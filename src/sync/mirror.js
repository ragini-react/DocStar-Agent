// Live mirror: the agent on the Mac is the one source of truth, and the hosted copy shows exactly its numbers.
//
// Mac (pusher): every few seconds it POSTs a snapshot of its records (only when something changed) plus its
// live status (automation state, Chrome, Gmail) to the hosted copy's /sync/push, with a shared SYNC_TOKEN.
// Hosted (receiver): replaces its tables with the snapshot and answers with the buttons pressed on the hosted
// dashboard since the last push. The Mac carries them out against its own API, so Open Chrome, Start, Resume
// or Approve pressed on the hosted URL happen on the Mac. Each command is handed out once (at most once).
//
// Never mirrored: platform passwords (credentials), the Gmail connection's sealed ids (integration_settings),
// verification links. The hosted copy stops running tasks of its own while it mirrors, so the two never diverge.
import { createHash } from 'node:crypto'
import { getSetting, now, setSetting } from '../db/index.js'
import { maskError } from '../security/mask.js'

// Parents before children; deleted in reverse.
export const MIRROR_TABLES = ['platform_categories', 'platforms', 'platform_scores', 'company_information', 'accounts', 'submissions',
  'backlinks', 'backlink_history', 'email_verifications', 'automation_tasks', 'human_approvals', 'activity_logs', 'system_settings']
const ACTIVITY_ROWS = 500
const LOCAL_ONLY_SETTINGS = new Set(['automation_state']) // the Mac's run state travels as status, never as a setting
const PUSH_MS = 5_000
const CONNECT_INFO_MS = 5 * 60_000
const ONLINE_MS = 30_000

export function buildSnapshot(db) {
  const out = {}
  for (const t of MIRROR_TABLES) {
    if (t === 'activity_logs') out[t] = db.prepare(`SELECT * FROM activity_logs ORDER BY id DESC LIMIT ${ACTIVITY_ROWS}`).all().reverse()
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
    db.prepare('DELETE FROM credentials').run() // a mirror never holds platform passwords
    for (const t of [...MIRROR_TABLES].reverse()) {
      if (t === 'system_settings') db.prepare(`DELETE FROM system_settings WHERE key NOT IN (${[...LOCAL_ONLY_SETTINGS].map(() => '?').join(',')}) AND key NOT LIKE 'mirror_%'`).run(...LOCAL_ONLY_SETTINGS)
      else db.prepare(`DELETE FROM ${t}`).run()
    }
    for (const t of MIRROR_TABLES) {
      const known = columns(t)
      for (const row of snap[t] || []) {
        if (t === 'system_settings' && (LOCAL_ONLY_SETTINGS.has(row.key) || row.key.startsWith('mirror_'))) continue
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

  const lastPush = () => getSetting(db, 'mirror_last_push')
  return {
    token,
    /** Mirroring once the Mac has pushed at least once: its data is what this copy shows. */
    on: () => Boolean(lastPush()),
    online: () => Boolean(lastPush()) && Date.now() - Date.parse(lastPush()) < ONLINE_MS,
    info() { return { on: this.on(), online: this.online(), lastPush: lastPush() } },
    state: () => status?.state ?? 'stopped',
    chrome: () => ({ ...(status?.chrome || { running: false, attached: false }), via: 'mac' }),
    gmail: () => status?.gmail || { connected: false, error: 'The Mac has not reported Gmail yet' },
    connectInfo: () => status?.connect || null,

    receive(body) {
      if (body.snapshot) {
        const fresh = applySnapshot(db, body.snapshot)
        for (const e of fresh.slice(-50)) activity.feed.emit('entry', e) // open dashboards get the newest live
      }
      if (body.status) { status = body.status; setSetting(db, 'mirror_status', JSON.stringify(status)) }
      setSetting(db, 'mirror_last_push', now())
      if (body.snapshot || body.status) activity.feed.emit('sync', { at: now() })
      const commands = db.prepare(`SELECT id, method, path, body FROM mirror_commands WHERE state = 'pending' ORDER BY id LIMIT 20`).all()
      if (commands.length) db.prepare(`UPDATE mirror_commands SET state = 'sent', sent_at = ? WHERE id IN (${commands.map(() => '?').join(',')})`).run(now(), ...commands.map(c => c.id))
      // Commands older than a day were never picked up: drop them rather than surprise anyone later.
      db.prepare(`DELETE FROM mirror_commands WHERE created_at < ?`).run(new Date(Date.now() - 86400_000).toISOString())
      return { commands: commands.map(c => ({ ...c, body: c.body ? JSON.parse(c.body) : undefined })) }
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
  let lastHash = null
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
      const status = {
        state: orchestrator.state(),
        chrome: await chrome.status().catch(e => ({ running: false, attached: false, note: maskError(e) })),
        gmail: await gmail.status().catch(e => ({ connected: false, error: maskError(e) })),
        connect: await connectInfo()
      }
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ snapshot: hash === lastHash ? null : snapshot, status }),
        signal: AbortSignal.timeout(20_000)
      })
      if (!res.ok) throw new Error(`hosted copy answered HTTP ${res.status}`)
      lastHash = hash
      if (failing) { failing = false; activity.success('mirror_online', 'Hosted dashboard is up to date again') }
      const { commands = [] } = await res.json()
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
