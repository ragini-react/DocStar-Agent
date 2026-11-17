// Every form submission is checked before and judged after:
//   before: each field's value and validity (required, :invalid, aria-invalid), and values that a page may have reset
//           since we set them (DevHunt resets pricing after the logo upload) are put back;
//   after:  the platform's XHR/fetch/document responses (status and a short, masked body), new validation messages,
//           the URL and confirmation text, and a screenshot. Success or failure is decided from that evidence.
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { maskText } from '../security/mask.js'
import { quietAfter, safeEvaluate } from './pageGuard.js'

// Runs in the page. Kept dependency-free: it is serialized by Playwright.
function auditInPage(ref) {
  const target = ref ? document.querySelector(`[data-ds-ref="${ref}"]`) : null
  const scope = target?.closest('form') || document
  const labelOf = el => ((el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText) || el.closest('label')?.innerText ||
    el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.id || '').trim().replace(/\s+/g, ' ').slice(0, 80)
  const keyOf = el => el.getAttribute('name') || el.id || labelOf(el)
  const fields = []
  for (const el of scope.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=image]), textarea, select')) {
    const type = (el.getAttribute('type') || el.tagName).toLowerCase()
    const r = el.getBoundingClientRect()
    const visible = type === 'file' || (r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden')
    if (!visible || el.disabled) continue
    const required = el.required || el.getAttribute('aria-required') === 'true'
    const value = type === 'checkbox' || type === 'radio' ? (el.checked ? 'checked' : '') : type === 'file' ? (el.files?.length ? `${el.files.length} file(s)` : '')
      : el.tagName === 'SELECT' ? (el.selectedOptions[0]?.text || '').trim() : el.value
    let valid = true
    try { valid = el.checkValidity() } catch {}
    if (el.getAttribute('aria-invalid') === 'true' || el.matches(':invalid')) valid = false
    fields.push({ key: keyOf(el), label: labelOf(el), type, required, filled: Boolean(value), value: type === 'password' ? (value ? '••••' : '') : String(value).slice(0, 60), valid, message: el.validationMessage || '' })
  }
  // Radio groups count once: required + one checked is enough.
  const seen = new Map()
  for (const f of fields.filter(f => f.type === 'radio')) seen.set(f.key, (seen.get(f.key) || false) || f.filled)
  const problems = fields.filter(f => (f.type === 'radio' ? f.required && !seen.get(f.key) : (!f.valid || (f.required && !f.filled))))
  const uniq = [...new Map(problems.map(p => [p.key, p])).values()]
  return { fields, problems: uniq }
}

export async function auditForm(page, ref) {
  return safeEvaluate(page, auditInPage, ref)
}

/**
 * Put back values the page reset since we set them. `expected`: { [fieldKey]: { kind: 'select'|'check', value, selector } }.
 * Returns the list of fields that had to be restored (each is a gotcha worth remembering).
 */
export async function restoreResetValues(page, audit, expected) {
  const restored = []
  for (const [key, want] of Object.entries(expected || {})) {
    const f = audit.fields.find(x => x.key === key || x.label === key)
    if (!f) continue
    const now = want.kind === 'check' ? (f.value === 'checked') : f.value
    const ok = want.kind === 'check' ? now === want.value : String(now).trim().toLowerCase() === String(want.value).trim().toLowerCase()
    if (ok) continue
    try {
      const loc = page.locator(want.selector).first()
      if (want.kind === 'select') { try { await loc.selectOption({ label: want.value }, { timeout: 5_000 }) } catch { await loc.selectOption(want.value, { timeout: 5_000 }) } }
      else if (want.kind === 'check') await (want.value ? loc.check({ timeout: 5_000 }) : loc.uncheck({ timeout: 5_000 }))
      restored.push({ key, was: now, now: want.value })
    } catch (e) { restored.push({ key, was: now, now: want.value, failed: e.message }) }
  }
  return restored
}

