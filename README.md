# DocStar Backlink Agent

Finds directories and listing sites for https://docstar.io/, qualifies them, drafts listings, signs up, submits through
its own Chrome, verifies emails, finds the published listing and checks the backlink. It runs the whole workflow
itself and asks a person only for what needs one: CAPTCHAs, payment, phone or ID checks, facts missing from the DocStar
profile, and the one-time Google sign-in in its Chrome profile.

Dashboard: http://localhost:4000 on the agent's machine, mirrored to the hosted dashboard (https://docstar-agent.embarko.app).

## Install and run

Needs Node.js 22+ and Google Chrome.

```bash
npm install
cp .env.example .env        # fill in the three VIASOCKET_ values (and the optional ones below)
npm start                   # http://localhost:4000
```

The first start generates `DOCSTAR_MASTER_KEY` and `DOCSTAR_ADMIN_PASSWORD` into `.env`. Back up `.env`: without the
master key, stored credentials cannot be decrypted.

First-time setup in the dashboard, **Integrations**:

1. **Connect Gmail** as support@docstar.io. Only the search and read-message permissions are requested.
2. **Open Chrome**, then **Sign in to Google** and sign in as support@docstar.io yourself (once). The session stays in
   `data/chrome-profile`; the agent never sees or types the Google password.

### Upgrading an existing installation

On the first start with this version the database moves to schema v2. A copy of the database is saved first
(`data/docstar.db.before-v2-<time>.bak`), then a one-time repair runs and writes `data/repair-report-<date>.md`
(before → after for every platform and task). To see what it will do without changing anything:

```bash
node scripts/repair.mjs --db data/docstar.db --dry-run --out repair-preview.md
```

`docs/repair-report-dry-run.md` is that preview for the data as of 17 Nov 2026.

## How a platform moves (the state machine)

One module (`src/engine/stateMachine.js`) lists every status, its label and the allowed transitions; one writer
(`src/engine/status.js`) changes a status, in one transaction with the account, submission and backlink sub-statuses it
implies, a timeline row and an activity event. Anything the table does not allow is refused and logged
(`illegal_transition`), so contradictory combinations cannot be written.

```
discovered ─▶ qualifying ─┬─▶ qualified ─▶ listing_drafted ─▶ approval_required ─▶ approved
                          ├─▶ rejected            (auto-approval or approvals off: listing_drafted ─▶ approved)
                          ├─▶ paid_skipped
                          └─▶ evaluation_failed ─▶ (retried after a day)

approved ─▶ registering ─▶ registered ─▶ email_verification_pending ─▶ ready_for_submission ─▶ submitting
             │  (no e-mail check: registering ─▶ ready_for_submission; no account needed: ─▶ submitting)
             └─▶ registration_failed                                    submitting ─▶ submission_failed

submitting ─▶ submitted ─▶ pending_platform_review ─▶ published ─┬─▶ live_backlink ─▶ backlink_lost
                                   └─▶ rejected_by_platform       └─▶ no_backlink

from any open state:  ─▶ needs_you (with what happened / what to do / where)  ─▶ back where it stopped (Resume)
                      ─▶ blocked, rejected, paid_skipped (a person's decision)
from any state, by a person: Mark as done manually / Set listing URL ─▶ submitted or published, then checked
```

- **Needs you** is one list: platforms with status `needs_you`. The overview count, the Needs-you page and the
  platform filter all come from `src/platforms/views.js`; every overview card is the length of the list it opens.
- **Failed** is platforms in `evaluation_failed`, `registration_failed` or `submission_failed`, each with the error, the
  step, the time and the attempts, and Retry / Mark needs you / Reject.
- **Stale-state sweeper** (every 5 min): a running task whose worker heartbeat stopped goes back to the queue; a
  platform in an in-progress state with no task for longer than `stale_minutes` is queued again, or failed with a
  reason when its retries are used up.
- **Reconciliation** (hourly and on start): recomputes each status from tasks, account, submission and backlink checks,
  fixes mismatches and logs each as `status_reconciled` (before → after). A fix means a bug wrote a wrong status, so
  each run with fixes raises an alert. Start-up also runs the invariant check and logs any problem.

## Tasks, retries and limits

- Every deferred task has a `run_after`. The worker sleeps until the earliest one and wakes on enqueue, resume,
  approval and task end; it never idles while work is runnable or scheduled.
- Failures retry with exponential back-off (1, 2, 4, 8 … minutes, at most an hour) up to `max_attempts` (5; per type
  with `max_attempts_<type>`). Then the platform goes to `needs_you` with the full error history (evaluations go to
  `evaluation_failed` and are retried a day later).
