// The dashboard's HTTP API. Listens on 127.0.0.1 only; every /api route except login needs the admin session;
// every write also needs the CSRF header and a same-origin request. Responses never carry a secret except the
// one credential the operator explicitly reveals after typing the admin password again.
import express from 'express'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { ROOT } from '../config/index.js'
import { createAdminPassword } from '../security/adminPassword.js'
import { safeEqual } from '../security/crypto.js'
import { maskError } from '../security/mask.js'
import { getSetting, now, setSetting } from '../db/index.js'
import { label, LABELS, OTHER_LABELS, STATUSES } from '../engine/stateMachine.js'
import { parseNeedsYou } from '../engine/status.js'
import { signupSlot } from '../engine/rateLimit.js'
import { toCsv } from '../platforms/service.js'
import { resolveFinalUrl } from '../platforms/domains.js'
import { actionPage, esc } from '../alerts/notify.js'
import { createGtm } from '../gtm/service.js'
import { createOutreachStore } from '../outreach/store.js'
import { createOutreachEngine } from '../outreach/engine.js'
import { registerOutreachRoutes } from '../outreach/routes.js'
// Local-only extension (git-ignored): loaded when present and GTM_OUTREACH=1, never on the hosted copy.
const OUTREACH_FILE = path.join(ROOT, 'gtm', 'outreach.js')
const localOutreach = process.env.GTM_OUTREACH === '1' && existsSync(OUTREACH_FILE) ? await import(OUTREACH_FILE) : null
import { BRAND, BRAND_SLUG, SITE_HOST, SITE_URL, SUPPORT_EMAIL, fillBrand, isSiteUrl } from '../agent/brand.js'

const SESSION_MS = 12 * 3600_000 // absolute limit
const IDLE_MS = 30 * 60_000 // signed out after 30 minutes without a request
const COOKIE = 'docstar_session'

