// Part 4: run_after scheduling, retries, the rolling sign-up limiter, concurrency and idempotency.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextSlot, signupSlot } from '../../src/engine/rateLimit.js'
import { setup, platformAt } from '../helpers/setup.js'

const until = async (cond, ms = 3000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 10)) } }

test('rolling window: hourly and daily caps, with the exact time the next slot frees', () => {
  const at = Date.parse('2026-11-17T12:00:00Z')
  const t = m => new Date(at - m * 60_000).toISOString()
  assert.equal(nextSlot([t(10), t(20)], { perHour: 3, perDay: 10, at }).ok, true)
  const full = nextSlot([t(10), t(20), t(50)], { perHour: 3, perDay: 10, at })
  assert.equal(full.ok, false)
  assert.equal(full.waitMs, 10 * 60_000 + 5_000) // the one 50 minutes ago drops out in 10 minutes
  const day = nextSlot([t(100), t(200), t(300), t(400)], { perHour: 3, perDay: 4, at })
  assert.equal(day.ok, false)
  assert.equal(day.waitMs, (1440 - 400) * 60_000 + 5_000)
  assert.match(day.reason, /24 hours/)
})

test('a deferred task gets a run_after and the worker wakes for it by itself (never idles past it)', async () => {
  const s = setup()
  const id = platformAt(s, 'discovered')
  let runs = 0
  s.orchestrator.register('qualify', async (task, ctx) => { runs++; if (runs === 1) ctx.defer(150, 'not yet') })
  s.orchestrator.enqueue(id, 'qualify')
  s.run()
  s.orchestrator.wake()
  await until(() => runs === 1)
  const task = s.db.prepare('SELECT state, run_after, attempts FROM automation_tasks').get()
  assert.equal(task.state, 'queued')
  assert.ok(task.run_after)
  assert.equal(task.attempts, 0) // a deferral is not an attempt
  await until(() => runs === 2, 2000) // woken by the timer set to run_after, no external tick
  await until(() => s.db.prepare('SELECT state FROM automation_tasks').get().state === 'done')
  s.orchestrator.shutdown()
})

test('enqueue wakes the worker immediately; evaluations run in parallel, browser tasks one at a time', async () => {
  const s = setup({ browser: true })
  s.db.prepare(`UPDATE system_settings SET value = '3' WHERE key = 'parallel_tasks'`).run()
  let active = 0, peak = 0, browserActive = 0, browserPeak = 0
  const slow = (counter) => async () => {
    if (counter === 'b') { browserActive++; browserPeak = Math.max(browserPeak, browserActive) } else { active++; peak = Math.max(peak, active) }
    await new Promise(r => setTimeout(r, 60))
    if (counter === 'b') browserActive--; else active--
  }
  s.orchestrator.register('qualify', slow('q'))
  s.orchestrator.register('submit', slow('b'), { browser: true })
  s.run()
  for (let i = 0; i < 5; i++) s.orchestrator.enqueue(platformAt(s, 'discovered'), 'qualify')
  for (let i = 0; i < 3; i++) s.orchestrator.enqueue(platformAt(s, 'approved', { submission: 'approved' }), 'submit')
  await until(() => s.db.prepare(`SELECT COUNT(*) n FROM automation_tasks WHERE state = 'done'`).get().n === 8)
  assert.equal(peak, 3)
  assert.equal(browserPeak, 1)
  s.orchestrator.shutdown()
})

test('two tasks for the same platform never run at once, and the same task is never queued twice', async () => {
  const s = setup()
  const id = platformAt(s, 'discovered')
  assert.equal(s.orchestrator.enqueue(id, 'qualify').created, true)
  assert.equal(s.orchestrator.enqueue(id, 'qualify').created, false)
  assert.equal(s.db.prepare('SELECT idempotency_key FROM automation_tasks').get().idempotency_key, `qualify:${id}`)
  let concurrent = 0, peak = 0
  const h = async () => { concurrent++; peak = Math.max(peak, concurrent); await new Promise(r => setTimeout(r, 40)); concurrent-- }
  s.orchestrator.register('qualify', h)
  s.orchestrator.register('prepare', h)
  s.orchestrator.enqueue(id, 'prepare')
  s.run()
  s.orchestrator.wake()
  await until(() => s.db.prepare(`SELECT COUNT(*) n FROM automation_tasks WHERE state = 'done'`).get().n === 2)
  assert.equal(peak, 1)
  s.orchestrator.shutdown()
})

test('sign-up limiter reads the accounts table; qualification never counts', () => {
  const s = setup()
  const at = Date.now()
  for (let i = 0; i < 3; i++) {
    const id = platformAt(s, 'registering', { submission: 'approved' })
    s.db.prepare(`INSERT INTO accounts (platform_id, email, login_method, created_at) VALUES (?, 'a@b.c', 'google', ?)`).run(id, new Date(at - (i + 1) * 60_000).toISOString())
  }
  assert.equal(signupSlot(s.db, at).ok, false)
  s.db.prepare(`UPDATE system_settings SET value = '4' WHERE key = 'max_signups_per_hour'`).run()
  assert.equal(signupSlot(s.db, at).ok, true)
})

test('a retried task resumes at its last verified checkpoint', async () => {
  const s = setup()
  const id = platformAt(s, 'discovered')
  const seen = []
  s.orchestrator.register('qualify', async (task, ctx) => {
    const cp = JSON.parse(task.checkpoint || '{}')
    seen.push(cp.steps || 0)
    ctx.checkpoint('step 3: type name', { steps: 3, url: 'https://x.io/form', form: { Name: 'filled (7 chars)' } })
    if (seen.length === 1) throw new Error('page crashed')
  })
  s.orchestrator.enqueue(id, 'qualify')
  s.run()
  await s.orchestrator._tick()
  s.db.prepare('UPDATE automation_tasks SET run_after = NULL').run()
  await s.orchestrator._tick()
  assert.deepEqual(seen, [0, 3])
  s.orchestrator.shutdown()
})
