// One-time repair of the records written before the state machine existed. Runs once on the agent's first start with
// schema v2 (and by hand: node scripts/repair.mjs). Every change goes through the status writer or is logged, and the
// report lists each platform and task before and after.
import { now, setSetting, getSetting } from './index.js'
import { label, IN_PROGRESS } from '../engine/stateMachine.js'
import { flowStage, gatherEvidence } from '../engine/maintenance.js'

const AUTH_PATH = /(sign.?up|sign.?in|log.?in|register|auth|oauth|verify|account\/new|join)/i
const host = u => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, '') } catch { return null } }

function snapshot(db) {
  const platforms = Object.fromEntries(db.prepare(`SELECT p.id, p.name, p.domain, p.status, p.resume_status, p.status_reason, a.status account, a.signup_completed_at signup,
      s.status submission, b.status backlink FROM platforms p LEFT JOIN accounts a ON a.platform_id = p.id LEFT JOIN submissions s ON s.platform_id = p.id
      LEFT JOIN backlinks b ON b.submission_id = s.id`).all().map(r => [r.id, r]))
  const tasks = Object.fromEntries(db.prepare(`SELECT t.id, t.type, t.state, t.attempts, t.run_after, t.wait_for, t.last_error, p.name FROM automation_tasks t LEFT JOIN platforms p ON p.id = t.platform_id`).all().map(r => [r.id, r]))
  return { platforms, tasks }
}

/**
 * @param {object} deps  { db, status, activity, orchestrator, maintenance, extraSteps? }
 * extraSteps: [{ name, run(db, ctx) => string[] }] — later parts add their own repairs (domains, scores).
 */
