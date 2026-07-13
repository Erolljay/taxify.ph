# Txform.ph — Progress

Tracking doc referenced by [`docs/ECC-PLAYBOOK.md`](ECC-PLAYBOOK.md). Snapshot of
where the app stands against the 6-phase SaaS plan, kept current from source
changes rather than hand-waved.

_Last updated: 2026-07-13_

## Phase status

| Phase | Status | Notes |
|-------|--------|-------|
| **0 — Foundation hardening** | ✅ Largely done | Pull-based auto-deploy (`scripts/deploy.sh` via 2-min root cron), nginx web-root hardening, LF normalization. Hosting-license confirmed, Manager Server bought. **Backups live (2026-07-13):** AWS Backup EC2 snapshots + S3 Manager.io data backups, both 2 AM Manila, 7/56/400-day retention. Still open: UFW, fail2ban, UptimeRobot, `save-tax-rates.php` security pass. |
| **1 — Tenancy / entitlement / provisioning** | 🟡 Substantially built | `server/auth-*.js`, `smtp-mailer.js`, `entitlement.php`, `provisioner.js` + Playwright driver, `schema.sql`, systemd units. **95 passing tests.** **Email sender LIVE** — `txform-auth` service running, real magic-link email delivered via Google Workspace. **Magic-link now lands on the portal** — `verifyLink` 302-redirects a browser to `txform.ph/account` (cookie attached) instead of downloading `verify.json`; portal + `/api/*` share the apex origin. Open: live Playwright selectors. |
| **2 — Website rebuild & SEO** | 🟡 Started | `website/index.html` is real static HTML (no longer the old JS bundle); multi-page/SEO build still pending. |
| **3 — Payments (PayMongo)** | 🔴 Not started | No PayMongo/webhook code yet. |
| **4 — ToS / Data Privacy (RA 10173)** | 🔴 Not started | No terms/privacy pages. |
| **5 — Beta / launch** | 🔴 Not started | — |

The BIR forms engine (26 form pages + report generators) is mature and fully wired.

## Current tooling notes

- **Admin / install tool:** `installer.html` ("Super Admin") — installs the extension
  pointing at the live `extension.txform.ph/taxify.html`, plus a shared tax-rates admin tab.
- **App shell:** `taxify.html` → `taxify-app.js` + `step-engine.js` + `workflows.js` (the
  workflow engine that replaced the old monolithic setup screen).

## Changelog

### 2026-07-13 — Magic-link sign-in lands on the portal (Phase 1)
Wired the emailed link so clicking it lands the firm owner on the owner portal instead of
downloading `verify.json`:
- **`verifyLink` redirect** — a browser (`Accept: text/html`) is now 302-redirected: on success to
  `TXFORM_PORTAL_URL` (`https://txform.ph/account`) with the `txfsid` cookie riding the redirect; on a
  bad/expired/used link to `…/account?error=link_invalid|link_expired|link_used`. API clients
  (`Accept: application/json` or none) keep the exact JSON contract. The thin `send()` glue gained a
  `Location`-header branch. TDD: +8 tests (**95 total, green**).
