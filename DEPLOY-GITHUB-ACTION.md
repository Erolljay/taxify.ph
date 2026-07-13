# Push-to-deploy: GitHub Action → server

One-time setup so that **every merge to `main` auto-deploys** to
`extension.txform.ph`. After this, you never hand-run `git pull` on the box again.

Pieces (all in this PR):
- `.github/workflows/deploy.yml` — runs on push to `main`, SSHes to the server, runs the deploy script.
- `scripts/deploy.sh` — runs **on the server**: fast-forwards `/var/www/taxify` to `origin/main`, preserving the runtime-written `tax-rates-data.json`.
- `nginx-web-root-hardening.conf` — blocks `/.git`, `/server`, `/scripts`, `/docs`, dotfiles from being served publicly (see step 4 — **do this, it closes a source-disclosure hole**).

---

## 1. (Recommended) Make a dedicated deploy key

Don't reuse `txform-key-sg.pem` (your admin key) as a CI secret — give CI its own
least-privilege key you can revoke independently. On your machine:

```bash
ssh-keygen -t ed25519 -f txform-deploy-key -C "github-actions-deploy" -N ""
```

Append the **public** half to the server's authorized keys (paste `txform-deploy-key.pub`):

```bash
# on the server, as the deploy user:
echo "ssh-ed25519 AAAA... github-actions-deploy" >> ~/.ssh/authorized_keys
```

If you'd rather just reuse the existing key, skip this and use `txform-key-sg.pem`
as `DEPLOY_SSH_KEY` below.

## 2. Add the four GitHub secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
|---|---|
| `DEPLOY_SSH_KEY` | Full contents of the **private** key (`txform-deploy-key`, or `txform-key-sg.pem`). Include the `-----BEGIN/END-----` lines. |
| `DEPLOY_HOST` | Server IP or hostname (the box behind `extension.txform.ph`). |
| `DEPLOY_USER` | SSH user (EC2 Ubuntu default is `ubuntu`). |
| `DEPLOY_KNOWN_HOSTS` | Output of `ssh-keyscan -H <DEPLOY_HOST>` — pins the host key so CI won't connect to an impostor. |

Generate the known-hosts value locally:

```bash
ssh-keyscan -H <DEPLOY_HOST>
```

## 3. One-time server prep

Land `scripts/deploy.sh` on the box and let the deploy user run it without a
password. **This first pull is the only manual one.**

```bash
# SSH in as the deploy user, then:
cd /var/www/taxify && sudo git pull            # brings in scripts/deploy.sh (+ current main)
sudo chmod +x /var/www/taxify/scripts/deploy.sh

# passwordless sudo for JUST this script (replace ubuntu if your user differs):
echo 'ubuntu ALL=(root) NOPASSWD: /var/www/taxify/scripts/deploy.sh' \
  | sudo tee /etc/sudoers.d/txform-deploy
sudo chmod 0440 /etc/sudoers.d/txform-deploy

# smoke-test it:
sudo /var/www/taxify/scripts/deploy.sh
```

> If `git pull` complains the repo is owned by a different user, run once:
> `sudo git config --global --add safe.directory /var/www/taxify`

## 4. Harden the web root (do this now — it's a real exposure)

The entire repo is checked out into the public web root, so `/.git`, `/server`,
and `/docs` are currently fetchable over HTTPS. Close it:

```bash
sudo nano /etc/nginx/sites-available/managerserver
# paste nginx-web-root-hardening.conf inside the extension.txform.ph server { } block
sudo nginx -t && sudo systemctl reload nginx
```

Verify (all four should 404):

```bash
for p in .git/config server/schema.sql server/auth-core.js docs/ECC-PLAYBOOK.md; do
  echo -n "$p -> "; curl -s -o /dev/null -w "%{http_code}\n" "https://extension.txform.ph/$p"
done
```

## 5. Test the pipeline

- Actions tab → **Deploy to production** → **Run workflow** (manual `workflow_dispatch`), or
- merge any trivial commit to `main`.

Watch the run; the log ends with `[deploy] done` and the new short SHA. Confirm
`git rev-parse --short HEAD` on the server matches.

---

### Security notes
- No third-party actions are used — the workflow relies only on the runner's
  OpenSSH client, so there's no action supply-chain surface.
- `StrictHostKeyChecking=yes` + a pinned `DEPLOY_KNOWN_HOSTS` prevents a
  man-in-the-middle from impersonating the server during deploy.
- The NOPASSWD sudoers grant is scoped to the single deploy script, not blanket
  `sudo`.
- Rotate/revoke: delete the deploy key from `~/.ssh/authorized_keys` on the
  server and remove the secret to kill CI access without touching your admin key.
