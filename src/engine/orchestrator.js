// Start / Pause / Resume / Stop and the worker that runs automation_tasks. State lives in the database, so a
// restart never loses or repeats work: a task is claimed with a lease, saves its step after every meaningful
// action, and a task whose lease ran out (the server died mid-step) goes back to the queue at its last step.
// Task types are registered by later phases; with none registered the worker idles and says so.
import { randomUUID } from 'node:crypto'
import { getSetting, now, setSetting } from '../db/index.js'
import { maskError } from '../security/mask.js'

const LEASE_MS = 5 * 60_000
const TICK_MS = 5_000
const STATES = ['stopped', 'running', 'paused']
// A task that stops for the operator at the same point this many times in a row is not handed back again:
// pressing Resume without the cause fixed only replays the same steps.
export const MAX_SAME_BLOCK = 3

export function createOrchestrator({ db, activity, chrome, browser = true }) {
  // browser: false on a hosted copy with no Chrome: Start does not launch one, and browser tasks are not registered.
  const workerId = `worker-${randomUUID().slice(0, 8)}`
  const handlers = new Map() // type -> async (task, ctx) => void
  let timer = null
  let busy = false
  let idleNoted = false
  const hooks = { onStart: null, onIdle: null } // set by the agent: what to queue when the queue runs dry

  const state = () => getSetting(db, 'automation_state', 'stopped')
  const setState = s => {
    if (!STATES.includes(s)) throw new Error(`unknown state ${s}`)
    setSetting(db, 'automation_state', s)
  }

  function recoverLeases() {
    const r = db.prepare(`UPDATE automation_tasks SET state = 'queued', locked_by = NULL, lease_until = NULL, updated_at = ?
      WHERE state = 'running' AND (lease_until IS NULL OR lease_until < ?)`).run(now(), now())
    if (r.changes) activity.warn('tasks_recovered', `${r.changes} interrupted task(s) returned to the queue at their last saved step`)
  }

  function claim() {
    const types = [...handlers.keys()]
    if (!types.length) return null
    const t = now()
    return db.prepare(`UPDATE automation_tasks
      SET state = 'running', locked_by = ?, lease_until = ?, attempts = attempts + 1, updated_at = ?
      WHERE id = (SELECT id FROM automation_tasks WHERE state = 'queued' AND (run_after IS NULL OR run_after <= ?)
                  AND type IN (${types.map(() => '?').join(',')}) ORDER BY id LIMIT 1)
      RETURNING *`).get(workerId, new Date(Date.now() + LEASE_MS).toISOString(), t, t, ...types) ?? null
  }

  function savedCheckpoint(taskId) {
    try { return JSON.parse(db.prepare('SELECT checkpoint FROM automation_tasks WHERE id = ?').get(taskId)?.checkpoint || '{}') } catch { return {} }
  }

  // What a handler gets: save its step, ask whether to keep going, hand the task to the operator.
  function taskContext(task) {
    return {
      chrome, db, activity,
      shouldContinue: () => state() === 'running',
      checkpoint(step, data = {}) {
        const block = savedCheckpoint(task.id)._block // the repeat counter survives the handler's own saves
        db.prepare(`UPDATE automation_tasks SET step = ?, checkpoint = ?, lease_until = ?, updated_at = ? WHERE id = ? AND locked_by = ?`)
          .run(step, JSON.stringify(block ? { ...data, _block: block } : data), new Date(Date.now() + LEASE_MS).toISOString(), now(), task.id, workerId)
      },
      /** Not now: back to the queue, picked again after `ms`. No work was done, so it does not count as an attempt. */
      defer(ms, reason) {
        db.prepare(`UPDATE automation_tasks SET state = 'queued', locked_by = NULL, lease_until = NULL, run_after = ?, last_error = ?,
            attempts = MAX(attempts - 1, 0), updated_at = ? WHERE id = ?`)
          .run(new Date(Date.now() + ms).toISOString(), reason, now(), task.id)
        activity.info('task_deferred', `Task ${task.type} deferred: ${reason}`, { platformId: task.platform_id, taskId: task.id })
      },
      /**
       * Hand the task to the operator. `at` names where it stopped (e.g. the page); stopping at the same `at`
       * MAX_SAME_BLOCK times in a row ends the task as failed instead, so Resume cannot loop on one blocker.
       * Returns { stuck } so the handler can mark its platform.
       */
      needsYou(reason, { at = null } = {}) {
        const cp = savedCheckpoint(task.id)
        const times = at && cp._block?.at === at ? cp._block.times + 1 : 1
        if (at) cp._block = { at, times }
        else delete cp._block
        if (at && times >= MAX_SAME_BLOCK) {
          const msg = `Stopped: blocked at the same point ${times} times in a row. ${reason}`
          db.prepare(`UPDATE automation_tasks SET state = 'failed', locked_by = NULL, lease_until = NULL, last_error = ?, checkpoint = ?, updated_at = ? WHERE id = ?`)
            .run(msg, JSON.stringify(cp), now(), task.id)
          activity.error('task_stuck', `${msg} It will not be retried on its own: finish it in Chrome, or fix the cause and choose Retry submission.`,
            { platformId: task.platform_id, taskId: task.id })
          return { stuck: true }
        }
        db.prepare(`UPDATE automation_tasks SET state = 'needs_you', locked_by = NULL, lease_until = NULL, last_error = ?, checkpoint = ?, updated_at = ? WHERE id = ?`)
          .run(reason, JSON.stringify(cp), now(), task.id)
        activity.warn('needs_you', reason, { platformId: task.platform_id, taskId: task.id })
        return { stuck: false }
      }
    }
  }

  async function tick() {
    if (busy || state() !== 'running') return
    busy = true
    try {
      recoverLeases()
      const task = claim()
      if (!task) {
        if (hooks.onIdle?.()) return
        if (!idleNoted) {
          activity.info('worker_idle', handlers.size
            ? 'No queued tasks'
            : 'Worker is running; no task types are enabled yet (registration and submission arrive in Phase 3)')
          idleNoted = true
        }
        return
      }
      idleNoted = false
      activity.info('task_started', `Task ${task.type} started${task.step ? ` (resuming after ${task.step})` : ''}`, { platformId: task.platform_id, taskId: task.id })
      const ctx = taskContext(task)
      try {
        await handlers.get(task.type)(task, ctx)
        const cur = db.prepare('SELECT state FROM automation_tasks WHERE id = ?').get(task.id)
        if (cur?.state === 'running') {
          // Paused or stopped mid-task: back to the queue at the saved step. Otherwise it finished.
          const next = state() === 'running' ? 'done' : 'queued'
          db.prepare(`UPDATE automation_tasks SET state = ?, locked_by = NULL, lease_until = NULL, updated_at = ? WHERE id = ?`).run(next, now(), task.id)
          if (next === 'done') activity.success('task_done', `Task ${task.type} finished`, { platformId: task.platform_id, taskId: task.id })
        }
      } catch (error) {
        const msg = maskError(error)
        db.prepare(`UPDATE automation_tasks SET state = 'failed', locked_by = NULL, lease_until = NULL, last_error = ?, updated_at = ? WHERE id = ?`)
          .run(msg, now(), task.id)
        activity.error('task_failed', `Task ${task.type} failed: ${msg}`, { platformId: task.platform_id, taskId: task.id })
      }
    } catch (error) {
      activity.error('worker_error', `Worker error: ${maskError(error)}`)
    } finally {
      busy = false
    }
  }

  return {
    workerId,
    state,
    register(type, handler) { handlers.set(type, handler) },
    hooks,

    /** On server start: a run that was going when the server died comes back paused, never on its own. */
    boot() {
      recoverLeases()
      if (state() === 'running') {
        setState('paused')
        activity.warn('automation_paused', 'Server restarted while automation was running: paused. Press Resume to continue.')
      }
      timer = setInterval(tick, TICK_MS)
      timer.unref()
    },

    async start() {
      if (state() === 'running') return state()
      if (browser) await chrome.connect() // fail here, loudly, rather than mid-task
      setState('running')
      idleNoted = false
      activity.success('automation_started', 'Automation started')
      hooks.onStart?.()
      tick()
      return state()
    },
    pause() {
      if (state() !== 'running') throw new Error(`cannot pause while ${state()}`)
      setState('paused')
      activity.info('automation_paused', 'Automation paused; the current step finishes, then the task waits')
      return state()
    },
    async resume() {
      if (state() !== 'paused') throw new Error(`cannot resume while ${state()}`)
      if (browser) await chrome.connect()
      setState('running')
      idleNoted = false
      activity.success('automation_resumed', 'Automation resumed')
      tick()
      return state()
    },
    stop() {
      if (state() === 'stopped') return state()
      setState('stopped')
      activity.info('automation_stopped', 'Automation stopped; queued tasks stay queued')
      return state()
    },

    /** Queue a task unless an unfinished or finished one of the same type exists for that platform. */
    enqueue(platformId, type, { runAfter = null } = {}) {
      const existing = db.prepare(`SELECT id, state FROM automation_tasks WHERE platform_id IS ? AND type = ?
        AND state IN ('queued','running','paused','needs_you','done')`).get(platformId, type)
      if (existing) return { created: false, task: existing }
      const task = db.prepare(`INSERT INTO automation_tasks (platform_id, type, run_after) VALUES (?, ?, ?) RETURNING id, state`).get(platformId, type, runAfter)
      return { created: true, task }
    },

    /** Operator finished the manual step (CAPTCHA, sign-in): the task goes back to the queue at its saved step. */
    resumeTask(taskId) {
      const r = db.prepare(`UPDATE automation_tasks SET state = 'queued', last_error = NULL, updated_at = ? WHERE id = ? AND state = 'needs_you'`).run(now(), taskId)
      if (!r.changes) throw new Error('task is not waiting for you')
      activity.info('task_resumed', `Task ${taskId} handed back to the agent`, { taskId })
    },

    counts() {
      return Object.fromEntries(db.prepare('SELECT state, COUNT(*) n FROM automation_tasks GROUP BY state').all().map(r => [r.state, r.n]))
    },

    signupsInLastHour() {
      return db.prepare(`SELECT COUNT(*) n FROM accounts WHERE created_at > ?`).get(new Date(Date.now() - 3600_000).toISOString()).n
    },

    /** Scheduled run (hosted): work through the queue until it is empty or `ms` has passed. */
    async drain(ms) {
      const until = Date.now() + ms
      let rounds = 0
      while (Date.now() < until && state() === 'running') {
        const before = db.prepare(`SELECT COUNT(*) n FROM automation_tasks WHERE state IN ('done','failed','needs_you') OR (state = 'queued' AND run_after IS NOT NULL)`).get().n
        while (busy) await new Promise(r => setTimeout(r, 500)) // the in-process timer may be mid-task
        await tick()
        rounds++
        const after = db.prepare(`SELECT COUNT(*) n FROM automation_tasks WHERE state IN ('done','failed','needs_you') OR (state = 'queued' AND run_after IS NOT NULL)`).get().n
        const queued = db.prepare(`SELECT COUNT(*) n FROM automation_tasks WHERE state = 'queued' AND (run_after IS NULL OR run_after <= ?) AND type IN (${[...handlers.keys()].map(() => '?').join(',') || "''"})`).get(now(), ...handlers.keys()).n
        if (after === before && !queued) break
      }
      return rounds
    },

    shutdown() { clearInterval(timer) },
    _tick: tick
  }
}
