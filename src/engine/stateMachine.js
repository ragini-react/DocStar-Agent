// The platform lifecycle: every status a platform can have, the transitions allowed between them, the
// human-readable label for each, and the sub-statuses (account, submission, backlink) each one implies.
// Pure: no I/O, so it is unit-tested exhaustively. src/engine/status.js is the only writer that uses it.
//
//   discovered → qualifying → qualified | rejected | paid_skipped | evaluation_failed
//   qualified → listing_drafted → approval_required → approved → registering → registered
//   → email_verification_pending → ready_for_submission → submitting → submitted → pending_platform_review
//   → published → live_backlink | no_backlink → backlink_lost
//
// Failure and blocked states: registration_failed, submission_failed, needs_you (with needs_you_reason), blocked,
// plus rejected_by_platform when a platform turns the listing down.

export const STATUSES = [
  'discovered', 'qualifying', 'qualified', 'rejected', 'paid_skipped', 'evaluation_failed',
  'listing_drafted', 'approval_required', 'approved',
  'registering', 'registered', 'email_verification_pending', 'ready_for_submission',
  'submitting', 'submitted', 'pending_platform_review', 'published',
  'live_backlink', 'no_backlink', 'backlink_lost', 'rejected_by_platform',
  'registration_failed', 'submission_failed', 'needs_you', 'blocked'
]

export const LABELS = {
  discovered: 'Discovered',
  qualifying: 'Evaluating',
  qualified: 'Qualified',
  rejected: 'Rejected',
  paid_skipped: 'Paid, skipped',
  evaluation_failed: 'Evaluation failed',
  listing_drafted: 'Listing drafted',
  approval_required: 'Waiting for your approval',
  approved: 'Approved',
  registering: 'Creating account',
  registered: 'Account created',
  email_verification_pending: 'Verifying email',
  ready_for_submission: 'Ready to submit',
  submitting: 'Submitting',
  submitted: 'Submitted',
  pending_platform_review: 'Awaiting platform review',
  published: 'Published',
  live_backlink: 'Live backlink',
  no_backlink: 'Published, no backlink',
  backlink_lost: 'Backlink lost',
  rejected_by_platform: 'Rejected by platform',
  registration_failed: 'Sign-up failed',
  submission_failed: 'Submission failed',
  needs_you: 'Needs you',
  blocked: 'Blocked'
}

// Labels for every other raw value the dashboard shows (task states, sub-statuses, reasons).
export const OTHER_LABELS = {
  // task states
  queued: 'Queued', running: 'Running', waiting: 'Waiting for an event', done: 'Done', failed: 'Failed', cancelled: 'Cancelled', paused: 'Paused',
  // account
  pending: 'Sign-up started', active: 'Active', disabled: 'Not used',
  // submission
  draft: 'Draft', pending_approval: 'Awaiting platform review',
  // backlink
  unverified: 'Not checked yet', live: 'Live', missing: 'Missing', error: 'Check failed',
  // reasons
  low_score: 'Score below threshold', duplicate: 'Duplicate', paid_only: 'Paid only', not_possible: 'Not possible',
  not_accepting: 'Does not accept submissions', not_legitimate: 'Not a legitimate platform', policy: 'Terms forbid automation',
  operator: 'By you', platform: 'By the platform', unknown: 'No reason recorded',
  // sign-up methods
  google: 'Google', email: 'Email', github: 'GitHub'
}

export const label = s => LABELS[s] ?? OTHER_LABELS[s] ?? String(s ?? '').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())

// Groups used by the sweeper, the views and the counts.
export const IN_PROGRESS = new Set(['qualifying', 'registering', 'registered', 'email_verification_pending', 'ready_for_submission', 'submitting'])
export const WAITING_FOR_TASK = new Set(['discovered', 'qualified', 'listing_drafted', 'approved'])
export const FAILED = new Set(['evaluation_failed', 'registration_failed', 'submission_failed'])
export const HUMAN = new Set(['needs_you', 'approval_required'])
export const DONE_NEGATIVE = new Set(['rejected', 'paid_skipped', 'rejected_by_platform'])
export const SUCCESS = new Set(['submitted', 'pending_platform_review', 'published', 'live_backlink', 'no_backlink', 'backlink_lost'])
export const PAUSED = new Set(['needs_you', 'blocked'])

