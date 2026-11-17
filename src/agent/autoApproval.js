// Auto-approval: a listing is approved without a person only when every condition holds; otherwise it waits for a
// person, with the reason shown on the approval card. require_approval stays the master switch (Settings).
//   - the auto_approve setting is on
//   - the platform's score is at least auto_approve_min_score (65)
//   - listing there is free (pricing free or freemium)
//   - nothing unusual is required (phone, ID, payment card, company documents, a call …)
//   - the listing uses only approved profile facts (its links and numbers all appear in the approved profile)
import { numSetting } from '../db/index.js'

const UNUSUAL = /phone|sms|text message|id verification|identity|passport|driver|credit card|card details|payment|invoice|tax id|vat|company registration|incorporation|budget|video call|interview|demo call|notari|reference|referral code/i

/** Pure: whether the listing says only what the approved facts say (URLs and numbers are the checkable claims). */
export function usesOnlyApprovedFacts(listing, facts) {
  const factText = Object.values(facts || {}).join('\n').toLowerCase()
  const text = [listing?.title, listing?.tagline, listing?.short_description, listing?.long_description, ...(listing?.tags || [])].join('\n')
  const urls = text.match(/https?:\/\/[^\s)>\]"']+/gi) || []
  for (const u of urls) if (!factText.includes(u.toLowerCase().replace(/[.,;]+$/, ''))) return { ok: false, why: `the listing links to ${u}, which is not in the approved profile` }
  const numbers = (text.match(/\b\d[\d,.]*\+?%?/g) || []).filter(n => n.replace(/\D/g, '').length >= 2)
  for (const n of numbers) if (!factText.includes(n.toLowerCase())) return { ok: false, why: `the listing states "${n}", which is not in the approved profile` }
  if (facts?.name && listing?.title && !listing.title.toLowerCase().includes(facts.name.toLowerCase())) return { ok: false, why: `the listing title "${listing.title}" is not the product name` }
  return { ok: true }
}

export function createAutoApproval({ db, company }) {
  return function check(platformId, listing) {
    if (numSetting(db, 'auto_approve', 0) !== 1) return { ok: false, why: 'auto-approval is off in Settings' }
    const p = db.prepare('SELECT pricing, registration_requirements, submission_requirements, pricing_notes FROM platforms WHERE id = ?').get(platformId)
    const score = db.prepare('SELECT overall FROM platform_scores WHERE platform_id = ? AND overall IS NOT NULL ORDER BY scored_at DESC, id DESC LIMIT 1').get(platformId)?.overall
    const min = numSetting(db, 'auto_approve_min_score', 65)
    if (score == null || score < min) return { ok: false, why: `score ${score ?? 'unknown'} is below the auto-approval minimum ${min}` }
    if (!['free', 'freemium'].includes(p.pricing)) return { ok: false, why: `listing there is ${p.pricing}, not free` }
    const req = `${p.registration_requirements || ''} ${p.submission_requirements || ''} ${p.pricing_notes || ''}`
    const unusual = req.match(UNUSUAL)
    if (unusual) return { ok: false, why: `the platform asks for something unusual ("${unusual[0]}")` }
    const facts = company.approved()
    if (!facts) return { ok: false, why: 'the DocStar profile is not approved' }
    const r = usesOnlyApprovedFacts(listing, facts)
    if (!r.ok) return r
    return { ok: true, why: `score ${score} ≥ ${min}, free, no unusual requirements, only approved facts` }
  }
}
