// Wires the agent's steps into the orchestrator's queue:
//   discover → qualify (per platform) → prepare (listing + approval) → submit (browser) → backlink checks.
// Each task type declares how its platform's status moves (start, entry, failure), so the orchestrator settles the
// platform on every outcome. When the queue runs dry, the next step is queued from the database.
import { getSetting } from '../db/index.js'
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
const REGISTRATION = new Set(['registering', 'registered', 'email_verification_pending'])

/** Where a submit task's platform stands when the task starts: signing up, or straight to the form. */
export function submitStart(p, db) {
  if (!p) return null
  if (p.status === 'email_verification_pending') return null // resumes the verification it was waiting for
  if (p.status === 'registration_failed') return 'registering'
  const acc = db.prepare('SELECT status, signup_completed_at FROM accounts WHERE platform_id = ?').get(p.id)
  if (['approved', 'ready_for_submission', 'registered', 'submission_failed'].includes(p.status)) return acc && !acc.signup_completed_at && acc.status === 'pending' ? 'registering' : 'submitting'
  return null
}

export function createAgent({ db, vault, activity, chrome, gmail, orchestrator, platforms, status, config, autoApproval = null }) {
  const ai = createAi({ config })
  const company = createCompany({ db, ai, activity })
  const listings = createListings({ db, ai, company })
  const approvals = createApprovals({ db, activity, listings, orchestrator, status })
  const discovery = createDiscovery({ db, ai, platforms, activity })
  const browser = config.hosted ? null : chrome // a hosted copy has no Chrome: browser steps run elsewhere
  const qualifier = createQualifier({ db, ai, activity, chrome: browser, listings, approvals, orchestrator, status, autoApproval: (...a) => autoApproval?.(...a) ?? { ok: false } })
  const backlinks = createBacklinkChecker({ db, chrome: browser, activity, status })
  const submit = createSubmitTask({ db, vault, ai, chrome, gmail, company, listings, activity, config, status })

  orchestrator.register('discover', async () => {
    const r = await discovery.run({ batch: Number(getSetting(db, 'discovery_batch', 10)) })
    for (const id of r.added) orchestrator.enqueue(id, 'qualify')
  }, { exhausted: null, failed: null })

  orchestrator.register('qualify', task => qualifier.run(task.platform_id), {
    start: 'qualifying', entry: 'discovered', exhausted: 'evaluation_failed', failed: 'evaluation_failed', ownsInProgress: s => s === 'qualifying'
  })
  orchestrator.register('prepare', (task, ctx) => qualifier.prepare(task.platform_id, ctx), { entry: 'qualified', exhausted: 'needs_you', failed: 'needs_you' })

  // Registering and submitting need Chrome: on a hosted copy approved submissions wait in the queue for it.
  if (browser) {
    orchestrator.register('submit', submit, {
      browser: true,
      start: submitStart,
      // Interrupted: back to where it can be picked up again.
      entry: p => (signedUp(p.id) ? 'ready_for_submission' : 'approved'),
      exhausted: 'needs_you',
      failed: p => (REGISTRATION.has(p.status) || REGISTRATION.has(p.resume_status) ? 'registration_failed' : 'submission_failed'),
      ownsInProgress: s => s !== 'qualifying'
    })
  }
  const signedUp = id => Boolean(db.prepare(`SELECT 1 FROM accounts WHERE platform_id = ? AND signup_completed_at IS NOT NULL`).get(id))

  function lastDiscovery() {
    return db.prepare(`SELECT MAX(created_at) t FROM automation_tasks WHERE type = 'discover'`).get().t
  }
  function queueDiscovery(force = false) {
    const pending = db.prepare(`SELECT 1 FROM automation_tasks WHERE type = 'discover' AND state IN ('queued','running')`).get()
    if (pending) return false
    const last = lastDiscovery()
    if (!force && last && Date.now() - Date.parse(last) < DISCOVERY_EVERY_MS) return false
    db.prepare(`INSERT INTO automation_tasks (platform_id, type, idempotency_key) VALUES (NULL, 'discover', 'discover:none')`).run()
    orchestrator.wake()
    return true
  }

  /** Every platform waiting for a task gets one. Returns how many were queued. */
  function feedQueue() {
    let queued = 0
    const hourAgo = new Date(Date.now() - 3600_000).toISOString()
    for (const { id } of db.prepare(`SELECT p.id FROM platforms p WHERE p.status = 'discovered' AND NOT EXISTS (SELECT 1 FROM automation_tasks t
        WHERE t.platform_id = p.id AND t.type = 'qualify' AND t.state = 'failed' AND t.updated_at > ?)`).all(hourAgo)) {
      if (orchestrator.enqueue(id, 'qualify').created) queued++
    }
    // Evaluations that failed for lack of data are retried a day later (up to three rounds).
    for (const { id } of db.prepare(`SELECT p.id FROM platforms p WHERE p.status = 'evaluation_failed' AND p.status_changed_at < ?
        AND (SELECT COUNT(*) FROM automation_tasks t WHERE t.platform_id = p.id AND t.type = 'qualify') < 4`).all(new Date(Date.now() - 86400_000).toISOString())) {
      db.prepare(`UPDATE automation_tasks SET state = 'cancelled' WHERE platform_id = ? AND type = 'qualify' AND state = 'done'`).run(id)
      if (orchestrator.enqueue(id, 'qualify').created) queued++
    }
    if (listings.ready()) {
      for (const { id } of db.prepare(`SELECT p.id FROM platforms p WHERE p.status IN ('qualified','listing_drafted')`).all()) {
        if (orchestrator.enqueue(id, 'prepare').created) queued++
      }
    }
    if (browser) {
      for (const { id } of db.prepare(`SELECT p.id FROM platforms p WHERE p.status IN ('approved','ready_for_submission') AND NOT EXISTS
          (SELECT 1 FROM automation_tasks t WHERE t.platform_id = p.id AND t.type = 'submit' AND t.state IN ('queued','running','waiting','needs_you','done'))`).all()) {
        if (orchestrator.enqueue(id, 'submit').created) queued++
      }
    }
    return queued
  }

  orchestrator.hooks.onIdle = () => feedQueue() > 0 || queueDiscovery()
  orchestrator.hooks.onStart = () => { if (!db.prepare('SELECT 1 FROM platforms LIMIT 1').get()) queueDiscovery(true) }

  // Backlink checks are read-only: they run whether or not the automation is started.
  const timer = setInterval(async () => {
    try { await backlinks.runDue() } catch {}
  }, BACKLINK_EVERY_MS)
  timer.unref?.()

  return {
    ai, company, listings, approvals, discovery, qualifier, backlinks,
    queueDiscovery,
    feedQueue,
    approveCompany() {
      const n = company.approveAll()
      orchestrator.signal('company_approved')
      feedQueue()
      return n
    },
    shutdown() { clearInterval(timer) }
  }
}
