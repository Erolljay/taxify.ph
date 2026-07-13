# Txform.ph — To-Do

Open work, newest concerns first. Part of the ECC tracking triad
(`instruction.md / progress.md / to-do.md`, see
[`docs/ECC-PLAYBOOK.md`](ECC-PLAYBOOK.md)). Phase labels map to the 6-phase SaaS plan.

_Last updated: 2026-07-13_

## Phase 0 — Foundation hardening

- [x] **EBS/S3 backups** — AWS Backup snapshots + S3 Manager.io data backups, 2 AM
      Manila, 7/56/400-day retention. *(Done 2026-07-13 — see [`instruction.md`](instruction.md).)*
- [ ] **UFW** firewall rules on `txform-server`.
- [ ] **fail2ban** for SSH brute-force protection.
- [ ] **UptimeRobot** (or similar) uptime/downtime alerting.
- [ ] **`save-tax-rates.php` security pass** — it trusts anything that reaches it
      and relies entirely on the nginx basic-auth block. Highest-risk existing line.
- [ ] Verify every BIR report end-to-end on a real business (**e2e-runner**).

### Backup hardening (optional, not urgent)
- [ ] **Immutability** — AWS Backup **Vault Lock** + S3 **Object Lock** (audit-grade,
      makes backups un-deletable for a set period).
- [ ] **Failure alert** — email/SNS if a 2 AM backup fails or `backup-errors.log` grows.
- [ ] Confirm with partner that the live setup is `txform-managerio-backups` (not the
      `esmeres` sample) so nobody re-points it.
- [ ] Delete the stray `test/backuptest.txt` left in the bucket from the permission test.

## Later phases (from the plan)
- [ ] **Phase 1** — tenancy/entitlement (75 tests passing; gate with `/security-review`):
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
  - [ ] **Live Playwright selectors** — need the live books.txform.ph admin UI.
- [x] **Phase 2** — website multi-page/SEO rebuild. **DONE (undeployed) 2026-07-13.** Old 564 KB
      JS bundle → static multi-page site (`website/`): home + features/security/about/contact/faq/
      terms/privacy, `assets/css/site.css` design system, real favicons, `robots.txt`/`sitemap.xml`,
      per-page meta + JSON-LD. Old bundle kept as `index.legacy.html`. Follow-ups before deploy:
  - [ ] Fill bracketed placeholders in `terms.html`, `privacy.html`, `about.html` (firm name,
        address, DPO, governing-law city) + **counsel review** of the legal pages.
  - [ ] Build the `/portal` sign-in page (the "Sign in" link 404s until it exists — ties to the
        Phase 1 "pretty portal page" item).
  - [ ] Wire an `/api/early-access` handler (form currently falls back to `mailto:hello@txform.ph`).
  - [ ] (Optional) Self-host the web fonts instead of Google Fonts, per ECC web perf/privacy rules.
  - [ ] Deploy: commit to `main` → 2-min cron pull, confirm `nginx` serves the new `website/` root.
- [ ] **Phase 3** — PayMongo payments (not started; security gate).
- [ ] **Phase 4** — ToS / RA 10173 data-privacy pages (not started).
- [ ] **Phase 5** — beta / launch.
