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
  - [~] **Email sender** — code **DONE** (2026-07-13): zero-dep SMTP client `server/smtp-mailer.js`
        wired into `deps.sendEmail` (`server/auth-service.js`), 12 new tests (87 total passing).
        **Remaining (server-side, one-time):** create `/etc/txform/auth.env` with the
        `hello@txform.ph` SMTP creds and `sudo systemctl restart txform-auth` — steps in
        [`instruction.md`](instruction.md#email--magic-link-sign-in). Until then the service logs the
        link instead of sending (safe fallback). Gate with `/security-review` after deploy.
  - [ ] **Live Playwright selectors** — need the live books.txform.ph admin UI.
- [ ] **Phase 2** — website multi-page/SEO rebuild (static HTML started).
- [ ] **Phase 3** — PayMongo payments (not started; security gate).
- [ ] **Phase 4** — ToS / RA 10173 data-privacy pages (not started).
- [ ] **Phase 5** — beta / launch.