// Product activity list: one group per URL, from its status. A URL whose product was added, published or whose backlink
// is live is processed: it is never qualified, drafted or submitted again (see orchestrator.enqueue).
// The groups follow the process in order, so reading them top to bottom is reading the workflow. Every status belongs to
// exactly one group; each group says what it means, what happens next and who acts.
export const ACTIVITY_GROUPS = ['new', 'your_approval', 'in_progress', 'needs_you', 'failed', 'product_added', 'product_published',
  'backlink_completed', 'backlink_lost', 'skipped']
export const ACTIVITY_LABELS = {
  new: 'New: being evaluated', your_approval: 'Waiting for your approval', in_progress: 'In progress', needs_you: 'Needs you',
  failed: 'Failed', product_added: 'Submitted, awaiting platform review', product_published: 'Published, backlink not counted yet',
  backlink_completed: 'Live backlink (done)', backlink_lost: 'Backlink lost', skipped: 'Skipped / rejected'
}
export const ACTIVITY_HELP = {
  new: { means: 'Found by discovery. The agent is checking whether the site is legitimate, relevant and free.', next: 'Qualified sites get a listing drafted; the rest are skipped.', who: 'Agent' },
  your_approval: { means: 'A listing has been drafted and is waiting for a person to approve it.', next: 'Approve or edit it in Needs you; the agent then signs up and submits.', who: 'You' },
  in_progress: { means: 'The agent is working on it: drafting, creating the account, verifying email or filling the submission form.', next: 'Moves to Submitted when the platform confirms, or to Needs you / Failed if it gets stuck.', who: 'Agent' },
  needs_you: { means: 'The agent stopped at something only a person can do (CAPTCHA, sign-in, payment, missing fact).', next: 'Do the step shown, then press Resume; the agent continues from where it stopped.', who: 'You' },
  failed: { means: 'A step failed after all retries.', next: 'Retry it, mark it as needs you, or reject it. Evaluation failures are retried automatically after a day.', who: 'You' },
  product_added: { means: 'Submitted successfully, but the platform has not published a public {{BRAND}} page yet (often a moderation queue).', next: 'The agent searches for the public listing on a schedule and moves it up when found.', who: 'Platform' },
  product_published: { means: 'A public {{BRAND}} page exists, but the link does not count yet (no link, nofollow, or the page is noindex).', next: 'Re-checked every 12 hours; becomes Live backlink when the link qualifies.', who: 'Agent re-checks' },
  backlink_completed: { means: 'Public listing with a verified link to {{SITE_HOST}}. Finished.', next: 'Re-checked every 24 hours; an alert is raised if the link disappears.', who: 'Nobody' },
  backlink_lost: { means: 'The link was live before and has since disappeared or changed.', next: 'Check the listing; contact the platform or fix the listing.', who: 'You' },
  skipped: { means: 'Not pursued: rejected at evaluation, paid only, a duplicate, or turned down by the platform.', next: 'Nothing. You can re-open one from the platform drawer if needed.', who: 'Nobody' }
}
export const PROCESSED = SUCCESS
/** Pure: the activity group of a platform row ({ status, resume_status }) or a status string. */
export function activityGroup(row) {
  const raw = typeof row === 'string' ? row : row.status
  if (PAUSED.has(raw)) return 'needs_you' // stopped for a person, whatever step it stopped at
  const s = typeof row === 'string' ? row : effectiveStatus(row)
  if (s === 'live_backlink') return 'backlink_completed'
  if (s === 'backlink_lost') return 'backlink_lost'
  if (s === 'published' || s === 'no_backlink') return 'product_published'
  if (s === 'submitted' || s === 'pending_platform_review') return 'product_added'
  if (s === 'discovered' || s === 'qualifying') return 'new'
  if (s === 'approval_required') return 'your_approval'
  if (FAILED.has(s)) return 'failed'
  if (DONE_NEGATIVE.has(s)) return 'skipped'
  return 'in_progress'
}

