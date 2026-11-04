import Database from 'better-sqlite3'
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCHEMA = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql'), 'utf8')
const VERSION = 1

export function openDb(dbPath) {
  if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 })
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL') // a crash mid-write never leaves a half-written row
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  const current = db.pragma('user_version', { simple: true })
  if (current === 0) {
    db.transaction(() => {
      db.exec(SCHEMA)
      db.pragma(`user_version = ${VERSION}`)
    })()
  } else if (current > VERSION) {
    throw new Error(`database is version ${current}, this code knows up to ${VERSION}`)
  }
  return db
}

export const now = () => new Date().toISOString()

export function getSetting(db, key, fallback = null) {
  return db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key)?.value ?? fallback
}

export function setSetting(db, key, value) {
  db.prepare(`INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, String(value), now())
}
