// A hosted copy starts with an empty database. seed/seed.json carries the non-secret records made locally
// (platforms, their scores, the DocStar profile); it is loaded once, into an empty database only.
import { existsSync, readFileSync } from 'node:fs'

const TABLES = ['platforms', 'platform_scores', 'company_information']

export function exportSeed(db) {
  const out = { exportedAt: new Date().toISOString() }
  for (const t of TABLES) out[t] = db.prepare(`SELECT * FROM ${t}`).all()
  return out
}

export function importSeedIfEmpty(db, file, activity) {
  if (!existsSync(file)) return 0
  if (db.prepare('SELECT 1 FROM platforms LIMIT 1').get() || db.prepare('SELECT 1 FROM company_information LIMIT 1').get()) return 0
  const seed = JSON.parse(readFileSync(file, 'utf8'))
  let n = 0
  db.transaction(() => {
    for (const t of TABLES) {
      for (const row of seed[t] || []) {
        const cols = Object.keys(row)
        db.prepare(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map(c => row[c]))
        n++
      }
    }
  })()
  activity.info('seed_loaded', `Loaded ${n} records exported from the local agent on ${seed.exportedAt?.slice(0, 10)}`)
  return n
}
