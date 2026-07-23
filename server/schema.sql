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
--
-- Pricing is per BUSINESS, not per seat: businesses_limit is the quantity
-- the firm has paid for, seats_limit is a generous anti-abuse ceiling only.
-- `plan` is retained for reporting but no longer selects a price tier —
-- every business bills at the same flat rate regardless of tax type,
-- deliberately, so the price can never depend on something the customer
-- declares about themselves.
CREATE TABLE IF NOT EXISTS account (
  id                  INTEGER PRIMARY KEY,
  firm_name           TEXT,                                 -- shown in the portal + on invoices
  -- Short uppercase code prefixed onto every one of this firm's business
  -- names in Manager ("TALLO-0001 Acme"). Two purposes:
  --   1. Names cannot collide across firms, so no firm ever learns that
  --      another firm already uses a client name.
  --   2. The server administrator can see at a glance, in Manager's own
  --      business list, which firm owns which books.
  -- IMMUTABLE once set: it is baked into every manager_business_name, so
  -- changing it would orphan every business this firm owns.
  firm_code           TEXT UNIQUE,
  plan                TEXT    NOT NULL DEFAULT 'starter',   -- starter|pro|firm
  -- pending = signed up but not yet paid. NOTHING is provisioned in Manager
  -- until this leaves 'pending' (pay-first, no trial).
  status              TEXT    NOT NULL DEFAULT 'active',    -- pending|active|grace|suspended|cancelled
  seats_limit         INTEGER NOT NULL DEFAULT 1,
  businesses_limit    INTEGER NOT NULL DEFAULT 1,
  subscription_id     TEXT,                                 -- Xendit subscription id
  current_period_end  TEXT,                                 -- ISO8601, set by webhook
  grace_until         TEXT,                                 -- ISO8601, nullable
  created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- owner  — the paying admin. Manages the firm; the only role that may
--          amend a filing that has already been frozen.
-- staff  — bookkeeper. Sees only businesses granted in user_business;
--          prepares, files and freezes, but cannot amend or administer.
-- client — the business owner. READ-ONLY, and scoped to the single
--          business granted in user_business. Costs no seat.
CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY,
  account_id        INTEGER NOT NULL REFERENCES account(id),
  email             TEXT    NOT NULL,
  role              TEXT    NOT NULL DEFAULT 'staff',        -- owner|staff|client
  -- Access to ALL clients. A firm principal — the owner, and any partner
  -- the owner designates — works in every client's books, so rather than a
  -- per-client grant they carry this flag and the provisioner keeps them
  -- granted to every business, existing and future. Regular staff leave it
  -- 0 and are assigned per-client on the access grid. The owner is always 1.
  all_businesses    INTEGER NOT NULL DEFAULT 0,              -- 0|1
  manager_user_ref  TEXT,                                   -- Manager restricted-user id, set by provisioner
  -- The Manager password the provisioner generated, held ONLY until the
  -- firm owner has collected it. Plaintext, deliberately and briefly: it
  -- has to survive from the provisioner run until the owner next opens
  -- the portal, and there is nowhere else to put it.
  --
  -- It is never emailed. It is cleared the moment it is shown, and it
  -- stops being surfaced 24h after it was set whether collected or not
  -- (see auth-core.isInitialPasswordVisible). Losing it is cheap — the
  -- owner presses Reset password and gets a new one.
  initial_password    TEXT,
  initial_password_at INTEGER,                              -- epoch ms
  -- Offboarding is REMOVE, never DELETE — same reasoning as archiving a
  -- business. audit_log and report_snapshot.filed_by record people by
  -- email, so deleting the row would leave those entries pointing at
  -- someone the system can no longer explain. A removed user keeps their
  -- history, frees their seat, and loses every book in Books.
  status            TEXT    NOT NULL DEFAULT 'active',      -- active|removed
  removed_at        TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, email)
);

-- One client's books. Manager Server has no GUIDs — it keys businesses by
-- NAME (the user-form's Businesses multi-select uses base64(name) as the
-- option value, and api4/businesses returns only `name`). So the join key
-- to Manager is the name itself.
--
-- Two columns, deliberately:
--   name                  — what the firm calls this client, shown in the portal.
--   manager_business_name — the key on the Manager server, globally unique.
-- They're normally identical. They diverge only when two different firms
-- register the same client name: the second gets an account-scoped suffix
-- so the Manager-side key stays unique WITHOUT telling firm B that firm A
-- exists (a plain "already taken" error would be a cross-tenant oracle).
-- Removal is ARCHIVE, never DELETE: filed snapshots must survive a client
-- leaving, and the audit trail has to stay intact. Archiving frees a slot
-- against businesses_limit immediately, but does NOT refund the period —
-- that's enforced by business_billing_period below.
--
-- There is deliberately no tax_type column. We serve VAT-registered
-- businesses only, so it would have exactly one value everywhere — and
-- the price is flat regardless, so nothing would ever read it. Add it
-- when a second kind of client actually exists.
CREATE TABLE IF NOT EXISTS businesses (
  id                    INTEGER PRIMARY KEY,
  account_id            INTEGER NOT NULL REFERENCES account(id),
  manager_business_name TEXT    NOT NULL,
  name                  TEXT    NOT NULL,
  status                TEXT    NOT NULL DEFAULT 'active',   -- active|archived
  archived_at           TEXT,
  -- Set by the provisioner once the books actually exist in Manager. NULL
  -- means "registered here, not created there yet" — access grants refuse
  -- to run against it, which is what stops a typo'd or pending business
  -- from collecting grants that can never apply.
  manager_created_at    TEXT,
  created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(manager_business_name)
);
CREATE INDEX IF NOT EXISTS idx_businesses_active
  ON businesses(account_id) WHERE status = 'active';

