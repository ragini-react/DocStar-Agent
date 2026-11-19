import { BRAND_SLUG } from '../agent/brand.js'
// Domains: normalized before anything is inserted (lowercase, no www., the final domain after redirects) and compared
// by registrable domain (eTLD+1), so g2crowd.com → g2.com or www.example.co.uk / app.example.co.uk are one platform.
// Hosts that serve many unrelated sites (github.com, medium.com …) keep their full host (and path owner) as the key.

// Multi-part public suffixes common for directory sites (a compact list, not the full Public Suffix List).
const MULTI = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.in', 'net.in', 'org.in', 'co.jp', 'ne.jp',
  'com.br', 'com.mx', 'com.ar', 'com.tr', 'com.sg', 'com.my', 'com.hk', 'com.tw', 'com.cn', 'co.za', 'co.kr', 'co.id', 'com.ph', 'com.pk', 'com.ng',
  'com.eg', 'com.sa', 'com.ua', 'co.il', 'com.co', 'com.pe', 'com.vn', 'eu.org', 'github.io', 'gitlab.io', 'vercel.app', 'netlify.app', 'pages.dev',
  'herokuapp.com', 'web.app', 'firebaseapp.com', 'notion.site', 'substack.com', 'blogspot.com', 'wordpress.com', 'carrd.co', 'framer.website', 'webflow.io'])
// Shared hosts: many unrelated listings live under one domain; the first path segment tells them apart.
export const SHARED_HOSTS = new Set(['github.com', 'gitlab.com', 'medium.com', 'dev.to', 'reddit.com', 'news.ycombinator.com', 'producthunt.com', 'notion.so', 'google.com', 'sites.google.com'])

export function normalizeHost(host) {
  return String(host || '').trim().toLowerCase().replace(/\.$/, '').replace(/^www\d?\./, '')
}

/** Pure: the registrable domain (eTLD+1) of a host. */
export function registrableDomain(host) {
  const h = normalizeHost(host)
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || !h.includes('.')) return h
  const parts = h.split('.')
  const last2 = parts.slice(-2).join('.')
  if (MULTI.has(last2) && parts.length >= 3) return parts.slice(-3).join('.')
  return last2
}

/** Pure: the key two records must not share. Shared hosts keep host + first path segment (github.com/thechangelog). */
export function siteKey(url) {
  const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`)
  const host = normalizeHost(u.hostname)
  if (SHARED_HOSTS.has(host) || SHARED_HOSTS.has(registrableDomain(host))) {
    const seg = u.pathname.split('/').filter(Boolean)[0]
    return seg ? `${host}/${seg.toLowerCase()}` : host
  }
  return registrableDomain(host)
}

/** Follow redirects (HTTP only, no browser) to the final host. Falls back to the input on any error. */
export async function resolveFinalUrl(url, { fetchImpl = fetch, hops = 6, timeoutMs = 8_000 } = {}) {
  let cur = url
  try {
    for (let i = 0; i < hops; i++) {
      const res = await fetchImpl(cur, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': `Mozilla/5.0 ${BRAND_SLUG}Agent` } })
      const loc = res.headers.get('location')
      if (!(res.status >= 300 && res.status < 400 && loc)) break
      cur = new URL(loc, cur).toString()
    }
  } catch { return url }
  return cur
}

/** Pure: a platform name without discovery noise ("BetaList alternative: Launching Next" → "Launching Next"). */
export function cleanName(name) {
  let n = String(name || '').trim().replace(/\s+/g, ' ')
  n = n.replace(/^.{2,40}?\b(alternative|alternatives|like|vs\.?)\s*[:\-–—]\s*/i, '')
  n = n.replace(/\s*[-–—|]\s*(home|homepage|official site|website)$/i, '')
  return n.slice(0, 80)
}
