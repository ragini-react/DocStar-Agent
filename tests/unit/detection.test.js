// Part 7: backlink checks that mean something, lost links, listings found without a person, platform emails.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyseLinks, createBacklinkChecker } from '../../src/agent/backlinks.js'
import { createFollowUp } from '../../src/agent/followUp.js'
import { robotsAllows, looksLikeListing } from '../../src/agent/listingFinder.js'
import { setup, platformAt } from '../helpers/setup.js'

const page = (links, { status = 200, robots = '', text = 'DocStar: API documentation', url } = {}) => async u => ({ status, url: url || u, html: 'x'.repeat(600), text, title: '', links, robots, xRobotsTag: '' })

function withBacklink(t, platformStatus, url = 'https://dir.io/p/docstar') {
  const id = platformAt(t, platformStatus, { submission: platformStatus === 'submitted' ? 'submitted' : 'published' })
  const sub = t.db.prepare('UPDATE submissions SET listing_url = ? WHERE platform_id = ? RETURNING id').get(url, id)
  const b = t.db.prepare(`INSERT INTO backlinks (submission_id, page_url) VALUES (?, ?) RETURNING *`).get(sub.id, url)
  return { id, b }
}

test('every DocStar link is recorded with its rel; noindex and page-level nofollow count', () => {
  const a = analyseLinks([{ href: 'https://docstar.io/', rel: 'nofollow ugc', text: 'site' }, { href: 'https://docstar.io/docs', rel: '', text: 'DocStar' }])
  assert.deepEqual(a.links.map(l => l.kind), ['ugc', 'dofollow'])
  assert.equal(a.kind, 'dofollow')
  assert.equal(analyseLinks([{ href: 'https://docstar.io', rel: '', text: '' }], { robots: 'noindex' }).indexable, false)
  assert.equal(analyseLinks([{ href: 'https://docstar.io', rel: '', text: '' }], { robots: 'nofollow' }).dofollow, false)
})

test('HTTP 200 without the link is not live; a link that disappears or loses dofollow is lost, with an alert', async () => {
  const t = setup()
  const sent = []
  const alerts = { send: (...a) => sent.push(a), link: x => x }
  let fetchImpl = page([])
  const checker = createBacklinkChecker({ db: t.db, chrome: null, activity: t.activity, status: t.status, alerts, fetchImpl: (...a) => fetchImpl(...a) })
  const { id, b } = withBacklink(t, 'submitted')
  // A page that is not DocStar's listing (a login redirect, a form) proves nothing: still submitted, not published.
  fetchImpl = page([], { text: 'Sign in to continue' })
  assert.equal((await checker.check(b)).status, 'pending')
  assert.equal(t.status.get(id).status, 'submitted')
  fetchImpl = page([], { url: 'https://dir.io/login?returnTo=%2Fp%2Fdocstar' })
  assert.equal((await checker.check(b)).status, 'pending')
  assert.equal(t.status.get(id).status, 'submitted')
  assert.equal(t.db.prepare('SELECT published_at FROM submissions WHERE id = ?').get(b.submission_id).published_at, null)
  fetchImpl = page([])
  assert.equal((await checker.check(b)).status, 'missing')
  assert.equal(t.status.get(id).status, 'no_backlink')
  fetchImpl = page([{ href: 'https://docstar.io/', rel: '', text: 'DocStar' }])
  assert.equal((await checker.check(t.db.prepare('SELECT * FROM backlinks WHERE id = ?').get(b.id))).status, 'live')
  assert.equal(t.status.get(id).status, 'live_backlink')
  const row = t.db.prepare('SELECT * FROM backlinks WHERE id = ?').get(b.id)
  assert.ok(Date.parse(row.next_check_at) > Date.now() + 23 * 3600_000, 'live links re-checked after 24 h')
  fetchImpl = page([{ href: 'https://docstar.io/', rel: 'nofollow', text: 'DocStar' }])
  await checker.check(row)
  assert.equal(t.status.get(id).status, 'backlink_lost', 'dofollow → nofollow is a lost backlink')
  assert.equal(sent.length, 1)
  fetchImpl = page([{ href: 'https://docstar.io/', rel: '', text: 'DocStar' }])
  await checker.check(t.db.prepare('SELECT * FROM backlinks WHERE id = ?').get(b.id))
  fetchImpl = page([])
  await checker.check(t.db.prepare('SELECT * FROM backlinks WHERE id = ?').get(b.id))
  assert.equal(t.status.get(id).status, 'backlink_lost')
  assert.equal(sent.length, 2)
  assert.deepEqual(t.status.contradictions(), [])
  // A page that cannot be read is not evidence the link is gone.
  fetchImpl = async () => { throw new Error('timeout') }
  assert.equal((await checker.check(t.db.prepare('SELECT * FROM backlinks WHERE id = ?').get(b.id))).status, 'error')
})

