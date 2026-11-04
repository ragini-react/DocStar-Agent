// The dashboard's HTTP API. Listens on 127.0.0.1 only; every /api route except login needs the admin session;
// every write also needs the CSRF header and a same-origin request. Responses never carry a secret except the
// one credential the operator explicitly reveals after typing the admin password again.
import express from 'express'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { ROOT } from '../config/index.js'
import { createAdminPassword } from '../security/adminPassword.js'
import { safeEqual } from '../security/crypto.js'
import { maskError } from '../security/mask.js'
import { getSetting, now, setSetting } from '../db/index.js'

const SESSION_MS = 12 * 3600_000
const COOKIE = 'docstar_session'

export function createApp({ config, db, vault, activity, gmail, chrome, orchestrator, platforms, agent, mirror = null }) {
  const app = express()
  const sessions = new Map() // token -> expiresAt; in memory, so a restart signs everyone out
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
      try { res.json(mirror.receive(req.body || {})) } catch (e) { res.status(500).json({ error: maskError(e) }) }
    })
  }
  app.use(express.json({ limit: '64kb' }))

  const cookieOf = req => Object.fromEntries(String(req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(([k]) => k))[COOKIE]
  const authed = req => {
    const t = cookieOf(req)
    const exp = t && sessions.get(t)
    if (!exp) return false
    if (exp < Date.now()) { sessions.delete(t); return false }
    return true
  }
  const admin = createAdminPassword({ config })
  // Hosted, every request arrives from the platform's proxy: the client is the first X-Forwarded-For entry.
  const clientIp = req => (config.hosted ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || req.socket.remoteAddress
  const throttle = req => {
    const ip = clientIp(req)
    const recent = (loginAttempts.get(ip) || []).filter(t => Date.now() - t < 60_000)
    if (recent.length >= 5) { const e = new Error('Too many attempts, wait a minute'); e.status = 429; throw e }
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
    sessions.set(token, Date.now() + SESSION_MS)
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
    sessions.set(token, Date.now() + 60_000)
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
      const id = mirror.queue(req.method, req.originalUrl, req.body)
      res.status(202).json({
        queued: true, id,
        message: mirror.online() ? 'Sent to the agent on the Mac: it runs in a few seconds.' : 'The Mac is offline: this runs when it reconnects.'
      })
    })
  }

  // Overview and automation
  app.get('/api/overview', wrap(async (req, res) => {
    res.json({ ...platforms.overview(), automation: runState(), tasks: orchestrator.counts(), signupsLastHour: orchestrator.signupsInLastHour(),
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
    const p = platforms.get(Number(req.params.id))
    return p ? res.json(p) : res.status(404).json({ error: 'No such platform' })
  })
  app.post('/api/platforms', wrap(async (req, res) => {
    const r = platforms.create({ name: req.body?.name, url: req.body?.url, category: req.body?.category, notes: req.body?.notes })
    res.status(r.created ? 201 : 409).json(r)
  }))
  app.patch('/api/platforms/:id', wrap(async (req, res) => res.json(platforms.update(Number(req.params.id), req.body || {}))))
  app.delete('/api/platforms/:id', wrap(async (req, res) => { platforms.remove(Number(req.params.id)); res.json({ ok: true }) }))
  app.post('/api/platforms/import-seeds', wrap(async (req, res) => res.json(platforms.importSeeds())))
  app.get('/api/export/platforms.csv', (req, res) => {
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="docstar-platforms-${now().slice(0, 10)}.csv"` })
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
    for (const [k, v] of Object.entries(req.body || {})) agent.company.save(k, String(v).slice(0, 5000))
    activity.info('company_edited', `DocStar profile edited (${Object.keys(req.body || {}).join(', ')}); needs approval again`)
    res.json({ ok: true })
  }))
  app.post('/api/company/draft', wrap(async (req, res) => res.json(await agent.company.draftFromWebsite())))
  app.post('/api/company/approve', wrap(async (req, res) => res.json({ approved: agent.approveCompany() })))

  // Agent actions on one platform
  app.post('/api/discovery/run', wrap(async (req, res) => res.json({ queued: agent.queueDiscovery(true) })))
  app.post('/api/platforms/:id/qualify', wrap(async (req, res) => {
    const id = Number(req.params.id)
    db.prepare(`UPDATE platforms SET status = 'discovered', updated_at = ? WHERE id = ? AND status IN ('failed','discovered','rejected')`).run(now(), id)
    // Re-evaluating on request: the earlier evaluation stops counting as the one finished qualify task.
    db.prepare(`UPDATE automation_tasks SET state = 'cancelled', updated_at = ? WHERE platform_id = ? AND type = 'qualify' AND state IN ('done','failed')`).run(now(), id)
    res.json(orchestrator.enqueue(id, 'qualify'))
  }))
  app.post('/api/platforms/:id/retry', wrap(async (req, res) => {
    const id = Number(req.params.id)
    // Finished work is never redone: a listing already submitted or live is not submitted a second time.
    const done = db.prepare(`SELECT 1 FROM platforms p LEFT JOIN submissions s ON s.platform_id = p.id
      WHERE p.id = ? AND (p.status IN ('submitted','live_backlink','pending_approval') OR s.status IN ('submitted','published','pending_approval'))`).get(id)
    if (done) return res.status(409).json({ error: 'This platform already has a submitted listing; it is not submitted again.' })
    res.json(orchestrator.enqueue(id, 'submit'))
  }))
  app.post('/api/platforms/:id/listing-url', wrap(async (req, res) => {
    agent.backlinks.setListingUrl(Number(req.params.id), String(req.body?.url || ''))
    res.json({ ok: true })
  }))
  app.post('/api/platforms/:id/check-backlink', wrap(async (req, res) => {
    const b = db.prepare(`SELECT b.* FROM backlinks b JOIN submissions s ON s.id = b.submission_id WHERE s.platform_id = ?`).get(Number(req.params.id))
    if (!b) return res.status(400).json({ error: 'No listing URL recorded for this platform yet' })
    res.json(await agent.backlinks.check(b))
  }))

  app.get('/api/tasks', (req, res) => res.json(db.prepare(`SELECT t.id, t.type, t.state, t.step, t.attempts, t.last_error, t.updated_at, p.name platform
    FROM automation_tasks t LEFT JOIN platforms p ON p.id = t.platform_id ${req.query.state ? 'WHERE t.state = ?' : ''} ORDER BY t.updated_at DESC LIMIT 200`)
    .all(...(req.query.state ? [req.query.state] : []))))
  app.post('/api/tasks/:id/resume', wrap(async (req, res) => { orchestrator.resumeTask(Number(req.params.id)); res.json({ ok: true }) }))

  // Activity: history and a live stream
  app.get('/api/activity', (req, res) => res.json(activity.recent(req.query.limit, { level: req.query.level })))
  app.get('/api/activity/stream', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', Connection: 'keep-alive' })
    res.flushHeaders()
    const send = e => res.write(`data: ${JSON.stringify(e)}\n\n`)
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000)
    // Hosted mirror: fresh numbers from the Mac arrived; open dashboards reload what they show.
    const synced = e => res.write(`event: sync\ndata: ${JSON.stringify(e)}\n\n`)
    activity.feed.on('entry', send)
    activity.feed.on('sync', synced)
    req.on('close', () => { clearInterval(ping); activity.feed.off('entry', send); activity.feed.off('sync', synced) })
  })

  // Chrome
  app.get('/api/chrome/status', wrap(async (req, res) => res.json(await chrome.status())))
  app.post('/api/chrome/launch', wrap(async (req, res) => { await chrome.connect(); await chrome.bringToFront(); res.json(await chrome.status()) }))
  app.post('/api/chrome/google-signin', wrap(async (req, res) => { await chrome.openGoogleSignIn(); res.json({ ok: true }) }))
  app.post('/api/chrome/front', wrap(async (req, res) => { await chrome.bringToFront(); res.json({ ok: true }) }))
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
  app.get('/api/credentials', (req, res) => res.json(db.prepare(`SELECT a.id, p.name platform, p.domain, a.email, a.login_method, a.status,
      a.created_at, (c.id IS NOT NULL) has_password, c.revealed_at
    FROM accounts a JOIN platforms p ON p.id = a.platform_id LEFT JOIN credentials c ON c.account_id = a.id ORDER BY p.name`).all()))
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
  const SETTINGS = { max_signups_per_hour: [1, 10], backlink_check_hours: [6, 72], require_approval: [0, 1], min_quality_score: [30, 90], discovery_batch: [3, 20] }
  const DEFAULTS = { require_approval: 1, min_quality_score: 55, discovery_batch: 10 }
  const settingValue = k => Number(getSetting(db, k, DEFAULTS[k]))
  app.get('/api/settings', (req, res) => res.json(Object.fromEntries(Object.keys(SETTINGS).map(k => [k, settingValue(k)]))))
  app.patch('/api/settings', wrap(async (req, res) => {
    for (const [k, v] of Object.entries(req.body || {})) {
      const range = SETTINGS[k]
      const n = Number(v)
      if (!range) return res.status(400).json({ error: `Unknown setting ${k}` })
      if (!Number.isInteger(n) || n < range[0] || n > range[1]) return res.status(400).json({ error: `${k} must be ${range[0]}–${range[1]}` })
      setSetting(db, k, n)
      activity.info('setting_changed', `${k} set to ${n}`)
    }
    res.json(Object.fromEntries(Object.keys(SETTINGS).map(k => [k, settingValue(k)])))
  }))

  app.get('/api/health', (req, res) => res.json({ ok: true, db: db.prepare('SELECT 1 ok').get().ok === 1 }))
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }))

  // The browser half of viaSocket Connect, served from the installed package.
  app.get('/vendor/viasocket-browser.js', (req, res) =>
    res.type('application/javascript').sendFile(path.join(ROOT, 'node_modules/viasocket-apps/dist/esm/browser.js')))
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
