// Keeps statuses true without anyone watching:
//   sweeper (every 5 min): running tasks whose worker stopped beating go back to the queue; platforms sitting in an
//     in-progress state with no task for longer than `stale_minutes` are re-queued, or failed with a reason when
//     their retries are used up; platforms waiting for a task get one.
//   reconcile (hourly and on start): recomputes every platform's status from its tasks, account, submission and
//     backlink checks, fixes mismatches and logs each fix as status_reconciled (before → after). A fix means some
//     code path wrote a wrong status, so each one also raises an alert.
//   invariants: the checks the tests and start-up run (contradictions, stale states, needs-you agreement).
import { now, numSetting } from '../db/index.js'
import { FAILED, IN_PROGRESS, PAUSED, SUCCESS, canTransition, effectiveStatus, findContradictions, label, substatusFixes } from './stateMachine.js'
import { JOINED, parseNeedsYou } from './status.js'

const SWEEP_MS = 5 * 60_000
const RECONCILE_MS = 60 * 60_000
const HEARTBEAT_STALE_MS = 150_000 // five missed 30-second beats

// Which task type owns each in-progress state, and the state a platform ends in when that work cannot continue.
export const STAGE_OWNER = {
  qualifying: { type: 'qualify', failed: 'evaluation_failed' },
  registering: { type: 'submit', failed: 'registration_failed' },
  registered: { type: 'submit', failed: 'submission_failed' },
  email_verification_pending: { type: 'submit', failed: 'registration_failed' },
  ready_for_submission: { type: 'submit', failed: 'submission_failed' },
  submitting: { type: 'submit', failed: 'submission_failed' }
}

const ACTIVE_TASK = `SELECT * FROM automation_tasks WHERE platform_id = ? AND state IN ('queued','running','waiting','paused','needs_you') ORDER BY id DESC LIMIT 1`

/** Pure-ish: the evidence about one platform (no network). */
export function gatherEvidence(db, platformId) {
  const row = db.prepare(`${JOINED} WHERE p.id = ?`).get(platformId)
  if (!row) return null
  const extra = db.prepare(`SELECT s.listing_url, s.submitted_at, b.is_dofollow, b.indexable FROM platforms p LEFT JOIN submissions s ON s.platform_id = p.id
    LEFT JOIN backlinks b ON b.submission_id = s.id WHERE p.id = ?`).get(platformId)
  return {
    ...row, ...extra,
    activeTask: db.prepare(ACTIVE_TASK).get(platformId) ?? null,
    pendingApproval: Boolean(db.prepare(`SELECT 1 FROM human_approvals WHERE platform_id = ? AND status = 'pending'`).get(platformId))
  }
}

/** The stage of the sign-up / submission flow the account and submission show. */
export function flowStage(ev) {
  if (ev.account_status === 'email_verification_pending') return 'email_verification_pending'
  if (ev.account_status === 'active' || ev.signup_completed_at) return 'ready_for_submission'
  if (ev.account_status === 'pending') return 'registering'
  return 'approved'
}

/**
 * Pure: the status the evidence supports, or null when the current one is fine. Returns { status, resume, reason }.
 * `nofollowLive`: a nofollow-only link counts as a live backlink (setting nofollow_counts_as_live).
 */
