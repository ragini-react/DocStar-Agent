// Wires the agent's steps into the orchestrator's queue:
//   discover → qualify (per platform) → prepare (listing + approval) → submit (browser) → backlink checks.
// When the queue runs dry, the next step is queued from the database, so a restart loses nothing.
import { getSetting, now } from '../db/index.js'
import { createAi } from './ai.js'
import { createCompany } from './company.js'
import { createListings } from './listing.js'
import { createApprovals } from './approvals.js'
import { createDiscovery } from './discovery.js'
import { createQualifier } from './qualify.js'
import { createSubmitTask } from './submitTask.js'
import { createBacklinkChecker } from './backlinks.js'

const DISCOVERY_EVERY_MS = 6 * 3600_000
const BACKLINK_EVERY_MS = 10 * 60_000

export function createAgent({ db, vault, activity, chrome, gmail, orchestrator, platforms, config }) {
  const ai = createAi({ config })
  const company = createCompany({ db, ai, activity })
  const listings = createListings({ db, ai, company })
  const approvals = createApprovals({ db, activity, listings, orchestrator })
  const discovery = createDiscovery({ db, ai, platforms, activity })
  const browser = config.hosted ? null : chrome // a hosted copy has no Chrome: browser steps run elsewhere
  const qualifier = createQualifier({ db, ai, activity, chrome: browser, listings, approvals, orchestrator })
  const backlinks = createBacklinkChecker({ db, chrome: browser, activity })
  const submit = createSubmitTask({ db, vault, ai, chrome, gmail, company, listings, activity, config })

  orchestrator.register('discover', async () => {
    const r = await discovery.run({ batch: Number(getSetting(db, 'discovery_batch', 10)) })
    for (const id of r.added) orchestrator.enqueue(id, 'qualify')
  })
  orchestrator.register('qualify', async task => {
    try {
      await qualifier.run(task.platform_id)
    } catch (e) {
      // Three failed reads in a row: stop retrying this platform and show it as failed.
      const fails = db.prepare(`SELECT COUNT(*) n FROM automation_tasks WHERE platform_id = ? AND type = 'qualify' AND state = 'failed'`).get(task.platform_id).n
      if (fails >= 2) db.prepare(`UPDATE platforms SET status = 'failed', notes = ?, updated_at = ? WHERE id = ?`).run(`could not evaluate: ${e.message}`.slice(0, 300), now(), task.platform_id)
      throw e
    }
  })
  orchestrator.register('prepare', async (task, ctx) => qualifier.prepare(task.platform_id, ctx))
  // Registering and submitting need Chrome: on a hosted copy approved submissions wait in the queue for it.
  if (browser) orchestrator.register('submit', submit)

  function lastDiscovery() {
    return db.prepare(`SELECT MAX(created_at) t FROM automation_tasks WHERE type = 'discover'`).get().t
  }
  function queueDiscovery(force = false) {
    const pending = db.prepare(`SELECT 1 FROM automation_tasks WHERE type = 'discover' AND state IN ('queued','running')`).get()
    if (pending) return false
    const last = lastDiscovery()
    if (!force && last && Date.now() - Date.parse(last) < DISCOVERY_EVERY_MS) return false
    db.prepare(`INSERT INTO automation_tasks (platform_id, type) VALUES (NULL, 'discover')`).run()
    return true
  }

  // Anything recorded but not yet worked on gets its task; then, when nothing is left, search again.
  orchestrator.hooks.onIdle = () => {
    let queued = false
    const hourAgo = new Date(Date.now() - 3600_000).toISOString()
    for (const { id } of db.prepare(`SELECT p.id FROM platforms p WHERE p.status = 'discovered' AND NOT EXISTS (SELECT 1 FROM automation_tasks t
        WHERE t.platform_id = p.id AND t.type = 'qualify' AND t.state = 'failed' AND t.updated_at > ?)`).all(hourAgo)) {
      if (orchestrator.enqueue(id, 'qualify').created) queued = true
    }
    if (listings.ready()) {
      for (const { id } of db.prepare(`SELECT p.id FROM platforms p LEFT JOIN submissions s ON s.platform_id = p.id WHERE p.status = 'qualified' AND s.id IS NULL`).all()) {
        if (orchestrator.enqueue(id, 'prepare').created) queued = true
      }
    }
    return queued || queueDiscovery()
  }
  orchestrator.hooks.onStart = () => { if (!db.prepare('SELECT 1 FROM platforms LIMIT 1').get()) queueDiscovery(true) }

  const timer = setInterval(async () => {
    if (orchestrator.state() !== 'running') return
    try { await backlinks.runDue() } catch {}
  }, BACKLINK_EVERY_MS)
  timer.unref()

  return {
    ai, company, listings, approvals, discovery, qualifier, backlinks,
    queueDiscovery,
    approveCompany() {
      const n = company.approveAll()
      for (const { id } of db.prepare(`SELECT id FROM platforms WHERE status = 'qualified'`).all()) orchestrator.enqueue(id, 'prepare')
      return n
    },
    shutdown() { clearInterval(timer) }
  }
}
