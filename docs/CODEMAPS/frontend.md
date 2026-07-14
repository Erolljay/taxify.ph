<!-- Generated: 2026-07-14 | Files scanned: ~60 (concern-grouped after refactor/js-restructure) | Token estimate: ~900 -->
# Frontend

Vanilla JS, no framework/build. Two static apps served from the box, plus the
marketing site. All user values rendered via `textContent` (no innerHTML).

**Layout note (2026-07-14 restructure):** the extension JS was moved out of the flat
repo root into concern folders (`reports/ helpers/ shared/ app/ batch/ admin/`). The
`<form>.html` **entry pages stay at the repo root** — their absolute URLs are the
installed Manager.io Custom Button keys, so they must not move. HTML pages load their
scripts via relative `<script src="<folder>/<file>.js">`.

## Owner portal — `account.html` + `account.js` (repo root, "the portal we made")
Firm-owner console served at **`https://txform.ph/account`** (apex, same origin as the
`/api/*` proxy). Talks to the Node auth/tenancy API with `credentials:'include'`.
```
init() → takeLinkError() (?error=… from a failed magic link) → GET /api/auth/me
   ├─ 200 → loadDashboard() → GET /api/tenancy/overview → render()
   └─ else → showSignin() (+ warn if a link error was present)
signin-form  → POST /api/auth/request-link {email}     (magic link)
dashboard-view:
   biz-form   → POST /api/tenancy/add-business
   staff-form → POST /api/tenancy/invite-staff
   matrix     → checkbox grid staff × business → POST /api/tenancy/user-business {grant}
```
Views: `#signin-view`, `#dashboard-view` (`#biz-list`, `#staff-list`, `#matrix`).
Clicking a magic link lands here: `verifyLink` 302-redirects the browser to `/account`
with the session cookie (success), or to `/account?error=<code>` which `takeLinkError()`
turns into a friendly sign-in warning (bad/expired/used link). Served on the apex via
`nginx-portal-snippet.conf` (explicit `= /account` + `= /account.js` aliases, **not** the
repo web root) — which is why `account.js` stays at the repo root rather than a subfolder.

## BIR extension — the mature core (Manager.io custom extension)
Entry HTML pages at repo root; JS grouped into folders. Load order inside each page is
preserved (only the `src` path prefix changed in the restructure).
```
installer.html          "Super Admin" — installs the extension + tax-rates admin tab
taxify.html  →  app/taxify-app.js + app/step-engine.js + app/workflows.js  (workflow shell)
                shared/shared.js · shared/tax-codes.js · shared/tax-rates.js
                shared/custom-fields.js · shared/chart-of-accounts.js
                shared/entitlement.js + shared/entitlement-core.js
                    (client-side entitlement check → entitlement.php)
app/reports.js          report dispatch (REPORTS[] = one Manager Custom Button each;
                        BASE_URL + <form>.html — the stable installed URLs; id GUIDs frozen)
app/app.js              extension bootstrap
```
### Folder map
```
reports/   15 form generators — one <form>-report.js per BIR form
           0619e 1601c 1601eq 1701 1701q 1702q 1702rt 2307 2316
           alphalist qap sawt sls sss tax-recon
helpers/   deduction-helpers · ewt-helpers · payroll-helpers · pnl-helpers
shared/    shared · tax-codes · tax-rates · custom-fields · chart-of-accounts
           · entitlement · entitlement-core   (loaded by nearly every page)
app/       taxify-app · step-engine · workflows · app · reports  (shell + dispatch)
batch/     batch-import · batch-import-collect  (Excel/CSV import; loads xlsx/exceljs from CDN)
admin/     tax-rates-admin · ewt-taxcodes-tab   (tax-rates admin tab)
```
### BIR form + data pages (repo root)
Each `<form>.html` loads its `reports/<form>-report.js` plus the shared/helper scripts it
needs. VAT uses `2550q.html`; SLS/SLP are `sls.html`/`slp.html`. Batch import is
`batch-import-*.html` (sales/purchase/payroll/receivables/payables) → `batch/batch-import*.js`.
The report calc functions are locked by `test/report-calcs.test.js` (Node `vm` sandbox that
loads the browser files by their new paths).

## Marketing — `website/`
Static multi-page SEO site (**Phase 2, deployed & live 2026-07-14**). Home +
features/security/about/contact/faq/terms/privacy, `assets/css/site.css`, favicons,
`robots.txt`/`sitemap.xml`, per-page meta + JSON-LD. Old 563 KB JS bundle kept as
`website/index.legacy.html`.

## Styling
`styles.css` (shared, repo root) for the extension pages. The portal has its own inline
styles in `account.html`; the marketing site uses `website/assets/css/site.css`.
