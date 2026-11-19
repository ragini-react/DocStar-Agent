// The product's name, site and support address live in ONE place: brand.config.json at the repo root.
// To rebrand, edit that file (or set BRAND_NAME / BRAND_DOMAIN / BRAND_SUPPORT_EMAIL) and restart. Everything the
// agent types, drafts, searches for, checks backlinks against or shows on the dashboard is derived from it.
//
// The Google account the agent signs in with is displayed as "<Name> Support", and sign-in-with-Google platforms copy
// that display name into maker / profile fields. Everything the agent types goes through brand(), so
// "<Name> Support" (any casing or spacing) is never published. Email addresses are left alone.
//
// The URL is one value too: https://<domain>/. Variants (http://, www., no trailing slash on the homepage) are
// rewritten to it, so every listing, form and backlink points at exactly the same address.
//
// Internal identifiers (DOCSTAR_* env vars, the database file name, cookie / CSRF header names, the viaSocket
// operator id) deliberately do NOT follow the brand: renaming them would log people out, orphan connections and
// break existing deployments. They are invisible to anyone outside the team.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CONFIG_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'brand.config.json')
const file = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
const env = process.env

export const BRAND = env.BRAND_NAME || file.name
export const SITE_HOST = (env.BRAND_DOMAIN || file.domain).toLowerCase()
export const SITE_URL = `https://${SITE_HOST}/`
export const SUPPORT_EMAIL = env.BRAND_SUPPORT_EMAIL || file.supportEmail || `support@${SITE_HOST}`
export const LOGO_LETTER = file.logoLetter || BRAND[0].toUpperCase()
/** URL-safe slug of the name ("Doc Star" → "docstar"), used for listing paths and searches. */
export const BRAND_SLUG = BRAND.toLowerCase().replace(/[^a-z0-9]+/g, '')

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// "DocStar" → doc\s*star (camel-case words may be typed with or without spaces)
const NAME_LOOSE = BRAND.split(/(?<=[a-z])(?=[A-Z])|\s+/).map(esc).join('[\\s_-]*')
const HOST_RE = esc(SITE_HOST)

/** Matches the brand name or its slug anywhere in text (case-insensitive). */
export const MENTION = new RegExp(`${NAME_LOOSE}|${esc(BRAND_SLUG)}`, 'i')
/** Matches a hostname that is the site itself (with or without www). */
export const SITE_HOSTNAME = new RegExp(`^(www\\.)?${HOST_RE}$`, 'i')
/** Matches the site's hostname or any subdomain of it. */
export const SITE_HOSTNAME_OR_SUB = new RegExp(`(^|\\.)${HOST_RE}$`, 'i')
/** Matches the site's domain anywhere in text. */
export const SITE_MENTION = new RegExp(HOST_RE, 'i')

const WRONG = new RegExp(`\\b${NAME_LOOSE}[\\s_-]+support(?:\\s+team)?\\b`, 'gi')
const URL_VARIANT = new RegExp(`\\b(?:https?:\\/\\/)?(?:www\\.)?${HOST_RE}(?=[\\/\\s"'<>)\\],;!?]|\\.(?:\\s|$)|$)(\\/[^\\s"'<>)\\],;]*)?`, 'gi')

/** Pure: a site URL in its one canonical form (https, no www, homepage with a trailing slash). */
export function canonicalUrl(url) {
  return String(url).replace(URL_VARIANT, (m, p, offset, whole) => {
    if (whole[offset - 1] === '@' || /[a-z0-9-]\.$/i.test(whole.slice(0, offset))) return m // an email or another host's subdomain
    if (!/^(https?:\/\/|www\.)/i.test(m)) return m // a bare mention ("docstar.io") stays as written
    return `https://${SITE_HOST}${p && p !== '/' ? p : '/'}`
  })
}

/** Pure: text with "<Name> Support" replaced by the name and site URLs made canonical. Non-strings unchanged. */
export function brand(text) {
  return typeof text === 'string' ? canonicalUrl(text.replace(WRONG, BRAND)) : text
}

/** Pure: true when a URL is the site itself (domain or www.domain), not another host or subdomain. */
export function isSiteUrl(url) {
  try { return SITE_HOSTNAME.test(new URL(url).hostname) } catch { return false }
}

/** Pure: brand() applied to every string value of an object (one level deep, arrays included). */
export function brandAll(obj) {
  if (!obj || typeof obj !== 'object') return obj
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, Array.isArray(v) ? v.map(brand) : brand(v)]))
}

/** Pure: whether text still carries the wrong brand name. */
export const hasWrongBrand = text => typeof text === 'string' && new RegExp(WRONG.source, 'i').test(text)

/** Pure: replace {{BRAND}}, {{SITE_HOST}}, {{SITE_URL}}, {{SUPPORT_EMAIL}}, {{BRAND_SLUG}}, {{LOGO_LETTER}} in a template. */
export function fillBrand(template) {
  const v = { BRAND, SITE_HOST, SITE_URL, SUPPORT_EMAIL, BRAND_SLUG, LOGO_LETTER }
  return String(template).replace(/\{\{(BRAND|SITE_HOST|SITE_URL|SUPPORT_EMAIL|BRAND_SLUG|LOGO_LETTER)\}\}/g, (_, k) => v[k])
}
