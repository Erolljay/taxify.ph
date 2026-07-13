# How deployment works (plain-English)

The server **updates itself automatically**. You don't SSH in to deploy.

## Deploying a change
Just get the change onto the `main` branch on GitHub (merge a PR, or push to `main`).
Within ~2 minutes the live server pulls it and it goes live. That's it.

**Why it works:** a scheduled job (cron) on the server runs every 2 minutes and
runs `scripts/deploy.sh`, which pulls the latest `main` into `/var/www/taxify`
(the folder that serves `extension.txform.ph`). It safely preserves the live
`tax-rates-data.json`, and does nothing at all when there's no new change.

## Watching a deploy
On the server:
```
sudo cat /var/log/txform-deploy.log        # history of every check/deploy
tail -f /var/log/txform-deploy.log         # watch live (Ctrl+C to stop)
```

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
