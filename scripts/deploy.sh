#!/usr/bin/env bash
#
# Server-side deploy for extension.txform.ph.
# Invoked by the GitHub Action over SSH as: sudo /var/www/taxify/scripts/deploy.sh
# Safe to run repeatedly and by hand.
#
# One-time setup (so the deploy user can run this without a password prompt):
#   echo 'DEPLOY_USER ALL=(root) NOPASSWD: /var/www/taxify/scripts/deploy.sh' \
#     | sudo tee /etc/sudoers.d/txform-deploy
#   sudo chmod 0440 /etc/sudoers.d/txform-deploy
# (replace DEPLOY_USER with the real SSH user, e.g. ubuntu)

set -euo pipefail

REPO_DIR="/var/www/taxify"
BRANCH="main"

cd "$REPO_DIR"

echo "[deploy] repo: $REPO_DIR  branch: $BRANCH"
echo "[deploy] before: $(git rev-parse --short HEAD)"

git fetch --quiet origin "$BRANCH"

# Nothing new upstream? Exit before touching the working tree at all. This keeps
# the scheduled (every-few-minutes) run a true no-op, so the live
# tax-rates-data.json is only ever stashed/restored on a real deploy.
if [ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$BRANCH")" ]; then
  echo "[deploy] already up to date at $(git rev-parse --short HEAD)"
  exit 0
fi

# tax-rates-data.json is written on the box by the Save-to-Server feature, so it
# may differ from the committed copy. Preserve it across the fast-forward.
STASHED=0
if ! git diff --quiet -- tax-rates-data.json 2>/dev/null; then
  echo "[deploy] stashing locally-modified tax-rates-data.json"
  git stash push --quiet -- tax-rates-data.json
  STASHED=1
fi

# What changed in this pull? Needed below to decide whether the long-running
# Node service has to be restarted. Captured before the merge moves HEAD.
# Refuse early, and say why.
#
# `git merge --ff-only` aborts if a tracked file was edited on the server,
# with a message that reads like a git problem rather than an operational
# one. Under `set -e` the script then just stops — and because this runs
# from cron, the only trace is a line in a log nobody reads. The site
# stays on old code while every merge looks successful from GitHub.
#
# That is not hypothetical: on 2026-07-21 an nginx snippet was patched by
# hand on the server to restore a broken portal, which left exactly this
# state. Nothing would have deployed again until someone noticed.
DIRTY="$(git status --porcelain --untracked-files=no)"
if [ -n "$DIRTY" ]; then
  echo "[deploy] BLOCKED: the server has local edits to tracked files."
  echo "[deploy] A fast-forward would overwrite them, so nothing can deploy."
  echo "$DIRTY" | sed 's/^/[deploy]   /'
  echo "[deploy] Get the change into the repo, then:  sudo git checkout -- <file>"
  exit 1
fi

CHANGED="$(git diff --name-only HEAD "origin/$BRANCH")"

# --ff-only refuses to deploy anything that isn't a clean fast-forward of main,
# so a surprise divergence fails loudly instead of creating a merge commit.
git merge --ff-only "origin/$BRANCH"

if [ "$STASHED" -eq 1 ]; then
  echo "[deploy] restoring tax-rates-data.json"
  git stash pop --quiet \
    || echo "[deploy] WARN: tax-rates-data.json needs manual reconciliation (git stash list)"
fi

# Keep the runtime-written file owned by the web server so the save feature can
# still overwrite it after a deploy. Ignore if the file isn't present yet.
if [ -f tax-rates-data.json ]; then
  chown www-data:www-data tax-rates-data.json 2>/dev/null || true
fi

# The static site and the extension are plain files — a pull is enough. But
# txform-auth is a long-running Node process that loaded server/*.js at start,
# so pulling new code changes NOTHING until it restarts.
#
# This bit was missing, and it failed silently: staff invites were merged,
# deployed, and still sent no email, because the process serving them had been
# started before that code existed. Nothing errored — the old code simply kept
# running. Restarting on every pull would be wasteful, so restart only when the
# service's own sources moved.
# schema.sql counts too: the service applies it at boot, so new tables and
# columns do not exist until it restarts.
if echo "$CHANGED" | grep -qE '^server/.*\.(js|sql)$'; then
  echo "[deploy] server code/schema changed — restarting txform-auth"
  if systemctl restart txform-auth; then
    sleep 2
    if [ "$(systemctl is-active txform-auth)" = "active" ]; then
      echo "[deploy] txform-auth active"
    else
      # Loud: a dead auth service means nobody can sign in, and a deploy that
      # quietly leaves it down is the worst version of this failure.
      echo "[deploy] ERROR: txform-auth did NOT come back up — check: journalctl -u txform-auth -n 50" >&2
      exit 1
    fi
  else
    echo "[deploy] ERROR: could not restart txform-auth" >&2
    exit 1
  fi
fi

# The provisioner is a systemd oneshot fired by a timer, so it re-reads its
# code on every tick — nothing to restart there.

echo "[deploy] after:  $(git rev-parse --short HEAD)"
echo "[deploy] done"