export function computeStatus(ev, { nofollowLive = true } = {}) {
  const cur = ev.status
  const eff = effectiveStatus(ev)
  // 1. Independent backlink checks win: they read the live page.
  if (ev.backlink_status === 'live') {
    const counts = nofollowLive || ev.is_dofollow === 1
    const want = counts ? 'live_backlink' : 'no_backlink'
    if (cur !== want) return { status: want, reason: counts ? 'a backlink check found the link live' : 'the link is nofollow only' }
    return null
  }
  // A page that could not be read is no evidence of absence, unless the link was seen there before.
  const absent = ev.listing_url && (ev.backlink_status === 'missing' || (ev.backlink_status === 'error' && ev.first_seen_at))
  if (absent) {
    const want = ev.first_seen_at ? 'backlink_lost' : 'no_backlink'
    if (cur === want) return null
    return { status: want, reason: ev.first_seen_at ? 'the link seen before is gone' : 'the listing page has no link to docstar.io' }
  }
  // 2. The submission record: work on the platform itself, whoever did it.
  const bySubmission = { published: 'published', pending_approval: 'pending_platform_review', submitted: 'submitted', rejected: 'rejected_by_platform' }[ev.submission_status]
  if (bySubmission) {
    const rank = s => ['submitted', 'pending_platform_review', 'published', 'no_backlink', 'live_backlink', 'backlink_lost'].indexOf(s)
    if (cur === 'needs_you' && SUCCESS.has(eff)) return null
    if (SUCCESS.has(cur) && rank(cur) >= rank(bySubmission) && bySubmission !== 'rejected_by_platform') return null
    if (cur === bySubmission) return null
    return { status: bySubmission, reason: `the submission is ${label(ev.submission_status).toLowerCase()}` }
  }
  // 3. A task waiting for a person: the platform shows it.
  if (ev.activeTask?.state === 'needs_you' && cur !== 'needs_you') {
    return { status: 'needs_you', resume: eff, needsYou: { what: ev.activeTask.last_error || 'The agent stopped and needs you', todo: 'See the reason, do the step, then press Resume.' }, reason: 'a task is waiting for you' }
  }
  // 4. Operator decisions stay; their sub-statuses are fixed separately.
  if (['rejected', 'paid_skipped'].includes(cur)) return null
  // 5. needs_you / blocked: the state to resume to must match the account and submission.
  if (PAUSED.has(cur)) {
    if (ev.submission_status === 'approved') {
      const stage = flowStage(ev)
      if (ev.resume_status !== stage && !['submitting', 'registered'].includes(ev.resume_status)) return { status: cur, resume: stage, reason: `resume step corrected to ${label(stage).toLowerCase()}` }
    }
    if (!ev.resume_status) return { status: cur, resume: ev.submission_status === 'approved' ? flowStage(ev) : 'discovered', reason: 'resume step was missing' }
    return null
  }
  // 6. Approvals: a pending approval means the platform waits for one; an approved listing means it moved on.
  if (ev.pendingApproval && ['qualified', 'listing_drafted'].includes(cur)) return { status: 'approval_required', reason: 'an approval is waiting' }
  if (ev.submission_status === 'approved' && ['qualified', 'listing_drafted', 'approval_required'].includes(cur) && !ev.pendingApproval) return { status: 'approved', reason: 'the listing is approved' }
  if (ev.submission_status === 'approval_required' && ['qualified', 'listing_drafted'].includes(cur)) return { status: 'approval_required', reason: 'the listing waits for approval' }
  // 7. The registration flow: the account says how far it got.
  if (ev.submission_status === 'approved' && ['registering', 'registered', 'email_verification_pending', 'ready_for_submission'].includes(cur) && !ev.activeTask) {
    const stage = flowStage(ev)
    if (stage !== cur && stage !== 'approved' && canTransition(cur, stage)) return { status: stage, reason: `the account is ${label(ev.account_status || 'none').toLowerCase()}` }
  }
  return null
}

