// Start / Pause / Resume / Stop and the worker that runs automation_tasks.
//
// State lives in the database, so a restart never loses or repeats work. Every task outcome (done, failed, deferred,
// waiting, needs_you, cancelled, resumed) updates the task row AND resolves the platform's status in one transaction,
// with an activity event: no code path changes a task's state without settling its platform too.
//
// Scheduling: the worker never polls on a fixed beat. After each change it either starts runnable tasks at once or
// sleeps until the earliest run_after; enqueue / resume / approval events wake it. Browser tasks run one at a time
// (one Chrome profile); qualification, discovery and drafting run in parallel up to `parallel_tasks`. Two tasks for
// the same platform never run at once. Failures retry with exponential back-off up to `max_attempts`; then the
// platform goes to needs_you (or evaluation_failed for evaluations) with the full error history.
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { getSetting, now, numSetting, setSetting } from '../db/index.js'
import { maskError } from '../security/mask.js'
import { IN_PROGRESS, PAUSED, canTransition, label } from './stateMachine.js'
import { parseNeedsYou } from './status.js'

const LEASE_MS = 5 * 60_000
const HEARTBEAT_MS = 30_000
const MAX_SLEEP_MS = 60_000 // a safety net only; normal wake-ups come from run_after and events
const STATES = ['stopped', 'running', 'paused']
const ACTIVE = ['queued', 'running', 'waiting', 'paused', 'needs_you']
// A task that stops for the operator at the same point this many times in a row is not handed back again:
// pressing Resume without the cause fixed only replays the same steps.
export const MAX_SAME_BLOCK = 3

/** An error retrying cannot fix (refused by policy, stuck at the same point): no back-off, straight to its end state. */
export class PermanentError extends Error {
  constructor(message, { platformStatus = null, statusReason = null } = {}) { super(message); this.permanent = true; this.platformStatus = platformStatus; this.statusReason = statusReason }
}

/** Exponential back-off: 1, 2, 4, 8 … minutes, capped at an hour, ±10 % jitter so retries do not bunch. */
export function backoffMs(attempt, { base = 60_000, cap = 3600_000, jitter = Math.random } = {}) {
  const raw = Math.min(cap, base * 2 ** Math.max(0, attempt - 1))
  return Math.round(raw * (0.9 + 0.2 * jitter()))
}

// Per task type: where its platform starts, which state a task's unrecoverable end leaves it in, and how it is
// put back when the task is cancelled. Types without a platform (discover) have none.
const DEFAULT_POLICY = { browser: false, exhausted: 'needs_you', entry: null }

