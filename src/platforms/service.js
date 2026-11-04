// Platform records: listing with filters, manual add, edit, skip/reject, the seed list, overview counts and CSV.
import { now } from '../db/index.js'

export const STATUSES = ['discovered', 'qualified', 'approval_required', 'registration_pending', 'registered',
  'email_verification_pending', 'ready_for_submission', 'submitted', 'pending_approval', 'live_backlink',
  'no_backlink', 'failed', 'paid_skipped', 'needs_you', 'rejected']

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
// The operator may move a platform to these by hand; every other status is set by the agent's own steps.
const OPERATOR_STATUSES = new Set(['discovered', 'rejected', 'paid_skipped'])

export function createPlatforms({ db, activity }) {
  const categoryId = slug => (slug ? db.prepare('SELECT id FROM platform_categories WHERE slug = ?').get(slug)?.id ?? null : null)

  const SELECT = `SELECT p.*, c.slug AS category, c.name AS category_name,
      (SELECT overall FROM platform_scores s WHERE s.platform_id = p.id ORDER BY scored_at DESC LIMIT 1) AS quality_score,
      a.email AS account_email, a.status AS account_status,
      s.status AS submission_status, s.submission_url AS listing_submission_url, s.listing_url,
      b.page_url AS backlink_url, b.status AS backlink_status, b.is_dofollow, b.last_checked_at
    FROM platforms p
    LEFT JOIN platform_categories c ON c.id = p.category_id
    LEFT JOIN accounts a ON a.platform_id = p.id
    LEFT JOIN submissions s ON s.platform_id = p.id
    LEFT JOIN backlinks b ON b.submission_id = s.id`

  function get(id) {
    return db.prepare(`${SELECT} WHERE p.id = ?`).get(id) ?? null
  }

  function create({ name, url, category, source = 'manual', notes = null }) {
    if (!name?.trim()) throw new Error('Name is required')
    const n = normalizeUrl(String(url || ''))
    const existing = db.prepare('SELECT id, name FROM platforms WHERE domain = ?').get(n.domain)
    if (existing) return { created: false, platform: get(existing.id), reason: `${existing.name} is already tracked` }
    const row = db.prepare(`INSERT INTO platforms (name, url, domain, category_id, source, notes) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`)
      .get(name.trim(), n.url, n.domain, categoryId(category), source, notes)
    activity.info('platform_discovered', `${name.trim()} added (${n.domain}, ${source})`, { platformId: row.id })
    return { created: true, platform: get(row.id) }
  }

  return {
    get,
    create,

    list({ q, status, category, pricing, sort = 'name', limit = 500 } = {}) {
      const where = []
      const args = []
      if (q) { where.push('(p.name LIKE ? OR p.domain LIKE ?)'); args.push(`%${q}%`, `%${q}%`) }
      if (status) { where.push('p.status = ?'); args.push(status) }
      if (category) { where.push('c.slug = ?'); args.push(category) }
      if (pricing) { where.push('p.pricing = ?'); args.push(pricing) }
      const order = { name: 'p.name COLLATE NOCASE', score: 'quality_score DESC NULLS LAST', updated: 'p.updated_at DESC' }[sort] ?? 'p.name'
      return db.prepare(`${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT ?`)
        .all(...args, Math.min(Number(limit) || 500, 2000))
    },

    update(id, patch) {
      const current = get(id)
      if (!current) throw new Error('No such platform')
      const sets = []
      const args = []
      for (const k of EDITABLE) if (k in patch) { sets.push(`${k} = ?`); args.push(patch[k] === '' ? null : patch[k]) }
      if ('category' in patch) { sets.push('category_id = ?'); args.push(categoryId(patch.category)) }
      if ('status' in patch) {
        if (!OPERATOR_STATUSES.has(patch.status)) throw new Error(`Status "${patch.status}" is set by the agent, not by hand`)
        sets.push('status = ?'); args.push(patch.status)
      }
      if (!sets.length) return current
      db.prepare(`UPDATE platforms SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...args, now(), id)
      if ('status' in patch && patch.status !== current.status) {
        activity.info('platform_status', `${current.name}: ${current.status} → ${patch.status} (by operator)`, { platformId: id })
      }
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

    overview() {
      const one = sql => db.prepare(sql).get().n
      return {
        discovered: one(`SELECT COUNT(*) n FROM platforms`),
        qualified: one(`SELECT COUNT(*) n FROM platforms WHERE status NOT IN ('discovered','rejected','paid_skipped')`),
        registered: one(`SELECT COUNT(*) n FROM accounts WHERE status = 'active'`),
        submitted: one(`SELECT COUNT(*) n FROM submissions WHERE status IN ('submitted','pending_approval','published')`),
        liveBacklinks: one(`SELECT COUNT(*) n FROM backlinks WHERE status = 'live'`),
        awaitingYou: one(`SELECT COUNT(*) n FROM human_approvals WHERE status = 'pending'`),
        pendingPlatformApproval: one(`SELECT COUNT(*) n FROM submissions WHERE status = 'pending_approval'`),
        failed: one(`SELECT COUNT(*) n FROM platforms WHERE status = 'failed'`),
        paidSkipped: one(`SELECT COUNT(*) n FROM platforms WHERE status = 'paid_skipped'`),
        needsYou: one(`SELECT COUNT(*) n FROM automation_tasks WHERE state = 'needs_you'`),
        freeSelected: one(`SELECT COUNT(*) n FROM platforms WHERE pricing IN ('free','freemium') AND status NOT IN ('discovered','rejected','paid_skipped','failed')`),
        verificationPending: one(`SELECT COUNT(*) n FROM accounts WHERE status = 'email_verification_pending'`),
        dofollow: one(`SELECT COUNT(*) n FROM backlinks WHERE status = 'live' AND is_dofollow = 1`),
        nofollow: one(`SELECT COUNT(*) n FROM backlinks WHERE status = 'live' AND is_dofollow = 0`),
        lost: one(`SELECT COUNT(*) n FROM backlinks WHERE first_seen_at IS NOT NULL AND status IN ('missing','error')`),
        byStatus: Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM platforms GROUP BY status').all().map(r => [r.status, r.n])),
        byCategory: db.prepare(`SELECT COALESCE(c.name, 'Uncategorised') name, COUNT(*) n FROM platforms p
          LEFT JOIN platform_categories c ON c.id = p.category_id GROUP BY 1 ORDER BY n DESC`).all()
      }
    },

    toCsv() {
      const cols = [
        ['Platform', 'name'], ['Domain', 'domain'], ['URL', 'url'], ['Category', 'category_name'], ['Quality score', 'quality_score'],
        ['Pricing', 'pricing'], ['Status', 'status'], ['Account email', 'account_email'], ['Account status', 'account_status'],
        ['Submission status', 'submission_status'], ['Submission URL', 'listing_submission_url'], ['Listing URL', 'listing_url'],
        ['Backlink URL', 'backlink_url'], ['Backlink status', 'backlink_status'], ['Dofollow', 'is_dofollow'],
        ['Last checked', 'last_checked_at'], ['Source', 'source'], ['Added', 'created_at']
      ]
      const rows = this.list({ limit: 2000 })
      const lines = [cols.map(([h]) => csvCell(h)).join(',')]
      for (const r of rows) lines.push(cols.map(([, k]) => csvCell(r[k])).join(','))
      return lines.join('\r\n') + '\r\n'
    }
  }
}

export function csvCell(v) {
  if (v == null) return ''
  let s = String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}` // a spreadsheet must never run a cell as a formula
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
