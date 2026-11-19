// Part 1: the platform state machine, the status writer, task outcomes, counts, reconciliation, the sweeper and the repair.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { STATUSES, TRANSITIONS, LABELS, canTransition, findContradictions, substatusFixes, MANUAL_TARGETS, OPERATOR_TARGETS, label } from '../../src/engine/stateMachine.js'
import { computeStatus, checkInvariants } from '../../src/engine/maintenance.js'
import { repairData } from '../../src/db/repair.js'
import { backoffMs } from '../../src/engine/orchestrator.js'
import { setup, platformAt } from '../helpers/setup.js'

test('every status has a human label, and no label is a raw value', () => {
  for (const s of STATUSES) {
    assert.ok(LABELS[s], `label for ${s}`)
    assert.ok(!/_/.test(LABELS[s]), `${s} label "${LABELS[s]}" looks raw`)
  }
  assert.equal(label('email_verification_pending'), 'Verifying email')
})

test('every pair of statuses: allowed exactly when the table (or the manual / operator rules) says so', () => {
  let allowed = 0, refused = 0
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      const expected = from === to || TRANSITIONS[from].has(to)
      assert.equal(canTransition(from, to), expected, `${from} → ${to}`)
      assert.equal(canTransition(from, to, { manual: true }), expected || MANUAL_TARGETS.has(to), `manual ${from} → ${to}`)
      assert.equal(canTransition(from, to, { operator: true }), expected || OPERATOR_TARGETS.has(to), `operator ${from} → ${to}`)
      expected ? allowed++ : refused++
    }
  }
  assert.ok(allowed > 100 && refused > 300, `${allowed} allowed, ${refused} refused`)
  assert.equal(canTransition('discovered', 'live_backlink'), false)
  assert.equal(canTransition('rejected', 'approved'), false)
  assert.equal(canTransition('nonsense', 'qualified'), false)
  // The main path is walkable end to end.
  const path = ['discovered', 'qualifying', 'qualified', 'listing_drafted', 'approval_required', 'approved', 'registering', 'registered',
    'email_verification_pending', 'ready_for_submission', 'submitting', 'submitted', 'pending_platform_review', 'published', 'live_backlink', 'backlink_lost']
  for (let i = 1; i < path.length; i++) assert.ok(canTransition(path[i - 1], path[i]), `${path[i - 1]} → ${path[i]}`)
})

test('contradictions are detected and the fixes follow the main status', () => {
  assert.deepEqual(findContradictions({ status: 'rejected', submission_status: 'approved' }), ['submission "approved" contradicts rejected'])
  assert.deepEqual(findContradictions({ status: 'paid_skipped', submission_status: 'approved' }), ['submission "approved" contradicts paid_skipped'])
  assert.ok(findContradictions({ status: 'needs_you', resume_status: 'approved', needs_you_reason: 'x', account_status: 'email_verification_pending', submission_status: 'approved' }).length)
  assert.deepEqual(findContradictions({ status: 'needs_you', resume_status: 'email_verification_pending', needs_you_reason: 'x', account_status: 'email_verification_pending', submission_status: 'approved' }), [])
  assert.ok(findContradictions({ status: 'pending_platform_review', submission_status: 'pending_approval', backlink_status: 'live' }).length)
  assert.deepEqual(substatusFixes('rejected', { submission_status: 'approved', account_status: 'pending' }), { submission: 'cancelled', account: 'disabled' })
  assert.deepEqual(substatusFixes('live_backlink', { submission_status: 'submitted', backlink_status: 'live' }), { submission: 'published' })
})

test('status writer: refuses and logs an illegal change, writes sub-statuses, timeline and activity in one go', () => {
  const t = setup()
  const id = platformAt(t, 'discovered')
  assert.throws(() => t.status.transition(id, 'live_backlink'), /not an allowed status change/)
  assert.equal(t.db.prepare(`SELECT COUNT(*) n FROM activity_logs WHERE event = 'illegal_transition'`).get().n, 1)
  assert.equal(t.status.get(id).status, 'discovered')
  t.status.transition(id, 'qualifying')
  t.status.transition(id, 'rejected', { statusReason: 'low_score', reason: 'score 40' })
  assert.equal(t.status.get(id).status_reason, 'low_score')
  assert.deepEqual(t.status.timeline(id).map(x => x.to_status), ['discovered', 'qualifying', 'rejected'])
  // needs_you needs a reason and remembers what it interrupted.
  const p2 = platformAt(t, 'approved', { submission: 'approved' })
  assert.throws(() => t.status.transition(p2, 'needs_you'), /needs a reason/)
  t.status.transition(p2, 'needs_you', { needsYou: { what: 'CAPTCHA', todo: 'solve it' } })
  assert.equal(t.status.get(p2).resume_status, 'approved')
  t.status.transition(p2, 'approved')
  assert.equal(t.status.get(p2).resume_status, null)
  assert.equal(t.status.get(p2).needs_you_reason, null)
  // A rejected platform's approved listing is cancelled in the same write.
  t.status.transition(p2, 'rejected', { operator: true, statusReason: 'operator' })
  assert.equal(t.db.prepare('SELECT status FROM submissions WHERE platform_id = ?').get(p2).status, 'cancelled')
  assert.deepEqual(t.status.contradictions(), [])
})

