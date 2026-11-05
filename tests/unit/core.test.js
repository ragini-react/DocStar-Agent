// Offline unit tests: node --test tests/unit/   (no viaSocket, no Chrome, an in-memory database)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { openDb } from '../../src/db/index.js'
import { createVault, generatePassword } from '../../src/security/crypto.js'
import { maskText, maskValue } from '../../src/security/mask.js'
import { createActivityLog } from '../../src/logging/activity.js'
import { createOrchestrator } from '../../src/engine/orchestrator.js'
import { createPlatforms, csvCell, normalizeUrl } from '../../src/platforms/service.js'
import { pickVerificationLink, senderDomain } from '../../src/integrations/verificationLinks.js'

const quiet = () => { const log = console.log; console.log = () => {}; return () => (console.log = log) }
function setup() {
  const db = openDb(':memory:')
  const restore = quiet()
  const activity = createActivityLog(db)
  const chrome = { connect: async () => {} }
  return { db, activity, orchestrator: createOrchestrator({ db, activity, chrome }), platforms: createPlatforms({ db, activity }), restore }
}

test('vault: round trip, random IV, tamper detected, wrong key refused', () => {
  const v = createVault(randomBytes(32))
  const a = v.encrypt('s3cret!'), b = v.encrypt('s3cret!')
  assert.notEqual(a, b)
  assert.equal(v.decrypt(a), 's3cret!')
  assert.ok(!a.includes('s3cret'))
  const parts = a.split(':'); parts[3] = Buffer.from('xxxxxxx').toString('base64url')
  assert.throws(() => v.decrypt(parts.join(':')))
  assert.throws(() => createVault(randomBytes(32)).decrypt(a))
})

