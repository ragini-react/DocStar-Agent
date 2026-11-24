// Cold-email sending policy: pure functions, no I/O. Everything the sender enforces before an email leaves lives here,
// so it is tested in one place: per-inbox hourly/daily limits, the random gap between sends, the recipient's business
// hours in their time zone, compliance checks (suppression, EU/UK role addresses, one live sequence per domain),
// follow-up timing (at most 2), opt-out and bounce detection, and the automatic-pause thresholds.

export const DEFAULTS = Object.freeze({
  hourly_limit: 8, daily_limit: 30,          // per inbox; new inboxes start here
  gap_min_sec: 120, gap_max_sec: 360,        // random 2–6 minutes between two sends from one inbox
  batch_size: 30,                            // most emails one approval can queue
  max_followups: 2,
  followup_days: [3, 7],                     // follow-up 1: 3 days after the first email, follow-up 2: 7 days after follow-up 1
  followup_jitter_days: 1,                   // + 0..1 day, so follow-ups don't all land together
  business_start: 9, business_end: 17,       // recipient's local hours, Monday–Friday
  default_tz: 'America/New_York',            // .com/.io and other generic domains
  bounce_pause_rate: 0.03,                   // pause an inbox above 3% bounces…
  bounce_min_sample: 20,                     // …once it has at least this many sends in the window
  bounce_pause_count: 3,                     // or this many bounces in the window, whatever the rate
  complaint_pause_count: 1,                  // any spam complaint pauses the inbox
  monitor_window_days: 7,
  domain_daily_cap: 1                        // emails per recipient domain per day, across every inbox
})
export const LIMIT_BOUNDS = { hourly_limit: [1, 50], daily_limit: [1, 500] }

/** Clamped settings: unknown keys dropped, numbers kept within sane bounds. */
export function cleanSettings(input = {}) {
  const out = {}
  const num = (k, lo, hi) => { if (input[k] == null || input[k] === '') return; const v = Number(input[k]); if (!Number.isFinite(v)) throw new Error(`${k} must be a number`); out[k] = Math.min(hi, Math.max(lo, v)) }
  num('gap_min_sec', 30, 3600); num('gap_max_sec', 30, 7200); num('batch_size', 1, 30); num('max_followups', 0, 2)
  num('business_start', 0, 23); num('business_end', 1, 24); num('bounce_pause_rate', 0.005, 0.2); num('bounce_min_sample', 5, 500)
  num('bounce_pause_count', 1, 50); num('complaint_pause_count', 1, 10); num('monitor_window_days', 1, 30); num('domain_daily_cap', 1, 5)
  num('hourly_limit', ...LIMIT_BOUNDS.hourly_limit); num('daily_limit', ...LIMIT_BOUNDS.daily_limit)
  if (input.followup_days != null) {
    const d = [].concat(input.followup_days).map(Number)
    if (d.length !== 2 || d.some(x => !Number.isFinite(x) || x < 1 || x > 30)) throw new Error('followup_days must be two numbers of days (1–30)')
    out.followup_days = d
  }
  if (input.default_tz != null) { tzValid(input.default_tz); out.default_tz = String(input.default_tz) }
  if (out.gap_min_sec != null && out.gap_max_sec != null && out.gap_max_sec < out.gap_min_sec) throw new Error('The longest gap must be at least the shortest')
  if (out.business_start != null && out.business_end != null && out.business_end <= out.business_start) throw new Error('Business hours must end after they start')
  return out
}
function tzValid(tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }) } catch { throw new Error(`Unknown time zone: ${tz}`) } }

// ── Limits ────────────────────────────────────────────────────────────────────────────────────────────────────────
const HOUR = 3600_000, DAY = 24 * HOUR

/** Whether an inbox may send at `now`, given the times (ms) of its recent sends. */
export function limitCheck({ sentTimes, hourly, daily, nextAllowedAt = 0, now }) {
  const lastHour = sentTimes.filter(t => t > now - HOUR).length
  const lastDay = sentTimes.filter(t => t > now - DAY).length
  if (lastDay >= daily) return { ok: false, reason: 'daily limit', until: Math.min(...sentTimes.filter(t => t > now - DAY)) + DAY }
  if (lastHour >= hourly) return { ok: false, reason: 'hourly limit', until: Math.min(...sentTimes.filter(t => t > now - HOUR)) + HOUR }
  if (nextAllowedAt > now) return { ok: false, reason: 'spacing', until: nextAllowedAt }
  return { ok: true, lastHour, lastDay }
}

/** The random gap before an inbox's next send (ms). */
export const nextGapMs = (s, rand = Math.random) => Math.round((s.gap_min_sec + rand() * (s.gap_max_sec - s.gap_min_sec)) * 1000)

