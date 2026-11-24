// Live mirror between the agent (the Mac, or a cloud worker) and the hosted dashboard.
//
// Records flow agent → hosted as an ordered, idempotent change log: each push carries the hash of the state it builds
// on (base) and the rows that changed or disappeared since the last push the hosted copy acknowledged (a delta, not a
// snapshot). The hosted copy applies a delta only on top of the exact base it holds; otherwise it answers with what
// it has and the agent sends a full copy. A missed push, a redeploy or a reconnect after days offline all converge.
//
// Changes made on the hosted dashboard flow hosted → agent as commands. Each command has an id, a state
// (queued → sent → applied | failed), timestamps and a result message. Identical commands within a short window are
// one command. The agent runs each command id at most once (it remembers the outcome) and reports the result back,
// so the dashboard says "Applied" only after the agent really applied it, and "Failed: <reason>" otherwise.
//
// Never mirrored: platform passwords (only that an account has one), the Gmail connection's sealed ids
// (integration_settings), verification links. The hosted copy runs no tasks of its own while it mirrors.
import { createHash, randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { getSetting, now, numSetting, setSetting } from '../db/index.js'
import { maskError } from '../security/mask.js'
import { BRAND } from '../agent/brand.js'
import { OUTREACH_KEYS, OUTREACH_TABLES } from '../outreach/store.js'

// Parents before children; deleted in reverse.
export const MIRROR_TABLES = ['platform_categories', 'platforms', 'platform_scores', 'company_information', 'accounts', 'credentials', 'submissions',
  'backlinks', 'backlink_history', 'email_verifications', 'automation_tasks', 'human_approvals', 'platform_transitions', 'emails_used',
  'platform_playbooks', 'screenshots', 'activity_logs', 'system_settings', 'gtm_leads', 'gtm_emails', 'gtm_outreach',
  ...OUTREACH_TABLES]
const KEY = { system_settings: 'key', platform_playbooks: 'platform_id', gtm_leads: 'key', gtm_emails: 'n', gtm_outreach: 'n', ...OUTREACH_KEYS }
const ACTIVITY_ROWS = 500
const LOCAL_ONLY_SETTINGS = new Set(['automation_state', 'repair_v2_done']) // the agent's run state travels as status
const PUSH_MS = 5_000
const MAX_BACKOFF_MS = 5 * 60_000
const CONNECT_INFO_MS = 5 * 60_000
const ONLINE_MS = 30_000
const CONFLICT_LOG_MS = 10 * 60_000
const DEDUPE_MS = 60_000
const RESEND_MS = 3 * 60_000 // a command handed out but never answered is handed out again (the agent runs each id once)

const keyOf = t => KEY[t] || 'id'
const rowHash = r => createHash('sha1').update(JSON.stringify(r)).digest('base64url')

const hasTable = (db, t) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t))
function tableRows(db, t) {
  if ((t.startsWith('gtm_') || t.startsWith('outreach_')) && !hasTable(db, t)) return [] // created by the Growth section; absent in bare copies
  if (t === 'activity_logs') return db.prepare(`SELECT * FROM activity_logs ORDER BY id DESC LIMIT ${ACTIVITY_ROWS}`).all().reverse()
  // Which accounts have a password, never the password: the sealed value stays with the agent.
  if (t === 'credentials') return db.prepare('SELECT id, account_id, created_at, revealed_at FROM credentials').all().map(r => ({ ...r, secret_enc: '' }))
  if (t === 'email_verifications') return db.prepare('SELECT * FROM email_verifications').all().map(r => ({ ...r, link_enc: null }))
  if (t === 'system_settings') return db.prepare('SELECT * FROM system_settings').all().filter(r => !LOCAL_ONLY_SETTINGS.has(r.key) && !r.key.startsWith('mirror_'))
  return db.prepare(`SELECT * FROM ${t}`).all()
}