- Conditions only a person can change are never retried on a timer: a task waits for the event (listing approved,
  profile approved).
- Sign-ups: a rolling window of `max_signups_per_hour` (3) and `max_signups_per_day` (10); the next slot's exact time
  is the task's `run_after`. Evaluations, discovery and backlink checks don't count and run in parallel
  (`parallel_tasks`); browser work runs one task at a time (one Chrome profile). Two tasks never run for one platform.
- Each task has an idempotency key (type + platform) and saves a verified checkpoint (step, URL, fields filled) after
  every successful step; a retry or a resume continues from there.

## Browser automation

- Google sign-in in a popup or a redirect is followed (account chooser, consent) and the original page re-attached.
  If Google asks for a password, the task asks a person for the one-time sign-in.
- No fixed waits: load states, URL and close events, and a request tracker attached before each click that waits for
  the click's own requests to finish.
- Before each submit: a search for an existing DocStar listing (never listed twice), each field's value and validity,
  and values the page reset put back (e.g. DevHunt's pricing after the logo upload). After: success or failure from the
  network responses, messages, URL, confirmation text and a screenshot. At most two submits per form without a
  confirmation.
- A navigation mid-read is read again; a closed browser is relaunched with the DocStar profile and the task continues
  at its checkpoint. What worked is saved per platform (playbook) and given to the next attempt.
- CAPTCHAs and bot checks are never solved or bypassed: they go to a person with the page open in the agent's Chrome.
- Read-only visits (qualification, backlink checks) use an isolated, cookie-less browser context.

## Email, published listings and backlinks

- After an email sign-up, Gmail (search and read only) is searched for mail from the platform's domain, inbox and
  spam, every 25 s for the platform's window (15 min). The link must be on the platform's domain (or a known
  email-tracking redirect that resolves there). It is opened in the agent's Chrome, then checked. "Resend" is pressed
  once halfway through. Each email used is recorded (masked sender, subject, time); links and bodies are never logged.
- After submitting, the platform is searched for the listing hourly for a day, then daily; unfinished platforms are
  searched daily too (work done by hand is picked up). Approved / live / rejected / received emails move the status.
- Backlink checks record every docstar.io link with its rel, anchor text, HTTP status and indexability. HTTP 200 alone
  is not live. Live links are re-checked every 24 h, pending ones every 12 h. A link that disappears or loses dofollow
  → `backlink_lost` and an alert.

## Hosted dashboard and sync

- The agent pushes its records to the hosted copy as an ordered, idempotent change log: a full copy once, then
  deltas built on the base the hosted copy acknowledged; any mismatch (missed push, redeploy) triggers a full resend.
  Failed pushes retry with back-off (5 s up to 5 min), each failure is logged, and an alert fires when the hosted
  copy is more than `offline_alert_minutes` behind.
- A change made on the hosted dashboard is a command with an id and a state: **queued** ("Pending — will apply when
  the agent is online"), **sent**, then **applied** or **failed: reason** once the agent ran it. The dashboard says
  "Applied" only then. Identical commands within a minute are one; the agent runs each command id once; buttons stay
  disabled while their command is in flight. The **Pending changes** panel lists them all.
- Every page shows "Agent online/offline" and "Last synced". Views refresh row by row on events and never overwrite
  a field being edited.
- The hosted copy is not a second writer of the agent's state: the agent applies every change (see the summary of
  why full two-way sync was not built).

Sync settings: the agent's `.env` has `HOSTED_URL` and `HOSTED_SYNC_TOKEN`; the hosted copy has the same token as
`SYNC_TOKEN`.

## Settings (dashboard → Settings)

| Setting | Default | Meaning |
|---|---|---|
| `max_signups_per_hour` / `max_signups_per_day` | 3 / 10 | rolling sign-up limits |
| `parallel_tasks` | 3 | evaluations / checks run in parallel |
| `max_attempts` | 5 | attempts per task before it needs a person |
| `stale_minutes` | 30 | when an in-progress platform without a task counts as stuck |
| `backlink_recheck_live_hours` / `backlink_recheck_pending_hours` | 24 / 12 | backlink re-check intervals |
| `nofollow_counts_as_live` | on | whether a nofollow link counts as a live backlink |
| `min_quality_score` | 55 | score ≥ this qualifies |
| `require_approval` | on | master switch: nothing is registered or submitted without an approval |
| `auto_approve` / `auto_approve_min_score` | off / 65 | approve automatically when safe (approved facts only, free, no unusual requirements) |
| `offline_alert_minutes` | 10 | alert when the agent / mirror is offline this long |
| `summary_frequency` | weekly | summary: daily, weekly (Mondays 09:00) or off |

## Alerts and notifications

Set in `.env` (agent) and in the hosted copy's environment:

```
ALERT_SLACK_WEBHOOK=https://hooks.slack.com/services/…   # Slack incoming webhook
ALERT_EMAIL_WEBHOOK=https://…                            # receives JSON {to, subject, text, link} and sends the email
ALERT_EMAIL_TO=support@docstar.io                        # default
PUBLIC_URL=https://docstar-agent.embarko.app             # where links in alerts point
```

Gmail stays read-only, so emails go out through a webhook, e.g. a viaSocket flow ("Webhook → Gmail: Send Email" from
another mailbox). Alerts: each new needs-you item (with a one-click Resume link: signed, single use, 48 h), the agent
offline, the mirror behind, a lost backlink, a rejection by a platform, reconciliation fixes, and the summary. Without a
channel, alerts appear in the activity log only (Health shows which channels are set).

## Running the worker in the cloud

The agent does not need the Mac: any always-on Linux server or VM with Node 22+ and Chrome can run it.

1. Install Chrome (`google-chrome-stable`) and Node 22, clone the repo, `npm ci`.
2. Copy `.env` from the Mac (it holds the master key that decrypts stored credentials) and add:
   ```
   CHROME_HEADLESS=1
   CHROME_PATH=/usr/bin/google-chrome
   CHROME_PROFILE_DIR=/srv/docstar/chrome-profile     # persistent disk
   DB_PATH=/srv/docstar/docstar.db                    # persistent disk
   HOSTED_URL=https://docstar-agent.embarko.app
   HOSTED_SYNC_TOKEN=…
   ```
3. Move the data once: stop the Mac agent, copy `data/docstar.db` and `data/chrome-profile/` to the server. Or sign
   in to Google once on the server: run it with `CHROME_HEADLESS=0` under a virtual display (`xvfb-run npm start`),
   open noVNC or VNC, press **Sign in to Google**, then switch back to headless.
4. Run it as a service (systemd: `Restart=always`, `WorkingDirectory` the repo, `EnvironmentFile` the `.env`).
   The dashboard listens on 127.0.0.1:4000; use the hosted dashboard, or an SSH tunnel.
5. Stop the Mac agent (or remove `HOSTED_URL` there): the hosted dashboard mirrors one agent at a time.

On a Mac the agent keeps the machine awake (caffeinate) while the automation runs. Alerts fire when the worker is
offline for longer than `offline_alert_minutes`.

## Layout

```
src/
  server.js                 entry point: wires everything, starts on 127.0.0.1:4000
  config/index.js           settings from .env; generates the master key and admin password
  db/schema.sql, migrations.js, index.js   schema v1, migrations (v2), backup before migrating
  db/repair.js, repairSteps.js             one-time repair and its report (scripts/repair.mjs)
  engine/stateMachine.js    statuses, labels, transitions, sub-status rules (pure)
  engine/status.js          the only writer of platform statuses
  engine/orchestrator.js    queue, scheduling, retries, outcomes, heartbeat
  engine/maintenance.js     sweeper, reconciliation, invariants
  engine/rateLimit.js       rolling sign-up windows
  platforms/                records, domains (eTLD+1), merge, views (one source for lists and counts)
  agent/                    discovery, qualification, listings, approvals, submit task, follow-up, backlinks,
                            listing finder, playbooks, manual completion, auto-approval
  browser/                  Chrome over CDP, OAuth, page guards, form audit and evidence
  integrations/             viaSocket, Gmail (read-only), email verifier, link helpers
  sync/mirror.js            delta mirror and tracked commands
  alerts/                   alerts, notifications, one-click links
  reports/summary.js        summary and health metrics
public/                     dashboard (plain HTML/CSS/JS)
tests/unit, tests/integration   offline tests; the browser suite drives a local mock platform in headless Chrome
```

## Tests

```bash
npm test     # unit + integration (the browser suite needs Google Chrome; it is skipped without it)
```

## Security

- Locally the server listens on 127.0.0.1 only and rejects other Host headers (DNS-rebinding guard).
- Admin sign-in: 5 attempts a minute, a 15-minute lockout after 10; HttpOnly, SameSite=Strict cookies (Secure when
  hosted); signed out after 30 minutes idle and after 12 hours at most. Revealing a password asks for the admin
  password again and is logged; the hosted copy never reveals passwords.
- Every write needs the `X-DocStar-CSRF` header and a same-origin request. Strict Content-Security-Policy.
- Platform passwords, the Gmail ids and verification links are sealed with AES-256-GCM and never mirrored. Logs mask
  emails, URL queries, tokens and one-click links.
- The agent honours each platform's automation policy and robots.txt, never solves CAPTCHAs, and keeps to the sign-up
  limits.