// Runs in the page: what the page says after a submit.
function afterInPage() {
  const sel = '[role=alert], .error, .errors, .invalid-feedback, .field-error, .form-error, .text-red-500, .text-red-600, .text-danger, [aria-invalid="true"], .is-invalid, .help-block.error'
  const messages = [...document.querySelectorAll(sel)].map(e => (e.innerText || e.getAttribute('aria-errormessage') || '').trim()).filter(t => t && t.length < 300)
  return { url: location.href, text: (document.body?.innerText || '').slice(0, 4000), messages: [...new Set(messages)].slice(0, 10), invalid: document.querySelectorAll(':invalid:not(form):not(fieldset)').length }
}

const SUCCESS = /thank you|thanks for (your )?submi|successfully (submitted|added|created|listed)|has been submitted|submission (was )?received|we('| wi)ll review|under review|pending (review|approval)|awaiting (review|approval)|is (now )?live|your (tool|product|listing|startup) (is|has been)/i
const FAILURE = /(is|are) required|must (be|have|contain)|invalid|already (exists|taken|submitted)|try again|something went wrong|error occurred|failed to/i

/**
 * Click submit and decide from evidence. `click` performs the click. Returns { verdict: 'success'|'failure'|'unknown', evidence }.
 */
export async function submitWithEvidence(page, click, { platformHost, screenshotFile = null, beforeAudit = null } = {}) {
  const responses = []
  const pending = []
  const onResponse = r => {
    const req = r.request()
    const type = req.resourceType()
    let host = ''
    try { host = new URL(r.url()).hostname } catch {}
    if (!['xhr', 'fetch', 'document'].includes(type)) return
    if (!['POST', 'PUT', 'PATCH'].includes(req.method()) && type !== 'document') return
    if (platformHost && !(host === platformHost || host.endsWith(`.${platformHost}`) || platformHost.endsWith(`.${host}`))) return
    pending.push(r.text().catch(() => '').then(body => responses.push({ method: req.method(), path: new URL(r.url()).pathname, status: r.status(), type, body: maskText(body.replace(/\s+/g, ' ')).slice(0, 300) })))
  }
  const beforeUrl = page.url()
  const before = await safeEvaluate(page, afterInPage).catch(() => ({ messages: [], text: '' }))
  page.on('response', onResponse)
  try {
    await quietAfter(page, click, { idleMs: 700 })
  } finally {
    page.off('response', onResponse)
  }
  await Promise.all(pending)
  const after = await safeEvaluate(page, afterInPage).catch(() => ({ url: page.url(), text: '', messages: [], invalid: 0 }))
  let screenshot = null
  if (screenshotFile) {
    mkdirSync(path.dirname(screenshotFile), { recursive: true, mode: 0o700 })
    screenshot = await page.screenshot({ path: screenshotFile, fullPage: false }).then(() => screenshotFile).catch(() => null)
  }
  const newMessages = after.messages.filter(m => !before.messages.includes(m))
  const bad = responses.filter(r => r.status >= 400)
  const good = responses.filter(r => r.status >= 200 && r.status < 400 && r.method !== 'GET')
  const moved = after.url !== beforeUrl
  const confirms = SUCCESS.test(after.text) && !SUCCESS.test(before.text)
  let verdict = 'unknown'
  let why = 'the page did not change and showed no message'
  if (bad.length) { verdict = 'failure'; why = `the platform answered HTTP ${bad.map(r => r.status).join(', ')}` }
  else if (newMessages.length && newMessages.some(m => FAILURE.test(m) || !SUCCESS.test(m))) { verdict = 'failure'; why = `the page shows: ${newMessages.slice(0, 3).join(' | ')}` }
  else if (after.invalid > 0 && !moved) { verdict = 'failure'; why = `${after.invalid} field(s) are still invalid` }
  else if (confirms) { verdict = 'success'; why = 'the page confirms the submission' }
  else if (good.length && moved) { verdict = 'success'; why = `the platform accepted it (HTTP ${good[0].status}) and moved to ${new URL(after.url).pathname}` }
  else if (good.length) { verdict = 'unknown'; why = `the platform answered HTTP ${good[0].status} but the page shows no confirmation` }
  return { verdict, why, evidence: { beforeUrl, afterUrl: after.url, responses: responses.slice(0, 8), messages: newMessages, invalidFields: after.invalid, confirms, problemsBefore: beforeAudit?.problems?.map(p => p.label || p.key) || [] }, screenshot }
}

export const _auditInPage = auditInPage
