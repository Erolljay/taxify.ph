# Txform.ph — Operations Instructions

Living runbook for operating the live infrastructure. Part of the ECC tracking
triad (`instruction.md / progress.md / to-do.md`, see
[`docs/ECC-PLAYBOOK.md`](ECC-PLAYBOOK.md)). Keep current from real changes, not
hand-waved.

_Last updated: 2026-07-13_

---

## Server

- **EC2:** `txform-server` (`i-09bbc637afe847bde`), t3.small, Ubuntu, region
  `ap-southeast-1` (Singapore). Account `erolljay-txform` (521605043764).
- **Clock is UTC.** Manila = UTC+8, so any 2 AM Manila schedule is `18:00 UTC`.
- **Manager.io** runs as `/home/ubuntu/ManagerServer` (not Docker). Live business
  data: `/home/ubuntu/Documents/Manager.io/` (`Businesses/` + `Trash/`).

---

## Backups

Two independent systems, both at **2 AM Manila (18:00 UTC)** with **7 / 56 / 400-day**
retention (daily / weekly / monthly).

### 1. AWS Backup — full-server snapshots
Restores the entire instance if the machine is lost.

- Vault: `txform-backup-vault`
- Plan: `txform-daily-weekly-monthly` — Daily `cron(0 18 * * ? *)` (7d), Weekly
  `cron(0 18 ? * SAT *)` (56d), Monthly `cron(0 18 L * ? *)` (400d).
- Resource assignment `all-ec2-instances` (all EC2, Default service role).

### 2. S3 data backup — portable Manager.io data
Downloadable `.tar.gz` of just the businesses. Runs on the server.

- Script: `/home/ubuntu/backup-managerio.sh` — tars `/home/ubuntu/Documents/Manager.io`,
  picks `monthly/` (1st) → `weekly/` (Sun) → `daily/` folder, uploads, keeps the
  local file only if the upload fails, logs to `/home/ubuntu/backup.log`.
- Cron (ubuntu user): `0 18 * * * /home/ubuntu/backup-managerio.sh 2>> /home/ubuntu/backup-errors.log`
- Bucket: `txform-managerio-backups` (own account; all public access blocked;
  lifecycle expiry `daily/`→7d, `weekly/`→56d, `monthly/`→400d).
- Auth: instance IAM role `txform-server-backup-role` → policy
  `txform-s3-backup-write` (`s3:PutObject` on the bucket only — no keys stored).

### How to check it's working
- **Data backups:** S3 console → `txform-managerio-backups` → `daily/weekly/monthly`
  fill daily. On the server: `cat /home/ubuntu/backup.log` (OK lines);
  `cat /home/ubuntu/backup-errors.log` (empty = healthy).
- **Snapshots:** AWS Backup → **Jobs** → "Completed" each morning.

### How to restore (when needed)
- **A business:** download the `.tar.gz` from S3, unzip, drop the `Manager.io`
  folder back into `/home/ubuntu/Documents/`, restart ManagerServer.
- **Whole server:** AWS Backup → recovery points → restore the instance/volume.

> Note: the server's role is **write-only** by design — it cannot list or delete
> bucket objects. Verify/restore from the console, not from the server CLI.

---

## Auth service (`txform-auth`) — first-time bring-up

The passwordless portal auth/tenancy service is a Node process on
`127.0.0.1:5100` (`server/auth-service.js`, unit `server/txform-auth.service`),
sharing the SQLite DB `/var/www/taxify/server/txform.db` with `entitlement.php`.
Both run as **`www-data`**. Recipe to stand it up on a fresh box (done 2026-07-13):

