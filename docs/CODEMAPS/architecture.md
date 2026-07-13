<!-- Generated: 2026-07-13 | Files scanned: ~90 | Token estimate: ~700 -->
# Architecture

Static-first BIR extension evolving into a PH multi-tenant SaaS. One EC2 box
(`txform-server`, ap-southeast-1). Manager Server holds the books; a small
SQLite DB (`txform.db`) holds subscribers/tenancy — the only new SaaS state.

## Surfaces (nginx vhosts on one box)
```
txform.ph            static marketing site  (root: website/)  + /api/* → :5100 (Node)
extension.txform.ph  the BIR extension       (root: repo root) — taxify.html, *-report.js, account.html
books.txform.ph      Manager Server UI       (proxy → :5000) — where bookkeeping happens
```

## Components
```
Browser ──HTTPS──> nginx ─┬─ static files (extension + portal + marketing)
                          ├─ /api/auth, /api/tenancy  → Node auth-service.js  :5100
                          ├─ *.php (entitlement, save-tax-rates) → php-fpm
                          └─ books.txform.ph          → Manager Server        :5000

Node auth-service.js ─┐
php entitlement.php  ─┼─> SQLite txform.db  (WAL; server/schema.sql)
Node provisioner.js  ─┘        │
                               └─ provision_job queue ─> Playwright ─> Manager Server (creates/revokes restricted users)
```

## Two login realms (never unified — no SSO in self-hosted Manager)
- **Owner portal** (`account.html`, magic-link): manage firm account, staff, client access.
- **Manager** (`books.txform.ph`, username/password created by the provisioner): actual bookkeeping. Staff use only this.

## Auth + provisioning flow
```
owner requests link → email (hello@txform.ph) → click → /api/auth/verify sets txfsid cookie
owner console (account.html) → invite staff / tick businesses → writes user_business + enqueues provision_job
provisioner (systemd timer) drains queue → Playwright drives Manager → emails Manager creds to staff
```

## Detail maps
[backend.md](backend.md) · [frontend.md](frontend.md) · [data.md](data.md) · [dependencies.md](dependencies.md)
