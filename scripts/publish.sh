#!/usr/bin/env bash
# Publish the @zhaenggg ssh plugin packages to npm, in dependency order.
# Requires: npm login (zhaenggg); pnpm available.
set -euo pipefail
cd "$(dirname "$0")/.."
for p in packages/ssh/ssh packages/ssh/fs-ssh packages/ssh/subprocess-ssh packages/ssh/fs-routing packages/client/ui-settings-ssh; do
  echo "==> publishing $p"
  (cd "$p" && pnpm publish --access public --no-git-checks)
done
echo 'all published'