test('generated passwords are strong and unique', () => {
  const p = generatePassword()
  assert.equal(p.length, 24)
  for (const re of [/[A-Z]/, /[a-z]/, /\d/, /[!@#$%*\-_]/]) assert.match(p, re)
  assert.notEqual(p, generatePassword())
})

test('masking: emails, URL queries, tokens, ids, numbers, secret keys', () => {
  const s = maskText('mail support@docstar.io at https://x.com/verify?token=abc123 Bearer eyJa.b.c auth_id=row123456789abc 223-903-9564 password: hunter2')
  assert.ok(!s.includes('support@'))
  assert.ok(s.includes('<email>@docstar.io'))
  assert.ok(!s.includes('abc123'))
  assert.ok(!s.includes('hunter2'))
  assert.ok(!s.includes('903-9564'))
  assert.ok(!s.includes('row123456789abc'))
  const v = maskValue({ authId: 'row_x', body: { html: '<p>hi</p>' }, note: 'ok' })
  assert.deepEqual(v, { authId: '<redacted>', body: '<redacted>', note: 'ok' })
})

test('activity log stores masked text only', () => {
  const { db, activity, restore } = setup()
  activity.info('t', 'sent to support@docstar.io with https://a.io/v?code=999999')
  restore()
  const row = db.prepare('SELECT message FROM activity_logs').get()
  assert.ok(!row.message.includes('support@') && !row.message.includes('999999'))
})

test('database: one platform per domain, one account and one listing per platform, statuses checked', () => {
  const { db, platforms, restore } = setup()
  const first = platforms.create({ name: 'Example', url: 'https://www.example.com/x' })
  const dup = platforms.create({ name: 'Example again', url: 'example.com' })
  restore()
  assert.equal(first.created, true)
  assert.equal(dup.created, false)
  const id = first.platform.id
  db.prepare(`INSERT INTO accounts (platform_id, email, login_method) VALUES (?, 'a@b.co', 'email')`).run(id)
  assert.throws(() => db.prepare(`INSERT INTO accounts (platform_id, email, login_method) VALUES (?, 'a@b.co', 'google')`).run(id), /UNIQUE/)
  db.prepare(`INSERT INTO submissions (platform_id) VALUES (?)`).run(id)
  assert.throws(() => db.prepare(`INSERT INTO submissions (platform_id) VALUES (?)`).run(id), /UNIQUE/)
  assert.throws(() => db.prepare(`UPDATE platforms SET status = 'bogus' WHERE id = ?`).run(id), /CHECK/)
  assert.throws(() => db.prepare(`DELETE FROM platforms WHERE id = ?`).run(id), /FOREIGN KEY/)
})

test('operator may only set discovered / rejected / paid_skipped by hand', () => {
  const { platforms, restore } = setup()
  const { platform } = platforms.create({ name: 'X', url: 'x.io' })
  assert.equal(platforms.update(platform.id, { status: 'rejected' }).status, 'rejected')
  assert.throws(() => platforms.update(platform.id, { status: 'live_backlink' }), /set by the agent/)
  restore()
})

test('tasks: no duplicate active or completed task, lease recovery resumes at saved step', async () => {
  const { db, orchestrator, platforms, restore } = setup()
  const { platform } = platforms.create({ name: 'P', url: 'p.io' })
  assert.equal(orchestrator.enqueue(platform.id, 'register').created, true)
  assert.equal(orchestrator.enqueue(platform.id, 'register').created, false)
  assert.throws(() => db.prepare(`INSERT INTO automation_tasks (platform_id, type) VALUES (?, 'register')`).run(platform.id), /UNIQUE/)

  // A worker dies mid-task: state running, lease in the past, a saved step.
  db.prepare(`UPDATE automation_tasks SET state = 'running', step = 'form_filled', lease_until = '2000-01-01T00:00:00Z', locked_by = 'dead'`).run()
  let seenStep = null
  orchestrator.register('register', async (task, ctx) => { seenStep = task.step; ctx.checkpoint('submitted', {}) })
  db.prepare(`UPDATE system_settings SET value = 'running' WHERE key = 'automation_state'`).run()
  await orchestrator._tick()
  restore()
  assert.equal(seenStep, 'form_filled')
  const t = db.prepare('SELECT state, step, attempts FROM automation_tasks').get()
  assert.deepEqual([t.state, t.step], ['done', 'submitted'])
  assert.equal(orchestrator.enqueue(platform.id, 'register').created, false) // done is never repeated
})

test('boot after a crash while running comes back paused', () => {
  const { db, orchestrator, restore } = setup()
  db.prepare(`UPDATE system_settings SET value = 'running' WHERE key = 'automation_state'`).run()
  orchestrator.boot(); orchestrator.shutdown()
  restore()
  assert.equal(orchestrator.state(), 'paused')
})

test('needs-you hand-off and resume', async () => {
  const { db, orchestrator, platforms, restore } = setup()
  const { platform } = platforms.create({ name: 'C', url: 'c.io' })
  orchestrator.enqueue(platform.id, 'register')
  orchestrator.register('register', async (task, ctx) => ctx.needsYou('CAPTCHA on sign-up'))
  db.prepare(`UPDATE system_settings SET value = 'running' WHERE key = 'automation_state'`).run()
  await orchestrator._tick()
  assert.equal(db.prepare('SELECT state FROM automation_tasks').get().state, 'needs_you')
  orchestrator.resumeTask(1)
  restore()
  assert.equal(db.prepare('SELECT state FROM automation_tasks').get().state, 'queued')
})

test('same blocker three times in a row ends the task instead of looping through Resume', async () => {
  const { db, orchestrator, platforms, restore } = setup()
  const { platform } = platforms.create({ name: 'L', url: 'l.io' })
  orchestrator.enqueue(platform.id, 'register')
  let at = 'l.io/signup'
  const results = []
  orchestrator.register('register', async (task, ctx) => { ctx.checkpoint('step', { steps: 1 }); results.push(ctx.needsYou('Cloudflare check', { at })) })
  db.prepare(`UPDATE system_settings SET value = 'running' WHERE key = 'automation_state'`).run()
  const state = () => db.prepare('SELECT state FROM automation_tasks').get().state

  await orchestrator._tick(); assert.equal(state(), 'needs_you')
  orchestrator.resumeTask(1); await orchestrator._tick(); assert.equal(state(), 'needs_you')
  // Progress to another page resets the count.
  at = 'l.io/profile'
  orchestrator.resumeTask(1); await orchestrator._tick(); assert.equal(state(), 'needs_you')
  orchestrator.resumeTask(1); await orchestrator._tick(); assert.equal(state(), 'needs_you')
  orchestrator.resumeTask(1); await orchestrator._tick()
  restore()
  assert.equal(state(), 'failed')
  assert.deepEqual(results.map(r => r.stuck), [false, false, false, false, true])
  assert.throws(() => orchestrator.resumeTask(1), /not waiting/)
})

test('deferring does not use up attempts', async () => {
  const { db, orchestrator, platforms, restore } = setup()
  const { platform } = platforms.create({ name: 'D', url: 'd.io' })
  orchestrator.enqueue(platform.id, 'register')
  orchestrator.register('register', async (task, ctx) => ctx.defer(0, 'limit'))
  db.prepare(`UPDATE system_settings SET value = 'running' WHERE key = 'automation_state'`).run()
  await orchestrator._tick(); await orchestrator._tick()
  restore()
  assert.deepEqual({ ...db.prepare('SELECT state, attempts FROM automation_tasks').get() }, { state: 'queued', attempts: 0 })
})

test('sign-up slot wait and block keys', async () => {
  const { msUntilSignupSlot, blockKey } = await import('../../src/agent/submitTask.js')
  const { db, platforms, restore } = setup()
  restore()
  const t = Date.parse('2026-11-03T10:00:00Z')
  assert.equal(msUntilSignupSlot(db, t), 60_000)
  const { platform } = platforms.create({ name: 'S', url: 's.io' })
  db.prepare(`INSERT INTO accounts (platform_id, email, login_method, created_at) VALUES (?, 'a@b.c', 'email', '2026-11-03T09:20:00.000Z')`).run(platform.id)
  assert.equal(msUntilSignupSlot(db, t), 20 * 60_000 + 5_000)
  assert.equal(blockKey('https://x.io/signup/?ref=1#a'), 'x.io/signup')
  assert.equal(blockKey('https://x.io/signup?ref=2'), 'x.io/signup')
})

test('verification links: only https on the platform domain, prefers verify links, skips unsubscribe', () => {
  const body = { html: `<a href="https://evil.com/verify?t=1">Verify</a>
    <a href="https://example.com/unsubscribe">Unsubscribe</a>
    <a href="https://example.com/blog">Blog</a>
    <a href="http://example.com/confirm?t=2">Confirm (http)</a>
    <a href="https://app.example.com/account/confirm?t=3&amp;u=4">Confirm your email</a>` }
  assert.deepEqual(pickVerificationLink(body, 'example.com'), { link: 'https://app.example.com/account/confirm?t=3&u=4', host: 'app.example.com' })
  assert.equal(pickVerificationLink({ html: '<a href="https://example.com/blog">Blog</a>' }, 'example.com'), null)
  assert.equal(pickVerificationLink({ plain: 'Verify: https://example.com.evil.io/verify?x' }, 'example.com'), null)
  assert.equal(senderDomain('Google <no-reply@accounts.google.com>'), 'accounts.google.com')
})

test('CSV cells cannot become formulas; URLs normalise to one domain', () => {
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`)
  assert.equal(csvCell('a,b'), '"a,b"')
  assert.deepEqual(normalizeUrl('WWW.Example.com/path'), { url: 'https://www.example.com/', domain: 'example.com' })
  assert.throws(() => normalizeUrl('javascript:alert(1)'))
})

test('mirror: hosted copy gets the Mac records without secrets, runs nothing itself, hands out each command once', async () => {
  const { buildSnapshot, applySnapshot, createMirrorReceiver, commandAllowed } = await import('../../src/sync/mirror.js')
  const mac = setup()
  const { platform } = mac.platforms.create({ name: 'M', url: 'm.io' })
  const acc = mac.db.prepare(`INSERT INTO accounts (platform_id, email, login_method) VALUES (?, 'a@b.c', 'email') RETURNING id`).get(platform.id)
  mac.db.prepare(`INSERT INTO credentials (account_id, secret_enc) VALUES (?, 'sealed-password')`).run(acc.id)
  mac.db.prepare(`INSERT INTO email_verifications (platform_id, sender_domain, link_enc) VALUES (?, 'm.io', 'sealed-link')`).run(platform.id)
  mac.orchestrator.enqueue(platform.id, 'submit')
  mac.db.prepare(`UPDATE system_settings SET value = 'running' WHERE key = 'automation_state'`).run()

  const hosted = setup()
  hosted.platforms.create({ name: 'Old', url: 'old.io' }) // replaced by the Mac's records
  hosted.db.prepare(`UPDATE system_settings SET value = 'running' WHERE key = 'automation_state'`).run()
  const receiver = createMirrorReceiver({ db: hosted.db, activity: hosted.activity, token: 't' })
  assert.equal(receiver.on(), false)
  receiver.receive({ snapshot: buildSnapshot(mac.db), status: { state: 'running', chrome: { running: true, attached: true } } })
  mac.restore(); hosted.restore()

  const count = t => hosted.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n
  assert.deepEqual(hosted.db.prepare('SELECT domain FROM platforms').all().map(r => r.domain), ['m.io'])
  assert.equal(count('accounts'), 1)
  assert.deepEqual(hosted.db.prepare('SELECT secret_enc FROM credentials').all(), [{ secret_enc: '' }]) // only that a password exists
  assert.equal(JSON.stringify(buildSnapshot(mac.db)).includes('sealed-password'), false) // the sealed password never leaves the Mac
  assert.equal(hosted.db.prepare('SELECT link_enc FROM email_verifications').get().link_enc, null)
  assert.equal(count('automation_tasks'), 1)
  assert.equal(hosted.orchestrator.state(), 'stopped') // the hosted copy runs nothing of its own
  assert.equal(receiver.state(), 'running') // it shows the Mac's state instead
  assert.equal(receiver.chrome().attached, true)
  assert.equal(receiver.on(), true)

  const id = receiver.queue('POST', '/api/chrome/launch', {})
  assert.deepEqual(receiver.receive({}).commands.map(c => [c.id, c.path]), [[id, '/api/chrome/launch']])
  assert.equal(receiver.receive({}).commands.length, 0) // handed out once only
  applySnapshot(hosted.db, buildSnapshot(mac.db)) // applying twice is safe
  assert.equal(count('platforms'), 1)

  assert.equal(commandAllowed({ method: 'POST', path: '/api/automation/start' }), true)
  assert.equal(commandAllowed({ method: 'POST', path: '/api/credentials/1/reveal' }), false)
  assert.equal(commandAllowed({ method: 'POST', path: '/api/login' }), false)
  assert.equal(commandAllowed({ method: 'GET', path: '/api/platforms' }), false)
  assert.equal(commandAllowed({ method: 'POST', path: 'https://evil.io/api/x' }), false)
})

test('mirror: one agent only, and a hosted copy that lost or never had the records gets them again', async () => {
  const { buildSnapshot, createMirrorReceiver } = await import('../../src/sync/mirror.js')
  const mac = setup(), other = setup(), hosted = setup()
  mac.platforms.create({ name: 'Real', url: 'real.io' })
  other.platforms.create({ name: 'Stray', url: 'stray.io' })
  const receiver = createMirrorReceiver({ db: hosted.db, activity: hosted.activity, token: 't' })
  const domains = () => hosted.db.prepare('SELECT domain FROM platforms').all().map(r => r.domain)

  const a = receiver.receive({ source: { id: 'mac', host: 'mac' }, hash: 'h1', snapshot: buildSnapshot(mac.db) })
  assert.equal(a.have, 'h1') // the Mac learns the hosted copy holds its records
  // A second agent with the same token, while the Mac is online: refused, nothing changes.
  const b = receiver.receive({ hash: 'h2', snapshot: buildSnapshot(other.db) })
  assert.equal(b.conflict, true)
  assert.deepEqual(domains(), ['real.io'])
  assert.equal(receiver.receive({ source: { id: 'mac', host: 'mac' }, hash: 'h1' }).have, 'h1')

  // The Mac goes offline for a while: another agent may take over, and the hosted copy then asks the Mac for a full copy.
  hosted.db.prepare(`UPDATE system_settings SET value = ? WHERE key = 'mirror_last_push'`).run(new Date(Date.now() - 120_000).toISOString())
  receiver.receive({ source: { id: 'other', host: 'other' }, hash: 'h2', snapshot: buildSnapshot(other.db) })
  assert.deepEqual(domains(), ['stray.io'])
  hosted.db.prepare(`UPDATE system_settings SET value = ? WHERE key = 'mirror_last_push'`).run(new Date(Date.now() - 120_000).toISOString())
  const c = receiver.receive({ source: { id: 'mac', host: 'mac' }, hash: 'h1' }) // status only, as when unchanged
  assert.equal(c.have, '') // not the Mac's hash: its next push carries the records
  receiver.receive({ source: { id: 'mac', host: 'mac' }, hash: 'h1', snapshot: buildSnapshot(mac.db) })
  assert.deepEqual(domains(), ['real.io'])
  mac.restore(); other.restore(); hosted.restore()
})
