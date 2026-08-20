#!/usr/bin/env bash
# Build and publish the @zhaenggg ssh plugin packages to npm, in dependency order.
# Self-contained: installs and builds in this repository — no harness checkout needed.
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm install --ignore-scripts
pnpm -r --filter './packages/*/*' run build
for p in packages/ssh/ssh packages/ssh/fs-ssh packages/ssh/subprocess-ssh packages/ssh/fs-routing packages/client/ui-settings-ssh; do
  echo "==> publishing $p"
  (cd "$p" && pnpm publish --access public --no-git-checks)
done
echo 'all published'