test('task outcomes always settle the platform: retry with back-off, then needs you with the error history', async () => {
  const t = setup()
  t.db.prepare(`UPDATE system_settings SET value = '2' WHERE key = 'max_attempts'`).run()
  const id = platformAt(t, 'discovered')
  t.orchestrator.register('qualify', async () => { throw new Error('site timed out') }, { start: 'qualifying', entry: 'discovered', exhausted: 'evaluation_failed' })
  t.orchestrator.enqueue(id, 'qualify')
  t.run()
  await t.orchestrator._tick()
  let task = t.db.prepare('SELECT * FROM automation_tasks').get()
  assert.equal(task.state, 'queued')
  assert.ok(Date.parse(task.run_after) > Date.now() + 30_000, 'retry scheduled with back-off')
  assert.equal(t.status.get(id).status, 'qualifying') // a task is queued for it: not stale
  t.db.prepare(`UPDATE automation_tasks SET run_after = NULL`).run()
  await t.orchestrator._tick()
  task = t.db.prepare('SELECT * FROM automation_tasks').get()
  assert.equal(task.state, 'failed')
  assert.equal(JSON.parse(task.error_history).length, 2)
  assert.equal(t.status.get(id).status, 'evaluation_failed')
  assert.equal(t.views.failed().length, 1)
  assert.equal(t.views.overview().failed, 1)
  t.orchestrator.shutdown()
})

test('back-off doubles and is capped', () => {
  const fixed = { jitter: () => 0.5 }
  assert.equal(backoffMs(1, fixed), 60_000)
  assert.equal(backoffMs(2, fixed), 120_000)
  assert.equal(backoffMs(4, fixed), 480_000)
  assert.equal(backoffMs(20, fixed), 3600_000)
})

test('cancel puts an in-progress platform back; waiting tasks wake on their event, never on a timer', async () => {
  const t = setup()
  const id = platformAt(t, 'approved', { submission: 'approved' })
  let calls = 0
  t.orchestrator.register('submit', async (task, ctx) => { calls++; if (calls === 1) return ctx.waitFor(`approval:${id}`, 'listing not approved') }, { start: 'submitting', entry: 'approved' })
  t.orchestrator.enqueue(id, 'submit')
  t.run()
  await t.orchestrator._tick()
  assert.equal(t.db.prepare('SELECT state FROM automation_tasks').get().state, 'waiting')
  assert.equal(t.status.get(id).status, 'approved') // not left in "submitting"
  await t.orchestrator._tick()
  assert.equal(calls, 1) // nothing runs it again by itself
  t.orchestrator.signal(`approval:${id}`)
  await t.orchestrator._tick()
  assert.equal(calls, 2)
  assert.equal(t.db.prepare('SELECT state FROM automation_tasks').get().state, 'done')
  t.orchestrator.shutdown()
})

