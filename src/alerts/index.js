// Alerts and notifications: an activity entry always, plus Slack and/or an email webhook when configured.
//   ALERT_SLACK_WEBHOOK   Slack incoming-webhook URL
//   ALERT_EMAIL_WEBHOOK   a URL that receives JSON { to, subject, text, link } and sends the email (e.g. a viaSocket flow);
//                         Gmail stays read-only, so the agent never sends mail itself
//   ALERT_EMAIL_TO        defaults to support@docstar.io
//   PUBLIC_URL            the dashboard address used in links (defaults to the hosted URL, else localhost)
// Each alert has a key: the same key alerts once per `everyMs` (default 6 h), not every minute.
import { now } from '../db/index.js'
import { maskText } from '../security/mask.js'
import { SUPPORT_EMAIL } from '../agent/brand.js'

export function createAlerts({ db, activity, env = process.env, fetchImpl = fetch }) {
  const slack = env.ALERT_SLACK_WEBHOOK || null
  const email = env.ALERT_EMAIL_WEBHOOK || null
  const to = env.ALERT_EMAIL_TO || `${SUPPORT_EMAIL}`
  const publicUrl = (env.PUBLIC_URL || env.HOSTED_URL || `http://localhost:${env.PORT || 4000}`).replace(/\/+$/, '')
  const sent = []

  async function deliver(subject, text, link) {
    const out = []
    const body = `${subject}\n${text}${link ? `\n${link}` : ''}`
    if (slack) {
      try {
        const r = await fetchImpl(slack, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: body }), signal: AbortSignal.timeout(10_000) })
        out.push(r.ok ? 'slack' : `slack failed (HTTP ${r.status})`)
      } catch (e) { out.push(`slack failed (${e.message})`) }
    }
    if (email) {
      try {
        const r = await fetchImpl(email, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to, subject, text, link }), signal: AbortSignal.timeout(10_000) })
        out.push(r.ok ? 'email' : `email failed (HTTP ${r.status})`)
      } catch (e) { out.push(`email failed (${e.message})`) }
    }
    return out
  }

  return {
    configured: () => ({ slack: Boolean(slack), email: Boolean(email), to }),
    link: (hash = '') => `${publicUrl}/${hash.startsWith('#') ? hash : hash ? `#${hash}` : ''}`,
    publicUrl,
    sent,

    /** Send once per key per `everyMs`. Returns false when it was sent recently. */
    send(key, subject, text, { level = 'warn', link = null, everyMs = 6 * 3600_000 } = {}) {
      const last = db.prepare('SELECT at FROM alerts_sent WHERE key = ?').get(key)?.at
      if (last && Date.now() - Date.parse(last) < everyMs) return false
      db.prepare(`INSERT INTO alerts_sent (key, channel, message, at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET at = excluded.at, message = excluded.message`)
        .run(key, [slack && 'slack', email && 'email'].filter(Boolean).join(',') || 'log', maskText(subject).slice(0, 300), now())
      activity[level === 'error' ? 'error' : level === 'info' ? 'info' : 'warn']('alert', `${subject}${text ? ` — ${text.split('\n')[0]}` : ''}`, { meta: { key, link } })
      sent.push({ key, subject, text, link })
      if (slack || email) deliver(subject, maskText(text), link).then(r => { if (r.some(x => /failed/.test(x))) activity.warn('alert_delivery_failed', `Alert "${subject}" could not be delivered: ${r.join(', ')}`) })
      return true
    }
  }
}
