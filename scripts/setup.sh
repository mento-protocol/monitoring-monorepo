#!/usr/bin/env bash
# setup.sh — run this once after creating a new worktree or cloning the repo.
#
# What it does:
#   1. Install all pnpm workspace dependencies when needed
#   2. Install Playwright Chromium for ui-dashboard browser tests when needed
#   3. Run Envio codegen when needed
#
# Why codegen is needed:
#   The indexer-envio package imports Envio's generated type facade from
#   `.envio/types.d.ts`. This file is gitignored. Without it, typecheck and
#   Vitest fail with missing Envio entity types. Run this script once per fresh
#   worktree to unblock it; reruns skip install/codegen when inputs are unchanged.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

hash_inputs() {
  local file_list
  file_list="$(mktemp "${TMPDIR:-/tmp}/monitoring-setup-hash.XXXXXX")"

  for p in "$@"; do
    if [ -d "$p" ]; then
      find "$p" -type f 2>/dev/null
    elif [ -e "$p" ]; then
      printf '%s\n' "$p"
    fi
  done | LC_ALL=C sort -u >"$file_list"

  if [ ! -s "$file_list" ]; then
    rm -f "$file_list"
    return 1
  fi

  local hash
  if command -v sha256sum >/dev/null 2>&1; then
    hash="$(xargs sha256sum <"$file_list" 2>/dev/null | sha256sum | awk '{print $1}')"
  else
    hash="$(xargs shasum -a 256 <"$file_list" 2>/dev/null | shasum -a 256 | awk '{print $1}')"
  fi
  rm -f "$file_list"
  printf '%s\n' "$hash"
}

playwright_chromium_present() {
  pnpm --filter @mento-protocol/ui-dashboard exec node -e \
    "const { chromium } = require('@playwright/test'); require('fs').accessSync(chromium.executablePath());" \
    >/dev/null 2>&1
}

dashboard_sentry_present() {
  pnpm --filter @mento-protocol/ui-dashboard exec node -e "require.resolve('@sentry/nextjs/package.json')" \
    >/dev/null 2>&1
}

echo "▶ Configuring git hooks..."
if [ "$(git config --get core.hooksPath || true)" = ".trunk/hooks" ]; then
  echo "  core.hooksPath already .trunk/hooks"
else
  if git config core.hooksPath .trunk/hooks 2>/dev/null; then
    echo "  core.hooksPath → .trunk/hooks"
  else
    echo "  WARN: could not set core.hooksPath; run manually if git hooks are needed"
  fi
fi

echo "▶ Installing dependencies..."
deps_marker="node_modules/.setup-deps.sha256"
deps_marker_pending=0
deps_hash="$(
  hash_inputs \
    pnpm-lock.yaml \
    pnpm-workspace.yaml \
    package.json \
    .npmrc \
    pnpmfile.cjs \
    patches \
    */package.json \
    alerts/infra/*/package.json \
    shared-config/src \
    shared-config/tsconfig.json || true
)"
if [ -d node_modules ] && [ -s shared-config/dist/chains.js ] &&
  [ -n "$deps_hash" ] &&
  [ "$(cat "$deps_marker" 2>/dev/null)" = "$deps_hash" ] &&
  dashboard_sentry_present; then
  echo "  deps + shared-config build are up to date; skipping pnpm install"
else
  CI=true pnpm install --frozen-lockfile --prefer-offline
  pnpm --filter @mento-protocol/monitoring-config build
  deps_marker_pending=1
fi

echo "▶ Verifying ui-dashboard dependency resolution..."
dashboard_sentry_present
if [ "$deps_marker_pending" -eq 1 ] && [ -n "$deps_hash" ]; then
  printf '%s' "$deps_hash" >"$deps_marker"
fi

echo "▶ Installing Playwright Chromium and host dependencies (ui-dashboard browser tests)..."
playwright_marker="node_modules/.setup-playwright-chromium.sha256"
playwright_hash="$(hash_inputs pnpm-lock.yaml ui-dashboard/package.json || true)"
if [ -n "$playwright_hash" ] &&
  [ "$(cat "$playwright_marker" 2>/dev/null)" = "$playwright_hash" ] &&
  playwright_chromium_present; then
  echo "  Playwright Chromium install is up to date; skipping"
else
  if pnpm --filter @mento-protocol/ui-dashboard exec playwright install --with-deps chromium; then
    if [ -n "$playwright_hash" ]; then
      printf '%s' "$playwright_hash" >"$playwright_marker"
    fi
  else
    echo "  ⚠ Playwright Chromium install failed; continuing setup." >&2
    echo "    Run 'pnpm --filter @mento-protocol/ui-dashboard exec playwright install --with-deps chromium' before browser tests." >&2
  fi
fi

echo "▶ Running Envio codegen (multichain config)..."
codegen_marker="node_modules/.setup-codegen.sha256"
codegen_hash="$(hash_inputs indexer-envio/config*.yaml indexer-envio/schema.graphql indexer-envio/package.json indexer-envio/abis indexer-envio/scripts || true)"
if [ -s "indexer-envio/.envio/types.d.ts" ] && [ -n "$codegen_hash" ] &&
  [ "$(cat "$codegen_marker" 2>/dev/null)" = "$codegen_hash" ]; then
  echo "  Envio types are up to date; skipping codegen"
else
  rm -f indexer-envio/.envio/types.d.ts
  pnpm indexer:codegen
fi

if [ ! -s "indexer-envio/.envio/types.d.ts" ]; then
  cat >&2 <<'MSG'
error: Envio codegen did not produce indexer-envio/.envio/types.d.ts.
Indexer typecheck and Vitest resolve generated Envio entity types from this
file. Re-run 'pnpm indexer:codegen' and inspect the Envio CLI output for the
underlying error.
MSG
  exit 1
fi
if [ -n "$codegen_hash" ]; then
  printf '%s' "$codegen_hash" >"$codegen_marker"
fi

echo ""
echo "✅ Setup complete. You're ready to work and push."
echo ""
echo "Before every push from a server/worktree, run the pre-push checks manually:"
echo "  git fetch origin main"
echo "  ./tools/trunk fmt --all"
echo "  ./tools/trunk check --all"
echo "  pnpm dashboard:react-doctor:diff"
echo "  pnpm --filter @mento-protocol/ui-dashboard typecheck"
echo "  pnpm --filter @mento-protocol/indexer-envio typecheck"
echo "  pnpm --filter @mento-protocol/indexer-envio test"
echo "  pnpm indexer:codegen"
echo "  pnpm --filter @mento-protocol/ui-dashboard test:coverage"
