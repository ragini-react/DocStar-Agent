// The HTTP API end to end (real Express app, in-memory database, no Chrome or Gmail): sign-in protections, CSRF,
// one-click Resume links, and the done criterion that every overview card equals the list it opens.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { createApp } from '../../src/server/app.js'
import { createManual } from '../../src/agent/manual.js'
import { createTokens } from '../../src/alerts/notify.js'
import { createReports } from '../../src/reports/summary.js'
import { setup, platformAt } from '../helpers/setup.js'

async function start() {
  const t = setup()
  const dir = mkdtempSync(path.join(tmpdir(), 'docstar-api-'))
  // The DNS-rebinding guard allows only this port: reserve a free one first.
  const port = await new Promise(r => { const srv = net.createServer().listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => r(p)) }) })
  const config = { port, hosted: false, publicHosts: [], dbPath: path.join(dir, 'x.db'), seedPath: path.join(dir, 'seed.json'), mirror: {}, adminPassword: 'pw', viasocketConfigured: false }
  const agent = { company: { approved: () => null, fields: [], get: () => ({}) }, approvals: { pending: () => [] }, listings: { get: () => null }, backlinks: { check: async () => ({}) }, queueDiscovery: () => true }
  const tokens = createTokens({ db: t.db, secret: 's' })
  const app = createApp({ config, db: t.db, vault: null, activity: t.activity, gmail: {}, chrome: {}, orchestrator: t.orchestrator, platforms: t.platforms, agent, status: t.status,
    views: t.views, maintenance: t.maintenance, manual: createManual({ db: t.db, activity: t.activity, status: t.status, orchestrator: t.orchestrator, backlinks: agent.backlinks }),
    tokens, reports: createReports({ db: t.db, views: t.views }) })
  const server = await new Promise(r => { const s = app.listen(port, '127.0.0.1', () => r(s)) })
  const base = `http://127.0.0.1:${config.port}`
  let cookie = ''
  const call = async (p, { method = 'GET', body, csrf = true, form = null } = {}) => {
    const res = await fetch(base + p, { method, redirect: 'manual', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...(csrf && method !== 'GET' ? { 'X-DocStar-CSRF': '1' } : {}), Cookie: cookie },
      body: body ? JSON.stringify(body) : form ?? undefined })
    const set = res.headers.get('set-cookie')
    if (set) cookie = set.split(';')[0]
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text()
    return { status: res.status, data }
  }
  return { t, call, tokens, close: () => { server.close(); t.orchestrator.shutdown() } }
}

test('sign-in: wrong passwords lock the address out; writes need the CSRF header', async () => {
  const s = await start()
  try {
    for (let i = 0; i < 5; i++) assert.equal((await s.call('/api/login', { method: 'POST', body: { password: 'nope' } })).status, 401)
    assert.equal((await s.call('/api/login', { method: 'POST', body: { password: 'pw' } })).status, 429)
    s.t.db.prepare('SELECT 1').get()
  } finally { s.close() }
  const s2 = await start()
  try {
    assert.equal((await s2.call('/api/login', { method: 'POST', body: { password: 'pw' } })).status, 200)
    assert.equal((await s2.call('/api/platforms', { method: 'POST', body: { name: 'X', url: 'x.io' }, csrf: false })).status, 403)
    assert.equal((await s2.call('/api/overview')).status, 200)
  } finally { s2.close() }
})

test('done criterion: every overview card equals the list it opens', async () => {
  const s = await start()
  try {
    await s.call('/api/login', { method: 'POST', body: { password: 'pw' } })
    const t = s.t
    platformAt(t, 'needs_you', { submission: 'approved' })
    t.db.prepare(`UPDATE platforms SET needs_you_reason = '{"what":"CAPTCHA"}', resume_status = 'approved' WHERE status = 'needs_you'`).run()
    platformAt(t, 'submission_failed', { submission: 'approved' })
    const live = platformAt(t, 'live_backlink', { submission: 'published' })
    t.db.prepare(`INSERT INTO backlinks (submission_id, page_url, status, is_dofollow, first_seen_at) SELECT id, 'https://x.io/d', 'live', 1, '2026-11-10' FROM submissions WHERE platform_id = ?`).run(live)
    platformAt(t, 'published', { submission: 'published' })
    platformAt(t, 'submitted', { submission: 'submitted' })
    platformAt(t, 'approved', { submission: 'approved' })
    const o = (await s.call('/api/overview')).data
    const count = async q => (await s.call(`/api/platforms?${q}`)).data.total
    assert.equal(o.needsYou, (await s.call('/api/needs-you')).data.length)
    assert.equal(o.needsYou, await count('group=needs_you'))
    assert.equal(o.failed, (await s.call('/api/failed')).data.length)
    assert.equal(o.failed, await count('group=failed'))
    const added = (await s.call('/api/added')).data
    assert.equal(o.successfullyAdded, added.total)
    assert.equal(o.successfullyAdded, await count('group=added'))
    assert.equal(o.liveBacklinks, added.live.length)
    assert.equal(o.approvedWaiting, (await s.call('/api/pipeline')).data.length)
    // Every live, published or submitted platform is in Successfully added.
    assert.deepEqual([added.live.length, added.published.length, added.awaiting.length], [1, 1, 1])
    assert.deepEqual((await s.call('/api/invariants')).data, [])
    const csv = (await s.call('/api/export/added.csv')).data
    assert.match(csv, /Live with backlink/)
  } finally { s.close() }
})

test('one-click Resume: the link shows what will happen; the button resumes, once', async () => {
  const s = await start()
  try {
    const id = platformAt(s.t, 'approved', { name: 'Uneed', submission: 'approved' })
    s.t.status.transition(id, 'needs_you', { needsYou: { what: 'A CAPTCHA', todo: 'Solve it' } })
    const tok = s.tokens.sign(id)
    const page = await s.call(`/r/${tok}`)
    assert.match(page.data, /Resume Uneed\?/)
    assert.equal(s.t.status.get(id).status, 'needs_you', 'opening the link changes nothing')
    const done = await s.call(`/r/${tok}`, { method: 'POST', csrf: false, form: '' })
    assert.match(done.data, /back with the agent/)
    assert.equal(s.t.status.get(id).status, 'approved')
    assert.ok(s.t.db.prepare(`SELECT 1 FROM automation_tasks WHERE platform_id = ? AND type = 'submit' AND state = 'queued'`).get(id))
    assert.match((await s.call(`/r/${tok}`, { method: 'POST', csrf: false, form: '' })).data, /already used/)
    assert.ok(!s.t.db.prepare(`SELECT 1 FROM activity_logs WHERE message LIKE ? OR meta LIKE ?`).get(`%${tok}%`, `%${tok}%`), 'the token is never logged')
  } finally { s.close() }
})