export function createOrchestrator({ db, activity, chrome, status, browser = true }) {
  const workerId = `worker-${randomUUID().slice(0, 8)}`
  const handlers = new Map() // type -> { fn, policy }
  const running = new Map() // taskId -> { type, browser, promise }
  let timer = null
  let heartbeat = null
  let scheduling = false
  let idleNoted = null
  let chromeDownNoted = false
  const hooks = { onStart: null, onIdle: null, beforeBrowserTask: null }

  const state = () => getSetting(db, 'automation_state', 'stopped')
  const setState = s => {
    if (!STATES.includes(s)) throw new Error(`unknown state ${s}`)
    setSetting(db, 'automation_state', s)
  }
  const taskRow = id => db.prepare('SELECT * FROM automation_tasks WHERE id = ?').get(id)
  const policyOf = type => handlers.get(type)?.policy ?? DEFAULT_POLICY
  const maxAttempts = task => task.max_attempts || numSetting(db, `max_attempts_${task.type}`, numSetting(db, 'max_attempts', 5))
  const platformName = id => db.prepare('SELECT name FROM platforms WHERE id = ?').get(id)?.name ?? 'Task'
  const ids = task => ({ platformId: task.platform_id, taskId: task.id, correlationId: task.correlation_id })

  function history(task, error, step) {
    let h = []
    try { h = JSON.parse(task.error_history || '[]') } catch {}
    h.push({ at: now(), attempt: task.attempts, step: step ?? task.step ?? null, error })
    return JSON.stringify(h.slice(-20))
  }

  // ---- platform resolution: the one place a task outcome becomes a platform status ----

  /** The stable state a platform goes back to when the task working on it stops without finishing. */
  function entryState(task, platform) {
    const entry = policyOf(task.type).entry
    return typeof entry === 'function' ? entry(platform, db) : entry
  }

  function settle(task, to, opts) {
    if (!task.platform_id || !to) return
    const p = status.get(task.platform_id)
    if (!p) return
    if (p.status === to && to !== 'needs_you') return
    status.transition(task.platform_id, to, { taskId: task.id, ...opts })
  }

  /** Put an interrupted platform back where it can be picked up again (cancel, unrecoverable deferral). */
  function revertPlatform(task, reason, actor = 'agent') {
    if (!task.platform_id) return
    const p = status.get(task.platform_id)
    if (!p) return
    const inFlight = IN_PROGRESS.has(p.status) || PAUSED.has(p.status)
    if (!inFlight) return
    const to = PAUSED.has(p.status) ? p.resume_status : entryState(task, p)
    if (to && canTransition(p.status, to)) settle(task, to, { reason, actor })
  }

  const OUTCOMES = {
    done(task) {
      db.prepare(`UPDATE automation_tasks SET state = 'done', locked_by = NULL, lease_until = NULL, last_error = NULL, finished_at = ?, updated_at = ? WHERE id = ?`).run(now(), now(), task.id)
      activity.success('task_done', `Task ${task.type} finished`, ids(task))
      // A finished task must have moved its platform out of the in-progress state it owned.
      const p = task.platform_id && status.get(task.platform_id)
      if (p && IN_PROGRESS.has(p.status) && policyOf(task.type).ownsInProgress?.(p.status)) {
        settle(task, 'needs_you', { needsYou: { what: `The ${task.type} task finished without a result (${label(p.status)}).`, todo: 'Open the platform to see where it stopped, then press Resume to run it again.' } })
      }
    },

    /** Retryable failure: back to the queue with back-off, or the type's end state once attempts are used up. */
    failed(task, error, { permanent = false, platformStatus = null, statusReason = null } = {}) {
      const msg = maskError(error)
      const cur = taskRow(task.id)
      const hist = history(cur, msg)
      const limit = maxAttempts(cur)
      if (!permanent && cur.attempts < limit) {
        const wait = backoffMs(cur.attempts)
        db.prepare(`UPDATE automation_tasks SET state = 'queued', locked_by = NULL, lease_until = NULL, last_error = ?, error_history = ?, run_after = ?, updated_at = ? WHERE id = ?`)
          .run(msg, hist, new Date(Date.now() + wait).toISOString(), now(), task.id)
        activity.warn('task_retry', `Task ${task.type} failed (attempt ${cur.attempts} of ${limit}): ${msg}. Retrying in ${Math.round(wait / 60_000) || 1} min.`, ids(task))
        return
      }
      const pol = policyOf(task.type)
      const end = platformStatus ?? (permanent ? (typeof pol.failed === 'function' ? pol.failed(status.get(task.platform_id) || {}) : pol.failed) : pol.exhausted) ?? null
      const why = permanent ? msg : `Gave up after ${cur.attempts} attempt(s). Last error: ${msg}`
      if (end === 'needs_you') {
        db.prepare(`UPDATE automation_tasks SET state = 'needs_you', locked_by = NULL, lease_until = NULL, last_error = ?, error_history = ?, updated_at = ? WHERE id = ?`).run(why, hist, now(), task.id)
        activity.error('task_failed', `Task ${task.type} needs you: ${why}`, ids(task))
        settle(task, 'needs_you', { needsYou: { what: why, todo: 'Check what went wrong (error history in the platform drawer), fix it if you can, then press Resume to try again, or Reject the platform.', where: JSON.parse(cur.checkpoint || '{}').url || null, action: 'retry' } })
      } else {
        db.prepare(`UPDATE automation_tasks SET state = 'failed', locked_by = NULL, lease_until = NULL, last_error = ?, error_history = ?, finished_at = ?, updated_at = ? WHERE id = ?`).run(why, hist, now(), now(), task.id)
        activity.error('task_failed', `Task ${task.type} failed: ${why}`, ids(task))
        if (end) settle(task, end, { reason: why, statusReason })
        else revertPlatform(task, why)
      }
    },

    /** Not now: back to the queue, picked again at run_after. No work was done, so it does not use up an attempt. */
    deferred(task, ms, reason) {
      const at = new Date(Date.now() + Math.max(1000, ms)).toISOString()
      db.prepare(`UPDATE automation_tasks SET state = 'queued', locked_by = NULL, lease_until = NULL, run_after = ?, last_error = ?,
          attempts = MAX(attempts - 1, 0), updated_at = ? WHERE id = ?`).run(at, reason, now(), task.id)
      activity.info('task_deferred', `Task ${task.type} deferred until ${at.slice(11, 16)} UTC: ${reason}`, ids(task))
    },

    /** Waits for an event that only something else can cause (an approval). Not retried on a timer. */
    waiting(task, event, reason) {
      db.prepare(`UPDATE automation_tasks SET state = 'waiting', wait_for = ?, locked_by = NULL, lease_until = NULL, run_after = NULL, last_error = ?,
          attempts = MAX(attempts - 1, 0), updated_at = ? WHERE id = ?`).run(event, reason, now(), task.id)
      activity.info('task_waiting', `Task ${task.type} waits for ${event.split(':')[0]}: ${reason}`, ids(task))
      revertPlatform(task, reason)
    },

    needs_you(task, ny) {
      db.prepare(`UPDATE automation_tasks SET state = 'needs_you', locked_by = NULL, lease_until = NULL, last_error = ?, updated_at = ? WHERE id = ?`).run(ny.what, now(), task.id)
      if (task.platform_id) settle(task, 'needs_you', { needsYou: ny })
      else activity.warn('needs_you', ny.what, ids(task))
    },

    cancelled(task, reason = 'cancelled', actor = 'operator') {
      db.prepare(`UPDATE automation_tasks SET state = 'cancelled', locked_by = NULL, lease_until = NULL, last_error = ?, finished_at = ?, updated_at = ? WHERE id = ?`).run(reason, now(), now(), task.id)
      activity.info('task_cancelled', `Task ${task.type} cancelled: ${reason}`, ids(task))
      revertPlatform(task, reason, actor)
    },

    resumed(task, actor = 'operator') {
      db.prepare(`UPDATE automation_tasks SET state = 'queued', last_error = NULL, run_after = NULL, wait_for = NULL, updated_at = ? WHERE id = ?`).run(now(), task.id)
      activity.info('task_resumed', `${platformName(task.platform_id)}: task ${task.type} handed back to the agent`, ids(task))
      const p = task.platform_id && status.get(task.platform_id)
      if (p && PAUSED.has(p.status)) settle(task, p.resume_status || entryState(task, p), { reason: 'resumed', actor })
    }
  }
  const outcome = (name, task, ...args) => db.transaction(() => OUTCOMES[name](task, ...args))()

  // ---- claiming and running ----

  function recoverLeases() {
    // Lease ran out (the server died mid-step) or this worker restarted: back to the queue at the saved step.
    const stale = db.prepare(`SELECT * FROM automation_tasks WHERE state = 'running' AND (lease_until IS NULL OR lease_until < ? OR locked_by <> ?)`).all(now(), workerId)
      .filter(t => !running.has(t.id))
    for (const t of stale) {
      db.prepare(`UPDATE automation_tasks SET state = 'queued', locked_by = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND state = 'running'`).run(now(), t.id)
    }
    if (stale.length) activity.warn('tasks_recovered', `${stale.length} interrupted task(s) returned to the queue at their last saved step`)
    return stale.length
  }

  function claim(kind) {
    const types = [...handlers.entries()].filter(([, h]) => Boolean(h.policy.browser) === (kind === 'browser')).map(([t]) => t)
    if (!types.length) return null
    const t = now()
    return db.prepare(`UPDATE automation_tasks
      SET state = 'running', locked_by = ?, lease_until = ?, heartbeat_at = ?, attempts = attempts + 1, started_at = COALESCE(started_at, ?),
          correlation_id = ?, updated_at = ?
      WHERE id = (SELECT id FROM automation_tasks WHERE state = 'queued' AND (run_after IS NULL OR run_after <= ?)
                  AND type IN (${types.map(() => '?').join(',')})
                  AND (platform_id IS NULL OR platform_id NOT IN (SELECT platform_id FROM automation_tasks WHERE state = 'running' AND platform_id IS NOT NULL))
                  ORDER BY COALESCE(run_after, created_at), id LIMIT 1)
      RETURNING *`).get(workerId, new Date(Date.now() + LEASE_MS).toISOString(), t, t, randomUUID().slice(0, 12), t, t, ...types) ?? null
  }

  function savedCheckpoint(taskId) {
    try { return JSON.parse(taskRow(taskId)?.checkpoint || '{}') } catch { return {} }
  }

  // What a handler gets: save verified checkpoints, move its platform, defer, wait, hand to the operator.
  function taskContext(task) {
    let ended = null // set once the handler chose an outcome itself
    const ctx = {
      chrome, db, activity, status, task,
      correlationId: task.correlation_id,
      shouldContinue: () => state() === 'running',
      log: (level, event, message, meta) => activity[level](event, message, { ...ids(task), meta }),
      /** A verified checkpoint: the step that completed, where (URL) and what the form looked like after it. */
      checkpoint(step, data = {}) {
        const block = savedCheckpoint(task.id)._block // the repeat counter survives the handler's own saves
        db.prepare(`UPDATE automation_tasks SET step = ?, checkpoint = ?, lease_until = ?, heartbeat_at = ?, updated_at = ? WHERE id = ? AND locked_by = ?`)
          .run(step, JSON.stringify(block ? { ...data, _block: block } : data), new Date(Date.now() + LEASE_MS).toISOString(), now(), now(), task.id, workerId)
      },
      /** Move this task's platform (validated by the state machine). */
      setStatus(to, opts = {}) { return task.platform_id ? status.transition(task.platform_id, to, { taskId: task.id, ...opts }) : null },
      defer(ms, reason) { ended = 'deferred'; outcome('deferred', task, ms, reason) },
      /** For conditions that cannot change on their own: no timer, woken by signal(event). */
      waitFor(event, reason) { ended = 'waiting'; outcome('waiting', task, event, reason) },
      /**
       * Hand the task to a person. `at` names where it stopped (e.g. the page); stopping at the same `at`
       * MAX_SAME_BLOCK times in a row ends the task as failed instead, so Resume cannot loop on one blocker.
       */
      needsYou(ny, { at = null } = {}) {
        if (typeof ny === 'string') ny = { what: ny, todo: '' }
        const cp = savedCheckpoint(task.id)
        const times = at && cp._block?.at === at ? cp._block.times + 1 : 1
        if (at) cp._block = { at, times }
        else delete cp._block
        db.prepare('UPDATE automation_tasks SET checkpoint = ? WHERE id = ?').run(JSON.stringify(cp), task.id)
        ended = 'needs_you'
        if (at && times >= MAX_SAME_BLOCK) {
          const pol = policyOf(task.type)
          const end = typeof pol.failed === 'function' ? pol.failed(status.get(task.platform_id) || {}) : pol.failed
          outcome('failed', task, new Error(`Blocked at the same point ${times} times in a row: ${ny.what}`), { permanent: true, platformStatus: end || null, statusReason: 'not_possible' })
          return { stuck: true }
        }
        outcome('needs_you', task, ny)
        return { stuck: false }
      },
      ended: () => ended
    }
    return ctx
  }

  async function runTask(task, kind) {
    idleNoted = null
    activity.info('task_started', `Task ${task.type} started${task.step ? ` (resuming after ${task.step})` : ''}${task.attempts > 1 ? `, attempt ${task.attempts}` : ''}`, ids(task))
    const ctx = taskContext(task)
    const { fn, policy } = handlers.get(task.type)
    try {
      if (policy.start && task.platform_id) {
        const to = typeof policy.start === 'function' ? policy.start(status.get(task.platform_id), db) : policy.start
        const cur = status.get(task.platform_id)
        if (to && cur && cur.status !== to && canTransition(cur.status, to)) status.transition(task.platform_id, to, { taskId: task.id, reason: `task ${task.type} started` })
      }
      await fn(task, ctx)
      const cur = taskRow(task.id)
      if (cur?.state === 'running' && !ctx.ended()) {
        if (state() === 'running') outcome('done', task)
        else db.prepare(`UPDATE automation_tasks SET state = 'queued', locked_by = NULL, lease_until = NULL, updated_at = ? WHERE id = ?`).run(now(), task.id) // paused mid-task: resumes at its step
      }
    } catch (error) {
      if (taskRow(task.id)?.state === 'running') {
        try { outcome('failed', task, error, { permanent: Boolean(error.permanent), platformStatus: error.platformStatus, statusReason: error.statusReason }) } catch (e2) {
          activity.error('worker_error', `Could not record the failure of task ${task.id}: ${maskError(e2)}`, ids(task))
          db.prepare(`UPDATE automation_tasks SET state = 'failed', locked_by = NULL, last_error = ?, updated_at = ? WHERE id = ?`).run(maskError(error), now(), task.id)
        }
      }
    } finally {
      running.delete(task.id)
      wake()
    }
  }

  function capacity(kind) {
    const n = [...running.values()].filter(r => r.kind === kind).length
    return kind === 'browser' ? (n < 1 ? 1 : 0) : Math.max(0, numSetting(db, 'parallel_tasks', 3) - n)
  }

  async function browserReady() {
    if (!browser || !chrome) return true
    try {
      await chrome.connect()
      if (chromeDownNoted) { chromeDownNoted = false; activity.success('chrome_recovered', 'Chrome is back; browser tasks continue') }
      return true
    } catch (e) {
      if (!chromeDownNoted) { chromeDownNoted = true; activity.error('chrome_unavailable', `Browser tasks are waiting: Chrome could not start (${maskError(e)}). Retrying every minute.`) }
      return false
    }
  }

  /** Start every task that may run now; then sleep until the earliest run_after (or an event). */
  async function schedule() {
    if (scheduling) return
    scheduling = true
    clearTimeout(timer)
    try {
      if (state() !== 'running') return
      recoverLeases()
      const browserTypes = [...handlers.entries()].filter(([, h]) => h.policy.browser).map(([t]) => t)
      let started = 0
      // Round two runs only when the queue was empty and the idle hook queued new work (next step from the database).
      for (let round = 0; round < 2; round++) {
        for (const kind of ['task', 'browser']) {
          while (capacity(kind) > 0) {
            if (kind === 'browser') {
              const waiting = browserTypes.length && db.prepare(`SELECT 1 FROM automation_tasks WHERE state = 'queued' AND (run_after IS NULL OR run_after <= ?)
                AND type IN (${browserTypes.map(() => '?').join(',')}) LIMIT 1`).get(now(), ...browserTypes)
              if (!waiting || !(await browserReady())) break
            }
            const task = claim(kind)
            if (!task) break
            started++
            running.set(task.id, { kind, type: task.type, promise: runTask(task, kind) })
          }
        }
        if (started || running.size || round === 1 || !hooks.onIdle?.()) break
      }
      if (!started && !running.size) {
        const next = nextRunAt()
        const key = next ? `wait:${next}` : 'idle'
        if (idleNoted !== key) {
          idleNoted = key
          if (next) activity.info('worker_waiting', `Waiting until ${new Date(next).toISOString().slice(11, 16)} UTC for ${scheduledCount()} scheduled task(s)`)
          else activity.info('worker_idle', handlers.size ? 'No queued tasks' : 'No task types are enabled')
        }
      }
    } catch (error) {
      activity.error('worker_error', `Worker error: ${maskError(error)}`)
    } finally {
      scheduling = false
      if (state() === 'running') {
        const next = nextRunAt()
        const delay = next ? Math.max(50, Math.min(MAX_SLEEP_MS, Date.parse(next) - Date.now())) : MAX_SLEEP_MS
        timer = setTimeout(schedule, chromeDownNoted ? Math.max(delay, 60_000) : delay)
        timer.unref?.()
      }
    }
  }

  function nextRunAt() {
    const types = [...handlers.keys()]
    if (!types.length) return null
    return db.prepare(`SELECT MIN(COALESCE(run_after, ?)) t FROM automation_tasks WHERE state = 'queued' AND type IN (${types.map(() => '?').join(',')})`).get(now(), ...types).t
  }
  const scheduledCount = () => db.prepare(`SELECT COUNT(*) n FROM automation_tasks WHERE state = 'queued' AND run_after > ?`).get(now()).n

  /** Run the scheduler soon (coalesced). Called on enqueue, resume, approval and every task end. */
  function wake() {
    if (state() !== 'running') return
    clearTimeout(timer)
    timer = setTimeout(schedule, 10)
    timer.unref?.()
  }

  function beat() {
    const t = now()
    setSetting(db, 'worker_heartbeat', JSON.stringify({ workerId, host: hostname(), at: t, state: state(), running: running.size }))
    if (running.size) {
      db.prepare(`UPDATE automation_tasks SET heartbeat_at = ?, lease_until = ? WHERE locked_by = ? AND state = 'running'`)
        .run(t, new Date(Date.now() + LEASE_MS).toISOString(), workerId)
    }
  }

  function findActive(platformId, type) {
    return db.prepare(`SELECT * FROM automation_tasks WHERE platform_id IS ? AND type = ? AND state IN (${ACTIVE.map(() => '?').join(',')})`).get(platformId, type, ...ACTIVE)
  }

  return {
    workerId,
    state,
    hooks,
    /** policy: { browser, start, entry, exhausted, failed, ownsInProgress } — see DEFAULT_POLICY. */
    register(type, fn, policy = {}) { handlers.set(type, { fn, policy: { ...DEFAULT_POLICY, ...policy } }) },
    outcome,
    wake,
    running: () => [...running.keys()],

    /** On server start: a run that was going when the server died comes back paused, never on its own. */
    boot() {
      recoverLeases()
      if (state() === 'running') {
        setState('paused')
        activity.warn('automation_paused', 'Server restarted while automation was running: paused. Press Resume to continue.')
      }
      beat()
      heartbeat = setInterval(beat, HEARTBEAT_MS)
      heartbeat.unref?.()
    },

    async start() {
      if (state() === 'running') return state()
      if (browser && chrome) await chrome.connect() // fail here, loudly, rather than mid-task
      setState('running')
      idleNoted = null
      activity.success('automation_started', 'Automation started')
      hooks.onStart?.()
      beat()
      wake()
      return state()
    },
    pause() {
      if (state() !== 'running') throw new Error(`cannot pause while ${state()}`)
      setState('paused')
      clearTimeout(timer)
      activity.info('automation_paused', 'Automation paused; the current step finishes, then the task waits')
      beat()
      return state()
    },
    async resume() {
      if (state() !== 'paused') throw new Error(`cannot resume while ${state()}`)
      if (browser && chrome) await chrome.connect()
      setState('running')
      idleNoted = null
      activity.success('automation_resumed', 'Automation resumed')
      beat()
      wake()
      return state()
    },
    stop() {
      if (state() === 'stopped') return state()
      setState('stopped')
      clearTimeout(timer)
      activity.info('automation_stopped', 'Automation stopped; queued tasks stay queued')
      beat()
      return state()
    },

    /** Queue a task unless an unfinished or finished one of the same type exists for that platform (idempotent). */
    enqueue(platformId, type, { runAfter = null, maxAttempts = null, checkpoint = null } = {}) {
      const existing = db.prepare(`SELECT id, state FROM automation_tasks WHERE platform_id IS ? AND type = ?
        AND state IN (${[...ACTIVE, 'done'].map(() => '?').join(',')})`).get(platformId, type, ...ACTIVE, 'done')
      if (existing) return { created: false, task: existing }
      const task = db.prepare(`INSERT INTO automation_tasks (platform_id, type, run_after, max_attempts, idempotency_key, checkpoint) VALUES (?, ?, ?, ?, ?, ?) RETURNING id, state`)
        .get(platformId, type, runAfter, maxAttempts, `${type}:${platformId ?? 'none'}`, checkpoint ? JSON.stringify(checkpoint) : null)
      wake()
      return { created: true, task }
    },

    /** Wake every task waiting for `event` (e.g. approval:12). */
    signal(event) {
      const r = db.prepare(`UPDATE automation_tasks SET state = 'queued', wait_for = NULL, run_after = NULL, updated_at = ? WHERE state = 'waiting' AND wait_for = ?`).run(now(), event)
      if (r.changes) { activity.info('task_signalled', `${r.changes} task(s) waiting for ${event.split(':')[0]} queued again`); wake() }
      return r.changes
    },

    /** A person finished the manual step (CAPTCHA, sign-in): the task goes back to the queue at its saved step. */
    resumeTask(taskId, { actor = 'operator' } = {}) {
      const t = taskRow(taskId)
      if (!t) throw Object.assign(new Error('No such task'), { status: 404 })
      if (t.state === 'queued' || t.state === 'running') return { ok: true, already: t.state } // already handed back: nothing to do
      if (t.state !== 'needs_you' && t.state !== 'waiting') throw Object.assign(new Error(`Task is ${label(t.state).toLowerCase()}, not waiting for you`), { status: 409 })
      outcome('resumed', t, actor)
      wake()
      return { ok: true }
    },

    /**
     * Resume a platform that needs you, whether or not a task is waiting: its needs_you task goes back to the queue,
     * or, when none exists (the task ended earlier), the platform returns to the state it was in and the matching
     * task is queued. One action for the Needs-you page, whatever caused the stop.
     */
    resumePlatform(platformId, { actor = 'operator', taskType = 'submit' } = {}) {
      const p = status.get(platformId)
      if (!p) throw Object.assign(new Error('No such platform'), { status: 404 })
      const t = db.prepare(`SELECT * FROM automation_tasks WHERE platform_id = ? AND state IN ('needs_you','waiting') ORDER BY id DESC LIMIT 1`).get(platformId)
      if (t) return this.resumeTask(t.id, { actor })
      if (!PAUSED.has(p.status)) throw Object.assign(new Error(`${platformName(platformId)} is ${label(p.status).toLowerCase()}, not waiting for you`), { status: 409 })
      const back = p.resume_status && canTransition(p.status, p.resume_status) ? p.resume_status : 'approved'
      db.transaction(() => {
        status.transition(platformId, back, { actor, reason: 'resumed' })
        const type = ['discovered', 'qualifying', 'evaluation_failed'].includes(back) ? 'qualify' : ['qualified', 'listing_drafted'].includes(back) ? 'prepare' : taskType
        if (!['approval_required'].includes(back)) this.enqueue(platformId, type)
      })()
      wake()
      return { ok: true }
    },

    /** Retry a failed (or stopped) platform from the right step. Finished work is never redone. */
    retryPlatform(platformId, { actor = 'operator' } = {}) {
      const p = status.get(platformId)
      if (!p) throw Object.assign(new Error('No such platform'), { status: 404 })
      if (PAUSED.has(p.status)) return this.resumePlatform(platformId, { actor })
      const signedUp = Boolean(db.prepare(`SELECT 1 FROM accounts WHERE platform_id = ? AND signup_completed_at IS NOT NULL`).get(platformId))
      const plan = {
        evaluation_failed: ['discovered', 'qualify'],
        registration_failed: ['approved', 'submit'],
        submission_failed: [signedUp ? 'ready_for_submission' : 'approved', 'submit'],
        rejected_by_platform: ['approved', 'submit'],
        approved: [null, 'submit'],
        ready_for_submission: [null, 'submit']
      }[p.status]
      if (!plan) throw Object.assign(new Error(`${p.name} is ${label(p.status).toLowerCase()}: nothing to retry`), { status: 409 })
      const [to, type] = plan
      db.transaction(() => {
        if (to) status.transition(platformId, to, { actor, reason: 'retry requested' })
        // The earlier finished run of this step stops counting, so the step runs again.
        db.prepare(`UPDATE automation_tasks SET state = 'cancelled', updated_at = ? WHERE platform_id = ? AND type = ? AND state = 'done'`).run(now(), platformId, type)
        this.enqueue(platformId, type, type === 'qualify' ? { checkpoint: { force: true } } : {})
      })()
      activity.info('platform_retry', `${p.name}: retry queued (${type})`, { platformId })
      return { ok: true, queued: type }
    },

    cancelTask(taskId, reason = 'cancelled by you') {
      const t = taskRow(taskId)
      if (!t || !ACTIVE.includes(t.state)) throw Object.assign(new Error('Task is not active'), { status: 409 })
      if (t.state === 'running') throw Object.assign(new Error('Task is running; pause the automation first'), { status: 409 })
      outcome('cancelled', t, reason)
      return { ok: true }
    },

    /** Cancel every active task of a platform (reject, skip, manual completion). */
    cancelPlatformTasks(platformId, reason, actor = 'operator') {
      for (const t of db.prepare(`SELECT * FROM automation_tasks WHERE platform_id = ? AND state IN ('queued','waiting','paused','needs_you')`).all(platformId)) {
        db.prepare(`UPDATE automation_tasks SET state = 'cancelled', locked_by = NULL, last_error = ?, finished_at = ?, updated_at = ? WHERE id = ?`).run(reason, now(), now(), t.id)
        activity.info('task_cancelled', `Task ${t.type} cancelled: ${reason}`, { platformId, taskId: t.id, meta: { actor } })
      }
    },

    findActive,

    counts() {
      return Object.fromEntries(db.prepare('SELECT state, COUNT(*) n FROM automation_tasks GROUP BY state').all().map(r => [r.state, r.n]))
    },

    /** Scheduled run (hosted cron): work through the queue until nothing is runnable or `ms` has passed. */
    async drain(ms) {
      const until = Date.now() + ms
      let rounds = 0
      while (Date.now() < until && state() === 'running') {
        await schedule()
        while (running.size) await Promise.race([...running.values()].map(r => r.promise))
        rounds++
        const next = nextRunAt()
        if (!next || Date.parse(next) > Date.now()) break
      }
      return rounds
    },

    shutdown() { clearTimeout(timer); clearInterval(heartbeat) },
    _tick: async () => { await schedule(); while (running.size) await Promise.race([...running.values()].map(r => r.promise)) },
    _schedule: schedule,
    parseNeedsYou
  }
}