1. **System-wide Node** (the service can't use nvm-Node in `/home`):
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
   sudo apt-get install -y nodejs   # → /usr/bin/node
   ```
2. **DB folder writable by `www-data`** (deploy pulls as root, so root keeps
   ownership; `www-data` writes `txform.db` via group):
   ```bash
   sudo chgrp www-data /var/www/taxify/server && sudo chmod 775 /var/www/taxify/server
   ```
3. **Install + enable the unit:**
   ```bash
   sudo cp /var/www/taxify/server/txform-auth.service /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now txform-auth
   sudo systemctl status txform-auth --no-pager   # want: active (running), "[auth] listening on 5100"
   ```
4. **nginx → service routing.** In the `txform.ph` (apex) 443 `server { }` block of
   `/etc/nginx/sites-available/managerserver`, add:
   `include /var/www/taxify/nginx-auth-snippet.conf;` (proxies `/api/auth/` +
   `/api/tenancy/` to `:5100`, throttles `request-link`). That snippet needs a
   rate-limit zone in `http{}`:
   ```bash
   echo 'limit_req_zone $binary_remote_addr zone=authlink:10m rate=1r/s;' \
     | sudo tee /etc/nginx/conf.d/txform-ratelimit.conf >/dev/null
   sudo nginx -t && sudo systemctl restart nginx    # RESTART — a reload may not apply new locations
   ```
   Smoke test: `curl -s -o /dev/null -w "%{http_code}\n" https://txform.ph/api/auth/verify?token=bogus` → **400**.

> **Gotchas hit the first time:** unit path `/usr/bin/node` was missing (nvm-only Node) →
> `203/EXEC`; `www-data` couldn't write the DB in a root-owned folder; and `nginx reload`
> silently didn't apply the new `location` — a full `restart` was required.

---

## Owner portal — serve `/account` + magic-link landing

The magic link in the sign-in email now drops the firm owner straight onto the
owner portal (`https://txform.ph/account`) instead of downloading a `verify.json`
file. Two one-time server steps make that live (the code ships via the normal
git-pull auto-deploy; these apply it):

### Step 1 — Restart the auth service (picks up the new redirect code + `TXFORM_PORTAL_URL`)
```bash
sudo systemctl daemon-reload
sudo systemctl restart txform-auth
sudo systemctl status txform-auth --no-pager   # want: active (running)
```

### Step 2 — Serve the portal on the apex, same origin as `/api/*`
In the **`txform.ph` (apex) 443 `server { }` block** of
`/etc/nginx/sites-available/managerserver` — the *same* block that already has
`include /var/www/taxify/nginx-auth-snippet.conf;` — add one more line right
next to it:
```nginx
    include /var/www/taxify/nginx-portal-snippet.conf;
```
Then test and **restart** (a reload may not apply new `location` blocks):
```bash
sudo nginx -t && sudo systemctl restart nginx
```

### How to check it's working
```bash
# portal page loads on the apex (200, HTML):
curl -s -o /dev/null -w "%{http_code}\n" https://txform.ph/account          # → 200
# a bad link bounces a browser back to sign-in with an error flag (302 + Location):
curl -s -o /dev/null -D - -H 'Accept: text/html' \
  "https://txform.ph/api/auth/verify?token=bogus" | grep -i '^location'     # → Location: https://txform.ph/account?error=link_invalid
# API clients still get JSON (unchanged):
curl -s -H 'Accept: application/json' \
  "https://txform.ph/api/auth/verify?token=bogus"                           # → {"error":"link missing"}
```
Then do the real thing: request a link from `https://txform.ph/account`, open the
email, click it — you should land signed-in on the portal (no file download).

> Gotcha (same as the auth route): nginx **`restart`**, not `reload` — a reload can
> silently skip the new `location` blocks.

---

## Email — magic-link sign-in

The auth service (`server/auth-service.js`, systemd unit `txform-auth`) emails
each portal sign-in link. Sending is zero-dependency (built-in SMTP client in
[`server/smtp-mailer.js`](../server/smtp-mailer.js)) — nothing to `npm install`.

**If SMTP is not configured, the service still runs** but only *logs* the link
instead of emailing it (safe fallback for local/dev). Real sending switches on
the moment `/etc/txform/auth.env` supplies `SMTP_HOST`.

Mailbox setup: **Google Workspace**. `hello@txform.ph` is a **Google Group**
(distribution list), *not* a user — a group has no login and can't authenticate
to SMTP. So we **authenticate as a real Workspace user** and send *as*
`hello@txform.ph` via a verified "Send mail as" alias. Send host is
`smtp.gmail.com` (**not** the `smtp.google.com` MX — that only *receives* mail).

Authenticating user: **`ejtallo@txform.ph`** (a real `@txform.ph` mailbox, which
keeps DKIM cleanest). Any other licensed mailbox in this Workspace would also work.

### Step 1 — Make `ejtallo@txform.ph` able to send as `hello@txform.ph`
1. Add `ejtallo@txform.ph` as a **member** of the `hello@txform.ph` group (Admin
   console → Directory → Groups → hello → Members). *Needed so it can receive the
   verification code in the next step.*
2. Sign in as `ejtallo@txform.ph` → Gmail → ⚙ **Settings → Accounts → "Send mail as"
   → Add another email address**. Enter `Txform.ph` / `hello@txform.ph`, keep
   "Treat as an alias" checked, Next → **Send verification**. Open the code that
   lands in the `hello@` group and confirm.

### Step 2 — Get a Google App Password (one time)
Google won't accept a login password over SMTP. Signed in as `ejtallo@txform.ph`:
1. Turn on **2-Step Verification**: Google Account → Security (App Passwords don't
   appear until this is on).
2. Go to **https://myaccount.google.com/apppasswords**, name it `txform-auth`,
   **Create**, copy the **16-character** password (spaces don't matter).
   - If that page is blocked, the Workspace admin must allow App Passwords:
     Admin console → Security → Access and data control.

### Step 3 — Create the secrets file on the server
Root-owned, not world-readable (`SMTP_USER` = the real user; `SMTP_FROM` = the
verified `hello@` alias):
```bash
sudo mkdir -p /etc/txform
sudo tee /etc/txform/auth.env >/dev/null <<'EOF'
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=ejtallo@txform.ph
SMTP_PASS=<paste the 16-char App Password, no spaces>
SMTP_FROM=Txform.ph <hello@txform.ph>
SMTP_EHLO=txform.ph
EOF
sudo chmod 600 /etc/txform/auth.env
```
- Port **465** + `SMTP_SECURE=true` (implicit TLS) is simplest with Gmail. Google
  also supports **587**; to switch, set `SMTP_PORT=587` and `SMTP_SECURE=false`.
- If `hello@` isn't verified as a send-as alias, Gmail silently **rewrites** the
  `From` to `ejtallo@txform.ph` — if recipients see the wrong From, Step 1.2 didn't take.

### Step 4 — Reload + restart the service
```bash
sudo systemctl daemon-reload
sudo systemctl restart txform-auth
```

### How to check it's working
- `sudo journalctl -u txform-auth -n 50` — a real send logs nothing; a failure
  logs `[mailer] send to <addr> failed: <reason>`. Seeing `[auth] would email …`
  means SMTP isn't configured yet (still in log-only mode).
- Request a sign-in link for a known address and confirm the email arrives, with
  the `From` showing `hello@txform.ph`. The sent copy lands in **`ejtallo@`'s Sent**
  (a group has no Sent folder), not in the `hello@` group.

> Secrets live **only** in `/etc/txform/auth.env` (chmod 600) — never in the repo.
> The systemd unit loads it via `EnvironmentFile=-/etc/txform/auth.env` (the `-`
> makes it optional, so a missing file degrades to log-only rather than crashing).

---

## Caveats / notes
- The `esmeres-managerio-backups` bucket + script your partner shared were only a
  **sample** — the live setup is the `txform-managerio-backups` one above. Don't
  re-point backups at `esmeres`.
- Backup is a live file-level tar of SQLite `.manager` files; running at 2 AM
  (idle) keeps it consistent. The script tolerates benign tar "file changed"
  warnings.
- Not yet done (optional hardening): immutability (AWS Backup **Vault Lock**, S3
  **Object Lock**) and a **failure email alert**. See [`docs/to-do.md`](to-do.md).
