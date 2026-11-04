// One place for every setting. Locally, secrets come from .env and the two the app owns itself (encryption key,
// admin password) are generated into .env on first start. Hosted (Embarko sets DATA_DIR), secrets come only from
// the host's environment settings, the encryption key is kept under DATA_DIR, and nothing is written next to the code.
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const ENV_FILE = path.join(ROOT, '.env')
export const HOSTED = Boolean(process.env.DATA_DIR)

if (existsSync(ENV_FILE) && !process.env.DOCSTAR_TEST && process.loadEnvFile) process.loadEnvFile(ENV_FILE) // set variables win over the file

function ensureGenerated(key, make) {
  if (process.env[key]) return
  const value = make()
  const current = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : ''
  appendFileSync(ENV_FILE, `${current.endsWith('\n') || !current ? '' : '\n'}${key}=${value}\n`, { mode: 0o600 })
  process.env[key] = value
  console.log(`[config] generated ${key} and saved it to .env`)
}

// Hosted: the key that seals stored credentials lives with the data it seals, so a redeploy keeps both.
function hostedMasterKey() {
  if (process.env.DOCSTAR_MASTER_KEY) return process.env.DOCSTAR_MASTER_KEY
  const file = path.join(process.env.DATA_DIR, 'master.key')
  if (!existsSync(file)) {
    mkdirSync(process.env.DATA_DIR, { recursive: true })
    writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600 })
  }
  return readFileSync(file, 'utf8').trim()
}

export const viasocketConfigured = () => ['VIASOCKET_ORG_ID', 'VIASOCKET_PROJECT_ID', 'VIASOCKET_EMBED_SECRET'].every(k => process.env[k])

export function loadConfig() {
  // Tests point DB_PATH elsewhere and pass their own key, so nothing is generated for them.
  if (!process.env.DOCSTAR_TEST && !HOSTED) {
    ensureGenerated('DOCSTAR_MASTER_KEY', () => randomBytes(32).toString('base64'))
    ensureGenerated('DOCSTAR_ADMIN_PASSWORD', () => randomBytes(18).toString('base64url'))
  }
  if (!HOSTED) {
    const missing = ['VIASOCKET_ORG_ID', 'VIASOCKET_PROJECT_ID', 'VIASOCKET_EMBED_SECRET', 'DOCSTAR_MASTER_KEY', 'DOCSTAR_ADMIN_PASSWORD']
      .filter(k => !process.env[k])
    if (missing.length) throw new Error(`Missing in .env: ${missing.join(', ')}`)
  }

  const masterKey = Buffer.from(HOSTED ? hostedMasterKey() : process.env.DOCSTAR_MASTER_KEY, 'base64')
  if (masterKey.length !== 32) throw new Error('DOCSTAR_MASTER_KEY must be 32 bytes, base64')
  const dataDir = HOSTED ? process.env.DATA_DIR : path.join(ROOT, 'data')

  return {
    hosted: HOSTED,
    port: Number(process.env.PORT || 4000),
    // Locally the dashboard listens on this Mac only. Hosted, the platform's proxy (HTTPS) is the only way in.
    host: HOSTED ? '0.0.0.0' : '127.0.0.1',
    publicHosts: HOSTED && process.env.APP_NAME ? [`${process.env.APP_NAME}.embarko.app`] : [],
    dbPath: process.env.DB_PATH || path.join(dataDir, 'docstar.db'),
    seedPath: path.join(ROOT, 'seed', 'seed.json'),
    chrome: {
      executable: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      profileDir: process.env.CHROME_PROFILE_DIR || path.join(dataDir, 'chrome-profile'),
      debugPort: Number(process.env.CHROME_DEBUG_PORT || 9333)
    },
    masterKey,
    adminPassword: process.env.DOCSTAR_ADMIN_PASSWORD || null, // hosted without it: sign-in stays closed
    viasocketConfigured: viasocketConfigured(),
    // Live mirror (src/sync/mirror.js). Mac: where to push and with which token. Hosted: the token it accepts.
    mirror: HOSTED
      ? { receiveToken: process.env.SYNC_TOKEN || null }
      : { url: process.env.HOSTED_URL || null, token: process.env.HOSTED_SYNC_TOKEN || null },
    operatorUserId: 'docstar-operator', // the viaSocket user every connection and AI thread belongs to
    gmail: {
      slug: 'gmail',
      // Connect asks Google only for these actions' scopes; run by their action_id and version.
      searchAction: { id: 'rowr1h03w5cx', version: 'V22' },
      getMessageAction: { id: 'row8s689orsm', version: 'V3' }
    }
  }
}