// ── Recipient time zone and business hours ──────────────────────────────────────────────────────────────────────
// Country-code domains → a representative zone. Generic domains (.com, .io, .ai…) fall back to the default zone.
const TLD_TZ = {
  uk: 'Europe/London', ie: 'Europe/Dublin', de: 'Europe/Berlin', fr: 'Europe/Paris', es: 'Europe/Madrid', it: 'Europe/Rome',
  nl: 'Europe/Amsterdam', be: 'Europe/Brussels', at: 'Europe/Vienna', ch: 'Europe/Zurich', se: 'Europe/Stockholm', no: 'Europe/Oslo',
  dk: 'Europe/Copenhagen', fi: 'Europe/Helsinki', pl: 'Europe/Warsaw', cz: 'Europe/Prague', pt: 'Europe/Lisbon', gr: 'Europe/Athens',
  ro: 'Europe/Bucharest', hu: 'Europe/Budapest', ee: 'Europe/Tallinn', lv: 'Europe/Riga', lt: 'Europe/Vilnius', sk: 'Europe/Bratislava',
  si: 'Europe/Ljubljana', hr: 'Europe/Zagreb', bg: 'Europe/Sofia', lu: 'Europe/Luxembourg', cy: 'Asia/Nicosia', mt: 'Europe/Malta',
  is: 'Atlantic/Reykjavik', ua: 'Europe/Kyiv', tr: 'Europe/Istanbul', il: 'Asia/Jerusalem', ae: 'Asia/Dubai', sa: 'Asia/Riyadh',
  in: 'Asia/Kolkata', pk: 'Asia/Karachi', bd: 'Asia/Dhaka', lk: 'Asia/Colombo', np: 'Asia/Kathmandu', sg: 'Asia/Singapore',
  my: 'Asia/Kuala_Lumpur', id: 'Asia/Jakarta', th: 'Asia/Bangkok', vn: 'Asia/Ho_Chi_Minh', ph: 'Asia/Manila', hk: 'Asia/Hong_Kong',
  tw: 'Asia/Taipei', cn: 'Asia/Shanghai', jp: 'Asia/Tokyo', kr: 'Asia/Seoul', au: 'Australia/Sydney', nz: 'Pacific/Auckland',
  ca: 'America/Toronto', us: 'America/New_York', mx: 'America/Mexico_City', br: 'America/Sao_Paulo', ar: 'America/Argentina/Buenos_Aires',
  cl: 'America/Santiago', co: 'America/Bogota', pe: 'America/Lima', za: 'Africa/Johannesburg', ng: 'Africa/Lagos', ke: 'Africa/Nairobi',
  eg: 'Africa/Cairo', ma: 'Africa/Casablanca'
}
// EU/EEA and UK: only role addresses (hello@, contact@…) are emailed; personal addresses need consent there.
export const STRICT_TLDS = new Set(['uk', 'ie', 'de', 'fr', 'es', 'it', 'nl', 'be', 'at', 'se', 'no', 'dk', 'fi', 'pl', 'cz', 'pt', 'gr', 'ro', 'hu',
  'ee', 'lv', 'lt', 'sk', 'si', 'hr', 'bg', 'lu', 'cy', 'mt', 'is', 'li', 'eu'])
const ROLE = /^(hello|hi|hey|contact|info|sales|team|partners?|partnerships|business|bd|api|dev|developers?|devrel|founders?|support|office|enquiries|inquiries|marketing|growth|press|general|admin|help)@/i

export const domainOf = email => String(email || '').split('@')[1]?.toLowerCase().trim() || ''
const tldOf = email => domainOf(email).split('.').pop()

/** The recipient's zone: an explicit one, else from the domain's country code, else the default. */
export function timezoneFor(email, s = DEFAULTS, explicit = null) {
  if (explicit) { try { tzValid(explicit); return explicit } catch {} }
  return TLD_TZ[tldOf(email)] || s.default_tz
}

function localParts(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', weekday: 'short', hour: 'numeric', minute: 'numeric' })
    .formatToParts(new Date(ms)).map(x => [x.type, x.value]))
  return { weekday: p.weekday, hour: Number(p.hour) % 24, minute: Number(p.minute) }
}
export function inBusinessHours(ms, tz, s = DEFAULTS) {
  const { weekday, hour } = localParts(ms, tz)
  return !['Sat', 'Sun'].includes(weekday) && hour >= s.business_start && hour < s.business_end
}
/** The first moment at or after `ms` inside the recipient's business hours (15-minute steps; DST-safe). */
export function nextBusinessTime(ms, tz, s = DEFAULTS) {
  let t = ms
  for (let i = 0; i < 4 * 24 * 8; i++, t += 15 * 60_000) {
    if (inBusinessHours(t, tz, s)) return i === 0 ? ms : t - (t % (15 * 60_000))
  }
  return ms // unreachable with valid hours
}

