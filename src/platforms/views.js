// One source of truth for every list the dashboard shows and every count on the overview: each card's number is the
// length of the list it opens, computed by the same function, so the two can never disagree.
import { numSetting } from '../db/index.js'
import { FAILED, IN_PROGRESS, label } from '../engine/stateMachine.js'
import { parseNeedsYou } from '../engine/status.js'

const PIPELINE = ['approved', 'registering', 'registered', 'email_verification_pending', 'ready_for_submission', 'submitting']
const inList = arr => arr.map(() => '?').join(',')

export function createViews({ db }) {
  /** Platforms waiting for a person: CAPTCHAs, sign-ins, missing facts, retries used up. */
  function needsYou() {
    return db.prepare(`SELECT p.id platform_id, p.name, p.domain, p.url, p.status, p.resume_status, p.needs_you_reason, p.status_changed_at,
        (SELECT t.id FROM automation_tasks t WHERE t.platform_id = p.id AND t.state IN ('needs_you','waiting') ORDER BY t.id DESC LIMIT 1) task_id,
        (SELECT t.type FROM automation_tasks t WHERE t.platform_id = p.id ORDER BY t.id DESC LIMIT 1) task_type,
        (SELECT t.error_history FROM automation_tasks t WHERE t.platform_id = p.id ORDER BY t.id DESC LIMIT 1) error_history
      FROM platforms p WHERE p.status = 'needs_you' ORDER BY p.status_changed_at DESC`).all()
      .map(r => {
        const ny = parseNeedsYou(r.needs_you_reason) || {}
        return { ...r, reason: ny.what || 'The agent stopped here', todo: ny.todo || 'Open the platform, finish the step, then press Resume.', where: ny.where || r.url,
          resumesAt: r.resume_status ? label(r.resume_status) : null, error_history: safeJson(r.error_history, []) }
      })
  }

  /** Platforms in a failed state, each with its latest failed task, plus failed platform-less tasks (discovery). */
  function failed() {
    const platforms = db.prepare(`SELECT p.id platform_id, p.name, p.domain, p.status, p.status_reason, p.status_changed_at,
        t.id task_id, t.type task_type, t.step, t.attempts, t.last_error, t.error_history, t.updated_at task_updated_at,
        (SELECT reason FROM platform_transitions x WHERE x.platform_id = p.id AND x.to_status = p.status ORDER BY x.id DESC LIMIT 1) transition_reason
      FROM platforms p
      LEFT JOIN automation_tasks t ON t.id = (SELECT id FROM automation_tasks WHERE platform_id = p.id AND state IN ('failed','needs_you','cancelled') ORDER BY id DESC LIMIT 1)
      WHERE p.status IN (${inList([...FAILED])}) ORDER BY p.status_changed_at DESC`).all(...FAILED)
      .map(r => ({ kind: 'platform', ...r, error: r.last_error || r.transition_reason || 'No error recorded', at: r.status_changed_at, error_history: safeJson(r.error_history, []) }))
    // A failed task with no platform counts until a later run of the same type succeeded.
    const tasks = db.prepare(`SELECT t.id task_id, t.type task_type, t.step, t.attempts, t.last_error, t.error_history, t.updated_at
      FROM automation_tasks t WHERE t.platform_id IS NULL AND t.state = 'failed'
        AND NOT EXISTS (SELECT 1 FROM automation_tasks d WHERE d.platform_id IS NULL AND d.type = t.type AND d.state = 'done' AND d.id > t.id)
      ORDER BY t.updated_at DESC`).all()
      .map(r => ({ kind: 'task', ...r, name: `${label(r.task_type)} run`, error: r.last_error, at: r.updated_at, error_history: safeJson(r.error_history, []) }))
    return [...platforms, ...tasks]
  }

  /** Approved listings that have not finished submission, with the step each one is at. */
  function approvedPipeline() {
    return db.prepare(`SELECT p.id platform_id, p.name, p.domain, p.status, p.status_changed_at, s.approved_at, s.auto_approved,
        (SELECT state FROM automation_tasks t WHERE t.platform_id = p.id AND t.type = 'submit' ORDER BY t.id DESC LIMIT 1) task_state,
        (SELECT run_after FROM automation_tasks t WHERE t.platform_id = p.id AND t.type = 'submit' AND t.state = 'queued' ORDER BY t.id DESC LIMIT 1) run_after
      FROM platforms p JOIN submissions s ON s.platform_id = p.id
      WHERE p.status IN (${inList(PIPELINE)}) ORDER BY s.approved_at`).all(...PIPELINE)
      .map(r => ({ ...r, step: label(r.status) }))
  }

  /** Completed work, in three groups. */
  function successfullyAdded() {
    const rows = db.prepare(`SELECT p.id platform_id, p.name, p.domain, p.status, p.status_changed_at,
        s.listing_url, s.submitted_at, s.published_at, s.manual, s.notes,
        b.page_url backlink_page, b.target_url backlink_target, b.rel, b.is_dofollow, b.anchor_text, b.http_status, b.indexable,
        b.first_seen_at, b.last_checked_at, b.link_count, b.status backlink_status,
        a.email account_email, a.login_method
      FROM platforms p
      LEFT JOIN submissions s ON s.platform_id = p.id
      LEFT JOIN backlinks b ON b.submission_id = s.id
      LEFT JOIN accounts a ON a.platform_id = p.id
      WHERE p.status IN ('live_backlink','published','no_backlink','submitted','pending_platform_review')
      ORDER BY COALESCE(b.first_seen_at, s.published_at, s.submitted_at, p.status_changed_at) DESC`).all()
    const nowMs = Date.now()
    const live = rows.filter(r => r.status === 'live_backlink')
    const published = rows.filter(r => r.status === 'published' || r.status === 'no_backlink').map(r => ({
      ...r,
      found: r.backlink_status === 'missing' ? (r.http_status ? `Page answers HTTP ${r.http_status}; no link to docstar.io on it` : 'No link to docstar.io found')
        : r.is_dofollow === 0 ? `Link present but ${r.rel || 'nofollow'}` : r.indexable === 0 ? 'Link present but the page is noindex' : r.last_checked_at ? 'Checked; not live yet' : 'Not checked yet'
    }))
    const awaiting = rows.filter(r => r.status === 'submitted' || r.status === 'pending_platform_review').map(r => ({
      ...r, waitingDays: r.submitted_at ? Math.floor((nowMs - Date.parse(r.submitted_at)) / 86400_000) : null
    }))
    return { live, published, awaiting, total: live.length + published.length + awaiting.length }
  }

  function overview() {
    const one = (sql, ...a) => db.prepare(sql).get(...a).n
    const byStatus = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM platforms GROUP BY status').all().map(r => [r.status, r.n]))
    const added = successfullyAdded()
    const ny = needsYou()
    const fl = failed()
    const pipeline = approvedPipeline()
    const nofollowLive = numSetting(db, 'nofollow_counts_as_live', 1) === 1
    return {
      discovered: one(`SELECT COUNT(*) n FROM platforms`),
      qualified: one(`SELECT COUNT(*) n FROM platforms WHERE status NOT IN ('discovered','qualifying','rejected','paid_skipped','evaluation_failed')`),
      freeSelected: one(`SELECT COUNT(*) n FROM platforms WHERE pricing IN ('free','freemium') AND status NOT IN ('discovered','qualifying','rejected','paid_skipped','evaluation_failed')`),
      paidSkipped: byStatus.paid_skipped || 0,
      rejected: byStatus.rejected || 0,
      // Accounts that actually finished sign-up, by method.
      registered: one(`SELECT COUNT(*) n FROM accounts WHERE signup_completed_at IS NOT NULL`),
      registeredBy: Object.fromEntries(db.prepare(`SELECT login_method m, COUNT(*) n FROM accounts WHERE signup_completed_at IS NOT NULL GROUP BY 1`).all().map(r => [r.m, r.n])),
      signupsStarted: one(`SELECT COUNT(*) n FROM accounts`),
      verificationPending: byStatus.email_verification_pending || 0,
      inProgress: one(`SELECT COUNT(*) n FROM platforms WHERE status IN (${inList([...IN_PROGRESS])})`, ...IN_PROGRESS),
      awaitingYou: byStatus.approval_required || 0,
      approvedWaiting: pipeline.length,
      submitted: added.total,
      pendingPlatformApproval: added.awaiting.length,
      successfullyAdded: added.total,
      liveBacklinks: added.live.length,
      publishedNoLink: added.published.length,
      dofollow: added.live.filter(r => r.is_dofollow === 1).length,
      nofollow: added.live.filter(r => r.is_dofollow === 0).length,
      nofollowCountsAsLive: nofollowLive,
      lost: byStatus.backlink_lost || 0,
      failed: fl.length,
      needsYou: ny.length,
      byStatus,
      byCategory: db.prepare(`SELECT COALESCE(c.name, 'Uncategorised') name, COUNT(*) n FROM platforms p
        LEFT JOIN platform_categories c ON c.id = p.category_id GROUP BY 1 ORDER BY n DESC`).all()
    }
  }

  return { needsYou, failed, approvedPipeline, successfullyAdded, overview }
}

function safeJson(v, fallback) { try { return v ? JSON.parse(v) : fallback } catch { return fallback } }
