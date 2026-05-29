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

echo "==> Prewarming Trunk CLI and linters"
# Trunk powers the git pre-commit/pre-push hooks (.trunk/hooks) and `trunk fmt`.
# The launcher self-downloads the pinned CLI from trunk.io, which is NOT in the
# default Trusted allowlist for Claude Code on the web. Everything else Trunk
# needs (node/python runtimes, prettier/markdownlint via npm, checkov/codespell/
# yamllint via PyPI, trufflehog/osv-scanner/actionlint via GitHub releases, tool
# binaries on *.amazonaws.com) is already covered by the Trusted defaults, so the
# ONLY host to add is trunk.io. In the environment's network settings choose
# "Custom", keep "include defaults", and add:
#     trunk.io
#     *.trunk.io
# Non-fatal: if trunk.io is still blocked the hooks degrade gracefully (see
# .trunk/hooks) and CI still enforces Trunk on the PR, so warn and continue
# rather than aborting the whole bootstrap.
if ./tools/trunk --version >/dev/null 2>&1; then
  ./tools/trunk --version
  if ! ./tools/trunk install; then
    echo "WARN: 'trunk install' could not preinstall all linters; hooks may run a reduced set." >&2
  fi
else
  echo "WARN: Trunk CLI could not be downloaded (is trunk.io allowlisted?)." >&2
  echo "WARN: git pre-commit/pre-push hooks will be skipped this session." >&2
  echo "WARN: Add 'trunk.io' and '*.trunk.io' to the env's Allowed domains (Custom" >&2
  echo "WARN: network access, keep defaults) to enable local Trunk fmt/lint hooks." >&2
fi

echo "==> Installing workspace dependencies"
CI=true pnpm install --frozen-lockfile

echo "==> Verifying dashboard dependency resolution"
pnpm --filter @mento-protocol/ui-dashboard exec node -e "require.resolve('@sentry/nextjs/package.json')"

echo "==> Running Envio codegen"
pnpm indexer:codegen

echo "==> Verifying Envio codegen output"
# `envio codegen` is quiet in CI/non-TTY mode and exits 0 even when it writes
# nothing, so the exit code alone is not a reliable signal. The agent typecheck
# and vitest loops resolve indexer types from .envio/types.d.ts (the `envio` npm
# package supplies the runtime); the ReScript `generated/` dir is only needed
# for `pnpm indexer:dev`/`start` (Docker + live RPC), which is not a hosted-agent
# flow. Assert the type facade exists so a silent codegen miss fails the
# bootstrap here instead of surfacing as confusing type errors mid-task.
if [ ! -s "indexer-envio/.envio/types.d.ts" ]; then
  echo "ERROR: Envio codegen did not produce indexer-envio/.envio/types.d.ts." >&2
  echo "ERROR: indexer typecheck and the vitest suites resolve types from this" >&2
  echo "ERROR: file and will fail without it. Re-run 'pnpm indexer:codegen' and" >&2
  echo "ERROR: inspect the envio CLI output for the underlying error." >&2
  exit 1
fi

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

echo "==> Reporting GitHub integration mode"
# Unlike scripts/codex-cloud-setup.sh, this script does NOT install or auth `gh`.
# In Claude Code on the web, git transport is proxied through a local credential
# proxy (origin is http://local_proxy@127.0.0.1:.../git/...) that authenticates
# git only, so no GitHub token is exposed in the container and `gh` has no
# credential by default. api.github.com itself IS reachable (it is in the default
# Trusted allowlist), so GitHub API work can flow two ways: the GitHub MCP
# server (default, no setup) or `gh` once you install it (apt) AND provide a
# GH_TOKEN env var in the environment settings. Until a GH_TOKEN is set, the
# gh-backed `pnpm pr:ready-state` probe — and the ship/babysit skills that wrap
# it — are unavailable; use the mcp__github__* tools for PR readiness instead.
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  echo "gh is present and authenticated; gh-backed PR flows (pr:ready-state) are available."
  gh auth status || true
else
  echo "gh is unavailable/unauthenticated: using the GitHub MCP server for PR/API work."
  echo "To enable gh flows, 'apt install -y gh' in the setup script and set GH_TOKEN in env settings."
fi

echo "Claude Code on the web setup complete."
