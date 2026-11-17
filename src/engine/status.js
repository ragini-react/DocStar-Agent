// The only code that writes platforms.status. Each change is validated against the state machine, written in one
// transaction with the sub-statuses it implies (account, submission, backlink), recorded in platform_transitions
// (the timeline) and logged as an activity event. A change the state machine does not allow is refused and logged.
import { now } from '../db/index.js'
import { canTransition, findContradictions, label, PAUSED, effectiveStatus, substatusFixes, STATUSES, REASONS } from './stateMachine.js'

export class IllegalTransition extends Error {
  constructor(name, from, to) {
    super(`${name}: ${label(from)} → ${label(to)} is not an allowed status change`)
    this.from = from
    this.to = to
    this.status = 409
  }
}

// One query joins a platform with everything its status must agree with.
export const JOINED = `SELECT p.id, p.name, p.status, p.resume_status, p.needs_you_reason, p.status_reason,
    a.id account_id, a.status account_status, a.signup_completed_at,
    s.id submission_id, s.status submission_status,
    b.id backlink_id, b.status backlink_status, b.first_seen_at
  FROM platforms p
  LEFT JOIN accounts a ON a.platform_id = p.id
  LEFT JOIN submissions s ON s.platform_id = p.id
  LEFT JOIN backlinks b ON b.submission_id = s.id`

/** needs_you reasons are stored as JSON {what, todo, where}; older rows hold plain text. */
export function parseNeedsYou(v) {
  if (!v) return null
  try { const o = JSON.parse(v); if (o && typeof o === 'object') return o } catch {}
  return { what: String(v), todo: '', where: null }
}

