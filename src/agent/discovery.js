// Find candidate platforms: viaSocket AI searches the web (search results only, no browsing), then every
// candidate's homepage is fetched by us; only sites that answer are recorded. Nothing is trusted on the AI's word.
import { fetchPage } from './fetchPage.js'
import { arr, obj, oneOf, str } from './schema.js'
import { normalizeUrl } from '../platforms/service.js'

const CATEGORIES = ['saas_directory', 'ai_tools', 'dev_tools', 'api_docs', 'docs_software', 'startup', 'product_listing', 'reviews', 'company_directory', 'business_profile']

// Rotated one per run, so successive runs widen the search instead of repeating it.
export const QUERIES = [
  'free SaaS directories that accept new software product submissions',
  'AI tool directories with a free "submit your tool" page',
  'developer tool directories and lists that accept free submissions (APIs, dev tools)',
  'API directories and API documentation tool listings where a product can be submitted for free',
  'documentation software and knowledge base software directories with free listings',
  'startup directories and launch platforms with a free submission option',
  'software alternatives / comparison sites where anyone can add a product for free',
  'MCP server directories and registries that accept submissions',
  'open developer communities where a product or project page can be created for free',
  'technology company directories and business profile sites with a free company profile'
]

const SEARCH_UNAVAILABLE = /no remaining credits|couldn.?t (complete|perform|run) the (web )?search|unable to (search|access the web)|search (service|tool) is (unavailable|not available)/i
// Public, community-maintained lists of places to post a product (read as plain files).
export const LIST_SOURCES = ['https://raw.githubusercontent.com/mmccaff/PlacesToPostYourStartup/master/README.md']

