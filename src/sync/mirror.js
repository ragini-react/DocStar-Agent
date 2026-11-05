// Live mirror: the agent on the Mac is the one source of truth, and the hosted copy shows exactly its numbers.
//
// Mac (pusher): every few seconds it POSTs a snapshot of its records (only when something changed) plus its
// live status (automation state, Chrome, Gmail) to the hosted copy's /sync/push, with a shared SYNC_TOKEN.
// Hosted (receiver): replaces its tables with the snapshot and answers with the buttons pressed on the hosted
// dashboard since the last push. The Mac carries them out against its own API, so Open Chrome, Start, Resume
// or Approve pressed on the hosted URL happen on the Mac. Each command is handed out once (at most once).
//
// Never mirrored: platform passwords (only that an account has one, so the Credentials page matches), the Gmail connection's sealed ids (integration_settings),
// verification links. The hosted copy stops running tasks of its own while it mirrors, so the two never diverge.
//
// One source only: the hosted copy remembers which agent it mirrors (a random id kept in that agent's database) and
// refuses pushes from any other agent while that one is online, so a second copy started elsewhere with the same
// token cannot overwrite the numbers or take the buttons. It also answers with the hash of the records it holds;
// when that is not the Mac's current hash (a redeploy wiped it, another agent pushed before), the Mac sends them again.
import { createHash, randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { getSetting, now, setSetting } from '../db/index.js'
import { maskError } from '../security/mask.js'

// Parents before children; deleted in reverse.
export const MIRROR_TABLES = ['platform_categories', 'platforms', 'platform_scores', 'company_information', 'accounts', 'credentials', 'submissions',
  'backlinks', 'backlink_history', 'email_verifications', 'automation_tasks', 'human_approvals', 'activity_logs', 'system_settings']
const ACTIVITY_ROWS = 500
const LOCAL_ONLY_SETTINGS = new Set(['automation_state']) // the Mac's run state travels as status, never as a setting
const PUSH_MS = 5_000
const CONNECT_INFO_MS = 5 * 60_000
const ONLINE_MS = 30_000
const FULL_PUSH_MS = 60_000 // resend the records at least this often, even when the hosted copy says it has them
const CONFLICT_LOG_MS = 10 * 60_000

export function buildSnapshot(db) {
  const out = {}
  for (const t of MIRROR_TABLES) {
    if (t === 'activity_logs') out[t] = db.prepare(`SELECT * FROM activity_logs ORDER BY id DESC LIMIT ${ACTIVITY_ROWS}`).all().reverse()
    // Which accounts have a password, never the password: the sealed value stays on the Mac.
    else if (t === 'credentials') out[t] = db.prepare('SELECT id, account_id, created_at, revealed_at FROM credentials').all().map(r => ({ ...r, secret_enc: '' }))
    else if (t === 'email_verifications') out[t] = db.prepare('SELECT * FROM email_verifications').all().map(r => ({ ...r, link_enc: null }))
    else if (t === 'system_settings') out[t] = db.prepare('SELECT * FROM system_settings').all().filter(r => !LOCAL_ONLY_SETTINGS.has(r.key) && !r.key.startsWith('mirror_'))
    else out[t] = db.prepare(`SELECT * FROM ${t}`).all()
  }
  return out
}

/** Replace the hosted copy's records with the Mac's, in one transaction. Returns activity rows that are new here. */
export function applySnapshot(db, snap) {
  const before = db.prepare('SELECT COALESCE(MAX(id), 0) n FROM activity_logs').get().n
  const columns = t => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name))
  db.transaction(() => {
    db.pragma('defer_foreign_keys = ON')
    for (const t of [...MIRROR_TABLES].reverse()) {
      if (t === 'system_settings') db.prepare(`DELETE FROM system_settings WHERE key NOT IN (${[...LOCAL_ONLY_SETTINGS].map(() => '?').join(',')}) AND key NOT LIKE 'mirror_%'`).run(...LOCAL_ONLY_SETTINGS)
      else db.prepare(`DELETE FROM ${t}`).run()
    }
    for (const t of MIRROR_TABLES) {
      const known = columns(t)
      for (let row of snap[t] || []) {
        if (t === 'system_settings' && (LOCAL_ONLY_SETTINGS.has(row.key) || row.key.startsWith('mirror_'))) continue
        if (t === 'credentials') row = { ...row, secret_enc: '' } // a mirror never holds platform passwords
        const cols = Object.keys(row).filter(c => known.has(c))
        db.prepare(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map(c => row[c]))
      }
    }
    // While it mirrors, the hosted copy runs nothing itself: the Mac's queue is the only queue.
    setSetting(db, 'automation_state', 'stopped')
  })()
  return db.prepare(`SELECT id, ts, level, event, message, platform_id AS platformId, task_id AS taskId, meta FROM activity_logs WHERE id > ? ORDER BY id`).all(before)
    .map(r => ({ ...r, meta: r.meta && JSON.parse(r.meta) }))
}

