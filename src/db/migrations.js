// Schema migrations, applied in order by src/db/index.js. v1 is schema.sql. Each later version is one function run
// inside a transaction with foreign keys off (SQLite needs a table rebuild to change a CHECK constraint).
import { STATUSES, REASONS } from '../engine/stateMachine.js'

const list = values => values.map(v => `'${v}'`).join(',')

/** Rebuild `table` with `createSql` (which creates `<table>__new`), copying the columns both have. */
function rebuild(db, table, createSql, select = {}) {
  db.exec(createSql)
  const oldCols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name)
  const newCols = db.prepare(`PRAGMA table_info(${table}__new)`).all().map(c => c.name)
  const cols = newCols.filter(c => oldCols.includes(c) || select[c])
  db.exec(`INSERT INTO ${table}__new (${cols.join(',')}) SELECT ${cols.map(c => select[c] ?? c).join(',')} FROM ${table}`)
  db.exec(`DROP TABLE ${table}`)
  db.exec(`ALTER TABLE ${table}__new RENAME TO ${table}`)
}

const hasColumn = (db, table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col)
const hasTable = (db, table) => Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table))

export const MIGRATIONS = {
  // v2: the explicit platform state machine, task retries and scheduling, sign-up records, sync bookkeeping.
  2(db) {
    const STATUS_MAP = `CASE status
      WHEN 'registration_pending' THEN 'registering'
      WHEN 'pending_approval' THEN 'pending_platform_review'
      WHEN 'failed' THEN CASE WHEN EXISTS (SELECT 1 FROM submissions s WHERE s.platform_id = platforms.id) THEN 'submission_failed' ELSE 'evaluation_failed' END
      WHEN 'needs_you' THEN 'needs_you'
      ELSE status END`
    rebuild(db, 'platforms', `CREATE TABLE platforms__new (
      id                        INTEGER PRIMARY KEY,
      name                      TEXT NOT NULL,
      url                       TEXT NOT NULL,
      domain                    TEXT NOT NULL UNIQUE,
      site_key                  TEXT,                                    -- registrable domain (eTLD+1) for duplicate checks
      category_id               INTEGER REFERENCES platform_categories(id) ON DELETE SET NULL,
      submission_url            TEXT,
      pricing                   TEXT NOT NULL DEFAULT 'unknown' CHECK (pricing IN ('free','freemium','paid','unknown')),
      pricing_notes             TEXT,
      registration_requirements TEXT,
      submission_requirements   TEXT,
      backlink_availability     TEXT NOT NULL DEFAULT 'unknown' CHECK (backlink_availability IN ('yes','no','unknown')),
      automation_policy         TEXT NOT NULL DEFAULT 'unknown' CHECK (automation_policy IN ('allowed','prohibited','unclear','unknown')),
      domain_reputation         INTEGER CHECK (domain_reputation BETWEEN 0 AND 100),
      reputation_source         TEXT,
      status                    TEXT NOT NULL DEFAULT 'discovered' CHECK (status IN (${list(STATUSES)})),
      resume_status             TEXT CHECK (resume_status IS NULL OR resume_status IN (${list(STATUSES)})),
      status_reason             TEXT CHECK (status_reason IS NULL OR status_reason IN (${list(REASONS)})),
      needs_you_reason          TEXT,                                    -- JSON {what, todo, where}
      status_changed_at         TEXT,
      source                    TEXT NOT NULL,                           -- seed | manual | import | discovery:<query>
      notes                     TEXT,
      version                   INTEGER NOT NULL DEFAULT 1,              -- bumped on every write, for sync
      next_listing_search_at    TEXT,
      listing_searches          INTEGER NOT NULL DEFAULT 0,
      created_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`, { status: STATUS_MAP, status_changed_at: 'updated_at', resume_status: `CASE WHEN status = 'needs_you' THEN 'approved' END` })
    db.exec(`CREATE INDEX platforms_status ON platforms(status);
      CREATE INDEX platforms_category ON platforms(category_id);
      CREATE INDEX platforms_updated ON platforms(updated_at);
      CREATE INDEX platforms_site_key ON platforms(site_key);`)

    rebuild(db, 'accounts', `CREATE TABLE accounts__new (
      id                  INTEGER PRIMARY KEY,
      platform_id         INTEGER NOT NULL UNIQUE REFERENCES platforms(id) ON DELETE RESTRICT,
      email               TEXT NOT NULL,
      login_method        TEXT NOT NULL CHECK (login_method IN ('google','email','github')),
      status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','email_verification_pending','active','failed','disabled')),
      profile_url         TEXT,
      signup_completed_at TEXT,                                          -- set only when sign-up actually finished
      signup_inferred     INTEGER NOT NULL DEFAULT 0 CHECK (signup_inferred IN (0,1)), -- 1: set by the repair from indirect evidence
      created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`, { signup_completed_at: `CASE WHEN status = 'active' THEN updated_at END` })

    rebuild(db, 'submissions', `CREATE TABLE submissions__new (
      id                   INTEGER PRIMARY KEY,
      platform_id          INTEGER NOT NULL UNIQUE REFERENCES platforms(id) ON DELETE RESTRICT,
      account_id           INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
      listing_title        TEXT,
      listing_description  TEXT,
      anchor_text          TEXT,
      target_url           TEXT NOT NULL DEFAULT 'https://docstar.io/',
      submission_url       TEXT,
      listing_url          TEXT,
      status               TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approval_required','approved','submitted','pending_approval','published','rejected','failed','cancelled')),
      rejection_reason     TEXT,
      manual               INTEGER NOT NULL DEFAULT 0 CHECK (manual IN (0,1)), -- 1: recorded by a person
      notes                TEXT,
      auto_approved        INTEGER NOT NULL DEFAULT 0 CHECK (auto_approved IN (0,1)),
      approved_at          TEXT,
      submitted_at         TEXT,
      published_at         TEXT,
      created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`)

    rebuild(db, 'automation_tasks', `CREATE TABLE automation_tasks__new (
      id              INTEGER PRIMARY KEY,
      platform_id     INTEGER REFERENCES platforms(id) ON DELETE CASCADE,
      type            TEXT NOT NULL,
      state           TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','waiting','paused','needs_you','done','failed','cancelled')),
      step            TEXT,
      checkpoint      TEXT,
      attempts        INTEGER NOT NULL DEFAULT 0,
      max_attempts    INTEGER,
      last_error      TEXT,
      error_history   TEXT,                                              -- JSON [{at, error, step}]
      wait_for        TEXT,                                              -- event that wakes a waiting task, e.g. approval:12
      locked_by       TEXT,
      lease_until     TEXT,
      heartbeat_at    TEXT,
      run_after       TEXT,
      idempotency_key TEXT,
      correlation_id  TEXT,
      started_at      TEXT,
      finished_at     TEXT,
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`, { idempotency_key: `type || ':' || COALESCE(platform_id, 'none')` })
    db.exec(`CREATE UNIQUE INDEX automation_tasks_one_active ON automation_tasks(platform_id, type) WHERE state IN ('queued','running','waiting','paused','needs_you');
      CREATE UNIQUE INDEX automation_tasks_one_done ON automation_tasks(platform_id, type) WHERE state = 'done';
      CREATE INDEX automation_tasks_pick ON automation_tasks(state, run_after);
      CREATE INDEX automation_tasks_platform ON automation_tasks(platform_id, state);
      CREATE INDEX automation_tasks_updated ON automation_tasks(updated_at);`)

    if (!hasColumn(db, 'activity_logs', 'correlation_id')) db.exec(`ALTER TABLE activity_logs ADD COLUMN correlation_id TEXT`)
    db.exec(`CREATE INDEX IF NOT EXISTS activity_logs_platform ON activity_logs(platform_id, id DESC);
      CREATE INDEX IF NOT EXISTS activity_logs_task ON activity_logs(task_id);
      CREATE INDEX IF NOT EXISTS activity_logs_event ON activity_logs(event);`)

    if (!hasColumn(db, 'backlinks', 'link_count')) db.exec(`ALTER TABLE backlinks ADD COLUMN link_count INTEGER`)
    if (!hasColumn(db, 'backlinks', 'links_json')) db.exec(`ALTER TABLE backlinks ADD COLUMN links_json TEXT`)
    if (!hasColumn(db, 'backlinks', 'manual_page')) db.exec(`ALTER TABLE backlinks ADD COLUMN manual_page INTEGER NOT NULL DEFAULT 0`)
    if (!hasColumn(db, 'backlink_history', 'links_json')) db.exec(`ALTER TABLE backlink_history ADD COLUMN links_json TEXT`)
    if (!hasColumn(db, 'platform_scores', 'reason')) db.exec(`ALTER TABLE platform_scores ADD COLUMN reason TEXT`)
    if (!hasColumn(db, 'platform_scores', 'model_overall')) db.exec(`ALTER TABLE platform_scores ADD COLUMN model_overall INTEGER`)

    db.exec(`
      -- Every status change, with who made it: the per-platform timeline and the audit trail.
      CREATE TABLE platform_transitions (
        id           INTEGER PRIMARY KEY,
        platform_id  INTEGER NOT NULL REFERENCES platforms(id) ON DELETE CASCADE,
        from_status  TEXT,
        to_status    TEXT NOT NULL,
        reason       TEXT,
        actor        TEXT NOT NULL,                 -- agent | operator | reconcile | sweeper | migration | platform
        task_id      INTEGER REFERENCES automation_tasks(id) ON DELETE SET NULL,
        meta         TEXT,
        at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX platform_transitions_by_platform ON platform_transitions(platform_id, at);
      CREATE INDEX platform_transitions_at ON platform_transitions(at);

      -- Emails the agent read for a platform: sender, subject, time and what they were used for. Never a body or link.
      CREATE TABLE emails_used (
        id           INTEGER PRIMARY KEY,
        platform_id  INTEGER REFERENCES platforms(id) ON DELETE CASCADE,
        message_id   TEXT,
        sender       TEXT,
        subject      TEXT,
        received_at  TEXT,
        purpose      TEXT NOT NULL,                 -- verification | approved | live | rejected | other
        at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE (platform_id, message_id)
      );

      -- What worked on a platform last time: sign-in method, fields, uploads, gotchas.
      CREATE TABLE platform_playbooks (
        platform_id  INTEGER PRIMARY KEY REFERENCES platforms(id) ON DELETE CASCADE,
        data         TEXT NOT NULL,                 -- JSON
        updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      -- Screenshots of key steps (files under data/screenshots), shown in the platform drawer.
      CREATE TABLE screenshots (
        id           INTEGER PRIMARY KEY,
        platform_id  INTEGER REFERENCES platforms(id) ON DELETE CASCADE,
        task_id      INTEGER REFERENCES automation_tasks(id) ON DELETE SET NULL,
        step         TEXT,
        file         TEXT NOT NULL,
        note         TEXT,
        at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX screenshots_platform ON screenshots(platform_id, at);

      -- Alerts sent (dedupe key + when), so a condition alerts once, not every minute.
      CREATE TABLE alerts_sent (
        key          TEXT PRIMARY KEY,
        channel      TEXT,
        message      TEXT,
        at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      -- One-click links (Resume from a notification) are single use.
      CREATE TABLE action_tokens_used (
        jti          TEXT PRIMARY KEY,
        at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `)

    // Hosted copy: the queue of changes made on the hosted dashboard, with their outcome.
    if (!hasTable(db, 'mirror_commands')) {
      db.exec(`CREATE TABLE mirror_commands (id INTEGER PRIMARY KEY, method TEXT NOT NULL, path TEXT NOT NULL, body TEXT,
        state TEXT NOT NULL DEFAULT 'queued', created_at TEXT NOT NULL, sent_at TEXT)`)
    }
    for (const [c, def] of [['dedupe_key', 'TEXT'], ['result', 'TEXT'], ['applied_at', 'TEXT'], ['label', 'TEXT'], ['http_status', 'INTEGER'], ['attempts', 'INTEGER NOT NULL DEFAULT 0']]) {
      if (!hasColumn(db, 'mirror_commands', c)) db.exec(`ALTER TABLE mirror_commands ADD COLUMN ${c} ${def}`)
    }
    db.exec(`UPDATE mirror_commands SET state = 'queued' WHERE state = 'pending';
      CREATE INDEX IF NOT EXISTS mirror_commands_state ON mirror_commands(state, id);
      CREATE INDEX IF NOT EXISTS mirror_commands_dedupe ON mirror_commands(dedupe_key, created_at);`)

    // Settings introduced with v2 (defaults; existing values are kept).
    const defaults = {
      stale_minutes: 30, max_attempts: 5, max_signups_per_day: 10, parallel_tasks: 3,
      backlink_recheck_live_hours: 24, backlink_recheck_pending_hours: 12, nofollow_counts_as_live: 1,
      auto_approve: 0, auto_approve_min_score: 65, offline_alert_minutes: 10, summary_frequency: 'weekly'
    }
    const ins = db.prepare(`INSERT OR IGNORE INTO system_settings (key, value) VALUES (?, ?)`)
    for (const [k, v] of Object.entries(defaults)) ins.run(k, String(v))
  }
}

export const LATEST = Math.max(1, ...Object.keys(MIGRATIONS).map(Number))
