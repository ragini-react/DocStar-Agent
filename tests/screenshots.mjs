// Screenshots of every dashboard view, in a separate headless Chrome (not the agent's profile).
// Run: node --env-file=.env tests/screenshots.mjs [baseUrl] [outDir]
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const base = process.argv[2] || 'http://localhost:4000'
const out = process.argv[3] || 'docs/screenshots'
mkdirSync(out, { recursive: true })

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
const errors = []
page.on('pageerror', e => errors.push(e.message))
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })

await page.goto(base)
await page.screenshot({ path: `${out}/00-login.png` })
await page.fill('#login-password', process.env.DOCSTAR_ADMIN_PASSWORD)
await page.click('#login-form button[type=submit]')
await page.waitForSelector('#app:not([hidden])')

for (const [i, view] of ['overview', 'platforms', 'queue', 'company', 'activity', 'integrations', 'credentials', 'settings'].entries()) {
  await page.goto(`${base}/#${view}`)
  await page.waitForTimeout(view === 'integrations' ? 2500 : 900)
  await page.screenshot({ path: `${out}/${String(i + 1).padStart(2, '0')}-${view}.png`, fullPage: true })
}
await page.setViewportSize({ width: 390, height: 844 })
await page.goto(`${base}/#overview`)
await page.waitForTimeout(800)
await page.screenshot({ path: `${out}/08-overview-mobile.png`, fullPage: true })

await browser.close()
console.log(errors.length ? `page errors:\n${errors.join('\n')}` : 'no page errors')
