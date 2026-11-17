// Part 9: auto-approval only when safe, needs-you notifications with one-click Resume, summaries and health metrics.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAutoApproval, usesOnlyApprovedFacts } from '../../src/agent/autoApproval.js'
import { attachNeedsYouNotifications, createTokens } from '../../src/alerts/notify.js'
import { createReports } from '../../src/reports/summary.js'
import { createAlerts } from '../../src/alerts/index.js'
import { setup, platformAt } from '../helpers/setup.js'

const facts = { name: 'DocStar', website: 'https://docstar.io/', short_description: 'API docs for 100+ APIs' }

test('a listing passes only with approved facts: links and numbers must be in the profile', () => {
  assert.equal(usesOnlyApprovedFacts({ title: 'DocStar', short_description: 'Docs for 100+ APIs at https://docstar.io/' }, facts).ok, true)
  assert.match(usesOnlyApprovedFacts({ title: 'DocStar', short_description: 'Trusted by 5,000 teams' }, facts).why, /5,000/)
  assert.match(usesOnlyApprovedFacts({ title: 'DocStar', long_description: 'see https://evil.io' }, facts).why, /evil\.io/)
  assert.equal(usesOnlyApprovedFacts({ title: 'Other', short_description: '' }, facts).ok, false)
})

test('auto-approval: off by default; on, only free, high-scoring, ordinary platforms', () => {
  const t = setup()
  const check = createAutoApproval({ db: t.db, company: { approved: () => facts } })
  const id = platformAt(t, 'listing_drafted', { submission: 'draft' })
  t.db.prepare(`UPDATE platforms SET pricing = 'free' WHERE id = ?`).run(id)
  t.db.prepare(`INSERT INTO platform_scores (platform_id, overall, method) VALUES (?, 70, 'ai:x')`).run(id)
  const listing = { title: 'DocStar', short_description: 'API docs' }
  assert.match(check(id, listing).why, /off/)
  t.db.prepare(`UPDATE system_settings SET value = '1' WHERE key = 'auto_approve'`).run()
  assert.equal(check(id, listing).ok, true)
  t.db.prepare(`UPDATE platforms SET submission_requirements = 'phone number and company registration' WHERE id = ?`).run(id)
  assert.match(check(id, listing).why, /unusual/)
  t.db.prepare(`UPDATE platforms SET submission_requirements = NULL, pricing = 'paid' WHERE id = ?`).run(id)
  assert.match(check(id, listing).why, /not free/)
  t.db.prepare(`UPDATE platforms SET pricing = 'free' WHERE id = ?`).run(id)
  t.db.prepare(`UPDATE system_settings SET value = '80' WHERE key = 'auto_approve_min_score'`).run()
  assert.match(check(id, listing).why, /below/)
})

test('one-click Resume links: signed, expiring, single use', () => {
  const t = setup()
  const tokens = createTokens({ db: t.db, secret: 'shared-sync-token' })
  const tok = tokens.sign(12, 'resume')
  assert.equal(tokens.verify(tok).platformId, 12)
  tokens.verify(tok, { consume: true })
  assert.throws(() => tokens.verify(tok), /already used/)
  assert.throws(() => tokens.verify(tok.replace(/.$/, c => (c === 'A' ? 'B' : 'A'))), /not valid/)
  assert.throws(() => tokens.verify(tokens.sign(1, 'resume', { ttlMs: -1 })), /expired/)
  assert.throws(() => createTokens({ db: t.db, secret: 'other' }).verify(tokens.sign(3)), /not valid/)
})

test('every new needs-you item sends one notification with what to do and a Resume link', () => {
  const t = setup()
  const posted = []
  const alerts = createAlerts({ db: t.db, activity: t.activity, env: { ALERT_SLACK_WEBHOOK: 'https://hooks.example/x', PUBLIC_URL: 'https://dash.example' }, fetchImpl: async (u, o) => { posted.push(JSON.parse(o.body)); return { ok: true } } })
  attachNeedsYouNotifications({ status: t.status, alerts, tokens: createTokens({ db: t.db, secret: 's' }) })
  const id = platformAt(t, 'approved', { name: 'Uneed', submission: 'approved' })
  t.status.transition(id, 'needs_you', { needsYou: { what: 'A CAPTCHA on uneed.best', todo: 'Complete it in Chrome' } })
  t.status.transition(id, 'needs_you', { needsYou: { what: 'A CAPTCHA on uneed.best', todo: 'Complete it in Chrome' } }) // same item: no second alert
  assert.equal(alerts.sent.length, 1)
  assert.match(alerts.sent[0].text, /What to do: Complete it in Chrome/)
  assert.match(alerts.sent[0].text, /https:\/\/dash\.example\/r\/resume\.\d+\./)
  assert.equal(alerts.sent[0].link, 'https://dash.example/#queue')
})

test('metrics per stage and the summary with its Successfully added section; sent once when due', () => {
  const t = setup()
  const a = platformAt(t, 'discovered', { name: 'A' })
  for (const s of ['qualifying', 'qualified']) t.status.transition(a, s)
  const b = platformAt(t, 'discovered', { name: 'B' })
  for (const s of ['qualifying', 'evaluation_failed']) t.status.transition(b, s)
  platformAt(t, 'pending_platform_review', { name: 'G2', submission: 'pending_approval' })
  const r = createReports({ db: t.db, views: t.views })
  const ev = r.metrics().stages.find(s => s.stage === 'Evaluation')
  assert.deepEqual([ev.entered, ev.succeeded, ev.failed, ev.successRate], [2, 1, 1, 50])
  const text = r.render(r.summary({ days: 7 }))
  assert.match(text, /SUCCESSFULLY ADDED/)
  assert.match(text, /Submitted, awaiting platform review \(1\)\n {2}• G2/)
  assert.match(text, /Failures \(1\)/)
  const alerts = { sent: [], send(...x) { this.sent.push(x) }, link: x => x }
  const monday = new Date(2026, 10, 16, 10, 0)
  assert.equal(r.sendIfDue(alerts, new Date(2026, 10, 16, 8, 0)), false) // before 09:00
  assert.equal(r.sendIfDue(alerts, monday), true)
  assert.equal(r.sendIfDue(alerts, monday), false) // once
  assert.equal(r.sendIfDue(alerts, new Date(2026, 10, 17, 10, 0)), false) // weekly: Mondays only
})
