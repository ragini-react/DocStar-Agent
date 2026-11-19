// Rename the product everywhere in one go.
//
//   node scripts/rebrand.mjs --name "NewName" [--domain newname.com] [--email support@newname.com] [--dry-run]
//
// 1. Writes brand.config.json: the app reads the name, site and support email only from there (src/agent/brand.js),
//    so prompts, the dashboard, listing searches and backlink checks all follow after a restart.
// 2. Sweeps the remaining text that mentions the old name: README, docs, code comments, tests, seed data,
//    package.json / embarko.json descriptions.
//
// Internal identifiers are never touched, so nothing breaks and nobody is logged out: DOCSTAR_* env vars, the
// database file (docstar.db), cookie and CSRF header names, the viaSocket operator id, the action-link HMAC salt,
// the deploy app name (docstar-agent.embarko.app) and the localStorage key.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null }
const dry = process.argv.includes('--dry-run')
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const CFG = path.join(ROOT, 'brand.config.json')
const old = JSON.parse(readFileSync(CFG, 'utf8'))

const name = arg('--name')
if (!name) { console.error('Usage: node scripts/rebrand.mjs --name "NewName" [--domain new.com] [--email support@new.com] [--dry-run]'); process.exit(1) }
const domain = (arg('--domain') || old.domain).toLowerCase()
const email = arg('--email') || (domain !== old.domain ? old.supportEmail.replace(old.domain, domain) : old.supportEmail)
const next = { ...old, name, domain, supportEmail: email, logoLetter: name[0].toUpperCase() }

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '')
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// Internal identifiers to protect (case-insensitive), as they appear in the code today.
const KEEP = [/DOCSTAR_[A-Z_]+/g, /docstar[-_.](?:db|session|operator|action-links|activityListSeenAt|logo|deploy|practice-|agent\.embarko)[\w.-]*/gi,
  /docstar-agent(?:\.embarko\.app)?/gi, /x-docstar-csrf/gi, /docstar_profile/g, /DOCSTAR_TEST/g]

// The exact name first, then any other casing as the slug (the same slug brand.js uses for URLs and searches).
const swaps = [[new RegExp(esc(old.name), 'g'), name], [new RegExp(esc(slug(old.name)), 'gi'), slug(name)]]
if (domain !== old.domain) swaps.unshift([new RegExp(esc(old.domain), 'gi'), domain])
if (email !== old.supportEmail) swaps.unshift([new RegExp(esc(old.supportEmail), 'gi'), email])

function rewrite(text) {
  const held = []
  let t = text
  for (const re of KEEP) t = t.replace(re, m => `\u0000${held.push(m) - 1}\u0000`)
  for (const [re, to] of swaps) t = t.replace(re, to)
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => held[i])
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'data'])
const EXT = /\.(js|mjs|json|md|sql|html|css|sh|example)$|^\.env\.example$/
const SKIP_FILES = new Set(['package-lock.json', 'brand.config.json', 'scripts/rebrand.mjs'])
const files = []
;(function walk(dir) {
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f), rel = path.relative(ROOT, p)
    if (SKIP_DIRS.has(f)) continue
    if (statSync(p).isDirectory()) walk(p)
    else if (EXT.test(f) && !SKIP_FILES.has(rel)) files.push(p)
  }
})(ROOT)

let changed = 0
for (const f of files) {
  const before = readFileSync(f, 'utf8'), after = rewrite(before)
  if (after !== before) { changed++; console.log(`${dry ? 'would change' : 'changed'}  ${path.relative(ROOT, f)}`); if (!dry) writeFileSync(f, after) }
}
if (!dry) writeFileSync(CFG, JSON.stringify(next, null, 2) + '\n')
console.log(`\n${dry ? 'Dry run: ' : ''}brand.config.json → ${JSON.stringify(next)}; ${changed} other files ${dry ? 'would change' : 'updated'}.`)
console.log('Restart the agent. The approved company profile in the database is not changed: edit or re-draft it on the dashboard.')
