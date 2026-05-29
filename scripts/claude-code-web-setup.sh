#!/usr/bin/env bash
# Prepare a Claude Code on the web container for monitoring-monorepo agent work.
#
# Invoked from the SessionStart hook in .claude/settings.json (Claude Code on
# the web only, gated on $CLAUDE_CODE_REMOTE). Keeps the cloud checkout close
# to a fresh local worktree without requiring anything from a developer's home
# directory.
#
# Parallel to scripts/codex-cloud-setup.sh (Codex Cloud). The two scripts share
# the install/codegen contract; this one additionally installs Playwright
# Chromium so the browser-fixture tests under
# `pnpm --filter @mento-protocol/ui-dashboard test:browser` work without an
# extra step.

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

echo "==> Installing Playwright Chromium for dashboard browser tests"
# Non-fatal: hosted environments often restrict outbound network access
# (cdn.playwright.dev returns 403 "Host not in allowlist") or run without sudo
# (so `--with-deps` cannot install OS packages). Browser tests are optional for
# most agent flows; warn and continue so the rest of the bootstrap (codegen,
# context-check) still completes. `--with-deps` mirrors the repo CI workflows
# (`.github/workflows/ci.yml` and `update-snapshots.yml`) so a successful
# bootstrap leaves the container actually able to run the browser fixtures.
if ! pnpm --filter @mento-protocol/ui-dashboard exec playwright install --with-deps chromium; then
  echo "WARN: Playwright Chromium install failed." >&2
  echo "WARN: 'pnpm --filter @mento-protocol/ui-dashboard test:browser' will not work" >&2
  echo "WARN: until the environment allows access to cdn.playwright.dev and can" >&2
  echo "WARN: install OS dependencies (sudo apt-get) for Chromium." >&2
fi

echo "==> Validating repo-visible agent context"
pnpm agent:context-check

echo "==> Checking optional GitHub CLI auth"
if command -v gh >/dev/null 2>&1; then
  gh auth status || true
else
  echo "gh is not installed in this image; PR ship/babysit flows need GitHub tooling."
fi

echo "Claude Code on the web setup complete."
