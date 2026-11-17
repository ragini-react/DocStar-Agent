// Repairs added by later parts, run inside the one-time repair (src/db/repair.js). Each step: { name, run(db, ctx) → string[] }.
import { now, numSetting } from './index.js'
import { cleanName, siteKey } from '../platforms/domains.js'
import { mergePlatforms, pickKeeper } from '../platforms/merge.js'
import { label } from '../engine/stateMachine.js'

// Wrong domains and names known from the records (the old domain → the right one).
export const DOMAIN_FIXES = {
  'appiod.com': { domain: 'appoid.com', url: 'https://appoid.com/' },
  'angel.co': { domain: 'wellfound.com', url: 'https://wellfound.com/', name: 'Wellfound (formerly AngelList)' },
  'g2crowd.com': { domain: 'g2.com', url: 'https://www.g2.com/' }
}
// A platform recorded under a host that is not its own (The Changelog was saved as github.com).
export const NAME_DOMAINS = { 'the changelog': { domain: 'changelog.com', url: 'https://changelog.com/' } }

const latestScore = (db, id) => db.prepare(`SELECT overall FROM platform_scores WHERE platform_id = ? AND overall IS NOT NULL ORDER BY scored_at DESC, id DESC LIMIT 1`).get(id)?.overall ?? null

/** Pure: a structured reason from the free-text notes old records carry. */
export function reasonFromNotes(status, notes = '') {
  const n = String(notes || '')
  if (/^duplicate/i.test(n)) return 'duplicate'
  if (/quality \d+ below/i.test(n)) return 'low_score'
  if (/^paid|requires payment|paid/i.test(n) && status === 'paid_skipped') return 'paid_only'
  if (/^policy|prohibit|terms|automated/i.test(n)) return 'policy'
  if (/not a legitimate/i.test(n)) return 'not_legitimate'
  if (/does not accept submissions/i.test(n)) return 'not_accepting'
  if (/^not_possible|^not_relevant|^already/i.test(n)) return 'not_possible'
  if (/rejected by operator|skipped by operator|by you/i.test(n)) return 'operator'
  if (/could not evaluate|could not read/i.test(n)) return 'evaluation_failed'
  return status === 'paid_skipped' ? 'paid_only' : 'unknown'
}

