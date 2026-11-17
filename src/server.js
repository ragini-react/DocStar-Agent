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
import { createViews } from './platforms/views.js'
import { createStatus } from './engine/status.js'
import { createMaintenance } from './engine/maintenance.js'
import { repairData, repairDone } from './db/repair.js'
import { repairSteps } from './db/repairSteps.js'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { createApp } from './server/app.js'
import { createAgent } from './agent/index.js'
import { createMirrorPusher, createMirrorReceiver } from './sync/mirror.js'
import { createAlerts } from './alerts/index.js'
import { createManual } from './agent/manual.js'

const config = loadConfig()
const db = openDb(config.dbPath)
const vault = createVault(config.masterKey)
const activity = createActivityLog(db)
if (config.hosted) importSeedIfEmpty(db, config.seedPath, activity)
const status = createStatus({ db, activity })
const alerts = createAlerts({ db, activity })
const views = createViews({ db })
const gmail = createGmail({ db, vault, activity, viasocket, config })
const chrome = createChrome({ config, activity })
const orchestrator = createOrchestrator({ db, activity, chrome, status, browser: !config.hosted })
const platforms = createPlatforms({ db, activity, status, orchestrator })

const agent = createAgent({ db, vault, activity, chrome, gmail, orchestrator, platforms, status, config, alerts })
orchestrator.boot()
const maintenance = createMaintenance({ db, activity, status, orchestrator, alerts, hooks: { feedQueue: () => agent.feedQueue() } })
const manual = createManual({ db, activity, status, orchestrator, backlinks: agent.backlinks })
// A hosted mirror shows the Mac's records: it never rewrites them itself.
if (!config.hosted) {
  if (!repairDone(db)) {
    // One-time repair of records written before the state machine (report saved next to the database).
    const r = repairData({ db, status, activity, orchestrator, maintenance, extraSteps: repairSteps })
    const file = path.join(path.dirname(config.dbPath), `repair-report-${new Date().toISOString().slice(0, 10)}.md`)
    writeFileSync(file, r.report, { mode: 0o600 })
    activity.warn('data_repaired', `One-time data repair done: ${r.notes.length} change(s); report in ${path.basename(file)}`)
  }
  maintenance.start()
}
const mirrorReceiver = config.hosted && config.mirror.receiveToken ? createMirrorReceiver({ db, activity, token: config.mirror.receiveToken, alerts }) : null
mirrorReceiver?.startWatch()
let mirrorPusher = null
const app = createApp({ config, db, vault, activity, gmail, chrome, orchestrator, platforms, agent, status, views, maintenance, manual, alerts, mirror: mirrorReceiver, pusher: () => mirrorPusher })
mirrorPusher = !config.hosted && config.mirror.url && config.mirror.token
  ? createMirrorPusher({ db, activity, chrome, gmail, orchestrator, replay: app.locals.replay, url: config.mirror.url, token: config.mirror.token, alerts })
  : null
const server = app.listen(config.port, config.host, () => {
  activity.info('server_started', `Dashboard on http://localhost:${config.port}`)
  mirrorPusher?.start()
})

process.on('unhandledRejection', e => activity.error('unhandled', maskError(e)))
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    orchestrator.shutdown()
    maintenance.shutdown()
    agent.shutdown()
    mirrorPusher?.shutdown()
    mirrorReceiver?.stopWatch()
    server.close()
    await chrome.close() // detach only; Chrome and its Google session stay open
    db.close()
    process.exit(0)
  })
}
