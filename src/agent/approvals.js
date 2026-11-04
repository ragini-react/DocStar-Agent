// The operator's decisions: approve (optionally with an edited listing), reject, or skip a platform.
// Approval puts the platform's submit task in the queue; nothing is registered or published before it.
import { now } from '../db/index.js'

export function createApprovals({ db, activity, listings, orchestrator }) {
  const one = id => db.prepare(`SELECT h.*, p.name, p.domain FROM human_approvals h JOIN platforms p ON p.id = h.platform_id WHERE h.id = ?`).get(id)

  function decide(id, status, note) {
    const a = one(id)
    if (!a || a.status !== 'pending') throw new Error('This approval is not pending')
    db.prepare(`UPDATE human_approvals SET status = ?, note = ?, decided_at = ? WHERE id = ?`).run(status, note ?? null, now(), id)
    return a
  }

  return {
    request(platformId, kind, payload) {
      db.transaction(() => {
        db.prepare(`INSERT INTO human_approvals (platform_id, kind, payload) VALUES (?, ?, ?)
          ON CONFLICT DO NOTHING`).run(platformId, kind, JSON.stringify(payload))
        db.prepare(`UPDATE platforms SET status = 'approval_required', updated_at = ? WHERE id = ?`).run(now(), platformId)
      })()
      activity.info('approval_requested', `Listing ready for your approval`, { platformId })
    },

    pending() {
      return db.prepare(`SELECT h.id, h.kind, h.payload, h.created_at, p.id platform_id, p.name, p.domain, p.url, p.pricing, p.pricing_notes,
          p.submission_url, p.registration_requirements, p.submission_requirements
        FROM human_approvals h JOIN platforms p ON p.id = h.platform_id WHERE h.status = 'pending' ORDER BY h.id`).all()
        .map(r => ({ ...r, payload: JSON.parse(r.payload), listing: listings.get(r.platform_id) }))
    },

    approve(id, editedListing) {
      const a = decide(id, 'approved')
      if (editedListing) listings.save(a.platform_id, editedListing, 'approved')
      else db.prepare(`UPDATE submissions SET status = 'approved', updated_at = ? WHERE platform_id = ?`).run(now(), a.platform_id)
      db.prepare(`UPDATE submissions SET approved_at = ? WHERE platform_id = ?`).run(now(), a.platform_id)
      db.prepare(`UPDATE platforms SET status = 'ready_for_submission', updated_at = ? WHERE id = ?`).run(now(), a.platform_id)
      orchestrator.enqueue(a.platform_id, 'submit')
      activity.success('listing_approved', `${a.name}: approved; registration and submission queued`, { platformId: a.platform_id })
    },

    reject(id, note) {
      const a = decide(id, 'rejected', note)
      db.prepare(`UPDATE platforms SET status = 'rejected', notes = COALESCE(?, notes), updated_at = ? WHERE id = ?`).run(note || 'rejected by operator', now(), a.platform_id)
      activity.info('listing_rejected', `${a.name}: rejected by you`, { platformId: a.platform_id })
    },

    skip(id, note) {
      const a = decide(id, 'skipped', note)
      db.prepare(`UPDATE platforms SET status = 'rejected', notes = ?, updated_at = ? WHERE id = ?`).run(note || 'skipped by operator', now(), a.platform_id)
      activity.info('platform_skipped', `${a.name}: skipped by you`, { platformId: a.platform_id })
    }
  }
}