export function createStatus({ db, activity }) {
  const listeners = new Set()
  const one = id => db.prepare(`${JOINED} WHERE p.id = ?`).get(id)

  /**
   * Move a platform to `to`.
   * @param {number} platformId
   * @param {string} to
   * @param {object} [o]
   * @param {string} [o.reason]        free text for the timeline and activity log
   * @param {string} [o.statusReason]  one of REASONS, for rejected / skipped / failed
   * @param {{what:string,todo:string,where?:string|null,action?:string}} [o.needsYou]  required when to = needs_you
   * @param {string} [o.actor]         agent | operator | reconcile | sweeper | migration | platform
   * @param {number} [o.taskId]
   * @param {boolean} [o.manual]       a person recording finished work
   * @param {boolean} [o.operator]     a person's reject / skip / back-to-discovered
   * @param {boolean} [o.force]        reconcile / migration only: write the computed truth, logged as such
   * @param {string} [o.resumeTo]      override the state needs_you / blocked resumes to
   * @param {object} [o.meta]
   */
  function transition(platformId, to, o = {}) {
    const { reason = null, statusReason = null, needsYou = null, actor = 'agent', taskId = null, manual = false, operator = false, force = false, meta = null } = o
    if (!STATUSES.includes(to)) throw new Error(`unknown status ${to}`)
    if (statusReason && !REASONS.includes(statusReason)) throw new Error(`unknown reason ${statusReason}`)
    let result
    try {
      write()
    } catch (e) {
      // Logged after the rollback, so the refusal itself is kept even though the change is not.
      if (e instanceof IllegalTransition) activity.error('illegal_transition', `Refused status change ${e.message}${reason ? ` (${reason})` : ''}`, { platformId, taskId, meta: { from: e.from, to: e.to, actor } })
      throw e
    }
    function write() { db.transaction(() => {
      const cur = one(platformId)
      if (!cur) throw new Error('No such platform')
      const from = cur.status
      // Resuming a paused platform to the state it was interrupted in is always allowed.
      const resuming = PAUSED.has(from) && to === cur.resume_status
      if (!force && !resuming && !canTransition(from, to, { manual, operator })) {
        throw new IllegalTransition(cur.name, from, to)
      }
      if (to === 'needs_you' && !needsYou?.what) throw new Error('needs_you needs a reason')
      const same = from === to
      // needs_you / blocked remember what they interrupted; leaving them clears it.
      const resume = PAUSED.has(to) ? (o.resumeTo ?? (PAUSED.has(from) ? cur.resume_status : from)) : null
      const ny = to === 'needs_you' ? JSON.stringify({ what: needsYou.what, todo: needsYou.todo || '', where: needsYou.where || null, action: needsYou.action || null, at: now() }) : null
      const keepReason = ['rejected', 'paid_skipped', 'rejected_by_platform', 'evaluation_failed', 'registration_failed', 'submission_failed', 'blocked'].includes(to)
      db.prepare(`UPDATE platforms SET status = ?, resume_status = ?, needs_you_reason = ?, status_reason = ?,
          status_changed_at = CASE WHEN status = ? THEN status_changed_at ELSE ? END, version = version + 1, updated_at = ? WHERE id = ?`)
        .run(to, resume, ny, keepReason ? (statusReason ?? (same ? cur.status_reason : null)) : null, to, now(), now(), platformId)

      // Sub-statuses follow the main status, so contradictory combinations cannot exist.
      const fixes = substatusFixes(PAUSED.has(to) ? resume : to, cur)
      if (fixes.submission && cur.submission_id) db.prepare(`UPDATE submissions SET status = ?, updated_at = ? WHERE id = ?`).run(fixes.submission, now(), cur.submission_id)
      if (fixes.account && cur.account_id) db.prepare(`UPDATE accounts SET status = ?, updated_at = ? WHERE id = ?`).run(fixes.account, now(), cur.account_id)
      if (fixes.backlink && cur.backlink_id) db.prepare(`UPDATE backlinks SET status = ? WHERE id = ?`).run(fixes.backlink, cur.backlink_id)

      if (!same || ny) {
        db.prepare(`INSERT INTO platform_transitions (platform_id, from_status, to_status, reason, actor, task_id, meta) VALUES (?,?,?,?,?,?,?)`)
          .run(platformId, from, to, reason ?? needsYou?.what ?? null, actor, taskId, meta || Object.keys(fixes).length ? JSON.stringify({ ...(meta || {}), fixes }) : null)
        const level = to === 'needs_you' || ['registration_failed', 'submission_failed', 'evaluation_failed', 'backlink_lost'].includes(to) ? 'warn'
          : ['live_backlink', 'published', 'submitted', 'qualified'].includes(to) ? 'success' : 'info'
        const by = { operator: ' (by you)', reconcile: ' (reconciled)', sweeper: ' (stale-state sweeper)', migration: ' (data repair)', platform: ' (by the platform)' }[actor] || ''
        const correlationId = taskId ? db.prepare('SELECT correlation_id FROM automation_tasks WHERE id = ?').get(taskId)?.correlation_id ?? null : null
        activity[level](to === 'needs_you' ? 'needs_you' : 'platform_status',
          `${cur.name}: ${label(from)} → ${label(to)}${by}${reason || needsYou?.what ? ` — ${reason || needsYou.what}` : ''}`,
          { platformId, taskId, correlationId, meta: { from, to, actor, reason: statusReason || undefined } })
      }
      result = { from, to, changed: !same, fixes, name: cur.name }
    })() }
    if (result.changed || to === 'needs_you') for (const fn of listeners) { try { fn({ platformId, ...result, actor, needsYou }) } catch {} }
    return result
  }

  return {
    transition,
    get: id => db.prepare('SELECT id, name, status, resume_status, needs_you_reason, status_reason FROM platforms WHERE id = ?').get(id),
    effective: id => { const r = one(id); return r ? effectiveStatus(r) : null },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn) },

    /** Contradictory status combinations (all platforms, or one). Empty = consistent. */
    contradictions(platformId = null) {
      const rows = platformId ? [one(platformId)].filter(Boolean) : db.prepare(JOINED).all()
      return rows.map(r => ({ id: r.id, name: r.name, status: r.status, problems: findContradictions(r) })).filter(r => r.problems.length)
    },

    timeline(platformId) {
      return db.prepare(`SELECT from_status, to_status, reason, actor, task_id, at FROM platform_transitions WHERE platform_id = ? ORDER BY at, id`).all(platformId)
    }
  }
}
