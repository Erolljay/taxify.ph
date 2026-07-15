# Txform.ph — To-Do

Open work, newest concerns first. Part of the ECC tracking triad
(`instruction.md / progress.md / to-do.md`, see
[`docs/ECC-PLAYBOOK.md`](ECC-PLAYBOOK.md)). Phase labels map to the 6-phase SaaS plan.

_Last updated: 2026-07-15_

## ⭐ Filing-workflow UX redesign — tax type by tax type (started 2026-07-15)

Redesign each tax type's filing workflow to the agreed conventions (top arrow stepper, merged
`document` steps, compound-JE payment, per-month DAT). **The standard to copy is written up in
[`instruction.md`](instruction.md#filing-workflow-ux-conventions-apply-to-every-tax-type)** and the
[`ECC-PLAYBOOK.md`](ECC-PLAYBOOK.md) — follow it for each tax type so they stay consistent.

- [x] **VAT** — **DONE 2026-07-15 (PR #32).** 12 → 8 steps. Top stepper + `document` steps (SLS/SLP) +
      2550Q split (Tax Codes / Return) + compound-JE payment with editable Description + SAWT 3-file
      monthly DAT. `npm test` 119 green. *Eyeball after deploy: split 2550Q Return shows mapped figures;
      SAWT DAT yields 3 accepted monthly files.*
- [x] **EWT (expanded withholding)** — **DONE 2026-07-15 (branch `feature/filing-workflow-ewt-redesign`).**
      8 → 5 steps. `info` instruction + `EWT Return` review (keeps the 0619-E monthly / 1601-EQ quarterly
      `fileFn` split — EWT genuinely has both periods) + **QAP merged into one `document` step**
      (supplier-TIN blocking banner + gated download) + compound-JE payment + `bundle`-folded freeze.
      **Correction to the original plan:** QAP is *not* a per-month DAT like SLS/SLP — its DAT is a single
      file for the period (Annex A Excel is always the full quarter), so the shared `document` footer got a
      new per-step `datHint` to say so instead of the wrong "3 files" note. `npm test` 119 green; presentation
      only. *Eyeball after deploy: QAP step shows TIN banner + single DAT; monthly→0619-E, quarterly→1601-EQ.*
- [x] **Compensation (1601-C payroll)** — **DONE 2026-07-15 (branch `feature/filing-workflow-ewt-redesign`).**
      4 → 5 steps. Info-only `Start` step + short chips; kept the `requireAllTaxStatus` gate. **Added the
      missing remittance JE voucher** (`paymentFlavor: 'compensation'`, reads `window._c.totalRemittance`).
      **Fixed a latent blank-iframe bug** — tax-status + review both used `iframeId: 'payroll'`, so the
      second step rendered blank; split into `payroll-taxstatus` / `payroll-report`. Also extracted a
      shared `mountRemittanceVoucherContent` engine helper so **EWT + compensation** share one house-style
      voucher (this also lifted EWT's payment step, which my EWT PR had left in the old plain style).
      `npm test` 119 green; presentation only.
- [x] **Income tax (1701Q / 1702Q individual & corporation)** — **DONE 2026-07-15 (branch
      `feature/filing-workflow-ewt-redesign`).** Both workflows: info-first `Start` step + short chips, kept
      the DTA carry-forward checklist, **SAWT converted to a `document` step** (customer-TIN blocking banner +
      per-month 3-file DAT — user confirmed monthly — optional/skippable when no CWT), **ITR payment folded
      into the shared voucher** (`extraNote` carries the free-choice DTA-account guidance; handles overpayment
      → balanced JE), freeze bundles the SAWT re-download. Also added **`skippable` support to the `document`
      footer** (a real "skip — nothing to file" button) for optional attachments. `npm test` 119 green.
- [x] *Cross-cutting:* all four tax types now share the top stepper + voucher. The standalone `final` step
      type is confirmed **unused by any workflow** — the code (`renderFinalFooter` + the `final` branch in
      `mountStep`) is dead and can be dropped in a cleanup pass (left in place for now, harmless). ITR now uses
      the shared voucher; VAT keeps its own bespoke renderer (multi-row output/input/CWT clearing).

## ⭐ Filing landing-screen changes (2026-07-15, same branch)

- [x] **Overview tabs reworked** — `All` now scopes to the **current year** (was a rolling 400-day window);
      `Needs filing` / `Filed` likewise current-year; **new `Archived` tab** with a year dropdown to browse past
      years. Enumeration widened to `[y-3 … y+1]` so Archived has history. (`renderWorkflowOverview`.)
- [x] **Deadline Tracker removed** — the whole `deadlines` nav + page + `dtk*` tracker code dropped (deadlines
      now surface on each category's Filings overview via due dates + Overdue pills). `dtkDate` retained (used by
      `enumerateWorkflowPeriods`). *Follow-up idea from the user: a lightweight overdue **notification** instead
      of the full page — not built.*
- [x] **"Others" category removed** — nav item + `renderOthersScreen` (Percentage Tax / Final WHT placeholders) gone.
- [x] **"Annual Filing" category added** — new nav + `annual` workflow grouping the once-a-year returns:
      annual income tax (1701 individual / 1702-RT corp by classification), 1604-C (`alphalist.html`), and
      **"coming soon" info steps for 1604-E and the Inventory List** (no report pages exist yet). Review-and-freeze
      guide — no auto-payment/variance because the annual return pages don't publish a `window` headline.
  - [ ] **Build the 1604-E annual alphalist report** (annualised QAP) — currently an eFPS-pointer placeholder.
  - [ ] **Build the annual Inventory List report** — currently an eFPS-pointer placeholder.
  - [ ] *(optional)* expose `window._itr` on the annual `1701.html` / `1702rt.html` pages so Annual Filing gets
        the JE voucher + auto-variance like the quarterly returns.

## ⭐ Prioritized next initiatives (agreed 2026-07-14)

Sequenced to run **after** the calc audit finishes, so we don't restructure files or add persistence
on top of math that's still changing. Order matters: restructure first (behavior-preserving, into a
clean layout), then build save-reports into that clean structure.

- [x] **PRIORITY 1 — Report/code restructure (clean architecture).** **DONE 2026-07-14
      (branch `refactor/js-restructure`).** Moved 35 of the 36 flat root `*.js` into concern-grouped
      folders (`reports/ helpers/ shared/ app/ batch/ admin/`) via `git mv`. `account.js` stays at
      root — the owner portal is served on the **apex** (`txform.ph/account`) via explicit nginx
      aliases (`nginx-portal-snippet.conf`), not from the repo web root, so a subfolder path would
      404 there. The form
      `*.html` **entry pages stay at root by design** — their absolute URLs are the installed
      Manager.io extension keys ([`reports.js`](../app/reports.js) `BASE_URL + file`), so moving
      them would 404 every installed client's buttons until reinstall (deferred to a later
      reinstall/redirect decision). Rewrote 172 `<script src>` refs across 24 HTML pages + the two
      Node test paths. Behavior-preserving: **107/107 tests green**, every `src` resolves, and the
      1701/app-shell/batch-import pages load all scripts `200` with no console errors.
      `docs/CODEMAPS/frontend.md` + `backend.md` regenerated to match. **Merged to main + deployed &
      verified LIVE 2026-07-14** — new subfolder paths (`reports/`, `shared/`, `app/`) serve 200, entry
      HTML (`1701.html`, `taxify.html`) still 200 (installed buttons intact, no reinstall), old flat
      paths (`1701-report.js`) now 404, and the live app shell loads every script 200 with no console errors.
- [x] **PRIORITY 2 — Save / freeze generated reports (point-in-time snapshots).** **DONE & MERGED
      2026-07-14 (PR #28 → `main`).** Rebuilt the workflow
      step-engine around a first-class **Filing** (biz + workflow + period) with a `draft → filed →
      amended` lifecycle, and built snapshots on top. Marking a period **Filed** freezes its figures so
      later book edits no longer rewrite the filed return. Delivered:
      - **Draft vs Filed status** — a new terminal **`file` (freeze)** step; a filed filing renders a
        frozen read-only view instead of the live rail.
      - **Amendment history** — append-only versions in a new `report_snapshot` table (`save-report.php`
        supersedes the prior filed row, inserts `version+1`); the frozen view lists all versions.
      - **Variance alert (v1 shipped)** — the frozen view recomputes live and flags *"Filed ₱X, books
        now ₱Y — amend?"* on the headline (auto for VAT/EWT via URL-param auto-run; graceful
        "check manually" fallback for returns that don't).
      - **Storage** — per-tenant `txform.db` via guarded `server/save-report.php` +
        `report-snapshots.php` (session-auth + business-ownership from the shared `report-store.php`,
        cloned from `entitlement.php`). **Server-only per decision:** freezing needs a session and
        **fails loudly** ("sign in to freeze") on no-session installs; drafts work everywhere.
      - **Manual-input persistence bonus** — the freeze captures the return's manual `input/select/
        textarea` fields (previously lost on reload) into the snapshot.
      - **Overview + tracker** — each category opens a Filing overview (period cards: Draft/Filed/
        Amended/Overdue); the Deadline Tracker shows real filed status.
      - **Tests** — `test/filing-core.test.js` (suite 119 green).
      - **⚠️ Remaining server steps before freeze works live** (code is on `main`, auto-deploys via the
        cron pull, but the snapshot table is a manual migration):
        - [ ] **Apply the schema migration on `txform-server`:** `sqlite3 /var/www/taxify/server/txform.db < /var/www/taxify/server/schema.sql` (idempotent). Until this runs, "Mark as Filed" errors (no `report_snapshot` table). See [`instruction.md`](instruction.md).
        - [ ] **Run `/security-review`** on `server/save-report.php` + `report-snapshots.php` + `report-store.php` (session auth, prepared statements, body cap, no enumeration; check CSRF/SameSite on the cookie-authed POST).
        - [ ] **Verify live** end-to-end on a signed-in business: freeze a period → re-open shows frozen → edit a txn → variance banner → amend → v2.
      - *Follow-up (not blocking):* extend auto-variance to comp/income returns (they'd need URL-param
        auto-run); optional stored-PDF; extend snapshot to SLS/SLP/alphalist supporting detail.
- [ ] **Evaluate the Manager Cloud self-serve distribution path (strategic).** Discovered 2026-07-14:
      a Manager.io **Cloud edition** custom button pointing at `extension.txform.ph/` loads the
      extension — so *any* Manager Cloud/Server/Desktop user can load it by URL, no install. This is a
      second, easier distribution model than "we host their books on `books.txform.ph`". Two blockers
      before it's real:
      1. **Verify data access end-to-end** — "the page loaded" ≠ "it read their books and produced a
         correct return". Generate a real BIR report on a live Cloud business and check the numbers;
         the official multi-tenant Cloud may hand the iframe API access differently than our own
         Manager Server.
      2. **No paywall on this path** — `shared/entitlement.js` is a **UX-only gate that fails open**
         ("real enforcement is server-side — provisioner + Manager auth"). That only bites in the
         host-their-books model; a Cloud user on their *own* data hits no gate → free today. Monetizing
         self-serve needs a real server-side authorize-before-run gate that does **not** fail open — a
         different enforcement model than Phase 1's provisioner. See memory `manager-cloud-distribution`.
      - **Decision (2026-07-14):** build this gate **as part of Phase 1 entitlement** work, not as a
        separate effort — it's a second enforcement mode on the same system. Confirmed second
        monetization path (reach existing Manager Cloud users directly, no hosted books).

## Phase 0 — Foundation hardening

- [x] **EBS/S3 backups** — AWS Backup snapshots + S3 Manager.io data backups, 2 AM
      Manila, 7/56/400-day retention. *(Done 2026-07-13 — see [`instruction.md`](instruction.md).)*
- [ ] **UFW** firewall rules on `txform-server`.
- [ ] **fail2ban** for SSH brute-force protection.
- [ ] **UptimeRobot** (or similar) uptime/downtime alerting.
- [x] **`save-tax-rates.php` security pass** — **DONE 2026-07-14 (merged PR #23 + server token created).**
      Defense-in-depth on top of nginx basic-auth: shared-secret `X-Txform-Token` header checked
      (constant-time) against `/etc/txform/tax-rates.token`, fail-closed if unset; 256 KB body cap;
      backup dir pruned to the newest 50. Admin tool prompts for the token once per browser
      (localStorage), never ships it. Token file created on `txform-server` (`www-data`, mode 640);
      the value is pasted into the browser once on the first "Save to Server". Setup:
      [`DEPLOY-TAX-RATES-SAVE.md`](../DEPLOY-TAX-RATES-SAVE.md) step 3.
- [x] **BIR report correctness audit** — **complete 2026-07-14 (PR #25).** Every report reviewed.
      **Cleared as correct:** rates data, graduated-tax engine, VAT 2550Q (lineAmounts back-out +
      netting), withholding chain (1601C, EWT gross-up, 0619E/1601EQ), 1702Q corporate OSD, SLS/SLP,
      SAWT/QAP, alphalist (1604-C annualization), 2307, SSS (reports actual payroll contributions).
      **Bugs found & fixed:** (1) individual OSD in 1701 + 1701Q double-deducted COGS → understated
      tax (RR 16-2008); (2) MCIT start year in 1702-RT + 1702-Q one year early → `>= 4` (RR 9-98);
      (3) **1601EQ used a divergent ATC table** vs the shared one (2307/QAP), so the quarterly return
      and its QAP alphalist read different ATC sets and wouldn't reconcile → **consolidated all EWT
      forms onto one canonical `ATC_MASTER`** (full BIR ATC list, 111 codes; `EWT_ATC_LIST` now derived
      from it). Also added a "Tax Due" column to the Tax-Rates admin income-tax panel.
      **Caveat noted:** 1601C treats separation pay as always non-taxable (only exempt for causes
      beyond the employee's control) — preparer judgment.
- [x] **Report-calc test harness** — **added 2026-07-14 (PR #25).** `test/report-calcs.test.js` loads
      the browser calc files into a Node `vm` sandbox (no source changes) and locks the graduated-tax
      engine, individual OSD (1701/1701Q), MCIT start year, and the consolidated ATC table. Runs under
      the existing `npm test` (now **107 tests**). *Follow-up:* extend coverage to VAT 2550Q netting and
      the 1601C compensation computation when convenient.
- [ ] Verify every BIR report end-to-end on a real business (**e2e-runner**).

### Backup hardening (optional, not urgent)
- [ ] **Immutability** — AWS Backup **Vault Lock** + S3 **Object Lock** (audit-grade,
      makes backups un-deletable for a set period).
- [ ] **Failure alert** — email/SNS if a 2 AM backup fails or `backup-errors.log` grows.
- [ ] Confirm with partner that the live setup is `txform-managerio-backups` (not the
      `esmeres` sample) so nobody re-points it.
- [ ] Delete the stray `test/backuptest.txt` left in the bucket from the permission test.

## Later phases (from the plan)
- [ ] **Phase 1** — tenancy/entitlement (95 tests passing; gate with `/security-review`):
  - [x] **Magic-link landing** — **LIVE & deployed 2026-07-13.** `verifyLink` 302-redirects a
        browser to the owner portal (`https://txform.ph/account`) with the session cookie on success,
        or to `…/account?error=<code>` on a bad/expired/used link (API JSON contract preserved for
        `Accept: application/json`). Portal + `/api/*` proxy aligned on the apex origin
        (`nginx-portal-snippet.conf` included in the `managerserver` apex 443 block); `account.js`
        surfaces the `?error=` as a sign-in warning. TDD (+8 tests → 95), `/security-review` clean.
        Server steps done: `txform-auth` restarted, portal snippet included + `nginx` restarted.
  - [x] **Email sender** — **LIVE & verified 2026-07-13.** Zero-dep SMTP client
        `server/smtp-mailer.js` wired into `deps.sendEmail`; 12 new tests (87 total). PR #15 merged.
        `txform-auth` systemd service installed & running on the server (Node 24 installed
        system-wide at `/usr/bin/node`; `/etc/txform/auth.env` holds Gmail creds; server dir made
        `www-data`-group-writable for `txform.db`). Confirmed: a real magic-link email delivered via
        Google Workspace (`ejtallo@txform.ph` auth). Setup runbook: [`instruction.md`](instruction.md#email--magic-link-sign-in).
  - [x] **`From` = hello@txform.ph** — confirmed 2026-07-13: delivered email shows `hello@`, so the
        Gmail send-as alias on `ejtallo@txform.ph` is verified and working.
  - [x] **nginx route** — LIVE 2026-07-13. Apex `txform.ph` 443 block includes the repo's canonical
        `nginx-auth-snippet.conf` (scopes `/api/auth/` + `/api/tenancy/` → `127.0.0.1:5100`,
        rate-limits `request-link` via `limit_req_zone authlink` added to
        `/etc/nginx/conf.d/txform-ratelimit.conf`). Verified: `/api/auth/verify` → 400 (reaches
        service), and `request-link` x8 → `200×6, 503×2` (throttle working). Ad-hoc
        `nginx-api-proxy.conf` removed. Note: needed a full `systemctl restart nginx`, not `reload`.
  - [x] **`/security-review`** — passed 2026-07-13. No HIGH/MEDIUM findings on the auth + mailer
        path: CRLF header-injection guard present (`oneLine()`), TLS cert validation on by default
        (no `rejectUnauthorized:false`), SMTP password never logged, magic-link token is CSPRNG.
  - [ ] **Remaining — in dependency / build order** (front half of the onboarding funnel + staff delivery):
    1. [ ] **Self-service sign-up** — *the blocker: no new firm can get in today* (`requestLink` only
       emails existing users). Add `POST /api/auth/sign-up { email, firmName }` → create `account`
       (`trialing` or `pending_payment`, per the model decision) + owner `users` row → send the first
       magic link; add a sign-up view to `account.html`. Reuses the shipped verify/redirect + mailer.
       **Decision needed: trial-first vs pay-first** (sets the starting `account.status`).
    2. [ ] **Staff invite email** — `inviteStaff` creates the row + enqueues provisioning but sends
       nothing. Email the invited staffer a magic link (gives them the `txfsid` session
       `entitlement.php` reads) plus a "your firm added you" note.
    3. [ ] **Manager credential delivery** — decide how a staff restricted-user logs into
       `books.txform.ph` (provisioner sets a password + one-time setup link, or a Manager-native
       invite). Confirm what Manager Server supports before touching the driver.
    4. [ ] **Live Playwright selectors** — map the real `books.txform.ph` admin DOM so
       `createUser`/`grantAccess`/`revokeAccess`/`disableUser` stop being stubs (they currently throw
       "not implemented" and `createUser` returns a null ref). Depends on #3.
    5. [ ] **Plan-status enforcement (expiry ladder)** — enforce `account.status`
       (active → grace → suspended → cancelled) on `verifyLink`/`/me` and in `entitlement.php`; wire
       `current_period_end` / `grace_until`. Nothing blocks a lapsed account today. (Couples with Phase 3 webhooks.)
- [x] **Phase 2** — website multi-page/SEO rebuild. **DONE (undeployed).** Old 564 KB JS bundle →
      static multi-page site (`website/`): home + features/security/about/contact/faq/terms/privacy,
      `assets/css/site.css` design system, real favicons, `robots.txt`/`sitemap.xml`, per-page meta +
      JSON-LD. Old bundle kept as `index.legacy.html`. Positioned as a live product, not a waitlist:
  - [x] **Pivoted from waitlist → full product (2026-07-14).** Removed the email-capture section +
        the `/api/early-access` endpoint (handler/table/tests/nginx all reverted) and the fabricated
        testimonials. CTAs are **"Get started"** → `/contact.html` (manual onboarding — self-serve
        billing waits on Phase 3 sign-up above) and **"Sign in"** → `/account`.
  - [x] Sign-in uses the **real owner portal** (not a duplicate). `account.html`/`account.js` stay at
        the repo root, served at `txform.ph/account` via the Phase-1 `nginx-portal-snippet.conf`;
        the throwaway `portal.html` was deleted and every "Sign in" link → `/account`. Merged `main`
        (magic-link portal redirect); tests green at **95**.
  - [x] Fill legal placeholders (2026-07-14): firm **TalloCPA**, **Iloilo City** (base +
        governing-law), DPO **Erol Jay Tallo, CPA** (`privacy@txform.ph`); all footers/contact
        moved Manila → Iloilo City. Still open: **counsel review** of the legal pages, and confirm
        whether the firm must **register its DPO with the NPC**.
  - [ ] (Optional) Self-host the web fonts instead of Google Fonts, per ECC web perf/privacy rules.
  - [x] **Deployed & verified LIVE 2026-07-14.** Merged as PR #21 → cron pull. All pages 200 on
        `https://txform.ph` (old JS bundle gone), legal pages show the firm details, `/account`
        portal 200, and `/api/auth/verify` → 400 (service reached). Open only: **counsel review**
        of legal pages, NPC DPO-registration check, and optional font self-hosting.
- [ ] **Phase 3** — PayMongo payments (not started; security gate).
- [ ] **Phase 4** — ToS / RA 10173 data-privacy pages (not started).
- [ ] **Phase 5** — beta / launch.
