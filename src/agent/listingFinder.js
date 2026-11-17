// Finds DocStar's listing on a platform: before every submission (so nothing is listed twice) and after it (to move the
// platform to published without anyone pasting a URL). It tries the usual listing URLs, the site's own search, and a
// web search; a candidate counts only if the page itself names DocStar or links to docstar.io. robots.txt is honoured.
import { fetchPage } from './fetchPage.js'

const PATHS = ['/product/docstar', '/products/docstar', '/tool/docstar', '/tools/docstar', '/software/docstar', '/p/docstar', '/listing/docstar',
  '/listings/docstar', '/app/docstar', '/apps/docstar', '/startup/docstar', '/startups/docstar', '/s/docstar', '/docstar', '/item/docstar', '/api/docstar']
const SEARCH = ['/search?q=docstar', '/search?query=docstar', '/?s=docstar', '/search/docstar']
const MENTION = /docstar/i

/** Pure: whether a robots.txt allows `path` for a generic agent (longest matching rule wins). */
export function robotsAllows(txt, path) {
  let applies = false
  const rules = []
  for (const raw of String(txt || '').split('\n')) {
    const line = raw.replace(/#.*/, '').trim()
    const m = line.match(/^(user-agent|allow|disallow)\s*:\s*(.*)$/i)
    if (!m) continue
    const [, k, v] = m
    if (/user-agent/i.test(k)) { applies = v.trim() === '*'; continue }
    if (applies && v) rules.push({ allow: /allow/i.test(k) && !/disallow/i.test(k), path: v.trim() })
  }
  const match = rules.filter(r => path.startsWith(r.path.replace(/\*$/, ''))).sort((a, b) => b.path.length - a.path.length)[0]
  return match ? match.allow : true
}

/** Pure: does this page show DocStar's listing? */
export function looksLikeListing(page) {
  const links = page.links || []
  const linksToUs = links.some(l => { try { return /(^|\.)docstar\.io$/i.test(new URL(l.href).hostname) } catch { return false } })
  return page.status >= 200 && page.status < 300 && (MENTION.test(page.title || '') || (linksToUs && MENTION.test(page.text || '')))
}

export function createListingFinder({ ai = null, fetchImpl = fetchPage, allowPrivate = false } = {}) {
  const robotsCache = new Map()
  async function allowed(origin, path) {
    if (!robotsCache.has(origin)) {
      const r = await fetchImpl(`${origin}/robots.txt`, { timeoutMs: 10_000, allowPrivate }).catch(() => null)
      robotsCache.set(origin, r && r.status === 200 ? r.html : '')
    }
    return robotsAllows(robotsCache.get(origin), path)
  }

  /** @returns {Promise<{ url: string, how: string } | null>} */
  async function find(platform, { useSearch = true } = {}) {
    const origin = new URL(platform.url).origin
    const tried = new Set()
    const check = async (url, how) => {
      if (tried.has(url)) return null
      tried.add(url)
      const u = new URL(url)
      if (u.origin === origin && !(await allowed(origin, u.pathname + u.search))) return null
      const page = await fetchImpl(url, { timeoutMs: 15_000, allowPrivate }).catch(() => null)
      return page && looksLikeListing(page) ? { url: page.url || url, how } : null
    }
    for (const p of PATHS) { const hit = await check(origin + p, 'listing URL'); if (hit) return hit }
    for (const p of SEARCH) {
      if (!(await allowed(origin, p))) continue
      const res = await fetchImpl(origin + p, { timeoutMs: 15_000, allowPrivate }).catch(() => null)
      if (!res || res.status !== 200) continue
      const candidates = (res.links || []).map(l => l.href).filter(h => { try { const u = new URL(h); return u.origin === origin && /docstar/i.test(u.pathname) } catch { return false } })
      for (const c of [...new Set(candidates)].slice(0, 5)) { const hit = await check(c, 'site search'); if (hit) return hit }
    }
    // A web search for the site and DocStar (results only; every URL is fetched and checked by us).
    if (useSearch && ai) {
      const text = await ai.text({ threadId: `find-${platform.domain}`, prompt: 'Use web search results only; do not open a browser. Reply with URLs only, one per line.',
        message: `site:${platform.domain} DocStar docstar.io — list up to 5 URLs on ${platform.domain} that are a page about DocStar (an API documentation product).` }).catch(() => '')
      const urls = [...new Set((text.match(/https?:\/\/[^\s)>\]"']+/g) || []).filter(u => { try { const h = new URL(u).hostname; return h === platform.domain || h.endsWith(`.${platform.domain}`) } catch { return false } }))]
      for (const u of urls.slice(0, 5)) { const hit = await check(u, 'web search'); if (hit) return hit }
    }
    return null
  }

  return { find }
}
