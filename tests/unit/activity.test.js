// Product activity list, the processed-URL guard and the DocStar brand name.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ACTIVITY_GROUPS, ACTIVITY_HELP, ACTIVITY_LABELS, STATUSES, activityGroup } from '../../src/engine/stateMachine.js'
import { BRAND, SITE_URL, brand, brandAll, canonicalUrl, hasWrongBrand, isSiteUrl } from '../../src/agent/brand.js'
import { analyseLinks } from '../../src/agent/backlinks.js'
import { createCompany } from '../../src/agent/company.js'
import { fill } from '../../src/agent/browserAgent.js'
import { cleanListingUrl, isPrivateUrl, notLiveYet, pageShowsListing, publicListingUrl } from '../../src/agent/listingUrl.js'
import { setup, platformAt } from '../helpers/setup.js'

test('activity groups follow the process: every status in exactly one group, with help text', () => {
  const g = s => activityGroup(s)
  for (const s of ['discovered', 'qualifying']) assert.equal(g(s), 'new', s)
  assert.equal(g('approval_required'), 'your_approval')
  for (const s of ['qualified', 'listing_drafted', 'approved', 'registering', 'registered', 'email_verification_pending', 'ready_for_submission', 'submitting']) assert.equal(g(s), 'in_progress', s)
  for (const s of ['evaluation_failed', 'registration_failed', 'submission_failed']) assert.equal(g(s), 'failed', s)
  for (const s of ['needs_you', 'blocked']) assert.equal(g(s), 'needs_you', s)
  for (const s of ['submitted', 'pending_platform_review']) assert.equal(g(s), 'product_added', s)
  for (const s of ['published', 'no_backlink']) assert.equal(g(s), 'product_published', s)
  assert.equal(g('backlink_lost'), 'backlink_lost')
  assert.equal(g('live_backlink'), 'backlink_completed')
  for (const s of ['rejected', 'paid_skipped', 'rejected_by_platform']) assert.equal(g(s), 'skipped', s)
  // A paused platform is shown under Needs you, whatever step it stopped at.
  assert.equal(activityGroup({ status: 'needs_you', resume_status: 'submitting' }), 'needs_you')
  for (const s of STATUSES) assert.ok(ACTIVITY_GROUPS.includes(g(s)), s)
  for (const k of ACTIVITY_GROUPS) assert.ok(ACTIVITY_LABELS[k] && ACTIVITY_HELP[k].means && ACTIVITY_HELP[k].next && ACTIVITY_HELP[k].who, k)
})

test('processed URLs are never qualified, drafted or submitted again', () => {
  const t = setup()
  for (const s of ['submitted', 'published', 'live_backlink', 'no_backlink']) {
    const id = platformAt(t, s)
    for (const type of ['qualify', 'prepare', 'submit']) {
      const r = t.orchestrator.enqueue(id, type)
      assert.equal(r.created, false, `${s}/${type}`)
      assert.equal(r.skipped, 'already_processed')
    }
  }
  assert.equal(t.db.prepare(`SELECT COUNT(*) n FROM automation_tasks`).get().n, 0)
  // Unprocessed URLs still queue.
  assert.equal(t.orchestrator.enqueue(platformAt(t, 'discovered'), 'qualify').created, true)
})

