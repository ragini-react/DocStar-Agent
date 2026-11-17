// Shared test wiring: an in-memory database with the real modules, no network, no Chrome, no console noise.
import { openDb } from '../../src/db/index.js'
import { createActivityLog } from '../../src/logging/activity.js'
import { createStatus } from '../../src/engine/status.js'
import { createOrchestrator } from '../../src/engine/orchestrator.js'
import { createPlatforms } from '../../src/platforms/service.js'
import { createViews } from '../../src/platforms/views.js'
import { createMaintenance } from '../../src/engine/maintenance.js'

export function setup({ browser = false } = {}) {
  const db = openDb(':memory:', { log: () => {} })
  const activity = createActivityLog(db, { quiet: true })
  const status = createStatus({ db, activity })
  const chrome = { connect: async () => {} }
  const orchestrator = createOrchestrator({ db, activity, chrome, status, browser })
  const platforms = createPlatforms({ db, activity, status, orchestrator })
  const views = createViews({ db })
  const maintenance = createMaintenance({ db, activity, status, orchestrator })
  const run = () => db.prepare(`UPDATE system_settings SET value = 'running' WHERE key = 'automation_state'`).run()
  return { db, activity, status, orchestrator, platforms, views, maintenance, run, restore: () => {} }
}

/** A platform walked to `status` through allowed transitions, with the rows that status implies. */
export function platformAt(t, status, { name = `P${Math.random().toString(36).slice(2, 7)}`, account = null, submission = null } = {}) {
  const { platform } = t.platforms.create({ name, url: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.io` })
  const id = platform.id
  if (submission) t.db.prepare(`INSERT INTO submissions (platform_id, status) VALUES (?, ?)`).run(id, submission)
  if (account) t.db.prepare(`INSERT INTO accounts (platform_id, email, login_method, status) VALUES (?, 'support@docstar.io', 'google', ?)`).run(id, account)
  t.db.prepare(`UPDATE platforms SET status = ? WHERE id = ?`).run(status, id)
  return id
}
