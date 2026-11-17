// Finished work is detected without anyone pasting a URL:
//   - after submitting, the platform's site (listing URLs, its own search, a web search) is searched for DocStar —
//     hourly for the first day, then daily. Found: listing_url saved, platform → published, backlink checked.
//   - platforms not finished yet are searched daily too, so a listing a person made by hand is picked up.
//   - the platform's emails (Gmail, read-only) since the submission: "approved" / "live" → published,
//     "rejected" → rejected_by_platform with the reason, "received / under review" → awaiting platform review.
import { now } from '../db/index.js'
import { maskText } from '../security/mask.js'
import { classifyEmail, listingUrlFromEmail } from '../integrations/verificationLinks.js'

const SUBMITTED = ['submitted', 'pending_platform_review']
// Platforms where a person may have finished the work by hand.
const UNFINISHED = ['approved', 'registering', 'registered', 'email_verification_pending', 'ready_for_submission', 'registration_failed', 'submission_failed', 'needs_you', 'blocked', 'approval_required', 'rejected_by_platform']

export function createFollowUp({ db, activity, status, orchestrator, finder, backlinks, gmail = null, alerts = null }) {
  function nextSearch(p) {
    // Hourly for the first 24 searches after a submission, then daily; unfinished platforms daily.
    const hourly = SUBMITTED.includes(p.status) && (p.listing_searches || 0) < 24
    return new Date(Date.now() + (hourly ? 3600_000 : 86400_000)).toISOString()
  }

  /** Record a listing found on the platform: saved, platform published, open tasks ended, backlink checked. */
  async function recordFound(p, url, how) {
    let backlinkId
    db.transaction(() => {
      orchestrator.cancelPlatformTasks(p.id, 'the listing already exists', 'agent')
      let sub = db.prepare('SELECT id FROM submissions WHERE platform_id = ?').get(p.id)
      if (!sub) sub = db.prepare(`INSERT INTO submissions (platform_id, status) VALUES (?, 'approved') RETURNING id`).get(p.id)
      db.prepare(`UPDATE submissions SET listing_url = ?, submitted_at = COALESCE(submitted_at, ?), published_at = COALESCE(published_at, ?), updated_at = ? WHERE id = ?`).run(url, now(), now(), now(), sub.id)
      backlinkId = db.prepare(`INSERT INTO backlinks (submission_id, page_url, status, next_check_at) VALUES (?, ?, 'unverified', ?)
        ON CONFLICT(submission_id) DO UPDATE SET page_url = excluded.page_url, next_check_at = excluded.next_check_at RETURNING id`).get(sub.id, url, now()).id
      status.transition(p.id, 'published', { manual: true, reason: `listing found (${how}): ${url}` })
      db.prepare(`UPDATE platforms SET next_listing_search_at = NULL WHERE id = ?`).run(p.id)
    })()
    activity.success('listing_found', `${p.name}: DocStar's listing found (${how}) — ${url}`, { platformId: p.id })
    await backlinks.check(db.prepare('SELECT * FROM backlinks WHERE id = ?').get(backlinkId)).catch(e => activity.warn('backlink_check_failed', `${p.name}: ${e.message}`, { platformId: p.id }))
    return true
  }

  async function searchListings({ limit = 10, at = Date.now() } = {}) {
    const due = db.prepare(`SELECT p.*, s.listing_url FROM platforms p LEFT JOIN submissions s ON s.platform_id = p.id
      WHERE s.listing_url IS NULL AND (p.status IN (${SUBMITTED.map(() => '?').join(',')}) OR p.status IN (${UNFINISHED.map(() => '?').join(',')}))
        AND (p.next_listing_search_at IS NULL OR p.next_listing_search_at <= ?)
        AND NOT EXISTS (SELECT 1 FROM automation_tasks t WHERE t.platform_id = p.id AND t.state = 'running')
      ORDER BY CASE WHEN p.status IN (${SUBMITTED.map(() => '?').join(',')}) THEN 0 ELSE 1 END, p.next_listing_search_at LIMIT ?`)
      .all(...SUBMITTED, ...UNFINISHED, new Date(at).toISOString(), ...SUBMITTED, limit)
    let found = 0
    for (const p of due) {
      db.prepare(`UPDATE platforms SET listing_searches = listing_searches + 1, next_listing_search_at = ? WHERE id = ?`).run(nextSearch(p), p.id)
      const hit = await finder.find(p, { useSearch: SUBMITTED.includes(p.status) }).catch(e => { activity.warn('listing_search_failed', `${p.name}: listing search failed (${e.message})`, { platformId: p.id }); return null })
      if (hit && await recordFound(p, hit.url, UNFINISHED.includes(p.status) ? `${hit.how}; done outside the agent` : hit.how)) found++
    }
    return { searched: due.length, found }
  }

  async function readEmails({ limit = 10 } = {}) {
    if (!gmail) return { read: 0 }
    const rows = db.prepare(`SELECT p.id, p.name, p.domain, p.url, p.status, s.submitted_at, s.listing_url FROM platforms p JOIN submissions s ON s.platform_id = p.id
      WHERE p.status IN ('submitted','pending_platform_review','published','no_backlink') AND s.submitted_at IS NOT NULL ORDER BY s.submitted_at DESC LIMIT ?`).all(limit)
    let read = 0
    for (const p of rows) {
      let emails = []
      try { emails = await gmail.searchPlatform({ domain: p.domain, since: p.submitted_at, includeSpam: true }) } catch { continue }
      for (const e of emails.reverse()) {
        if (db.prepare('SELECT 1 FROM emails_used WHERE platform_id = ? AND message_id = ?').get(p.id, e.id)) continue
        const kind = classifyEmail({ subject: e.subject, text: e.body?.plain || e.body?.html?.replace(/<[^>]+>/g, ' ') || '' })
        db.prepare(`INSERT OR IGNORE INTO emails_used (platform_id, message_id, sender, subject, received_at, purpose) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(p.id, e.id, maskText(e.from || ''), maskText(e.subject || '').slice(0, 200), e.receivedAt || null, kind)
        read++
        const cur = db.prepare('SELECT status FROM platforms WHERE id = ?').get(p.id).status
        if ((kind === 'approved' || kind === 'live') && SUBMITTED.includes(cur)) {
          const url = listingUrlFromEmail(e.body, p.domain)
          if (url) await recordFound(p, url, `"${maskText(e.subject)}" email`)
          else status.transition(p.id, 'published', { actor: 'platform', reason: `email "${maskText(e.subject)}"` })
        } else if (kind === 'rejected' && ['submitted', 'pending_platform_review', 'published'].includes(cur)) {
          db.prepare(`UPDATE submissions SET status = 'rejected', rejection_reason = ? WHERE platform_id = ?`).run(maskText(e.subject).slice(0, 300), p.id)
          status.transition(p.id, 'rejected_by_platform', { actor: 'platform', statusReason: 'platform', reason: `email "${maskText(e.subject)}"` })
          alerts?.send(`rejected:${p.id}`, `${p.name} rejected the listing`, `Email: "${maskText(e.subject)}"`, { level: 'warn', link: alerts.link('failed') })
        } else if (kind === 'received' && cur === 'submitted') {
          status.transition(p.id, 'pending_platform_review', { actor: 'platform', reason: `email "${maskText(e.subject)}"` })
        }
      }
    }
    return { read }
  }

  return { searchListings, readEmails, recordFound }
}