test('product activity list: one row per URL, counts, new since last visit', () => {
  const t = setup()
  const live = platformAt(t, 'live_backlink', { submission: 'published' })
  t.db.prepare(`INSERT INTO submissions (platform_id, status) VALUES (?, 'draft') ON CONFLICT DO NOTHING`).run(live)
  platformAt(t, 'published'); platformAt(t, 'submitted'); platformAt(t, 'approved'); platformAt(t, 'paid_skipped')
  const since = new Date(Date.now() - 1000).toISOString()
  t.db.prepare(`UPDATE platforms SET created_at = '2020-01-01T00:00:00.000Z'`).run()
  const fresh = platformAt(t, 'discovered')
  const a = t.views.productActivity({ since })
  assert.equal(a.items.length, 6)
  assert.equal(new Set(a.items.map(i => i.platform_id)).size, 6)
  assert.deepEqual(a.counts, { new: 1, your_approval: 0, in_progress: 1, needs_you: 0, failed: 0, product_added: 1, product_published: 1, backlink_completed: 1, backlink_lost: 0, skipped: 1 })
  assert.equal(a.total, 6)
  assert.ok(a.groups.every(g => !/\{\{/.test(g.help.means)), 'brand placeholders filled')
  assert.equal(a.newSinceLastVisit, 1)
  assert.equal(a.items.find(i => i.newSinceLastVisit).platform_id, fresh)
  assert.equal(t.views.productActivity().newSinceLastVisit, 0)
})

test('brand: "DocStar Support" becomes "DocStar"; the support email is untouched', () => {
  assert.equal(brand('Made by docStar Support'), 'Made by DocStar')
  assert.equal(brand('DOCSTAR SUPPORT TEAM'), 'DocStar')
  assert.equal(brand(BRAND.replace(/(?<=[a-z])(?=[A-Z])/g, ' ') + ' Support'), BRAND) // spaced-out spelling
  assert.equal(brand('Contact support@docstar.io for DocStar support'), 'Contact support@docstar.io for DocStar')
  assert.equal(brand('DocStar supports OpenAPI'), 'DocStar supports OpenAPI')
  assert.equal(brand(null), null)
  assert.deepEqual(brandAll({ name: 'DocStar Support', tags: ['DocStar Support', 'api'], n: 1 }), { name: 'DocStar', tags: ['DocStar', 'api'], n: 1 })
  assert.equal(fill('{{account.name}}', { 'account.name': 'docStar Support' }), 'DocStar')
  assert.ok(hasWrongBrand('docstar support'))
  assert.ok(!hasWrongBrand('support@docstar.io'))
})

test('listing URLs: trailing punctuation removed; dashboards, forms, logins and trackers are not listings', () => {
  assert.equal(cleanListingUrl('https://www.indiehackers.com/product/docstar,'), 'https://www.indiehackers.com/product/docstar')
  assert.equal(cleanListingUrl('https://www.tinylaunch.com/dashboard/startups.'), 'https://www.tinylaunch.com/dashboard/startups')
  for (const u of ['https://www.g2.com/add_product_requests/new', 'https://www.tinylaunch.com/dashboard/startups.', 'https://portal.10words.io/submissions/submitted/36195',
    'https://x.io/login?returnTo=%2Fp', 'https://x.io/submit', 'https://x.io/my-products', 'not a url']) assert.ok(isPrivateUrl(u), u)
  for (const u of ['https://devhunt.org/tool/docstar', 'https://www.uneed.best/tool/docstar', 'https://mcpservers.org/servers/docstar-io',
    'https://www.indiehackers.com/product/docstar']) assert.equal(publicListingUrl(u), u)
  assert.ok(notLiveYet("DocStar shows as 'Waiting for approval' with a launch scheduled"))
  assert.ok(!notLiveYet('DocStar is listed at https://devhunt.org/tool/docstar'))
  assert.ok(pageShowsListing({ url: 'https://a.io/p/docstar', text: 'DocStar — API docs' }))
  assert.ok(!pageShowsListing({ url: 'https://a.io/p/docstar', finalUrl: 'https://a.io/login?returnTo=x', text: 'DocStar' }))
  assert.ok(!pageShowsListing({ url: 'https://a.io/p/x', text: 'Sign in' }))
})

test('docstar.io URL: one canonical form everywhere; emails, paths and other hosts untouched', () => {
  assert.equal(SITE_URL, 'https://docstar.io/')
  for (const v of ['http://docstar.io', 'https://www.docstar.io', 'www.docstar.io/', 'HTTPS://DocStar.io']) assert.equal(canonicalUrl(v), 'https://docstar.io/', v)
  assert.equal(canonicalUrl('See http://www.docstar.io/pricing.'), 'See https://docstar.io/pricing.')
  assert.equal(canonicalUrl('Visit https://docstar.io, then sign up'), 'Visit https://docstar.io/, then sign up')
  assert.equal(canonicalUrl('support@docstar.io'), 'support@docstar.io')
  assert.equal(canonicalUrl('https://app.docstar.io/x'), 'https://app.docstar.io/x')
  assert.equal(canonicalUrl('learn more at docstar.io'), 'learn more at docstar.io')
  assert.equal(brand('docStar Support — http://www.docstar.io'), 'DocStar — https://docstar.io/')
  assert.ok(isSiteUrl('https://www.docstar.io/'))
  assert.ok(!isSiteUrl('https://docstar.com/'))
  assert.ok(!isSiteUrl('https://docstar.io.evil.com/'))
  assert.ok(!isSiteUrl('https://app.docstar.io/'))
})

test('backlinks count only links to the docstar.io site itself', () => {
  assert.ok(analyseLinks([{ href: 'https://docstar.io/?ref=devhunt', rel: '', text: 'DocStar' }]).present)
  assert.ok(analyseLinks([{ href: 'https://www.docstar.io/', rel: '', text: 'DocStar' }]).present)
  assert.ok(!analyseLinks([{ href: 'https://app.docstar.io/', rel: '', text: 'DocStar' }]).present)
  assert.ok(!analyseLinks([{ href: 'https://docstar.io.example.com/', rel: '', text: 'DocStar' }]).present)
})

test('profile website is always https://docstar.io/; another domain is refused', () => {
  const t = setup()
  const company = createCompany({ db: t.db, ai: null, activity: t.activity })
  company.save('website', 'www.docstar.io')
  assert.equal(company.get().website.value, 'https://docstar.io/')
  assert.throws(() => company.save('website', 'https://docstar.com'), new RegExp('must be ' + SITE_URL.replace(/[./]/g, '\\$&')))
  for (const [k, v] of [['name', 'DocStar'], ['short_description', 'x'], ['long_description', 'y'], ['category', 'API docs']]) company.save(k, v)
  company.approveAll()
  assert.equal(company.approved().website, 'https://docstar.io/')
})
