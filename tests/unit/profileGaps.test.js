import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setup, platformAt } from '../helpers/setup.js'
import { createProfileGaps, slugOf } from '../../src/agent/profileGaps.js'

const failWith = (t, id, error) => t.db.prepare(`INSERT INTO automation_tasks (platform_id, type, state, attempts, last_error) VALUES (?, 'submit', 'failed', 3, ?)`).run(id, error)

test('profile gaps: grouped by fact, only platforms still stuck, answer saves an approved fact and retries', () => {
  const t = setup()
  const gaps = createProfileGaps({ db: t.db, orchestrator: t.orchestrator, activity: t.activity })
  const a = platformAt(t, 'submission_failed', { name: 'Alpha', account: 'active' })
  const b = platformAt(t, 'registration_failed', { name: 'Beta' })
  const c = platformAt(t, 'submitted', { name: 'Gamma', submission: 'submitted' }) // moved on: not waiting
  failWith(t, a, 'Blocked at the same point 3 times in a row: missing profile field: GitHub repository URL')
  failWith(t, b, 'Blocked at the same point 3 times in a row: missing profile field: GitHub Repository URL')
  failWith(t, c, 'Blocked at the same point 3 times in a row: missing profile field: Last Name')

  const list = gaps.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].key, 'github_repository_url')
  assert.deepEqual(list[0].platforms.map(p => p.name).sort(), ['Alpha', 'Beta'])

  const r = gaps.answer({ github_repository_url: 'https://github.com/example/docstar' })
  assert.deepEqual(r.saved, ['github_repository_url'])
  assert.equal(r.retried, 2)
  const row = t.db.prepare(`SELECT value, approved FROM company_information WHERE field = 'extra_github_repository_url'`).get()
  assert.equal(row.approved, 1)
  assert.equal(row.value, 'https://github.com/example/docstar')
  assert.deepEqual(gaps.list(), []) // both platforms left the failed states
})

test('profile gaps: needs-you items are read from the reason, blank answers are ignored', () => {
  const t = setup()
  const gaps = createProfileGaps({ db: t.db, orchestrator: t.orchestrator, activity: t.activity })
  const id = platformAt(t, 'needs_you', { name: 'Delta' })
  t.db.prepare('UPDATE platforms SET needs_you_reason = ? WHERE id = ?').run(JSON.stringify({ what: 'missing profile field: Feature 2 (distinct feature)' }), id)
  assert.equal(gaps.list()[0].key, 'feature_2')
  assert.deepEqual(gaps.answer({ feature_2: '   ' }).saved, [])
  assert.equal(slugOf('Your Name or Pseudonym'), 'your_name_or_pseudonym')
})