export function buildSnapshot(db) {
  return Object.fromEntries(MIRROR_TABLES.map(t => [t, tableRows(db, t)]))
}

/** Per table: key → row hash. What a copy holding these rows looks like, compactly. */
export function indexSnapshot(snap) {
  const out = {}
  for (const t of MIRROR_TABLES) out[t] = new Map((snap[t] || []).map(r => [String(r[keyOf(t)]), rowHash(r)]))
  return out
}
export const stateHash = idx => createHash('sha256').update(MIRROR_TABLES.map(t => `${t}:${[...idx[t]].sort().map(([k, h]) => `${k}=${h}`).join(',')}`).join('|')).digest('hex')

/** Pure: the rows of `snap` that differ from what `known` (an index) holds, and the keys that are gone. */
export function diffSnapshot(snap, known) {
  const delta = {}
  for (const t of MIRROR_TABLES) {
    const k = known?.[t] || new Map()
    const rows = snap[t] || []
    const seen = new Set()
    const upsert = []
    for (const r of rows) {
      const key = String(r[keyOf(t)])
      seen.add(key)
      if (k.get(key) !== rowHash(r)) upsert.push(r)
    }
    const del = [...k.keys()].filter(key => !seen.has(key))
    if (upsert.length || del.length) delta[t] = { upsert, delete: del }
  }
  return delta
}

const columnsOf = (db, t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name))
const skipSetting = row => LOCAL_ONLY_SETTINGS.has(row.key) || row.key.startsWith('mirror_')

/** Replace the hosted copy's records with the agent's, in one transaction. Returns activity rows that are new here. */
export function applySnapshot(db, snap) {
  const before = db.prepare('SELECT COALESCE(MAX(id), 0) n FROM activity_logs').get().n
  db.transaction(() => {
    db.pragma('defer_foreign_keys = ON')
    for (const t of [...MIRROR_TABLES].reverse()) {
      if (t === 'system_settings') db.prepare(`DELETE FROM system_settings WHERE key NOT IN (${[...LOCAL_ONLY_SETTINGS].map(() => '?').join(',')}) AND key NOT LIKE 'mirror_%'`).run(...LOCAL_ONLY_SETTINGS)
      else if (hasTable(db, t)) db.prepare(`DELETE FROM ${t}`).run()
    }
    for (const t of MIRROR_TABLES) insertRows(db, t, snap[t] || [])
    setSetting(db, 'automation_state', 'stopped') // while it mirrors, the hosted copy runs nothing itself
  })()
  return newActivity(db, before)
}

/** Apply a delta (upserts and deletes per table) in one transaction. Returns activity rows that are new here. */
export function applyDelta(db, delta) {
  const before = db.prepare('SELECT COALESCE(MAX(id), 0) n FROM activity_logs').get().n
  const touched = { platforms: new Set(), tables: new Set(Object.keys(delta)) }
  db.transaction(() => {
    db.pragma('defer_foreign_keys = ON')
    for (const t of [...MIRROR_TABLES].reverse()) {
      for (const key of hasTable(db, t) ? delta[t]?.delete || [] : []) {
        if (t === 'system_settings' && skipSetting({ key })) continue
        db.prepare(`DELETE FROM ${t} WHERE ${keyOf(t)} = ?`).run(t === 'system_settings' || !/^\d+$/.test(key) ? key : Number(key))
      }
    }
    for (const t of MIRROR_TABLES) {
      const rows = delta[t]?.upsert || []
      insertRows(db, t, rows, true)
      for (const r of rows) {
        if (t === 'platforms') touched.platforms.add(r.id)
        else if (r.platform_id) touched.platforms.add(r.platform_id)
      }
    }
    setSetting(db, 'automation_state', 'stopped')
  })()
  return { fresh: newActivity(db, before), touched }
}

