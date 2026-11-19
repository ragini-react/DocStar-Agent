import { MENTION } from '../agent/brand.js'
// Pure helpers for platform emails: no I/O, so they are unit-tested offline.

export function senderDomain(from) {
  const m = String(from || '').match(/@([A-Za-z0-9.-]+\.[A-Za-z]{2,})>?\s*$/)
  return m ? m[1].toLowerCase() : null
}

const VERIFY_WORDS = /verif|confirm|activat|validate|magic|sign.?in|log.?in/i
// Click-tracking redirects that email services wrap links in. Such a link counts only if it resolves to the platform.
export const TRACKER_HOSTS = /(^|\.)(sendgrid\.net|mandrillapp\.com|list-manage\.com|mailchi\.mp|mailgun\.org|mailgun\.net|customeriomail\.com|customer\.io|hubspotlinks\.com|hs-sites\.com|mjt\.lu|awstrack\.me|sparkpostmail\.com|pstmrk\.it|mtasv\.net|convertkit-mail\d?\.com|ck\.page|klclick\d?\.com|brevo\.com|sendibt\d\.com|sendinblue\.com|mlsend\.com|beehiiv\.com|loops\.so|resend\.dev|postmarkapp\.com)$/i
const onDomain = (host, domain) => host === domain || host.endsWith(`.${domain}`)

/**
 * Pure: from an email body, the best https link on the platform's own domain, or (second best) a link through a known
 * email-tracking redirect, which the caller must resolve to the platform's domain before using. Returns
 * { link, host, tracker } or null.
 */
export function pickVerificationLink(body, domain) {
  const html = String(body?.html || '')
  const plain = String(body?.plain || '')
  const candidates = []
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    candidates.push({ href: m[1].replace(/&amp;/g, '&'), text: m[2].replace(/<[^>]+>/g, ' ') })
  }
  for (const m of plain.matchAll(/https:\/\/[^\s<>"')\]]+/g)) candidates.push({ href: m[0], text: '' })

  const valid = []
  for (const c of candidates) {
    let url
    try { url = new URL(c.href) } catch { continue }
    const host = url.hostname.toLowerCase()
    // https only; plain http only for this machine itself (the local test platform).
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && /^(127\.0\.0\.1|localhost)$/.test(host))) continue
    const own = onDomain(host, domain)
    const tracker = !own && TRACKER_HOSTS.test(host)
    if (!own && !tracker) continue
    if (/unsubscribe|privacy|terms|preferences/i.test(url.pathname + c.text)) continue
    const score = (VERIFY_WORDS.test(c.text) ? 2 : 0) + (own && VERIFY_WORDS.test(url.pathname + url.search) ? 1 : 0)
    valid.push({ link: url.toString(), host, tracker, score: score - (tracker ? 0.5 : 0) })
  }
  valid.sort((a, b) => b.score - a.score)
  const best = valid.find(v => v.score > 0 && (!v.tracker || v.score >= 1.5))
  return best ? { link: best.link, host: best.host, tracker: best.tracker } : null
}

/** Pure: what a platform's email says about the listing. */
export function classifyEmail({ subject = '', text = '' } = {}) {
  const s = `${subject}\n${String(text).slice(0, 2000)}`
  if (/verify|confirm (your )?(email|account)|activate (your )?account|magic link|sign.?in link/i.test(subject)) return 'verification'
  if (/(not (been )?approved|rejected|declined|unable to (approve|publish|list)|did not meet|doesn.t meet|not a fit|was removed)/i.test(s)) return 'rejected'
  if (/(is (now )?live|has been published|now listed|is now available|went live|is live on)/i.test(s)) return 'live'
  if (/(has been approved|was approved|approved your|accepted your (submission|listing|tool|product))/i.test(s)) return 'approved'
  if (/(received your (submission|listing)|under review|in (the )?review queue|we.ll review)/i.test(s)) return 'received'
  return 'other'
}

/** Pure: the first public URL in an email on the platform's domain that looks like the listing (for "is live" emails). */
export function listingUrlFromEmail(body, domain) {
  const html = String(body?.html || '') + '\n' + String(body?.plain || '')
  const urls = [...html.matchAll(/https:\/\/[^\s<>"')\]]+/g)].map(m => m[0].replace(/&amp;/g, '&'))
  return urls.find(u => { try { const x = new URL(u); return onDomain(x.hostname, domain) && MENTION.test(x.pathname) } catch { return false } }) || null
}
