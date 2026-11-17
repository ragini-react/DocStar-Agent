// What worked on each platform, learned from every run and given to the next attempt: the sign-in method, the fields
// the form required, uploads it asked for, and gotchas (a field the page resets, a button that needs two clicks).
import { now } from '../db/index.js'

const uniq = arr => [...new Set(arr.filter(Boolean))]

export function createPlaybooks({ db }) {
  const get = pid => { try { return JSON.parse(db.prepare('SELECT data FROM platform_playbooks WHERE platform_id = ?').get(pid)?.data || 'null') } catch { return null } }

  function update(pid, patch) {
    const cur = get(pid) || { requiredFields: [], filledFields: [], uploads: [], gotchas: [], runs: 0 }
    const next = {
      ...cur,
      ...Object.fromEntries(Object.entries(patch).filter(([k, v]) => v !== undefined && !['requiredFields', 'filledFields', 'uploads', 'gotchas'].includes(k))),
      requiredFields: uniq([...(cur.requiredFields || []), ...(patch.requiredFields || [])]).slice(0, 40),
      filledFields: uniq([...(cur.filledFields || []), ...(patch.filledFields || [])]).slice(0, 40),
      uploads: uniq([...(cur.uploads || []), ...(patch.uploads || [])]).slice(0, 10),
      gotchas: uniq([...(cur.gotchas || []), ...(patch.gotchas || [])]).slice(-15)
    }
    db.prepare(`INSERT INTO platform_playbooks (platform_id, data, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(platform_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`).run(pid, JSON.stringify(next), now())
    return next
  }

  return {
    get,
    update,
    /** The playbook as a few lines for the AI's message. */
    brief(pid) {
      const p = get(pid)
      if (!p) return 'No earlier runs on this platform.'
      return [
        p.signinMethod && `Sign-in that worked: ${p.signinMethod}.`,
        p.submitUrl && `Listing form: ${p.submitUrl}.`,
        p.requiredFields?.length && `Required fields seen: ${p.requiredFields.join(', ')}.`,
        p.uploads?.length && `Uploads asked for: ${p.uploads.join(', ')}.`,
        p.gotchas?.length && `Gotchas: ${p.gotchas.join(' | ')}.`,
        p.lastOutcome && `Last run: ${p.lastOutcome}${p.lastRunAt ? ` (${p.lastRunAt.slice(0, 10)})` : ''}.`
      ].filter(Boolean).join('\n')
    }
  }
}