test('overview counts equal the lists they open', () => {
  const t = setup()
  platformAt(t, 'needs_you', { submission: 'approved' })
  t.db.prepare(`UPDATE platforms SET needs_you_reason = '{"what":"CAPTCHA"}', resume_status = 'approved' WHERE status = 'needs_you'`).run()
  platformAt(t, 'submission_failed', { submission: 'approved' })
  platformAt(t, 'live_backlink', { submission: 'published' })
  platformAt(t, 'pending_platform_review', { submission: 'pending_approval' })
  platformAt(t, 'approved', { submission: 'approved' })
  platformAt(t, 'registering', { submission: 'approved', account: 'pending' })
  const o = t.views.overview()
  assert.equal(o.needsYou, t.views.needsYou().length)
  assert.equal(o.needsYou, 1)
  assert.equal(o.failed, t.views.failed().length)
  assert.equal(o.successfullyAdded, t.views.successfullyAdded().total)
  assert.equal(o.successfullyAdded, 1) // only the public listing; the one awaiting review is not listed yet
  assert.equal(o.approvedWaiting, t.views.approvedPipeline().length)
  assert.equal(o.approvedWaiting, 2) // approved + registering; never the one awaiting platform review
  assert.equal(o.needsYou, t.platforms.list({ group: 'needs_you' }).total)
  assert.equal(o.failed, t.platforms.list({ group: 'failed' }).total)
  assert.equal(o.successfullyAdded, t.platforms.list({ group: 'added' }).total)
  assert.equal(o.registered, 0) // a sign-up only counts once it finished
})

test('reconcile computes status from evidence', () => {
  assert.equal(computeStatus({ status: 'submitted', backlink_status: 'live', is_dofollow: 1 }).status, 'live_backlink')
  assert.equal(computeStatus({ status: 'submitted', backlink_status: 'live', is_dofollow: 0 }, { nofollowLive: false }).status, 'no_backlink')
  assert.equal(computeStatus({ status: 'live_backlink', backlink_status: 'missing', first_seen_at: 'x', listing_url: 'u' }).status, 'backlink_lost')
  assert.equal(computeStatus({ status: 'rejected', submission_status: 'published' }).status, 'published')
  assert.equal(computeStatus({ status: 'rejected', submission_status: 'approved' }), null) // a decision stays; only its sub-status is fixed
  assert.equal(computeStatus({ status: 'approved', activeTask: { state: 'needs_you', last_error: 'CAPTCHA' } }).status, 'needs_you')
  assert.equal(computeStatus({ status: 'needs_you', resume_status: 'approved', submission_status: 'approved', account_status: 'email_verification_pending' }).resume, 'email_verification_pending')
})

test('sweeper: stale in-progress platform is re-queued while retries remain, failed with a reason after', () => {
  const t = setup()
  const id = platformAt(t, 'registering', { submission: 'approved', account: 'pending' })
  t.db.prepare(`UPDATE platforms SET updated_at = '2026-01-01T00:00:00Z', status_changed_at = '2026-01-01T00:00:00Z' WHERE id = ?`).run(id)
  assert.equal(checkInvariants(t.db).filter(p => p.kind === 'stale').length, 1)
  const r = t.maintenance.sweep()
  assert.equal(r.requeuedPlatforms, 1)
  assert.equal(t.db.prepare(`SELECT state FROM automation_tasks WHERE platform_id = ?`).get(id).state, 'queued')
  assert.equal(checkInvariants(t.db).length, 0)
  // Retries used up: failed with the reason.
  t.db.prepare(`UPDATE system_settings SET value = '1' WHERE key = 'max_attempts'`).run()
  t.db.prepare(`UPDATE automation_tasks SET state = 'failed', last_error = 'boom' WHERE platform_id = ?`).run(id)
  t.db.prepare(`UPDATE platforms SET updated_at = '2026-01-01T00:00:00Z', status_changed_at = '2026-01-01T00:00:00Z' WHERE id = ?`).run(id)
  assert.equal(t.maintenance.sweep().failedPlatforms, 1)
  assert.equal(t.status.get(id).status, 'registration_failed')
  // A running task whose worker stopped beating goes back to the queue.
  const id2 = platformAt(t, 'discovered')
  t.db.prepare(`INSERT INTO automation_tasks (platform_id, type, state, heartbeat_at, locked_by) VALUES (?, 'qualify', 'running', '2026-01-01T00:00:00Z', 'gone')`).run(id2)
  assert.equal(t.maintenance.sweep().requeuedTasks, 1)
})

