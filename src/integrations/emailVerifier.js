// Email verification without a person. After a step that sends an email, Gmail (read-only) is searched for mail from the
// platform's domain — inbox and spam — every 25 seconds for the platform's expiry window. The verification link must
// point to the platform's domain, or to a known email-tracking redirect that resolves there. It is opened in the agent's
// Chrome and the result is checked. Halfway through the window, "resend" is pressed once. Only when no email arrives
// after that does the task go to a person, with exactly what to look for.
// Logged: sender (masked), subject and time of each email used. Never the link or the body.
import { now } from '../db/index.js'
import { maskText } from '../security/mask.js'
import { settle } from '../browser/pageGuard.js'
import { classifyEmail, pickVerificationLink } from './verificationLinks.js'

const POLL_MS = 25_000
const DEFAULT_WINDOW_MIN = 15
const RESEND = /^(resend|send (it |the email |a new (link|email) )?again|didn.t (get|receive)|request a new (link|email)|send new (link|code))/i

/** Follow a tracking redirect without opening it in a browser: the final host must be the platform's. */
export async function resolveTracker(url, domain, { fetchImpl = fetch, hops = 6 } = {}) {
  let cur = url
  for (let i = 0; i < hops; i++) {
    const host = new URL(cur).hostname.toLowerCase()
    if (host === domain || host.endsWith(`.${domain}`)) return cur
    const res = await fetchImpl(cur, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(10_000) })
    const loc = res.headers.get('location')
    if (!(res.status >= 300 && res.status < 400 && loc)) return null
    cur = new URL(loc, cur).toString()
    if (new URL(cur).protocol !== 'https:') return null
  }
  return null
}

export function createEmailVerifier({ db, gmail, activity, vault, status, playbooks = null, sleep = ms => new Promise(r => setTimeout(r, ms)), pollMs = POLL_MS, fetchImpl = fetch, windowMin: fixedWindow = null }) {
  function recordEmail(platformId, e, purpose) {
    db.prepare(`INSERT INTO emails_used (platform_id, message_id, sender, subject, received_at, purpose) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(platform_id, message_id) DO UPDATE SET purpose = excluded.purpose`)
      .run(platformId, e.id, maskText(e.from || ''), maskText(e.subject || '').slice(0, 200), e.receivedAt || null, purpose)
  }

  async function clickResend(page) {
    for (const loc of [page.getByRole('button', { name: RESEND }), page.getByRole('link', { name: RESEND })]) {
      const el = loc.first()
      if (await el.count() && await el.isVisible().catch(() => false)) {
        await el.click({ timeout: 10_000 }).catch(() => {})
        await settle(page)
        return true
      }
    }
    return false
  }

  /**
   * @returns {Promise<{ ok: true } | { ok: false, reason: string, todo: string }>}
   */
  async function verify({ platform: p, task, ctx, page, account }) {
    const windowMin = fixedWindow || playbooks?.get(p.id)?.emailExpiryMin || DEFAULT_WINDOW_MIN
    // Emails sent since the sign-up started (a little earlier, for clock drift), never older than an hour.
    const since = new Date(Math.max(Date.parse(account?.created_at || now()) - 2 * 60_000, Date.now() - 3600_000)).toISOString()
    const row = db.prepare(`INSERT INTO email_verifications (platform_id, account_id, sender_domain) VALUES (?, ?, ?) RETURNING id`).get(p.id, account?.id ?? null, p.domain)
    if (account) db.prepare(`UPDATE accounts SET status = 'email_verification_pending', updated_at = ? WHERE id = ?`).run(now(), account.id)
    if (db.prepare('SELECT status FROM platforms WHERE id = ?').get(p.id).status !== 'email_verification_pending') {
      ctx.setStatus('email_verification_pending', { reason: `waiting for the verification email from ${p.domain}` })
    }
    const deadline = Date.now() + windowMin * 60_000
    const resendAt = Date.now() + (windowMin * 60_000) / 2
    let resent = false
    let polls = 0
    const tried = new Set()
    while (Date.now() < deadline) {
      polls++
      let emails = []
      try { emails = await gmail.searchPlatform({ domain: p.domain, since, includeSpam: true }) } catch (e) {
        ctx.log('warn', 'gmail_search_failed', `${p.name}: Gmail search failed (${e.message}); trying again`)
      }
      for (const e of emails) {
        if (tried.has(e.id)) continue
        tried.add(e.id)
        const kind = classifyEmail({ subject: e.subject, text: e.body?.plain || '' })
        const picked = pickVerificationLink(e.body, p.domain)
        if (!picked) { recordEmail(p.id, e, kind === 'verification' ? 'verification' : kind); continue }
        recordEmail(p.id, e, 'verification')
        let link = picked.link
        if (picked.tracker) {
          const final = await resolveTracker(link, p.domain, { fetchImpl }).catch(() => null)
          if (!final) { ctx.log('warn', 'verification_link_refused', `${p.name}: a link in "${maskText(e.subject)}" goes through ${picked.host} but does not lead to ${p.domain}; not opened`); continue }
        }
        ctx.log('success', 'verification_email', `${p.name}: verification email found (${e.spam ? 'in spam, ' : ''}"${maskText(e.subject)}", received ${e.receivedAt || 'just now'})`)
        db.prepare(`UPDATE email_verifications SET status = 'found', link_host = ?, link_enc = ? WHERE id = ?`).run(new URL(link).hostname, vault.encrypt(link), row.id)
        // Opened in the agent's own Chrome (its session is the one being verified).
        await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        await settle(page)
        const landed = new URL(page.url()).hostname
        const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '')
        if (!(landed === p.domain || landed.endsWith(`.${p.domain}`)) || /expired|invalid (link|token)|link (is )?no longer valid|something went wrong/i.test(text)) {
          ctx.log('warn', 'verification_link_failed', `${p.name}: the verification link opened but the page says it did not work`)
          db.prepare(`UPDATE email_verifications SET status = 'rejected' WHERE id = ?`).run(row.id)
          continue // a newer email (after resend) may still come
        }
        db.prepare(`UPDATE email_verifications SET status = 'verified', verified_at = ? WHERE id = ?`).run(now(), row.id)
        playbooks?.update(p.id, { gotchas: e.spam ? [`${p.name}'s emails land in spam`] : [] })
        return { ok: true }
      }
      if (!resent && Date.now() >= resendAt && page) {
        resent = await clickResend(page)
        if (resent) ctx.log('info', 'verification_resent', `${p.name}: no email yet; pressed "resend" once`)
      }
      ctx.checkpoint('waiting_for_email', { ...JSON.parse(db.prepare('SELECT checkpoint FROM automation_tasks WHERE id = ?').get(task.id)?.checkpoint || '{}'), waiting: true })
      if (Date.now() + pollMs > deadline) break
      await sleep(pollMs)
    }
    db.prepare(`UPDATE email_verifications SET status = 'not_found' WHERE id = ?`).run(row.id)
    return {
      ok: false,
      reason: `No verification email from ${p.domain} arrived within ${windowMin} minutes (${polls} searches of inbox and spam${resent ? ', after pressing resend once' : ''})`,
      todo: `Search Gmail for support@docstar.io for "from:${p.domain}" (inbox and spam). If the email is there, open its link in the agent's Chrome, then press Resume. If it is not, press Resume and the agent asks for a new one.`
    }
  }

  return { verify, recordEmail }
}
