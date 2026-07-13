# Txform.ph — Progress

Tracking doc referenced by [`docs/ECC-PLAYBOOK.md`](ECC-PLAYBOOK.md). Snapshot of
where the app stands against the 6-phase SaaS plan, kept current from source
changes rather than hand-waved.

_Last updated: 2026-07-13_

## Phase status

| Phase | Status | Notes |
|-------|--------|-------|
| **0 — Foundation hardening** | ✅ Largely done | Pull-based auto-deploy (`scripts/deploy.sh` via 2-min root cron), nginx web-root hardening, LF normalization. Hosting-license confirmed, Manager Server bought. |
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
