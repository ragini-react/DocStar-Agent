// The activity feed: every event goes to the database and the console, masked, and out to open dashboards.
import { EventEmitter } from 'node:events'
import { maskText, maskValue } from '../security/mask.js'

const LEVELS = new Set(['info', 'success', 'warn', 'error'])

export function createActivityLog(db) {
  const feed = new EventEmitter()
  feed.setMaxListeners(50)
  const insert = db.prepare(`INSERT INTO activity_logs (level, event, message, platform_id, task_id, meta)
    VALUES (@level, @event, @message, @platformId, @taskId, @meta) RETURNING id, ts`)

  function log(level, event, message, { platformId = null, taskId = null, meta = null } = {}) {
    if (!LEVELS.has(level)) level = 'info'
    const row = {
      level, event,
      message: maskText(message),
      platformId, taskId,
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
    console.log(`[${entry.ts}] ${level.toUpperCase()} ${event}: ${entry.message}`)
    feed.emit('entry', entry)
    return entry
  }

  return {
    feed,
    info: (event, message, ctx) => log('info', event, message, ctx),
    success: (event, message, ctx) => log('success', event, message, ctx),
    warn: (event, message, ctx) => log('warn', event, message, ctx),
    error: (event, message, ctx) => log('error', event, message, ctx),
    recent(limit = 100, { level, event } = {}) {
      const where = []
      const args = []
      if (level) { where.push('level = ?'); args.push(level) }
      if (event) { where.push('event = ?'); args.push(event) }
      return db.prepare(`SELECT id, ts, level, event, message, platform_id AS platformId, task_id AS taskId, meta
        FROM activity_logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`)
        .all(...args, Math.min(Number(limit) || 100, 500))
        .map(r => ({ ...r, meta: r.meta && JSON.parse(r.meta) }))
    }
  }
}
