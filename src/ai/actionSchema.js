// The only browser actions the AI may propose, and the server-side check every proposal passes
// before Playwright runs it. The AI sees elements by ref (e1, e2, …) from our own page snapshot,
// never raw selectors, and fills secrets and company facts through {{placeholders}} we resolve.

export const ACTIONS = ['click', 'type', 'select', 'upload', 'scroll', 'wait', 'navigate', 'submit', 'verify_email', 'request_human', 'skip', 'complete']
export const SKIP_REASONS = ['paid', 'already_listed', 'not_possible', 'policy', 'not_relevant']

const ELEMENT_ACTIONS = new Set(['click', 'type', 'select', 'upload', 'submit'])
// May point at an element (the CAPTCHA to show the operator) but need not.
const OPTIONAL_TARGET_ACTIONS = new Set(['request_human', 'skip', 'verify_email'])
const VALUE_ACTIONS = new Set(['type', 'select', 'upload', 'navigate', 'scroll', 'wait'])
// May carry a value: complete → the listing URL if one is visible; skip → one of SKIP_REASONS.
const OPTIONAL_VALUE_ACTIONS = new Set(['complete', 'skip'])
// Actions that send company information or publish it: allowed only once the listing is approved.
const PUBLISHING_ACTIONS = new Set(['submit'])

export const browserActionSchema = {
  name: 'browser_action',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['action', 'target', 'value', 'reason', 'confidence', 'requiresHumanApproval'],
    properties: {
      action: { type: 'string', enum: ACTIONS },
      target: { type: ['string', 'null'], description: 'Element ref from the snapshot, e.g. "e12"; null when the action has no element' },
      value: { type: ['string', 'null'], description: 'Text to type, option to select, URL to open, "up"/"down" to scroll, seconds to wait, {{company.logo}} to upload, the listing URL on complete, a skip reason (paid, already_listed, not_possible, policy, not_relevant); null otherwise' },
      reason: { type: 'string', description: 'One sentence: why this step' },
      confidence: { type: 'number', description: '0 to 1' },
      requiresHumanApproval: { type: 'boolean', description: 'true for a CAPTCHA, payment, unclear terms, or anything you are unsure is allowed' }
    }
  }
}

const PLACEHOLDER = /\{\{([A-Za-z0-9_.]+)\}\}/g

/**
 * @param {unknown} proposal  the AI's answer
 * @param {object} ctx
 * @param {Set<string>} ctx.refs              element refs present in the snapshot sent with this step
 * @param {string[]} ctx.allowedHosts         hosts this task may open (the platform, its auth hosts)
 * @param {Set<string>} ctx.placeholders      placeholder names the server can fill ({{company.name}}, {{account.password}})
 * @param {Set<string>} ctx.approvedTexts     listing texts the operator approved, typed verbatim
 * @param {boolean} ctx.listingApproved       the operator approved publishing on this platform
 * @returns {{ ok: true, action: object } | { ok: false, errors: string[] }}
 */
export function validateBrowserAction(proposal, ctx) {
  const errors = []
  const p = proposal
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { ok: false, errors: ['not an object'] }

  const keys = Object.keys(p).sort().join(',')
  if (keys !== 'action,confidence,reason,requiresHumanApproval,target,value') errors.push(`unexpected keys: ${keys}`)
  if (!ACTIONS.includes(p.action)) errors.push(`action not allowed: ${String(p.action)}`)
  if (typeof p.reason !== 'string' || !p.reason.trim()) errors.push('reason missing')
  if (typeof p.confidence !== 'number' || p.confidence < 0 || p.confidence > 1) errors.push('confidence must be 0..1')
  if (typeof p.requiresHumanApproval !== 'boolean') errors.push('requiresHumanApproval must be boolean')
  if (errors.length) return { ok: false, errors }

  if (ELEMENT_ACTIONS.has(p.action)) {
    if (typeof p.target !== 'string' || !ctx.refs.has(p.target)) errors.push(`target not in snapshot: ${String(p.target)}`)
  } else if (OPTIONAL_TARGET_ACTIONS.has(p.action)) {
    if (p.target !== null && !ctx.refs.has(p.target)) errors.push(`target not in snapshot: ${String(p.target)}`)
  } else if (p.target !== null) {
    errors.push(`${p.action} takes no target`)
  }

  if (VALUE_ACTIONS.has(p.action) && (typeof p.value !== 'string' || !p.value)) errors.push(`${p.action} needs a value`)
  if (!VALUE_ACTIONS.has(p.action) && !OPTIONAL_VALUE_ACTIONS.has(p.action) && p.value !== null) errors.push(`${p.action} takes no value`)
  if (p.action === 'skip' && p.value !== null && !SKIP_REASONS.includes(p.value)) errors.push(`skip reason must be one of ${SKIP_REASONS.join(', ')}`)
  if (p.action === 'complete' && p.value !== null) {
    try { if (!/^https?:$/.test(new URL(p.value).protocol)) errors.push('complete value must be an http(s) URL') } catch { errors.push('complete value must be a URL') }
  }
  if (p.action === 'upload' && p.value !== '{{company.logo}}') errors.push('upload value must be {{company.logo}}')

  if (p.action === 'navigate' && typeof p.value === 'string') {
    let url
    try { url = new URL(p.value) } catch { errors.push('navigate value is not a URL') }
    if (url) {
      if (url.protocol !== 'https:') errors.push('navigate must be https')
      const ok = ctx.allowedHosts.some(h => url.hostname === h || url.hostname.endsWith(`.${h}`))
      if (!ok) errors.push(`host not allowed for this task: ${url.hostname}`)
    }
  }

  if (p.action === 'scroll' && !['up', 'down'].includes(p.value)) errors.push('scroll value must be up or down')
  if (p.action === 'wait' && !(Number(p.value) > 0 && Number(p.value) <= 30)) errors.push('wait must be 1..30 seconds')

  if (p.action === 'type' && typeof p.value === 'string') {
    if (p.value.length > 5000) errors.push('typed value too long')
    for (const [, name] of p.value.matchAll(PLACEHOLDER)) {
      if (!ctx.placeholders.has(name)) errors.push(`unknown placeholder: {{${name}}}`)
    }
    // Free text must be something the operator approved; anything else must be only placeholders.
    const bare = p.value.replace(PLACEHOLDER, '').trim()
    if (bare && !ctx.approvedTexts.has(p.value)) errors.push('typed text is neither a placeholder nor approved listing text')
  }

  if (PUBLISHING_ACTIONS.has(p.action) && !ctx.listingApproved && !p.requiresHumanApproval) {
    errors.push('submit before the listing was approved')
  }

  if (errors.length) return { ok: false, errors }
  // A proposal that asks for a human, or a submit before approval, always pauses the task.
  const pause = p.action === 'request_human' || p.requiresHumanApproval || (PUBLISHING_ACTIONS.has(p.action) && !ctx.listingApproved)
  return { ok: true, action: { ...p, pause } }
}