/** Pure: "* Name - https://…" and "[Name](https://…)" entries of a markdown list, without subreddits. */
export function listEntries(md) {
  const out = []
  for (const line of String(md).split('\n')) {
    const m = line.match(/^\s*[*-]\s+(.+?)\s+[-–—:]\s+(https?:\/\/\S+)/) || line.match(/^\s*[*-]\s+\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/)
    if (!m) continue
    const url = m[2].replace(/[).,;]+$/, '')
    if (/reddit\.com|^\/r\//i.test(url + m[1])) continue
    out.push({ name: m[1].replace(/[*_`[\]]/g, '').trim().slice(0, 80), url })
  }
  return out
}

const QUERY_CATEGORY = ['saas_directory', 'ai_tools', 'dev_tools', 'api_docs', 'docs_software', 'startup', 'product_listing', 'dev_tools', 'dev_tools', 'company_directory']

/** Pure fallback: entries of a markdown list → { name, homepage, submit_url }. */
export function parseCandidates(text, category) {
  const out = []
  for (const block of String(text).split(/\n(?=\s*(?:[-*]|\d+[.)])\s)/)) {
    const urls = block.match(/https?:\/\/[^\s)>\]*"'`]+/g) || []
    if (!urls.length) continue
    const head = block.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').split('\n')[0]
    const name = (head.match(/\*\*([^*]+)\*\*/)?.[1] || head.split(/\s[—–-]\s|\s\(|:/)[0]).replace(/[*_`]/g, '').trim()
    const submit = block.match(/submi[^\n]*?(https?:\/\/[^\s)>\]*"'`]+)/i)?.[1] || ''
    if (name) out.push({ name: name.slice(0, 80), homepage: urls[0].replace(/[.,;]+$/, ''), submit_url: submit.replace(/[.,;]+$/, ''), category, why: block.split('\n').slice(1).join(' ').replace(/\*\*[^*]+\*\*:?/g, '').trim().slice(0, 200) })
  }
  return out
}

const schema = {
  name: 'candidates',
  strict: true,
  schema: obj({
    items: arr(obj({
      name: str('site name'),
      homepage: str('homepage URL exactly as found'),
      submit_url: str('submission page URL if the result shows one, else ""'),
      category: oneOf(CATEGORIES, 'best fit'),
      why: str('one sentence: why it fits an API documentation / developer tool product')
    }), 'up to 12 real sites from the search results')
  })
}

export function createDiscovery({ db, ai, platforms, activity }) {
  return {
    async run({ batch = 12 } = {}) {
      const runs = Number(db.prepare(`SELECT COUNT(*) n FROM activity_logs WHERE event = 'discovery_run'`).get().n)
      const query = QUERIES[runs % QUERIES.length]
      const known = db.prepare('SELECT domain FROM platforms').all().map(r => r.domain)
      const exclude = `Exclude: link farms, PBNs, "submit to 1000 directories" services, sites that only sell paid listings, forums or subreddits where posting a link would be spam, and these already-known domains: ${known.slice(0, 300).join(', ') || 'none'}.`
      // 1. Web search, in plain text (the path where viaSocket's search runs), structured in a second call.
      let source = 'web search'
      const found = await ai.text({
        threadId: `discover-${Date.now().toString(36)}`,
        prompt: `You find legitimate places to list DocStar (https://docstar.io/), an API documentation platform for developers and AI agents.
Use web search results only; do not open the browser or visit pages. Return only sites that appear in your search results, with their real URLs.
${exclude}`,
        message: `Search: ${query}. Return up to ${batch} sites as a list: name, homepage URL, submission page URL if shown, one line on why it fits.`
      }).catch(() => '')
      let answer = { items: [] }
      const searchWorked = found && !SEARCH_UNAVAILABLE.test(found)
      for (let i = 0; searchWorked && i < 2 && !answer.items.length; i++) {
        answer = await ai.json({
          threadId: `discover-parse-${Date.now().toString(36)}-${i}`,
          schema,
          prompt: 'Convert the list into the schema. Copy names and URLs exactly; do not add sites that are not in the list. Do not browse or search.',
          message: found
        }).catch(() => ({ items: [] }))
      }
      // The structuring call sometimes answers with an empty list: read the names and URLs from the text instead.
      if (searchWorked && !answer.items.length) answer = { items: parseCandidates(found, QUERY_CATEGORY[runs % QUERIES.length]) }

      // 2. Search unavailable (e.g. out of credits): public lists of places to post a product, read by us.
      if (!answer.items.length) {
        source = 'public lists'
        const lines = []
        for (const url of LIST_SOURCES) {
          try {
            const res = await fetchPage(url, { timeoutMs: 20_000 })
            if (res.status === 200) lines.push(...listEntries(res.html))
          } catch {}
        }
        const fresh = lines.filter(l => { try { return !known.includes(normalizeUrl(l.url).domain) } catch { return false } })
        if (fresh.length) {
          answer = await ai.json({
            threadId: `discover-lists-${Date.now().toString(36)}`,
            schema,
            prompt: `Pick the entries best suited to listing DocStar (https://docstar.io/), an API documentation platform for developers and AI agents. Use only entries from the list, URLs copied exactly. ${exclude} Do not browse or search.`,
            message: `Choose up to ${batch}, best first, preferring "${query}":\n${fresh.slice(0, 250).map(l => `- ${l.name}: ${l.url}`).join('\n')}`
          }).catch(() => ({ items: [] }))
        }
      }

      // 3. Still nothing: candidates from the model's own knowledge. Every one is fetched below before it counts.
      if (!answer.items.length) {
        source = 'model knowledge (verified by fetch)'
        answer = await ai.json({
          threadId: `discover-known-${Date.now().toString(36)}`,
          schema,
          prompt: `From your own knowledge, name real, long-running sites matching the request where DocStar (https://docstar.io/), an API documentation platform, can be listed for free. Give real homepage URLs only. ${exclude} Do not browse or search.`,
          message: `${query}. Up to ${batch} sites.`
        }).catch(() => ({ items: [] }))
      }
      activity.info('discovery_run', `Discovery (${source}): "${query}" → ${answer.items.length} candidates`)
      const added = []
      for (const c of answer.items.slice(0, batch)) {
        let norm
        try { norm = normalizeUrl(c.homepage) } catch { continue }
        if (known.includes(norm.domain)) continue
        let page
        try { page = await fetchPage(norm.url, { timeoutMs: 15_000 }) } catch (e) {
          activity.info('discovery_unreachable', `${c.name} (${norm.domain}) did not answer; not added`)
          continue
        }
        // 403/429/503 are usually bot protection: the site exists; qualification reads it in Chrome.
        if (page.status >= 400 && ![401, 403, 429, 503].includes(page.status)) {
          activity.info('discovery_unreachable', `${c.name} (${norm.domain}) answered ${page.status}; not added`)
          continue
        }
        const r = platforms.create({ name: c.name.slice(0, 80), url: norm.url, category: c.category, source: 'discovered', notes: c.why })
        if (r.created) {
          if (c.submit_url) platforms.update(r.platform.id, { submission_url: c.submit_url })
          added.push(r.platform.id)
          known.push(norm.domain)
        }
      }
      return { query, source, candidates: answer.items.length, added }
    }
  }
}
