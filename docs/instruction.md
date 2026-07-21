# Txform.ph — Operations Instructions

Living runbook for operating the live infrastructure. Part of the ECC tracking
triad (`instruction.md / progress.md / to-do.md`, see
[`docs/ECC-PLAYBOOK.md`](ECC-PLAYBOOK.md)). Keep current from real changes, not
hand-waved.

_Last updated: 2026-07-21_

---

## Filing-workflow UX conventions (apply to every tax type)

The house style for the filing workflows (the step engine in
[`app/workflows.js`](../app/workflows.js) + [`app/step-engine.js`](../app/step-engine.js)).
Established with **VAT** (PR #32, 2026-07-15); **copy this pattern when redesigning EWT,
compensation, and income tax** so all tax types feel the same. The goal is fewer clicks and
one clear navigation model.

**Navigation & step shape**
- **Top arrow-flow stepper**, never a left rail — it frees the report panel to full width.
  Give each step a `short:` label for the chip (the full `label:` is the panel heading).
- **One step per concern.** *Merge* passive work (review a report + download its file);
  *separate* anything that carries a real decision.
- **First step = `info: true` instruction** (the "open Reports → Tax Audit, confirm no
  transaction is missing a Tax Code" reminder). Read-only guidance, not a gate.

**Which tabs become their own step**
- A report tab that **changes the numbers** (e.g. the 2550Q Tax Codes mapping) → its **own
  step, placed before the return**, so the figures you review are trustworthy.
- Split such tabs into steps with **distinct `iframeId`s** — the engine keeps an iframe in the
  step that *created* it, so two steps sharing one id leaves the second blank. State carries
  over via the report's own persistence (e.g. `saveMappingOverrides` saves the VAT mapping per
  business), not via a shared iframe.

**The `document` step type (review + validate + download in one)**
- Use for each downloadable listing (SLS, SLP, SAWT, QAP). It embeds the report, runs the
  party-TIN check as an **inline blocking banner** (BIR rejects DAT files with missing TINs)
  with a "fix" link into the report's own Customers/Suppliers tab, and gates Continue on a
  passing check **and** a confirmed download.
- Optional attachments (e.g. SAWT for VAT) → `optional: true` + `skippable` with a clear skip label.
- **DAT cadence note:** the footer defaults to the SLSP "one DAT per month (3 files)" line. For a
  listing whose DAT is a **single file per period** (e.g. the **QAP** — its Annex A Excel always spans
  the full quarter), set a per-step **`datHint`** string to override that text so it isn't stated
  wrongly. (Added with EWT, 2026-07-15.)

**Payment step = compound journal-entry voucher**
- Header band (kind badge · date · pay-from · **editable Description**) over a DR/CR ledger with
  a balanced badge. The Description defaults to `"<TAX> - <period>"` (e.g. `VAT - Q2 2026`) and
  feeds the Manager payment `description` / journal `narration`. Keep the pre-filled clearing
  lines and posting logic as-is — this is a visual layer over the existing recalc/post code.
- **Simple remittances share one helper.** A withholding remittance (EWT, 1601-C) is always "clear
  one Withholding Tax Payable liability against bank/cash" — EWT and compensation both route through
  `mountRemittanceVoucherContent(cfg)` in `step-engine.js` (cfg = window var/field + wording). Reuse
  it for any new single-liability remittance instead of copying a renderer. VAT keeps its own bespoke
  renderer (multi-row output/input/CWT clearing + summary strip); ITR is still to be folded in with
  the income-tax redesign.

**Terminal step**
- The `file` (freeze) step is the last action. Fold the working-paper re-download into it via
  `bundle:` instead of a separate "download working paper" step.

**DAT downloads (compliance)**
- SLSP-family listings are filed **per month**, so a **quarter downloads one DAT file per month
  (3 files)**, not one file spanning the quarter. SLS/SLP already did this; SAWT was aligned to it
  in PR #32. (If an RDO's eSubmission ever rejects monthly SAWT, `exportSAWTDat` is the retained
  single-file fallback.)

