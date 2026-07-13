<!-- Generated: 2026-07-13 | Files scanned: server/schema.sql | Token estimate: ~600 -->
# Data

SQLite `txform.db` (WAL, `foreign_keys=ON`) at `/var/www/taxify/server/txform.db`.
Written by both the Node service and `entitlement.php` (both run as `www-data`).
Schema: `server/schema.sql`. Manager Server remains the books DB — not here.

## Tables & relationships
```
account (the firm = unit of billing)
  id · plan(starter|pro|firm) · status(active|grace|suspended|cancelled)
  seats_limit · businesses_limit · pm_subscription_id · current_period_end · grace_until
     │ 1
     ├───< users        (account_id FK) · email · role(owner|staff) · manager_user_ref · UNIQUE(account_id,email)
     └───< businesses   (account_id FK) · manager_business_guid UNIQUE · name

user_business  (user_id FK, business_id FK)  PK(user_id,business_id)
   → SOURCE OF TRUTH for "which staff may open which client"

provision_job  work queue → reconciles Manager to match user_business
   type(create|grant|revoke|disable) · status(pending|running|done|failed)
   attempts · screenshot_path · last_error   [idx: pending]

audit_log  APPEND-ONLY (RA 10173 / DPA evidence) — never UPDATE/DELETE
   account_id · actor(email|'system') · action · target · at

-- Phase 1.3 auth (hash-only storage) --
login_token  email · token_hash UNIQUE · expires_at · consumed_at(single-use) · request_ip   [idx: email]
session      user_id FK · session_hash UNIQUE · expires_at · last_seen   [idx: user_id]
```

## Notes
- Tokens & session secrets stored **hashed only**; raw secret lives only in the httpOnly cookie / emailed link.
- `login_token.expires_at/consumed_at` are epoch-ms integers (match `auth-core` numeric compares).
- Billing status lives on `account` only; users + businesses inherit it (expiry ladder gates the whole firm at once).
- Migrations: none yet — single `schema.sql` with `CREATE TABLE IF NOT EXISTS`.
