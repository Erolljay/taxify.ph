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

# tax-rates-data.json is written on the box by the Save-to-Server feature, so it
# may differ from the committed copy. Preserve it across the fast-forward.
STASHED=0
if ! git diff --quiet -- tax-rates-data.json 2>/dev/null; then
  echo "[deploy] stashing locally-modified tax-rates-data.json"
  git stash push --quiet -- tax-rates-data.json
  STASHED=1
fi

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

echo "[deploy] after:  $(git rev-parse --short HEAD)"
echo "[deploy] done"
