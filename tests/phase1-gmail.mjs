// Phase 1, tests 1–3: the Gmail test connection, search-email-messages (V22) and get-gmail-message-by-id (V3).
// Run: node --env-file=.env tests/phase1-gmail.mjs [sender-domain]   (default google.com: the security
// alert Google sends when Gmail is connected to viaSocket). Output is sanitized: no auth_id, script_id,
// email addresses, link query strings or full bodies are printed.
import { viasocket, serviceIdFor } from '../src/integrations/viasocket.js'

const TEST_USER = 'apps-api-test-user' // the dashboard's test connection belongs to this user
const domain = process.argv[2] || 'google.com'

const mask = s => (s.length <= 8 ? '…' : `${s.slice(0, 3)}…${s.slice(-3)}`)
function sanitize(v, key = '') {
  if (typeof v === 'string') {
    let s = v.replace(/([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '<email>@$2')
      .replace(/(https?:\/\/[^\s"'<>?#]+)[?#][^\s"'<>]*/g, '$1?<query>')
    if (/(^id$|_id$|Id$|token|threadId)/i.test(key)) s = mask(s)
    return s.length > 200 ? `${s.slice(0, 200)}… (${s.length} chars)` : s
  }
  if (Array.isArray(v)) return v.slice(0, 3).map(x => sanitize(x, key)).concat(v.length > 3 ? [`… ${v.length - 3} more`] : [])
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sanitize(x, k)]))
  return v
}
const show = (label, v) => console.log(`\n=== ${label}\n${JSON.stringify(sanitize(v), null, 1)}`)

const user = viasocket.user(TEST_USER)
const serviceId = await serviceIdFor('gmail')

// Test 1: the connection
const connections = await user.listConnections()
const gmail = connections.filter(c => String(c.id).endsWith(`_${serviceId}`))
console.log(`=== Test 1: connections for test user: ${connections.length}, Gmail: ${gmail.length}`)
if (!gmail.length) {
  console.log('No Gmail connection yet: connect a test account on the apps-api page of your viaSocket embed project')
  process.exit(1)
}
show('Test 1: Gmail connection (sanitized)', gmail.map(c => ({ ...c, id: mask(String(c.id)) })))
const authId = gmail[0].id

const scriptId = (await user.findEnabled(serviceId)) ?? (await user.enable(serviceId, authId)).scriptId
console.log(`enabled Gmail for test user: ${scriptId ? 'yes' : 'NO'}`)

// Test 2: search, with the parameters from the plan
const searchVersionId = await viasocket.catalog.versionIdFor(serviceId, 'rowr1h03w5cx', 'V22')
const t2 = Date.now()
const search = await viasocket.runAction(scriptId, searchVersionId, {
  search_mode: 'manual',
  query: ['domain'],
  searchFields: { domain },
  pagination: { maxResults: 5 }
})
console.log(`\nTest 2 took ${((Date.now() - t2) / 1000).toFixed(1)}s, domain=${domain}`)
show('Test 2: search-email-messages response (sanitized)', search)

// Test 3: one message by the id the search returned
const found = JSON.stringify(search).match(/"(?:id|messageId|message_id)":"([0-9a-f]{12,})"/)
if (!found) {
  console.log('\nTest 3 skipped: no message id in the search response (shape above)')
  process.exit(0)
}
const getVersionId = await viasocket.catalog.versionIdFor(serviceId, 'row8s689orsm', 'V3')
const t3 = Date.now()
const message = await viasocket.runAction(scriptId, getVersionId, { message_id: found[1] })
console.log(`\nTest 3 took ${((Date.now() - t3) / 1000).toFixed(1)}s`)
show('Test 3: get-gmail-message-by-id response (sanitized)', message)