const T = {
  discovered: ['qualifying'],
  qualifying: ['qualified', 'rejected', 'paid_skipped', 'evaluation_failed', 'discovered'],
  evaluation_failed: ['qualifying', 'discovered'],
  qualified: ['listing_drafted', 'discovered'],
  listing_drafted: ['approval_required', 'approved', 'qualified'],
  approval_required: ['approved', 'listing_drafted'],
  approved: ['registering', 'submitting', 'ready_for_submission', 'approval_required'],
  registering: ['registered', 'email_verification_pending', 'ready_for_submission', 'registration_failed', 'submitting', 'approved'],
  registered: ['email_verification_pending', 'ready_for_submission', 'submitting'],
  email_verification_pending: ['registered', 'ready_for_submission', 'submitting', 'registration_failed'],
  ready_for_submission: ['submitting', 'registering'],
  submitting: ['submitted', 'pending_platform_review', 'published', 'submission_failed', 'ready_for_submission', 'approved',
    'registering', 'email_verification_pending'],
  submitted: ['pending_platform_review', 'published', 'rejected_by_platform', 'live_backlink', 'no_backlink'],
  pending_platform_review: ['published', 'rejected_by_platform', 'live_backlink', 'no_backlink'],
  published: ['live_backlink', 'no_backlink', 'rejected_by_platform'],
  live_backlink: ['backlink_lost', 'no_backlink'],
  no_backlink: ['live_backlink', 'published', 'backlink_lost'],
  backlink_lost: ['live_backlink', 'no_backlink'],
  rejected_by_platform: ['approved', 'published', 'live_backlink'],
  registration_failed: ['registering', 'approved', 'ready_for_submission'],
  submission_failed: ['submitting', 'ready_for_submission', 'approved', 'registering'],
  rejected: ['discovered', 'qualifying'],
  paid_skipped: ['discovered', 'qualifying'],
  needs_you: [],
  blocked: []
}
// From any state the agent is still working on, a task can stop for a person or be blocked, and the operator can
// reject or skip. needs_you and blocked go back to the state they were entered from (resume_status) or forward.
const OPEN = STATUSES.filter(s => !DONE_NEGATIVE.has(s) && !SUCCESS.has(s) && !PAUSED.has(s))
for (const s of OPEN) T[s].push('needs_you', 'blocked', 'rejected', 'paid_skipped')
for (const s of ['submitted', 'pending_platform_review', 'published', 'no_backlink', 'backlink_lost']) T[s].push('needs_you')
T.needs_you = [...OPEN.filter(s => s !== 'discovered'), 'rejected', 'paid_skipped', 'submitted', 'pending_platform_review', 'published', 'blocked']
T.blocked = [...OPEN.filter(s => s !== 'discovered'), 'rejected', 'paid_skipped', 'needs_you']
export const TRANSITIONS = Object.fromEntries(Object.entries(T).map(([k, v]) => [k, new Set(v)]))

// A person may record finished work by hand from any state ("Mark as done manually", "Set listing URL…").
export const MANUAL_TARGETS = new Set(['submitted', 'pending_platform_review', 'published', 'live_backlink', 'no_backlink'])
// The operator's own decisions, also allowed from any state.
export const OPERATOR_TARGETS = new Set(['rejected', 'paid_skipped', 'discovered'])

/**
 * @param {string} from
 * @param {string} to
 * @param {{ manual?: boolean, operator?: boolean }} [opts]
 */
export function canTransition(from, to, { manual = false, operator = false } = {}) {
  if (!STATUSES.includes(to)) return false
  if (!STATUSES.includes(from)) return false
  if (from === to) return true
  if (TRANSITIONS[from].has(to)) return true
  if (manual && MANUAL_TARGETS.has(to)) return true
  if (operator && OPERATOR_TARGETS.has(to)) return true
  return false
}

// Structured reasons a platform is rejected, skipped or failed.
export const REASONS = ['low_score', 'duplicate', 'paid_only', 'not_possible', 'not_accepting', 'not_legitimate', 'policy', 'evaluation_failed',
  'operator', 'platform', 'unknown']

/** The state a paused platform will continue in: needs_you / blocked carry it in resume_status. */
export const effectiveStatus = row => (PAUSED.has(row.status) && row.resume_status ? row.resume_status : row.status)

/**
 * What the sub-statuses must be for a main status. undefined = no rule (any value, or no row, is fine).
 * `hasSignup`: the account finished sign-up (signup_completed_at is set).
 */
