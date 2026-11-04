// Pure helpers for verification emails: no I/O, so they are unit-tested offline.

export function senderDomain(from) {
  const m = String(from || '').match(/@([A-Za-z0-9.-]+\.[A-Za-z]{2,})>?\s*$/)
  return m ? m[1].toLowerCase() : null
}

const VERIFY_WORDS = /verif|confirm|activat|validate|magic|sign.?in|log.?in/i

/** Pure: from an email body, the best https link on the platform's own domain, or null. */
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
    if (url.protocol !== 'https:') continue
    if (host !== domain && !host.endsWith(`.${domain}`)) continue
    if (/unsubscribe|privacy|terms|preferences/i.test(url.pathname + c.text)) continue
    valid.push({ link: url.toString(), host, score: (VERIFY_WORDS.test(c.text) ? 2 : 0) + (VERIFY_WORDS.test(url.pathname + url.search) ? 1 : 0) })
  }
  valid.sort((a, b) => b.score - a.score)
  const best = valid.find(v => v.score > 0)
  return best ? { link: best.link, host: best.host } : null
}
