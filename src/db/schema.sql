-- DocStar backlink agent, schema v1. Applied once by src/db/index.js; later versions add migrations.
-- Secrets live only in *_enc columns, sealed with AES-256-GCM (src/security/crypto.js).

PRAGMA foreign_keys = ON;

CREATE TABLE platform_categories (
  id          INTEGER PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL
);

CREATE TABLE platforms (
  id                        INTEGER PRIMARY KEY,
  name                      TEXT NOT NULL,
  url                       TEXT NOT NULL,
  domain                    TEXT NOT NULL UNIQUE,              -- one record per site: the duplicate guard
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
  status                    TEXT NOT NULL DEFAULT 'discovered' CHECK (status IN (
                              'discovered','qualified','approval_required','registration_pending','registered',
                              'email_verification_pending','ready_for_submission','submitted','pending_approval',
                              'live_backlink','no_backlink','failed','paid_skipped','needs_you','rejected')),
  source                    TEXT NOT NULL CHECK (source IN ('seed','manual','discovered')),
  notes                     TEXT,
  created_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX platforms_status ON platforms(status);
CREATE INDEX platforms_category ON platforms(category_id);

CREATE TABLE platform_scores (
  id                  INTEGER PRIMARY KEY,
  platform_id         INTEGER NOT NULL REFERENCES platforms(id) ON DELETE CASCADE,
  relevance           INTEGER CHECK (relevance BETWEEN 0 AND 100),
  domain_reputation   INTEGER CHECK (domain_reputation BETWEEN 0 AND 100),
  audience_quality    INTEGER CHECK (audience_quality BETWEEN 0 AND 100),
  credibility         INTEGER CHECK (credibility BETWEEN 0 AND 100),
  indexability        INTEGER CHECK (indexability BETWEEN 0 AND 100),
  referral_potential  INTEGER CHECK (referral_potential BETWEEN 0 AND 100),
  backlink_quality    INTEGER CHECK (backlink_quality BETWEEN 0 AND 100),
  overall             INTEGER CHECK (overall BETWEEN 0 AND 100),
  seo_value           TEXT CHECK (seo_value IN ('high','medium','low','unknown')),
  method              TEXT NOT NULL,                             -- 'ai:<model>' or 'operator'
  evidence            TEXT,                                      -- the pages the score was based on
  scored_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX platform_scores_latest ON platform_scores(platform_id, scored_at DESC);

CREATE TABLE company_information (
  id           INTEGER PRIMARY KEY,
  field        TEXT NOT NULL UNIQUE,                             -- 'name', 'website', 'short_description', …
  value        TEXT NOT NULL,
  approved     INTEGER NOT NULL DEFAULT 0 CHECK (approved IN (0,1)),
  approved_at  TEXT,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE accounts (
  id            INTEGER PRIMARY KEY,
  platform_id   INTEGER NOT NULL UNIQUE REFERENCES platforms(id) ON DELETE RESTRICT,  -- one account per platform
  email         TEXT NOT NULL,
  login_method  TEXT NOT NULL CHECK (login_method IN ('google','email')),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','email_verification_pending','active','failed','disabled')),
  profile_url   TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE credentials (
  id          INTEGER PRIMARY KEY,
  account_id  INTEGER NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  secret_enc  TEXT NOT NULL,                                     -- never plaintext
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revealed_at TEXT
);

CREATE TABLE submissions (
  id                   INTEGER PRIMARY KEY,
  platform_id          INTEGER NOT NULL UNIQUE REFERENCES platforms(id) ON DELETE RESTRICT,  -- one listing per platform
  account_id           INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  listing_title        TEXT,
  listing_description  TEXT,
  anchor_text          TEXT,
  target_url           TEXT NOT NULL DEFAULT 'https://docstar.io/',
  submission_url       TEXT,
  listing_url          TEXT,
  status               TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approval_required','approved','submitted','pending_approval','published','rejected','failed')),
  approved_at          TEXT,
  submitted_at         TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE backlinks (
  id               INTEGER PRIMARY KEY,
  submission_id    INTEGER NOT NULL UNIQUE REFERENCES submissions(id) ON DELETE CASCADE,
  page_url         TEXT NOT NULL,
  target_url       TEXT,
  anchor_text      TEXT,
  rel              TEXT,                                         -- raw rel attribute
  is_dofollow      INTEGER CHECK (is_dofollow IN (0,1)),
  is_sponsored     INTEGER CHECK (is_sponsored IN (0,1)),
  is_ugc           INTEGER CHECK (is_ugc IN (0,1)),
  http_status      INTEGER,
  indexable        INTEGER CHECK (indexable IN (0,1)),
  status           TEXT NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified','live','missing','pending','error')),
  first_seen_at    TEXT,                                         -- set only by an independent check, never by a submit
  last_checked_at  TEXT,
  next_check_at    TEXT
);
CREATE INDEX backlinks_next_check ON backlinks(next_check_at);

CREATE TABLE backlink_history (
  id            INTEGER PRIMARY KEY,
  backlink_id   INTEGER NOT NULL REFERENCES backlinks(id) ON DELETE CASCADE,
  checked_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  http_status   INTEGER,
  link_present  INTEGER CHECK (link_present IN (0,1)),
  rel           TEXT,
  anchor_text   TEXT,
  indexable     INTEGER CHECK (indexable IN (0,1)),
  note          TEXT
);
CREATE INDEX backlink_history_by_link ON backlink_history(backlink_id, checked_at DESC);

CREATE TABLE email_verifications (
  id             INTEGER PRIMARY KEY,
  platform_id    INTEGER NOT NULL REFERENCES platforms(id) ON DELETE CASCADE,
  account_id     INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  sender_domain  TEXT NOT NULL,
  link_host      TEXT,                                           -- the validated host of the link, in clear
  link_enc       TEXT,                                           -- the link itself, sealed; no email body is ever stored
  status         TEXT NOT NULL DEFAULT 'searching' CHECK (status IN ('searching','found','opened','verified','not_found','rejected')),
  searched_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  verified_at    TEXT
);

CREATE TABLE automation_tasks (
  id           INTEGER PRIMARY KEY,
  platform_id  INTEGER REFERENCES platforms(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,                                    -- 'qualify', 'register', 'submit', 'verify_backlink', …
  state        TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','paused','needs_you','done','failed','cancelled')),
  step         TEXT,                                             -- last completed step, for resume
  checkpoint   TEXT,                                             -- JSON, never secrets
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,                                             -- masked
  locked_by    TEXT,                                             -- worker id holding the lease
  lease_until  TEXT,
  run_after    TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- At most one unfinished task of a type per platform: two workers can never work the same platform.
CREATE UNIQUE INDEX automation_tasks_one_active ON automation_tasks(platform_id, type)
  WHERE state IN ('queued','running','paused','needs_you');
-- A completed task of a type is never repeated for the same platform.
CREATE UNIQUE INDEX automation_tasks_one_done ON automation_tasks(platform_id, type) WHERE state = 'done';
CREATE INDEX automation_tasks_pick ON automation_tasks(state, run_after);

CREATE TABLE activity_logs (
  id           INTEGER PRIMARY KEY,
  ts           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  level        TEXT NOT NULL CHECK (level IN ('info','success','warn','error')),
  event        TEXT NOT NULL,
  message      TEXT NOT NULL,                                    -- masked before insert
  platform_id  INTEGER REFERENCES platforms(id) ON DELETE SET NULL,
  task_id      INTEGER REFERENCES automation_tasks(id) ON DELETE SET NULL,
  meta         TEXT                                              -- masked JSON
);
CREATE INDEX activity_logs_ts ON activity_logs(ts DESC);

CREATE TABLE human_approvals (
  id           INTEGER PRIMARY KEY,
  platform_id  INTEGER NOT NULL REFERENCES platforms(id) ON DELETE CASCADE,
  task_id      INTEGER REFERENCES automation_tasks(id) ON DELETE SET NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('platform','registration','publication','captcha','policy')),
  payload      TEXT NOT NULL,                                    -- JSON shown to the operator
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','skipped')),
  note         TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_at   TEXT
);
CREATE UNIQUE INDEX human_approvals_one_pending ON human_approvals(platform_id, kind) WHERE status = 'pending';

CREATE TABLE integration_settings (
  key         TEXT PRIMARY KEY,                                  -- 'gmail'
  value_enc   TEXT NOT NULL,                                     -- sealed JSON: auth_id, script_id
  meta        TEXT,                                              -- non-secret JSON: connected label, status
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE system_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT INTO platform_categories (slug, name) VALUES
  ('saas_directory', 'SaaS directory'),
  ('ai_tools', 'AI tool directory'),
  ('dev_tools', 'Developer tool directory'),
  ('api_docs', 'API documentation directory'),
  ('docs_software', 'Documentation software directory'),
  ('startup', 'Startup directory'),
  ('product_listing', 'Product listing site'),
  ('reviews', 'Software review platform'),
  ('company_directory', 'Technology company directory'),
  ('business_profile', 'Business profile site');

INSERT INTO system_settings (key, value) VALUES
  ('automation_state', 'stopped'),
  ('max_signups_per_hour', '3'),
  ('backlink_check_hours', '12');
