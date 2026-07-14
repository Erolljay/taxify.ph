<!-- Generated: 2026-07-13 | Files scanned: ~60 (repo-root static) | Token estimate: ~800 -->
# Frontend

Vanilla JS, no framework/build. Two static apps served from the box, plus the
marketing site. All user values rendered via `textContent` (no innerHTML).

## Owner portal — `account.html` + `account.js`  (the "portal we made")
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
Clicking a magic link now lands here: `verifyLink` 302-redirects the browser to
`/account` with the session cookie (success), or to `/account?error=<code>` which
`takeLinkError()` turns into a friendly sign-in warning (bad/expired/used link).
Served on the apex via `nginx-portal-snippet.conf` so its cookie'd `/api/*` calls resolve.

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
