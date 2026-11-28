// Profile gaps: facts a listing form asked for that the approved profile does not have ("missing profile field: X").
// Each platform that stopped on one is grouped under the fact's name, so one answer unblocks every platform asking
// for it. Answers are saved as approved profile facts (`extra_<slug>`), which the submit task offers to the AI as
// {{company.extra_<slug>}} like any other fact, and every waiting platform is retried.
import { now } from '../db/index.js'

const MISSING = /missing profile field: (.+?)\s*$/i
// Platforms still stuck on the gap; one that moved on (submitted, skipped, done by hand) is not waiting any more.
const WAITING = ['needs_you', 'registration_failed', 'submission_failed']

export const slugOf = label => String(label).toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50)

export function createProfileGaps({ db, orchestrator, activity }) {
  /** Open gaps, most-blocking first: [{ key, label, platforms: [{ id, name, status }] }]. */
  function list() {
    const rows = db.prepare(`SELECT p.id, p.name, p.status, p.needs_you_reason, t.last_error
      FROM platforms p LEFT JOIN automation_tasks t ON t.id = (SELECT id FROM automation_tasks WHERE platform_id = p.id ORDER BY id DESC LIMIT 1)
      WHERE p.status IN (${WAITING.map(() => '?').join(',')})`).all(...WAITING)
    const answered = new Set(db.prepare(`SELECT field FROM company_information WHERE field LIKE 'extra_%' AND value <> ''`).all().map(r => r.field.slice(6)))
    const gaps = new Map()
    for (const r of rows) {
      let what = r.needs_you_reason || ''
      try { what = JSON.parse(what).what || '' } catch {}
      const reason = r.status === 'needs_you' ? what : r.last_error || ''
      const label = reason.match(MISSING)?.[1]?.trim()
      if (!label) continue
      const key = slugOf(label)
      if (!key) continue
      const g = gaps.get(key) || { key, label, answered: answered.has(key), platforms: [] }
      g.platforms.push({ id: r.id, name: r.name, status: r.status })
      gaps.set(key, g)
    }
    return [...gaps.values()].sort((a, b) => b.platforms.length - a.platforms.length || a.label.localeCompare(b.label))
  }

  /** Save answers ({ key: value }) as approved facts, then retry every platform waiting on any of them. */
  function answer(answers = {}) {
    const open = new Map(list().map(g => [g.key, g]))
    const saved = [], retried = new Set(), errors = []
    const upsert = db.prepare(`INSERT INTO company_information (field, value, approved, approved_at, updated_at) VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(field) DO UPDATE SET value = excluded.value, approved = 1, approved_at = excluded.approved_at, updated_at = excluded.updated_at`)
    for (const [rawKey, rawValue] of Object.entries(answers)) {
      const key = slugOf(rawKey), value = String(rawValue ?? '').trim().slice(0, 2000)
      if (!key || !value) continue
      const at = now()
      upsert.run(`extra_${key}`, value, at, at)
      saved.push(key)
      for (const p of open.get(key)?.platforms || []) {
        if (retried.has(p.id)) continue
        try { orchestrator.retryPlatform(p.id, { actor: 'operator' }); retried.add(p.id) } catch (e) { errors.push(`${p.name}: ${e.message}`) }
      }
    }
    if (saved.length) activity.success('profile_gap_answered', `Profile facts added (${saved.join(', ')}); ${retried.size} platform${retried.size === 1 ? '' : 's'} retried`)
    return { saved, retried: retried.size, errors }
  }

  return { list, answer }
}
