// Independent backlink checks: fetch the listing page (Chrome when it blocks plain HTTP), find links to
// docstar.io, record rel / anchor / indexability, keep history, and flag links that disappear.
// A submission never counts as live until this check has seen the link.
import { getSetting, now } from '../db/index.js'
import { fetchPage } from './fetchPage.js'

const TARGET = /(^|\.)docstar\.io$/i

/** Pure: the best DocStar link on a page and what it is worth. */
export function analyseLinks(links, { robots = '', xRobotsTag = '' } = {}) {
  const ours = links.filter(l => { try { return TARGET.test(new URL(l.href).hostname) } catch { return false } })
  const rels = l => new Set(String(l.rel || '').toLowerCase().split(/\s+/).filter(Boolean))
  const best = ours.find(l => !['nofollow', 'sponsored', 'ugc'].some(r => rels(l).has(r))) ?? ours[0]
  const noindex = /noindex/i.test(robots) || /noindex/i.test(xRobotsTag || '')
  if (!best) return { present: false, indexable: !noindex }
  const r = rels(best)
  return {
    present: true,
    href: best.href,
    anchor: (best.text || '').slice(0, 200),
    rel: [...r].join(' '),
    dofollow: !r.has('nofollow') && !r.has('sponsored') && !r.has('ugc'),
    sponsored: r.has('sponsored'),
    ugc: r.has('ugc'),
    indexable: !noindex,
    count: ours.length
  }
}

export function createBacklinkChecker({ db, chrome, activity }) {
  async function read(url) {
    try {
      const p = await fetchPage(url, { timeoutMs: 20_000 })
      if (p.status < 400 && p.html.length > 500) return { status: p.status, links: p.links, robots: p.robots, xRobotsTag: p.xRobotsTag }
    } catch {}
    // Blocked or rendered by script: a plain visit in the agent's Chrome (none on a hosted copy).
    if (!chrome) return { status: 0, links: [], error: 'page blocks plain requests; it needs the browser check' }
    let page
    try {
      page = await (await chrome.context()).newPage()
      const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForTimeout(3000)
      const data = await page.evaluate(() => ({
        links: [...document.querySelectorAll('a[href]')].map(a => ({ href: a.href, rel: a.getAttribute('rel') || '', text: a.innerText.trim() })),
        robots: document.querySelector('meta[name="robots" i]')?.content || ''
      }))
      return { status: res?.status() ?? 0, ...data, xRobotsTag: (await res?.allHeaders())?.['x-robots-tag'] || '', viaChrome: true }
    } finally {
      await page?.close().catch(() => {})
    }
  }

  async function check(b) {
    const hours = Number(getSetting(db, 'backlink_check_hours', 12))
    const next = new Date(Date.now() + hours * 3600_000).toISOString()
    const sub = db.prepare('SELECT s.*, p.name, p.id pid FROM submissions s JOIN platforms p ON p.id = s.platform_id WHERE s.id = ?').get(b.submission_id)
    let page
    try { page = await read(b.page_url) } catch (e) { page = { status: 0, links: [], error: e.message } }
    const a = analyseLinks(page.links || [], page)
    const ok = page.status >= 200 && page.status < 400
    // No public listing URL yet (moderation queue): the link cannot be seen, so it stays pending, not missing.
    const status = a.present && ok ? 'live' : !sub.listing_url ? 'pending' : ok ? 'missing' : 'error'
    const wasLive = b.status === 'live'
    db.transaction(() => {
      db.prepare(`INSERT INTO backlink_history (backlink_id, http_status, link_present, rel, anchor_text, indexable, note) VALUES (?,?,?,?,?,?,?)`)
        .run(b.id, page.status || null, a.present ? 1 : 0, a.rel ?? null, a.anchor ?? null, a.indexable ? 1 : 0, page.viaChrome ? 'read in Chrome' : null)
      db.prepare(`UPDATE backlinks SET target_url = ?, anchor_text = ?, rel = ?, is_dofollow = ?, is_sponsored = ?, is_ugc = ?, http_status = ?,
          indexable = ?, status = ?, first_seen_at = COALESCE(first_seen_at, ?), last_checked_at = ?, next_check_at = ? WHERE id = ?`)
        .run(a.href ?? null, a.anchor ?? null, a.rel ?? null, a.present ? (a.dofollow ? 1 : 0) : null, a.present ? (a.sponsored ? 1 : 0) : null,
          a.present ? (a.ugc ? 1 : 0) : null, page.status || null, a.indexable ? 1 : 0, status, status === 'live' ? now() : null, now(), next, b.id)
      const platformStatus = status === 'live' ? 'live_backlink' : status === 'missing' ? 'no_backlink' : status === 'pending' ? 'pending_approval' : null
      if (platformStatus) db.prepare(`UPDATE platforms SET status = ?, updated_at = ? WHERE id = ?`).run(platformStatus, now(), sub.pid)
      if (status === 'live') db.prepare(`UPDATE submissions SET status = 'published', updated_at = ? WHERE id = ?`).run(now(), sub.id)
      if (status === 'pending') db.prepare(`UPDATE submissions SET status = 'pending_approval', updated_at = ? WHERE id = ?`).run(now(), sub.id)
    })()
    if (status === 'live') activity.success('backlink_verified', `${sub.name}: backlink live (${a.dofollow ? 'dofollow' : a.rel || 'nofollow'}, anchor "${a.anchor}")`, { platformId: sub.pid })
    else if (wasLive) activity.error('backlink_lost', `${sub.name}: backlink no longer found (HTTP ${page.status})`, { platformId: sub.pid })
    else activity.info('backlink_checked', `${sub.name}: ${status} (HTTP ${page.status || 'no answer'})`, { platformId: sub.pid })
    return { status, ...a, httpStatus: page.status }
  }

  return {
    check,
    async runDue(limit = 10) {
      const due = db.prepare(`SELECT * FROM backlinks WHERE next_check_at IS NULL OR next_check_at <= ? ORDER BY next_check_at LIMIT ?`).all(now(), limit)
      for (const b of due) {
        try { await check(b) } catch (e) { activity.error('backlink_check_failed', `Backlink check failed: ${e.message}`) }
      }
      return due.length
    },
    setListingUrl(platformId, url) {
      const u = new URL(url)
      if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) URLs')
      const sub = db.prepare('SELECT id FROM submissions WHERE platform_id = ?').get(platformId)
      if (!sub) throw new Error('No submission for this platform')
      db.prepare(`UPDATE submissions SET listing_url = ?, updated_at = ? WHERE id = ?`).run(u.toString(), now(), sub.id)
      db.prepare(`INSERT INTO backlinks (submission_id, page_url, next_check_at) VALUES (?, ?, ?)
        ON CONFLICT(submission_id) DO UPDATE SET page_url = excluded.page_url, next_check_at = excluded.next_check_at`).run(sub.id, u.toString(), now())
    }
  }
}
