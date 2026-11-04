// One-off cleanup of DocStar's own Gmail resources in the old embed project, using the backup keys.
// Touches only the two DocStar users, only Gmail, only resources of the old project, and never the
// connection or flow the app uses now. Dry run unless --apply. Prints masked ids only.
// Run: node --env-file=.env tests/cleanup-old-project.mjs [--apply]
// Ran once on 2026-11-02 (2 connections revoked, 2 flows deleted); it needs the backup file, which is now deleted.
import { readFileSync } from 'node:fs'
import { ViaSocket } from 'viasocket-apps'
import { loadConfig } from '../src/config/index.js'
import { openDb } from '../src/db/index.js'
import { createVault } from '../src/security/crypto.js'
import { serviceIdFor } from '../src/integrations/viasocket.js'

const APPLY = process.argv.includes('--apply')
const USERS = ['docstar-operator', 'apps-api-test-user']
const mask = s => `${String(s).slice(0, 4)}…${String(s).slice(-4)}`

const config = loadConfig()
const db = openDb(config.dbPath)
const current = JSON.parse(createVault(config.masterKey).decrypt(
  db.prepare("SELECT value_enc FROM integration_settings WHERE key = 'gmail'").get().value_enc))
db.close()

const old = Object.fromEntries(readFileSync('.env.backup-2026-11-02', 'utf8').split('\n').filter(l => l.includes('='))
  .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
const OLD_PROJECT = old.VIASOCKET_PROJECT_ID
if (OLD_PROJECT === process.env.VIASOCKET_PROJECT_ID) throw new Error('backup points at the current project: refusing')
const oldClient = new ViaSocket({ orgId: old.VIASOCKET_ORG_ID, projectId: OLD_PROJECT, secret: old.VIASOCKET_EMBED_SECRET })
const serviceId = await serviceIdFor('gmail')

console.log(`${APPLY ? 'APPLY' : 'DRY RUN'}: old project ${OLD_PROJECT}; current connection ${mask(current.authId)}, current flow ${mask(current.scriptId)}`)
for (const userId of USERS) {
  const user = oldClient.user(userId)
  const conns = (await user.listConnections()).filter(c =>
    String(c.id).endsWith(`_${serviceId}`) &&
    JSON.stringify(c.access_level_ids_list) === JSON.stringify([OLD_PROJECT]))
  const flows = (await user.listFlows()).filter(f => f.status !== 'deleted')
  console.log(`\n${userId}: old-project Gmail connections ${conns.length}, flows in old project ${flows.length}`)
  for (const f of flows) {
    if (f.id === current.scriptId) throw new Error('a flow in the old project is the app\'s current flow: refusing')
    console.log(`  flow ${mask(f.id)} status=${f.status} title=${f.title} → ${APPLY ? 'delete' : 'would delete'}`)
    if (APPLY) await user.setFlowStatus(f.id, 0)
  }
  for (const c of conns) {
    if (c.id === current.authId) throw new Error('an old-project connection is the app\'s current connection: refusing')
    console.log(`  connection ${mask(c.id)} projects=${c.access_level_ids_list.join('+')} → ${APPLY ? 'revoke' : 'would revoke'}`)
    if (APPLY) await user.revokeConnection(c.id)
  }
  if (APPLY) {
    const left = (await user.listConnections()).filter(c => JSON.stringify(c.access_level_ids_list) === JSON.stringify([OLD_PROJECT]) && String(c.id).endsWith(`_${serviceId}`))
    const flowsLeft = (await user.listFlows()).filter(f => f.status !== 'deleted')
    console.log(`  after: old-project Gmail connections ${left.length}, live flows ${flowsLeft.length}`)
  }
}