// ── Compliance ───────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Why this recipient may not be emailed, or null. `ctx`: suppressed (Set of emails and '@domain'), activeDomains
 * (Set of domains with a live sequence), emailed (Set of addresses that ever got a first email).
 */
export function complianceProblem(email, ctx = {}) {
  const e = String(email || '').trim().toLowerCase(), d = domainOf(e)
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(e)) return 'not a valid address'
  if (ctx.suppressed?.has(e) || ctx.suppressed?.has(`@${d}`)) return 'on the suppression list'
  if (/^(noreply|no-reply|donotreply|postmaster|abuse|privacy|legal|gdpr|dpo|security|mailer-daemon)@/.test(e)) return 'not an address for business contact'
  if (STRICT_TLDS.has(tldOf(e)) && !ROLE.test(e)) return 'EU/UK personal address: only role addresses (hello@, contact@…) are emailed there'
  if (ctx.emailed?.has(e)) return 'already emailed'
  if (ctx.activeDomains?.has(d)) return 'this company already has an email sequence running'
  return null
}

// ── Follow-ups ───────────────────────────────────────────────────────────────────────────────────────────────────
/** When follow-up `step` (1 or 2) is due, after the previous email went out at `prevSentMs`. Null past the maximum. */
export function followupDueAt(step, prevSentMs, s = DEFAULTS, rand = Math.random) {
  if (step < 1 || step > s.max_followups) return null
  return prevSentMs + (s.followup_days[step - 1] + rand() * s.followup_jitter_days) * DAY
}
export function followupEmail(step, { company, subject }) {
  const subj = /^re:/i.test(subject) ? subject : `Re: ${subject}`
  const body = step === 1
    ? `Hi ${company} team,\n\nFollowing up on my note from a few days ago. If good API docs, an MCP server and a CLI for ${company} are on your list this quarter, DocStar gets you there in an afternoon, and it's free to start.\n\nWorth a look? https://docstar.io\n\nDocStar by Walkover`
    : `Hi ${company} team,\n\nLast note from me, I promise. If API docs aren't a priority right now, no problem at all and I won't follow up again.\n\nIf they are, you can have docs, llms.txt, an MCP server and a CLI live today: https://docstar.io\n\nDocStar by Walkover`
  return { subject: subj, body }
}

// ── Replies, opt-outs, bounces, complaints ───────────────────────────────────────────────────────────────────────
const OPT_OUT = /\b(unsubscribe|opt[ -]?out|remove (me|us)|take (me|us) off|stop (emailing|contacting|sending)|do not (contact|email)|don'?t (contact|email)|not interested|no thanks|no, thanks)\b|^\s*(no|stop|remove)\s*[.!]?\s*$/im
const COMPLAINT = /\b(spam|reported|report(ing)? (this|you)|harass|illegal|gdpr complaint|data protection)\b/i
/** A reply's meaning: 'complaint', 'optout' or 'reply'. Only the first lines (above any quoted text) are read. */
export function classifyReply(text) {
  const own = String(text || '').split(/\n\s*(>|On .+wrote:|-----Original Message-----|From: )/)[0].slice(0, 2000)
  if (COMPLAINT.test(own)) return 'complaint'
  if (OPT_OUT.test(own)) return 'optout'
  return 'reply'
}
/** The failed recipient in a delivery-failure notice (Gmail's mailer-daemon), or null if it is not a hard bounce. */
export function parseBounce({ from, subject, text }) {
  if (!/mailer-daemon|postmaster/i.test(String(from)) && !/delivery status notification|undeliverable|delivery has failed|returned mail|failure notice/i.test(String(subject))) return null
  const t = String(text || '')
  if (/temporar|will retry|delayed|has been delayed|try again later/i.test(t) && !/address not found|does not exist|user unknown|no such user|recipient rejected|550/i.test(t)) return null // soft bounce
  const m = t.match(/(?:wasn't delivered to|couldn't be delivered to|delivery to the following recipients? failed[^\n]*\n\s*|address not found[\s\S]{0,200}?|final-recipient:\s*rfc822;\s*|<)([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i)
  return m ? { email: m[1].toLowerCase() } : null
}

/** Whether an inbox's recent record calls for an automatic pause, and why. */
export function pauseReason({ sent, bounces, complaints }, s = DEFAULTS) {
  if (complaints >= s.complaint_pause_count) return `${complaints} spam complaint${complaints === 1 ? '' : 's'} in ${s.monitor_window_days} days`
  if (bounces >= s.bounce_pause_count) return `${bounces} bounces in ${s.monitor_window_days} days`
  if (sent >= s.bounce_min_sample && bounces / sent > s.bounce_pause_rate) return `bounce rate ${(100 * bounces / sent).toFixed(1)}% (limit ${(100 * s.bounce_pause_rate).toFixed(1)}%)`
  return null
}
