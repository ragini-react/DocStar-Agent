// Event-based waits and navigation-safe page access. Nothing here sleeps a fixed time: it waits for the page's load
// state, a URL, a response or the network going quiet, each with a timeout.

/** The page navigated while we were reading it: re-acquire it and read again. */
export const isNavigationError = e => /Execution context was destroyed|Cannot find context with specified id|frame was detached|navigation|Inspected target navigated/i.test(e?.message || '')
/** The page, context or browser is gone: recover the browser, then continue from the checkpoint. */
export const isClosedError = e => /Target page, context or browser has been closed|Target closed|Browser has been closed|browser has disconnected|Session closed|Protocol error.*Target/i.test(e?.message || '')

/**
 * Wait until a page has settled after an action: DOM loaded, then the network quiet for a moment (capped), so
 * client-side frameworks finish rendering. Never a blind sleep.
 */
export async function settle(page, { timeout = 10_000, quiet = 4_000 } = {}) {
  if (!page || page.isClosed()) return
  await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => {})
  await page.waitForLoadState('networkidle', { timeout: quiet }).catch(() => {}) // long-polling pages never go idle: capped
}

/**
 * page.evaluate that survives a navigation in the middle: wait for the new document and try again.
 * `getPage` returns the current page (it may change, e.g. after an OAuth popup closes).
 */
export async function safeEvaluate(getPage, fn, arg, { attempts = 4 } = {}) {
  let last
  for (let i = 0; i < attempts; i++) {
    const page = typeof getPage === 'function' ? await getPage() : getPage
    try {
      return await page.evaluate(fn, arg)
    } catch (e) {
      last = e
      if (!isNavigationError(e)) throw e
      await settle(page, { quiet: 2_000 })
    }
  }
  throw last
}

/**
 * Run `action` and wait until what it started has finished: listeners attach before the action, so a request the
 * click fires at once is counted; then the DOM is loaded and no request has been in flight for `idleMs`.
 * (waitForLoadState('networkidle') returns at once on a page that was already idle, so it cannot see a click's fetch.)
 */
export async function quietAfter(page, action, { idleMs = 500, timeout = 15_000 } = {}) {
  const inflight = new Set()
  let lastChange = Date.now()
  const start = r => { inflight.add(r); lastChange = Date.now() }
  const end = r => { inflight.delete(r); lastChange = Date.now() }
  page.on('request', start)
  page.on('requestfinished', end)
  page.on('requestfailed', end)
  try {
    const result = await action()
    const deadline = Date.now() + timeout
    await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => {})
    // Long-lived requests (event streams, sockets, beacons) never finish: they are not counted.
    while (Date.now() < deadline && !page.isClosed()) {
      const active = [...inflight].filter(r => !['eventsource', 'websocket', 'ping', 'beacon'].includes(r.resourceType()))
      if (!active.length && Date.now() - lastChange >= idleMs) break
      await new Promise(r => setTimeout(r, 50)) // a poll of our own counters, not a wait on the page
    }
    return result
  } finally {
    page.off('request', start)
    page.off('requestfinished', end)
    page.off('requestfailed', end)
  }
}

/** Wait for a condition on the page URL (or the page closing), without sleeping. */
export async function waitForUrlChange(page, from, { timeout = 15_000 } = {}) {
  try {
    await page.waitForURL(u => u.toString() !== from, { timeout, waitUntil: 'domcontentloaded' })
    return true
  } catch { return false }
}
