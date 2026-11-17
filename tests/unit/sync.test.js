// Part 2: the mirror as an ordered, idempotent change log; hosted changes tracked to "Applied" or "Failed: why";
// agent offline then reconnecting with queued manual changes; manual completion on any platform.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSnapshot, indexSnapshot, stateHash, createMirrorPusher, createMirrorReceiver, describeCommand } from '../../src/sync/mirror.js'
import { createManual } from '../../src/agent/manual.js'
import { setup, platformAt } from '../helpers/setup.js'

const hashOf = db => stateHash(indexSnapshot(buildSnapshot(db)))

function pair({ replay } = {}) {
  const mac = setup(), hosted = setup()
  const receiver = createMirrorReceiver({ db: hosted.db, activity: hosted.activity, token: 't' })
  const sent = []
  let online = true
  const fetchImpl = async (url, opts) => {
    if (!online) throw new Error('fetch failed')
    const body = JSON.parse(opts.body)
    sent.push(body)
    const r = receiver.receive(body)
    return { ok: !r.conflict, status: r.conflict ? 409 : 200, json: async () => r }
  }
  const replays = []
  const pusher = createMirrorPusher({
    db: mac.db, activity: mac.activity, orchestrator: mac.orchestrator, url: 'https://hosted.example', token: 't', fetchImpl,
    chrome: { status: async () => ({ running: true, attached: true }) },
    gmail: { status: async () => ({ connected: true }), embedToken: async () => 'x', serviceId: async () => 's', consentActions: () => [], authIdForReconnect: () => null },
    replay: replay || (async c => { replays.push(c); return { status: 200, data: { ok: true } } })
  })
  return { mac, hosted, receiver, pusher, sent, replays, setOnline: v => (online = v) }
}

test('mirror sends a full copy first, then only the rows that changed, and the copies converge', async () => {
  const { mac, hosted, pusher, sent } = pair()
  platformAt(mac, 'discovered', { name: 'Alpha' })
  platformAt(mac, 'discovered', { name: 'Beta' })
  await pusher.push()
  assert.ok(sent[0].snapshot, 'first push carries everything')
  assert.equal(hashOf(hosted.db), hashOf(mac.db))
  mac.db.prepare(`UPDATE platforms SET notes = 'changed' WHERE name = 'Alpha'`).run()
  await pusher.push()
  const delta = sent.at(-1).delta
  assert.ok(delta && !sent.at(-1).snapshot, 'second push is a delta')
  assert.equal(delta.platforms.upsert.length, 1)
  assert.equal(hosted.db.prepare(`SELECT notes FROM platforms WHERE name = 'Alpha'`).get().notes, 'changed')
  mac.db.prepare(`DELETE FROM platforms WHERE name = 'Beta'`).run()
  await pusher.push()
  assert.equal(sent.at(-1).delta.platforms.delete.length, 1)
  assert.equal(hosted.db.prepare('SELECT COUNT(*) n FROM platforms').get().n, 1)
  assert.equal(hashOf(hosted.db), hashOf(mac.db))
  pusher.shutdown()
})

test('a delta built on a state the hosted copy does not hold is refused, and a full copy follows', async () => {
  const { mac, hosted, pusher, sent } = pair()
  platformAt(mac, 'discovered', { name: 'Gamma' })
  await pusher.push()
  hosted.db.prepare(`UPDATE system_settings SET value = 'something else' WHERE key = 'mirror_hash'`).run() // e.g. a redeploy
  mac.db.prepare(`UPDATE platforms SET notes = 'n' WHERE name = 'Gamma'`).run()
  await pusher.push()
  assert.ok(sent.at(-1).delta)
  await pusher.push()
  assert.ok(sent.at(-1).snapshot, 'resent in full after the mismatch')
  assert.equal(hashOf(hosted.db), hashOf(mac.db))
  pusher.shutdown()
})

