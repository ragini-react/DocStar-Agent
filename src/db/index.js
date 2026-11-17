import Database from 'better-sqlite3'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { LATEST, MIGRATIONS } from './migrations.js'

const SCHEMA = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql'), 'utf8')
export const VERSION = LATEST

export function openDb(dbPath, { log = console.log } = {}) {
  if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 })
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL') // a crash mid-write never leaves a half-written row
  db.pragma('busy_timeout = 5000')
  let current = db.pragma('user_version', { simple: true })
  if (current > VERSION) throw new Error(`database is version ${current}, this code knows up to ${VERSION}`)
  if (current === 0) {
    db.transaction(() => { db.exec(SCHEMA); db.pragma('user_version = 1') })()
    current = 1
  } else if (current < VERSION && dbPath !== ':memory:') {
    // A copy of the database as it was, before anything changes it.
    const backup = `${dbPath}.before-v${VERSION}-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`
    if (!existsSync(backup)) db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`)
    log(`[db] backed up to ${path.basename(backup)} before migrating v${current} → v${VERSION}`)
  }
  if (current < VERSION) {
    db.pragma('foreign_keys = OFF') // table rebuilds; checked again below
    for (let v = current + 1; v <= VERSION; v++) {
      db.transaction(() => { MIGRATIONS[v](db); db.pragma(`user_version = ${v}`) })()
    }
    const broken = db.pragma('foreign_key_check')
    if (broken.length) throw new Error(`migration left ${broken.length} broken foreign key(s): ${JSON.stringify(broken.slice(0, 3))}`)
  }
  db.pragma('foreign_keys = ON')
  return db
}

export const now = () => new Date().toISOString()

export function getSetting(db, key, fallback = null) {
  return db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key)?.value ?? fallback
}

export const numSetting = (db, key, fallback) => {
  const n = Number(getSetting(db, key, fallback))
  return Number.isFinite(n) ? n : fallback
}

export function setSetting(db, key, value) {
  db.prepare(`INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, String(value), now())
}
