// Platform-specific listing copy, written only from the approved DocStar profile. One draft per platform
// (submissions has one row per platform); the operator sees and may edit it in the approval.
import { now } from '../db/index.js'
import { arr, obj, str } from './schema.js'

const schema = {
  name: 'listing',
  strict: true,
  schema: obj({
    title: str('product name as the listing title, normally "DocStar"'),
    tagline: str('≤ 80 characters'),
    short_description: str('≤ 160 characters'),
    long_description: str('fits what this platform asks for; 80–250 words; no claims beyond the profile'),
    tags: arr(str('tag'), '3–8 tags suited to this platform'),
    anchor_text: str('natural anchor text: the brand name "DocStar" unless the platform asks otherwise')
  })
}

export function createListings({ db, ai, company }) {
  return {
    ready: () => Boolean(company.approved()),

    get(platformId) {
      const s = db.prepare('SELECT * FROM submissions WHERE platform_id = ?').get(platformId)
      if (!s) return null
      return { id: s.id, title: s.listing_title, anchor_text: s.anchor_text, target_url: s.target_url, status: s.status, ...JSON.parse(s.listing_description || '{}') }
    },

    async draft(platformId) {
      const facts = company.approved()
      if (!facts) throw new Error('DocStar profile is not approved yet')
      const p = db.prepare('SELECT name, domain, submission_requirements, notes FROM platforms WHERE id = ?').get(platformId)
      const l = await ai.json({
        threadId: `listing-${p.domain}-${Date.now().toString(36)}`,
        schema,
        prompt: 'You write a directory listing for DocStar using ONLY the approved facts given. Never add numbers, customers, awards, integrations or capabilities that are not in the facts. Vary wording per platform; no keyword stuffing. Do not browse.',
        message: `PLATFORM: ${p.name} (${p.domain})\nWHAT IT ASKS FOR: ${p.submission_requirements || 'unknown'}\nCONTEXT: ${p.notes || ''}\n\nAPPROVED FACTS:\n${JSON.stringify(facts, null, 1)}`
      })
      this.save(platformId, l, 'approval_required')
      return l
    },

    save(platformId, l, status) {
      const body = JSON.stringify({ tagline: l.tagline, short_description: l.short_description, long_description: l.long_description, tags: l.tags })
      db.prepare(`INSERT INTO submissions (platform_id, listing_title, listing_description, anchor_text, status, updated_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(platform_id) DO UPDATE SET listing_title = excluded.listing_title, listing_description = excluded.listing_description,
          anchor_text = excluded.anchor_text, status = excluded.status, updated_at = excluded.updated_at`)
        .run(platformId, l.title, body, l.anchor_text, status, now())
    }
  }
}