test('agent offline: hosted changes are pending, de-duplicated, then applied (or failed with the reason) after reconnecting', async () => {
  const replay = async c => (c.path.endsWith('/resume') ? { status: 409, data: { error: 'Task is done, not waiting for you' } } : { status: 201, data: { created: true } })
  const { mac, hosted, receiver, pusher, setOnline } = pair({ replay })
  const id = platformAt(mac, 'discovered', { name: 'Delta' })
  await pusher.push()
  setOnline(false)
  hosted.db.prepare(`UPDATE system_settings SET value = '2026-01-01T00:00:00Z' WHERE key = 'mirror_last_push'`).run()
  assert.equal(receiver.online(), false)
  const add = receiver.queue('POST', '/api/platforms', { name: 'New one', url: 'new.io' })
  const again = receiver.queue('POST', '/api/platforms', { name: 'New one', url: 'new.io' })
  assert.equal(again.id, add.id, 'identical change within a minute is one change')
  assert.equal(again.duplicate, true)
  const resume = receiver.queue('POST', `/api/platforms/${id}/resume`, {})
  assert.equal(add.label, 'Add platform New one (new.io)')
  assert.equal(receiver.command(add.id).state, 'queued')
  assert.equal(receiver.info().pending, 2)
  await pusher.push() // offline: fails, logged, retried with back-off
  assert.equal(pusher.info().failures, 1)
  assert.ok(mac.db.prepare(`SELECT 1 FROM activity_logs WHERE event = 'mirror_failed'`).get())
  setOnline(true)
  await pusher.push() // reconnect: commands handed out and run
  assert.equal(receiver.command(add.id).state, 'sent')
  await pusher.push() // results reported
  assert.equal(receiver.command(add.id).state, 'applied')
  assert.equal(receiver.command(resume.id).state, 'failed')
  assert.match(receiver.command(resume.id).result, /not waiting for you/)
  assert.equal(receiver.info().pending, 0)
  pusher.shutdown()
})

test('a command handed out twice runs once on the agent', async () => {
  const { pusher, replays } = pair()
  const c = { id: 7, method: 'POST', path: '/api/automation/start' }
  const a = await pusher._run(c)
  const b = await pusher._run(c)
  assert.equal(replays.length, 1)
  assert.equal(b.repeated, true)
  assert.equal(a.ok, b.ok)
  assert.equal((await pusher._run({ id: 8, method: 'POST', path: '/api/credentials/1/reveal' })).ok, false)
  pusher.shutdown()
})

test('commands have readable labels', () => {
  const t = setup()
  const id = platformAt(t, 'discovered', { name: 'Uneed' })
  assert.equal(describeCommand(t.db, 'POST', `/api/platforms/${id}/resume`), 'Resume Uneed')
  assert.equal(describeCommand(t.db, 'PATCH', `/api/platforms/${id}`, { status: 'rejected' }), 'Set Uneed to rejected')
  assert.equal(describeCommand(t.db, 'POST', `/api/platforms/${id}/manual-complete`, {}), 'Mark Uneed as done manually')
})

test('mark as done manually works on any platform: account, listing, notes, right status, backlink check', async () => {
  const t = setup()
  const checked = []
  const manual = createManual({ db: t.db, activity: t.activity, status: t.status, orchestrator: t.orchestrator, backlinks: { check: async b => { checked.push(b.page_url); return {} } } })
  const id = platformAt(t, 'discovered', { name: 'Hand' })
  t.orchestrator.enqueue(id, 'qualify')
  const r = manual.complete(id, { accountEmail: 'support@docstar.io', listingUrl: 'https://hand.io/p/docstar', notes: 'listed by Ana', loginMethod: 'google' })
  await r.check
  assert.equal(r.status, 'published')
  assert.deepEqual(checked, ['https://hand.io/p/docstar'])
  assert.equal(t.db.prepare(`SELECT state FROM automation_tasks WHERE platform_id = ?`).get(id).state, 'cancelled')
  const acc = t.db.prepare('SELECT login_method, signup_completed_at FROM accounts WHERE platform_id = ?').get(id)
  assert.equal(acc.login_method, 'google')
  assert.ok(acc.signup_completed_at)
  assert.equal(t.db.prepare('SELECT manual, notes, status FROM submissions WHERE platform_id = ?').get(id).manual, 1)
  assert.deepEqual(t.status.contradictions(), [])
  // Without a URL it is recorded as submitted and the agent looks for the listing.
  const id2 = platformAt(t, 'needs_you', { name: 'Hand2', submission: 'approved' })
  t.db.prepare(`UPDATE platforms SET needs_you_reason = '{"what":"x"}', resume_status = 'approved' WHERE id = ?`).run(id2)
  assert.equal(manual.complete(id2, { notes: 'done by hand' }).status, 'submitted')
  assert.throws(() => manual.complete(id2, { listingUrl: 'javascript:alert(1)' }), /http/)
})