export function createMaintenance({ db, activity, status, orchestrator, alerts = null, hooks = {} }) {
  let sweepTimer = null
  let reconcileTimer = null
  const staleMs = () => numSetting(db, 'stale_minutes', 30) * 60_000
  const maxAttempts = type => numSetting(db, `max_attempts_${type}`, numSetting(db, 'max_attempts', 5))

  /** Returns what it did, for the log and the tests. */
  function sweep({ at = Date.now() } = {}) {
    const done = { requeuedTasks: 0, requeuedPlatforms: 0, failedPlatforms: 0, fedQueue: 0 }
    // 1. Running tasks whose worker heartbeat is gone.
    const mine = new Set(orchestrator.running?.() || [])
    const dead = db.prepare(`SELECT id, type, platform_id FROM automation_tasks WHERE state = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < ?)`)
      .all(new Date(at - HEARTBEAT_STALE_MS).toISOString()).filter(t => !mine.has(t.id))
    for (const t of dead) {
      db.prepare(`UPDATE automation_tasks SET state = 'queued', locked_by = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND state = 'running'`).run(now(), t.id)
      activity.warn('task_requeued', `Task ${t.type} had no worker heartbeat for over 2 minutes: returned to the queue at its last step`, { platformId: t.platform_id, taskId: t.id })
      done.requeuedTasks++
    }
    // 2. Platforms in an in-progress state, no active task, untouched for longer than the limit.
    const cutoff = new Date(at - staleMs()).toISOString()
    const stale = db.prepare(`SELECT p.id, p.name, p.status, p.status_changed_at, p.updated_at FROM platforms p
      WHERE p.status IN (${[...IN_PROGRESS].map(() => '?').join(',')}) AND COALESCE(p.status_changed_at, p.updated_at) < ? AND p.updated_at < ?
        AND NOT EXISTS (SELECT 1 FROM automation_tasks t WHERE t.platform_id = p.id AND t.state IN ('queued','running','waiting','paused','needs_you'))`)
      .all(...IN_PROGRESS, cutoff, cutoff)
    for (const p of stale) {
      const owner = STAGE_OWNER[p.status]
      const last = db.prepare(`SELECT * FROM automation_tasks WHERE platform_id = ? AND type = ? ORDER BY id DESC LIMIT 1`).get(p.id, owner.type)
      const used = db.prepare(`SELECT COUNT(*) n FROM automation_tasks WHERE platform_id = ? AND type = ? AND state IN ('failed','cancelled')`).get(p.id, owner.type).n
      const since = (p.status_changed_at || p.updated_at).slice(0, 16).replace('T', ' ')
      const permanent = last?.state === 'failed' && /same point|terms|policy|payment/i.test(last.last_error || '')
      if (!permanent && used < maxAttempts(owner.type)) {
        db.transaction(() => {
          const r = orchestrator.enqueue(p.id, owner.type)
          if (!r.created && r.task.state === 'done') {
            // The work was recorded as done yet the platform never moved on: re-run it.
            db.prepare(`UPDATE automation_tasks SET state = 'cancelled', updated_at = ? WHERE id = ?`).run(now(), r.task.id)
            orchestrator.enqueue(p.id, owner.type)
          }
          activity.warn('stale_requeued', `${p.name}: ${label(p.status)} since ${since} UTC with no task running; queued again (retry ${used + 1} of ${maxAttempts(owner.type)})`, { platformId: p.id })
        })()
        done.requeuedPlatforms++
      } else {
        const why = `Stuck in "${label(p.status)}" since ${since} UTC with no task running, and its ${used} attempt(s) are used up${last?.last_error ? `. Last error: ${last.last_error}` : ''}`
        status.transition(p.id, owner.failed, { actor: 'sweeper', reason: why, statusReason: 'not_possible' })
        done.failedPlatforms++
      }
    }
    // 3. Platforms waiting for a task get one (the idle hook knows which).
    if (hooks.feedQueue) done.fedQueue = hooks.feedQueue() || 0
    if (done.requeuedTasks || done.requeuedPlatforms || done.failedPlatforms) activity.info('sweep', `Stale-state sweep: ${done.requeuedTasks} task(s) and ${done.requeuedPlatforms} platform(s) re-queued, ${done.failedPlatforms} marked failed`)
    return done
  }

  /** Recompute statuses from evidence. `dryRun` reports without writing. */
  function reconcile({ dryRun = false, actor = 'reconcile', alert = true } = {}) {
    const fixes = []
    const nofollowLive = numSetting(db, 'nofollow_counts_as_live', 1) === 1
    for (const { id } of db.prepare('SELECT id FROM platforms ORDER BY id').all()) {
      const ev = gatherEvidence(db, id)
      const want = computeStatus(ev, { nofollowLive })
      if (want && (want.status !== ev.status || (want.resume && want.resume !== ev.resume_status))) {
        fixes.push({ id, name: ev.name, before: label(ev.status) + (ev.resume_status ? ` (resumes at ${label(ev.resume_status)})` : ''), after: label(want.status) + (want.resume ? ` (resumes at ${label(want.resume)})` : ''), from: ev.status, to: want.status, reason: want.reason })
        if (!dryRun) {
          db.transaction(() => {
            status.transition(id, want.status, { actor, force: true, reason: want.reason, resumeTo: want.resume, needsYou: want.needsYou ?? (want.status === 'needs_you' ? parseNeedsYou(ev.needs_you_reason) || { what: want.reason } : null) })
            activity.warn('status_reconciled', `${ev.name}: ${label(ev.status)}${ev.resume_status ? ` (resumes at ${label(ev.resume_status)})` : ''} → ${label(want.status)}${want.resume ? ` (resumes at ${label(want.resume)})` : ''} — ${want.reason}`,
              { platformId: id, meta: { before: { status: ev.status, resume: ev.resume_status }, after: { status: want.status, resume: want.resume ?? null }, reason: want.reason } })
          })()
        }
      }
      // Sub-statuses that contradict the (possibly new) main status.
      const after = gatherEvidence(db, id)
      const problems = findContradictions(dryRun && want ? { ...after, status: want.status, resume_status: want.resume ?? after.resume_status } : after)
      if (problems.length) {
        const sf = substatusFixes(effectiveStatus(dryRun && want ? { ...after, status: want.status, resume_status: want.resume ?? after.resume_status } : after), after)
        if (Object.keys(sf).length) {
          fixes.push({ id, name: ev.name, before: problems.join('; '), after: Object.entries(sf).map(([k, v]) => `${k} → ${label(v)}`).join(', '), reason: 'sub-status contradicted the main status' })
          if (!dryRun) {
            db.transaction(() => {
              if (sf.submission && after.submission_id) db.prepare(`UPDATE submissions SET status = ?, updated_at = ? WHERE id = ?`).run(sf.submission, now(), after.submission_id)
              if (sf.account && after.account_id) db.prepare(`UPDATE accounts SET status = ?, updated_at = ? WHERE id = ?`).run(sf.account, now(), after.account_id)
              if (sf.backlink && after.backlink_id) db.prepare(`UPDATE backlinks SET status = ? WHERE id = ?`).run(sf.backlink, after.backlink_id)
              db.prepare(`UPDATE platforms SET version = version + 1, updated_at = ? WHERE id = ?`).run(now(), id)
              activity.warn('status_reconciled', `${ev.name}: ${problems.join('; ')} — fixed (${Object.entries(sf).map(([k, v]) => `${k} → ${label(v)}`).join(', ')})`, { platformId: id, meta: { before: problems, after: sf } })
            })()
          }
        }
      }
    }
    // Tasks waiting for a person whose platform does not say so were handled above; tasks for platforms that are done are cancelled.
    if (!dryRun) {
      for (const t of db.prepare(`SELECT t.id, t.type, t.platform_id, p.status, p.name FROM automation_tasks t JOIN platforms p ON p.id = t.platform_id
          WHERE t.state IN ('queued','waiting','needs_you') AND t.type = 'submit' AND p.status IN ('submitted','pending_platform_review','published','live_backlink','no_backlink','backlink_lost','rejected','paid_skipped','rejected_by_platform')`).all()) {
        db.prepare(`UPDATE automation_tasks SET state = 'cancelled', last_error = ?, finished_at = ?, updated_at = ? WHERE id = ?`).run(`not needed: platform is ${label(t.status).toLowerCase()}`, now(), now(), t.id)
        fixes.push({ id: t.platform_id, name: t.name, before: `task ${t.id} (${t.type}) still queued`, after: 'task cancelled', reason: `platform is already ${label(t.status).toLowerCase()}` })
        activity.warn('status_reconciled', `${t.name}: task ${t.type} cancelled — platform is already ${label(t.status).toLowerCase()}`, { platformId: t.platform_id, taskId: t.id })
      }
    }
    if (!dryRun && fixes.length && alert && alerts) {
      alerts.send(`reconcile:${new Date().toISOString().slice(0, 13)}`, `Status reconciliation fixed ${fixes.length} record(s)`,
        `Each fix means a status was written wrongly somewhere:\n${fixes.slice(0, 20).map(f => `• ${f.name}: ${f.before} → ${f.after} (${f.reason})`).join('\n')}`, { level: 'warn' })
    }
    if (!dryRun) activity.info('reconcile_run', `Reconciliation: ${fixes.length} fix(es)`)
    return fixes
  }

  return {
    sweep,
    reconcile,
    invariants: () => checkInvariants(db, { staleMs: staleMs() }),
    start() {
      try { reconcile() } catch (e) { activity.error('reconcile_failed', `Reconciliation failed: ${e.message}`) }
      const problems = checkInvariants(db, { staleMs: staleMs() })
      if (problems.length) activity.error('invariants_failed', `Start-up check: ${problems.length} problem(s): ${problems.slice(0, 5).map(p => p.message).join(' | ')}`)
      sweepTimer = setInterval(() => { try { sweep() } catch (e) { activity.error('sweep_failed', `Sweep failed: ${e.message}`) } }, SWEEP_MS)
      reconcileTimer = setInterval(() => { try { reconcile() } catch (e) { activity.error('reconcile_failed', `Reconciliation failed: ${e.message}`) } }, RECONCILE_MS)
      sweepTimer.unref?.(); reconcileTimer.unref?.()
    },
    shutdown() { clearInterval(sweepTimer); clearInterval(reconcileTimer) }
  }
}

