// Everything written to a log, an activity row or an API error passes through here first.

const RULES = [
  // email addresses: keep the domain, it is what tells platforms apart
  [/([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '<email>@$2'],
  // query strings and fragments of URLs carry tokens (verification links, OAuth callbacks)
  [/(https?:\/\/[^\s"'<>?#]+)[?#][^\s"'<>]*/g, '$1?<redacted>'],
  // bearer tokens, JWTs, key=value secrets
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 <redacted>'],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<jwt>'],
  [/\b(password|passwd|secret|token|auth_?id|script_?id|api_?key)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1$2<redacted>'],
  // viaSocket ids (auth_id, script_id, version ids) and long opaque strings
  [/\b(row|scri|proj|flh)[A-Za-z0-9_]{6,}\b/g, '$1…'],
  [/\b[A-Za-z0-9_-]{32,}\b/g, '<long-id>'],
  // phone/customer numbers like 223-903-9564 and long digit runs
  [/\b\d{3}[- ]\d{3}[- ]\d{4}\b/g, '<number>'],
  [/\b\d{9,}\b/g, '<number>']
]

export function maskText(text) {
  let s = String(text)
  for (const [re, to] of RULES) s = s.replace(re, to)
  return s
}

const SECRET_KEYS = /pass|secret|token|auth_?id|script_?id|cookie|authorization|body|html|plain/i

export function maskValue(value, key = '') {
  if (value == null) return value
  if (SECRET_KEYS.test(key)) return '<redacted>'
  if (typeof value === 'string') return maskText(value)
  if (Array.isArray(value)) return value.map(v => maskValue(v, key))
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskValue(v, k)]))
  return value
}

export function maskError(error) {
  return maskText(error?.message ?? String(error))
}
