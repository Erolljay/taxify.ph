<!-- Generated: 2026-07-13 | Files scanned: ~60 (repo-root static) | Token estimate: ~800 -->
# Frontend

Vanilla JS, no framework/build. Two static apps served from the box, plus the
marketing site. All user values rendered via `textContent` (no innerHTML).

## Owner portal — `account.html` + `account.js`  (the "portal we made")
Firm-owner console. Talks to the Node auth/tenancy API with `credentials:'include'`.
```
init() → GET /api/auth/me
   ├─ 200 → loadDashboard() → GET /api/tenancy/overview → render()
   └─ else → showSignin()
signin-form  → POST /api/auth/request-link {email}     (magic link)
dashboard-view:
   biz-form   → POST /api/tenancy/add-business
   staff-form → POST /api/tenancy/invite-staff
   matrix     → checkbox grid staff × business → POST /api/tenancy/user-business {grant}
```
Views: `#signin-view`, `#dashboard-view` (`#biz-list`, `#staff-list`, `#matrix`).
**Gap:** `/api/auth/verify` returns JSON — it does NOT yet redirect into `account.html`,
so clicking a magic link downloads `verify.json` instead of landing on this console.
Also account.html sits at repo root (extension host); the `/api/*` proxy is on the
`txform.ph` apex — serving host + proxy host need aligning for the portal to call the API.

## BIR extension — the mature core (Manager.io custom extension)
```
installer.html   "Super Admin" — installs the extension + tax-rates admin tab
taxify.html  →  taxify-app.js  +  step-engine.js  +  workflows.js   (workflow shell)
                shared.js · tax-codes.js · custom-fields.js · chart-of-accounts.js
                entitlement.js (client-side entitlement check → entitlement.php)
reports.js  (report dispatch)
```
### BIR form pages (26; each `<form>.html` + `<form>-report.js`)
0619e · 1601c · 1601eq · 1701 · 1701q · 1702q · 1702rt · 2307 · 2316 · 2550q ·
alphalist · qap · sawt · sls · slp · sss · tax-recon …
Helpers: `deduction-helpers.js` · `ewt-helpers.js` · `payroll-helpers.js` · `pnl-helpers.js`.
Batch import: `batch-import*.html/.js`.

## Marketing — `website/index.html`
Static HTML (replaced the old 563KB JS bundle). Multi-page SEO rebuild = Phase 2 (pending).

## Styling
`styles.css` (shared). Portal has its own inline styles in `account.html`.
