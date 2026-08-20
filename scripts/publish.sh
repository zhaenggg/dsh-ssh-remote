#!/usr/bin/env bash
# Build and publish the @zhaenggg ssh plugin packages to npm, in dependency order.
# Self-contained: installs and builds in this repository — no harness checkout needed.
# Publishes with an Automation-classic token from ~/.npmrc (bypasses 2FA).
set -euo pipefail
OTP="${1:-${OTP:-}}"
cd "$(dirname "$0")/.."
pnpm install --ignore-scripts
pnpm -r --filter './packages/*/*' run build
for p in packages/ssh/ssh packages/ssh/fs-ssh packages/ssh/subprocess-ssh packages/ssh/fs-routing packages/client/ui-settings-ssh; do
  echo "==> publishing $p"
  (cd "$p" && npm publish --access public)
done
echo 'all published'
