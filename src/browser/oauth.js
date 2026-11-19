// "Continue with Google" without a person: the sign-in opens either as a popup or in the same tab. We follow whichever
// it is, pick the DocStar account on Google's chooser, accept the consent screen, and wait until the popup closes or
// the tab is back on the platform. The agent never types a Google password: if Google asks for one (the profile is not
// signed in), the result says so and the task goes to a person for the one-time sign-in.
import { settle } from './pageGuard.js'
import { BRAND } from '../agent/brand.js'

export const GOOGLE_AUTH_HOSTS = ['accounts.google.com']
const onHost = (url, hosts) => { try { const h = new URL(url).hostname; return hosts.some(x => h === x || h.endsWith(`.${x}`)) } catch { return false } }

/**
 * Run `action` (a click) and collect any page it opens. Returns { popup } (null when none opened).
 * Listening starts before the click, so a popup that opens at once is never missed.
 */
export async function withPopup(context, action, { waitMs = 2_500 } = {}) {
  let popup = null
  const onPage = p => { popup ||= p }
  context.on('page', onPage)
  try {
    await action()
    if (!popup) await context.waitForEvent('page', { timeout: waitMs }).then(p => { popup ||= p }).catch(() => {})
  } finally {
    context.off('page', onPage)
  }
  return { popup }
}

/**
 * Follow a Google OAuth flow in `authPage` (a popup, or the original tab redirected to Google).
 * @returns {Promise<{ ok: boolean, page?: object, reason?: string, needsHuman?: boolean, steps: string[] }>}
 */
export async function followGoogleOAuth({ authPage, originalPage, email, authHosts = GOOGLE_AUTH_HOSTS, timeout = 60_000 }) {
  const steps = []
  const deadline = Date.now() + timeout
  const isPopup = authPage !== originalPage
  let clicks = 0
  while (Date.now() < deadline) {
    if (authPage.isClosed()) { steps.push('popup closed'); break }
    await settle(authPage, { quiet: 2_000 })
    if (authPage.isClosed()) { steps.push('popup closed'); break }
    if (!onHost(authPage.url(), authHosts)) { steps.push(`back on ${new URL(authPage.url()).host}`); break }
    if (++clicks > 8) return { ok: false, reason: 'Google sign-in did not finish after 8 steps', steps }

    // Google asks for a password or a second factor: the profile is not signed in. One-time job for a person.
    if (await authPage.locator('input[type=password]:visible, input[name=Passwd]:visible, #totpPin:visible, [data-challengetype]:visible').count()) {
      return { ok: false, needsHuman: true, reason: 'Google asks for the password or a 2-step check: the agent\'s Chrome is not signed in to Google', steps }
    }
    // Account chooser: the DocStar account.
    const account = authPage.locator(`[data-identifier="${email}" i], [data-email="${email}" i]`).first()
    if (await account.count()) {
      steps.push(`chose the ${BRAND} account`)
      await act(authPage, () => account.click({ timeout: 10_000 }))
      continue
    }
    const byText = authPage.getByText(email, { exact: false }).first()
    if (await byText.count() && await byText.isVisible().catch(() => false)) {
      steps.push(`chose the ${BRAND} account (by text)`)
      await act(authPage, () => byText.click({ timeout: 10_000 }))
      continue
    }
    // An email box: Google wants an account typed in, which means the DocStar account is not in this profile.
    if (await authPage.locator('input[type=email]:visible, #identifierId:visible').count()) {
      return { ok: false, needsHuman: true, reason: `${email} is not signed in to the agent's Chrome (Google shows an email box)`, steps }
    }
    // Consent / continue screen.
    const consent = authPage.getByRole('button', { name: /^(continue|allow|confirm|accept|i understand|weiter|continuer)$/i }).first()
    if (await consent.count()) {
      steps.push(`pressed "${(await consent.innerText().catch(() => 'Continue')).trim()}"`)
      await act(authPage, () => consent.click({ timeout: 10_000 }))
      continue
    }
    // Nothing to press yet: wait for the page to change (or close) instead of sleeping.
    const from = authPage.url()
    await Promise.race([
      authPage.waitForURL(u => u.toString() !== from, { timeout: 8_000 }).catch(() => {}),
      authPage.waitForEvent('close', { timeout: 8_000 }).catch(() => {})
    ])
  }
  if (Date.now() >= deadline) return { ok: false, reason: 'Google sign-in timed out', steps }
  // Back to the platform: the original tab (popup flow) or the same tab (redirect flow), settled.
  const page = isPopup ? originalPage : authPage
  if (isPopup) await originalPage.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {})
  await settle(page)
  return { ok: true, page, steps }
}

async function act(page, click) {
  const from = page.url()
  await click()
  await Promise.race([
    page.waitForURL(u => u.toString() !== from, { timeout: 10_000 }).catch(() => {}),
    page.waitForEvent('close', { timeout: 10_000 }).catch(() => {})
  ])
}

export const isAuthUrl = (url, hosts = GOOGLE_AUTH_HOSTS) => onHost(url, hosts)
