// The daily or weekly summary (platforms added, submitted, published and live; failures; needs-you items; lost
// backlinks; a Successfully added section) and the health metrics (success rate and average time per stage, failure
// reasons ranked, tasks per hour). Both are computed from platform_transitions and automation_tasks.
import { getSetting, now, setSetting } from '../db/index.js'
import { label } from '../engine/stateMachine.js'

// Stages: entered at `from`, succeeded on reaching one of `ok`, failed on reaching one of `fail`.
export const STAGES = [
  { name: 'Evaluation', from: ['qualifying'], ok: ['qualified', 'rejected', 'paid_skipped'], fail: ['evaluation_failed'] },
  { name: 'Sign-up', from: ['registering'], ok: ['registered', 'ready_for_submission', 'submitting'], fail: ['registration_failed'] },
  { name: 'Email verification', from: ['email_verification_pending'], ok: ['registered', 'ready_for_submission', 'submitting'], fail: ['registration_failed'] },
  { name: 'Submission', from: ['submitting'], ok: ['submitted', 'pending_platform_review', 'published'], fail: ['submission_failed'] },
  { name: 'Platform review', from: ['submitted', 'pending_platform_review'], ok: ['published', 'live_backlink', 'no_backlink'], fail: ['rejected_by_platform'] },
  { name: 'Backlink', from: ['published'], ok: ['live_backlink'], fail: ['no_backlink'] }
]

const normalizeError = e => String(e || 'unknown').replace(/\b\d+\b/g, 'N').replace(/https?:\/\/\S+/g, '<url>').replace(/\s+/g, ' ').slice(0, 90)

export function createReports({ db, views }) {
  function metrics({ days = 30 } = {}) {
    const since = new Date(Date.now() - days * 86400_000).toISOString()
    const tr = db.prepare(`SELECT platform_id, from_status, to_status, at FROM platform_transitions WHERE at >= ? ORDER BY platform_id, at, id`).all(since)
    const stages = STAGES.map(st => {
      let entered = 0, ok = 0, fail = 0
      const durations = []
      const open = new Map()
      for (const t of tr) {
        if (st.from.includes(t.to_status) && !open.has(t.platform_id)) { open.set(t.platform_id, t.at); entered++; continue }
        if (!open.has(t.platform_id)) continue
        const outcome = st.ok.includes(t.to_status) ? 'ok' : st.fail.includes(t.to_status) ? 'fail' : null
        if (!outcome) continue
        durations.push(Date.parse(t.at) - Date.parse(open.get(t.platform_id)))
        open.delete(t.platform_id)
        outcome === 'ok' ? ok++ : fail++
      }
      const done = ok + fail
      return { stage: st.name, entered, succeeded: ok, failed: fail, inProgress: open.size, successRate: done ? Math.round((ok / done) * 100) : null,
        avgMinutes: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length / 60_000) : null }
    })
    const reasons = new Map()
    for (const t of db.prepare(`SELECT type, last_error, error_history FROM automation_tasks WHERE updated_at >= ? AND (state IN ('failed','needs_you') OR error_history IS NOT NULL)`).all(since)) {
      let hist = []
      try { hist = JSON.parse(t.error_history || '[]') } catch {}
      const errs = hist.length ? hist.map(h => h.error) : [t.last_error]
      for (const e of errs.filter(Boolean)) { const k = `${label(t.type)}: ${normalizeError(e)}`; reasons.set(k, (reasons.get(k) || 0) + 1) }
    }
    const perHour = db.prepare(`SELECT strftime('%Y-%m-%dT%H', finished_at) h, COUNT(*) n FROM automation_tasks WHERE state = 'done' AND finished_at >= ? GROUP BY h ORDER BY h`).all(new Date(Date.now() - 86400_000).toISOString())
    const doneDay = perHour.reduce((a, r) => a + r.n, 0)
    return {
      days, stages,
      failureReasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([reason, count]) => ({ reason, count })),
      tasksPerHour: Math.round((doneDay / 24) * 10) / 10,
      tasksLast24h: perHour
    }
  }

  function summary({ days = 7 } = {}) {
    const since = new Date(Date.now() - days * 86400_000).toISOString()
    const reached = to => db.prepare(`SELECT DISTINCT p.name FROM platform_transitions t JOIN platforms p ON p.id = t.platform_id WHERE t.at >= ? AND t.to_status IN (${to.map(() => '?').join(',')})`).all(since, ...to).map(r => r.name)
    const added = db.prepare(`SELECT name FROM platforms WHERE created_at >= ?`).all(since).map(r => r.name)
    const a = views.successfullyAdded()
    return {
      period: `${days === 1 ? 'Daily' : days === 7 ? 'Weekly' : `${days}-day`} summary, ${since.slice(0, 10)} to ${now().slice(0, 10)}`,
      added, submitted: reached(['submitted', 'pending_platform_review']), published: reached(['published']), live: reached(['live_backlink']),
      failed: views.failed().map(f => `${f.name}: ${f.error}`), needsYou: views.needsYou().map(n => `${n.name}: ${n.reason}`), lost: reached(['backlink_lost']),
      successfullyAdded: {
        live: a.live.map(r => `${r.name} — ${r.listing_url || r.backlink_page} (${r.is_dofollow ? 'dofollow' : r.rel || 'nofollow'})`),
        published: a.published.map(r => `${r.name} — ${r.found}`),
        awaiting: a.awaiting.map(r => `${r.name} — waiting ${r.waitingDays ?? '?'} day(s)`)
      }
    }
  }

  function render(s) {
    const list = (title, items) => `${title} (${items.length})${items.length ? '\n' + items.slice(0, 25).map(i => `  • ${i}`).join('\n') + (items.length > 25 ? `\n  … and ${items.length - 25} more` : '') : ''}`
    return [s.period, '', list('New platforms', s.added), list('Submitted', s.submitted), list('Published', s.published), list('Backlinks went live', s.live),
      list('Failures', s.failed), list('Needs you', s.needsYou), list('Backlinks lost', s.lost), '', 'SUCCESSFULLY ADDED',
      list('Live with backlink', s.successfullyAdded.live), list('Published, backlink not counted yet', s.successfullyAdded.published),
      list('Submitted, awaiting platform review', s.successfullyAdded.awaiting)].join('\n')
  }

  /** Send the summary when it is due: daily, or weekly on Mondays, from 09:00 local time. */
  function sendIfDue(alerts, at = new Date()) {
    const freq = getSetting(db, 'summary_frequency', 'weekly')
    if (freq === 'off' || at.getHours() < 9 || (freq === 'weekly' && at.getDay() !== 1)) return false
    const key = `${freq}:${at.toISOString().slice(0, 10)}`
    if (getSetting(db, 'summary_last_sent') === key) return false
    const s = summary({ days: freq === 'daily' ? 1 : 7 })
    alerts.send(`summary:${key}`, s.period, render(s), { level: 'info', link: alerts.link('added'), everyMs: 20 * 3600_000 })
    setSetting(db, 'summary_last_sent', key)
    return true
  }

  return { metrics, summary, render, sendIfDue }
}
