# DocStar Backlink Agent

Finds relevant directories and listing sites for https://docstar.io/, registers and submits genuine listings with
the operator's approval, and verifies the backlinks. Runs on this Mac with a visible Chrome and a dashboard at
http://localhost:4000.

**Status: Phase 2 (local infrastructure).** No task types are enabled yet: the agent creates no accounts and
submits nothing until Phase 3 is approved.

## Install and run

Needs Node.js 22+ and Google Chrome.

```bash
npm install
cp .env.example .env        # fill in the three VIASOCKET_ values
npm start                   # http://localhost:4000
```

The first start generates `DOCSTAR_MASTER_KEY` and `DOCSTAR_ADMIN_PASSWORD` into `.env`. Sign in to the dashboard
with that password. Back up `.env`: without the master key, stored credentials cannot be decrypted.

First-time setup in the dashboard, **Integrations**:

1. **Connect Gmail** and sign in as support@docstar.io. Only the search and read-message permissions are requested.
2. **Open Chrome**, then **Sign in to Google** and sign in as support@docstar.io yourself. The session stays in
   `data/chrome-profile`; the agent never sees the Google password.

## Layout

```
src/
  server.js                 entry point: wires everything, starts on 127.0.0.1:4000
  config/index.js           settings from .env; generates the master key and admin password
  db/schema.sql, index.js   SQLite schema (15 tables) and helpers
  security/crypto.js        AES-256-GCM vault, password generator, constant-time compare
  security/mask.js          masks emails, tokens, ids, URL queries and numbers in every log and error
  logging/activity.js       activity feed: database + console + live stream to the dashboard
  integrations/viasocket.js viaSocket client (+ slug lookup fallback)
  integrations/gmail.js     Gmail connection, status, test, verification-link search
  integrations/verificationLinks.js   pure link extraction (unit-tested)
  browser/chrome.js         real Chrome over CDP: launch/attach, status, Google sign-in, bring to front
  engine/orchestrator.js    Start/Pause/Resume/Stop, task leases, crash recovery, duplicate guards
  platforms/service.js      platform records, filters, seed list, overview counts, CSV
  ai/actionSchema.js        browser-action JSON schema and its validator
  server/app.js             HTTP API: auth, CSRF, security headers, routes
public/                     dashboard (plain HTML/CSS/JS, no build step)
tests/unit/                 offline unit tests
tests/phase1-*.mjs          live integration tests (viaSocket AI, Gmail)
tests/screenshots.mjs       screenshots of every view
data/                       database, Chrome profile, logs (git-ignored)
```

## Tests

```bash
npm test                                             # 11 offline unit tests
npm run test:phase1                                  # live: viaSocket AI and Gmail (needs the test connection)
node --env-file=.env tests/screenshots.mjs           # dashboard screenshots into docs/screenshots
```

## Security

- The server listens on 127.0.0.1 only and rejects any other Host header (DNS-rebinding guard).
- One admin password; session cookie is HttpOnly + SameSite=Strict, 12 h; 5 sign-in attempts a minute.
- Every write needs the `X-DocStar-CSRF` header and a same-origin request. Strict Content-Security-Policy.
- Platform passwords, the Gmail auth_id and script_id, and verification links are sealed with AES-256-GCM.
  Revealing a password asks for the admin password again and is logged.
- Email bodies are never stored or logged; only a link that passes the domain checks is kept, encrypted.
- Gmail searches leave read/unread status unchanged (verified: a message stayed UNREAD after search and fetch).

## Deployment (later, Embarko)

Not yet. A hosted run needs a persistent disk for `data/`, the `.env` secrets in the host's secret store, and an
authenticated remote browser view for CAPTCHAs and Google sign-in: the local Chrome profile does not move to a server.