export function createApp({ config, db, vault, activity, gmail, chrome, orchestrator, platforms, agent, status, views, maintenance, manual, alerts = null, tokens = null, reports = null, mirror = null, pusher = () => null, viasocket = null }) {
  const app = express()
  const sessions = new Map() // token -> { exp, seen }; in memory, so a restart signs everyone out
  const loginAttempts = new Map() // ip -> [timestamps]
  const allowedHosts = new Set([`localhost:${config.port}`, `127.0.0.1:${config.port}`, ...config.publicHosts])
  const secure = config.hosted ? '; Secure' : '' // hosted copies are served over HTTPS only

  app.disable('x-powered-by')
  app.set('etag', false)

  // DNS rebinding guard and security headers on everything.
  app.use((req, res, next) => {
    // Locally this blocks DNS rebinding. Hosted, the platform's proxy decides which host reaches the app.
    if (!config.hosted && !allowedHosts.has(req.headers.host)) return res.status(421).send('Unknown host')
    res.set({
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self' https://flow.viasocket.com",
        "connect-src 'self' https://*.viasocket.com",
        "frame-src https://*.viasocket.com",
        "img-src 'self' data: https:",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'"
      ].join('; '),
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store'
    })
    next()
  })
  // Hosted: the Mac pushes its records here and collects the buttons pressed on this dashboard (src/sync/mirror.js).
  // Its own bearer token, not a dashboard session; a larger body limit for the snapshot.
  if (mirror) {
    app.post('/sync/push', express.json({ limit: '16mb' }), (req, res) => {
      if (!safeEqual(req.get('authorization') || '', `Bearer ${mirror.token}`)) return res.status(401).json({ error: 'unauthorized' })
      try {
        const r = mirror.receive(req.body || {})
        res.status(r.conflict ? 409 : 200).json(r)
      } catch (e) { res.status(500).json({ error: maskError(e) }) }
    })
  }
  app.use(express.json({ limit: '64kb' }))

  // One-click Resume from a notification: the signed, single-use token is the permission. Opening the link only shows
  // what will happen; the button (a same-origin POST) does it. On a hosted copy the resume is queued for the agent.
  app.get('/r/:token', (req, res) => {
    try {
      const t = tokens.verify(req.params.token)
      const p = db.prepare('SELECT name, status, needs_you_reason FROM platforms WHERE id = ?').get(t.platformId)
      if (!p) throw Object.assign(new Error('That platform no longer exists'), { status: 404 })
      const ny = parseNeedsYou(p.needs_you_reason)
      res.type('html').send(actionPage(`Resume ${p.name}?`, `<p class="muted">Status: ${esc(label(p.status))}</p>${ny ? `<p><b>What happened:</b> ${esc(ny.what)}</p><p><b>What to do:</b> ${esc(ny.todo)}</p>` : ''}
        <form method="post"><button type="submit">I did it — resume</button></form>`))
    } catch (e) { res.status(e.status || 400).type('html').send(actionPage('Link not usable', `<p>${esc(e.message)}</p><p><a href="/#queue">Open the dashboard</a></p>`)) }
  })
  app.post('/r/:token', express.urlencoded({ extended: false, limit: '1kb' }), wrap(async (req, res) => {
    try {
      const t = tokens.verify(req.params.token, { consume: true })
      const name = db.prepare('SELECT name FROM platforms WHERE id = ?').get(t.platformId)?.name || 'The platform'
      if (mirror?.on()) {
        const c = mirror.queue('POST', `/api/platforms/${t.platformId}/resume`, {})
        return res.type('html').send(actionPage('Resume sent', `<p>${esc(c.label)} is pending and runs as soon as the agent is online.</p><p><a href="/#queue">Open the dashboard</a></p>`))
      }
      orchestrator.resumePlatform(t.platformId, { actor: 'operator' })
      activity.info('resumed_from_link', `${name}: resumed from a notification link`, { platformId: t.platformId })
      res.type('html').send(actionPage('Resumed', `<p>${esc(name)} is back with the agent.</p><p><a href="/#queue">Open the dashboard</a></p>`))
    } catch (e) { res.status(e.status || 400).type('html').send(actionPage('Could not resume', `<p>${esc(e.message)}</p><p><a href="/#queue">Open the dashboard</a></p>`)) }
  }))

  const cookieOf = req => Object.fromEntries(String(req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(([k]) => k))[COOKIE]
  const authed = req => {
    const t = cookieOf(req)
    const s = t && sessions.get(t)
    if (!s) return false
    if (s.exp < Date.now() || Date.now() - s.seen > IDLE_MS) { sessions.delete(t); return false }
    s.seen = Date.now()
    return true
  }
  const admin = createAdminPassword({ config })
  // Hosted, every request arrives from the platform's proxy: the client is the first X-Forwarded-For entry.
  const clientIp = req => (config.hosted ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || req.socket.remoteAddress
  const throttle = req => {
    const ip = clientIp(req)
    // 5 a minute; 10 in 15 minutes locks this address out for 15 minutes.
    const recent = (loginAttempts.get(ip) || []).filter(t => Date.now() - t < 15 * 60_000)
    if (recent.length >= 10) { const e = new Error('Too many attempts: sign-in is locked for 15 minutes'); e.status = 429; activity.warn('login_locked', 'Dashboard sign-in locked for 15 minutes after repeated attempts'); throw e }
    if (recent.filter(t => Date.now() - t < 60_000).length >= 5) { const e = new Error('Too many attempts, wait a minute'); e.status = 429; throw e }
    recent.push(Date.now())
    loginAttempts.set(ip, recent)
  }
  const checkPassword = (req, password) => {
    throttle(req)
    if (!admin.isSet()) { const e = new Error('Sign-in is closed: set the admin password first'); e.status = 503; throw e }
    return admin.verify(password)
  }
  const startSession = res => {
    const token = randomBytes(32).toString('base64url')
    sessions.set(token, { exp: Date.now() + SESSION_MS, seen: Date.now() })
    res.set('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure}`)
  }

  // Writes need the CSRF header (a cross-site form cannot set it) and, when the browser sends one, our Origin.
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET') return next()
    const origin = req.headers.origin
    const ownHost = config.hosted ? (req.headers['x-forwarded-host'] || req.headers.host) : null
    const originHost = origin?.replace(/^https?:\/\//, '')
    if (origin && !allowedHosts.has(originHost) && originHost !== ownHost) return res.status(403).json({ error: 'Cross-origin request refused' })
    if (req.headers['x-docstar-csrf'] !== '1') return res.status(403).json({ error: 'Missing CSRF header' })
    next()
  })

  // Embarko's scheduler calls this every 5 minutes (embarko.json); it may run up to 5 minutes per call.
  app.get('/tasks/agent-tick', wrap(async (req, res) => {
    const expected = process.env.CRON_SECRET
    if (!expected || !safeEqual(req.get('authorization') || '', `Bearer ${expected}`)) return res.status(401).send('unauthorized')
    if (orchestrator.state() !== 'running') return res.send(`agent ${orchestrator.state()}: nothing run`)
    const rounds = await orchestrator.drain(230_000)
    const checked = await agent.backlinks.runDue(10)
    res.send(`ran ${rounds} queue round(s), checked ${checked} backlink(s); tasks ${JSON.stringify(orchestrator.counts())}`)
  }))

  // Which build is running: the git commit scripts/deploy.sh sent as X-App-Version (Embarko exposes it as
  // APP_VERSION). Public, so the deploy script and anyone checking can confirm the live copy matches main.
  app.get('/api/version', (req, res) => res.set('Cache-Control', 'no-store').json({ version: process.env.APP_VERSION || 'local', hosted: config.hosted }))

  app.get('/api/session', (req, res) => res.json({
    authenticated: authed(req),
    hosted: config.hosted,
    signInOpen: admin.isSet(),
    viasocket: config.viasocketConfigured,
    mirror: mirror ? mirror.info() : null
  }))

  // Mac: run a button pressed on the hosted dashboard through this server's own API, exactly as if pressed here.
  // A one-minute internal session; the same checks and handlers as a click on the local dashboard.
  app.locals.replay = async ({ method, path: p, body }) => {
    const token = randomBytes(32).toString('base64url')
    sessions.set(token, { exp: Date.now() + 60_000, seen: Date.now() })
    try {
      const res = await fetch(`http://127.0.0.1:${config.port}${p}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-DocStar-CSRF': '1', Cookie: `${COOKIE}=${token}` },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(120_000)
      })
      const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text()
      return { status: res.status, data }
    } finally {
      sessions.delete(token)
    }
  }
  app.post('/api/login', wrap(async (req, res) => {
    if (!checkPassword(req, req.body?.password)) {
      activity.warn('login_failed', 'Dashboard sign-in failed')
      return res.status(401).json({ error: 'Wrong password' })
    }
    startSession(res)
    res.json({ authenticated: true })
  }))
  app.post('/api/logout', (req, res) => {
    sessions.delete(cookieOf(req))
    res.set('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`)
    res.json({ authenticated: false })
  })

  app.use('/api', (req, res, next) => (authed(req) ? next() : res.status(401).json({ error: 'Sign in first' })))

  // Hosted and mirroring the Mac: Chrome, Gmail and the run state are the Mac's, and every change is sent to the
  // Mac to carry out (it collects them within seconds). Records shown here are the Mac's, replaced on each push.
  const mirroring = () => Boolean(mirror?.on())
  const runState = () => (mirroring() ? mirror.state() : orchestrator.state())
  if (mirror) {
    app.use('/api', (req, res, next) => {
      if (!mirroring()) return next()
      if (req.method === 'GET') {
        if (req.path === '/chrome/status') return res.json(mirror.chrome())
        if (req.path === '/gmail/status') return res.json(mirror.gmail())
        if (req.path === '/viasocket/connect-token') {
          const info = mirror.connectInfo()
          return info ? res.json(info) : res.status(503).json({ error: 'The Mac has not shared Gmail connect details yet; is it online?' })
        }
        if (req.path === '/automation') return res.json({ state: runState(), tasks: orchestrator.counts(), workerId: 'mac' })
        return next()
      }
      if (/\/reveal$/.test(req.path)) return res.status(403).json({ error: 'Passwords stay on the Mac: reveal them in the local dashboard.' })
      // Recorded and shown as pending at once; "Applied" or "Failed: why" arrives when the agent has run it.
      const command = mirror.queue(req.method, req.originalUrl, req.body)
      res.status(202).json({
        queued: true, id: command.id, command, duplicate: Boolean(command.duplicate),
        message: command.duplicate ? `Already pending: ${command.label}` : mirror.online()
          ? `Pending: ${command.label}. The agent applies it in a few seconds.`
          : `Pending — will apply when the agent is online: ${command.label}`
      })
    })
  }

  // Overview and automation
  app.get('/api/overview', wrap(async (req, res) => {
    const slot = signupSlot(db)
    res.json({ ...views.overview(), automation: runState(), tasks: orchestrator.counts(), signupsLastHour: slot.usedHour, signupsToday: slot.usedDay,
      companyApproved: Boolean(agent.company.approved()) })
  }))
  app.get('/api/automation', (req, res) => res.json({ state: orchestrator.state(), tasks: orchestrator.counts(), workerId: orchestrator.workerId }))
  app.post('/api/automation/:action', wrap(async (req, res) => {
    const fn = { start: 'start', pause: 'pause', resume: 'resume', stop: 'stop' }[req.params.action]
    if (!fn) return res.status(404).json({ error: 'Unknown action' })
    res.json({ state: await orchestrator[fn]() })
  }))

  // Platforms
  app.get('/api/categories', (req, res) => res.json(platforms.categories()))
  app.get('/api/platforms', (req, res) => res.json(platforms.list(req.query)))
  app.get('/api/platforms/:id', (req, res) => {
    const id = Number(req.params.id)
    const p = platforms.get(id)
    if (!p) return res.status(404).json({ error: 'No such platform' })
    res.json({
      ...p,
      needsYou: parseNeedsYou(p.needs_you_reason),
      timeline: status.timeline(id),
      tasks: db.prepare(`SELECT id, type, state, step, attempts, last_error, error_history, run_after, wait_for, created_at, updated_at FROM automation_tasks WHERE platform_id = ? ORDER BY id DESC LIMIT 20`).all(id),
      scores: db.prepare(`SELECT overall, relevance, domain_reputation, audience_quality, credibility, backlink_quality, method, reason, scored_at FROM platform_scores WHERE platform_id = ? ORDER BY scored_at DESC, id DESC LIMIT 10`).all(id),
      listing: agent.listings.get(id),
      account: db.prepare(`SELECT email, login_method, status, signup_completed_at, signup_inferred, created_at FROM accounts WHERE platform_id = ?`).get(id) ?? null,
      backlinkHistory: db.prepare(`SELECT h.checked_at, h.http_status, h.link_present, h.rel, h.anchor_text, h.indexable, h.note FROM backlink_history h
        JOIN backlinks b ON b.id = h.backlink_id JOIN submissions s ON s.id = b.submission_id WHERE s.platform_id = ? ORDER BY h.checked_at DESC LIMIT 20`).all(id),
      emails: db.prepare(`SELECT sender, subject, received_at, purpose FROM emails_used WHERE platform_id = ? ORDER BY at DESC LIMIT 20`).all(id),
      screenshots: db.prepare(`SELECT id, step, note, at FROM screenshots WHERE platform_id = ? ORDER BY at DESC LIMIT 12`).all(id),
      playbook: JSON.parse(db.prepare(`SELECT data FROM platform_playbooks WHERE platform_id = ?`).get(id)?.data || 'null'),
      contradictions: status.contradictions(id)[0]?.problems || []
    })
  })
  app.post('/api/platforms', wrap(async (req, res) => {
    // The final domain after redirects is what is stored and compared (g2crowd.com → g2.com).
    const raw = String(req.body?.url || '')
    const final = await resolveFinalUrl(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).catch(() => raw)
    const r = platforms.create({ name: req.body?.name, url: final, category: req.body?.category, notes: req.body?.notes })
    res.status(r.created ? 201 : 409).json(r)
  }))
  app.patch('/api/platforms/:id', wrap(async (req, res) => res.json(platforms.update(Number(req.params.id), req.body || {}))))
  app.delete('/api/platforms/:id', wrap(async (req, res) => { platforms.remove(Number(req.params.id)); res.json({ ok: true }) }))
  app.post('/api/platforms/import-seeds', wrap(async (req, res) => res.json(platforms.importSeeds())))
  app.get('/api/export/platforms.csv', (req, res) => {
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${BRAND_SLUG}-platforms-${now().slice(0, 10)}.csv"` })
    res.send('﻿' + platforms.toCsv())
    activity.info('csv_exported', 'Platforms exported to CSV')
  })

  // Human-in-the-loop
  app.get('/api/approvals', (req, res) => res.json(agent.approvals.pending()))
  app.post('/api/approvals/:id/:decision', wrap(async (req, res) => {
    const id = Number(req.params.id)
    const { decision } = req.params
    if (decision === 'approve') agent.approvals.approve(id, req.body?.listing ? cleanListing(req.body.listing) : null)
    else if (decision === 'reject') agent.approvals.reject(id, req.body?.note)
    else if (decision === 'skip') agent.approvals.skip(id, req.body?.note)
    else return res.status(404).json({ error: 'Unknown decision' })
    res.json({ ok: true })
  }))

  // DocStar profile: the only facts listings may use
  app.get('/api/company', (req, res) => res.json({ fields: agent.company.fields, values: agent.company.get(), approved: Boolean(agent.company.approved()) }))
  app.put('/api/company', wrap(async (req, res) => {
    const body = req.body || {}
    // Checked before anything is saved, so a wrong website never leaves the profile half-edited.
    if ('website' in body && !isSiteUrl(/^https?:\/\//i.test(String(body.website).trim()) ? String(body.website).trim() : `https://${String(body.website).trim()}`)) {
      return res.status(400).json({ error: `Website must be ${SITE_URL}` })
    }
    for (const [k, v] of Object.entries(body)) agent.company.save(k, String(v).slice(0, 5000))
    activity.info('company_edited', `${BRAND} profile edited (${Object.keys(req.body || {}).join(', ')}); needs approval again`)
    res.json({ ok: true })
  }))
  app.post('/api/company/draft', wrap(async (req, res) => res.json(await agent.company.draftFromWebsite())))
  app.post('/api/company/approve', wrap(async (req, res) => res.json({ approved: agent.approveCompany() })))

  // Agent actions on one platform
  app.post('/api/discovery/run', wrap(async (req, res) => res.json({ queued: agent.queueDiscovery(true) })))
  app.post('/api/platforms/:id/qualify', wrap(async (req, res) => {
    const id = Number(req.params.id)
    const p = status.get(id)
    if (!p) return res.status(404).json({ error: 'No such platform' })
    if (!['discovered', 'rejected', 'paid_skipped', 'evaluation_failed'].includes(p.status)) return res.status(409).json({ error: `${p.name} is ${label(p.status).toLowerCase()}; only discovered, rejected, skipped or failed evaluations are re-evaluated` })
    db.transaction(() => {
      if (p.status !== 'discovered') status.transition(id, 'discovered', { actor: 'operator', operator: true, reason: 're-evaluation requested' })
      // Re-evaluating on request: the earlier evaluation stops counting as the one finished qualify task.
      db.prepare(`UPDATE automation_tasks SET state = 'cancelled', updated_at = ? WHERE platform_id = ? AND type = 'qualify' AND state IN ('done','failed')`).run(now(), id)
    })()
    res.json(orchestrator.enqueue(id, 'qualify', { checkpoint: { force: true } }))
  }))
  app.post('/api/platforms/:id/retry', wrap(async (req, res) => res.json(orchestrator.retryPlatform(Number(req.params.id)))))
  app.post('/api/platforms/:id/resume', wrap(async (req, res) => res.json(orchestrator.resumePlatform(Number(req.params.id)))))
  app.post('/api/platforms/:id/needs-you', wrap(async (req, res) => {
    const id = Number(req.params.id)
    const p = status.get(id)
    if (!p) return res.status(404).json({ error: 'No such platform' })
    orchestrator.cancelPlatformTasks(id, 'handed to you')
    status.transition(id, 'needs_you', { actor: 'operator', needsYou: { what: String(req.body?.note || `Marked as needing you (was ${label(p.status).toLowerCase()})`).slice(0, 500), todo: 'Finish the step by hand, then press Resume, or Mark as done manually.' } })
    res.json({ ok: true })
  }))
  app.post('/api/platforms/:id/reject', wrap(async (req, res) => {
    res.json(platforms.update(Number(req.params.id), { status: 'rejected', note: req.body?.note || null, reason: 'operator' }))
  }))
  app.get('/api/needs-you', (req, res) => res.json(views.needsYou()))
  app.get('/api/added', (req, res) => res.json(views.added()))
  app.get('/api/product-activity', (req, res) => {
    const since = /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(String(req.query.since || '')) ? String(req.query.since) : null
    res.json(views.productActivity({ since }))
  })
  app.get('/api/metrics', (req, res) => res.json(reports.metrics({ days: Math.min(Number(req.query.days) || 30, 365) })))
  app.get('/api/summary', (req, res) => {
    const s = reports.summary({ days: Math.min(Number(req.query.days) || 7, 90) })
    res.json({ ...s, text: reports.render(s), alerts: alerts?.configured() ?? null, frequency: getSetting(db, 'summary_frequency', 'weekly') })
  })
  app.get('/api/export/added.csv', (req, res) => {
    const a = views.added()
    const d = t => (t ? t.slice(0, 10) : '')
    const ms = (r, k) => d(r.timeline.find(x => x.key === k)?.at)
    const rows = [...a.live.map(r => ({ ...r, group: 'Live with backlink' })), ...a.published.map(r => ({ ...r, group: 'Published, backlink not counted yet' })),
      ...a.awaiting.map(r => ({ ...r, group: 'Submitted, awaiting platform review' }))]
    const cols = [['Group', 'group'], ['Platform', 'name'], ['Domain', 'domain'], ['Listing URL', 'listing_url'], ['Backlink page', 'backlink_page'],
      ['Link', r => (r.backlink_status === 'live' ? (r.is_dofollow ? 'dofollow' : r.rel || 'nofollow') : '')], ['Anchor text', 'anchor_text'],
      ['Found', 'found'], ['First verified', r => d(r.first_seen_at)], ['Last re-verified', r => d(r.last_checked_at)], ['Account', 'account_email'],
      ['Signed up with', r => (r.login_method ? label(r.login_method) : '')], ['Submitted', r => d(r.submitted_at)], ['Days waiting', 'waitingDays'],
      ['Discovered', r => ms(r, 'discovered')], ['Qualified', r => ms(r, 'qualified')], ['Approved', r => ms(r, 'approved')], ['Account created', r => ms(r, 'registered')],
      ['Published', r => ms(r, 'published')], ['Live', r => ms(r, 'live')], ['Added by', r => (r.manual ? 'a person' : 'the agent')]]
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${BRAND_SLUG}-successfully-added-${now().slice(0, 10)}.csv"` })
    res.send('\ufeff' + toCsv(cols, rows))
    activity.info('csv_exported', 'Successfully added exported to CSV')
  })
  app.get('/api/failed', (req, res) => res.json(views.failed()))
  app.get('/api/pipeline', (req, res) => res.json(views.approvedPipeline()))
  app.get('/api/invariants', (req, res) => res.json(maintenance ? maintenance.invariants() : []))
  app.post('/api/maintenance/reconcile', wrap(async (req, res) => res.json({ fixes: maintenance.reconcile() })))
  app.post('/api/maintenance/sweep', wrap(async (req, res) => res.json(maintenance.sweep())))
  // Any platform, whatever its status: a person records the listing (and the account) and the agent checks it.
  app.post('/api/platforms/:id/listing-url', wrap(async (req, res) => {
    const { check, ...r } = manual.setListingUrl(Number(req.params.id), String(req.body?.url || ''))
    res.json({ ...r, message: 'Listing URL saved; checking the backlink' })
  }))
  app.post('/api/platforms/:id/manual-complete', wrap(async (req, res) => {
    const b = req.body || {}
    const { check, ...r } = manual.complete(Number(req.params.id), { accountEmail: b.accountEmail, listingUrl: b.listingUrl, backlinkUrl: b.backlinkUrl, notes: b.notes, loginMethod: b.loginMethod })
    res.json({ ...r, message: `Recorded as done (${label(r.status).toLowerCase()})` })
  }))
  app.post('/api/platforms/:id/check-backlink', wrap(async (req, res) => {
    const b = db.prepare(`SELECT b.* FROM backlinks b JOIN submissions s ON s.id = b.submission_id WHERE s.platform_id = ?`).get(Number(req.params.id))
    if (!b) return res.status(400).json({ error: 'No listing URL recorded for this platform yet' })
    res.json(await agent.backlinks.check(b))
  }))
  // Sync state for the header on every page, and the Pending changes panel.
  app.get('/api/sync', (req, res) => {
    const hb = JSON.parse(getSetting(db, 'worker_heartbeat', 'null') || 'null')
    const workerOnline = Boolean(hb && Date.now() - Date.parse(hb.at) < 90_000)
    if (mirroring()) {
      const m = mirror.info()
      return res.json({ hosted: true, mirroring: true, agentOnline: m.online, lastSynced: m.lastRecords || m.lastPush, lastContact: m.lastPush, source: m.source, pending: m.pending, worker: m.worker })
    }
    const p = pusher()
    res.json({ hosted: config.hosted, mirroring: false, agentOnline: workerOnline, worker: hb, mirrorTarget: p ? new URL(config.mirror.url).host : null,
      lastSynced: p ? p.info().lastOk : null, mirrorFailing: p ? p.info().failures > 0 : false, failingSince: p?.info().failingSince ?? null, pending: 0 })
  })
  app.get('/api/commands', (req, res) => {
    if (mirror) return res.json(mirror.commands({ limit: req.query.limit }))
    // On the agent: the hosted dashboard's changes it applied, with their outcome.
    const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mirror_applied'`).get()
      ? db.prepare(`SELECT id, CASE ok WHEN 1 THEN 'applied' ELSE 'failed' END state, message result, status http_status, at applied_at FROM mirror_applied ORDER BY at DESC LIMIT 50`).all() : []
    res.json(rows)
  })

  app.get('/api/tasks', (req, res) => res.json(db.prepare(`SELECT t.id, t.type, t.state, t.step, t.attempts, t.last_error, t.updated_at, p.name platform
    FROM automation_tasks t LEFT JOIN platforms p ON p.id = t.platform_id ${req.query.state ? 'WHERE t.state = ?' : ''} ORDER BY t.updated_at DESC LIMIT 200`)
    .all(...(req.query.state ? [req.query.state] : []))))
  app.post('/api/tasks/:id/resume', wrap(async (req, res) => res.json(orchestrator.resumeTask(Number(req.params.id)))))
  app.post('/api/tasks/:id/cancel', wrap(async (req, res) => res.json(orchestrator.cancelTask(Number(req.params.id)))))

  // Activity: history and a live stream
  // Paginated on the server: newest first, `before` = the last id the page has.
  app.get('/api/activity', (req, res) => res.json(activity.recent(req.query.limit, {
    level: req.query.level, event: req.query.event, platformId: req.query.platform, taskId: req.query.task, q: req.query.q ? String(req.query.q).slice(0, 100) : null, before: req.query.before })))
  app.get('/api/platform-names', (req, res) => res.json(db.prepare('SELECT id, name FROM platforms ORDER BY name COLLATE NOCASE').all()))
  // A screenshot of a key step, only from the screenshots folder next to the database.
  app.get('/api/screenshots/:id', (req, res) => {
    const row = db.prepare('SELECT file FROM screenshots WHERE id = ?').get(Number(req.params.id))
    const base = path.resolve(path.dirname(config.dbPath), 'screenshots')
    const file = row && path.resolve(path.dirname(config.dbPath), row.file)
    if (!file || !file.startsWith(base + path.sep) || !existsSync(file)) return res.status(404).json({ error: mirror?.on() ? 'Screenshots stay on the agent: open them in its local dashboard.' : 'No such screenshot' })
    res.type('png').sendFile(file)
  })
  app.get('/api/activity/stream', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', Connection: 'keep-alive' })
    res.flushHeaders()
    const send = e => res.write(`data: ${JSON.stringify(e)}\n\n`)
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000)
    // Hosted mirror: fresh numbers from the Mac arrived; open dashboards reload what they show.
    const synced = e => res.write(`event: sync\ndata: ${JSON.stringify(e)}\n\n`)
    // A change made on the hosted dashboard moved on (queued → sent → applied | failed).
    const command = e => res.write(`event: command\ndata: ${JSON.stringify(e)}\n\n`)
    activity.feed.on('entry', send)
    activity.feed.on('sync', synced)
    activity.feed.on('command', command)
    req.on('close', () => { clearInterval(ping); activity.feed.off('entry', send); activity.feed.off('sync', synced); activity.feed.off('command', command) })
  })

  // Chrome
  app.get('/api/chrome/status', wrap(async (req, res) => res.json(await chrome.status())))
  app.post('/api/chrome/launch', wrap(async (req, res) => { await chrome.connect(); await chrome.bringToFront(); res.json(await chrome.status()) }))
  app.post('/api/chrome/google-signin', wrap(async (req, res) => { await chrome.openGoogleSignIn(); res.json({ ok: true }) }))
  app.post('/api/chrome/front', wrap(async (req, res) => { await chrome.bringToFront(); res.json({ ok: true }) }))
  // Open a needs-you page in the agent's Chrome, for the person to finish the step there.
  app.post('/api/chrome/open', wrap(async (req, res) => { await chrome.open(String(req.body?.url || '')); res.json({ ok: true }) }))
  app.post('/api/chrome/close', wrap(async (req, res) => {
    if (orchestrator.state() === 'running') return res.status(409).json({ error: 'Pause or stop the automation first' })
    await chrome.close({ quit: true })
    activity.info('chrome_closed', 'Chrome closed by the operator')
    res.json({ ok: true })
  }))

  // Gmail through viaSocket
  app.get('/api/gmail/status', wrap(async (req, res) => res.json(await gmail.status({ fresh: req.query.fresh === '1' }))))
  app.get('/api/viasocket/connect-token', wrap(async (req, res) => {
    const status = await gmail.status()
    res.json({
      token: await gmail.embedToken(), // the one viaSocket value a browser may hold
      serviceId: await gmail.serviceId(),
      actions: gmail.consentActions(),
      // Only to sign an expired connection in again in place; viaSocket's popup needs it in the browser.
      reconnectAuthId: status.expired ? gmail.authIdForReconnect() : undefined
    })
  }))
  app.post('/api/gmail/connected', wrap(async (req, res) => {
    const authId = req.body?.authId
    if (typeof authId !== 'string' || !/^[A-Za-z0-9_]{6,200}$/.test(authId)) return res.status(400).json({ error: 'Bad connection id' })
    res.json(await gmail.saveConnection(authId))
  }))
  app.post('/api/gmail/test', wrap(async (req, res) => res.json(await gmail.test())))
  app.post('/api/gmail/disconnect', wrap(async (req, res) => { gmail.disconnect(); res.json({ connected: false }) }))

  // Credentials: listed without secrets; one revealed only after the admin password is typed again.
  app.get('/api/credentials', (req, res) => res.json(db.prepare(`SELECT a.id, p.id platform_id, p.name platform, p.domain, p.url platform_url, a.profile_url, p.status platform_status,
      CASE WHEN p.status IN ('published','live_backlink','no_backlink') THEN s.listing_url END listing_url,
      a.email, a.login_method, a.status, a.created_at, a.signup_completed_at, a.signup_inferred, (c.id IS NOT NULL) has_password, c.revealed_at
    FROM accounts a JOIN platforms p ON p.id = a.platform_id LEFT JOIN credentials c ON c.account_id = a.id
    LEFT JOIN submissions s ON s.platform_id = p.id ORDER BY p.name`).all()))
  app.post('/api/credentials/:accountId/reveal', wrap(async (req, res) => {
    if (!checkPassword(req, req.body?.password)) {
      activity.warn('credential_reveal_denied', 'Credential reveal refused: wrong admin password')
      return res.status(401).json({ error: 'Wrong password' })
    }
    const row = db.prepare(`SELECT c.secret_enc, p.name, p.id platform_id FROM credentials c JOIN accounts a ON a.id = c.account_id
      JOIN platforms p ON p.id = a.platform_id WHERE c.account_id = ?`).get(Number(req.params.accountId))
    if (!row) return res.status(404).json({ error: 'No stored password for this account' })
    db.prepare('UPDATE credentials SET revealed_at = ? WHERE account_id = ?').run(now(), Number(req.params.accountId))
    activity.info('credential_revealed', `Password for ${row.name} revealed to the operator`, { platformId: row.platform_id })
    res.set('Cache-Control', 'no-store').json({ password: vault.decrypt(row.secret_enc) })
  }))

  // Settings
  const SETTINGS = {
    max_signups_per_hour: [1, 10], max_signups_per_day: [1, 50], parallel_tasks: [1, 8], max_attempts: [1, 10], stale_minutes: [10, 240],
    backlink_recheck_live_hours: [6, 168], backlink_recheck_pending_hours: [1, 72], nofollow_counts_as_live: [0, 1],
    require_approval: [0, 1], auto_approve: [0, 1], auto_approve_min_score: [30, 100], min_quality_score: [30, 90], discovery_batch: [3, 20],
    offline_alert_minutes: [5, 120]
  }
  const DEFAULTS = { require_approval: 1, min_quality_score: 55, discovery_batch: 10, max_signups_per_day: 10, parallel_tasks: 3, max_attempts: 5, stale_minutes: 30,
    backlink_recheck_live_hours: 24, backlink_recheck_pending_hours: 12, nofollow_counts_as_live: 1, auto_approve: 0, auto_approve_min_score: 65, offline_alert_minutes: 10, max_signups_per_hour: 3 }
  const settingValue = k => Number(getSetting(db, k, DEFAULTS[k]))
  const TEXT_SETTINGS = { summary_frequency: ['off', 'daily', 'weekly'] }
  const allSettings = () => ({ ...Object.fromEntries(Object.keys(SETTINGS).map(k => [k, settingValue(k)])), summary_frequency: getSetting(db, 'summary_frequency', 'weekly') })
  app.get('/api/settings', (req, res) => res.json(allSettings()))
  app.patch('/api/settings', wrap(async (req, res) => {
    for (const [k, v] of Object.entries(req.body || {})) {
      if (TEXT_SETTINGS[k]) {
        if (!TEXT_SETTINGS[k].includes(v)) return res.status(400).json({ error: `${k} must be one of ${TEXT_SETTINGS[k].join(', ')}` })
        setSetting(db, k, v); activity.info('setting_changed', `${k} set to ${v}`); continue
      }
      const range = SETTINGS[k]
      const n = Number(v)
      if (!range) return res.status(400).json({ error: `Unknown setting ${k}` })
      if (!Number.isInteger(n) || n < range[0] || n > range[1]) return res.status(400).json({ error: `${k} must be ${range[0]}–${range[1]}` })
      setSetting(db, k, n)
      activity.info('setting_changed', `${k} set to ${n}`)
    }
    orchestrator.wake() // a higher limit or more parallel slots may let waiting work start now
    res.json(allSettings())
  }))

  // Growth: ICP research and lead pipeline. Read and status-tracking only; there is no send endpoint by design.
  const gtm = createGtm({ db, root: ROOT })
  gtm.importLeads()
  app.get('/api/gtm/summary', (req, res) => res.json(gtm.summary()))
  app.get('/api/gtm/icps', (req, res) => res.json(gtm.icps()))
  app.get('/api/gtm/leads', (req, res) => res.json({ leads: gtm.leads(), statuses: gtm.statuses }))
  app.get('/api/gtm/channels', (req, res) => res.json(gtm.channels()))
  app.get('/api/gtm/doc/:name', (req, res) => res.type('text/plain').send(gtm.doc(req.params.name)))
  app.post('/api/gtm/import', (req, res) => res.json(gtm.importLeads()))
  app.patch('/api/gtm/leads/:key', (req, res) => {
    try { gtm.update(req.params.key, req.body || {}); res.json({ ok: true }) } catch (e) { res.status(400).json({ error: e.message }) }
  })
  app.get('/api/health', (req, res) => res.json({ ok: true, db: db.prepare('SELECT 1 ok').get().ok === 1 }))
  // Outreach: lists come from the database (written by the local outreach module, mirrored to the hosted copy).
  // Searching and sending run only on the Mac; on the hosted copy those POSTs are queued for the Mac like any change.
  const outreachOn = () => Boolean(localOutreach && !config.hosted) || mirroring()
  app.get('/api/outreach', (req, res) => {
    if (!outreachOn()) return res.status(404).json({ error: 'Not found' })
    res.json({ enabled: true, from: 'DocStar by Walkover <support@docstar.io>', emails: gtm.outreachEmails() })
  })
  app.get('/api/outreach/find', (req, res) => {
    if (!outreachOn()) return res.status(404).json({ error: 'Not found' })
    res.json(JSON.parse(getSetting(db, 'gtm_find_job', 'null') || 'null') || { running: false, log: [] })
  })
  app.get('/outreach', (req, res, next) => (outreachOn() ? res.sendFile(path.join(ROOT, 'public', 'outreach.html')) : next()))
  // Cold-email sending (src/outreach): tables on both copies; the sender itself only on the Mac.
  const outreachStore = createOutreachStore(db)
  let outreachEngine = null
  const { gmailFor } = registerOutreachRoutes(app, { db, vault, activity, viasocket, config, store: outreachStore, engine: () => outreachEngine, outreachOn })
  if (localOutreach && !config.hosted) {
    const hooks = localOutreach.register(app, { db, gmail, gtm, activity, root: ROOT, config })
    if (hooks?.render && viasocket) {
      outreachEngine = createOutreachEngine({ db, store: outreachStore, activity, gmailFor, ...hooks })
      outreachEngine.start()
      app.locals.outreachEngine = outreachEngine
    }
  }
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }))

  // The browser half of viaSocket Connect, served from the installed package.
  app.get('/vendor/viasocket-browser.js', (req, res) =>
    res.type('application/javascript').sendFile(path.join(ROOT, 'node_modules/viasocket-apps/dist/esm/browser.js')))
  // The state machine's statuses and labels, as a module the dashboard imports: one list for server and page.
  app.get('/labels.js', (req, res) => res.type('application/javascript').send(
    `export const STATUSES = ${JSON.stringify(STATUSES)};\nexport const LABELS = ${JSON.stringify({ ...OTHER_LABELS, ...LABELS })};\n` +
    `export const GROUPS = ${JSON.stringify(platforms.GROUPS)};\nexport const label = s => LABELS[s] ?? String(s ?? '').replace(/_/g, ' ');\n`))
  // The brand (name, site, support email) from brand.config.json: filled into the page and offered as a module.
  app.get('/brand.js', (req, res) => res.type('application/javascript').send(
    `export const BRAND = ${JSON.stringify(BRAND)}, SITE_HOST = ${JSON.stringify(SITE_HOST)}, SITE_URL = ${JSON.stringify(SITE_URL)}, SUPPORT_EMAIL = ${JSON.stringify(SUPPORT_EMAIL)};\n`))
  const indexHtml = fillBrand(readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8'))
  app.get(['/', '/index.html'], (req, res) => res.type('html').send(indexHtml))
  app.use(express.static(path.join(ROOT, 'public'), { index: 'index.html' }))

  // Errors: masked message to the client and the log, never a stack or a secret.
  app.use((err, req, res, next) => {
    const msg = maskError(err)
    const status = err.status || (/not connected|No such|already|must|Only|Not a valid|cannot|is set by|Has an account|not waiting|not pending|Unknown|not approved|No submission|No listing/i.test(err.message) ? 400 : 500)
    if (status >= 500) activity.error('api_error', `${req.method} ${req.path}: ${msg}`)
    res.status(status).json({ error: msg })
  })

  return app
}

function cleanListing(l) {
  const str = (v, n) => String(v ?? '').slice(0, n)
  return { title: str(l.title, 120), tagline: str(l.tagline, 120), short_description: str(l.short_description, 300),
    long_description: str(l.long_description, 4000), tags: String(l.tags ?? '').split(',').map(t => t.trim()).filter(Boolean).slice(0, 12),
    anchor_text: str(l.anchor_text, 80) }
}

const wrap = fn => (req, res, next) => fn(req, res, next).catch(next)
