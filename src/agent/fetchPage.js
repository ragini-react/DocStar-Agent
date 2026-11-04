// Fetch a public web page for the agent to read: http(s) only, public hosts only (no localhost or private
// networks), size and time capped. Returns status, final URL, headers that matter, text, links and robots meta.
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

const MAX_BYTES = 2_000_000
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'

function privateAddress(ip) {
  if (isIP(ip) === 6) return /^(::1|fc|fd|fe80|::ffff:(10|127|169\.254|172\.(1[6-9]|2\d|3[01])|192\.168)\.)/i.test(ip) || ip === '::'
  return /^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip)
}

export async function assertPublicUrl(raw) {
  const url = new URL(raw)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`refused: ${url.protocol} URL`)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true })).map(a => a.address)
  if (!ips.length || ips.some(privateAddress)) throw new Error(`refused: ${host} is not a public host`)
  return url
}

export async function fetchPage(raw, { timeoutMs = 20_000, allowPrivate = false } = {}) {
  let url = allowPrivate ? new URL(raw) : await assertPublicUrl(raw)
  let res
  for (let hop = 0; hop < 6; hop++) {
    res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'en' }
    })
    const loc = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && loc) {
      url = allowPrivate ? new URL(loc, url) : await assertPublicUrl(new URL(loc, url).toString())
      continue
    }
    break
  }
  const type = res.headers.get('content-type') || ''
  let html = ''
  if (/html|xml|text/.test(type) && res.body) {
    const reader = res.body.getReader()
    const chunks = []
    let size = 0
    while (size < MAX_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      size += value.length
    }
    reader.cancel().catch(() => {})
    html = Buffer.concat(chunks).toString('utf8')
  }
  return { status: res.status, url: url.toString(), contentType: type, xRobotsTag: res.headers.get('x-robots-tag'), html, ...parseHtml(html, url) }
}

const decode = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&nbsp;/g, ' ')

/** Pure: title, meta description, robots meta, visible text and links (with rel and anchor text). */
export function parseHtml(html, base) {
  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim())
  const meta = name => decode(html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i'))?.[1]
    || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`, 'i'))?.[1] || '')
  const links = []
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = m[1]
    const href = attrs.match(/href\s*=\s*["']([^"']+)["']/i)?.[1]
    if (!href) continue
    let abs
    try { abs = new URL(decode(href), base).toString() } catch { continue }
    links.push({ href: abs, rel: (attrs.match(/rel\s*=\s*["']([^"']*)["']/i)?.[1] || '').toLowerCase(), text: decode(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() })
  }
  const text = decode(html
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim()
  return { title, description: meta('description') || meta('og:description'), robots: meta('robots').toLowerCase(), ogImage: meta('og:image'), text, links }
}