**Guardrails when editing the engine**
- Preserve the step engine's contracts: the ids/classes the recalc/post/freeze code reads
  (`#tfy-je-*`, `.tfy-je-*`, `window._v/_e/_itr`, `window._period`), lazy iframe mounting, and the
  period cascade. Presentation changes only — no calc changes.
- **Verify:** `npm test` + `node --check`, then **eyeball in live Manager** (there's no local dev
  server — `taxify.html` needs Manager's API context to render with data).

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

## Save/freeze filings — apply the snapshot schema (one time)

The save/freeze feature stores frozen filing snapshots in the existing subscriber
DB (`server/txform.db`). The endpoints live at the **web root** — `save-report.php`
and `report-snapshots.php` (next to `save-tax-rates.php`), NOT under `server/`,
because the nginx web-root hardening 404s the whole `/server/` path on
`extension.txform.ph`. They ship via the normal git-pull auto-deploy. Two manual
steps make freezing work live:

**1. Create the snapshot table.** The dev box / server may not have the `sqlite3`
CLI (`sudo apt install -y sqlite3`). Run the migration **as `www-data`** so the DB
+ any WAL files keep the ownership the app writes with. It's idempotent
(`CREATE TABLE IF NOT EXISTS`), safe to re-run:

```bash
sudo apt install -y sqlite3   # if 'sqlite3: command not found'
sudo -u www-data sqlite3 /var/www/taxify/server/txform.db < /var/www/taxify/server/schema.sql
```

**2. Scope the session cookie across subdomains.** The portal sets `txfsid` on
`txform.ph`; the endpoints read it on `extension.txform.ph`. For the cookie to
cross, the auth service must set `TXFORM_COOKIE_DOMAIN=.txform.ph` in
`/etc/txform/auth.env`, then restart:

```bash
grep TXFORM_COOKIE_DOMAIN /etc/txform/auth.env || echo 'TXFORM_COOKIE_DOMAIN=.txform.ph' | sudo tee -a /etc/txform/auth.env
sudo systemctl restart txform-auth
```

Without this, freezing 401s and the extension shows the explicit "sign in to
freeze" prompt (drafts still work) — never a silent loss.

**3. Route the endpoints to php-fpm (nginx).** The extension server block only
wires `save-tax-rates.php` to php-fpm via an exact-match `location`; there is NO
general `.php` handler, so any other root `*.php` is served as a RAW STATIC FILE
(GET → 200 with the source, POST → 405) instead of executing. Add the repo snippet
that wires the three session-authed endpoints, then reload:

```bash
# after the code has deployed (git pull), add ONE include line to the
# extension.txform.ph server block, below `location = /save-tax-rates.php`:
#     include /var/www/taxify/nginx-php-endpoints.conf;
sudo nano /etc/nginx/sites-available/managerserver
sudo nginx -t && sudo systemctl reload nginx
```

The snippet (`nginx-php-endpoints.conf`) uses the same `php8.5-fpm.sock` as
`save-tax-rates.php` — bump the socket there if PHP is upgraded.

**4. PHP needs the SQLite driver.** These endpoints (and `entitlement.php`) open
`txform.db` via `PDO('sqlite:…')`. The base php-fpm install does NOT include SQLite
(only `save-tax-rates.php`, which uses plain file I/O, ran before), so without it
every request 500s with `{"error":"Subscriber database not initialized"}`:

```bash
ls /etc/php/8.5/fpm/conf.d/*sqlite* >/dev/null 2>&1 || sudo apt install -y php8.5-sqlite3
sudo systemctl restart php8.5-fpm
```

### How to check it's working

```bash
# the table exists:
sudo -u www-data sqlite3 /var/www/taxify/server/txform.db '.tables' | grep report_snapshot
# root PHP executes (GET a POST-only endpoint → 405, i.e. reached PHP, not 404):
curl -s -o /dev/null -w '%{http_code}\n' https://extension.txform.ph/save-report.php
# → 405
# an unauthenticated POST is rejected (401), not a silent write:
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://extension.txform.ph/save-report.php \
  -H 'Content-Type: application/json' \
  --data '{"business":"x","workflowKey":"vat","periodKey":"quarterly:2026:1","payload":{}}'
# → 401
```

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

## Deploy watchdog (`deploy-watch.js`) — install

Notices that deploys have quietly stopped and emails about it. See the trap it
exists for in [`DEPLOY.md`](../DEPLOY.md).

It alerts on two conditions, both of which mean *nothing you merge is reaching
the site*:

| Condition | Meaning |
|---|---|
| **dirty** | tracked files edited on the server — the next fast-forward will abort |
| **stale** | HEAD behind `origin/main` for over 10 minutes — it is failing every tick |

One alert per distinct problem, then at most hourly while it persists, and a
single all-clear when it lifts. Decision logic is pure and unit-tested in
`server/deploy-health.js`; `deploy-watch.js` only runs git, reads/writes a
state file, and sends mail.

### Install

1. **Where to send.** Add to `/etc/txform/provisioner.env` (or its own env
   file), alongside the SMTP settings the mailer already uses:

   ```
   DEPLOY_ALERT_TO=erolljay@tallocpa.com
   ```

   **Put it in `/etc/txform/auth.env`, not `provisioner.env`** — that is where
   the `SMTP_*` settings live, and the watcher reads exactly the variables the
   auth service'''s mailer reads (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
   `SMTP_PASS`, `SMTP_FROM`, `SMTP_SECURE`, `SMTP_EHLO`). An alerting path
   configured differently from the path known to deliver is a path nobody has
   tested.

   Without it the watcher still runs and logs, but shouts
   `WOULD ALERT but DEPLOY_ALERT_TO is unset` rather than pretending to
   monitor. **A watchdog that cannot bark is worse than none, because it is
   believed.**

2. **State directory** (remembers what it last said, so it doesn't repeat):

   ```bash
   sudo mkdir -p /var/lib/txform
   ```

3. **systemd timer — NOT cron:**

   ```bash
   sudo cp server/txform-deploy-watch.{service,timer} /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now txform-deploy-watch.timer
   ```

   **Why not cron:** `auth.env` is a systemd *EnvironmentFile*, not a shell
   script. It contains `SMTP_FROM=Txform.ph <hello@txform.ph>`, and sourcing
   that from bash reads the `<` as a redirect — the source aborts on that line
   and every variable after it, including `DEPLOY_ALERT_TO`, is silently
   unset. A cron install therefore ran, logged, and sent nothing. systemd
   parses the file correctly.

4. **Check it:**

   ```bash
   systemctl list-timers txform-deploy-watch.timer
   sudo journalctl -u txform-deploy-watch.service -n 5 --no-pager -o cat
   # [deploy-watch] healthy head=24d77ae origin=24d77ae dirty=0
   ```

   A **failed** unit means the watchdog itself is blind (it could not reach
   origin) — deliberately non-zero, so it shows up in `systemctl --failed`
   rather than looking healthy while seeing nothing.

### Testing it without waiting for a real outage

Copy the repo, dirty a file, and point the watcher at the copy — never at
`/var/www/taxify`:

```bash
sudo cp -r /var/www/taxify /tmp/dwrepo
echo '// test' | sudo tee -a /tmp/dwrepo/account.js
sudo TXFORM_REPO=/tmp/dwrepo DEPLOY_WATCH_STATE=/tmp/s.json node server/deploy-watch.js
sudo rm -rf /tmp/dwrepo /tmp/s.json
```

---

## Provisioner — credentials, and the check to run after every Manager update

The provisioner reconciles the portal's access grid into Manager: it creates a
client's books, turns on the firm's tabs, creates restricted users, and grants
or revokes their access. It talks to Manager over **plain HTTP — no browser, no
npm dependencies**.

### Access is TWO things, not one

This cost a real bug. Granting a staff member access requires both:

| | Where | Decides |
|---|---|---|
| 1 | `Businesses` multi-select on `/user-form` | **which** books they can open |
| 2 | **User Permissions** record inside each business (Settings → User Permissions) | **what** they can do once inside |

A freshly created business has **no** permission record — Manager does not make
one when you link a user. Do only step 1 and the staff member signs in, sees the
client, opens the books, and cannot work in them. `grantAccess` now does both and
verifies both, but if you ever do it by hand, do both.

### Credentials

Both live in `/etc/txform/provisioner.env`, root-owned and `chmod 600`:

```
MANAGER_API_KEY=<api2 access token — currently unused, kept for later>
MANAGER_ADMIN_USER=provisioner
MANAGER_ADMIN_PASS=<long random; generate with: openssl rand -base64 32>
```

`provisioner` is a **dedicated Manager Administrator**, deliberately not a
personal login. Manager's own audit trail then attributes the robot's changes to
it rather than to you, it can be disabled without locking you out, and you stay
free to put MFA on your own account — which a robot could never satisfy.

### The check to run after every Manager update

Manager updates often, and the parts the provisioner leans on — the login form
and the user form — are **not a published API with a stability promise**. When
an upgrade moves one of them, the symptom is not an error: access changes simply
stop being applied, while the portal keeps showing green ticks.

This turns that into a failing test. It is **read-only** and creates nothing:

```
cd /var/www/taxify
sudo -E env $(sudo cat /etc/txform/provisioner.env | xargs) npm run contract
```

Thirteen checks, about a second. It asserts the things that would otherwise
break silently.

**Sign-in and the user form:**

- the two-step login still issues a session
- the session still reaches `/api4/businesses` and `/users`
- `/user-form` still carries `Name`, `EmailAddress`, `Username`, `Password`,
  `Type`, `Businesses`
- `Type` still offers `Restricted` — if that option were renamed, new users
  would fall back to whatever Manager defaults to, which is **Administrator**
- `Businesses` option values are still `base64(name)` — the entire grant/revoke
  mechanism is that encoding
- `POST /api4/business` still takes a name
- an expired session is recovered automatically, so the timer-driven provisioner
  does not need restarting when Manager expires it

**The business-scoped screens** (User Permissions and Tabs — the driver reaches
these by following Manager's own links, so a missing link is a real failure mode):

- the Settings sidebar still carries **both** links the driver follows
- the Tabs form still names **every one of the nine tabs** the firm turns on, and
  each is still a boolean
- Manager still hides child tabs behind their parents the way `PARENTS` in
  `manager-tabs.js` assumes — otherwise ticking a child saves a setting that
  never appears in the sidebar
- the User Permissions list still offers **New User Permissions**, without which
  a user who has no record could never be granted one
- **`Access type` still offers Full access as `1`** — the label is what a human
  reads, `1` is what we post; a renumbering here would set every staff member to
  Custom access, which is precisely the bug PR #56 fixed
- the hidden field these Vue forms submit through (`febb4049-…`, read from
  Manager's own `form.js`) is unchanged — if Manager regenerated it, every post
  would arrive with a field Manager ignores: a `200` that changes nothing

A failure here means **stop and fix the driver before trusting the access grid.**

**Which business does it inspect?** The business-scoped screens only exist inside
a business, so those checks need one. By default it uses the first business
Manager lists. Pin it to a throwaway if you prefer:

```
MANAGER_CONTRACT_BUSINESS="Test-Business-1"
```

**It creates nothing.** Every check is a `GET`, including opening the blank "New
User Permissions" form — which no more creates a record than `GET /user-form`
creates a user. Verified after a live run: the permissions list was unchanged.

### Two encodings, and why they are easy to confuse

Manager uses different encodings in the same page, which cost us a real bug:

| Where | Encoding |
|---|---|
| `Businesses` option **values** | plain `base64(businessName)` |
| URL query **params** (`/user-form?…`, `/login-password?…`) | `0x0a` + length + utf8, unpadded **base64url** |

Addressing `/user-form` with plain base64 does **not** 404 — it quietly serves a
blank *new-user* form. The driver then reads an empty user, edits that, posts it
back, and gets a `200`. Every signal says success while nothing was granted.

Two guards now make that impossible to repeat: a blank `Username` on the fetched
form throws instead of being posted back, and every access change is **read back
and compared** before the job is marked done.

### ⚠️ One bit separates Update from Delete

Business-scoped screens (User Permissions, Tabs) use a longer version of that URL
envelope, and **field 250 in it is destructive** — Delete on the permissions form,
Reset on the tabs form. The safe URL and the destructive one differ by a single
character at the end:

```
Update  …EfLQDwA     (250 = 0)
Reset   …EfLQDwE     (250 = 1)
```

Getting it wrong does not error. It deletes.

**So the driver never builds one.** It constructs only the simplest key — the
business name alone — and then follows Manager's own `href`s to reach records.
Those already carry a correct, flag-zero envelope. A test asserts that no key the
driver builds has that flag set.

**If you are ever hand-editing a Manager URL, do not touch the last character.**
And if you are extending the driver: keep following links. Do not be tempted to
assemble a record URL because it looks straightforward.

### These screens are Vue apps, not HTML forms

`/user-permissions-form` and `/tabs-form` have **no `name` attributes** on their
inputs — everything is `v-model`-bound. There is nothing to scrape into a
urlencoded post. The state is a JS literal at the foot of the page, and Manager's
`form.js` posts `JSON.stringify(app.$data)` into one multipart field named
`febb4049-dcdb-4c7a-a395-4b71da72a85b` (a hardcoded constant, not a nonce).

The post is the record's **complete new state**, so anything omitted is blanked.
Always read the model, change what you mean to, and post the whole thing back —
which is what [`server/manager-vue-form.js`](../server/manager-vue-form.js) does.

---

## The subscriber database — schema changes and backups

### Schema changes apply themselves

`schema.sql` is all `CREATE TABLE IF NOT EXISTS`, which creates a missing table
but does **nothing** to one that already exists. Adding a column therefore had no
effect on a live database — and it failed at *query* time, not deploy time: the
auth service started healthy and then returned 500 on the first request touching
the new column. That is how `users.status` took sign-in down.

`server/migrate.js` now runs at boot, right after `schema.sql`. It compares each
table against the live database and `ALTER`s in whatever is missing. Additive
only: it never drops, renames, retypes or reorders anything, never touches a row,
and is a no-op once the database is current.

Three things it will **not** do, because SQLite cannot, and it says so in the log
rather than guessing:

- `NOT NULL` with no `DEFAULT` — existing rows would have nowhere to go
- a non-constant default such as `DEFAULT (datetime('now'))`
- `PRIMARY KEY` on an existing table

A `UNIQUE` column *is* handled: the column goes in plain and a unique index
enforces it, which is what the inline constraint compiles to anyway.

Anything it reports as skipped needs a hand-written migration. Check after a
deploy that changed the schema:

```
journalctl -u txform-auth -n 30 --no-pager | grep migrate
```

### ⚠️ Backing it up: `cp` is NOT enough

The database runs in **WAL mode**, so recent writes live in `txform.db-wal`, not
in `txform.db`. Copying the `.db` file alone captures a stale — often empty —
snapshot. Two `.bak` files taken that way during development turned out to be
completely unreadable.

Always use SQLite's own backup, which checkpoints the WAL first:

```
sudo sqlite3 /var/www/taxify/server/txform.db ".backup '/var/www/taxify/server/txform-$(date +%F).db'"
```

Verify it before trusting it:

```
sqlite3 /path/to/backup.db "SELECT COUNT(*) FROM users;"
```

(The AWS whole-instance snapshots are unaffected — they capture `-wal` along with
everything else. This only bites hand-made copies.)

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