export function expectedSubstatuses(status, { hasSignup = false, firstSeen = false } = {}) {
  const e = { submission: undefined, account: undefined, backlink: undefined }
  switch (status) {
    case 'discovered': case 'qualifying': case 'qualified': case 'evaluation_failed':
      e.submission = ['cancelled', null]; break
    case 'listing_drafted': e.submission = ['draft']; break
    case 'approval_required': e.submission = ['approval_required']; break
    case 'approved': e.submission = ['approved']; e.account = ['pending', 'active', 'failed', 'disabled', null]; break
    case 'registering': e.submission = ['approved']; e.account = ['pending', 'active', null]; break
    case 'registered': case 'ready_for_submission': case 'submitting':
      e.submission = ['approved']; e.account = ['active', 'pending', null]; break
    case 'email_verification_pending': e.submission = ['approved']; e.account = ['email_verification_pending']; break
    case 'registration_failed': e.submission = ['approved']; e.account = ['failed', 'pending', null]; break
    case 'submission_failed': e.submission = ['approved', 'failed']; break
    case 'submitted': e.submission = ['submitted']; break
    case 'pending_platform_review': e.submission = ['pending_approval']; break
    case 'published': e.submission = ['published']; e.backlink = ['unverified', 'pending', 'error', null]; break
    case 'live_backlink': e.submission = ['published']; e.backlink = ['live']; break
    case 'no_backlink': e.submission = ['published']; e.backlink = ['missing', 'error']; break
    case 'backlink_lost': e.submission = ['published']; e.backlink = ['missing', 'error']; break
    case 'rejected_by_platform': e.submission = ['rejected']; break
    case 'rejected': case 'paid_skipped': e.submission = ['cancelled', null]; e.account = ['disabled', 'active', 'failed', null]; break
  }
  // An account that finished sign-up is never "still signing up" again.
  if (hasSignup && e.account) e.account = e.account.filter(a => a !== 'pending')
  if (status === 'backlink_lost' && !firstSeen) e.backlink = ['__never_seen__'] // lost needs a link that was once seen
  return e
}

/**
 * Pure: the contradictions in one platform row joined with its account, submission and backlink.
 * Row fields: status, resume_status, account_status, signup_completed_at, submission_status, backlink_status, first_seen_at.
 */
export function findContradictions(row) {
  const problems = []
  if (!STATUSES.includes(row.status)) return [`unknown status "${row.status}"`]
  if (PAUSED.has(row.status) && !row.resume_status) problems.push(`${row.status} without the state to resume to`)
  if (row.status === 'needs_you' && !row.needs_you_reason) problems.push('needs_you without a reason')
  const status = effectiveStatus(row)
  const e = expectedSubstatuses(status, { hasSignup: Boolean(row.signup_completed_at), firstSeen: Boolean(row.first_seen_at) })
  const check = (kind, value) => {
    const allowed = e[kind]
    if (!allowed) return
    if (!allowed.includes(value ?? null)) problems.push(`${kind} "${value ?? 'none'}" contradicts ${status}`)
  }
  check('submission', row.submission_status)
  if (row.account_status != null) check('account', row.account_status)
  if (row.backlink_status != null || ['live_backlink', 'no_backlink', 'backlink_lost'].includes(status)) check('backlink', row.backlink_status)
  // A live link on a platform that is not live_backlink (or lost: the reverse) is the other way round.
  if (row.backlink_status === 'live' && status !== 'live_backlink') problems.push(`backlink is live but status is ${status}`)
  return problems
}

/**
 * Pure: the sub-status values to write for a main status, given the current ones. Returns only what must change.
 * The main status is the truth; sub-statuses follow it so contradictory combinations cannot be written.
 */
export function substatusFixes(status, current) {
  const e = expectedSubstatuses(status, { hasSignup: Boolean(current.signup_completed_at), firstSeen: Boolean(current.first_seen_at) })
  const fix = {}
  const pick = (kind, value, preferred) => {
    const allowed = e[kind]
    if (!allowed || allowed.includes(value ?? null)) return
    fix[kind] = preferred ?? allowed.find(a => a !== null && !a.startsWith('__'))
  }
  if (current.submission_status != null) {
    const preferred = { rejected: 'cancelled', paid_skipped: 'cancelled', discovered: 'cancelled', qualifying: 'cancelled', qualified: 'cancelled', evaluation_failed: 'cancelled' }[status]
    pick('submission', current.submission_status, preferred)
  }
  if (current.account_status != null) {
    const preferred = { rejected: 'disabled', paid_skipped: 'disabled', registration_failed: 'failed' }[status]
    pick('account', current.account_status, preferred ?? (current.signup_completed_at ? 'active' : undefined))
  }
  if (current.backlink_status != null) pick('backlink', current.backlink_status)
  return fix
}
