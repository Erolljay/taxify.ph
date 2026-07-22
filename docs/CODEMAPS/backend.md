<!-- Generated: 2026-07-13 | Files scanned: ~16 (server/ + tests) | Token estimate: ~850 -->
# Backend

Two runtimes behind nginx, one shared SQLite DB. Pure decision logic is split
into tested `*-core` modules; the service files stay thin glue.

## Node auth + tenancy service — `server/auth-service.js` (:5100)
Handlers are pure `(db, input, deps) → {status, json, setCookie?}`; `main()` is
thin HTTP wiring. Rules live in `server/auth-core.js` (token/session/rate-limit/authz).

```
POST /api/auth/request-link   → requestLink   → auth-core.withinRateLimit → deps.sendEmail (smtp-mailer)
GET  /api/auth/verify         → verifyLink    → single-use token → creates session → Set-Cookie txfsid
                                 browser (Accept: text/html): 302 → portal (ok) | portal?error=<code> (fail)
                                 API (Accept: application/json / none): JSON {ok:true} | {error} — unchanged
GET  /api/auth/me             → currentUser   → resolve session → {email,role,account_id}
POST /api/tenancy/user-business → setUserBusiness → owner-only → user_business +/- → enqueue provision_job (grant|revoke)
POST /api/tenancy/invite-staff  → inviteStaff     → owner-only → seat check → users row → enqueue 'create'
POST /api/tenancy/add-business  → addBusiness     → owner-only → biz-limit check → businesses row
GET  /api/tenancy/overview      → overview        → owner-only → {account, me, users, businesses, grants}
```
- Auth: passwordless magic link. Tokens + session secrets stored **hashed only** (`auth-core.hashToken`). Cookie `txfsid`, httpOnly, domain `.txform.ph`.
- Portal landing: `verifyLink` redirects a *browser* to `TXFORM_PORTAL_URL` (`https://txform.ph/account`, defaults to `<base>/account`) with the cookie on the 302; a failed link redirects to `…/account?error=link_expired|link_used|link_invalid`. The `send()` glue grew a `Location`-header branch. Portal page + `/api/*` proxy share the apex origin (nginx `nginx-portal-snippet.conf` + `nginx-auth-snippet.conf`).
- Authz: `authorizeOwnerAction` — session valid → role owner → same account (cross-tenant guard).
- Mailer: `server/smtp-mailer.js` (zero-dep SMTP; CRLF header-injection guard; TLS verify on). Sends via Gmail when `SMTP_HOST` set, else logs link.

## PHP entitlement — `entitlement.php` (web root, php-fpm)
```
GET /entitlement.php?business=<manager_business_guid>
   → reads txfsid session → 200 {status,...} | 401 unauth | 404 not-your-business
```
Owners see all their businesses; staff only those granted via `user_business`. Same session table as the Node service. Authz logic mirrored in tested `shared/entitlement-core.js` / `entitlement-authz` tests.
(`save-tax-rates.php` — writes shared `tax-rates-data.json`; guarded by nginx basic-auth + shared-secret token.)

**Placement note:** session-authed PHP endpoints live at the **web root**, NOT `server/` — the nginx
web-root hardening 404s the whole `/server/` path on `extension.txform.ph`. Root `*.php` is executed
by php-fpm (no source disclosure), so `entitlement.php` / `save-report.php` / `report-snapshots.php` /
`save-tax-rates.php` all sit at the root; only non-executed backend files (`*.js`, `schema.sql`,
`report-store.php` include) stay under `server/`, reached via filesystem `require`.

## PHP filing snapshots — `save-report.php` + `report-snapshots.php` (web root, php-fpm)
```
POST /save-report.php     body {business,workflowKey,periodKey,form?,headline?,payload}
   → freezes a filing: supersede prior 'filed' row, insert version+1, audit_log → 200 {ok,version}
GET  /report-snapshots.php?business=<guid>[&workflow=&period=]
   → one filing's version history (with payload) | batch: latest filed per filing (no payload)
```
Server-only save/freeze store (Priority 2). Both `require server/report-store.php` (shared session
auth + business-ownership, cloned from `entitlement.php`; PDO prepared statements; 256 KB body cap;
401 no-session / 404 cross-account — no enumeration). Rows live in the `report_snapshot` table
(`server/schema.sql`, append-only versions = amendment history). Pure client logic in
tested `app/filing-core.js`. Session cookie must be `Domain=.txform.ph` to cross from the portal.

## Provisioner — `server/provisioner.js` (systemd timer, one `drainOnce`/tick)
```
claimNext (oldest pending, bump attempts) → dispatch(job, driver) → mark done|pending(retry)|failed
job.type (users):    create | reset_password | grant | revoke | disable
job.type (business): create_business | configure_tabs | copy_chart_of_accounts | configure_custom_button
MAX_ATTEMPTS=3   business-scoped jobs throw (→ retry) until create_business stamps manager_created_at
```
Driver interface (injected; real one = `provisioner-driver-http.js`, plain HTTP to Manager api4 + admin
UI — no browser, zero deps):
`createUser · setPassword · grantAccess · revokeAccess · disableUser · createBusiness · configureTabs ·
copyChartOfAccounts · configureCustomButton` (async, may throw).
Manager helpers: `manager-client.js` (auth + api4/form posts, `Manager-Business` header) ·
`manager-vue-form` / `manager-permissions` / `manager-tabs` (scraped Vue forms) ·
`manager-extension` (custom button → `POST /api4/extension`) ·
`manager-coa` (COA copy → bulk `PUT /api4/<x>-batch` from template `0000 Chart of Accounts`, keys preserved).

## systemd units
`txform-auth.service` (Node :5100, EnvironmentFile `/etc/txform/auth.env`) · `txform-provisioner.{service,timer}`.

## Tests (`node --test`, 482 passing + 15 read-only live-Manager contract checks via `npm run contract`)
`auth-core` · `auth-service` (in-mem sqlite) · `smtp-mailer` (mock SMTP) · `entitlement-core` · `entitlement-authz` · `provisioner` (fake driver) · `provisioner-driver-http` / `manager-tabs` / `manager-extension` / `manager-coa` (fake client).
