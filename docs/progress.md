# Txform.ph — Progress

Tracking doc referenced by [`docs/ECC-PLAYBOOK.md`](ECC-PLAYBOOK.md). Snapshot of
where the app stands against the 6-phase SaaS plan, kept current from source
changes rather than hand-waved.

_Last updated: 2026-07-21_

## Phase status

| Phase | Status | Notes |
|-------|--------|-------|
| **0 — Foundation hardening** | ✅ Largely done | Pull-based auto-deploy (`scripts/deploy.sh` via 2-min root cron), nginx web-root hardening, LF normalization. Hosting-license confirmed, Manager Server bought. **Backups live (2026-07-13):** AWS Backup EC2 snapshots + S3 Manager.io data backups, both 2 AM Manila, 7/56/400-day retention. **`save-tax-rates.php` hardened & LIVE (2026-07-14, PR #23):** shared-secret token + body cap + backup pruning on top of nginx basic-auth; token file created on the server. Still open: UFW, fail2ban, UptimeRobot, e2e BIR verification. |
| **1 — Tenancy / entitlement / provisioning** | ✅ Live | `server/auth-*.js`, `smtp-mailer.js`, `migrate.js`, `manager-client.js`, `provisioner.js` + HTTP driver, `manager-vue-form.js` / `manager-permissions.js` / `manager-tabs.js`, `create-firm.js`, `entitlement.php`, systemd units. **363 passing tests. Zero npm dependencies** — Playwright was deleted once it became clear Books needs no browser. **LIVE as of 2026-07-21:** Tallo CPA (code TALLO) with four users, provisioner timer reconciling every two minutes, deploys restarting the auth service automatically, and email reaching external addresses (SPF/DMARC added). Roles owner/staff/client, firm-code prefixes, archive-not-delete, removal that revokes in Books and kills the session, voucher-based comping, high-water-mark billing, one-time password handover with MFA, and portal sign-out (PR #54). **Provisioning is now complete end to end (PR #56):** a grant sets Full access inside the business as well as linking it, and new books get the firm's nine tabs — both verified live. Open: the two partner firms; failed jobs are visible only in Activity, not as a chip. |
| **2 — Website rebuild & SEO** | ✅ Live | **Deployed 2026-07-14 (PR #21).** Full static multi-page site under `website/`: home + features/security/about/contact/faq/terms/privacy, shared `assets/css/site.css` + `assets/js/site.js`, real favicons, `robots.txt` + `sitemap.xml` + per-page meta & JSON-LD. **Positioned as a live product, not a waitlist** — CTAs are "Get started" → contact onboarding and "Sign in" → the owner portal at **`/account`**. Legal pages carry the firm's real details (TalloCPA, Iloilo City, DPO Erol Jay Tallo). Old JS bundle preserved as `index.legacy.html`. Open only: counsel review of legal pages, optional font self-hosting. |
| **3 — Payments (PayMongo)** | 🔴 Not started | No PayMongo/webhook code yet. **Model decided 2026-07-20:** flat ₱500/business/month (no tiers), no trial, one monthly invoice billed on the high-water mark of active businesses. PayMongo cannot prorate, but invoice line items can be adjusted before an invoice finalises — that's the mechanism. Annual prepay deferred. |
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

### 2026-07-21 (evening) — A grant was only ever half a grant (PR #56)

Found by the owner looking at the screen, not by any test: after the
provisioner linked a business to a staff member, there was still a manual
step nobody had automated — setting that user's **Access type** to Full
inside the business.

Ticking the business on `/user-form` decides **which** books a user can
open. What they may **do** once inside is a separate per-business **User
Permissions** record, and nothing created it. So a provisioned staff
member signed in, saw the client listed, opened the books, and could not
work in them — while the portal showed a green tick the whole time.

The codebase asserted the opposite as fact, in two file headers and in
`to-do.md`:

> "Manager has no per-user permissions page."

Wrong, and load-bearing: it was the stated reason nobody had looked for
the step. Verified false on the live server — a freshly created business
has **no** permission record at all. Corrected everywhere it appeared.

`grantAccess` now does both halves and verifies both. **Half a grant is
worse than a failed one**: a failure retries and is visible in Activity,
whereas a half-grant looks like success until someone tries to work.

**Also shipped: `configure_tabs`.** New books arrive with Manager's
default sidebar, so every client needed nine boxes ticked by hand. Queued
beside `create_business`, it turns on Bank and Cash Accounts, Receipts,
Payments, Customers, Sales Invoices, Suppliers, Purchase Invoices,
Employees and Payslips. It is **additive — it never unticks**, so a retry
cannot undo a tab enabled deliberately for a client. Journal Entries has
no checkbox; Manager always shows it.

**Two protocol facts learned, neither documented anywhere before:**

*These screens are Vue apps, not HTML forms.* Inputs are `v-model`-bound
with **no `name` attributes**, so there is nothing to scrape into a
urlencoded post. The state is a JS literal at the foot of the page, and
`htmx-extensions/form.js` posts `JSON.stringify(app.$data)` into a single
multipart field named `febb4049-dcdb-4c7a-a395-4b71da72a85b` — a constant
hardcoded in Manager's own JS, not a per-render nonce. Shared handling
lives in [`server/manager-vue-form.js`](../server/manager-vue-form.js).
The model parser is brace-counted and string-aware rather than
regex-matched: these models contain `{}`, and a non-greedy regex returns a
**truncated object**, which Manager would then accept as the record's
complete new state.

*Field 250 of the URL envelope is destructive* — Delete on the
permissions form, Reset on the tabs form — and the safe URL differs from
the destructive one **by a single bit**:

```
Update  …EfLQDwA     (250 = 0)
Reset   …EfLQDwE     (250 = 1)
```

So nothing constructs that field. The driver builds only the simplest key
it can (the business name, which the sidebar links prove valid) and then
**follows Manager's own hrefs**, which already carry a correct flag-zero
envelope. A bug in envelope construction therefore cannot produce a
delete, and a test asserts it of every key the driver builds.
`revokeAccess` leaves the permission record in place for the same reason:
the `Businesses` select is the gate, so an orphaned record grants nothing,
and removing it would mean building exactly that URL.

**Verified live** against `Test-Business-1` with `idetayson@tallocpa.com`,
run from the server with `provisioner.env` — a read-only probe first, then
the writes:

- a fresh business had **no** permission record, confirming the bug
- tabs went 0 → the nine, 27 left untouched
- the record was **created**, access read back as Full
- the user went 16 → 17 businesses with **MFA intact**
- **re-run was clean**: tabs skipped the write entirely, the grant edited
  rather than duplicating, count held at 17 — which matters, because
  provisioner jobs retry up to three times
- **additive confirmed live**: a hand-enabled Fixed Assets survived a
  subsequent run

**363 tests.** Fixtures captured from Manager 26.7.10.3654, including its
`href ="..."` spacing quirk.

The pattern from the going-live entry holds again: this was a failure that
**read as success** from every angle the software could see, and only
using it exposed it.

### 2026-07-21 (later still) — Sign out of the owner portal

The portal could be signed *into* but never *out of* — the header showed who
you were, with no way to end the session. Added it end to end:

- **Server** ([`server/auth-service.js`](../server/auth-service.js)) — new
  `POST /api/auth/sign-out` handler. It **deletes the server-side session row**
  (sessions are secret-in-cookie / hash-in-DB, so dropping the row makes the
  cookie unreplayable even if a copy survives) and returns a `Max-Age=0`
  cookie carrying the same `Domain`/`Path` the session was set with — a
  mismatch there would leave the original cookie in place. Scoped to **this
  session only** (signing out on one device leaves the user's other sessions
  alone), and **idempotent** — no cookie, or an already-dead session, still
  returns 200 with the cleared cookie.
- **Portal** ([`account.js`](../account.js) + [`account.html`](../account.html)) —
  a **Sign out** button beside the identity in the header (every role gets it;
  the header is the one thing on every screen). It POSTs, clears client state,
  and returns to the sign-in view with a confirmation — resetting optimistically
  even if the request fails, so a network blip can't strand you "signing out…".
- **No infra change** — the existing `location /api/auth/` proxy already routes
  the new path to `:5100`; nothing to add in nginx.
- **Tests** — +3 in [`test/auth-service.test.js`](../test/auth-service.test.js)
  (session ends + `/me` 401 + cleared cookie; idempotent no-cookie; this-session-only).
  `npm test` **313 green** (was 310).
- **Merged as PR #54** → auto-deploys via the 2-min cron pull; because the diff
  touches `server/*.js`, `deploy.sh` restarts `txform-auth` on its own, so the new
  route goes live with no manual step. **Not yet eyeballed in a live browser** —
  see [`to-do.md`](to-do.md) (click Sign out → lands on the sign-in card, dashboard
  does not return on refresh).

### 2026-07-21 (later) — Going live: five bugs the real system found

Everything below was found by *running* it, not by reasoning about it. Recorded
because each failure mode is one that reads as success.

**Email to anyone outside the firm was silently dropped.** The From domain
`txform.ph` had **no SPF record** — `tallocpa.com` did, which is why mail inside
the firm always worked and nothing else ever arrived. Neither the send nor the
log showed a problem: Google accepted every message, and it appeared in Sent.
Fixed with one DNS record (`v=spf1 include:_spf.google.com ~all`), plus DMARC
(`p=none`, reports to `hello@txform.ph`).

*The diagnosis took two wrong turns worth remembering.* SPF was found early and
then abandoned on a misread — "the magic link is received" was assumed to mean
*at Gmail* when it meant *at the Workspace address*. That produced a whole theory
about the invite email looking like phishing. **The question that settles it is
"which inbox received it?"** — ask before building.

**A live offboarding failed silently.** A `disable` job burned its retries on
`could not open the user form (http 302)`. That 302 was Books saying "not signed
in" — it redirects unauthenticated requests to the **site root**, not to
`/login`, which is all the client checked for. So it never re-authenticated. A
failed grant is a nuisance; a failed revoke is someone who has left still holding
the client books. `manager-client.js` had no test file at all; it does now.

**Schema changes never reached the live database.** `schema.sql` is all
`CREATE TABLE IF NOT EXISTS`, which does nothing to a table that already exists —
so `users.status` shipped, the service started healthy, and then 500'd on the
first query touching it. `server/migrate.js` now ALTERs in missing columns at
boot, additively, refusing loudly what SQLite genuinely cannot do.

**Deploys never restarted the auth service.** A long-running Node process keeps
its old modules; the staff-invite email was merged, deployed, and still sent
nothing. `deploy.sh` now restarts `txform-auth` when `server/*.js` or
`server/*.sql` move, and fails loudly if it does not come back.

**MFA was never actually enabled.** `createUser` posted
`MultifactorAuthentication='on'`, but that field's value is a TOTP secret Books
mints per render — so it was ignored and users were created without a second
factor. It now fetches the form and posts back the minted secret.

**Also shipped:** staff/client removal (the missing half of the access grid —
grants deleted, `disable` queued, session killed, sign-in blocked at all three
paths, seat freed, history kept); the invite email; one-time password handover
with the authenticator steps beside it; per-tab search; Open-in-Books links; and
mailer logging of successes, without which "did we send it?" was unanswerable.

**Two operational traps recorded in [`instruction.md`](instruction.md):** `cp` is
not a backup of a WAL-mode SQLite database (two `.bak` files taken that way were
unreadable — use `sqlite3 .backup`), and MFA must never be enabled on the
`provisioner` account or the robot is locked out permanently.

`npm test` **310 green**. Live: Tallo CPA (code TALLO), four users, provisioner
timer ticking every two minutes.

### 2026-07-21 — Firm accounts, and the provisioner actually reaches Books (PR #41)

**Naming note:** user-facing text now says **Books** for `books.txform.ph`. Code,
comments and column names still say Manager, because that is genuinely the product
they talk to — renaming those would make the code lie about its own dependency.

**Roles.** `owner` · `staff` · `client`, the last being the business owner we keep
books for: read-only, one business, free. The permission matrix lives in one tested
table (`ROLE_CAPABILITIES`) and **fails closed** on an unknown role. Only the owner
may amend an already-frozen filing.

**The portal works for everyone.** `overview()` was owner-only, so staff and clients
could sign in and were then turned away. Now each role gets a scoped payload — staff
and clients get no team roster, no access grid, no limits, no billing. Five tabs for
owners, landing on **Clients**; search on Clients/Team/Access once a list passes five
entries; every client row has an **Open** link into its books.

**Billing.** `business_billing_period` records one row per business per month it was
active for *any* part of — a high-water mark, not a snapshot of invoice day. Without
it, archiving before the invoice would be free, and since VAT is filed *quarterly*
while billing is *monthly*, a firm could add every client, file the whole quarter and
remove them before being charged. Removal is **archive, never delete**.

**Free accounts are a voucher, not an exemption.** A comped firm is still counted,
invoiced and audited; its invoice simply totals zero and carries the reason. One code
path for everybody, and the same mechanism covers promos and partner rates. Money is
in centavos.

**Firm codes.** Every account has an immutable short code prefixing its business names
in Books (`TALLO-0001 Acme`). Two firms can hold the same client name, which deleted
the old collision-suffix scheme — and with it a leak, since a firm that asked for
"Acme" and got "Acme (1)" could infer another firm had one. It also gives the
administrator a who-owns-what view in Books' own business list.

**The picker was dropped from the design.** Listing businesses for an owner would have
shown them every *other* firm's client names, which for CPA firms is the confidential
asset. No listing endpoint exists to be called.

**Provisioner: Playwright deleted, plain HTTP instead.** Books needs no browser — its
login is an ordinary two-step form POST with no CSRF token. `package.json` now has
**zero dependencies**. Verified live against 26.7.10, end to end: business created,
restricted user created, access granted and revoked.

Four bugs found along the way, three of them the same shape — a partial form post that
Books reads as the user's *complete* new state:

- **URL params are not plain base64.** `/user-form?<key>` takes a protobuf-style
  envelope (`0x0a`, length, utf8). Plain base64 does not 404 — it serves a *blank
  new-user form*, so the driver read an empty user, edited that, and got a `200`.
  Every signal said success while nothing was granted. Caught only by checking Books
  directly rather than trusting our own job status.
- **An access change would have stripped MFA.** `MultifactorAuthentication`'s value is
  the user's TOTP secret; omitting it posts "MFA off". The robot would have quietly
  undone the protection it exists to support.
- **Retries burned out in one tick.** `drainOnce` re-claimed a job that had just failed
  back to pending, so anything waiting on another job gave up seconds after being
  queued. Now one attempt per tick.
- Writes are now **read back and compared** before a job is marked done, and a blank
  form throws rather than being posted back as a stray account.

**Credentials.** A dedicated `provisioner` admin in Books, long random password, in
`/etc/txform/provisioner.env` (root, 600). New staff get a generated password shown
**once** to the firm owner in the portal — never emailed, cleared on acknowledgement,
expired after 24h — plus a Reset password button. MFA is on by default for provisioned
users; enrolment happens at their first login.

**A read-only contract test** (`npm run contract`) asserts the shapes we depend on.
Run it after every Books update — see [`instruction.md`](instruction.md#provisioner--credentials-and-the-check-to-run-after-every-manager-update).

`npm test` **249 green** (was 149). Not yet deployed: the schema changed again, so the
live `txform.db` needs recreating on merge (it is still effectively empty).

### 2026-07-20 — Firm-account IA decided + businesses re-keyed to Manager name (PR #40)

**The design.** Settled the firm/user/business model that Phase 1 half-built, and the pricing
that Phase 3 will bill. Full IA (roles, sign-up, screens, session model, gap list) is published
as an artifact: <https://claude.ai/code/artifact/11868cee-4b68-4643-bdb7-94df63b100c9>.

- **Three roles.** `admin` (the paying firm owner — billing, adds/archives businesses, invites
  staff, sets the grid, and the *only* role that can amend a filed return) · `staff` (granted
  businesses only; prepares, files, freezes) · `client` (the business owner — read-only, own
  business only). Staff seats are unlimited and free; client users are free too.
- **Pricing: flat ₱500/business/month, VAT or not.** A ₱250 non-VAT tier was considered and
  rejected — tax status is self-declared and unaudited, so a firm would register clients as
  non-VAT and generate VAT returns anyway. **Price must never depend on a figure the customer
  declares about themselves.** No free trial.
- **Billing: one monthly invoice, high-water mark.** A business is billed for any month it was
  active *at any point*; no proration, no refunds, access to period end. Rejected "free until the
  next cycle" because VAT returns are filed *quarterly* while billing is *monthly* — a firm could
  add every client after a billing date, file the whole quarter, and remove them before the next,
  paying ₱0. **PayMongo does not support proration at all** (verified against their docs), but it
  does allow invoice line items to be adjusted before the next invoice finalises, which is exactly
  what a recalculated monthly invoice needs. Annual prepay deferred.
- **Architecture rule made explicit.** txform.ph is the control plane (source of truth for firms,
  users, roles, access, billing, frozen filings); Manager is a mirror. Sync is one-way and the
  website wins. Nobody edits users inside Manager — the provisioner reconciles it away, and the
  failure mode of two-master editing is cross-firm data exposure.
- **Never authenticate by matching email addresses** between Manager and txform.ph. Even if
  Manager hands the iframe a logged-in email, that's an unverifiable claim. Not needed anyway:
  `txfsid` is issued with a configurable `Domain` (**`TXFORM_COOKIE_DOMAIN`**), and since
  `txform.ph` / `extension.txform.ph` / `books.txform.ph` share one registrable domain they are
  *same-site*, so `SameSite=Lax` does not strip the cookie inside the extension iframe.
  **Verified on the server the same day: `TXFORM_COOKIE_DOMAIN=.txform.ph` is set**, so this works
  today. (Were it unset the cookie would be host-only and every entitlement check would fail for
  signed-in users — worth re-checking first if entitlement ever misbehaves.)

**The fix (PR #40).** Manager Server has no business GUIDs — `api4/businesses` returns objects
carrying only `name`, and the user form's Businesses multi-select uses `base64(name)`. The portal
nonetheless asked owners to paste a "Manager business GUID" and stored it as the join key, so
**two features were silently dead in production**:

- `shared/entitlement.js` resolved name → GUID off `.key`, a field Manager never sends. It
  returned `null` every time and `checkEntitlement(null)` fails open — the gate never engaged.
- `app/filing-store.js` threw `FilingAuthError('Business not resolvable')` on the same `null`, so
  **every freeze and every snapshot load failed**.

Column renamed to `manager_business_name`; both resolvers deleted. Because Manager names must be
unique across every hosted firm, a colliding firm silently gets an account-scoped Manager-side
name (`OtherCo (1)`) while the portal keeps showing their chosen name — a plain "already taken"
error would be a cross-tenant oracle. The suffix derives from the **account id**, not a collision
count, so it never reveals how many other firms hold the name. The Playwright driver's TODOs were
also corrected: they described an `/admin/users/<id>/permissions` page that does not exist —
access is the Businesses multi-select on `/user-form`, making grant and revoke the same operation.

**Deploy note:** the live `txform.db` was checked the same day and is effectively empty
(`businesses=0, report_snapshot=0, users=1, account=1` — just the seeded owner), so the column
rename needs **no migration**: drop and recreate from `schema.sql` when this merges. Freeze has
never worked in production, so it needs an end-to-end test after deploy rather than a regression check.

`npm test` **149 green** (+3 from this change). Not yet deployed.

### 2026-07-19 — Month-end Prep restructure + party Excel round-trip + readiness-gated workflows
Turned the "Month-end" nav placeholder into a real **Month-end Prep** screen (the "update your data
before you file" hub) and made every filing workflow gate on data readiness up front. Full design
rationale in memory `month-end-prep-restructure`.

- **Excel round-trip in the party/employee editors** ([`shared/custom-fields.js`](../shared/custom-fields.js)):
  📥 Download / 📤 Upload `.xlsx` for Customers, Suppliers, Employees. Upload matches rows by a locked
  **Manager ID** column, **skips records already complete** (type-aware — individuals need last+first,
  companies need a company name), shows a **preview/confirm modal**, and writes **only non-empty cells
  (never erases existing data)**. SheetJS loaded on demand (same CDN build the SLS report uses).
- **Month-end Prep screen** ([`taxify.html`](../taxify.html) new `#month-end-mode` +
  [`app/taxify-app.js`](../app/taxify-app.js) `renderMonthEndPrep`): replaced the placeholder. One screen,
  5 lazy tabs — Customers / Suppliers / Employees (inline `CF` mounts, same pattern as Settings) +
  Receivables / Payables (batch-import iframes **moved out of Data Intake**; Data Intake is now just Sales /
  Purchases / Payroll). The report party tabs were **kept** (in-line typo-fix fallback — Excel re-upload
  skips complete records, so in-line edit is the only way to fix a mistyped-but-complete record).
- **Readiness-gated workflows** ([`app/workflows.js`](../app/workflows.js) +
  [`app/step-engine.js`](../app/step-engine.js)): two new engine behaviors — a **gating checklist**
  (`gate: true` — Continue blocked until the check passes, with a "Fix in Month-end Prep →" button that
  navigates via `window.tfyGoToMonthEnd(tab)`) and a **conditional step** (`showIf` predicate — hidden
  entirely when there's nothing to do; `buildDraft` is now async and resolves `showIf` into
  `state.hiddenKeys`; hidden steps are auto-done and skipped in the rail/nav). Wiring:
  - **VAT** — upfront readiness gate on Customers + Suppliers; the **Tax-Codes step is now conditional**
    (`hasUnmappedVatCore` — hidden when all 8 core VAT categories are mapped).
  - **EWT** — readiness gate on payees (suppliers).
  - **Compensation** — the old `taxstatus-check` review-gate **replaced** by an employee readiness gate
    (TIN + Tax Status + name).
  - **Income (1701Q/1702Q)** — a **non-blocking** customer readiness heads-up (SAWT is optional).
  - Per-step party-TIN checks removed from sls/slp/qap/sawt (the upfront gate covers them); the dead
    `checkPartyTIN` helper dropped.
- **Address Line 2 → ZIP Code** — the party field `PARTY_GUIDS` `…009` was repurposed as a **4-digit
  numeric ZIP Code** so it feeds **BIR Form 2307**'s payee ZIP boxes (`supp.zipCode`, which `loadPartyBIR`
  never populated before — the boxes were always blank). `loadPartyBIR` now exposes `zipCode` (and keeps
  `address2` for the SLS/SLP/1601EQ address line, where the ZIP appends normally); 2307's `payeeAddr` is
  `address1` only to avoid doubling the ZIP. A `zip4()` helper + `maxlength=4`/numeric input enforce 4
  digits on entry, save, and Excel up/download. *Migration note: businesses that previously typed
  "City, Province" into Address Line 2 will see it treated as ZIP — the full address now belongs in Address.*
- **Verify:** `npm test` **146 green** (+27: `test/custom-fields-helpers.test.js` locks the completeness
  rule, select-value conversion and `zip4`; `test/workflows-structure.test.js` loads `workflows.js` in the
  `vm` sandbox and locks the readiness gate / `showIf` / removed per-step checks). `node --check` clean on
  every changed file. **Not runtime-tested in live Manager** (needs Manager's API context) — eyeball after
  deploy: readiness gate blocks + "Fix" lands on the right tab; VAT Tax-Codes step hides when mapped; 2307
  shows the payee ZIP; Excel upload preview + skip-complete behaves.
- **Follow-up (in [`to-do.md`](to-do.md)):** the "conditional mapping" pattern only covers VAT so far —
  Compensation's payslip-item mapping needs an "unmapped" signal built before it can get its own conditional
  step. Two tunable thresholds noted (employee completeness strictness; which VAT categories count).

### 2026-07-19 — Batch import: party dedup dropdown at data entry (PR #37)
Added **Layer 1** duplicate prevention to the Excel batch-import templates (Sales / Purchase / Payroll),
all in [`batch/batch-import.js`](../batch/batch-import.js). Each template now builds a `Customers` /
`Suppliers` / `Employees` reference sheet — sorted, de-duped, auto-pulled live from Manager through the
existing lookup cache (no new API calls) — and attaches a **warning-style** Data Validation dropdown to
the party-name column (column B), mirroring the Account/ATC dropdowns already there. Warning (not Stop)
means a genuinely new party can still be typed and confirmed rather than blocked. This complements the
pre-existing **Layer 2** import-time fuzzy-match resolver (`normalizePartyName`/`levenshtein`/
`findNearDupCandidates` + the preview "Possible duplicate → pick the match" dropdown): Layer 1 stops most
duplicates at entry, Layer 2 catches whatever slips through. Also fixed a latent bug — payroll's
Withholding Tax Calculator was creating a second sheet also named `Employees` (an ExcelJS collision); it
now reuses the shared reference sheet. Instruction sheet documents the dropdown + the Microsoft 365
(filters as you type) vs older-Excel (type full name + Enter) behavior. Presentation-only; `node --check`
clean. Not yet exercised end-to-end (needs ExcelJS + Manager API at runtime) — eyeball after deploy.

### 2026-07-15 — Hotfix: Annual Filing crashed the app at load (PR #35)
PR #34 was merged with an `annual` step-engine workflow whose `annual-1604c` step read
`file: findReport('alphalist.html').file` at object-literal (load) time — but `REPORTS` stores that
page as `alphalist.html#2316`, so `findReport` returned `undefined` and reading `.file` **threw**,
aborting `workflows.js` and leaving `WORKFLOWS` undefined (whole app dead:
`Cannot read properties of undefined (reading 'file')` → `WORKFLOWS is not defined`). Fixed by removing
the `annual` workflow and reshaping Annual Filing as a nav **header** with direct report-embed items +
placeholders (see the entry below, now corrected). `WORKFLOWS` builds cleanly (5 keys); `npm test` 119
green. Lesson recorded: `findReport(x)` at load time throws unless `x` is an exact `REPORTS[].file`.

### 2026-07-15 — Income tax redesign + filing landing-screen overhaul
Finished the tax-by-tax redesign (income tax = 4th/last type) and reworked the filing landing screen,
on branch `feature/filing-workflow-ewt-redesign`.

**Income tax (1701Q individual + 1702Q corporation)** — both workflows to the house style:
- Info-first `Start` step + short chips; kept the DTA carry-forward checklist.
- **SAWT converted to a `document` step** — customer-TIN blocking banner (the payors who withheld from
  you) + gated download, **per-month 3-file DAT** (user-confirmed monthly cadence), and `optional` +
  `skippable` when no creditable tax was withheld.
- **ITR payment folded into the shared `mountRemittanceVoucherContent`** — all four tax types now share
  one voucher renderer (VAT keeps its bespoke multi-row one). The helper gained an `extraNote` (carries
  ITR's free-choice DTA-account guidance) and now handles a signed total (overpayment → balanced JE).
- **Engine:** added real `skippable` support to the `document` footer (a "skip — nothing to file"
  button that bypasses the TIN gate + download for optional attachments).

**Filing landing screen:**
- **Overview tabs reworked** — `All` scopes to the **current year** (was a 400-day rolling window),
  `Needs filing` / `Filed` current-year, and a **new `Archived` tab** with a year dropdown for past
  years. Enumeration widened to `[y-3 … y+1]`.
- **Deadline Tracker removed** — the `deadlines` nav + page + `dtk*` code dropped; deadlines now live on
  each category's Filings overview (due dates + Overdue pills). `dtkDate` kept (used by enumeration).
- **"Others" category removed** (nav + `renderOthersScreen`).
- **"Annual Filing" added as a nav *header*** (a sidenav group, like Prepare / File returns — **not** a
  workflow). Under it: **Annual Income Tax (1701 / 1702-RT, by classification)** and **1604-C**
  (`alphalist.html`) open their report pages directly (full-width iframe, `?biz=` passed like Data
  Intake); **1604-E** and **Inventory List** are placeholder panels (no report page exists yet). Also a
  new **Month-end** header + **Quarterly Closing** placeholder item **before** File returns.
  - *(Restructured from a first attempt that made Annual Filing a single step-engine workflow — that
    version crashed the whole app at load; see the hotfix entry below.)*

**Verify:** `npm test` **119 green**, `node --check` clean on all changed JS. Presentation/structure
only — no report-calc changes. Not runtime-tested in live Manager. *Open follow-ups: build the 1604-E +
Inventory List reports; optional overdue notification; drop the now-dead `final` step type.*

### 2026-07-15 — Filing-workflow UX redesign: Compensation 1601-C (third tax type)
Applied the house style to the `compensation` (payroll) workflow, on branch
`feature/filing-workflow-ewt-redesign` (same branch as EWT). **4 steps → 5** (added the missing
remittance JE), and fixed a latent blank-iframe bug.

- **`comp-instructions`** — the old payslip-items reminder promoted to the info-only first step
  (`info: true` + `Start` chip), matching VAT/EWT. Added a "payroll fully entered & posted" line.
- **Tax-status gate kept** — still `requireAllTaxStatus: true` (blocks until no employee is blank);
  added the `Tax Status` chip.
- **Blank-iframe fix** — the tax-status and review steps both used `iframeId: 'payroll'`. Because the
  engine parents an iframe in the step that created it, the second step rendered **blank** (the exact
  hazard the conventions warn about). Split into `payroll-taxstatus` / `payroll-report`; the statuses
  live on the employee records so the review iframe reloads them.
- **NEW `compensation-payment`** — the workflow had no remittance step. Added a JE voucher
  (`paymentFlavor: 'compensation'`) reading `window._c.totalRemittance` (the "Tax still due" line):
  DR Withholding Tax Payable – Compensation, CR bank/cash — the same shape as EWT.
- **Freeze** — added the `File` chip; unchanged otherwise (no downloadable listing to bundle).

**Shared engine refactor (also lifts EWT):** [`app/step-engine.js`](../app/step-engine.js) — the EWT
payment renderer was still the *old* plain style (no voucher header band, no editable Description),
so my EWT redesign had left it inconsistent with VAT. Extracted a **`mountRemittanceVoucherContent`**
helper (the shared shape: clear one Withholding Tax Payable liability against bank/cash, Payment vs
balanced JE) and routed **both EWT and compensation** through it — so both now get the VAT-style
voucher with editable Description. EWT's and compensation's renderers are thin cfg wrappers. *ITR
payment still uses its own older renderer — folded into the income-tax redesign (next).*

- **Verify** — `npm test` **119 green**, `node --check` clean. *Presentation only — no calc changes*
  (1601-C generator untouched; the new payment step only reads the already-computed total and posts a
  standard remittance). *Eyeball after deploy: review step renders (not blank); payment voucher shows
  editable Description + the remittance total; freeze re-opens frozen.*

### 2026-07-15 — Filing-workflow UX redesign: EWT (second tax type)
Applied the VAT house style (recorded in
[`instruction.md`](instruction.md#filing-workflow-ux-conventions-apply-to-every-tax-type)) to the
`expanded` (EWT) workflow. **8 gated steps → 5**, on branch
`feature/filing-workflow-ewt-redesign`.

- **`ewt-instructions`** — now `info: true` (read-only, self-advancing) + a `Start` chip, matching VAT.
- **`ewt-return-review`** — added the `EWT Return` chip. Keeps the `fileFn` split (0619-E monthly /
  1601-EQ quarterly) — EWT legitimately has **both** periods, unlike VAT's quarterly-only.
- **QAP** — merged the old `qap-review` + `qap-tin-check` + `qap-download` into **one `document` step**
  (inline blocking supplier-TIN banner with a "fix" deep-link into the report's Suppliers tab + gated
  download). Unlike SLS/SLP, the QAP DAT is **a single file for the period** (the Annex A Excel always
  covers the full quarter), so a new per-step **`datHint`** overrides the shared "one file per month"
  note instead of stating it wrongly.
- **`ewt-payment`** — added the `Payment` chip; unchanged posting logic (compound-JE voucher layer is
  the shared engine change from PR #32).
- **Freeze** — dropped the standalone `ewt-final` working-paper step; folded the QAP re-download into
  the terminal `file` (freeze) step via `bundle: ['qap']`, exactly as VAT folds SLS/SLP/SAWT. Added the
  `File` chip.
- **Engine (shared)** — [`app/step-engine.js`](../app/step-engine.js) `renderDocumentFooter` now reads
  an optional `step.datHint` (defaults to the SLS/SLP per-month text), so the `document` type serves
  both monthly-per-file (SLS/SLP) and single-file-per-period (QAP) listings.
- **Verify** — `npm test` **119 green**, `node --check` clean on both files. *Presentation only — no
  calc changes* (QAP/0619-E/1601-EQ generators untouched). *Eyeball after deploy: QAP step shows the
  TIN banner + single DAT; monthly period picks 0619-E, quarterly picks 1601-EQ; freeze re-downloads QAP.*

### 2026-07-15 — Filing-workflow UX redesign: VAT (first tax type) — PR #32
Started the tax-by-tax UX redesign of the filing workflows (design conventions now recorded in
[`instruction.md`](instruction.md#filing-workflow-ux-conventions-apply-to-every-tax-type) and
[`ECC-PLAYBOOK.md`](ECC-PLAYBOOK.md)). VAT is the first one done and sets the pattern to copy to
EWT / compensation / income. **Design approved via an interactive mockup before implementation.**
VAT went from **12 gated steps → 8**. Opened as **PR #32** (branch `docs/save-freeze-deploy-notes`).

- **Engine (shared, applies to all workflows)** — [`app/step-engine.js`](../app/step-engine.js) +
  [`taxify.html`](../taxify.html):
  - Left step rail → **top arrow-flow stepper** (chevron `clip-path` segments, numbered, done/active/
    locked), freeing the report panel to full width. Steps prefer a `short:` label in the stepper.
  - New **`document` step type** — merges report review + party-TIN validation (inline **blocking**
    banner with a "fix" link into the report's own tab) + download into one screen.
  - Instruction steps with **`info: true`** render as soft guidance ("Continue →"), not a checklist gate.
  - **Payment step restyled as a compound journal-entry voucher** (header band, DR/CR ledger, balanced
    badge) — logic unchanged. Added an **editable Description** (default `VAT - Q2 2026`) that feeds the
    payment `description` / journal `narration`. Shared `triggerBundleDownloads` helper; working-paper
    bundle folded into the freeze step.
- **VAT workflow** ([`app/workflows.js`](../app/workflows.js)): 2550Q split into **Confirm Tax Codes**
  and **Review 2550Q Return** (distinct `iframeId`s — the engine keeps an iframe in its creating step, so
  a shared id blanks the second; the mapping carries over because `saveMappingOverrides` persists it per
  business). SLS/SLP each collapse review + TIN check + download into one `document` step; "Before you
  start" is info-only.
- **SAWT** ([`reports/sawt-report.js`](../reports/sawt-report.js)): quarterly DAT export now emits **one
  file per month (3 per quarter)**, matching SLS/SLP, via `exportSAWTDatSimple`. Old single-file
  quarterly `exportSAWTDat` kept as a labeled fallback (in case an RDO's eSubmission rejects monthly SAWT).
- **Verified:** `npm test` (119 green) + `node --check`. **Not yet runtime-tested in live Manager** (the
  extension needs Manager's API context; no local dev server) — eyeball after deploy: the split 2550Q
  Return shows mapped figures, and SAWT DAT yields 3 accepted monthly files.

### 2026-07-14 — Save/freeze filings + workflow step-engine rebuild (PRIORITY 2) — MERGED (PR #28)
Reoriented the filing workflows around a first-class **Filing** object (business + workflow +
period) with a `draft → filed → amended` lifecycle, and built point-in-time snapshots on top of it.
Marking a period **Filed** now freezes its figures so later book edits don't rewrite the filed
return. **Merged to `main` as PR #28** — the code auto-deploys via the cron pull, but freeze only
works live once the one-time schema migration is applied on the server (see the deploy step below);
`/security-review` on the new PHP endpoints is still an open pre-live gate.

- **Server (per-tenant, server-only store):** new `report_snapshot` table in `server/schema.sql`
  (append-only versions = amendment history) + two endpoints — [`server/save-report.php`](../server/save-report.php)
  (POST, versioned insert, supersedes prior, `audit_log` row) and
  [`server/report-snapshots.php`](../server/report-snapshots.php) (GET history / batch). Both reuse
  `entitlement.php`'s exact session-auth + business-ownership model via the shared
  [`server/report-store.php`](../server/report-store.php) include (session validation, PDO prepared
  statements, 256 KB body cap, no enumeration oracle).
- **Client model:** [`app/filing-core.js`](../app/filing-core.js) — pure, dual-exported logic
  (period-key encoding shared with the SQL/regex layer, `draft/filed/amended` resolution, live-vs-filed
  variance, form↔workflow map). [`app/filing-store.js`](../app/filing-store.js) — the fetch layer;
  turns a 401 into a typed `FilingAuthError` so a freeze **fails loudly** (explicit "sign in to freeze"
  state) on installs with no session instead of silently dropping the snapshot.
- **Rebuilt step engine** ([`app/step-engine.js`](../app/step-engine.js)): the control model is now
  Filing-scoped (step progress keyed by `biz:workflow:periodKey`). The terminal step is a new **`file`
  (freeze)** step — it reads the headline figure + the report's own `window._period` + a generic
  capture of every manual `input/select/textarea` from the return iframe, and POSTs the snapshot.
  A **filed** filing renders a **frozen read-only view** (snapshot figures, amendment history, Amend
  action) with a **variance** banner that recomputes live and warns *"Filed ₱X, books now ₱Y"*. The
  well-tested step mechanics (review/validate/download/checklist/payment, iframe reuse, period cascade)
  are preserved. Old `final` bundle steps become a mid-flow "working papers" step.
- **App shell** ([`app/taxify-app.js`](../app/taxify-app.js) + [`taxify.html`](../taxify.html)): each
  category now opens a **Filing overview** — period cards showing Draft / Filed / Amended / Overdue +
  the frozen headline — that drills into the engine. The Deadline Tracker reads **real filed status**
  from snapshots (replacing the session-only toggle) and shows a static "✓ Filed" for frozen periods.
- **Manual-input persistence bonus:** the freeze captures the return's manual fields (previously lost
  on reload) into the snapshot.
- **Reports:** added additive `window._c` (1601C) and `window._period` (2550Q, 0619E, 1601EQ, 1601C,
  1701Q, 1702Q) exports so the freeze/variance can read exactly what's on screen — no calc changes.
- **Tests:** [`test/filing-core.test.js`](../test/filing-core.test.js) locks the pure logic. Suite
  **119 green** (was 107). PHP endpoints follow repo convention (no Node unit test) — verified on the
  server, and gated by `/security-review` before merge.
- **Server-only tradeoff (per decision):** freezing requires a signed-in session; drafts work
  everywhere. No-session installs see the explicit sign-in prompt, never a silent loss.
- **Deploy step:** apply the schema migration on the server —
  `sqlite3 /var/www/taxify/server/txform.db < server/schema.sql` (idempotent `CREATE TABLE IF NOT
  EXISTS`). See [`docs/instruction.md`](instruction.md).

### 2026-07-14 — Code restructure: flat root JS → concern folders (PRIORITY 1)
Behavior-preserving reorganization now that the test harness locks the calculations. 35 of the 36 flat
root `*.js` moved via `git mv` into concern-grouped folders — `reports/` (15 `*-report.js`),
`helpers/` (deduction/ewt/payroll/pnl), `shared/` (shared, tax-codes, tax-rates, custom-fields,
chart-of-accounts, entitlement, entitlement-core), `app/` (taxify-app, step-engine, workflows, app,
reports), `batch/`, `admin/`. **`account.js` stays at root** — the owner portal is served on the apex
(`txform.ph/account`) via explicit `nginx-portal-snippet.conf` aliases (`= /account`, `= /account.js`),
not from the repo web root, so moving it to a subfolder would 404 the portal without an nginx change.

- **HTML entry pages stay at root by design.** Each report is an installed Manager.io Custom Button
  pointing at an absolute URL (`https://extension.txform.ph/<form>.html`, [`reports.js`](../app/reports.js)
  `BASE_URL + file`). Moving a form's `.html` changes its URL and 404s that button on every already-installed
  client until reinstall — so only the JS (loaded via relative `<script src>`) moved. Root drops from 61
  files to the HTML/JSON/config entry points.
- Rewrote **173** `<script src>` references across 25 HTML pages; updated the two Node test paths
  (`report-calcs` sandbox list + `entitlement-core` require) and the changelog file links above.
- **Verified:** 107/107 tests green; every `<script src>` resolves to a real file; the 1701 form,
  the `taxify.html` app shell, and a batch-import page each load all scripts `200` with no console
  errors.
- **Follow-up:** `docs/CODEMAPS/frontend.md` still describes the flat layout — regenerate it.
- **Deployed & verified LIVE 2026-07-14.** Merged to `main` → cron pull. On `extension.txform.ph`:
  new subfolder paths serve 200, entry HTML pages still 200 (installed Manager.io buttons unchanged —
  no client reinstall), old flat `*.js` paths now 404, and the live `taxify.html` app shell loads
  every script 200 with no console errors. Codemaps (`frontend.md` + `backend.md`) regenerated.

### 2026-07-14 — Audit complete: ATC consolidation + report-calc test harness
Finished the report correctness audit and locked it with tests.
- **Remaining forms cleared:** SAWT/QAP, alphalist (1604-C annualization — annual tax via graduated
  table on annualized comp, over/under split correct), 2307, and SSS (reports actual payroll
  contributions, no stale table).
- **Bug found & fixed — 1601EQ ATC divergence:** 1601EQ carried its own partial ATC table while
  0619E/2307/QAP used the shared one, so the two disagreed on which ATC codes exist — a consultant fee
  (WI050) hit 1601EQ but not QAP, a medical fee (WI150) hit QAP but not 1601EQ, so the quarterly return
  and its alphalist wouldn't reconcile at filing. **Consolidated every EWT form onto one canonical
  `ATC_MASTER`** in [ewt-helpers.js](../helpers/ewt-helpers.js) — the full BIR ATC list (111 codes, with payee
  type); [tax-codes.js](../shared/tax-codes.js) `EWT_ATC_LIST` is now *derived* from it, and 1601EQ's private
  copy was deleted. Royalties / Sec.109BB stay in their own FWT/PT lists (not creditable EWT).
- **Test harness added** — [test/report-calcs.test.js](../test/report-calcs.test.js) loads the browser
  calc files into a Node `vm` sandbox (no source changes) and asserts the graduated-tax brackets,
  individual OSD (1701/1701Q net = 60% of gross sales), MCIT start (year + 4), ATC rates, and that
  `EWT_ATC_LIST` can't drift from `ATC_MASTER`. Runs under `npm test` — **107 tests green** (was 95).

This closes the "verify every BIR report" Phase 0 item. Next up are the two prioritized initiatives
(restructure, then save/freeze reports).

### 2026-07-14 — Audit: withholding chain cleared + next two initiatives prioritized
Continued the report correctness audit through the withholding forms — **no new bugs found:**
- **1601C (compensation)** — MWE exemptions, cumulative ₱90k 13th-month cap (YTD), and SSS/PHIC/HDMF
  net-of-contribution ordering all correct; reports actual tax withheld (right for a monthly remittance
  return). *Caveat:* separation pay is treated as always non-taxable (only exempt for causes beyond the
  employee's control).
- **EWT / ATC rates** (`ewt-helpers.js`) — every ATC rate matches RR 11-2018 (professional 5/10% indiv,
  10/15% corp; rentals 5%; contractors 2%; govt 1% goods / 2% services; final VAT 5%; royalties 20%).
  The 0%-pass-through gross-up (`base = ewt ÷ rate`) is correct.
- **0619E / 1601EQ** remittance aggregation — correct.
- **1702Q corporate OSD** — 40% of gross income (the OSD bug was individual-only, as expected).
- **SLS / SLP** — reuses the verified `lineAmounts` back-out and tax-code categorization, TIN-grouped;
  ties out to 2550Q. Still to audit (lower-risk listings): SAWT/QAP, alphalist, 2307, SSS.

**Agreed to prioritize two initiatives after the audit** (see [`to-do.md`](to-do.md) "Prioritized next
initiatives"): **(1) report/code restructure** — move the flat root `*-report.js`/`*.html` files into a
clean, concern-grouped layout (behavior-preserving, after a test harness lands); **(2) save/freeze
reports** — persist a report when marked *Filed* so its figures snapshot as of filing and later edits to
that period don't rewrite the filed return (Draft-vs-Filed status, amendment history, variance alert,
per-tenant SQLite storage via a guarded endpoint).

### 2026-07-14 — BIR report correctness audit + two income-tax fixes (Phase 0)
Static/logic audit of the report generators against BIR rules (part of the "verify every BIR report"
Phase 0 item). **Cleared as correct:** `tax-rates-data.json` (all rates + effectivity windows), the
graduated-tax engine (`computeGraduatedTax` — bracket math spot-checked against the BIR table), and
**VAT 2550Q** end-to-end (`lineAmounts` VAT back-out, output/input categorization by tax code, and
the item 37→60→61 netting all faithful to the form). **Two bugs found and fixed** (both rule-confirmed
with the CPA):

- **Individual OSD double-deducted Cost of Sales** ([1701-report.js](../reports/1701-report.js),
  [1701q-report.js](../reports/1701q-report.js)) — net income was `(sales − COGS) − 40%×sales` instead of
  `sales − 40%×sales`. For individuals, OSD is 40% of *gross sales/receipts* with COGS not separately
  deductible (RR 16-2008 §3); the bug **understated** taxable income (and tax) by the full COGS. Fixed
  so OSD net = 60% of gross sales; COGS now shows ₱0 on the return under OSD (matching eBIRForms), with
  real COGS still on the P&L tab. Itemized path unchanged.
- **MCIT started one year too early** ([pnl-helpers.js](../helpers/pnl-helpers.js) `isMcitApplicable`, surfaced
  in [1702rt-report.js](../reports/1702rt-report.js) + [1702q-report.js](../reports/1702q-report.js)) — used
  `taxYear − incYear >= 3`. Per RR 9-98, MCIT begins the **4th taxable year following** commencement
  (its worked example: commenced 1998 → MCIT 2002 = year + 4). Changed to `>= 4`; the exempt-window
  note now reads "+ 4". The bug **overstated** tax in the transition year when MCIT exceeded regular tax.

Also **added a "Tax Due" column** to the Tax-Rates admin income-tax panel
([tax-rates-admin.js](../admin/tax-rates-admin.js)) — shows the BIR-style "₱X + Y% of excess over ₱Z" per
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
  block alone can no longer expose the write. The admin tool ([`tax-rates-admin.js`](../admin/tax-rates-admin.js))
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
