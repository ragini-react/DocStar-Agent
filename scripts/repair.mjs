// One-time data repair, by hand. Prints the before/after report; --dry-run rolls everything back.
//   node scripts/repair.mjs [--db data/docstar.db] [--dry-run] [--out report.md]
import { writeFileSync } from 'node:fs'
import { openDb } from '../src/db/index.js'
import { createActivityLog } from '../src/logging/activity.js'
import { createStatus } from '../src/engine/status.js'
import { createOrchestrator } from '../src/engine/orchestrator.js'
import { createMaintenance } from '../src/engine/maintenance.js'
import { repairData } from '../src/db/repair.js'
import { repairSteps } from '../src/db/repairSteps.js'

const arg = (name, fallback = null) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback }
const dryRun = process.argv.includes('--dry-run')
const db = openDb(arg('--db', 'data/docstar.db'))
const activity = createActivityLog(db, { quiet: true })
const status = createStatus({ db, activity })
const orchestrator = createOrchestrator({ db, activity, chrome: null, status, browser: false })
for (const t of ['qualify', 'prepare', 'discover']) orchestrator.register(t, async () => {}, {})
orchestrator.register('submit', async () => {}, { browser: true })
const maintenance = createMaintenance({ db, activity, status, orchestrator })
const r = repairData({ db, status, activity, orchestrator, maintenance, extraSteps: repairSteps }, { dryRun })
const out = arg('--out')
if (out) writeFileSync(out, r.report)
console.log(r.report)
const left = maintenance.invariants()
console.log(left.length ? `\n${left.length} invariant problem(s) remain:\n${left.map(p => `- ${p.message}`).join('\n')}` : '\nAll invariants hold.')
orchestrator.shutdown()
db.close()
