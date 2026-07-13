# Txform.ph — Progress

Tracking doc referenced by [`docs/ECC-PLAYBOOK.md`](ECC-PLAYBOOK.md). Snapshot of
where the app stands against the 6-phase SaaS plan, kept current from source
changes rather than hand-waved.

_Last updated: 2026-07-13_

## Phase status

| Phase | Status | Notes |
|-------|--------|-------|
| **0 — Foundation hardening** | ✅ Largely done | Pull-based auto-deploy (`scripts/deploy.sh` via 2-min root cron), nginx web-root hardening, LF normalization. Hosting-license confirmed, Manager Server bought. **Backups live (2026-07-13):** AWS Backup EC2 snapshots + S3 Manager.io data backups, both 2 AM Manila, 7/56/400-day retention. Still open: UFW, fail2ban, UptimeRobot, `save-tax-rates.php` security pass. |
| **1 — Tenancy / entitlement / provisioning** | 🟡 Substantially built | `server/auth-*.js`, `entitlement.php`, `provisioner.js` + Playwright driver, `schema.sql`, systemd units. **75 passing tests.** Open: live Playwright selectors, email sender. |
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
