#!/usr/bin/env bash
# bootstrap-worktree.sh — monitoring-monorepo
# Run after worktree creation to get a fully working environment.
set -euo pipefail
cd "$(dirname "$0")"

# Shared Turbo cache across worktrees (GitHub issue #1411): keep the local Turbo
# filesystem cache at one stable per-repo location outside any worktree so a
# fresh per-PR worktree reuses warm entries instead of starting 100% cold.
# Respect a caller-provided TURBO_CACHE_DIR; set AGENT_TURBO_SHARED_CACHE=0 to
# opt out and fall back to Turbo's per-worktree default.
if [[ -z "${TURBO_CACHE_DIR:-}" &&
  "${AGENT_TURBO_SHARED_CACHE:-1}" != "0" &&
  "${AGENT_TURBO_SHARED_CACHE:-1}" != "false" &&
  -n "${HOME:-}" ]]; then
  export TURBO_CACHE_DIR="${HOME}/.cache/turbo-monitoring-monorepo"
fi

echo "📦 Installing dependencies..."
pnpm install --frozen-lockfile

echo "🔎 Verifying ui-dashboard dependency resolution..."
pnpm --filter @mento-protocol/ui-dashboard exec node -e "require.resolve('@sentry/nextjs/package.json')"

echo "🔧 Running indexer codegen (multichain mainnet)..."
pnpm indexer:codegen

echo "✅ Verifying typecheck..."
pnpm --filter @mento-protocol/ui-dashboard typecheck
pnpm --filter @mento-protocol/indexer-envio typecheck

echo "🧪 Running tests..."
pnpm --filter @mento-protocol/ui-dashboard test
pnpm --filter @mento-protocol/indexer-envio test

echo ""
echo "🚀 monitoring-monorepo is ready to code"
echo ""
echo "Key commands:"
echo "  pnpm dashboard:dev          — start dashboard dev server"
echo "  pnpm dashboard:build        — production build"
echo "  pnpm indexer:codegen        — regenerate indexer types"
echo "  ./tools/trunk check --all   — lint everything"