-- One row per business per billing month it was active for ANY part of.
-- This is what makes billing a high-water mark rather than a snapshot of
-- whoever happens to be active on invoice day: a business added on the 3rd
-- and archived on the 20th still has its row, so it is still billed.
-- Without this table, archiving before the invoice would be free — and
-- since VAT returns are filed quarterly while billing is monthly, a firm
-- could add every client, file the whole quarter, and remove them before
-- being charged.
--
-- period_key is 'YYYY-MM' (see auth-core.billingPeriodKey). A row is written
-- when a business is added and by the monthly roll for every active business.
CREATE TABLE IF NOT EXISTS business_billing_period (
  id           INTEGER PRIMARY KEY,
  business_id  INTEGER NOT NULL REFERENCES businesses(id),
  period_key   TEXT    NOT NULL,                             -- 'YYYY-MM'
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(business_id, period_key)
);
CREATE INDEX IF NOT EXISTS idx_billing_period ON business_billing_period(period_key);

-- A discount attached to an account. This is how an account pays nothing —
-- NOT by exempting it from the rules. An account with a 100% voucher is
-- still counted, still invoiced, and still audited; its invoice simply
-- totals zero, for a stated reason.
--
-- The alternative (a billing_exempt flag, a fake 'free' plan, a
-- never-expiring subscription) puts a branch in the billing path and makes
-- comped accounts invisible to it. A voucher keeps one code path for
-- everybody, and the same mechanism covers every case we might want:
-- founders' own firms (100%, no end), a launch promo (20%, three months),
-- a partner rate (50%, ongoing).
--
-- percent_off, not an amount: the price per business can change without
-- silently turning a full comp into a partial one.
-- Periods are 'YYYY-MM' and compare lexicographically; ends_period NULL
-- means it never expires.
CREATE TABLE IF NOT EXISTS account_discount (
  id            INTEGER PRIMARY KEY,
  account_id    INTEGER NOT NULL REFERENCES account(id),
  code          TEXT,                                      -- voucher code, or NULL for a direct grant
  percent_off   INTEGER NOT NULL,                          -- 1..100
  reason        TEXT    NOT NULL,                          -- why it was granted — this is the audit
  starts_period TEXT    NOT NULL,                          -- 'YYYY-MM', inclusive
  ends_period   TEXT,                                      -- 'YYYY-MM', inclusive; NULL = no end
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_account_discount ON account_discount(account_id);

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

-- ── Priority 2: frozen filing snapshots (save/freeze reports) ────
-- When a preparer marks a filing "Filed", the report figures + manual
-- inputs are frozen here as of that moment, so later edits to that period's
-- books no longer rewrite the filed return. Append-only: an amendment adds
-- a new row with version+1 and marks prior rows 'superseded', preserving
-- the full amendment history. A filing is identified by
-- (business_id, workflow_key, period_key); `headline` holds just the one
-- figure the variance alert compares against live books.
CREATE TABLE IF NOT EXISTS report_snapshot (
  id            INTEGER PRIMARY KEY,
  business_id   INTEGER NOT NULL REFERENCES businesses(id),
  workflow_key  TEXT    NOT NULL,                     -- vat|expanded|compensation|individual|nonindividual
  period_key    TEXT    NOT NULL,                     -- e.g. quarterly:2026:1 / monthly:2026:3 / annual:2026
  form          TEXT,                                 -- 2550Q, 1601EQ, ...
  version       INTEGER NOT NULL DEFAULT 1,           -- 1 = original filed, 2+ = amendments
  status        TEXT    NOT NULL DEFAULT 'filed',     -- filed|superseded
  headline      TEXT,                                 -- JSON { label, amount } — variance source
  payload       TEXT    NOT NULL,                     -- JSON { figures, manualInputs } snapshot
  filed_by      TEXT,                                 -- user email
  filed_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_report_snapshot_lookup
  ON report_snapshot(business_id, workflow_key, period_key);
CREATE INDEX IF NOT EXISTS idx_report_snapshot_business
  ON report_snapshot(business_id);
