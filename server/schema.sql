-- ============================================================
-- Txform.ph — subscriber database (SQLite)
--
-- The ONLY new state the SaaS introduces. Manager Server remains the
-- database of books; this holds who pays, who may open which client,
-- and the provisioner's work queue.
--
-- Apply:  sqlite3 /var/www/taxify/server/txform.db < server/schema.sql
-- Run in WAL mode so the PHP endpoints (writers) and the Node
-- provisioner (status writer) don't block each other on reads.
-- ============================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- The firm — the unit of billing. A solo bookkeeper is just 1 user/1 biz.
CREATE TABLE IF NOT EXISTS account (
  id                  INTEGER PRIMARY KEY,
  plan                TEXT    NOT NULL DEFAULT 'starter',   -- starter|pro|firm
  status              TEXT    NOT NULL DEFAULT 'active',    -- active|grace|suspended|cancelled
  seats_limit         INTEGER NOT NULL DEFAULT 1,
  businesses_limit    INTEGER NOT NULL DEFAULT 1,
  pm_subscription_id  TEXT,                                 -- PayMongo subscription id
  current_period_end  TEXT,                                 -- ISO8601, set by webhook
  grace_until         TEXT,                                 -- ISO8601, nullable
  created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY,
  account_id        INTEGER NOT NULL REFERENCES account(id),
  email             TEXT    NOT NULL,
  role              TEXT    NOT NULL DEFAULT 'staff',        -- owner|staff
  manager_user_ref  TEXT,                                   -- Manager restricted-user id, set by provisioner
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, email)
);

CREATE TABLE IF NOT EXISTS businesses (
  id                    INTEGER PRIMARY KEY,
  account_id            INTEGER NOT NULL REFERENCES account(id),
  manager_business_guid TEXT    NOT NULL,
  name                  TEXT    NOT NULL,
  created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(manager_business_guid)
);

-- Source of truth for access: which user may open which client.
CREATE TABLE IF NOT EXISTS user_business (
  user_id      INTEGER NOT NULL REFERENCES users(id),
  business_id  INTEGER NOT NULL REFERENCES businesses(id),
  PRIMARY KEY (user_id, business_id)
);

-- Provisioner work queue. Every access change enqueues a job here; the
-- Node worker drains it and reconciles Manager to match user_business.
CREATE TABLE IF NOT EXISTS provision_job (
  id              INTEGER PRIMARY KEY,
  type            TEXT    NOT NULL,                          -- create|grant|revoke|disable
  user_id         INTEGER REFERENCES users(id),
  business_id     INTEGER REFERENCES businesses(id),
  status          TEXT    NOT NULL DEFAULT 'pending',        -- pending|running|done|failed
  attempts        INTEGER NOT NULL DEFAULT 0,
  screenshot_path TEXT,
  last_error      TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_provision_job_pending
  ON provision_job(status) WHERE status = 'pending';

-- Append-only audit trail. Doubles as RA 10173 / DPA accountability
-- evidence for every permission change. Never UPDATE or DELETE rows here.
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY,
  account_id  INTEGER REFERENCES account(id),
  actor       TEXT,                                          -- email or 'system'
  action      TEXT    NOT NULL,
  target      TEXT,
  at          TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ── Phase 1.3: passwordless (magic-link) auth ────────────────────
-- Single-use, short-lived login tokens. We store only the HASH of the
-- token (see auth-core.hashToken) — a DB leak must not yield usable
-- login links. expires_at / consumed_at are epoch-ms integers to match
-- the numeric comparisons in auth-core.js.
CREATE TABLE IF NOT EXISTS login_token (
  id          INTEGER PRIMARY KEY,
  email       TEXT    NOT NULL,
  token_hash  TEXT    NOT NULL UNIQUE,
  expires_at  INTEGER NOT NULL,
  consumed_at INTEGER,
  request_ip  TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_token_email ON login_token(email);

-- Server-side sessions. Only the hash of the session secret is stored;
-- the raw secret lives only in the user's httpOnly cookie. Revocable by
-- deleting the row.
CREATE TABLE IF NOT EXISTS session (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  session_hash  TEXT    NOT NULL UNIQUE,
  expires_at    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  last_seen     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_session_user ON session(user_id);