/** The done criteria the database must always meet. Empty array = all good. */
export function checkInvariants(db, { staleMs = 30 * 60_000, at = Date.now() } = {}) {
  const out = []
  for (const r of db.prepare(JOINED).all()) {
    for (const problem of findContradictions(r)) out.push({ kind: 'contradiction', platformId: r.id, message: `${r.name}: ${problem}` })
  }
  const cutoff = new Date(at - staleMs).toISOString()
  for (const r of db.prepare(`SELECT p.id, p.name, p.status FROM platforms p WHERE p.status IN (${[...IN_PROGRESS].map(() => '?').join(',')})
      AND COALESCE(p.status_changed_at, p.updated_at) < ? AND p.updated_at < ?
      AND NOT EXISTS (SELECT 1 FROM automation_tasks t WHERE t.platform_id = p.id AND t.state IN ('queued','running','waiting','paused','needs_you'))`).all(...IN_PROGRESS, cutoff, cutoff)) {
    out.push({ kind: 'stale', platformId: r.id, message: `${r.name}: ${label(r.status)} with no task for longer than the sweeper limit` })
  }
  for (const r of db.prepare(`SELECT t.id, p.id pid, p.name, p.status FROM automation_tasks t JOIN platforms p ON p.id = t.platform_id WHERE t.state = 'needs_you' AND p.status <> 'needs_you'`).all()) {
    out.push({ kind: 'needs_you_mismatch', platformId: r.pid, message: `${r.name}: task ${r.id} needs you but the platform is ${label(r.status)}` })
  }
  for (const r of db.prepare(`SELECT p.id, p.name FROM platforms p WHERE p.status IN (${[...FAILED].map(() => '?').join(',')}) AND EXISTS
      (SELECT 1 FROM automation_tasks t WHERE t.platform_id = p.id AND t.state = 'running')`).all(...FAILED)) {
    out.push({ kind: 'failed_but_running', platformId: r.id, message: `${r.name}: failed while a task runs` })
  }
  return out
}