export const repairSteps = [
  {
    name: 'Domains, names and duplicates',
    run(db, { activity }) {
      const out = []
      // 1. Names with discovery noise, wrong domains.
      for (const p of db.prepare('SELECT id, name, domain, url FROM platforms').all()) {
        const fix = DOMAIN_FIXES[p.domain] || NAME_DOMAINS[p.name.toLowerCase()]
        const name = fix?.name || cleanName(p.name)
        if (name !== p.name) { db.prepare('UPDATE platforms SET name = ? WHERE id = ?').run(name, p.id); out.push(`"${p.name}" renamed "${name}"`) }
        if (fix && fix.domain !== p.domain) {
          const clash = db.prepare('SELECT id, name, status FROM platforms WHERE domain = ? AND id <> ?').get(fix.domain, p.id)
          if (clash) {
            const [keep, dup] = pickKeeper(clash, db.prepare('SELECT id, name, status FROM platforms WHERE id = ?').get(p.id))
            mergePlatforms(db, keep.id, dup.id, { reason: `${p.domain} is ${fix.domain}`, activity })
            out.push(`${p.domain} is ${fix.domain}: ${dup.name} merged into ${keep.name}, history kept`)
          } else {
            db.prepare('UPDATE platforms SET domain = ?, url = ? WHERE id = ?').run(fix.domain, fix.url, p.id)
            out.push(`${name}: domain ${p.domain} corrected to ${fix.domain}`)
          }
        }
      }
      // 2. Registrable-domain keys; records that share one (or the exact same name) are one platform.
      for (const p of db.prepare('SELECT id, url FROM platforms').all()) {
        try { db.prepare('UPDATE platforms SET site_key = ? WHERE id = ?').run(siteKey(p.url), p.id) } catch {}
      }
      const groups = db.prepare(`SELECT site_key k FROM platforms WHERE site_key IS NOT NULL GROUP BY site_key HAVING COUNT(*) > 1
        UNION SELECT LOWER(name) k FROM platforms GROUP BY LOWER(name) HAVING COUNT(*) > 1`).all()
      for (const { k } of groups) {
        const rows = db.prepare('SELECT id, name, domain, status FROM platforms WHERE site_key = ? OR LOWER(name) = ? ORDER BY id').all(k, k)
        while (rows.length > 1) {
          const [keep, dup] = pickKeeper(rows[0], rows[1])
          mergePlatforms(db, keep.id, dup.id, { reason: `same site (${k})`, activity })
          out.push(`${dup.name} (${dup.domain}) merged into ${keep.name} (${keep.domain}): same site; history kept`)
          rows.splice(rows.indexOf(dup), 1)
        }
      }
      return out
    }
  },
  {
    name: 'Sources',
    run(db) {
      // "discovered" says nothing: the query of the discovery run that found each one.
      const runs = db.prepare(`SELECT ts, message FROM activity_logs WHERE event = 'discovery_run' ORDER BY ts`).all()
        .map(r => ({ ts: r.ts, query: r.message.match(/"([^"]+)"/)?.[1] })).filter(r => r.query)
      let n = 0
      for (const p of db.prepare(`SELECT id, created_at FROM platforms WHERE source = 'discovered'`).all()) {
        const run = [...runs].reverse().find(r => r.ts <= p.created_at)
        db.prepare('UPDATE platforms SET source = ? WHERE id = ?').run(run ? `discovery:${run.query}`.slice(0, 200) : 'discovery:unknown query', p.id)
        n++
      }
      return n ? [`${n} platform(s): source "discovered" replaced by the discovery query that found them`] : []
    }
  },
  {
    name: 'Scores and reasons',
    run(db, { status, orchestrator }) {
      const out = []
      const min = numSetting(db, 'min_quality_score', 55)
      for (const p of db.prepare(`SELECT id, name, status, status_reason, notes FROM platforms WHERE status IN ('rejected','paid_skipped','evaluation_failed')`).all()) {
        const score = latestScore(db, p.id)
        // Near-zero scores are failed evaluations, not judgements: evaluated again.
        if (score !== null && score <= 4 && p.status === 'rejected') {
          status.transition(p.id, 'evaluation_failed', { actor: 'migration', force: true, statusReason: 'evaluation_failed', reason: `score ${score} looks like a failed evaluation (${p.notes || 'no reason'}); evaluated again` })
          db.prepare(`UPDATE automation_tasks SET state = 'cancelled', updated_at = ? WHERE platform_id = ? AND type = 'qualify' AND state = 'done'`).run(now(), p.id)
          orchestrator.enqueue(p.id, 'qualify', { checkpoint: { force: true } })
          out.push(`${p.name}: score ${score} treated as a failed evaluation; re-evaluation queued`)
          continue
        }
        const reason = p.status_reason || (p.status === 'evaluation_failed' ? 'evaluation_failed' : reasonFromNotes(p.status, p.notes))
        // One threshold rule (score ≥ minimum qualifies), applied to every old rejection.
        if (p.status === 'rejected' && reason === 'low_score' && score !== null && score >= min) {
          status.transition(p.id, 'qualified', { actor: 'migration', force: true, reason: `score ${score} meets the minimum ${min} (was rejected under an inconsistent rule)` })
          out.push(`${p.name}: score ${score} ≥ ${min} → qualified (the threshold is now applied the same way everywhere)`)
          continue
        }
        // A judgement call ("does not accept submissions") on a site that scores above the minimum: checked again.
        if (p.status === 'rejected' && reason === 'not_accepting' && score !== null && score >= min) {
          status.transition(p.id, 'discovered', { actor: 'migration', operator: true, reason: `score ${score} ≥ ${min} but rejected as "does not accept submissions"; evaluated again` })
          db.prepare(`UPDATE automation_tasks SET state = 'cancelled', updated_at = ? WHERE platform_id = ? AND type = 'qualify' AND state = 'done'`).run(now(), p.id)
          orchestrator.enqueue(p.id, 'qualify', { checkpoint: { force: true } })
          out.push(`${p.name}: score ${score} but rejected as "does not accept submissions" — re-evaluation queued`)
          continue
        }
        if (reason !== p.status_reason) {
          db.prepare('UPDATE platforms SET status_reason = ? WHERE id = ?').run(reason, p.id)
          out.push(`${p.name}: ${label(p.status).toLowerCase()} — reason recorded as "${label(reason)}"`)
        }
      }
      return out
    }
  }
]
