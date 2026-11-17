// Part 5 (and Part 13) integration: real headless Chrome against a local mock platform. A scripted stand-in for the
// AI picks actions from the real page snapshot; everything else is the production submit task.
//   - Google OAuth in a popup, followed to the end; sign-up recorded with its method
//   - a form that resets "Pricing type" after the logo upload (restored before submitting)
//   - a field with hidden validation (aria-invalid): not submitted until fixed
//   - success decided from the network response and the page's confirmation
//   - duplicate prevention: an existing listing is recorded, never submitted again
//   - a browser crash mid-task: relaunched, resumed from the verified checkpoint
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { startMockPlatform } from '../fixtures/mockPlatform.mjs'
import { createSubmitTask } from '../../src/agent/submitTask.js'
import { createListingFinder } from '../../src/agent/listingFinder.js'
import { createPlaybooks } from '../../src/agent/playbooks.js'
import { setup } from '../helpers/setup.js'

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const skip = !existsSync(CHROME) && 'Google Chrome is not installed'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

/** A Chrome that can crash and be relaunched with the same profile, like the real one. */
function testChrome(dir) {
  let ctx = null
  let launches = 0
  return {
    get launches() { return launches },
    async connect() {
      if (ctx && ctx.browser()?.isConnected() !== false && ctx.pages) { try { ctx.pages(); return ctx } catch {} }
      ctx = await chromium.launchPersistentContext(path.join(dir, 'profile'), { executablePath: CHROME, headless: true })
      launches++
      ctx.on('close', () => { ctx = null })
      return ctx
    },
    async context() { return ctx || this.connect() },
    crash: () => ctx?.close(),
    close: () => ctx?.close()
  }
}

