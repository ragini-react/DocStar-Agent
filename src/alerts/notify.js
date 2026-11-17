// Instant notification for every new needs-you item: what happened, what to do, a deep link to the Needs-you page and a
// one-click Resume link. The Resume link carries a signed, expiring, single-use token; opening it shows a confirmation
// page (a GET never changes anything) whose button resumes the platform. On a hosted copy the resume is queued for the
// agent like any other change. The token is signed with the sync token both sides share (or the master key without a
// mirror), so a link works on whichever dashboard the alert points to.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { now } from '../db/index.js'

const TTL_MS = 48 * 3600_000

export function createTokens({ db, secret }) {
  const key = createHmac('sha256', String(secret)).update('docstar-action-links').digest()
  const sig = body => createHmac('sha256', key).update(body).digest('base64url')
  return {
    sign(platformId, action = 'resume', { ttlMs = TTL_MS } = {}) {
      const body = `${action}.${platformId}.${Date.now() + ttlMs}.${randomBytes(9).toString('base64url')}`
      return `${body}.${sig(body)}`
    },
    /** Returns { action, platformId, jti } or throws. `consume` marks it used (single use). */
    verify(token, { consume = false } = {}) {
      const parts = String(token || '').split('.')
      if (parts.length !== 5) throw Object.assign(new Error('This link is not valid'), { status: 400 })
      const [action, pid, exp, jti, s] = parts
      const expected = Buffer.from(sig(parts.slice(0, 4).join('.')))
      const given = Buffer.from(s)
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw Object.assign(new Error('This link is not valid'), { status: 400 })
      if (Number(exp) < Date.now()) throw Object.assign(new Error('This link has expired; open the dashboard instead'), { status: 410 })
      if (db.prepare('SELECT 1 FROM action_tokens_used WHERE jti = ?').get(jti)) throw Object.assign(new Error('This link was already used'), { status: 409 })
      if (consume) db.prepare('INSERT INTO action_tokens_used (jti, at) VALUES (?, ?)').run(jti, now())
      return { action, platformId: Number(pid), jti }
    }
  }
}

export function attachNeedsYouNotifications({ status, alerts, tokens }) {
  return status.onChange(e => {
    if (e.to !== 'needs_you' || !e.needsYou) return
    const token = tokens.sign(e.platformId, 'resume')
    const resume = `${alerts.publicUrl}/r/${token}`
    alerts.send(`needs-you:${e.platformId}:${e.needsYou.what}`.slice(0, 200), `Needs you: ${e.name}`,
      `What happened: ${e.needsYou.what}\nWhat to do: ${e.needsYou.todo || 'Open the dashboard.'}${e.needsYou.where ? `\nWhere: ${e.needsYou.where}` : ''}\nResume when done: ${resume}`,
      { level: 'warn', link: alerts.link('queue'), everyMs: 3600_000 })
  })
}

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
export const actionPage = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>:root{color-scheme:light dark}body{font:15px/1.5 -apple-system,system-ui,sans-serif;max-width:520px;margin:48px auto;padding:0 16px;background:Canvas;color:CanvasText}
button{font:inherit;padding:9px 16px;border-radius:8px;border:0;background:#3b5bdb;color:#fff;cursor:pointer}.muted{opacity:.7}</style></head><body><h1>${esc(title)}</h1>${body}</body></html>`
export { esc }
