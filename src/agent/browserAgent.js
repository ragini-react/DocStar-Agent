// What the AI sees of a page and how its validated decisions are carried out in the agent's Chrome.
// Elements are tagged with data-ds-ref="eN" by our own snapshot script; the AI only ever names those refs.

// Runs in the page. Kept dependency-free: it is serialized by Playwright.
function snapshotInPage(limit) {
  for (const el of document.querySelectorAll('[data-ds-ref]')) el.removeAttribute('data-ds-ref')
  const sel = 'a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[role=checkbox],[role=radio],[role=combobox],[role=option],[role=menuitem],[role=tab],[contenteditable=true],summary'
  const lines = []
  let n = 0
  for (const el of document.querySelectorAll(sel)) {
    const tag = el.tagName.toLowerCase()
    const type = (el.getAttribute('type') || '').toLowerCase()
    const r = el.getBoundingClientRect()
    const st = getComputedStyle(el)
    const isFile = tag === 'input' && type === 'file'
    if (!isFile && (r.width < 2 || r.height < 2 || st.visibility === 'hidden' || st.display === 'none')) continue
    if (el.disabled) continue
    if (n >= limit) break
    const ref = `e${++n}`
    el.setAttribute('data-ds-ref', ref)
    const role = el.getAttribute('role') || ({ a: 'link', select: 'select', textarea: 'textbox', summary: 'button' }[tag]) ||
      (tag === 'input' ? (['checkbox', 'radio', 'file', 'submit', 'button', 'email', 'password', 'url', 'search', 'tel'].includes(type) ? type : 'textbox') : tag)
    const label = (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText) || el.closest('label')?.innerText || ''
    const name = (el.getAttribute('aria-label') || label || (tag !== 'input' && tag !== 'select' && tag !== 'textarea' ? el.innerText : '') ||
      el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || (tag === 'input' ? el.value : '') || '')
      .trim().replace(/\s+/g, ' ').slice(0, 90)
    const bits = []
    if (el.getAttribute('placeholder') && !name.includes(el.getAttribute('placeholder'))) bits.push(`placeholder="${el.getAttribute('placeholder').slice(0, 40)}"`)
    if (el.required || el.getAttribute('aria-required') === 'true') bits.push('required')
    if (type === 'checkbox' || type === 'radio') bits.push(el.checked ? 'checked' : 'unchecked')
    if (['textbox', 'email', 'url', 'search', 'tel', 'textarea'].includes(role) || tag === 'textarea') bits.push(el.value ? `filled="${el.value.slice(0, 40)}"` : 'empty')
    if (type === 'password') bits.push(el.value ? 'filled' : 'empty')
    if (tag === 'select') bits.push(`options=[${[...el.options].slice(0, 20).map(o => o.text.trim()).join(' | ')}]${el.value ? ` selected="${el.selectedOptions[0]?.text.trim()}"` : ''}`)
    if (tag === 'a') { try { const u = new URL(el.href); if (u.host !== location.host) bits.push(`→ ${u.host}`) } catch {} }
    if (isFile) bits.push(`accept="${el.getAttribute('accept') || '*'}"`)
    lines.push(`[${ref}] ${role} "${name}"${bits.length ? ' ' + bits.join(' ') : ''}`)
  }
  const frames = [...document.querySelectorAll('iframe')].map(f => f.src || '')
  const captcha = frames.some(s => /recaptcha|hcaptcha|challenges\.cloudflare|turnstile|arkoselabs|funcaptcha|captcha/i.test(s)) ||
    !!document.querySelector('.g-recaptcha,.h-captcha,.cf-turnstile,[data-sitekey],#captcha,input[name*="captcha" i]') ||
    /verify you are human|are you a robot|complete the security check/i.test(document.body?.innerText || '')
  const otp = !!document.querySelector('input[autocomplete="one-time-code"]') || /enter (the )?(verification|security|one[- ]time) code/i.test(document.body?.innerText || '')
  return { url: location.href, title: document.title, elements: lines, refs: lines.map(l => l.slice(1, l.indexOf(']'))), text: (document.body?.innerText || '').replace(/\n{2,}/g, '\n').slice(0, 3500), captcha, otp }
}

export async function snapshot(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {})
  return page.evaluate(snapshotInPage, 160)
}

export function renderSnapshot(s) {
  return `URL: ${s.url}\nTITLE: ${s.title}\n\nINTERACTIVE ELEMENTS:\n${s.elements.join('\n') || '(none)'}\n\nPAGE TEXT (start):\n${s.text}`
}

/** Replace {{placeholders}} with real values; unknown ones were already refused by the validator. */
export function fill(value, values) {
  return value.replace(/\{\{([A-Za-z0-9_.]+)\}\}/g, (_, k) => values[k] ?? '')
}

const PAYMENT_HOSTS = /(^|\.)(stripe\.com|paypal\.com|paddle\.com|lemonsqueezy\.com|gumroad\.com|chargebee\.com|checkout\.com|braintreegateway\.com|razorpay\.com|2checkout\.com|fastspring\.com)$/i
export const isPaymentPage = url => { try { const u = new URL(url); return PAYMENT_HOSTS.test(u.hostname) || /\/(checkout|payment|billing|upgrade)(\/|$|\?)/i.test(u.pathname) } catch { return false } }

/** Carry out one validated action. Returns a short description of what happened for the next AI turn. */
export async function execute(page, action, { values, logoPath }) {
  const el = () => page.locator(`[data-ds-ref="${action.target}"]`).first()
  const settle = () => page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {}).then(() => page.waitForTimeout(1500))
  switch (action.action) {
    case 'click':
    case 'submit':
      await el().scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {})
      await el().click({ timeout: 10_000 })
      await settle()
      return `clicked ${action.target}`
    case 'type': {
      const text = fill(action.value, values)
      await el().fill(text, { timeout: 10_000 })
      return `typed into ${action.target} (${action.value.includes('password') ? 'password' : `${text.length} chars`})`
    }
    case 'select':
      try { await el().selectOption({ label: action.value }, { timeout: 8000 }) } catch { await el().selectOption(action.value, { timeout: 8000 }) }
      return `selected "${action.value}"`
    case 'upload':
      if (!logoPath) throw new Error('no logo file available')
      await el().setInputFiles(logoPath, { timeout: 10_000 })
      await page.waitForTimeout(1500)
      return 'uploaded the DocStar logo'
    case 'scroll':
      await page.mouse.wheel(0, action.value === 'up' ? -800 : 800)
      await page.waitForTimeout(700)
      return `scrolled ${action.value}`
    case 'wait':
      await page.waitForTimeout(Number(action.value) * 1000)
      return `waited ${action.value}s`
    case 'navigate':
      await page.goto(action.value, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForTimeout(1500)
      return `opened ${new URL(action.value).host}`
    default:
      throw new Error(`execute does not handle ${action.action}`)
  }
}
