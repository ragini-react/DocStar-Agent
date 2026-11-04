// End-to-end test of the browser agent on the local practice site, with a throwaway database:
// real Chrome, real viaSocket AI, real validator. Run: node --env-file=.env tests/agent-practice.mjs
import { rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadConfig } from '../src/config/index.js'
import { openDb } from '../src/db/index.js'
import { createVault } from '../src/security/crypto.js'
import { createActivityLog } from '../src/logging/activity.js'
import { createChrome } from '../src/browser/chrome.js'
import { createOrchestrator } from '../src/engine/orchestrator.js'
import { createPlatforms } from '../src/platforms/service.js'
import { createAgent } from '../src/agent/index.js'
import { startPracticeSite } from './fixtures/practice-site.mjs'

const config = loadConfig()
const live = openDb(config.dbPath) // read the drafted DocStar profile only
const profile = live.prepare('SELECT field, value FROM company_information').all()
live.close()

const dir = mkdtempSync(path.join(tmpdir(), 'docstar-practice-'))
const cfg = { ...config, dbPath: path.join(dir, 'test.db') }
const db = openDb(cfg.dbPath)
const vault = createVault(cfg.masterKey)
const activity = createActivityLog(db)
const chrome = createChrome({ config: cfg, activity })
const orchestrator = createOrchestrator({ db, activity, chrome })
const platforms = createPlatforms({ db, activity })
const gmail = { findVerificationLink: async () => null }
const agent = createAgent({ db, vault, activity, chrome, gmail, orchestrator, platforms, config: cfg })
const site = await startPracticeSite()

for (const { field, value } of profile) agent.company.save(field, value)
agent.company.approveAll()
const { platform } = platforms.create({ name: 'Practice Directory', url: site.url, category: 'dev_tools' })
platforms.update(platform.id, { submission_url: `${site.url}/signup` })
db.prepare(`UPDATE platforms SET status = 'qualified' WHERE id = ?`).run(platform.id)
const listing = await agent.listings.draft(platform.id)
db.prepare(`UPDATE submissions SET status = 'approved' WHERE platform_id = ?`).run(platform.id)
console.log('listing drafted:', listing.title, '|', listing.short_description)

const { task } = orchestrator.enqueue(platform.id, 'submit')
db.prepare(`UPDATE system_settings SET value = 'running' WHERE key = 'automation_state'`).run()
const t = Date.now()
let row
for (let i = 0; i < 3; i++) {
  await orchestrator._tick()
  row = db.prepare('SELECT state, step, last_error FROM automation_tasks WHERE id = ?').get(task.id)
  if (row.state !== 'queued') break
}
console.log(`\nsubmit task: ${row.state} after ${((Date.now() - t) / 1000).toFixed(0)}s, last step "${row.step}" ${row.last_error ? '| ' + row.last_error : ''}`)
console.log('practice site saw: signups', JSON.stringify(site.state.signups), '| submissions', site.state.submissions.length)
const acct = db.prepare('SELECT a.login_method, a.status, (c.id IS NOT NULL) has_pw, substr(c.secret_enc,1,3) enc FROM accounts a LEFT JOIN credentials c ON c.account_id = a.id').get()
console.log('account:', JSON.stringify(acct))
const sub = db.prepare('SELECT status, listing_url FROM submissions').get()
console.log('submission:', JSON.stringify(sub))
const b = db.prepare('SELECT * FROM backlinks').get()
if (b) console.log('backlink check:', JSON.stringify(await agent.backlinks.check(b)))
console.log('platform status:', db.prepare('SELECT status FROM platforms WHERE id = ?').get(platform.id).status)
console.log('\nsteps:'); for (const e of db.prepare(`SELECT message FROM activity_logs WHERE event = 'agent_step' ORDER BY id`).all()) console.log('  ' + e.message.slice(0, 150))

// CAPTCHA hand-off
// A second practice platform needs its own domain: inserted directly, it points at the CAPTCHA page.
const cp = db.prepare(`INSERT INTO platforms (name, url, domain, submission_url, status, source) VALUES ('Captcha Site', ?, 'captcha.test', ?, 'qualified', 'manual') RETURNING id`)
  .get(`${site.url}/`, `${site.url}/captcha`)
agent.listings.save(cp.id, listing, 'approved')
const { task: ct } = orchestrator.enqueue(cp.id, 'submit')
await orchestrator._tick()
console.log('\ncaptcha task:', JSON.stringify(db.prepare('SELECT state, last_error FROM automation_tasks WHERE id = ?').get(ct.id)))

agent.shutdown(); orchestrator.shutdown()
for (const p of (await chrome.context()).pages()) if (p.url().includes(':4321')) await p.close()
await chrome.close(); site.server.close(); db.close(); rmSync(dir, { recursive: true, force: true })
process.exit(0)
