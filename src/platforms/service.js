// Platform records: listing with filters (paginated on the server), manual add, edit, the operator's status
// decisions (through the status writer), the seed list and CSV. Counts and grouped lists live in views.js.
import { now } from '../db/index.js'
import { STATUSES, label } from '../engine/stateMachine.js'

export { STATUSES }

// The operator's own seed list (plan, section 2). Imported only when the operator presses the button;
// every one starts as "discovered" with nothing assumed about pricing, backlinks or automation.
export const SEED_PLATFORMS = [
  ['AlternativeTo', 'https://alternativeto.net/', 'saas_directory'],
  ['SaaSHub', 'https://www.saashub.com/', 'saas_directory'],
  ['Product Hunt', 'https://www.producthunt.com/', 'product_listing'],
  ['BetaList', 'https://betalist.com/', 'startup'],
  ['G2', 'https://www.g2.com/', 'reviews'],
  ['Capterra', 'https://www.capterra.com/', 'reviews'],
  ['Crunchbase', 'https://www.crunchbase.com/', 'company_directory'],
  ["There's An AI For That", 'https://theresanaiforthat.com/', 'ai_tools'],
  ['Futurepedia', 'https://www.futurepedia.io/', 'ai_tools'],
  ['SourceForge', 'https://sourceforge.net/', 'saas_directory'],
  ['GetApp', 'https://www.getapp.com/', 'reviews'],
  ['Software Advice', 'https://www.softwareadvice.com/', 'reviews'],
  ['Slant', 'https://www.slant.co/', 'product_listing'],
  ['StackShare', 'https://stackshare.io/', 'dev_tools']
]

