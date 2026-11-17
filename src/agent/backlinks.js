// Independent backlink checks: load the listing page (plain HTTP, or an isolated Chrome page when it blocks plain
// requests), find every <a> pointing to docstar.io, and record each one's rel (dofollow / nofollow / ugc / sponsored),
// anchor text, the HTTP status and whether the page may be indexed (meta robots, X-Robots-Tag). An HTTP 200 alone is
// never "live": the link must be there, on a page that is indexable.
// Live links are re-checked every `backlink_recheck_live_hours` (24), pending ones every `backlink_recheck_pending_hours`
// (12). A link that disappears or stops being dofollow moves the platform to backlink_lost and raises an alert.
import { now, numSetting } from '../db/index.js'
import { fetchPage } from './fetchPage.js'
import { safeEvaluate, settle } from '../browser/pageGuard.js'

const TARGET = /(^|\.)docstar\.io$/i
const relsOf = l => new Set(String(l.rel || '').toLowerCase().split(/\s+/).filter(Boolean))
const kindOf = r => (r.has('sponsored') ? 'sponsored' : r.has('ugc') ? 'ugc' : r.has('nofollow') ? 'nofollow' : 'dofollow')

/** Pure: every DocStar link on a page, the best one, and what it is worth. */
export function analyseLinks(links, { robots = '', xRobotsTag = '' } = {}) {
  const ours = links.filter(l => { try { return TARGET.test(new URL(l.href).hostname) } catch { return false } })
  const noindex = /noindex/i.test(robots) || /noindex/i.test(xRobotsTag || '')
  const nofollowPage = /nofollow/i.test(robots) || /nofollow/i.test(xRobotsTag || '')
  const all = ours.map(l => ({ href: l.href, anchor: (l.text || '').slice(0, 200), rel: [...relsOf(l)].join(' '), kind: nofollowPage ? 'nofollow' : kindOf(relsOf(l)) }))
  const best = all.find(l => l.kind === 'dofollow') ?? all[0]
  if (!best) return { present: false, indexable: !noindex, links: [] }
  const r = new Set(best.rel.split(' ').filter(Boolean))
  return {
    present: true,
    href: best.href,
    anchor: best.anchor,
    rel: best.rel,
    kind: best.kind,
    dofollow: best.kind === 'dofollow',
    sponsored: r.has('sponsored'),
    ugc: r.has('ugc'),
    indexable: !noindex,
    count: all.length,
    links: all.slice(0, 20)
  }
}

