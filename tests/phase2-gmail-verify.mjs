// Phase 2 check on the operator's own Gmail connection (the one saved from the dashboard): search, fetch one
// message by id, search again, and compare the UNREAD label before and after. Prints no content.
// Run: node --env-file=.env tests/phase2-gmail-verify.mjs
import { loadConfig } from '../src/config/index.js'
import { openDb } from '../src/db/index.js'
import { createVault } from '../src/security/crypto.js'
import { viasocket, serviceIdFor } from '../src/integrations/viasocket.js'

const config = loadConfig()
const db = openDb(config.dbPath)
const row = db.prepare("SELECT value_enc FROM integration_settings WHERE key = 'gmail'").get()
if (!row) { console.log('Gmail is not connected in the dashboard'); process.exit(1) }
const { scriptId } = JSON.parse(createVault(config.masterKey).decrypt(row.value_enc))

const serviceId = await serviceIdFor('gmail')
const searchId = await viasocket.catalog.versionIdFor(serviceId, config.gmail.searchAction.id, config.gmail.searchAction.version)
const getId = await viasocket.catalog.versionIdFor(serviceId, config.gmail.getMessageAction.id, config.gmail.getMessageAction.version)
const search = () => viasocket.runAction(scriptId, searchId, {
  search_mode: 'manual', query: ['domain'], searchFields: { domain: 'accounts.google.com' }, pagination: { maxResults: 5 }
})
const short = id => `${id.slice(0, 3)}…${id.slice(-3)}`
const unread = e => e.labelIds?.includes('UNREAD') ?? false

let t = Date.now()
const before = (await search()).emails ?? []
console.log(`search 1: ${before.length} messages in ${Date.now() - t} ms`)
for (const e of before) console.log(`  ${short(e.id)} ${e.originalSentDate} unread=${unread(e)} bodyKeys=${Object.keys(e.body || {}).join('+')}`)

const target = before.find(unread) ?? before[0]
if (!target) { console.log('no message to fetch'); process.exit(1) }
t = Date.now()
const msg = await viasocket.runAction(scriptId, getId, { message_id: target.id })
console.log(`get by id ${short(target.id)}: ${Date.now() - t} ms, same id=${msg.id === target.id}, unread in reply=${unread(msg)}, body present=${Boolean(msg.body?.plain || msg.body?.html)}`)

const after = (await search()).emails ?? []
const again = after.find(e => e.id === target.id)
console.log(`search 2: target unread before=${unread(target)} after=${again ? unread(again) : 'not returned'}`)
const changed = before.filter(b => { const a = after.find(x => x.id === b.id); return a && unread(a) !== unread(b) })
console.log(`read/unread changes across all ${before.length} messages: ${changed.length}`)
db.close()
