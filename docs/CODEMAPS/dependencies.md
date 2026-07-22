<!-- Generated: 2026-07-13 | Files scanned: package.json + configs | Token estimate: ~550 -->
# Dependencies

Deliberately **zero npm dependencies** — `package.json` has only a test script
(`node --test test/*.js`). Everything uses Node builtins so the git-pull deploy
needs no `npm install` on the server.

## Runtime (Node builtins only)
`node:sqlite` (DatabaseSync — needs Node ≥22.5; server runs **24**) · `node:http` ·
`node:net`/`node:tls` (hand-rolled SMTP) · `node:crypto` · `node:test`.

## External services
| Service | Use | Status |
|---|---|---|
| **Manager Server** (:5000) | books DB; provisioner creates books/users, tabs, chart of accounts, custom button | live |
| **Google Workspace SMTP** (`smtp.gmail.com:465`) | sends magic-link email as `hello@txform.ph` (auth `ejtallo@`, App Password) | **live** |
| ~~Playwright / Chromium~~ | ~~provisioner drove Manager UI~~ — removed; the provisioner now talks plain HTTP to Manager (api4 + admin forms), zero npm deps | n/a |
| **Xendit** | subscriptions + webhooks (₱) | Phase 3, not started |

## Infra
- **nginx + Certbot** on EC2 t3.small (ap-southeast-1). vhosts: `txform.ph` (apex, `/api/*`→:5100), `extension.txform.ph`, `books.txform.ph`, `app.txform.ph`.
  - snippets in repo: `nginx-auth-snippet.conf` (auth/tenancy proxy + `request-link` rate-limit `authlink`), `nginx-entitlement-snippet.conf`, `nginx-tax-rates-snippet.conf`, `nginx-web-root-hardening.conf`.
- **systemd**: `txform-auth.service` (env `/etc/txform/auth.env`), `txform-provisioner.{service,timer}`.
- **Deploy**: root cron every 2 min → `scripts/deploy.sh` ff-only pulls `main` into `/var/www/taxify` (see `DEPLOY.md`).
- **Backups**: AWS Backup EC2 snapshots + S3 Manager.io data backups (see `docs/instruction.md`).

## Secrets (never in repo)
`/etc/txform/auth.env` (SMTP creds) · nginx basic-auth for `save-tax-rates.php`.
