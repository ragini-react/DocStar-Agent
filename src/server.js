// Entry point: node --env-file=.env src/server.js
import { loadConfig } from './config/index.js'
import { openDb } from './db/index.js'
import { importSeedIfEmpty } from './db/seed.js'
import { createVault } from './security/crypto.js'
import { maskError } from './security/mask.js'
import { createActivityLog } from './logging/activity.js'
import { viasocket } from './integrations/viasocket.js'
import { createGmail } from './integrations/gmail.js'
import { createChrome } from './browser/chrome.js'
import { createOrchestrator } from './engine/orchestrator.js'
import { createPlatforms } from './platforms/service.js'
import { createApp } from './server/app.js'
import { createAgent } from './agent/index.js'
import { createMirrorPusher, createMirrorReceiver } from './sync/mirror.js'

const config = loadConfig()
const db = openDb(config.dbPath)
const vault = createVault(config.masterKey)
const activity = createActivityLog(db)
if (config.hosted) importSeedIfEmpty(db, config.seedPath, activity)
const gmail = createGmail({ db, vault, activity, viasocket, config })
const chrome = createChrome({ config, activity })
const orchestrator = createOrchestrator({ db, activity, chrome, browser: !config.hosted })
const platforms = createPlatforms({ db, activity })

const agent = createAgent({ db, vault, activity, chrome, gmail, orchestrator, platforms, config })
orchestrator.boot()
const mirrorReceiver = config.hosted && config.mirror.receiveToken ? createMirrorReceiver({ db, activity, token: config.mirror.receiveToken }) : null
const app = createApp({ config, db, vault, activity, gmail, chrome, orchestrator, platforms, agent, mirror: mirrorReceiver })
const mirrorPusher = !config.hosted && config.mirror.url && config.mirror.token
  ? createMirrorPusher({ db, activity, chrome, gmail, orchestrator, replay: app.locals.replay, url: config.mirror.url, token: config.mirror.token })
  : null
const server = app.listen(config.port, config.host, () => {
  activity.info('server_started', `Dashboard on http://localhost:${config.port}`)
  mirrorPusher?.start()
})

process.on('unhandledRejection', e => activity.error('unhandled', maskError(e)))
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    orchestrator.shutdown()
    agent.shutdown()
    mirrorPusher?.shutdown()
    server.close()
    await chrome.close() // detach only; Chrome and its Google session stay open
    db.close()
    process.exit(0)
  })
}