test('the listing is found after submitting, and on a platform someone finished by hand', async () => {
  const t = setup()
  const checked = []
  const finder = { find: async p => (p.name === 'NotYet' ? null : { url: `${p.url}tools/docstar`, how: 'listing URL' }) }
  const f = createFollowUp({ db: t.db, activity: t.activity, status: t.status, orchestrator: t.orchestrator, finder, backlinks: { check: async b => checked.push(b.page_url) } })
  const sub = platformAt(t, 'submitted', { name: 'Sub', submission: 'submitted' })
  const manual = platformAt(t, 'registration_failed', { name: 'ByHand', submission: 'approved' })
  t.orchestrator.enqueue(manual, 'submit')
  const notYet = platformAt(t, 'pending_platform_review', { name: 'NotYet', submission: 'pending_approval' })
  const r = await f.searchListings()
  assert.deepEqual([r.searched, r.found], [3, 2])
  assert.equal(t.status.get(sub).status, 'published')
  assert.equal(t.status.get(manual).status, 'published')
  assert.equal(t.db.prepare(`SELECT state FROM automation_tasks WHERE platform_id = ?`).get(manual).state, 'cancelled')
  assert.equal(checked.length, 2)
  const next = t.db.prepare('SELECT next_listing_search_at, listing_searches FROM platforms WHERE id = ?').get(notYet)
  assert.ok(Date.parse(next.next_listing_search_at) < Date.now() + 2 * 3600_000, 'hourly at first')
  assert.deepEqual(t.status.contradictions(), [])
})

test('platform emails move the status: received → under review, approved → published, rejected → rejected by platform', async () => {
  const t = setup()
  const mail = {
    A: [{ id: 'a1', from: 'x@a.io', subject: 'We received your submission', receivedAt: '2026-11-17', body: { plain: 'in the review queue' } }],
    B: [{ id: 'b1', from: 'x@b.io', subject: 'DocStar has been approved', receivedAt: '2026-11-17', body: { html: '<a href="https://b.io/tools/docstar">see</a>' } }],
    C: [{ id: 'c1', from: 'x@c.io', subject: 'Your submission was not approved', receivedAt: '2026-11-17', body: { plain: 'not a fit' } }]
  }
  const ids = {}
  for (const n of ['A', 'B', 'C']) {
    ids[n] = platformAt(t, 'submitted', { name: n, submission: 'submitted' })
    t.db.prepare(`UPDATE submissions SET submitted_at = '2026-11-16' WHERE platform_id = ?`).run(ids[n])
  }
  const gmail = { searchPlatform: async ({ domain }) => mail[domain[0].toUpperCase()] || [] }
  const f = createFollowUp({ db: t.db, activity: t.activity, status: t.status, orchestrator: t.orchestrator, finder: { find: async () => null }, backlinks: { check: async () => ({}) }, gmail })
  await f.readEmails()
  assert.equal(t.status.get(ids.A).status, 'pending_platform_review')
  assert.equal(t.status.get(ids.B).status, 'published')
  assert.equal(t.status.get(ids.C).status, 'rejected_by_platform')
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM emails_used').get().n, 3)
  await f.readEmails() // each email is used once
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM emails_used').get().n, 3)
})

test('robots.txt is honoured and a listing must really show DocStar', () => {
  const txt = 'User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /search\nAllow: /search/public\n'
  assert.equal(robotsAllows(txt, '/search?q=docstar'), false)
  assert.equal(robotsAllows(txt, '/search/public'), true)
  assert.equal(robotsAllows(txt, '/tools/docstar'), true)
  assert.equal(looksLikeListing({ status: 200, title: 'DocStar — API docs', text: '', links: [] }), true)
  assert.equal(looksLikeListing({ status: 200, title: 'Home', text: 'nothing', links: [] }), false)
  assert.equal(looksLikeListing({ status: 404, title: 'DocStar', text: '', links: [] }), false)
})