export function repairData({ db, status, activity, orchestrator, maintenance, extraSteps = [] }, { dryRun = false } = {}) {
  const before = snapshot(db)
  const notes = []
  const note = (section, text) => notes.push({ section, text })

  const run = () => {
    // 1. Submit tasks for platforms whose listing is already submitted or decided: not needed (G2's task 48).
    for (const t of db.prepare(`SELECT t.id, t.platform_id, t.state, t.attempts, t.last_error, p.name, p.status FROM automation_tasks t JOIN platforms p ON p.id = t.platform_id
        WHERE t.type = 'submit' AND t.state IN ('queued','paused','waiting','needs_you')
          AND p.status IN ('submitted','pending_platform_review','published','live_backlink','no_backlink','backlink_lost','rejected','paid_skipped')`).all()) {
      db.prepare(`UPDATE automation_tasks SET state = 'cancelled', last_error = ?, finished_at = ?, updated_at = ? WHERE id = ?`).run(`not needed: platform is ${label(t.status).toLowerCase()}`, now(), now(), t.id)
      note('Tasks', `Task ${t.id} (${t.name}, submit, ${t.attempts} attempts, last: "${t.last_error}") cancelled: the platform is already ${label(t.status).toLowerCase()}.`)
    }
    // 2. Tasks deferred for a condition only a person changes ("listing not approved"): wait for the approval event.
    for (const t of db.prepare(`SELECT t.id, t.platform_id, t.last_error, p.name, s.status sub FROM automation_tasks t JOIN platforms p ON p.id = t.platform_id
        LEFT JOIN submissions s ON s.platform_id = p.id WHERE t.state = 'queued' AND t.last_error LIKE '%not approved%'`).all()) {
      if (t.sub === 'approved') {
        db.prepare(`UPDATE automation_tasks SET run_after = NULL, last_error = NULL, updated_at = ? WHERE id = ?`).run(now(), t.id)
        note('Tasks', `Task ${t.id} (${t.name}): deferred for "listing not approved" although it is approved; runs at once.`)
      } else {
        db.prepare(`UPDATE automation_tasks SET state = 'waiting', wait_for = ?, run_after = NULL, updated_at = ? WHERE id = ?`).run(`approval:${t.platform_id}`, now(), t.id)
        note('Tasks', `Task ${t.id} (${t.name}): now waits for the approval instead of being deferred every 30 minutes.`)
      }
    }
    // 3. Deferred tasks without a run_after time: give them one (now), so they run.
    const noTime = db.prepare(`UPDATE automation_tasks SET run_after = ?, updated_at = ? WHERE state = 'queued' AND run_after IS NULL AND last_error LIKE '%deferred%'`).run(now(), now())
    if (noTime.changes) note('Tasks', `${noTime.changes} deferred task(s) had no run-after time; scheduled now.`)

    // 4. Google sign-ups: an account finished sign-up when the task reached a platform page past the sign-in screens.
    for (const a of db.prepare(`SELECT a.id, a.platform_id, a.login_method, a.created_at, p.name, p.domain FROM accounts a JOIN platforms p ON p.id = a.platform_id
        WHERE a.signup_completed_at IS NULL`).all()) {
      const tasks = db.prepare(`SELECT checkpoint, step FROM automation_tasks WHERE platform_id = ? AND type = 'submit' ORDER BY id DESC`).all(a.platform_id)
      const evidence = tasks.map(t => { try { return JSON.parse(t.checkpoint || '{}') } catch { return {} } })
        .find(cp => cp.url && host(cp.url)?.endsWith(a.domain) && !AUTH_PATH.test(new URL(cp.url).pathname) && Number(cp.steps || 0) >= 4)
      if (evidence) {
        db.prepare(`UPDATE accounts SET signup_completed_at = ?, signup_inferred = 1, status = CASE WHEN status = 'pending' THEN 'active' ELSE status END, updated_at = ? WHERE id = ?`).run(a.created_at, now(), a.id)
        note('Accounts', `${a.name}: ${label(a.login_method)} sign-up counted as finished (the agent later worked on ${new URL(evidence.url).pathname} at step ${evidence.steps}; marked "inferred").`)
      } else note('Accounts', `${a.name}: ${label(a.login_method)} sign-up started ${a.created_at.slice(0, 10)} but never confirmed finished; not counted.`)
    }

    // 5. Platforms stopped for a person by a task that then ended "stuck": the Needs-you list shows them, with the
    //    reason, and Resume continues the same task at its saved step.
    for (const p of db.prepare(`SELECT p.id, p.name, p.needs_you_reason FROM platforms p WHERE p.status = 'needs_you'`).all()) {
      const t = db.prepare(`SELECT * FROM automation_tasks WHERE platform_id = ? ORDER BY id DESC LIMIT 1`).get(p.id)
      const ev = gatherEvidence(db, p.id)
      const resume = ev.submission_status === 'approved' ? flowStage(ev) : 'approved'
      const what = cleanReason(t?.last_error || 'The agent stopped and needs you', p.name)
      const todo = /CAPTCHA|human check/i.test(what) ? 'Open the platform in the agent\'s Chrome, complete the human check, then press Resume.'
        : /verification email/i.test(what) ? 'Press Resume: the agent now checks Gmail itself and clicks the link. If it still fails, open the inbox (and spam) for support@docstar.io.'
          : /last name|phone|budget|missing/i.test(what) ? 'The form asks for details the DocStar profile does not have. Fill them in the agent\'s Chrome (or add them to the profile), then press Resume.'
            : 'Finish the step in the agent\'s Chrome, then press Resume.'
      status.transition(p.id, 'needs_you', { actor: 'migration', force: true, resumeTo: resume, needsYou: { what, todo, where: JSON.parse(t?.checkpoint || '{}').url || null }, reason: 'reason and resume step recorded' })
      if (t && ['failed', 'cancelled'].includes(t.state) && !orchestrator.findActive(p.id, t.type)) {
        const cp = JSON.parse(t.checkpoint || '{}'); delete cp._block
        db.prepare(`UPDATE automation_tasks SET state = 'needs_you', checkpoint = ?, last_error = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(cp), what, now(), t.id)
        note('Needs you', `${p.name}: shown on the Needs-you page ("${what.slice(0, 120)}"); Resume continues task ${t.id} at ${t.step || 'its start'} and resumes at ${label(resume)}.`)
      } else note('Needs you', `${p.name}: reason recorded; resumes at ${label(resume)}.`)
    }

    // Later parts' repairs (domains and duplicates, scores and reasons).
    for (const step of extraSteps) for (const line of step.run(db, { status, activity, orchestrator, note: t => note(step.name, t) }) || []) note(step.name, line)

    // 6. Recompute every status from its evidence (contradictions: rejected/skipped with an approved listing, etc.).
    for (const f of maintenance.reconcile({ actor: 'migration', alert: false })) note('Reconciled', `${f.name}: ${f.before} → ${f.after} (${f.reason})`)

    // 7. Platforms stuck in an in-progress state with no task: re-queued (retries left) or failed with a reason.
    const stuck = db.prepare(`SELECT id, name, status FROM platforms WHERE status IN (${[...IN_PROGRESS].map(() => '?').join(',')})`).all(...IN_PROGRESS)
    const swept = maintenance.sweep({ at: Date.now() + 365 * 86400_000 }) // everything older than "now" counts as stale here
    for (const p of stuck) {
      const after = db.prepare('SELECT status FROM platforms WHERE id = ?').get(p.id).status
      const task = db.prepare(`SELECT id, state FROM automation_tasks WHERE platform_id = ? AND state IN ('queued','waiting') ORDER BY id DESC LIMIT 1`).get(p.id)
      note('Stuck platforms', `${p.name}: ${label(p.status)} → ${label(after)}${task ? ` (task ${task.id} ${task.state}; continues from its saved step)` : ''}`)
    }
    note('Summary', `Sweep: ${swept.requeuedPlatforms} re-queued, ${swept.failedPlatforms} marked failed, ${swept.requeuedTasks} orphaned running task(s) returned to the queue.`)
  }

  let after
  if (dryRun) {
    // Run inside a transaction and roll it back: the report shows exactly what would change.
    try { db.transaction(() => { run(); after = snapshot(db); throw new DryRun() })() } catch (e) { if (!(e instanceof DryRun)) throw e }
  } else {
    db.transaction(run)()
    setSetting(db, 'repair_v2_done', now())
    after = snapshot(db)
  }
  return { notes, before, after, report: renderReport({ notes, before, after, dryRun }) }
}

class DryRun extends Error {}

/** The stop reason without the platform's name in front or the old "press Resume" instruction behind (the page shows both). */
export function cleanReason(text, name) {
  return String(text)
    .replace(/^Stopped: blocked at the same point \d+ times in a row\.\s*/, '')
    .replace(new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*`), '')
    .replace(/\s*(Complete it there|Do it in Chrome|Do it there),? then press Resume\.?$/i, '')
    .trim()
}

export const repairDone = db => Boolean(getSetting(db, 'repair_v2_done'))

export function renderReport({ notes, before, after, dryRun }) {
  const lines = [`# Data repair report${dryRun ? ' (dry run — nothing written)' : ''}`, '', `Run at ${now()}.`, '']
  const sections = [...new Set(notes.map(n => n.section))]
  for (const s of sections) {
    lines.push(`## ${s}`, '')
    for (const n of notes.filter(x => x.section === s)) lines.push(`- ${n.text}`)
    lines.push('')
  }
  lines.push('## Platforms: before → after', '', '| Platform | Status before | Status after | Account | Submission | Backlink |', '|---|---|---|---|---|---|')
  for (const [id, b] of Object.entries(before.platforms)) {
    const a = after.platforms[id]
    if (!a) { lines.push(`| ${b.name} | ${label(b.status)} | merged / removed | | | |`); continue }
    const fmt = (x, y) => (x === y ? label(y ?? '—') : `${label(x ?? '—')} → ${label(y ?? '—')}`)
    if (b.status !== a.status || b.resume_status !== a.resume_status || b.account !== a.account || b.submission !== a.submission || b.backlink !== a.backlink || b.signup !== a.signup || b.name !== a.name) {
      lines.push(`| ${a.name}${b.name !== a.name ? ` (was ${b.name})` : ''} | ${label(b.status)}${b.resume_status ? ` ↺${label(b.resume_status)}` : ''} | ${label(a.status)}${a.resume_status ? ` ↺${label(a.resume_status)}` : ''} | ${fmt(b.account, a.account)}${a.signup && !b.signup ? ' (sign-up finished)' : ''} | ${fmt(b.submission, a.submission)} | ${fmt(b.backlink, a.backlink)} |`)
    }
  }
  lines.push('', '## Tasks: before → after', '', '| Task | Platform | Type | Before | After |', '|---|---|---|---|---|')
  for (const [id, b] of Object.entries(before.tasks)) {
    const a = after.tasks[id]
    if (!a || a.state !== b.state || a.run_after !== b.run_after || a.wait_for !== b.wait_for) {
      lines.push(`| ${id} | ${b.name || '—'} | ${b.type} | ${label(b.state)}${b.attempts ? ` (${b.attempts} attempts)` : ''} | ${a ? `${label(a.state)}${a.wait_for ? ` for ${a.wait_for.split(':')[0]}` : ''}` : 'removed'} |`)
    }
  }
  for (const [id, a] of Object.entries(after.tasks)) if (!before.tasks[id]) lines.push(`| ${id} (new) | ${a.name || '—'} | ${a.type} | — | ${label(a.state)} |`)
  const count = snap => Object.values(snap.platforms).reduce((m, p) => ((m[p.status] = (m[p.status] || 0) + 1), m), {})
  lines.push('', '## Status counts', '', '| Status | Before | After |', '|---|---|---|')
  const b = count(before), a = count(after)
  for (const s of [...new Set([...Object.keys(b), ...Object.keys(a)])].sort()) lines.push(`| ${label(s)} | ${b[s] || 0} | ${a[s] || 0} |`)
  return lines.join('\n') + '\n'
}
