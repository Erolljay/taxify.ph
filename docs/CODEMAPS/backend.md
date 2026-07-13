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
GET  /api/auth/me             → currentUser   → resolve session → {email,role,account_id}
POST /api/tenancy/user-business → setUserBusiness → owner-only → user_business +/- → enqueue provision_job (grant|revoke)
POST /api/tenancy/invite-staff  → inviteStaff     → owner-only → seat check → users row → enqueue 'create'
POST /api/tenancy/add-business  → addBusiness     → owner-only → biz-limit check → businesses row
GET  /api/tenancy/overview      → overview        → owner-only → {account, me, users, businesses, grants}
```
- Auth: passwordless magic link. Tokens + session secrets stored **hashed only** (`auth-core.hashToken`). Cookie `txfsid`, httpOnly, domain `.txform.ph`.
- Authz: `authorizeOwnerAction` — session valid → role owner → same account (cross-tenant guard).
- Mailer: `server/smtp-mailer.js` (zero-dep SMTP; CRLF header-injection guard; TLS verify on). Sends via Gmail when `SMTP_HOST` set, else logs link.

## PHP entitlement — `server/entitlement.php` (php-fpm)
```
GET /server/entitlement.php?business=<manager_business_guid>
   → reads txfsid session → 200 {status,...} | 401 unauth | 404 not-your-business
```
Owners see all their businesses; staff only those granted via `user_business`. Same session table as the Node service. Authz logic mirrored in tested `entitlement-core.js` / `entitlement-authz` tests.
(`server/save-tax-rates.php` — writes shared `tax-rates-data.json`; guarded by nginx basic-auth. Flagged for a security pass in to-do.md.)

## Provisioner — `server/provisioner.js` (systemd timer, one `drainOnce`/tick)
```
claimNext (oldest pending, bump attempts) → dispatch(job, driver) → mark done|pending(retry)|failed
job.type: create | grant | revoke | disable   MAX_ATTEMPTS=3
```
Driver interface (injected; real one = `provisioner-driver-playwright.js`, headless Chromium → Manager):
`createUser · grantAccess · revokeAccess · disableUser` (async, may throw, may return {screenshot}).

## systemd units
`txform-auth.service` (Node :5100, EnvironmentFile `/etc/txform/auth.env`) · `txform-provisioner.{service,timer}`.

## Tests (`node --test`, 87 passing)
`auth-core` · `auth-service` (in-mem sqlite) · `smtp-mailer` (mock SMTP) · `entitlement-core` · `entitlement-authz` · `provisioner` (fake driver).