function insertRows(db, t, rows, replace = false) {
  if (!rows.length || !hasTable(db, t)) return
  const known = columnsOf(db, t)
  for (let row of rows) {
    if (t === 'system_settings' && skipSetting(row)) continue
    if (t === 'credentials') row = { ...row, secret_enc: '' } // a mirror never holds platform passwords
    const cols = Object.keys(row).filter(c => known.has(c))
    // An upsert, never REPLACE: REPLACE deletes the old row first, which would cascade to its children.
    const k = keyOf(t)
    const update = cols.filter(c => c !== k).map(c => `${c} = excluded.${c}`).join(', ')
    db.prepare(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})${replace && update ? ` ON CONFLICT(${k}) DO UPDATE SET ${update}` : ''}`).run(...cols.map(c => row[c]))
  }
}

function newActivity(db, before) {
  return db.prepare(`SELECT l.id, l.ts, l.level, l.event, l.message, l.platform_id AS platformId, l.task_id AS taskId, l.correlation_id AS correlationId, l.meta, p.name AS platform
    FROM activity_logs l LEFT JOIN platforms p ON p.id = l.platform_id WHERE l.id > ? ORDER BY l.id`).all(before)
    .map(r => ({ ...r, meta: r.meta && JSON.parse(r.meta) }))
}

/** A readable name for a change made on the dashboard, shown in the Pending changes panel. */
export function describeCommand(db, method, path, body = {}) {
  const pid = Number(path.match(/\/api\/platforms\/(\d+)/)?.[1])
  const name = pid ? db.prepare('SELECT name FROM platforms WHERE id = ?').get(pid)?.name || `platform ${pid}` : null
  const aid = Number(path.match(/\/api\/approvals\/(\d+)/)?.[1])
  const aname = aid ? db.prepare('SELECT p.name FROM human_approvals h JOIN platforms p ON p.id = h.platform_id WHERE h.id = ?').get(aid)?.name : null
  const tid = Number(path.match(/\/api\/tasks\/(\d+)/)?.[1])
  const tname = tid ? db.prepare('SELECT p.name FROM automation_tasks t LEFT JOIN platforms p ON p.id = t.platform_id WHERE t.id = ?').get(tid)?.name : null
  const rules = [
    [/^POST \/api\/platforms$/, () => `Add platform ${body.name || ''} (${body.url || ''})`],
    [/^PATCH \/api\/platforms\/\d+$/, () => (body.status ? `Set ${name} to ${String(body.status).replace(/_/g, ' ')}` : `Edit ${name}`)],
    [/^DELETE \/api\/platforms\/\d+$/, () => `Delete ${name}`],
    [/\/listing-url$/, () => `Set listing URL of ${name}`],
    [/\/manual-complete$/, () => `Mark ${name} as done manually`],
    [/\/resume$/, () => `Resume ${name || tname || 'task'}`],
    [/\/retry$/, () => `Retry ${name}`],
    [/\/reject$/, () => `Reject ${name}`],
    [/\/needs-you$/, () => `Hand ${name} to you`],
    [/\/qualify$/, () => `Evaluate ${name}`],
    [/\/check-backlink$/, () => `Check backlink of ${name}`],
    [/\/approvals\/\d+\/approve$/, () => `Approve listing for ${aname}`],
    [/\/approvals\/\d+\/reject$/, () => `Reject listing for ${aname}`],
    [/\/approvals\/\d+\/skip$/, () => `Skip ${aname}`],
    [/\/automation\/(\w+)$/, m => `${m[1][0].toUpperCase()}${m[1].slice(1)} the automation`],
    [/^PUT \/api\/company$/, () => `Edit the ${BRAND} profile`],
    [/\/company\/approve$/, () => `Approve the ${BRAND} profile`],
    [/^PATCH \/api\/settings$/, () => `Change settings (${Object.keys(body).join(', ')})`],
    [/\/chrome\/(\w[\w-]*)$/, m => `Chrome: ${m[1].replace('-', ' ')}`],
    [/\/discovery\/run$/, () => 'Run discovery']
  ]
  const line = `${method} ${path.split('?')[0]}`
  for (const [re, fn] of rules) { const m = line.match(re); if (m) return fn(m).trim() }
  return line
}

// ---------- hosted side ----------

export function createMirrorReceiver({ db, activity, token, alerts = null }) {
  db.exec(`CREATE TABLE IF NOT EXISTS mirror_commands (id INTEGER PRIMARY KEY, method TEXT NOT NULL, path TEXT NOT NULL, body TEXT,
    state TEXT NOT NULL DEFAULT 'queued', created_at TEXT NOT NULL, sent_at TEXT, dedupe_key TEXT, result TEXT, applied_at TEXT, label TEXT,
    http_status INTEGER, attempts INTEGER NOT NULL DEFAULT 0)`)
  let status = JSON.parse(getSetting(db, 'mirror_status', 'null') || 'null') // last live status from the agent
  db.prepare(`UPDATE mirror_commands SET state = 'queued' WHERE state = 'pending'`).run() // left by the old default
  let conflictLoggedAt = 0
  let behindTimer = null

  const lastPush = () => getSetting(db, 'mirror_last_push')
  const lastRecords = () => getSetting(db, 'mirror_last_records')
  const isOnline = () => Boolean(lastPush()) && Date.now() - Date.parse(lastPush()) < ONLINE_MS
  const sourceOf = body => ({ id: String(body.source?.id || 'unidentified').slice(0, 64), host: String(body.source?.host || 'an older agent').slice(0, 100) })
  const commandRow = id => db.prepare(`SELECT id, method, path, state, label, result, http_status, created_at, sent_at, applied_at FROM mirror_commands WHERE id = ?`).get(id)

  function checkBehind() {
    const last = lastPush()
    const limit = numSetting(db, 'offline_alert_minutes', 10) * 60_000
    if (last && Date.now() - Date.parse(last) > limit) {
      alerts?.send(`agent-offline:${last}`, `The ${BRAND} agent is offline`, `No update from the agent since ${last}. Changes made on the hosted dashboard wait until it reconnects.`, { level: 'error' })
    }
  }

  return {
    token,
    /** Mirroring once the agent has pushed at least once: its data is what this copy shows. */
    on: () => Boolean(lastPush()),
    online: isOnline,
    source: () => JSON.parse(getSetting(db, 'mirror_source', 'null') || 'null'),
    info() {
      return { on: this.on(), online: this.online(), lastPush: lastPush(), lastRecords: lastRecords(), source: this.source()?.host || null,
        pending: db.prepare(`SELECT COUNT(*) n FROM mirror_commands WHERE state IN ('queued','sent')`).get().n, worker: status?.worker || null }
    },
    state: () => status?.state ?? 'stopped',
    chrome: () => ({ ...(status?.chrome || { running: false, attached: false }), via: 'mac' }),
    gmail: () => status?.gmail || { connected: false, error: 'The agent has not reported Gmail yet' },
    connectInfo: () => status?.connect || null,
    startWatch() { behindTimer = setInterval(checkBehind, 60_000); behindTimer.unref?.() },
    stopWatch() { clearInterval(behindTimer) },

    receive(body) {
      const source = sourceOf(body)
      const current = this.source()
      if (current && current.id !== source.id) {
        if (isOnline()) {
          // Another agent is pushing with the same token while the mirrored one is online: keep the mirrored one.
          if (Date.now() - conflictLoggedAt > CONFLICT_LOG_MS) {
            conflictLoggedAt = Date.now()
            activity.warn('mirror_conflict', `Refused records from a second agent (${source.host}): this dashboard mirrors ${current.host}`)
          }
          return { conflict: true, error: `This dashboard already mirrors the agent on ${current.host}, which is online. Stop this copy, or remove HOSTED_URL from its .env.` }
        }
        activity.warn('mirror_source_changed', `Now mirroring the agent on ${source.host} (was ${current.host}, offline)`)
      }
      if (!current || current.id !== source.id) {
        setSetting(db, 'mirror_source', JSON.stringify(source))
        setSetting(db, 'mirror_hash', '') // what is here came from another agent: ask for a full copy
      }
      const have = getSetting(db, 'mirror_hash', '')
      let touched = null
      let fresh = []
      if (body.snapshot) {
        fresh = applySnapshot(db, body.snapshot)
        setSetting(db, 'mirror_hash', typeof body.hash === 'string' ? body.hash : '')
        setSetting(db, 'mirror_last_records', now())
        touched = { platforms: 'all', tables: MIRROR_TABLES }
      } else if (body.delta) {
        if (body.base !== have) {
          // Built on a state this copy does not hold (a missed push, a redeploy): ask for a full copy.
          activity.feed.emit('sync', { at: now(), resync: true })
          return { have, resync: true, commands: [] }
        }
        const r = applyDelta(db, body.delta)
        fresh = r.fresh
        touched = { platforms: [...r.touched.platforms], tables: [...r.touched.tables] }
        setSetting(db, 'mirror_hash', typeof body.hash === 'string' ? body.hash : '')
        setSetting(db, 'mirror_last_records', now())
      }
      for (const e of fresh.slice(-50)) activity.feed.emit('entry', e) // open dashboards get the newest live
      if (body.status) { status = body.status; setSetting(db, 'mirror_status', JSON.stringify(status)) }
      setSetting(db, 'mirror_last_push', now())

      // Results of commands the agent ran: the dashboard learns "Applied" or "Failed: why".
      for (const r of Array.isArray(body.results) ? body.results : []) {
        const id = Number(r.id)
        if (!id) continue
        const state = r.ok ? 'applied' : 'failed'
        const res = db.prepare(`UPDATE mirror_commands SET state = ?, result = ?, http_status = ?, applied_at = ? WHERE id = ? AND state IN ('queued','sent')`)
          .run(state, String(r.message || (r.ok ? 'Applied' : 'Failed')).slice(0, 500), Number(r.status) || null, now(), id)
        if (res.changes) activity.feed.emit('command', commandRow(id))
      }
      if (touched || body.status) activity.feed.emit('sync', { at: now(), ...(touched || {}) })

      // Commands to hand out: new ones, and ones handed out earlier that never got an answer.
      const commands = db.prepare(`SELECT id, method, path, body FROM mirror_commands WHERE state = 'queued' OR (state = 'sent' AND sent_at < ?) ORDER BY id LIMIT 20`)
        .all(new Date(Date.now() - RESEND_MS).toISOString())
      if (commands.length) {
        db.prepare(`UPDATE mirror_commands SET state = 'sent', sent_at = ?, attempts = attempts + 1 WHERE id IN (${commands.map(() => '?').join(',')})`).run(now(), ...commands.map(c => c.id))
        for (const c of commands) activity.feed.emit('command', commandRow(c.id))
      }
      // Finished commands are kept a week for the panel; ones never picked up are reported failed after a day.
      db.prepare(`UPDATE mirror_commands SET state = 'failed', result = 'Not applied: the agent did not come online within a day', applied_at = ? WHERE state = 'queued' AND created_at < ?`)
        .run(now(), new Date(Date.now() - 86400_000).toISOString())
      db.prepare(`DELETE FROM mirror_commands WHERE created_at < ?`).run(new Date(Date.now() - 7 * 86400_000).toISOString())
      return { commands: commands.map(c => ({ ...c, body: c.body ? JSON.parse(c.body) : undefined })), have: getSetting(db, 'mirror_hash', '') }
    },

    /** Record a change made here. Identical changes within a minute are one change: returns the existing one. */
    queue(method, path, body) {
      const b = body && Object.keys(body).length ? JSON.stringify(body) : null
      const dedupeKey = createHash('sha1').update(`${method} ${path} ${b || ''}`).digest('hex')
      const existing = db.prepare(`SELECT id FROM mirror_commands WHERE dedupe_key = ? AND state IN ('queued','sent') AND created_at > ? ORDER BY id DESC LIMIT 1`)
        .get(dedupeKey, new Date(Date.now() - DEDUPE_MS).toISOString())
      if (existing) return { ...commandRow(existing.id), duplicate: true }
      const label = describeCommand(db, method, path, body || {})
      // State set explicitly: a table created by an older version defaults to 'pending', which is never handed out.
      const id = db.prepare(`INSERT INTO mirror_commands (method, path, body, state, created_at, dedupe_key, label) VALUES (?, ?, ?, 'queued', ?, ?, ?) RETURNING id`)
        .get(method, path, b, now(), dedupeKey, label).id
      const row = commandRow(id)
      activity.feed.emit('command', row)
      return row
    },

    commands({ limit = 50 } = {}) {
      return db.prepare(`SELECT id, method, path, state, label, result, http_status, created_at, sent_at, applied_at FROM mirror_commands ORDER BY id DESC LIMIT ?`).all(Math.min(Number(limit) || 50, 200))
    },
    command: commandRow
  }
}

// ---------- agent side ----------

/** Paths a hosted dashboard may have the agent run. Passwords are never revealed through the mirror. */
export function commandAllowed({ method, path }) {
  return ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) && /^\/api\/[A-Za-z0-9/_.-]+$/.test(path) &&
    !/\/reveal$|^\/api\/(login|logout)$/.test(path)
}

export function createMirrorPusher({ db, activity, chrome, gmail, orchestrator, replay, url, token, alerts = null, fetchImpl = fetch }) {
  const endpoint = `${url.replace(/\/+$/, '')}/sync/push`
  db.exec(`CREATE TABLE IF NOT EXISTS mirror_applied (id INTEGER PRIMARY KEY, ok INTEGER NOT NULL, status INTEGER, message TEXT, at TEXT NOT NULL)`)
  // This agent's identity on the hosted copy: random, kept in its own database (mirror_* settings are never pushed).
  let sourceId = getSetting(db, 'mirror_source_id')
  if (!sourceId) { sourceId = randomBytes(12).toString('hex'); setSetting(db, 'mirror_source_id', sourceId) }
  const source = { id: sourceId, host: hostname() }
  let known = null // index of what the hosted copy holds (acknowledged), or null = unknown → full copy
  let knownHash = ''
  let connect = null
  let connectAt = 0
  let timer = null
  let busy = false
  let failures = 0
  let failingSince = null
  let lastOk = null
  let results = [] // command outcomes not yet reported

  async function connectInfo() {
    if (connect && Date.now() - connectAt < CONNECT_INFO_MS) return connect
    try {
      const g = await gmail.status()
      connect = {
        token: await gmail.embedToken(), // the browser-safe viaSocket token, so Connect Gmail works on the hosted page
        serviceId: await gmail.serviceId(),
        actions: gmail.consentActions(),
        reconnectAuthId: g.expired ? gmail.authIdForReconnect() : undefined
      }
      connectAt = Date.now()
    } catch { connect = null }
    return connect
  }

  function schedule(ms) {
    clearTimeout(timer)
    timer = setTimeout(push, ms)
    timer.unref?.()
  }

  async function push() {
    if (busy) return
    busy = true
    let again = false
    try {
      const snap = buildSnapshot(db)
      const idx = indexSnapshot(snap)
      const hash = stateHash(idx)
      const status = {
        state: orchestrator.state(),
        chrome: await chrome.status().catch(e => ({ running: false, attached: false, note: maskError(e) })),
        gmail: await gmail.status().catch(e => ({ connected: false, error: maskError(e) })),
        connect: await connectInfo(),
        worker: JSON.parse(getSetting(db, 'worker_heartbeat', 'null') || 'null')
      }
      const payload = { source, hash, status, results }
      if (!known) payload.snapshot = snap
      else if (hash !== knownHash) { payload.base = knownHash; payload.delta = diffSnapshot(snap, known) }
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000)
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `hosted copy answered HTTP ${res.status}`)
      results = [] // delivered
      if (data.resync || data.have !== hash) {
        // The hosted copy holds something else (missed push, redeploy, another agent): send everything next.
        known = null; knownHash = ''; again = true
      } else { known = idx; knownHash = hash }
      lastOk = now()
      setSetting(db, 'mirror_last_ok', lastOk)
      if (failures) {
        activity.success('mirror_online', `Hosted dashboard is up to date again (after ${failures} failed attempt(s) since ${failingSince})`)
        failures = 0; failingSince = null
      }
      const { commands = [] } = data
      for (const c of commands) results.push(await run(c))
      if (commands.length) again = true // report the results and the changes they made straight away
    } catch (e) {
      failures++
      failingSince ||= now()
      // Every failure is logged; back-off keeps that from flooding the log.
      activity.warn('mirror_failed', `Could not update the hosted dashboard (attempt ${failures}): ${maskError(e)}. Next try in ${Math.round(backoff() / 1000)} s.`)
      const behindMin = (Date.now() - Date.parse(lastOk || failingSince)) / 60_000
      if (behindMin > numSetting(db, 'offline_alert_minutes', 10)) {
        alerts?.send(`mirror-behind:${failingSince}`, 'The hosted dashboard is falling behind', `The agent could not update the hosted dashboard for ${Math.round(behindMin)} minutes: ${maskError(e)}`, { level: 'warn' })
      }
    } finally {
      busy = false
      schedule(again ? 50 : failures ? backoff() : PUSH_MS)
    }
  }
  const backoff = () => Math.min(MAX_BACKOFF_MS, PUSH_MS * 2 ** Math.min(failures, 8))

  /** Run one command at most once: a repeated id returns the outcome recorded the first time. */
  async function run(c) {
    const done = db.prepare('SELECT ok, status, message FROM mirror_applied WHERE id = ?').get(c.id)
    if (done) return { id: c.id, ok: Boolean(done.ok), status: done.status, message: done.message, repeated: true }
    let out
    if (!commandAllowed(c)) {
      activity.warn('remote_command_refused', `Refused from the hosted dashboard: ${c.method} ${c.path}`)
      out = { id: c.id, ok: false, status: 403, message: 'Not allowed from the hosted dashboard' }
    } else {
      try {
        const r = await replay(c)
        if (r.status >= 400) {
          const msg = r.data?.error || `HTTP ${r.status}`
          activity.warn('remote_command_failed', `From the hosted dashboard: ${c.method} ${c.path} failed: ${msg}`)
          out = { id: c.id, ok: false, status: r.status, message: msg }
        } else {
          activity.info('remote_command', `Applied on the agent, from the hosted dashboard: ${c.method} ${c.path}`)
          out = { id: c.id, ok: true, status: r.status, message: r.data?.message || 'Applied' }
        }
      } catch (e) {
        activity.warn('remote_command_failed', `From the hosted dashboard: ${c.method} ${c.path} failed: ${maskError(e)}`)
        out = { id: c.id, ok: false, status: 0, message: maskError(e) }
      }
    }
    db.prepare(`INSERT OR REPLACE INTO mirror_applied (id, ok, status, message, at) VALUES (?, ?, ?, ?, ?)`).run(c.id, out.ok ? 1 : 0, out.status, out.message, now())
    db.prepare(`DELETE FROM mirror_applied WHERE at < ?`).run(new Date(Date.now() - 14 * 86400_000).toISOString())
    return out
  }

  return {
    start() {
      schedule(0)
      activity.info('mirror_started', `Mirroring to the hosted dashboard (${new URL(url).host})`)
    },
    push,
    info: () => ({ lastOk, failures, failingSince }),
    shutdown() { clearTimeout(timer) },
    _run: run
  }
}