export function normalizeUrl(input) {
  let url
  try { url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`) } catch { throw new Error('Not a valid URL') }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http(s) URLs')
  const domain = url.hostname.toLowerCase().replace(/^www\./, '')
  if (!domain.includes('.')) throw new Error('Not a valid domain')
  return { url: url.origin + '/', domain }
}

const EDITABLE = ['name', 'submission_url', 'pricing', 'pricing_notes', 'registration_requirements', 'submission_requirements',
  'backlink_availability', 'automation_policy', 'notes']
const SOURCE = /^(seed|manual|import|discovery:.{1,200})$/

// Fields each view needs: the list returns only these unless asked for everything.
const LIST_FIELDS = `p.id, p.name, p.domain, p.url, p.source, p.status, p.resume_status, p.status_reason, p.needs_you_reason, p.pricing,
  p.status_changed_at, p.updated_at, p.version, p.notes, c.slug AS category, c.name AS category_name,
  (SELECT overall FROM platform_scores s WHERE s.platform_id = p.id ORDER BY scored_at DESC, id DESC LIMIT 1) AS quality_score,
  a.email AS account_email, a.status AS account_status, a.login_method, a.signup_completed_at,
  s.status AS submission_status, s.submission_url AS listing_submission_url, s.listing_url, s.manual AS manual_submission,
  b.page_url AS backlink_url, b.status AS backlink_status, b.is_dofollow, b.rel AS backlink_rel, b.last_checked_at`
const FROM = `FROM platforms p
    LEFT JOIN platform_categories c ON c.id = p.category_id
    LEFT JOIN accounts a ON a.platform_id = p.id
    LEFT JOIN submissions s ON s.platform_id = p.id
    LEFT JOIN backlinks b ON b.submission_id = s.id`

// Filter groups the overview cards link to.
const GROUPS = {
  needs_you: ['needs_you'],
  failed: ['evaluation_failed', 'registration_failed', 'submission_failed'],
  added: ['live_backlink', 'published', 'no_backlink', 'submitted', 'pending_platform_review'],
  in_progress: ['qualifying', 'registering', 'registered', 'email_verification_pending', 'ready_for_submission', 'submitting'],
  pipeline: ['approved', 'registering', 'registered', 'email_verification_pending', 'ready_for_submission', 'submitting']
}

export function createPlatforms({ db, activity, status, orchestrator = null }) {
  const categoryId = slug => (slug ? db.prepare('SELECT id FROM platform_categories WHERE slug = ?').get(slug)?.id ?? null : null)

  function get(id) {
    return db.prepare(`SELECT p.*, ${LIST_FIELDS} ${FROM} WHERE p.id = ?`).get(id) ?? null
  }

  function create({ name, url, category, source = 'manual', notes = null, siteKey = null }) {
    if (!name?.trim()) throw new Error('Name is required')
    if (!SOURCE.test(source)) throw new Error(`Bad source "${source}"`)
    const n = normalizeUrl(String(url || ''))
    const existing = db.prepare('SELECT id, name FROM platforms WHERE domain = ? OR (site_key IS NOT NULL AND site_key = ?)').get(n.domain, siteKey ?? n.domain)
    if (existing) return { created: false, platform: get(existing.id), reason: `${existing.name} is already tracked` }
    const row = db.prepare(`INSERT INTO platforms (name, url, domain, site_key, category_id, source, notes, status_changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
      .get(name.trim(), n.url, n.domain, siteKey ?? n.domain, categoryId(category), source, notes, now())
    db.prepare(`INSERT INTO platform_transitions (platform_id, from_status, to_status, reason, actor) VALUES (?, NULL, 'discovered', ?, ?)`)
      .run(row.id, `added (${source})`, source === 'manual' ? 'operator' : 'agent')
    activity.info('platform_discovered', `${name.trim()} added (${n.domain}, ${source})`, { platformId: row.id })
    return { created: true, platform: get(row.id) }
  }

  return {
    get,
    create,
    GROUPS,

    /** Paginated and filtered on the server. Returns { rows, total, limit, offset }. */
    list({ q, status, group, category, pricing, ids, sort = 'name', limit = 100, offset = 0 } = {}) {
      const where = []
      const args = []
      // Specific rows (live refresh of the rows an event touched).
      if (ids) { const list = String(ids).split(',').map(Number).filter(Boolean).slice(0, 200); where.push(`p.id IN (${list.map(() => '?').join(',') || 'NULL'})`); args.push(...list) }
      if (q) { where.push('(p.name LIKE ? OR p.domain LIKE ?)'); args.push(`%${q}%`, `%${q}%`) }
      if (status) { where.push('p.status = ?'); args.push(status) }
      if (group && GROUPS[group]) { where.push(`p.status IN (${GROUPS[group].map(() => '?').join(',')})`); args.push(...GROUPS[group]) }
      if (category) { where.push('c.slug = ?'); args.push(category) }
      if (pricing) { where.push('p.pricing = ?'); args.push(pricing) }
      const w = where.length ? 'WHERE ' + where.join(' AND ') : ''
      const order = { name: 'p.name COLLATE NOCASE', score: 'quality_score DESC NULLS LAST', updated: 'p.updated_at DESC', status: 'p.status, p.name COLLATE NOCASE' }[sort] ?? 'p.name COLLATE NOCASE'
      const lim = Math.min(Math.max(Number(limit) || 100, 1), 2000)
      const off = Math.max(Number(offset) || 0, 0)
      const total = db.prepare(`SELECT COUNT(*) n ${FROM} ${w}`).get(...args).n
      const rows = db.prepare(`SELECT ${LIST_FIELDS} ${FROM} ${w} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, lim, off)
      return { rows, total, limit: lim, offset: off }
    },

    update(id, patch, { actor = 'operator' } = {}) {
      const current = get(id)
      if (!current) throw new Error('No such platform')
      const sets = []
      const args = []
      for (const k of EDITABLE) if (k in patch) { sets.push(`${k} = ?`); args.push(patch[k] === '' ? null : patch[k]) }
      if ('category' in patch) { sets.push('category_id = ?'); args.push(categoryId(patch.category)) }
      db.transaction(() => {
        if (sets.length) db.prepare(`UPDATE platforms SET ${sets.join(', ')}, version = version + 1, updated_at = ? WHERE id = ?`).run(...args, now(), id)
        if ('status' in patch && patch.status !== current.status) {
          if (!['discovered', 'rejected', 'paid_skipped'].includes(patch.status)) throw new Error(`Status "${label(patch.status)}" is set by the agent, not by hand`)
          // A person's decision ends whatever the agent had queued for this platform.
          orchestrator?.cancelPlatformTasks(id, `platform set to ${label(patch.status).toLowerCase()} by you`)
          status.transition(id, patch.status, { actor, operator: true, statusReason: patch.status === 'discovered' ? null : (patch.reason || 'operator'), reason: patch.note || null })
        }
      })()
      return get(id)
    },

    remove(id) {
      const p = get(id)
      if (!p) throw new Error('No such platform')
      if (p.account_status || p.submission_status) throw new Error('Has an account or a submission: reject it instead of deleting')
      db.prepare('DELETE FROM platforms WHERE id = ?').run(id)
      activity.info('platform_removed', `${p.name} removed`)
    },

    importSeeds() {
      let added = 0
      db.transaction(() => {
        for (const [name, url, category] of SEED_PLATFORMS) if (create({ name, url, category, source: 'seed' }).created) added++
      })()
      activity.info('seeds_imported', `Seed list imported: ${added} new, ${SEED_PLATFORMS.length - added} already tracked`)
      return { added, total: SEED_PLATFORMS.length }
    },

    categories: () => db.prepare('SELECT slug, name FROM platform_categories ORDER BY name').all(),

    toCsv() {
      const cols = [
        ['Platform', 'name'], ['Domain', 'domain'], ['URL', 'url'], ['Category', 'category_name'], ['Quality score', 'quality_score'],
        ['Pricing', 'pricing'], ['Status', r => label(r.status)], ['Reason', r => (r.status_reason ? label(r.status_reason) : '')],
        ['Account email', 'account_email'], ['Sign-up method', r => (r.signup_completed_at ? label(r.login_method) : '')],
        ['Account status', r => (r.account_status ? label(r.account_status) : '')],
        ['Submission status', r => (r.submission_status ? label(r.submission_status) : '')], ['Submission URL', 'listing_submission_url'], ['Listing URL', 'listing_url'],
        ['Backlink URL', 'backlink_url'], ['Backlink status', r => (r.backlink_status ? label(r.backlink_status) : '')], ['Dofollow', 'is_dofollow'],
        ['Last checked', 'last_checked_at'], ['Source', 'source'], ['Added', 'created_at']
      ]
      const rows = db.prepare(`SELECT p.created_at, ${LIST_FIELDS} ${FROM} ORDER BY p.name COLLATE NOCASE`).all()
      return toCsv(cols, rows)
    }
  }
}

export function toCsv(cols, rows) {
  const lines = [cols.map(([h]) => csvCell(h)).join(',')]
  for (const r of rows) lines.push(cols.map(([, k]) => csvCell(typeof k === 'function' ? k(r) : r[k])).join(','))
  return lines.join('\r\n') + '\r\n'
}

export function csvCell(v) {
  if (v == null) return ''
  let s = String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}` // a spreadsheet must never run a cell as a formula
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