export function createBacklinkChecker({ db, chrome, activity, status, alerts = null, fetchImpl = fetchPage }) {
  async function read(url) {
    try {
      const p = await fetchImpl(url, { timeoutMs: 20_000 })
      if (p.status < 400 && p.html.length > 500) return { status: p.status, links: p.links, robots: p.robots, xRobotsTag: p.xRobotsTag }
      if (!chrome) return { status: p.status, links: p.links || [], robots: p.robots, xRobotsTag: p.xRobotsTag, error: p.status >= 400 ? `HTTP ${p.status}` : 'page needs a browser' }
    } catch (e) { if (!chrome) return { status: 0, links: [], error: e.message } }
    // Blocked or rendered by script: a plain visit in an isolated Chrome page (none on a hosted copy).
    let page
    try {
      page = await chrome.isolatedPage()
      const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await settle(page)
      const data = await safeEvaluate(page, () => ({
        links: [...document.querySelectorAll('a[href]')].map(a => ({ href: a.href, rel: a.getAttribute('rel') || '', text: a.innerText.trim() })),
        robots: document.querySelector('meta[name="robots" i]')?.content || ''
      }))
      return { status: res?.status() ?? 0, ...data, xRobotsTag: (await res?.allHeaders())?.['x-robots-tag'] || '', viaChrome: true }
    } finally {
      await page?.close().catch(() => {})
    }
  }

  async function check(b) {
    const sub = db.prepare('SELECT s.*, p.name, p.id pid FROM submissions s JOIN platforms p ON p.id = s.platform_id WHERE s.id = ?').get(b.submission_id)
    let page
    try { page = await read(b.page_url) } catch (e) { page = { status: 0, links: [], error: e.message } }
    const a = analyseLinks(page.links || [], page)
    const ok = page.status >= 200 && page.status < 300
    const nofollowLive = numSetting(db, 'nofollow_counts_as_live', 1) === 1
    // live: the link is on a reachable, indexable page. missing: the page answers and has no link (or is noindex).
    // error: the page could not be read (not evidence of absence). pending: no public listing URL yet.
    const linkStatus = !sub.listing_url && !b.manual_page && !ok ? 'pending' : a.present && ok && a.indexable ? 'live' : ok ? 'missing' : 'error'
    const wasLive = b.status === 'live'
    const wasDofollow = b.is_dofollow === 1
    const relChanged = wasLive && linkStatus === 'live' && wasDofollow && !a.dofollow
    const hours = linkStatus === 'live' ? numSetting(db, 'backlink_recheck_live_hours', 24) : numSetting(db, 'backlink_recheck_pending_hours', 12)
    const next = new Date(Date.now() + hours * 3600_000).toISOString()
    db.transaction(() => {
      db.prepare(`INSERT INTO backlink_history (backlink_id, http_status, link_present, rel, anchor_text, indexable, note, links_json) VALUES (?,?,?,?,?,?,?,?)`)
        .run(b.id, page.status || null, a.present ? 1 : 0, a.rel ?? null, a.anchor ?? null, a.indexable ? 1 : 0, [page.viaChrome && 'read in Chrome', page.error].filter(Boolean).join('; ') || null, JSON.stringify(a.links))
      db.prepare(`UPDATE backlinks SET target_url = ?, anchor_text = ?, rel = ?, is_dofollow = ?, is_sponsored = ?, is_ugc = ?, http_status = ?,
          indexable = ?, status = ?, first_seen_at = COALESCE(first_seen_at, ?), last_checked_at = ?, next_check_at = ?, link_count = ?, links_json = ? WHERE id = ?`)
        .run(a.href ?? null, a.anchor ?? null, a.rel ?? null, a.present ? (a.dofollow ? 1 : 0) : null, a.present ? (a.sponsored ? 1 : 0) : null,
          a.present ? (a.ugc ? 1 : 0) : null, page.status || null, a.indexable ? 1 : 0, linkStatus, linkStatus === 'live' ? now() : null, now(), next, a.count || 0, JSON.stringify(a.links), b.id)
      if (linkStatus === 'live' || linkStatus === 'missing') db.prepare(`UPDATE submissions SET published_at = COALESCE(published_at, ?) WHERE id = ?`).run(now(), sub.id)
      const cur = db.prepare('SELECT status FROM platforms WHERE id = ?').get(sub.pid).status
      let want = null
      if (relChanged || (wasLive && linkStatus === 'missing')) want = 'backlink_lost'
      else if (linkStatus === 'live') want = nofollowLive || a.dofollow ? 'live_backlink' : 'no_backlink'
      else if (linkStatus === 'missing') want = b.first_seen_at ? 'backlink_lost' : 'no_backlink'
      if (want && cur !== want) {
        const why = want === 'live_backlink' ? `link found (${a.kind}, anchor "${a.anchor}")`
          : relChanged ? `the link changed from dofollow to ${a.kind}` : !a.indexable && a.present ? 'the listing page is noindex' : a.present ? `the link is ${a.kind} only` : 'no link to docstar.io on the listing page'
        status.transition(sub.pid, want, { reason: why, manual: true })
      }
    })()
    if (linkStatus === 'live' && !wasLive) activity.success('backlink_verified', `${sub.name}: backlink live (${a.kind}, anchor "${a.anchor}")`, { platformId: sub.pid })
    else if (relChanged || (wasLive && linkStatus === 'missing')) {
      const what = relChanged ? `changed from dofollow to ${a.kind}` : `is gone (HTTP ${page.status || 'no answer'})`
      activity.error('backlink_lost', `${sub.name}: the backlink ${what}`, { platformId: sub.pid })
      alerts?.send(`backlink-lost:${sub.pid}:${now().slice(0, 10)}`, `Backlink lost: ${sub.name}`, `The DocStar link on ${b.page_url} ${what}.`, { level: 'error', link: alerts.link(`platforms?status=backlink_lost`) })
    } else activity.info('backlink_checked', `${sub.name}: ${linkStatus} (HTTP ${page.status || 'no answer'}${a.present ? `, ${a.kind}` : ''}${a.present && !a.indexable ? ', noindex' : ''})`, { platformId: sub.pid })
    return { status: linkStatus, ...a, httpStatus: page.status }
  }

  return {
    check,
    /** Due checks, a few at a time in parallel (read-only work). */
    async runDue(limit = 20) {
      const due = db.prepare(`SELECT * FROM backlinks WHERE next_check_at IS NULL OR next_check_at <= ? ORDER BY next_check_at LIMIT ?`).all(now(), limit)
      const parallel = Math.max(1, numSetting(db, 'parallel_tasks', 3))
      for (let i = 0; i < due.length; i += parallel) {
        await Promise.all(due.slice(i, i + parallel).map(b => check(b).catch(e => activity.error('backlink_check_failed', `Backlink check failed: ${e.message}`, { meta: { backlinkId: b.id } }))))
      }
      return due.length
    }
  }
}
