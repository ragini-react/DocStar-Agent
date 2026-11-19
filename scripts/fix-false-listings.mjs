// One-time repair (19 Nov 2026): platforms recorded as published on a page that is not a public listing (a dashboard,
// a submission form, a "submitted" tracker) go back to "awaiting platform review"; listing URLs lose trailing
// punctuation. Uses the app's status writer, so every change is in the platform timeline and the activity log.
// Usage: node scripts/fix-false-listings.mjs [--db data/docstar.db] [--dry-run]
import { openDb, now } from '../src/db/index.js'
import { createActivityLog } from '../src/logging/activity.js'
import { createStatus } from '../src/engine/status.js'
import { cleanListingUrl, isPrivateUrl } from '../src/agent/listingUrl.js'

const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null }
const dry = process.argv.includes('--dry-run')
const db = openDb(arg('--db') || 'data/docstar.db', { log: () => {} })
const activity = createActivityLog(db, { quiet: true })
const status = createStatus({ db, activity })

const rows = db.prepare(`SELECT p.id, p.name, p.status, s.id sid, s.listing_url, b.id bid, b.page_url, b.first_seen_at
  FROM platforms p JOIN submissions s ON s.platform_id = p.id LEFT JOIN backlinks b ON b.submission_id = s.id
  WHERE p.status IN ('published','no_backlink','live_backlink','backlink_lost','submitted','pending_platform_review')`).all()
for (const r of rows) {
  const page = r.page_url || r.listing_url
  const listed = ['published', 'no_backlink', 'live_backlink', 'backlink_lost'].includes(r.status)
  if (listed && !r.first_seen_at && page && isPrivateUrl(page)) {
    console.log(`${r.name}: ${r.status} → pending_platform_review (${page} is not a public listing)`)
    if (dry) continue
    db.transaction(() => {
      if (r.bid) db.prepare('DELETE FROM backlinks WHERE id = ?').run(r.bid)
      db.prepare(`UPDATE submissions SET listing_url = NULL, published_at = NULL, status = 'submitted', updated_at = ? WHERE id = ?`).run(now(), r.sid)
      status.transition(r.id, 'pending_platform_review', { actor: 'operator', manual: true, reason: `not listed yet: ${page} is not a public listing page` })
      db.prepare(`UPDATE platforms SET next_listing_search_at = ?, listing_searches = 0 WHERE id = ?`).run(now(), r.id)
    })()
    continue
  }
  for (const [col, table, id] of [['listing_url', 'submissions', r.sid], ['page_url', 'backlinks', r.bid]]) {
    const v = col === 'listing_url' ? r.listing_url : r.page_url
    const c = v && cleanListingUrl(v)
    if (id && c && c !== v) {
      console.log(`${r.name}: ${col} ${v} → ${c}`)
      if (!dry) db.prepare(`UPDATE ${table} SET ${col} = ?${table === 'backlinks' ? ', next_check_at = NULL' : ''} WHERE id = ?`).run(c, id)
    }
  }
}
if (!dry) activity.info('data_repaired', 'Listings recorded on non-public pages moved back to awaiting platform review; listing URLs cleaned')
