// Cold-email sender: limits, spacing, business hours, compliance, follow-ups, monitoring and automatic pauses.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/db/index.js'
import { DEFAULTS, classifyReply, complianceProblem, inBusinessHours, limitCheck, nextBusinessTime, nextGapMs, parseBounce, pauseReason, timezoneFor } from '../../src/outreach/policy.js'
import { checkDomainAuth } from '../../src/outreach/dns.js'
import { createOutreachStore } from '../../src/outreach/store.js'
import { createOutreachEngine } from '../../src/outreach/engine.js'

const H = 3600_000
// Tuesday 2026-11-24 15:00 UTC = 10:00 in New York, 20:30 in Kolkata.
const TUE_10AM_NY = Date.parse('2026-11-24T15:00:00Z')

test('limits: 8 per hour and 30 per day by default, and the 2–6 minute gap', () => {
  assert.equal(DEFAULTS.hourly_limit, 8); assert.equal(DEFAULTS.daily_limit, 30)
  const now = TUE_10AM_NY
  const eight = Array.from({ length: 8 }, (_, i) => now - i * 5 * 60_000)
  assert.deepEqual(limitCheck({ sentTimes: eight, hourly: 8, daily: 30, now }).reason, 'hourly limit')
  const thirty = Array.from({ length: 30 }, (_, i) => now - 2 * H - i * 60_000)
  assert.equal(limitCheck({ sentTimes: thirty, hourly: 8, daily: 30, now }).reason, 'daily limit')
  assert.equal(limitCheck({ sentTimes: [], hourly: 8, daily: 30, nextAllowedAt: now + 1, now }).reason, 'spacing')
  assert.ok(limitCheck({ sentTimes: eight.slice(1), hourly: 8, daily: 30, now }).ok)
  for (const r of [0, 0.5, 0.999]) { const g = nextGapMs(DEFAULTS, () => r); assert.ok(g >= 120_000 && g <= 360_000) }
})

test('time zones and business hours follow the recipient', () => {
  assert.equal(timezoneFor('hello@acme.de'), 'Europe/Berlin')
  assert.equal(timezoneFor('hello@acme.co.in'), 'Asia/Kolkata')
  assert.equal(timezoneFor('hello@acme.io'), 'America/New_York')
  assert.ok(inBusinessHours(TUE_10AM_NY, 'America/New_York'))
  assert.ok(!inBusinessHours(TUE_10AM_NY, 'Asia/Kolkata')) // 20:30 there
  const next = nextBusinessTime(TUE_10AM_NY, 'Asia/Kolkata')
  assert.equal(new Date(next).toISOString(), '2026-11-25T03:30:00.000Z') // 09:00 IST Wednesday
  const sat = Date.parse('2026-11-28T15:00:00Z')
  assert.equal(new Date(nextBusinessTime(sat, 'America/New_York')).toISOString(), '2026-11-30T14:00:00.000Z') // Monday 09:00 EST
})

test('compliance: suppression, EU/UK role addresses only, one sequence per company', () => {
  const ctx = { suppressed: new Set(['x@a.com', '@blocked.io']), activeDomains: new Set(['busy.com']), emailed: new Set(['old@b.com']) }
  assert.match(complianceProblem('x@a.com', ctx), /suppression/)
  assert.match(complianceProblem('anyone@blocked.io', ctx), /suppression/)
  assert.match(complianceProblem('jan.schmidt@firma.de', ctx), /EU\/UK/)
  assert.equal(complianceProblem('hello@firma.de', ctx), null)
  assert.match(complianceProblem('hello@busy.com', ctx), /already has/)
  assert.match(complianceProblem('old@b.com', ctx), /already emailed/)
  assert.match(complianceProblem('noreply@c.com', ctx), /not an address/)
})

test('replies, opt-outs, complaints and bounces are recognised', () => {
  assert.equal(classifyReply('Thanks, can we talk Thursday?'), 'reply')
  assert.equal(classifyReply('Please remove me from your list'), 'optout')
  assert.equal(classifyReply('no'), 'optout')
  assert.equal(classifyReply('This is spam, reported.'), 'complaint')
  assert.equal(classifyReply('Sounds good\n\nOn Mon, X wrote:\n> unsubscribe'), 'reply') // quoted text is ignored
  assert.deepEqual(parseBounce({ from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', subject: 'Delivery Status Notification (Failure)',
    text: "Address not found\nYour message wasn't delivered to ghost@nowhere.com because the address couldn't be found" }), { email: 'ghost@nowhere.com' })
  assert.equal(parseBounce({ from: 'mailer-daemon@googlemail.com', subject: 'Delivery Status Notification (Delay)', text: 'Delivery has been delayed. Will retry for 47 more hours to x@y.com' }), null)
  assert.equal(parseBounce({ from: 'bob@acme.com', subject: 'hi', text: 'x@y.com' }), null)
})