- **Same-origin portal** — chose apex option (a): `account.html`/`account.js` served at
  `https://txform.ph/account` via new `nginx-portal-snippet.conf`, so the portal shares the origin with
  the `/api/*` proxy already on the apex (its cookie'd `/api/auth/me` + `/api/tenancy/*` calls resolve).
  `account.js` reads `?error=` and shows a friendly sign-in warning. `TXFORM_PORTAL_URL` added to the
  systemd unit (defaults to `<base>/account`).
- **`/security-review`** — clean: no user input reaches the `Location` header or the DOM (redirect target
  is trusted env + fixed literal codes; `?error=` is compared, never rendered).
- **Server steps (one-time):** `sudo systemctl daemon-reload && sudo systemctl restart txform-auth`;
  add `include …/nginx-portal-snippet.conf;` to the apex 443 block, then `sudo nginx -t && sudo systemctl
  restart nginx`. Full recipe in [`instruction.md`](instruction.md).

### 2026-07-13 — Security review passed + tracking/artifact synced
`/security-review` on the auth + mailer path returned **no HIGH/MEDIUM findings** (CRLF
header-injection guard, default TLS verification, no secret logging, CSPRNG magic-link token).
Docs shipped via PRs #15 (feature) and #16 (runbook); this entry + the checkbox in
[`to-do.md`](to-do.md) close the review gate. The visual SaaS-plan artifact was updated to show
Phase 0 email ✅ and Phase 1 "Auth LIVE".

### 2026-07-13 — Magic-link email sender LIVE on the server (Phase 1)
Brought the `txform-auth` service up on `txform-server` for the first time and confirmed a real
sign-in email delivered end-to-end:
- **Node 24 installed system-wide** (NodeSource → `/usr/bin/node`); the box only had nvm-Node in
  `/home/ubuntu`, which the `www-data` service can't reach (`ProtectHome=true`) — hence a fresh
  `203/EXEC` "node not found" until the system install.
- **systemd unit installed** (`/etc/systemd/system/txform-auth.service`), `enable --now` → `active`.
- **DB permissions:** `chgrp www-data` + `chmod 775` on `/var/www/taxify/server` so the `www-data`
  service (and `entitlement.php`, same user) can create/write `txform.db` there; `root` stays owner
  so the git-pull deploy is unaffected.
- **`/etc/txform/auth.env`** holds the Gmail SMTP creds (auth as `ejtallo@txform.ph`, App Password).
- Seeded a test user, POSTed `/api/auth/request-link`, no `[mailer]` error → **email received.**

Then closed out the click-through path: confirmed `From: hello@txform.ph` (Gmail send-as alias
already verified), and wired nginx → service using the repo's canonical `nginx-auth-snippet.conf`
(includes into the apex `txform.ph` 443 block; scopes `/api/auth/` + `/api/tenancy/`; rate-limits
`request-link` via a `limit_req_zone authlink` in `/etc/nginx/conf.d/txform-ratelimit.conf`).
Verified `/api/auth/verify` → 400 and `request-link` x8 → `200×6, 503×2` (throttle live). **Needed a
full `systemctl restart nginx`, not `reload`.** Full first-time recipe now in
[`instruction.md`](instruction.md) → "Auth service — first-time bring-up".

### 2026-07-13 — Magic-link email sender wired (Phase 1)
`hello@txform.ph` mailbox exists + SMTP creds ready, so the sender is now built and wired
(chose the zero-dependency path to keep the git-pull deploy install-free):

- **New:** [`server/smtp-mailer.js`](../server/smtp-mailer.js) — zero-dep SMTP client (Node
  `net`/`tls` only). Implicit TLS (465) or STARTTLS (587); AUTH LOGIN; RFC 5322 message
  builder with base64/RFC-2047 encoding for non-ASCII; **CR/LF header-injection guard**.
- **Wired:** `deps.sendEmail` in [`server/auth-service.js`](../server/auth-service.js) now
  uses it when `SMTP_HOST` is set, else falls back to logging the link (dev/CI safe).
- **Tests:** +12 in `test/smtp-mailer.test.js` (pure builders + `session()` against an
  in-process mock SMTP server, incl. auth-fail, bad-recipient, STARTTLS, injection). **87 total, green.**
- **Systemd:** `txform-auth.service` now loads `EnvironmentFile=-/etc/txform/auth.env` (optional).
- **Remaining (server, one-time):** create `/etc/txform/auth.env` + restart — see
  [`instruction.md`](instruction.md#email--magic-link-sign-in).

### 2026-07-13 — Backups configured (Phase 0)
Two independent backup systems on the `txform-server` EC2 (`i-09bbc637afe847bde`, ap-southeast-1), both firing at 2 AM Manila (18:00 UTC — the server clock is UTC):

- **AWS Backup** (full-instance snapshots) — vault `txform-backup-vault`, plan `txform-daily-weekly-monthly` with Daily/Weekly/Monthly rules, retention **7 / 56 / 400** days, assigned to all EC2.
- **S3 data backup** (portable Manager.io data) — `/home/ubuntu/backup-managerio.sh` (cron `0 18 * * *`) tars `/home/ubuntu/Documents/Manager.io` and uploads to own bucket `txform-managerio-backups`; lifecycle retention `daily/`→7, `weekly/`→56, `monthly/`→400. Server authenticates via scoped IAM role `txform-server-backup-role` (`s3:PutObject`-only). First manual run verified (Manila-time log, correct `daily/` folder).

Operations runbook: [`docs/instruction.md`](instruction.md). Full build notes in memory `aws-backup-infra`.

### 2026-07-13 — Dead-code cleanup
Removed 8 orphaned/superseded files (~4,138 lines), tests green throughout (75/75):

| Files | Superseded by |
|-------|---------------|
| `vat.js`, `vat-report.js`, `sls-slp.js` | `2550q.html` + `sls-report.js` |
| `atc-codes.js` | `tax-codes.js` |
| `installer-fix.diff` | stale already-applied patch |
| `setup.js` | `taxify-app.js` + workflow engine + `tax-codes.js` + `custom-fields.js` |
| `tallo-onboarding.html` | install slice → `installer.html`; rest retired |

**Known feature gap** from retiring `tallo-onboarding.html`: the firm-level client
dashboard, new-client onboarding wizard, and cross-business master supplier/customer
sync now have no home in the app. Treat as net-new SaaS-roadmap work (Phase 1 territory)
if wanted again — do not resurrect the old page (it installed a stale `github.io` URL).
