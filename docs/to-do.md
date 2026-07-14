# Txform.ph — To-Do

Open work, newest concerns first. Part of the ECC tracking triad
(`instruction.md / progress.md / to-do.md`, see
[`docs/ECC-PLAYBOOK.md`](ECC-PLAYBOOK.md)). Phase labels map to the 6-phase SaaS plan.

_Last updated: 2026-07-14_

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
- [ ] **BIR report correctness audit** — *in progress (static/logic pass).* Cleared: rates data,
      graduated-tax engine, VAT 2550Q (lineAmounts back-out + output/input netting all correct).
      **Fixed 2026-07-14:** (1) individual OSD in 1701 + 1701Q double-deducted COGS → understated
      tax (RR 16-2008: OSD = 40% of gross sales, COGS not separately deductible); (2) MCIT start year
      in 1702-RT + 1702-Q was one year early → `>= 4` (RR 9-98: 4th taxable year *following*
      commencement). Also added a "Tax Due" column to the Tax-Rates admin income-tax panel so brackets
      can be checked against the BIR table. **Still to audit:** 1601C, 0619E, 1601EQ, 1702Q OSD base,
      SLS/SLP, SAWT/QAP, alphalist, 2307, SSS.
- [ ] **Report generators have no automated tests** — the `node --test` suite covers only the server
      side. The pure calc functions (`isMcitApplicable`, `netIncomeFor1701`, `computeGraduatedTax`)
      need to be made importable in Node so these fixes can be locked in with unit tests.
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