// ---------- hosted side ----------

export function createMirrorReceiver({ db, activity, token }) {
  db.exec(`CREATE TABLE IF NOT EXISTS mirror_commands (
    id INTEGER PRIMARY KEY, method TEXT NOT NULL, path TEXT NOT NULL, body TEXT,
    state TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, sent_at TEXT)`)
  let status = JSON.parse(getSetting(db, 'mirror_status', 'null') || 'null') // last live status from the Mac
  let conflictLoggedAt = 0

  const lastPush = () => getSetting(db, 'mirror_last_push')
  const isOnline = () => Boolean(lastPush()) && Date.now() - Date.parse(lastPush()) < ONLINE_MS
  const sourceOf = body => ({ id: String(body.source?.id || 'unidentified').slice(0, 64), host: String(body.source?.host || 'an older agent').slice(0, 100) })
  return {
    token,
    /** Mirroring once the Mac has pushed at least once: its data is what this copy shows. */
    on: () => Boolean(lastPush()),
    online: isOnline,
    source: () => JSON.parse(getSetting(db, 'mirror_source', 'null') || 'null'),
    info() { return { on: this.on(), online: this.online(), lastPush: lastPush(), source: this.source()?.host || null } },
    state: () => status?.state ?? 'stopped',
    chrome: () => ({ ...(status?.chrome || { running: false, attached: false }), via: 'mac' }),
    gmail: () => status?.gmail || { connected: false, error: 'The Mac has not reported Gmail yet' },
    connectInfo: () => status?.connect || null,

    receive(body) {
      const source = sourceOf(body)
      const current = this.source()
      if (current && current.id !== source.id) {
        if (isOnline()) {
          // Another agent is pushing with the same token while the one mirrored here is online: keep the mirrored one.
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
      if (body.snapshot) {
        const fresh = applySnapshot(db, body.snapshot)
        setSetting(db, 'mirror_hash', typeof body.hash === 'string' ? body.hash : '')
        for (const e of fresh.slice(-50)) activity.feed.emit('entry', e) // open dashboards get the newest live
      }
      if (body.status) { status = body.status; setSetting(db, 'mirror_status', JSON.stringify(status)) }
      setSetting(db, 'mirror_last_push', now())
      if (body.snapshot || body.status) activity.feed.emit('sync', { at: now() })
      const commands = db.prepare(`SELECT id, method, path, body FROM mirror_commands WHERE state = 'pending' ORDER BY id LIMIT 20`).all()
      if (commands.length) db.prepare(`UPDATE mirror_commands SET state = 'sent', sent_at = ? WHERE id IN (${commands.map(() => '?').join(',')})`).run(now(), ...commands.map(c => c.id))
      // Commands older than a day were never picked up: drop them rather than surprise anyone later.
      db.prepare(`DELETE FROM mirror_commands WHERE created_at < ?`).run(new Date(Date.now() - 86400_000).toISOString())
      return { commands: commands.map(c => ({ ...c, body: c.body ? JSON.parse(c.body) : undefined })), have: getSetting(db, 'mirror_hash', '') }
    },

    queue(method, path, body) {
      return db.prepare(`INSERT INTO mirror_commands (method, path, body, created_at) VALUES (?, ?, ?, ?) RETURNING id`)
        .get(method, path, body && Object.keys(body).length ? JSON.stringify(body) : null, now()).id
    }
  }
}

// ---------- Mac side ----------

/** Paths a hosted dashboard may have the Mac run. Passwords are never revealed through the mirror. */
export function commandAllowed({ method, path }) {
  return ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) && /^\/api\/[A-Za-z0-9/_.-]+$/.test(path) &&
    !/\/reveal$|^\/api\/(login|logout)$/.test(path)
}

export function createMirrorPusher({ db, activity, chrome, gmail, orchestrator, replay, url, token }) {
  const endpoint = `${url.replace(/\/+$/, '')}/sync/push`
  // This agent's identity on the hosted copy: random, kept in its own database (mirror_* settings are never pushed).
  let sourceId = getSetting(db, 'mirror_source_id')
  if (!sourceId) { sourceId = randomBytes(12).toString('hex'); setSetting(db, 'mirror_source_id', sourceId) }
  const source = { id: sourceId, host: hostname() }
  let lastHash = null // the hash of the records the hosted copy holds, as far as we know
  let fullAt = 0
  let connect = null
  let connectAt = 0
  let timer = null
  let busy = false
  let failing = false

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

  async function push() {
    if (busy) return
    busy = true
    try {
      const snapshot = buildSnapshot(db)
      const hash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
      const sendRecords = hash !== lastHash || Date.now() - fullAt > FULL_PUSH_MS
      const status = {
        state: orchestrator.state(),
        chrome: await chrome.status().catch(e => ({ running: false, attached: false, note: maskError(e) })),
        gmail: await gmail.status().catch(e => ({ connected: false, error: maskError(e) })),
        connect: await connectInfo()
      }
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ source, hash, snapshot: sendRecords ? snapshot : null, status }),
        signal: AbortSignal.timeout(20_000)
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `hosted copy answered HTTP ${res.status}`)
      if (sendRecords) fullAt = Date.now()
      // The hosted copy says which records it holds; if they are not ours, the next push sends ours again.
      lastHash = 'have' in data ? data.have : hash
      if (failing) { failing = false; activity.success('mirror_online', 'Hosted dashboard is up to date again') }
      const { commands = [] } = data
      for (const c of commands) await run(c)
      if (commands.length) lastHash = null // what they changed goes up on the next push
    } catch (e) {
      if (!failing) { failing = true; activity.warn('mirror_offline', `Could not update the hosted dashboard: ${maskError(e)}. Retrying.`) }
    } finally {
      busy = false
    }
  }

  async function run(c) {
    if (!commandAllowed(c)) return activity.warn('remote_command_refused', `Refused from the hosted dashboard: ${c.method} ${c.path}`)
    try {
      const r = await replay(c)
      if (r.status >= 400) activity.warn('remote_command_failed', `From the hosted dashboard: ${c.method} ${c.path} failed: ${r.data?.error || `HTTP ${r.status}`}`)
      else activity.info('remote_command', `Done on the Mac, from the hosted dashboard: ${c.method} ${c.path}`)
    } catch (e) {
      activity.warn('remote_command_failed', `From the hosted dashboard: ${c.method} ${c.path} failed: ${maskError(e)}`)
    }
  }

  return {
    start() {
      timer = setInterval(push, PUSH_MS)
      timer.unref()
      push()
      activity.info('mirror_started', `Mirroring to the hosted dashboard (${new URL(url).host})`)
    },
    push,
    shutdown() { clearInterval(timer) }
  }
}