test('repair: the observed problems are resolved and every invariant holds afterwards', () => {
  const t = setup()
  t.orchestrator.register('submit', async () => {}, { browser: true })
  t.orchestrator.register('qualify', async () => {})
  const old = '2026-11-03T00:00:00Z'
  // Rejected with an approved submission; paid/skipped with an approved submission.
  const saashub = platformAt(t, 'rejected', { name: 'SaaSHub', submission: 'approved' })
  const mcpso = platformAt(t, 'paid_skipped', { name: 'MCPso', submission: 'approved' })
  // A needs-you platform whose task ended "stuck", account waiting for email verification (SourceForge).
  const sf = platformAt(t, 'needs_you', { name: 'SourceForge', submission: 'approved', account: 'email_verification_pending' })
  t.db.prepare(`INSERT INTO automation_tasks (platform_id, type, state, attempts, last_error, checkpoint) VALUES (?, 'submit', 'failed', 18, 'Stopped: blocked at the same point 3 times in a row. SourceForge: CAPTCHA / human check in Chrome. Complete it there, then press Resume.', '{"url":"https://sourceforge.net/x","steps":1,"_block":{"at":"x","times":3}}')`).run(sf)
  // A platform stuck registering since November with a crashed task (Uneed).
  const uneed = platformAt(t, 'registering', { name: 'Uneed', submission: 'approved', account: 'pending' })
  t.db.prepare(`UPDATE platforms SET updated_at = ?, status_changed_at = ? WHERE id = ?`).run(old, old, uneed)
  t.db.prepare(`INSERT INTO automation_tasks (platform_id, type, state, attempts, last_error) VALUES (?, 'submit', 'failed', 1, 'page.evaluate: Execution context was destroyed')`).run(uneed)
  // Awaiting platform review with a submit task deferred 37 times for "listing not approved" (G2, task 48).
  const g2 = platformAt(t, 'pending_platform_review', { name: 'G2', submission: 'pending_approval' })
  t.db.prepare(`INSERT INTO automation_tasks (platform_id, type, state, attempts, last_error, run_after) VALUES (?, 'submit', 'queued', 37, 'listing not approved', '2026-11-17T05:53:18Z')`).run(g2)

  assert.ok(checkInvariants(t.db).length >= 4)
  const r = repairData({ db: t.db, status: t.status, activity: t.activity, orchestrator: t.orchestrator, maintenance: t.maintenance })
  assert.deepEqual(checkInvariants(t.db), [])
  assert.equal(t.db.prepare('SELECT status FROM submissions WHERE platform_id = ?').get(saashub).status, 'cancelled')
  assert.equal(t.db.prepare('SELECT status FROM submissions WHERE platform_id = ?').get(mcpso).status, 'cancelled')
  const sfRow = t.status.get(sf)
  assert.equal(sfRow.resume_status, 'email_verification_pending')
  assert.match(JSON.parse(sfRow.needs_you_reason).what, /^CAPTCHA \/ human check in Chrome\.?$/)
  assert.equal(t.db.prepare(`SELECT state FROM automation_tasks WHERE platform_id = ?`).get(sf).state, 'needs_you') // Resume continues it
  assert.equal(t.views.overview().needsYou, 1)
  assert.equal(t.db.prepare(`SELECT state FROM automation_tasks WHERE platform_id = ?`).get(g2).state, 'cancelled')
  assert.ok(t.db.prepare(`SELECT 1 FROM automation_tasks WHERE platform_id = ? AND state = 'queued'`).get(uneed), 'stuck sign-up re-queued')
  assert.match(r.report, /Task .* cancelled: the platform is already awaiting platform review/)
  assert.match(r.report, /## Platforms: before → after/)
  t.orchestrator.shutdown()
})

test('successfully added: three groups, each item with its dated timeline', () => {
  const t = setup()
  const live = platformAt(t, 'discovered', { name: 'LiveOne' })
  for (const s of ['qualifying', 'qualified', 'listing_drafted', 'approval_required', 'approved', 'submitting', 'submitted', 'live_backlink']) t.status.transition(live, s)
  const sub = t.db.prepare(`INSERT INTO submissions (platform_id, status, listing_url, submitted_at) VALUES (?, 'published', 'https://x.io/docstar', '2026-11-10') RETURNING id`).get(live)
  t.db.prepare(`INSERT INTO backlinks (submission_id, page_url, status, is_dofollow, first_seen_at) VALUES (?, 'https://x.io/docstar', 'live', 1, '2026-11-12')`).run(sub.id)
  platformAt(t, 'pending_platform_review', { name: 'Waiting', submission: 'pending_approval' })
  const a = t.views.added()
  assert.deepEqual([a.live.length, a.published.length, a.awaiting.length, a.total], [1, 0, 1, 1])
  const tl = Object.fromEntries(a.live[0].timeline.map(m => [m.key, m.at]))
  for (const k of ['discovered', 'qualified', 'approved', 'submitted', 'live']) assert.ok(tl[k], k)
  assert.equal(tl.live, '2026-11-12')
  assert.equal(t.views.overview().successfullyAdded, a.total)
})
