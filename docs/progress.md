# Txform.ph — Progress

Tracking doc referenced by [`docs/ECC-PLAYBOOK.md`](ECC-PLAYBOOK.md). Snapshot of
where the app stands against the 6-phase SaaS plan, kept current from source
changes rather than hand-waved.

_Last updated: 2026-07-14_

## Phase status

| Phase | Status | Notes |
|-------|--------|-------|
| **0 — Foundation hardening** | ✅ Largely done | Pull-based auto-deploy (`scripts/deploy.sh` via 2-min root cron), nginx web-root hardening, LF normalization. Hosting-license confirmed, Manager Server bought. **Backups live (2026-07-13):** AWS Backup EC2 snapshots + S3 Manager.io data backups, both 2 AM Manila, 7/56/400-day retention. **`save-tax-rates.php` hardened & LIVE (2026-07-14, PR #23):** shared-secret token + body cap + backup pruning on top of nginx basic-auth; token file created on the server. Still open: UFW, fail2ban, UptimeRobot, e2e BIR verification. |
| **1 — Tenancy / entitlement / provisioning** | 🟡 Substantially built | `server/auth-*.js`, `smtp-mailer.js`, `entitlement.php`, `provisioner.js` + Playwright driver, `schema.sql`, systemd units. **95 passing tests.** **Email sender LIVE** — `txform-auth` service running, real magic-link email delivered via Google Workspace. **Magic-link now lands on the portal** — `verifyLink` 302-redirects a browser to `txform.ph/account` (cookie attached) instead of downloading `verify.json`; portal + `/api/*` share the apex origin. Open: live Playwright selectors. |
| **2 — Website rebuild & SEO** | ✅ Live | **Deployed 2026-07-14 (PR #21).** Full static multi-page site under `website/`: home + features/security/about/contact/faq/terms/privacy, shared `assets/css/site.css` + `assets/js/site.js`, real favicons, `robots.txt` + `sitemap.xml` + per-page meta & JSON-LD. **Positioned as a live product, not a waitlist** — CTAs are "Get started" → contact onboarding and "Sign in" → the owner portal at **`/account`**. Legal pages carry the firm's real details (TalloCPA, Iloilo City, DPO Erol Jay Tallo). Old JS bundle preserved as `index.legacy.html`. Open only: counsel review of legal pages, optional font self-hosting. |
| **3 — Payments (PayMongo)** | 🔴 Not started | No PayMongo/webhook code yet. |
| **4 — ToS / Data Privacy (RA 10173)** | 🟡 Draft pages | `website/terms.html` + `website/privacy.html` drafted (RA 10173-aligned, NPC/DPO sections) with bracketed firm placeholders; needs real firm details + counsel review before launch. |
| **5 — Beta / launch** | 🔴 Not started | — |

The BIR forms engine (26 form pages + report generators) is mature and fully wired. A
correctness audit of the report calculations is underway (see the 2026-07-14 changelog entry) —
rates, the graduated-tax engine and VAT 2550Q are verified; two income-tax bugs were fixed.

## Current tooling notes

- **Admin / install tool:** `installer.html` ("Super Admin") — installs the extension
  pointing at the live `extension.txform.ph/taxify.html`, plus a shared tax-rates admin tab.
- **App shell:** `taxify.html` → `taxify-app.js` + `step-engine.js` + `workflows.js` (the
  workflow engine that replaced the old monolithic setup screen).

## Changelog

### 2026-07-14 — BIR report correctness audit + two income-tax fixes (Phase 0)
Static/logic audit of the report generators against BIR rules (part of the "verify every BIR report"
Phase 0 item). **Cleared as correct:** `tax-rates-data.json` (all rates + effectivity windows), the
graduated-tax engine (`computeGraduatedTax` — bracket math spot-checked against the BIR table), and
**VAT 2550Q** end-to-end (`lineAmounts` VAT back-out, output/input categorization by tax code, and
the item 37→60→61 netting all faithful to the form). **Two bugs found and fixed** (both rule-confirmed
with the CPA):

- **Individual OSD double-deducted Cost of Sales** ([1701-report.js](../1701-report.js),
  [1701q-report.js](../1701q-report.js)) — net income was `(sales − COGS) − 40%×sales` instead of
  `sales − 40%×sales`. For individuals, OSD is 40% of *gross sales/receipts* with COGS not separately
  deductible (RR 16-2008 §3); the bug **understated** taxable income (and tax) by the full COGS. Fixed
  so OSD net = 60% of gross sales; COGS now shows ₱0 on the return under OSD (matching eBIRForms), with
  real COGS still on the P&L tab. Itemized path unchanged.
- **MCIT started one year too early** ([pnl-helpers.js](../pnl-helpers.js) `isMcitApplicable`, surfaced
  in [1702rt-report.js](../1702rt-report.js) + [1702q-report.js](../1702q-report.js)) — used
  `taxYear − incYear >= 3`. Per RR 9-98, MCIT begins the **4th taxable year following** commencement
  (its worked example: commenced 1998 → MCIT 2002 = year + 4). Changed to `>= 4`; the exempt-window
  note now reads "+ 4". The bug **overstated** tax in the transition year when MCIT exceeded regular tax.

Also **added a "Tax Due" column** to the Tax-Rates admin income-tax panel
([tax-rates-admin.js](../tax-rates-admin.js)) — shows the BIR-style "₱X + Y% of excess over ₱Z" per
bracket (same cumulative math the engine uses), so a preparer can check the brackets against the
official table instead of seeing only the rate.

**Not yet audited:** 1601C, 0619E, 1601EQ, 1702Q OSD base, SLS/SLP, SAWT/QAP, alphalist, 2307, SSS.
**Gap:** the report generators still have no automated tests (see [`to-do.md`](to-do.md)).

### 2026-07-14 — `save-tax-rates.php` security pass — LIVE (Phase 0)
**Merged as PR #23 and deployed via the cron pull; token file created on `txform-server`.**
Hardened the highest-risk existing endpoint, which previously trusted anything that reached it and
leaned entirely on the nginx basic-auth block. Three additions, no new dependencies (stays plain PHP):
- **Shared-secret second gate** — requires an `X-Txform-Token` header matched (constant-time
  `hash_equals`) against `/etc/txform/tax-rates.token` (env `TXFORM_TAXRATES_TOKEN` fallback).
  **Fail-closed:** no token file → `500`, never an open write. So a dropped/mis-scoped nginx auth
  block alone can no longer expose the write. The admin tool ([`tax-rates-admin.js`](../tax-rates-admin.js))
  prompts for the token once per browser and caches it in localStorage; it never ships in the JS.
- **256 KB body cap** — rejects oversized POSTs before parsing (Content-Length + hard read limit).
- **Backup pruning** — `tax-rates-backups/` now trimmed to the newest 50 (was unbounded).

Left the per-value content validation alone by design: blast radius is only "report display looks
off," caught immediately, and one backup copy undoes it. Server step done: `/etc/txform/tax-rates.token`
created (`www-data`, mode 640) per [`DEPLOY-TAX-RATES-SAVE.md`](../DEPLOY-TAX-RATES-SAVE.md) step 3;
the token is pasted into the browser once on the first "Save to Server".

### 2026-07-14 — Full-product website LIVE (Phase 2 deployed)
Merged as PR #21 and confirmed live on `https://txform.ph` via the cron pull: all pages return 200
(the old 564 KB JS bundle is gone), the legal pages render the firm's real details, the `/account`
owner portal is reachable, and `/api/auth/verify` returns 400 (service reached). Phase 2 is done;
remaining items are non-code (counsel review of the legal pages, NPC DPO-registration check) plus
optional font self-hosting.

### 2026-07-14 — Website pivoted from waitlist to full product (Phase 2)
Dropped the "early access" positioning; the site now presents Txform as a live product:
- **Early-access removed:** deleted the homepage email-capture section and reverted the
  `/api/early-access` backend (handler, `early_access` table, tests, nginx route). Also removed the
  fabricated testimonials block (dishonest on a live site).
- **CTAs are real:** primary **"Get started"** → `/contact.html` (manual onboarding, since
  self-serve billing is Phase 3), secondary **"Sign in"** → the owner portal at **`/account`**.
- **Sign-in uses the real portal:** the throwaway `portal.html` was deleted in favour of the
  existing `account.html` + `account.js` (sign-in view **and** firm dashboard). These stay at the
  repo root and are served at `txform.ph/account` via the Phase-1 `nginx-portal-snippet.conf`; the
  magic-link `verifyLink` redirect already lands there. Every marketing "Sign in" link → `/account`.
- **Legal details filled:** operator **TalloCPA**, **Iloilo City** (base + governing law), DPO
  **Erol Jay Tallo, CPA** — across terms/privacy/about; all footers moved Manila → Iloilo City.
- Merged `main` (Phase-1 magic-link portal work); suite green at **95 tests**.

### 2026-07-13 — Website rebuilt as static multi-page site (Phase 2)
Replaced the 564 KB self-unpacking JS bundle at `website/index.html` with a real, crawlable
static site. Design system extracted from the live render (navy `#0B2447` + green `#19A974`,
Plus Jakarta Sans / Inter / JetBrains Mono) and rebuilt as shared CSS.

- **New pages:** `index.html` (rebuilt — adds How-it-works, Security, Testimonials, FAQ to the
  existing feature/pricing sections), plus `features.html`, `security.html`, `about.html`,
  `contact.html`, `faq.html`, `terms.html`, `privacy.html`.
- **Foundation:** `assets/css/site.css` (tokens + components), `assets/js/site.js` (mobile nav,
  scroll-reveal, early-access capture with `mailto` fallback).
- **SEO:** per-page `<title>`/description/canonical/OG, `SoftwareApplication` + `FAQPage` JSON-LD,
  `robots.txt`, `sitemap.xml` — none of which the JS bundle could expose to crawlers.
- **Favicons:** generated real `favicon.ico` (16/32/48), `favicon.svg`, `apple-touch-icon.png`
  from the brand mark (replaces fragile data-URI that Safari ignored).
- **Safety:** old bundle kept as `index.legacy.html`. All 12 routes verified `200`, no broken
  internal links. **Not yet deployed** — awaits the open items above.

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
