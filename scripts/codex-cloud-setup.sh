#!/usr/bin/env bash
# Prepare a Codex Cloud container for monitoring-monorepo agent work.
#
# Configure this as the environment setup script in Codex Cloud. It keeps the
# cloud checkout close to a fresh local worktree without requiring anything from
# a developer's home directory.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> Marking repository safe for git"
git config --global --add safe.directory "$REPO_ROOT" || true

echo "==> Configuring repository git hooks"
git config core.hooksPath .trunk/hooks

echo "==> Activating package manager from package.json"
if command -v corepack >/dev/null 2>&1; then
  corepack enable
  PNPM_VERSION="$(node -p "require('./package.json').packageManager.split('@')[1]")"
  corepack prepare "pnpm@${PNPM_VERSION}" --activate
fi
pnpm --version

echo "==> Installing workspace dependencies"
CI=true pnpm install --frozen-lockfile

echo "==> Verifying dashboard dependency resolution"
pnpm --filter @mento-protocol/ui-dashboard exec node -e "require.resolve('@sentry/nextjs/package.json')"

echo "==> Running Envio codegen"
pnpm indexer:codegen

echo "==> Validating repo-visible agent context"
pnpm agent:context-check

echo "==> Checking optional GitHub CLI auth"
if command -v gh >/dev/null 2>&1; then
  gh auth status || true
else
  echo "gh is not installed in this image; PR ship/babysit flows need GitHub tooling."
fi

echo "Codex Cloud setup complete."