/** Scripted decisions from the snapshot text: what a careful person would do next. */
function scriptedAi({ skipTaglineFirst = false, onStep = null } = {}) {
  let n = 0
  let taglineSkipped = false
  const act = (action, target = null, value = null, reason = action) => ({ action, target, value, reason, confidence: 0.9, requiresHumanApproval: false })
  return {
    calls: () => n,
    async json({ message }) {
      n++
      await onStep?.(n, message)
      const lines = message.split('\n').filter(l => /^\[e\d+\]/.test(l))
      const ref = re => lines.find(l => re.test(l))?.match(/^\[(e\d+)\]/)?.[1]
      const line = re => lines.find(l => re.test(l)) || ''
      if (/SUBMIT RESULT: SUCCESS/.test(message)) return act('complete', null, null, 'submitted')
      if (ref(/button "Continue with Google"/)) return act('click', ref(/button "Continue with Google"/))
      if (ref(/link "Submit your tool"/)) return act('click', ref(/link "Submit your tool"/))
      if (/TITLE: Submit your tool/.test(message)) {
        if (/empty/.test(line(/"Tool name/))) return act('type', ref(/"Tool name/), '{{listing.title}}')
        if (/empty/.test(line(/"Website/))) return act('type', ref(/"Website/), '{{company.website}}')
        if (/empty/.test(line(/"Tagline/))) {
          if (skipTaglineFirst && !taglineSkipped) { taglineSkipped = true } else return act('type', ref(/"Tagline/), '{{listing.tagline}}')
        }
        if (!/selected="Subscription"/.test(line(/select "Pricing type/)) && !/uploaded/.test(message)) return act('select', ref(/select "Pricing type/), 'Subscription')
        if (!/logo uploaded|uploaded the DocStar logo/.test(message)) return act('upload', ref(/file "Logo/), '{{company.logo}}')
        return act('submit', ref(/button "Submit tool"/))
      }
      return act('wait', null, '1')
    },
    async text() { return '' }
  }
}

function harness({ mock, ai, chrome, dir }) {
  const t = setup({ browser: true })
  const { platform } = t.platforms.create({ name: 'Mock', url: mock.platformUrl })
  const id = platform.id
  t.db.prepare(`INSERT INTO submissions (platform_id, status, listing_title) VALUES (?, 'approved', 'DocStar')`).run(id)
  t.db.prepare(`UPDATE platforms SET status = 'approved', submission_url = ? WHERE id = ?`).run(mock.platformUrl + '/', id)
  mkdirSync(path.join(dir, 'assets'), { recursive: true })
  writeFileSync(path.join(dir, 'assets', 'docstar-logo.png'), PNG)
  const facts = { name: 'DocStar', website: 'https://docstar.io/', tagline: 'API docs your agent writes', short_description: 'x', long_description: 'y', category: 'API documentation', logo_url: '' }
  const playbooks = createPlaybooks({ db: t.db })
  const submit = createSubmitTask({
    db: t.db, vault: { encrypt: s => s, decrypt: s => s }, ai, chrome, gmail: null, activity: t.activity, status: t.status,
    company: { approved: () => facts }, listings: { get: () => ({ title: 'DocStar', tagline: 'API docs your agent writes', short_description: 'x', long_description: 'y', tags: ['api'], status: 'approved' }) },
    config: { dbPath: path.join(dir, 'x.db') }, finder: createListingFinder({ allowPrivate: true }), playbooks,
    opts: { authHosts: ['localhost'], maxSteps: 25 }
  })
  t.orchestrator.register('submit', submit, { browser: true, start: 'submitting', entry: 'approved', exhausted: 'needs_you', failed: 'submission_failed' })
  t.orchestrator.enqueue(id, 'submit')
  t.run()
  return { ...t, id, playbooks }
}

test('Google popup sign-up, reset value restored, hidden validation caught, success judged from evidence', { skip, timeout: 120_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'docstar-it-'))
  const mock = await startMockPlatform()
  const chrome = testChrome(dir)
  const ai = scriptedAi({ skipTaglineFirst: true })
  const t = harness({ mock, ai, chrome, dir })
  try {
    await t.orchestrator._tick()
    const task = t.db.prepare('SELECT state, last_error FROM automation_tasks').get()
    assert.equal(task.state, 'done', task.last_error)
    assert.equal(t.status.get(t.id).status, 'submitted')
    assert.equal(mock.state.submissions.length, 1, 'exactly one submission')
    assert.equal(mock.state.submissions[0].pricing, 'Subscription', 'pricing restored after the logo upload reset it')
    const acc = t.db.prepare('SELECT login_method, signup_completed_at FROM accounts WHERE platform_id = ?').get(t.id)
    assert.equal(acc.login_method, 'google')
    assert.ok(acc.signup_completed_at, 'sign-up recorded as finished')
    const events = t.db.prepare(`SELECT event, message FROM activity_logs ORDER BY id`).all()
    assert.ok(events.some(e => e.event === 'google_oauth' && /finished/.test(e.message)))
    assert.ok(events.some(e => e.event === 'form_values_restored'))
    assert.deepEqual(events.filter(e => e.event === 'submit_evidence').map(e => /success/.test(e.message)), [true], 'one submit, judged a success')
    assert.ok(!events.some(e => e.event === 'listing_found'))
    assert.ok(t.playbooks.get(t.id).gotchas.some(g => /Pricing type/.test(g)), 'gotcha learned')
    assert.ok(t.db.prepare('SELECT COUNT(*) n FROM screenshots WHERE platform_id = ?').get(t.id).n >= 1)
    assert.deepEqual(t.status.contradictions(), [])
  } finally { t.orchestrator.shutdown(); await chrome.close(); mock.close() }
})

test('an existing listing is found first and never submitted again', { skip, timeout: 60_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'docstar-it-'))
  const mock = await startMockPlatform({ alreadyListed: true })
  const chrome = testChrome(dir)
  const t = harness({ mock, ai: scriptedAi(), chrome, dir })
  try {
    await t.orchestrator._tick()
    assert.equal(t.status.get(t.id).status, 'published')
    assert.equal(mock.state.posts, 0, 'nothing was posted')
    assert.match(t.db.prepare('SELECT listing_url FROM submissions WHERE platform_id = ?').get(t.id).listing_url, /\/listing\/docstar$/)
  } finally { t.orchestrator.shutdown(); await chrome.close(); mock.close() }
})

test('a browser crash mid-task: Chrome is relaunched and the task continues from its checkpoint', { skip, timeout: 120_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'docstar-it-'))
  const mock = await startMockPlatform()
  const chrome = testChrome(dir)
  let crashed = false
  const ai = scriptedAi({ onStep: async (n, message) => { if (!crashed && /TITLE: Submit your tool/.test(message) && /filled/.test(message)) { crashed = true; await chrome.crash() } } })
  const t = harness({ mock, ai, chrome, dir })
  try {
    await t.orchestrator._tick()
    const task = t.db.prepare('SELECT state, last_error FROM automation_tasks').get()
    assert.ok(crashed, 'the browser was killed mid-form')
    assert.equal(task.state, 'done', task.last_error)
    assert.ok(chrome.launches >= 2, 'relaunched')
    assert.ok(t.db.prepare(`SELECT 1 FROM activity_logs WHERE event = 'browser_recovered'`).get())
    assert.equal(mock.state.submissions.length, 1)
  } finally { t.orchestrator.shutdown(); await chrome.close(); mock.close() }
})

test('Google asks for a password (profile not signed in): one clear needs-you item, never a typed password', { skip, timeout: 60_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'docstar-it-'))
  const mock = await startMockPlatform({ signedIn: false })
  const chrome = testChrome(dir)
  const t = harness({ mock, ai: scriptedAi(), chrome, dir })
  try {
    await t.orchestrator._tick()
    assert.equal(t.status.get(t.id).status, 'needs_you')
    const ny = JSON.parse(t.status.get(t.id).needs_you_reason)
    assert.match(ny.what, /not signed in/)
    assert.match(ny.todo, /Sign in to Google/)
    assert.equal(t.views.needsYou().length, 1)
  } finally { t.orchestrator.shutdown(); await chrome.close(); mock.close() }
})
