// Read-only check that the dashboard's Gmail connection and flow live in the current project, and that the old
// project's flow is not the one the app uses. Old project is read with the backup keys; nothing is changed.
// Run: node --env-file=.env tests/migration-verify.mjs [.env.backup-file]
import { existsSync, readFileSync } from 'node:fs'
import { ViaSocket } from 'viasocket-apps'
import { loadConfig } from '../src/config/index.js'
import { openDb } from '../src/db/index.js'
import { createVault } from '../src/security/crypto.js'
import { viasocket, serviceIdFor } from '../src/integrations/viasocket.js'

const backup = process.argv[2] || '.env.backup-2026-11-02'
const config = loadConfig()
const mask = s => (s ? `${String(s).slice(0, 4)}…${String(s).slice(-4)}` : String(s))
const db = openDb(config.dbPath)
const row = db.prepare("SELECT value_enc, meta, updated_at FROM integration_settings WHERE key = 'gmail'").get()
db.close()
if (!row) { console.log('no Gmail connection stored'); process.exit(1) }
const stored = JSON.parse(createVault(config.masterKey).decrypt(row.value_enc))
console.log(`stored in app: auth ${mask(stored.authId)}, flow ${mask(stored.scriptId)}, saved ${row.updated_at}`)

const serviceId = await serviceIdFor('gmail')
const project = process.env.VIASOCKET_PROJECT_ID
const user = viasocket.user(config.operatorUserId)

const conns = await user.listConnections()
const conn = conns.find(c => c.id === stored.authId)
console.log(`\n1. connection: ${conn ? 'found' : 'NOT FOUND'}; projects=${JSON.stringify(conn?.access_level_ids_list)}; in current project ${project}: ${Boolean(conn?.access_level_ids_list?.includes(project))}; expired=${conn?.isExpired}`)
console.log(`   all operator Gmail connections visible: ${conns.filter(c => String(c.id).endsWith(`_${serviceId}`)).map(c => `${mask(c.id)}→${(c.access_level_ids_list || []).join('+')}`).join(', ')}`)

const flows = await user.listFlows()
const enabled = await user.findEnabled(serviceId)
console.log(`\n2. flows of operator in current project: ${flows.length}; enabled Gmail flow ${mask(enabled)}; equals stored flow: ${enabled === stored.scriptId}`)

if (!existsSync(backup)) { console.log(`\n3. old project: skipped (${backup} no longer exists)`); process.exit(0) }
const old = Object.fromEntries(readFileSync(backup, 'utf8').split('\n').filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
const oldClient = new ViaSocket({ orgId: old.VIASOCKET_ORG_ID, projectId: old.VIASOCKET_PROJECT_ID, secret: old.VIASOCKET_EMBED_SECRET })
const oldFlows = await oldClient.user(config.operatorUserId).listFlows()
const oldIds = oldFlows.map(f => f.id ?? f.script_id ?? f.scriptId).filter(Boolean)
console.log(`\n3. old project ${old.VIASOCKET_PROJECT_ID}: operator flows ${oldIds.map(mask).join(', ') || 'none'}; app uses one of them: ${oldIds.includes(stored.scriptId)}`)
