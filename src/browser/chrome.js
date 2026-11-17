// The real Chrome the agent works in: started by us as a normal Chrome with its own profile folder and a
// local debugging port, then attached to with Playwright over CDP. Google sign-in done once by the operator
// in this window stays in the profile. If the server restarts, it re-attaches to the Chrome already running.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { chromium } from 'playwright-core'
import { maskError } from '../security/mask.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))

export function createChrome({ config, activity }) {
  const { executable, profileDir, debugPort, headless = false } = config.chrome
  const endpoint = `http://127.0.0.1:${debugPort}`
  let browser = null
  let connecting = null
  let detaching = false

  async function debuggerUp() {
    try {
      const res = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1500) })
      return res.ok
    } catch {
      return false
    }
  }

  async function pageTargets() {
    try {
      const res = await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(1500) })
      return (await res.json()).filter(t => t.type === 'page')
    } catch {
      return []
    }
  }

  // Chrome refuses browser-context commands (attach, cookies, new tab) while it has no window open, which is
  // where it sits on a Mac after its last window is closed. Open a blank tab first so they work.
  async function ensureWindow() {
    if ((await pageTargets()).length) return false
    await fetch(`${endpoint}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(3000) })
    return true
  }

  function launch() {
    if (!existsSync(executable)) throw new Error(`Chrome not found at ${executable} (set CHROME_PATH)`)
    mkdirSync(profileDir, { recursive: true, mode: 0o700 }) // holds the Google session
    const child = spawn(executable, [
      `--remote-debugging-port=${debugPort}`,
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      // Cloud worker: no screen. The profile (and its Google session) is the same persistent folder.
      ...(headless ? ['--headless=new', '--window-size=1366,900'] : []),
      'about:blank'
    ], { detached: true, stdio: 'ignore' })
    child.unref() // Chrome outlives a server restart; we re-attach to it
  }

  async function connect() {
    if (browser?.isConnected()) return browser
    if (connecting) return connecting
    connecting = (async () => {
      let launched = false
      if (!(await debuggerUp())) {
        launch()
        launched = true
        for (let i = 0; i < 40 && !(await debuggerUp()); i++) await sleep(250)
      }
      await ensureWindow()
      browser = await chromium.connectOverCDP(endpoint)
      browser.on('disconnected', () => {
        browser = null
        // Our own detach on server stop leaves Chrome open: not worth a warning.
        if (!detaching) activity.warn('chrome_disconnected', 'Chrome closed or disconnected')
      })
      activity.success('chrome_connected', launched ? 'Chrome started with the DocStar profile' : 'Attached to the running Chrome')
      return browser
    })()
    try {
      return await connecting
    } catch (error) {
      activity.error('chrome_failed', `Chrome could not start: ${maskError(error)}`)
      throw error
    } finally {
      connecting = null
    }
  }

  const context = async () => (await connect()).contexts()[0]
  let lastHealth = null

  return {
    connect,
    context,

    async page() {
      const ctx = await context()
      if (await ensureWindow()) {
        for (let i = 0; i < 20 && !ctx.pages().length; i++) await sleep(100)
      }
      return ctx.pages().find(p => !p.isClosed()) ?? ctx.newPage()
    },

    /** Never starts Chrome or opens a window; re-attaches after a server restart when a window is open. */
    async status() {
      const running = browser?.isConnected() || (await debuggerUp())
      if (!running) return { running: false, attached: false }
      const pages = (await pageTargets()).length
      if (!browser?.isConnected() && pages) await connect().catch(() => {})
      const attached = Boolean(browser?.isConnected())
      if (!attached) return { running: true, attached: false, pages }
      const base = { running: true, attached, pages, version: browser.version() }
      if (!pages) return { ...base, googleSignedIn: null, note: 'Chrome has no open window' }
      // Signed in to Google = Google's session cookie is in this profile. Read locally, nothing is visited.
      try {
        const cookies = await browser.contexts()[0].cookies('https://accounts.google.com')
        const googleSignedIn = cookies.some(c => c.name === 'SID' || c.name === '__Secure-1PSID')
        const health = googleSignedIn ? { ok: true } : { ok: false, reason: 'The agent\'s Chrome is not signed in to Google: Google sign-ups will stop for you. Press "Sign in to Google" once.' }
        if (lastHealth?.ok !== health.ok) activity[health.ok ? 'success' : 'warn']('chrome_health', health.ok ? 'Chrome is signed in to Google' : health.reason)
        lastHealth = health
        return { ...base, googleSignedIn, health }
      } catch (error) {
        return { ...base, googleSignedIn: null, health: { ok: false, reason: `Google session could not be read: ${maskError(error)}` }, note: `Google session could not be read: ${maskError(error)}` }
      }
    },

    /** Opens Google sign-in for the operator to complete by hand. The agent never types into it. */
    async openGoogleSignIn() {
      const page = await this.page()
      await page.goto('https://accounts.google.com/', { waitUntil: 'domcontentloaded' })
      await page.bringToFront()
      activity.info('google_signin_opened', 'Google sign-in opened in Chrome for the operator')
    },

    /**
     * A page in a separate, cookie-less context: for read-only visits (qualification, backlink checks), kept apart
     * from the DocStar profile and its sessions. The caller closes it (closing the page closes its context).
     */
    async isolatedPage() {
      const b = await connect()
      const ctx = await b.newContext()
      const page = await ctx.newPage()
      page.on('close', () => ctx.close().catch(() => {}))
      return page
    },

    /** Open a URL in the agent's own profile for a person (the Needs-you "where" link). */
    async open(url) {
      const u = new URL(url)
      if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) URLs')
      const page = await (await context()).newPage()
      await page.goto(u.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.bringToFront()
    },

    async bringToFront() {
      const page = await this.page()
      await page.bringToFront()
    },

    /** Detach, and optionally close Chrome itself. The profile (and the Google session) stays on disk. */
    async close({ quit = false } = {}) {
      if (!browser) return
      detaching = !quit
      if (quit) {
        const cdp = await browser.newBrowserCDPSession()
        await cdp.send('Browser.close').catch(() => {})
      }
      await browser.close().catch(() => {})
      browser = null
    }
  }
}
