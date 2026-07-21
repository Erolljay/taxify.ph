# Txform.ph — To-Do

Open work, newest concerns first. Part of the ECC tracking triad
(`instruction.md / progress.md / to-do.md`, see
[`docs/ECC-PLAYBOOK.md`](ECC-PLAYBOOK.md)). Phase labels map to the 6-phase SaaS plan.

_Last updated: 2026-07-21_

## ⭐ Firm-account IA — build-out (decided 2026-07-20, shipped 2026-07-21)

The firm/user/business model and its pricing are settled. Full IA — roles, permission matrix,
sign-up flow, screen map, session model, gap list — is published as an artifact:
<https://claude.ai/code/artifact/11868cee-4b68-4643-bdb7-94df63b100c9>. Decisions are recorded in
[`progress.md`](progress.md#2026-07-20--firm-account-ia-decided--businesses-re-keyed-to-manager-name-pr-40).

**Server checks — both answered 2026-07-20 (SSH, after re-pinning the security group to the current
home IP per [`DEPLOY.md`](../DEPLOY.md)):**

- [x] **`TXFORM_COOKIE_DOMAIN`** — **set to `.txform.ph`.** Not a live bug: the `txfsid` cookie does
      reach `extension.txform.ph`, and since all three hosts share one registrable domain they are
      same-site, so `SameSite=Lax` doesn't strip it inside the extension iframe. Signed-in users are
      recognised in the books without signing in again.
- [x] **Live `txform.db` is effectively empty** — `businesses=0, report_snapshot=0, users=1,
      account=1` (just the seeded owner). **PR #40's column rename therefore needs no migration** —
      drop and recreate from `schema.sql` at deploy time.
- [x] **Confirmed 2026-07-20** — `api4/businesses` objects carry only `name` and a tabs link, no `key`. Entitlement and freeze were both dead before PR #40.

**Shipped 2026-07-21 (PR #41)** — see
[`progress.md`](progress.md#2026-07-21--firm-accounts-and-the-provisioner-actually-reaches-books-pr-41):
roles (owner/staff/client), firm-code prefixes, archive, voucher comping,
high-water-mark billing, the role-scoped portal (search + Open-in-Books), the
back-office firm creator, the HTTP provisioner with its contract test, and one-time
password handover with MFA. **249 tests. Playwright deleted — zero dependencies.**

**All shipped and LIVE as of 2026-07-21.** Tallo CPA (code TALLO) is running with
four users, the provisioner reconciling every two minutes, and email reaching
external addresses. 310 tests.

**Left to do:**

- [ ] **Eyeball portal sign-out live** (shipped PR #54, see
      [`progress.md`](progress.md#2026-07-21-later-still--sign-out-of-the-owner-portal)) —
      after the cron pull deploys it: sign in at `txform.ph/account`, click **Sign out**,
      confirm you land on the sign-in card with the "You have been signed out." message and
      the dashboard does **not** come back on refresh (the session row is really gone, not
      just hidden). Logic + `Domain`/`Path` cookie-clearing are only unit-tested, not seen in
      a real browser.
- [ ] **The two partner firms** — each needs a name, an owner email, and a
      PERMANENT code (it prefixes every business name in Books and cannot be
      changed):
      `node server/create-firm.js "Firm Name" owner@firm.ph --code CODE --comp "founder firm"`
- [ ] **Make a failed job impossible to miss.** A failed `disable` carries no
      business, so it never appears as a red chip in the Access grid — only as
      `job_failed` in Activity. A failed offboarding is the highest-consequence
      failure in the system (someone who left still holds the client books) and
      currently it is the least visible one. Surface failed jobs somewhere the
      owner cannot walk past.
- [ ] **Run the whole loop once, end to end, with everything working** — invite →
      email arrives → password + pairing handed over → sign in → grant → chip goes
      live → remove → access stripped in Books. Every piece has now been seen
      working individually; the full sequence has not.
- [ ] *(later)* Move grant/revoke to api2's `user-permissions-form` if the session
      path proves fragile. The token is already in `provisioner.env` and works; its
      request shape is unknown, and learning it means writing to live books.
- [ ] *(later)* Two `.bak` files on the server are **unreadable** (copied from a
      WAL-mode database with `cp`). Worth deleting so nobody restores from one
      believing it is real — see the backup note in `instruction.md`.

**Superseded — do not build:**

- [x] **Re-key businesses to the Books name** — DONE 2026-07-20 (PR #40).
- [x] **Schema additions** — DONE (PR #41). `firm_name`, `firm_code`, `client` role,
      `businesses.status` + `archived_at` + `manager_created_at`, `business_billing_period`,
      `account_discount`, and the one-time password columns. **No tax-type column**: we serve
      VAT businesses only and the rate is flat, so it would have held one value everywhere.
- [x] **Portal rework** — DONE (PR #41), plus search and Open-in-Books links.
- [ ] ~~**Sign-up flow**~~ — **not being built.** Every firm on the system is one we know
      personally, so onboarding is a command (`create-firm.js`), not a funnel. Revisit only if
      strangers ever need to self-serve.
- [ ] ~~**PayMongo**~~ — **deferred indefinitely.** The three firms are comped via vouchers and
      there is no PayMongo account. The billing model is decided and implemented (flat ₱500 per
      business, high-water-mark monthly, `invoiceFor` computes the amount) — only the charging
      integration is missing, and nothing depends on it.

## ⭐ Month-end Prep restructure + party Excel round-trip + readiness-gated workflows (2026-07-19)

Turned the "Month-end" nav placeholder into a real **Month-end Prep** screen and made the filing
workflows gate on data readiness up front. See memory `month-end-prep-restructure`.

- [x] **Excel round-trip in the party/employee editors** ([`shared/custom-fields.js`](../shared/custom-fields.js)) —
      📥 Download / 📤 Upload `.xlsx` for Customers, Suppliers, Employees. Matches rows by a locked
      **Manager ID** column, **skips already-complete records** (type-aware), previews in a confirm modal,
      writes **non-empty cells only (never erases)**. SheetJS loaded on demand.
- [x] **Month-end Prep screen** ([`taxify.html`](../taxify.html) `#month-end-mode` +
      [`taxify-app.js`](../app/taxify-app.js)) — replaced the "Quarterly Closing" placeholder. One screen,
      5 lazy tabs: Customers / Suppliers / Employees (inline CF mounts) + Receivables / Payables
      (batch-import iframes **moved out of Data Intake** — Data Intake is now just Sales / Purchases / Payroll).
- [x] **Report party tabs retained** (reversed an earlier "remove them" plan) — SLS/SLP/QAP/SAWT/Alphalist
      keep their party tabs as the in-line typo-fix fallback (Excel re-upload skips complete records, so
      in-line edit is the only path to fix a mistyped-but-complete record).
- [x] **Readiness-gated workflows** ([`app/workflows.js`](../app/workflows.js) +
      [`app/step-engine.js`](../app/step-engine.js)) — each workflow opens with a **gating checklist** on
      full type-aware party/employee completeness (TIN + name + address); blocks Continue until green with a
      "Fix in Month-end Prep →" button (`window.tfyGoToMonthEnd`). VAT / EWT / Compensation block; Income's
      customer row is **non-blocking** (SAWT is optional). Per-step party-TIN checks removed from
      sls/slp/qap/sawt (the gate covers them); replaced Compensation's `taxstatus-check` with the gate.
- [x] **Conditional steps** — new engine `showIf` predicate hides a step entirely when there's nothing to
      do (hidden steps auto-done + skipped in the rail). Applied to the **VAT Tax-Codes** step
      (`hasUnmappedVatCore` — hidden when all core VAT categories are mapped).
- [x] **Address Line 2 → ZIP Code** — party field `…009` repurposed as a 4-digit numeric ZIP (feeds BIR
      2307's payee ZIP boxes via a new `loadPartyBIR().zipCode`); `zip4()` validation on entry / save / Excel.
      *Migration note: existing "City, Province" text in that field now reads as ZIP — move it into Address.*
- [x] **Tests** — [`test/custom-fields-helpers.test.js`](../test/custom-fields-helpers.test.js) (completeness
      rule, select-value conversion, `zip4`) + [`test/workflows-structure.test.js`](../test/workflows-structure.test.js)
      (readiness gate / `showIf` / no per-step checks). `npm test` **146 green**. *Logic/structure only —
      not runtime-tested in live Manager.*
- [ ] **Compensation payslip-item mapping conditional step** — the one remaining piece of the "conditional
      mapping" pattern. Only VAT got a conditional mapping step (clean `!vm[coreCat]` signal); Compensation's
      payslip-item→BIR-category mapping has no cheap "unmapped" signal yet (would need a new loader across the
      3 payslip endpoints + their category map). Build that check, then add a conditional "Map payslip items"
      step to the compensation workflow (embeds the Settings payslip-items mapper). EWT/Income have no separate
      mapping step, so the pattern doesn't apply there.
- [ ] *Eyeball in live Manager:* readiness gate blocks + "Fix" lands on the right Month-end Prep tab; VAT
      Tax-Codes step hides when all core codes are mapped; 2307 shows the payee ZIP; Excel upload preview +
      skip-complete behaves.
- [ ] *(tunable)* employee completeness = TIN + Tax Status + name (may feel strict for monthly payroll); the
      VAT step hides only when all 8 core VAT categories are mapped — loosen if it nags businesses without
      zero-rated / exempt codes.

## ⭐ Batch import — party dedup at data entry (Layer 1) (2026-07-19)

The Excel batch-import templates (Sales / Purchase / Payroll) let bookkeepers type the same
Customer/Supplier/Employee under different spellings, creating duplicate contacts on import.
The importer already had **Layer 2** (import-time fuzzy-match resolver in
[`batch/batch-import.js`](../batch/batch-import.js) — `normalizePartyName` + `levenshtein` +
`findNearDupCandidates` + the "Possible duplicate → pick the match" preview dropdown). This adds
**Layer 1** — prevention at data entry.

- [x] **Party-name dropdown on the template's column B** — **DONE & MERGED 2026-07-19 (PR #37).** New
      `Customers` / `Suppliers` / `Employees` reference sheet (sorted, de-duped, auto-pulled live from
      Manager via the existing lookup cache — no new API calls) feeds a **warning-style** Data Validation
      dropdown on the party-name column, mirroring the existing Account/ATC dropdowns. Warning (not Stop)
      so a genuinely new party can still be typed and confirmed. Payroll's Withholding Tax Calculator now
      reuses the shared `Employees` sheet (was creating a second same-named sheet → ExcelJS collision).
      Instruction sheet documents the dropdown + the Microsoft 365 (filters as you type) vs older-Excel
      (type full name + Enter) behavior. Presentation-only; `node --check` clean.
  - [ ] *Eyeball after deploy:* download each of the 3 templates → column B shows the live contact list,
        and typing a made-up name **warns** (not blocks). Not yet exercised end-to-end (needs ExcelJS +
        Manager API at runtime).
  - [ ] *(watch, not urgent)* very large contact lists (2,000+) make the dropdown long to scroll on older
        Excel; Microsoft 365 filters as you type. No VBA/combobox workaround added by design (keeps the file
        non-macro and robust).

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
- [x] **"Annual Filing" is a nav *header* (group), not a workflow** — restructured per user 2026-07-15. Under the
      **Annual Filing** header: **Annual Income Tax (1701/1702-RT)** and **1604-C** open their report pages
      directly (full-width iframe via `renderEmbeddedReport`, `?biz=` passed like Data Intake); **1604-E** and
      **Inventory List** are placeholder panels (`PLACEHOLDER_SCREENS`). Keys `annual-itr` / `annual-1604c`
      (report embeds via `ANNUAL_REPORTS`) + `annual-1604e` / `annual-inventory` (placeholders), routed in
      `renderUserMode`. **The earlier single `annual` step-engine workflow was removed** — it crashed at load
      (`findReport('alphalist.html')` → undefined; REPORTS stores it as `alphalist.html#2316`), which took down
      `WORKFLOWS` and the whole app (the console error the user hit). No freeze/period tracking on annual items now.
  - [ ] **Build the 1604-E annual alphalist report** (annualised QAP) — currently a placeholder panel.
  - [ ] **Build the annual Inventory List report** — currently a placeholder panel.
  - [ ] *(later)* if annual returns should get period tracking / freeze, give each its own workflow key with a
        form-scoped period_key (the annual returns share `annual:YYYY`, so they'd collide in the filing store).
- [x] **"Month-end (Quarterly closing)" header + placeholder added** — new nav group **before File Returns** with a
      single `month-end` placeholder item (`PLACEHOLDER_SCREENS['month-end']`). **Superseded 2026-07-19:** the
      placeholder became the real **Month-end Prep** screen (party master data + AR/AP + readiness gates — see the
      top section).
  - [ ] **Build the month-end / quarterly-closing checklist** (accruals, bank/CoA recon, tax-code audit) — the
        pre-filing "close the books" step. *(Still open — Month-end Prep covers party/AR-AP readiness, not the
        accounting-close checklist.)*

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
       **Decided 2026-07-20: pay-first, no trial** — nothing is provisioned in Manager until the
       card clears, so the account starts `active` only after payment. Full 6-step flow in the
       Firm-account IA section at the top of this file.
    2. [ ] **Staff invite email** — `inviteStaff` creates the row + enqueues provisioning but sends
       nothing. Email the invited staffer a magic link (gives them the `txfsid` session
       `entitlement.php` reads) plus a "your firm added you" note.
    3. [ ] **Manager credential delivery** — decide how a staff restricted-user logs into
       `books.txform.ph` (provisioner sets a password + one-time setup link, or a Manager-native
       invite). Confirm what Manager Server supports before touching the driver.
    4. [ ] **Live Playwright selectors** — map the real `books.txform.ph` admin DOM so
       `createUser`/`grantAccess`/`revokeAccess`/`disableUser` stop being stubs (they currently throw
       "not implemented" and `createUser` returns a null ref). Depends on #3. **Model corrected
       2026-07-20 (PR #40):** there is no per-user permissions page — access is the `Businesses`
       multi-select on `/user-form?<base64 email>`, whose option values are `base64(businessName)`,
       so grant and revoke are the same operation (re-open the form, edit the selection, save).
       Use the `/playwright` skill against a live admin session to pin the selectors.
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
