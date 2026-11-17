// The activity feed: every event goes to the database and the console, masked, and out to open dashboards.
// Every entry can carry a platform id, a task id and a correlation id (one per task run), so a run's steps group.
import { EventEmitter } from 'node:events'
import { maskText, maskValue } from '../security/mask.js'

const LEVELS = new Set(['info', 'success', 'warn', 'error'])

export function createActivityLog(db, { quiet = false } = {}) {
  const feed = new EventEmitter()
  feed.setMaxListeners(100)
  const insert = db.prepare(`INSERT INTO activity_logs (level, event, message, platform_id, task_id, meta, correlation_id)
    VALUES (@level, @event, @message, @platformId, @taskId, @meta, @correlationId) RETURNING id, ts`)
  const exists = db.prepare('SELECT 1 FROM activity_logs WHERE id = ?')

  function log(level, event, message, { platformId = null, taskId = null, meta = null, correlationId = null } = {}) {
    if (!LEVELS.has(level)) level = 'info'
    const row = {
      level, event,
      message: maskText(message),
      platformId, taskId, correlationId,
      meta: meta == null ? null : JSON.stringify(maskValue(meta))
    }
    let saved
    try {
      saved = insert.get(row)
    } catch (error) {
      // Logging must never take the agent down; the console still gets it.
      console.error(`[activity] could not save: ${maskText(error.message)}`)
    }
    const entry = { id: saved?.id ?? null, ts: saved?.ts ?? new Date().toISOString(), ...row, meta: row.meta && JSON.parse(row.meta) }
    if (!quiet) console.log(`[${entry.ts}] ${level.toUpperCase()} ${event}: ${entry.message}`)
    // Written inside a transaction: tell dashboards only once it committed (a rolled-back event never happened).
    if (db.inTransaction && entry.id) queueMicrotask(() => { try { if (db.open && exists.get(entry.id)) feed.emit('entry', entry) } catch {} })
    else feed.emit('entry', entry)
    return entry
  }

  return {
    feed,
    log,
    info: (event, message, ctx) => log('info', event, message, ctx),
    success: (event, message, ctx) => log('success', event, message, ctx),
    warn: (event, message, ctx) => log('warn', event, message, ctx),
    error: (event, message, ctx) => log('error', event, message, ctx),

    /** Paginated on the server: newest first, `before` is the last id the client has. */
    recent(limit = 50, { level, event, platformId, taskId, q, before } = {}) {
      const where = []
      const args = []
      if (level) { where.push('l.level = ?'); args.push(level) }
      if (event) { where.push('l.event = ?'); args.push(event) }
      if (platformId) { where.push('l.platform_id = ?'); args.push(Number(platformId)) }
      if (taskId) { where.push('l.task_id = ?'); args.push(Number(taskId)) }
      if (q) { where.push('(l.message LIKE ? OR p.name LIKE ?)'); args.push(`%${q}%`, `%${q}%`) }
      if (before) { where.push('l.id < ?'); args.push(Number(before)) }
      return db.prepare(`SELECT l.id, l.ts, l.level, l.event, l.message, l.platform_id AS platformId, l.task_id AS taskId,
          l.correlation_id AS correlationId, l.meta, p.name AS platform
        FROM activity_logs l LEFT JOIN platforms p ON p.id = l.platform_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY l.id DESC LIMIT ?`)
        .all(...args, Math.min(Number(limit) || 50, 500))
        .map(r => ({ ...r, meta: r.meta && JSON.parse(r.meta) }))
    }
  }
}