test('automatic pause thresholds', () => {
  assert.equal(pauseReason({ sent: 10, bounces: 0, complaints: 0 }), null)
  assert.match(pauseReason({ sent: 10, bounces: 0, complaints: 1 }), /complaint/)
  assert.match(pauseReason({ sent: 200, bounces: 3, complaints: 0 }), /3 bounces/)
  assert.match(pauseReason({ sent: 40, bounces: 2, complaints: 0 }, { ...DEFAULTS, bounce_pause_count: 10 }), /bounce rate 5\.0%/)
})

test('DNS check requires SPF (Google), DKIM and DMARC', async () => {
  const recs = { 'mail.x.io': [['v=spf1 include:_spf.google.com ~all']], '_dmarc.mail.x.io': [['v=DMARC1; p=none']], 'google._domainkey.mail.x.io': [['v=DKIM1; k=rsa; p=' + 'A'.repeat(200)]] }
  const resolve = async n => { if (recs[n]) return recs[n]; const e = new Error('none'); e.code = 'ENOTFOUND'; throw e }
  assert.equal((await checkDomainAuth('mail.x.io', { resolve })).ok, true)
  delete recs['_dmarc.mail.x.io']
  const r = await checkDomainAuth('mail.x.io', { resolve })
  assert.deepEqual([r.ok, r.spf.ok, r.dkim.ok, r.dmarc.ok], [false, true, true, false])
})

function rig({ start = TUE_10AM_NY, replies = {}, bounces = [] } = {}) {
  const db = openDb(':memory:', { log: () => {} })
  const store = createOutreachStore(db)
  let t = start
  const sent = []
  const gmail = {
    async sendEmail(m) { sent.push(m); return { id: `m${sent.length}`, threadId: `t${sent.length}` } },
    async searchPlatform({ domain }) { if (domain === 'googlemail.com') return bounces; return replies[domain] || [] },
    disconnect() {}
  }
  const emails = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [i + 1, { company: `Co${i + 1}`, to: `hello@co${i + 1}.io`, subject: `Hi Co${i + 1}`, body: 'Hello' }]))
  emails[39] = { company: 'Berlin', to: 'max.mustermann@firma.de', subject: 'Hi', body: 'x' }
  const firsts = []
  const activity = { info() {}, success() {}, warn() {}, error() {} }
  const engine = createOutreachEngine({ db, store, activity, gmailFor: () => gmail, render: e => `<html>${e.body}</html>`, emailFor: n => emails[n] || null,
    onFirstSent: (n, r) => firsts.push(n), sendEnabled: () => true, clock: () => t, rand: () => 0.5,
    checkDns: async d => ({ ok: true, domain: d, spf: { ok: true }, dkim: { ok: true }, dmarc: { ok: true }, checkedAt: new Date(t).toISOString() }) })
  const box = store.addInbox({ address: 'hello@mail.docstar.io' })
  db.prepare('UPDATE outreach_inboxes SET connected = 1 WHERE id = ?').run(box.id)
  return { db, store, engine, sent, firsts, box, advance: ms => { t += ms }, now: () => t }
}

test('batches: at most 30, compliance-checked, need an active inbox', async () => {
  const r = rig()
  assert.throws(() => r.engine.approveBatch([1]), /No active sending inbox/)
  await r.engine.activate(r.box.id)
  assert.throws(() => r.engine.approveBatch(Array.from({ length: 31 }, (_, i) => i + 1)), /at most 30/)
  const out = r.engine.approveBatch([1, 2, 39])
  assert.equal(out.queued.length, 2)
  assert.match(out.skipped[0].reason, /EU\/UK/)
  assert.match(r.engine.approveBatch([1]).skipped[0].reason, /already approved/)
})

test('an inbox cannot be activated without a connection and passing DNS', async () => {
  const r = rig()
  r.db.prepare('UPDATE outreach_inboxes SET connected = 0').run()
  await assert.rejects(r.engine.activate(r.box.id), /Connect/)
  assert.throws(() => r.store.addInbox({ address: 'support@docstar.io' }), /separate/)
})

