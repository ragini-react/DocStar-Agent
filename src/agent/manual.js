// Work done by a person, recorded on any platform: "Mark as done manually" and "Set listing URL…". The account email,
// listing URL, backlink page and notes are saved, open tasks for the platform end, the platform moves to the state the
// facts support (published with a listing URL, submitted without one), and a backlink check runs at once.
import { now } from '../db/index.js'
import { cleanListingUrl } from './listingUrl.js'

const httpUrl = (v, field) => {
  if (!v) return null
  let u
  try { u = new URL(String(v).trim()) } catch { throw Object.assign(new Error(`${field} is not a valid URL`), { status: 400 }) }
  if (!/^https?:$/.test(u.protocol)) throw Object.assign(new Error(`${field} must be http(s)`), { status: 400 })
  return u.toString()
}

export function createManual({ db, activity, status, orchestrator, backlinks }) {
  /**
   * @param {number} platformId
   * @param {{ accountEmail?: string, listingUrl?: string, backlinkUrl?: string, notes?: string, loginMethod?: string, submitted?: boolean }} data
   */
  function complete(platformId, data = {}) {
    const p = db.prepare('SELECT id, name, status FROM platforms WHERE id = ?').get(platformId)
    if (!p) throw Object.assign(new Error('No such platform'), { status: 404 })
    const listingUrl = cleanListingUrl(httpUrl(data.listingUrl, 'Listing URL')) || null
    const backlinkUrl = cleanListingUrl(httpUrl(data.backlinkUrl, 'Backlink URL')) || null
    const email = data.accountEmail ? String(data.accountEmail).trim().slice(0, 200) : null
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw Object.assign(new Error('Account email is not valid'), { status: 400 })
    const notes = data.notes ? String(data.notes).slice(0, 2000) : null
    const method = ['google', 'email', 'github'].includes(data.loginMethod) ? data.loginMethod : 'email'
    let backlinkId = null
    db.transaction(() => {
      orchestrator.cancelPlatformTasks(platformId, 'done manually by a person')
      let sub = db.prepare('SELECT id, status FROM submissions WHERE platform_id = ?').get(platformId)
      if (!sub) sub = db.prepare(`INSERT INTO submissions (platform_id, status, manual) VALUES (?, 'approved', 1) RETURNING id, status`).get(platformId)
      db.prepare(`UPDATE submissions SET manual = 1, listing_url = COALESCE(?, listing_url), notes = COALESCE(?, notes),
          submitted_at = COALESCE(submitted_at, ?), published_at = CASE WHEN ? IS NOT NULL THEN COALESCE(published_at, ?) ELSE published_at END, updated_at = ? WHERE id = ?`)
        .run(listingUrl, notes, now(), listingUrl, now(), now(), sub.id)
      if (email) {
        const acc = db.prepare('SELECT id FROM accounts WHERE platform_id = ?').get(platformId)
        if (acc) db.prepare(`UPDATE accounts SET email = ?, status = 'active', signup_completed_at = COALESCE(signup_completed_at, ?), updated_at = ? WHERE id = ?`).run(email, now(), now(), acc.id)
        else db.prepare(`INSERT INTO accounts (platform_id, email, login_method, status, signup_completed_at) VALUES (?, ?, ?, 'active', ?)`).run(platformId, email, method, now())
        db.prepare('UPDATE submissions SET account_id = (SELECT id FROM accounts WHERE platform_id = ?) WHERE id = ?').run(platformId, sub.id)
      }
      const page = backlinkUrl || listingUrl
      if (page) {
        backlinkId = db.prepare(`INSERT INTO backlinks (submission_id, page_url, status, next_check_at, manual_page) VALUES (?, ?, 'unverified', ?, ?)
          ON CONFLICT(submission_id) DO UPDATE SET page_url = excluded.page_url, next_check_at = excluded.next_check_at, manual_page = excluded.manual_page RETURNING id`)
          .get(sub.id, page, now(), backlinkUrl ? 1 : 0).id
      }
      const to = listingUrl || backlinkUrl ? 'published' : 'submitted'
      status.transition(platformId, to, { actor: 'operator', manual: true, reason: `done manually${listingUrl ? `: ${listingUrl}` : ''}${notes ? ` (${notes.slice(0, 80)})` : ''}` })
    })()
    activity.success('manual_completion', `${p.name}: recorded as done manually${listingUrl ? ' with its listing URL' : ''}; ${backlinkId ? 'checking the backlink now' : 'the agent will look for the listing'}`, { platformId })
    // The check moves it on (live / no backlink); it runs in the background so the request returns at once.
    const check = backlinkId ? backlinks.check(db.prepare('SELECT * FROM backlinks WHERE id = ?').get(backlinkId)).catch(e => activity.warn('backlink_check_failed', `${p.name}: ${e.message}`, { platformId })) : null
    if (!backlinkId) db.prepare(`UPDATE platforms SET next_listing_search_at = ? WHERE id = ?`).run(now(), platformId)
    return { ok: true, status: db.prepare('SELECT status FROM platforms WHERE id = ?').get(platformId).status, checking: Boolean(check), check }
  }

  return {
    complete,
    /** Set listing URL on any platform: the same record, only the URL. */
    setListingUrl: (platformId, url) => complete(platformId, { listingUrl: url })
  }
}
