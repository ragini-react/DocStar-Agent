// Write seed/seed.json from the local database (platforms, scores, DocStar profile; no accounts or secrets).
// Also writes seed/admin-password.json (a hash only). Run before deploying a hosted copy: node scripts/export-seed.mjs
import { writeFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { exportSeed } from '../src/db/seed.js'
import { hashAdminPassword } from '../src/security/adminPassword.js'

const db = new Database('data/docstar.db', { readonly: true })
const seed = exportSeed(db)
writeFileSync('seed/seed.json', JSON.stringify(seed, null, 1) + '\n')
// The hosted copy accepts the same admin password: only its salted scrypt hash is shipped.
process.loadEnvFile('.env')
writeFileSync('seed/admin-password.json', JSON.stringify(hashAdminPassword(process.env.DOCSTAR_ADMIN_PASSWORD)) + '\n')
console.log('seed/admin-password.json: hash of DOCSTAR_ADMIN_PASSWORD')
console.log(`seed/seed.json: ${seed.platforms.length} platforms, ${seed.platform_scores.length} scores, ${seed.company_information.length} profile fields`)