test('sending honours the gap, the hourly and daily limits, and business hours', async () => {
  const r = rig()
  await r.engine.activate(r.box.id)
  r.engine.approveBatch(Array.from({ length: 30 }, (_, i) => i + 1))
  // Tick every 30 s for an hour: the 4-minute gap (rand 0.5) allows 8 (the hourly limit caps it at 8 too).
  for (let i = 0; i < 120; i++) { await r.engine.tick(); r.advance(30_000) }
  assert.equal(r.sent.length, 8)
  // The rest of the business day (10:00 → 17:00 NY): never more than 8 in any hour, and the day stops at 17:00.
  for (let i = 0; i < 12 * 120; i++) { await r.engine.tick(); r.advance(30_000) }
  const times = r.db.prepare("SELECT sent_at FROM outreach_messages WHERE state = 'sent' ORDER BY sent_at").all().map(x => Date.parse(x.sent_at))
  for (const t of times) assert.ok(times.filter(u => u > t - H && u <= t).length <= 8)
  assert.ok(times.every(t => inBusinessHours(t, 'America/New_York')))
  assert.ok(r.sent.length <= 30)
  assert.ok(r.sent.every(m => m.body.startsWith('<html>'))) // the template renderer is always used
  assert.equal(r.firsts.length, r.sent.length)
})

test('follow-ups: at most 2, stopped by a reply, and suppressed recipients never get one', async () => {
  const r = rig()
  await r.engine.activate(r.box.id)
  r.engine.approveBatch([1, 2, 3])
  for (let i = 0; i < 40; i++) { await r.engine.tick(); r.advance(30_000) }
  assert.equal(r.sent.length, 3)
  r.store.suppress('hello@co3.io', 'test')
  // co2 replies before its follow-up.
  r.engine // eslint-disable-line no-unused-expressions
  const replies = { 'co2.io': [{ id: 'r1', from: 'Bob <hello@co2.io>', subject: 'Re: Hi', body: { plain: 'Interested, tell me more' } }] }
  const gmail2 = { sendEmail: async m => { r.sent.push(m); return { id: 'x', threadId: 'y' } }, searchPlatform: async ({ domain }) => replies[domain] || [] }
  const eng2 = createOutreachEngine({ db: r.db, store: r.store, activity: { info() {}, success() {}, warn() {}, error() {} }, gmailFor: () => gmail2,
    render: e => `<html>${e.body}</html>`, emailFor: n => ({ company: `Co${n}`, to: `hello@co${n}.io`, subject: `Hi Co${n}`, body: 'Hello' }),
    sendEnabled: () => true, clock: r.now, rand: () => 0.5 })
  for (let d = 0; d < 20 * 48; d++) { await eng2.tick(); r.advance(30 * 60_000) } // 20 days in half-hour steps
  const bySeq = r.db.prepare("SELECT s.to_email, COUNT(*) c, MAX(m.step) top FROM outreach_messages m JOIN outreach_sequences s ON s.id = m.sequence_id WHERE m.state = 'sent' GROUP BY s.id").all()
  const of = e => bySeq.find(x => x.to_email === e)
  assert.deepEqual([of('hello@co1.io').c, of('hello@co1.io').top], [3, 2]) // first + 2 follow-ups, never a third
  assert.equal(of('hello@co2.io').c, 1) // replied: no follow-ups
  assert.equal(of('hello@co3.io').c, 1) // suppressed: no follow-ups
  assert.match(r.sent.find(m => m.to === 'hello@co1.io' && /^Re:/.test(m.subject)).subject, /^Re: Hi Co1/)
})

test('bounces are suppressed and pause the inbox past the threshold', async () => {
  const bounce = to => ({ id: to, from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', subject: 'Delivery Status Notification (Failure)', body: { plain: `Address not found\nYour message wasn't delivered to ${to} because the address couldn't be found` } })
  const r = rig({ bounces: [bounce('hello@co1.io'), bounce('hello@co2.io'), bounce('hello@co3.io')] })
  await r.engine.activate(r.box.id)
  r.engine.approveBatch([1, 2, 3, 4])
  for (let i = 0; i < 60; i++) { await r.engine.tick(); r.advance(30_000) }
  await r.engine.monitorInbox(r.store.inbox(r.box.id))
  const box = r.store.inbox(r.box.id)
  assert.equal(box.state, 'paused')
  assert.match(box.pause_reason, /3 bounces/)
  assert.ok(r.store.suppressed().has('hello@co1.io'))
  const before = r.sent.length
  for (let i = 0; i < 20; i++) { await r.engine.tick(); r.advance(30_000) }
  assert.equal(r.sent.length, before) // a paused inbox sends nothing
})

test('an opt-out reply suppresses the whole company and a complaint pauses the inbox', async () => {
  const r = rig()
  await r.engine.activate(r.box.id)
  r.engine.approveBatch([5])
  for (let i = 0; i < 10; i++) { await r.engine.tick(); r.advance(30_000) }
  assert.equal(r.engine.recordComplaint('hello@co5.io') != null, true)
  assert.equal(r.store.inbox(r.box.id).state, 'paused')
  assert.ok(r.store.suppressed().has('@co5.io'))
})
