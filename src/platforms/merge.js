// Merge a duplicate platform into the one that stays, keeping all history: scores, transitions, activity, emails,
// screenshots, approvals and tasks move over; an account or listing the kept platform lacks moves over too. The
// duplicate's own row is recorded in the kept platform's timeline before it is removed.
import { now } from '../db/index.js'
import { registrableDomain } from './domains.js'

const PROGRESS = ['discovered', 'evaluation_failed', 'rejected', 'paid_skipped', 'qualifying', 'qualified', 'listing_drafted', 'approval_required',
  'approved', 'registering', 'registration_failed', 'registered', 'email_verification_pending', 'ready_for_submission', 'submitting',
  'submission_failed', 'needs_you', 'blocked', 'rejected_by_platform', 'submitted', 'pending_platform_review', 'published', 'no_backlink',
  'backlink_lost', 'live_backlink']

/** Pure: does the platform's own registrable domain carry its name ("Software Advice" → softwareadvice.com)? */
const ownDomain = p => { const slug = String(p.name || '').toLowerCase().replace(/[^a-z0-9]/g, ''); return Boolean(slug) && registrableDomain(p.domain || '').replace(/[^a-z0-9]/g, '').startsWith(slug) }

/** Pure: which of two platforms to keep — the one further along; on a tie the one on its own domain, then the older one. */
export function pickKeeper(a, b) {
  const ra = PROGRESS.indexOf(a.status), rb = PROGRESS.indexOf(b.status)
  if (ra !== rb) return ra > rb ? [a, b] : [b, a]
  if (ownDomain(a) !== ownDomain(b)) return ownDomain(a) ? [a, b] : [b, a]
  return a.id < b.id ? [a, b] : [b, a]
}

export function mergePlatforms(db, keepId, dupId, { reason = 'duplicate', activity = null } = {}) {
  const keep = db.prepare('SELECT * FROM platforms WHERE id = ?').get(keepId)
  const dup = db.prepare('SELECT * FROM platforms WHERE id = ?').get(dupId)
  if (!keep || !dup || keepId === dupId) return null
  const moved = []
  db.transaction(() => {
    for (const t of ['platform_scores', 'platform_transitions', 'activity_logs', 'emails_used', 'screenshots']) {
      const r = db.prepare(`UPDATE OR IGNORE ${t} SET platform_id = ? WHERE platform_id = ?`).run(keepId, dupId)
      if (r.changes) moved.push(`${r.changes} ${t.replace(/_/g, ' ')}`)
    }
    db.prepare(`DELETE FROM emails_used WHERE platform_id = ?`).run(dupId) // the same message seen on both: kept once
    // Tasks keep their history but stop: a duplicate's work is never resumed.
    db.prepare(`UPDATE automation_tasks SET state = 'cancelled', last_error = COALESCE(last_error, ?), updated_at = ? WHERE platform_id = ? AND state IN ('queued','running','waiting','paused','needs_you','done')`)
      .run(`merged into ${keep.name}`, now(), dupId)
    const tasks = db.prepare(`UPDATE automation_tasks SET platform_id = ? WHERE platform_id = ?`).run(keepId, dupId)
    if (tasks.changes) moved.push(`${tasks.changes} task(s)`)
    db.prepare(`UPDATE human_approvals SET status = CASE WHEN status = 'pending' THEN 'skipped' ELSE status END, note = COALESCE(note, ?) WHERE platform_id = ?`).run(`merged into ${keep.name}`, dupId)
    db.prepare(`UPDATE human_approvals SET platform_id = ? WHERE platform_id = ?`).run(keepId, dupId)
    // Account and listing: moved if the kept platform has none; otherwise the duplicate's are recorded and removed.
    const dropped = {}
    for (const [t, child] of [['accounts', 'credentials'], ['submissions', 'backlinks']]) {
      const mine = db.prepare(`SELECT id FROM ${t} WHERE platform_id = ?`).get(keepId)
      const theirs = db.prepare(`SELECT * FROM ${t} WHERE platform_id = ?`).get(dupId)
      if (!theirs) continue
      if (!mine) { db.prepare(`UPDATE ${t} SET platform_id = ? WHERE id = ?`).run(keepId, theirs.id); moved.push(t === 'accounts' ? 'the account' : 'the listing') }
      else {
        dropped[t] = { ...theirs, secret_enc: undefined }
        if (t === 'accounts') { db.prepare(`UPDATE submissions SET account_id = NULL WHERE account_id = ?`).run(theirs.id); db.prepare(`DELETE FROM email_verifications WHERE account_id = ?`).run(theirs.id) }
        db.prepare(`DELETE FROM ${child} WHERE ${t === 'accounts' ? 'account_id' : 'submission_id'} = ?`).run(theirs.id)
        db.prepare(`DELETE FROM ${t} WHERE id = ?`).run(theirs.id)
      }
    }
    db.prepare(`UPDATE email_verifications SET platform_id = ? WHERE platform_id = ?`).run(keepId, dupId)
    db.prepare(`DELETE FROM platform_playbooks WHERE platform_id = ?`).run(dupId)
    db.prepare(`INSERT INTO platform_transitions (platform_id, from_status, to_status, reason, actor, meta) VALUES (?, ?, ?, ?, 'migration', ?)`)
      .run(keepId, keep.status, keep.status, `merged duplicate ${dup.name} (${dup.domain}): ${reason}`, JSON.stringify({ merged: { ...dup, needs_you_reason: undefined }, dropped, moved }))
    db.prepare('DELETE FROM platforms WHERE id = ?').run(dupId)
    db.prepare('UPDATE platforms SET version = version + 1, updated_at = ? WHERE id = ?').run(now(), keepId)
  })()
  activity?.info('platforms_merged', `${dup.name} (${dup.domain}) merged into ${keep.name} (${keep.domain}): ${reason}`, { platformId: keepId })
  return { keep: keep.name, dup: dup.name, moved }
}
