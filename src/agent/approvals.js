// The operator's decisions: approve (optionally with an edited listing), reject, or skip a platform. Approval moves the
// platform to approved, queues its submit task and wakes any task waiting for this approval; nothing is registered or
// published before it. Each decision changes the approval, the listing and the platform in one transaction.
import { now } from '../db/index.js'

export function createApprovals({ db, activity, listings, orchestrator, status }) {
  const one = id => db.prepare(`SELECT h.*, p.name, p.domain FROM human_approvals h JOIN platforms p ON p.id = h.platform_id WHERE h.id = ?`).get(id)

  function decide(id, decision, note) {
    const a = one(id)
    if (!a) throw Object.assign(new Error('No such approval'), { status: 404 })
    if (a.status !== 'pending') throw Object.assign(new Error(`This approval was already ${a.status}`), { status: 409 })
    db.prepare(`UPDATE human_approvals SET status = ?, note = ?, decided_at = ? WHERE id = ?`).run(decision, note ?? null, now(), id)
    return a
  }

  return {
    request(platformId, kind, payload) {
      db.transaction(() => {
        db.prepare(`INSERT INTO human_approvals (platform_id, kind, payload) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`).run(platformId, kind, JSON.stringify(payload))
        status.transition(platformId, 'approval_required', { reason: 'listing ready for your approval' })
      })()
      activity.info('approval_requested', 'Listing ready for your approval', { platformId })
    },

    pending() {
      return db.prepare(`SELECT h.id, h.kind, h.payload, h.created_at, p.id platform_id, p.name, p.domain, p.url, p.pricing, p.pricing_notes,
          p.submission_url, p.registration_requirements, p.submission_requirements
        FROM human_approvals h JOIN platforms p ON p.id = h.platform_id WHERE h.status = 'pending' ORDER BY h.id`).all()
        .map(r => ({ ...r, payload: JSON.parse(r.payload), listing: listings.get(r.platform_id) }))
    },

    /** Approve a listing. `auto`: approved by the auto-approval rule, not a person. */
    approve(id, editedListing, { auto = false, why = null } = {}) {
      let a
      db.transaction(() => {
        a = decide(id, 'approved', auto ? `auto-approved: ${why}` : null)
        if (editedListing) listings.save(a.platform_id, editedListing, 'approved')
        else db.prepare(`UPDATE submissions SET status = 'approved', updated_at = ? WHERE platform_id = ?`).run(now(), a.platform_id)
        db.prepare(`UPDATE submissions SET approved_at = ?, auto_approved = ? WHERE platform_id = ?`).run(now(), auto ? 1 : 0, a.platform_id)
        status.transition(a.platform_id, 'approved', { actor: auto ? 'agent' : 'operator', reason: auto ? `auto-approved: ${why}` : 'approved by you' })
        orchestrator.enqueue(a.platform_id, 'submit')
      })()
      orchestrator.signal(`approval:${a.platform_id}`)
      activity.success('listing_approved', `${a.name}: ${auto ? 'auto-approved' : 'approved'}; registration and submission queued`, { platformId: a.platform_id })
    },

    /** Approve straight from the platform (no approval row: e.g. require_approval was off when it was drafted). */
    approvePlatform(platformId, { auto = false, why = null } = {}) {
      const pending = db.prepare(`SELECT id FROM human_approvals WHERE platform_id = ? AND status = 'pending'`).get(platformId)
      if (pending) return this.approve(pending.id, null, { auto, why })
      db.transaction(() => {
        db.prepare(`UPDATE submissions SET status = 'approved', approved_at = ?, auto_approved = ?, updated_at = ? WHERE platform_id = ?`).run(now(), auto ? 1 : 0, now(), platformId)
        status.transition(platformId, 'approved', { actor: auto ? 'agent' : 'operator', reason: auto ? `auto-approved: ${why}` : 'approved' })
        orchestrator.enqueue(platformId, 'submit')
      })()
      orchestrator.signal(`approval:${platformId}`)
    },

    reject(id, note) {
      const a = one(id)
      db.transaction(() => {
        decide(id, 'rejected', note)
        if (note) db.prepare(`UPDATE platforms SET notes = ? WHERE id = ?`).run(note, a.platform_id)
        orchestrator.cancelPlatformTasks(a.platform_id, 'listing rejected by you')
        status.transition(a.platform_id, 'rejected', { actor: 'operator', operator: true, statusReason: 'operator', reason: note || 'rejected by you' })
      })()
      activity.info('listing_rejected', `${a.name}: rejected by you`, { platformId: a.platform_id })
    },

    skip(id, note) {
      const a = one(id)
      db.transaction(() => {
        decide(id, 'skipped', note)
        orchestrator.cancelPlatformTasks(a.platform_id, 'platform skipped by you')
        status.transition(a.platform_id, 'rejected', { actor: 'operator', operator: true, statusReason: 'operator', reason: note || 'skipped by you' })
      })()
      activity.info('platform_skipped', `${a.name}: skipped by you`, { platformId: a.platform_id })
    }
  }
}
