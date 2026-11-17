// Part 8: one threshold rule, deterministic scores, failed evaluations kept apart, domains normalised, duplicates merged.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { qualifies, rubricScore, evaluationFailed } from '../../src/agent/qualify.js'
import { registrableDomain, siteKey, cleanName, resolveFinalUrl } from '../../src/platforms/domains.js'
import { mergePlatforms, pickKeeper } from '../../src/platforms/merge.js'
import { reasonFromNotes } from '../../src/db/repairSteps.js'
import { validateBrowserAction } from '../../src/ai/actionSchema.js'
import { setup, platformAt } from '../helpers/setup.js'

test('one threshold rule: a score at the minimum qualifies (Product Hunt 55 = Capterra 55)', () => {
  assert.equal(qualifies(55, 55), true)
  assert.equal(qualifies(54, 55), false)
  assert.equal(qualifies('60', 55), true)
})

test('the overall score is computed from the parts: same parts, same score', () => {
  const q = { relevance: 80, domain_reputation: 70, audience_quality: 60, credibility: 50, indexability: 90, referral_potential: 40, backlink_quality: 70, overall: 12 }
  assert.equal(rubricScore(q), 69)
  assert.equal(rubricScore({ ...q, overall: 99 }), 69) // the model's own overall is ignored
})

test('a failure to evaluate is not a low score', () => {
  const parts = { relevance: 2, domain_reputation: 0, audience_quality: 1, credibility: 0, indexability: 3, referral_potential: 0, backlink_quality: 0 }
  assert.match(evaluationFailed(parts, 5000), /near zero/)
  assert.match(evaluationFailed({ ...parts, relevance: 60 }, 300), /300 characters/)
  assert.equal(evaluationFailed({ ...parts, relevance: 40, credibility: 30 }, 5000), null)
})

test('domains: eTLD+1, shared hosts keep their path owner, names cleaned, redirects followed', async () => {
  assert.equal(registrableDomain('WWW.App.Example.co.uk'), 'example.co.uk')
  assert.equal(registrableDomain('vendor.crozdesk.com'), 'crozdesk.com')
  assert.equal(siteKey('https://github.com/thechangelog/nightly'), 'github.com/thechangelog')
  assert.equal(siteKey('https://www.g2.com/products/x'), 'g2.com')
  assert.equal(cleanName('BetaList alternative: Launching Next'), 'Launching Next')
  assert.equal(cleanName('SaaSHub'), 'SaaSHub')
  const hops = { 'https://g2crowd.com/': 'https://www.g2.com/' }
  const fetchImpl = async u => ({ status: hops[u] ? 301 : 200, headers: { get: () => hops[u] || null } })
  assert.equal(await resolveFinalUrl('https://g2crowd.com/', { fetchImpl }), 'https://www.g2.com/')
})

test('the same site under two names is refused on insert', () => {
  const t = setup()
  assert.equal(t.platforms.create({ name: 'Ex', url: 'https://example.co.uk/' }).created, true)
  const again = t.platforms.create({ name: 'Ex app', url: 'https://app.example.co.uk/' })
  assert.equal(again.created, false)
  assert.match(again.reason, /same site/)
  assert.equal(t.platforms.create({ name: 'A', url: 'https://github.com/a/x' }).created, true)
  assert.equal(t.platforms.create({ name: 'B', url: 'https://github.com/b/y' }).created, true) // different owners on a shared host
})

test('merging keeps all history and the record that got further', () => {
  const t = setup()
  const g2 = platformAt(t, 'pending_platform_review', { name: 'G2', submission: 'pending_approval' })
  const crowd = platformAt(t, 'registering', { name: 'G2 Crowd', submission: 'approved', account: 'pending' })
  t.db.prepare(`INSERT INTO platform_scores (platform_id, overall, method) VALUES (?, 72, 'ai:x')`).run(crowd)
  t.orchestrator.enqueue(crowd, 'submit')
  const [keep, dup] = pickKeeper(t.status.get(g2), t.status.get(crowd))
  assert.equal(keep.id, g2)
  mergePlatforms(t.db, keep.id, dup.id, { reason: 'g2crowd.com redirects to g2.com' })
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM platforms').get().n, 1)
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM platform_scores WHERE platform_id = ?').get(g2).n, 1, 'score history moved')
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM accounts WHERE platform_id = ?').get(g2).n, 1, 'the account moved (G2 had none)')
  assert.equal(t.db.prepare(`SELECT state FROM automation_tasks WHERE platform_id = ?`).get(g2).state, 'cancelled')
  assert.ok(t.status.timeline(g2).some(x => /merged duplicate G2 Crowd/.test(x.reason)))
  assert.deepEqual(t.status.contradictions(), [])
})

test('every old rejection gets a structured reason', () => {
  assert.equal(reasonFromNotes('rejected', 'quality 40 below 55'), 'low_score')
  assert.equal(reasonFromNotes('rejected', 'duplicate: betapage.co redirects to pitchwall.co'), 'duplicate')
  assert.equal(reasonFromNotes('rejected', 'policy: SaaSHub says agents should not submit'), 'policy')
  assert.equal(reasonFromNotes('paid_skipped', 'listing requires payment'), 'paid_only')
  assert.equal(reasonFromNotes('rejected', 'not_possible: archived'), 'not_possible')
  assert.equal(reasonFromNotes('rejected', null), 'unknown')
})

test('only approved facts, each in its own field: the homepage is refused in a documentation field', () => {
  const base = { reason: 'r', confidence: 0.9, requiresHumanApproval: false }
  const ctx = profile => ({ refs: new Set(['e1']), allowedHosts: ['a.com'], placeholders: new Set(['company.website', 'company.docs_url']), approvedTexts: new Set(), listingApproved: true,
    fieldLabels: { e1: '[e1] url "Documentation URL" required empty' }, profileFields: new Set(profile) })
  const r = validateBrowserAction({ ...base, action: 'type', target: 'e1', value: '{{company.website}}' }, ctx(['website']))
  assert.equal(r.ok, false)
  assert.match(r.errors.join(), /missing_field/)
  assert.match(validateBrowserAction({ ...base, action: 'type', target: 'e1', value: '{{company.website}}' }, ctx(['website', 'docs_url'])).errors.join(), /company\.docs_url/)
  assert.ok(validateBrowserAction({ ...base, action: 'type', target: 'e1', value: '{{company.docs_url}}' }, ctx(['docs_url'])).ok)
  assert.ok(validateBrowserAction({ ...base, action: 'missing_field', target: 'e1', value: 'Documentation URL' }, ctx([])).ok)
})
