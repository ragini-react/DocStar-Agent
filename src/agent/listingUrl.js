import { MENTION, SITE_MENTION } from './brand.js'
// What counts as a public listing. A URL is DocStar's listing only when anyone can open it and see DocStar: never a
// dashboard, a login, a submission form or a "submitted / waiting for review" tracker. Everything that records a
// listing URL or marks a platform published goes through these checks.

/** Pure: a URL cut out of a sentence, without trailing punctuation ("…/docstar," → "…/docstar"). null if not http(s). */
export function cleanListingUrl(raw) {
  let u = String(raw ?? '').trim().replace(/[.,;:!?'")\]}>]+$/, '')
  if (!/^https?:\/\//i.test(u)) return null
  try { return new URL(u).toString() } catch { return null }
}

const PRIVATE_HOST = /^(portal|dashboard|admin|account|accounts|app|my|members?|login|auth|sso|seller)\./i
const PRIVATE_PATH = /\/(dashboard|admin|account|accounts|settings|profile\/edit|login|log-in|signin|sign-in|signup|sign-up|register|auth|oauth|seller_login|my-?[a-z]*|submit|submissions?|submitted|add[_-]?product[_a-z-]*|add[_-]?(tool|app|startup|listing)s?|new|edit|drafts?|checkout|billing|pricing|upgrade|thank-?you|success|pending|review-?queue)(\/|$|\?|#)/i

/** Pure: true for URLs only the account owner can see, or pages that are not a listing (forms, trackers, logins). */
export function isPrivateUrl(raw) {
  const u = cleanListingUrl(raw)
  if (!u) return true
  const { hostname, pathname, search } = new URL(u)
  return PRIVATE_HOST.test(hostname) || PRIVATE_PATH.test(pathname) || /[?&](returnTo|redirect|next)=/i.test(search)
}

/** Pure: a URL that can be recorded as DocStar's public listing, or null. */
export function publicListingUrl(raw) {
  const u = cleanListingUrl(raw)
  return u && !isPrivateUrl(u) ? u : null
}

/** Pure: the platform says the listing is not live yet ("waiting for approval", "in review", "scheduled"). */
export const notLiveYet = text => /\b(waiting for (approval|review)|awaiting (approval|review|moderation)|pending (approval|review|moderation)|under review|in review|in (the )?queue|not (yet )?(live|published|approved)|scheduled (for|to launch)|launch(es|ing)? (is )?scheduled|submitted for review)\b/i.test(String(text || ''))

/**
 * Pure: does a fetched page show DocStar's public listing? The final URL (after redirects) must still be public and
 * the page must name DocStar. A login redirect or a page that never mentions DocStar is not a listing.
 */
export function pageShowsListing({ url, finalUrl, text = '', title = '', links = [] } = {}) {
  if (isPrivateUrl(finalUrl || url)) return false
  if (MENTION.test(`${title} ${text}`)) return true
  return links.some(l => SITE_MENTION.test(l.href || ''))
}
