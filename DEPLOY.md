# How deployment works (plain-English)

The server **updates itself automatically**. You don't SSH in to deploy.

## Deploying a change
Just get the change onto the `main` branch on GitHub (merge a PR, or push to `main`).
Within ~2 minutes the live server pulls it and it goes live. That's it.

**Why it works:** a scheduled job (cron) on the server runs every 2 minutes and
runs `scripts/deploy.sh`, which pulls the latest `main` into `/var/www/taxify`
(the folder that serves `extension.txform.ph`). It safely preserves the live
`tax-rates-data.json`, and does nothing at all when there's no new change.

**Backend changes also restart `txform-auth`.** The website and the extension are
plain files, so a pull is enough. But `txform-auth` is a long-running Node process
that loads `server/*.js` and `schema.sql` when it starts — pulling new code changes
nothing until it restarts. The deploy does that automatically whenever those files
move, and fails loudly if the service doesn't come back up.

This used to be missing, and it failed *silently*: the staff-invite email was
merged and deployed, and still sent nothing, because the process handling invites
had been started before that code existed. Nothing errored — the old code just kept
running. If a backend change ever seems not to have taken effect, check when the
service actually started:

```
systemctl show txform-auth -p ActiveEnterTimestamp --value
```

If that's older than your merge, it's running stale code — `sudo systemctl restart txform-auth`.

## Watching a deploy
On the server:
```
sudo cat /var/log/txform-deploy.log        # history of every check/deploy
tail -f /var/log/txform-deploy.log         # watch live (Ctrl+C to stop)
```

## ⚠️ The one thing that silently stops deploys

If anyone edits a file **on the server** that git tracks — patching a config
by hand to fix something urgent, say — the next deploy **aborts**:

```
error: Your local changes to the following files would be overwritten by merge
```

Nothing after that runs. The site stays on old code, GitHub still shows your
PR merged, and the only trace is a line in a log nobody reads. This happened
on 2026-07-21: an nginx snippet was patched by hand to bring the portal back
up, which would have blocked every deploy from that moment on.

**Two things now catch it:**

- `scripts/deploy.sh` refuses up front with a message that names the files
  and the fix, instead of a raw git error mid-run.
- `server/deploy-watch.js` runs every five minutes and **emails you** if the
  server has local edits, or has been behind `main` for more than ten
  minutes. One message per problem, at most one an hour, and a single
  all-clear when it lifts.

**If you get that email**, get the change into the repo properly, then:

```
cd /var/www/taxify
sudo git checkout -- <the files it named>
sudo bash scripts/deploy.sh
```

Nginx keeps its config in memory, so reverting a config file on disk does
**not** take the site down — you have time to do this calmly.

## Deploy by hand (rarely needed)
```
sudo bash /var/www/taxify/scripts/deploy.sh
```
(Always run it with `bash` — the file's "runnable" flag gets reset on each update,
so `bash` is the reliable way.)

## Security lockdown
`nginx-web-root-hardening.conf` is pulled into the `extension.txform.ph` server
block (via one `include` line in `/etc/nginx/sites-available/managerserver`). It
blocks the public from downloading source/ops files that sit in the web root:
`/.git`, `/server`, `/scripts`, `/docs`, and any dotfile (`.claude`, `.env`, ...).
All return 404. To re-verify after any change:
```
for f in .git/config server/schema.sql .claude/identity.json; do
  echo -n "$f -> "; curl -s -o /dev/null -w "%{http_code}\n" "https://extension.txform.ph/$f"
done   # all should print 404
```

## Server facts (for reference)
- AWS EC2 instance **txform-server**, region **ap-southeast-1** (Singapore).
- Address **47.131.92.61** (an Elastic IP — it never changes).
- Log in: `ssh -i ~/Downloads/Taxify/txform-key-sg.pem ubuntu@47.131.92.61`

## ⚠️ If you ever CAN'T log into the server ("Connection timed out")
This is almost always the AWS firewall, because **your home internet address
changes now and then** and the firewall only allows one address for logins.
It does **not** mean the server is down (the website keeps working). Fix:

1. AWS Console → make sure region is **Asia Pacific (Singapore)**.
2. **EC2 → Instances → txform-server → Security tab → click the security group.**
3. **Edit inbound rules** → find the **port 22** row → set **Source = My IP** → **Save rules.**
4. Try `ssh ...` again — it works within seconds.

(Never set port 22's source to "Anywhere"/`0.0.0.0/0` — that opens logins to the
whole internet.)
