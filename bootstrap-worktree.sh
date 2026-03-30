#!/usr/bin/env bash
# bootstrap-worktree.sh — monitoring-monorepo
# Run after worktree creation to get a fully working environment.
set -euo pipefail
cd "$(dirname "$0")"

echo "📦 Installing dependencies..."
pnpm install --frozen-lockfile

echo "🔧 Running indexer codegen (multichain mainnet)..."
pnpm indexer:codegen 2>/dev/null || {
  # Fallback: try default devnet config
  echo "   ⚠️ Multichain codegen failed, trying devnet..."
  pnpm --filter @mento-protocol/indexer-envio codegen --config config.multichain.mainnet.yaml
}

echo "✅ Verifying typecheck..."
pnpm --filter @mento-protocol/ui-dashboard typecheck
pnpm --filter @mento-protocol/indexer-envio typecheck

echo "🧪 Running tests..."
pnpm --filter @mento-protocol/ui-dashboard test -- --run 2>/dev/null || echo "   ⚠️ Dashboard tests: some failures (check manually)"
pnpm --filter @mento-protocol/indexer-envio test 2>/dev/null || echo "   ⚠️ Indexer tests: some failures (check manually)"

echo ""
echo "🚀 monitoring-monorepo is ready to code"
echo ""
echo "Key commands:"
echo "  pnpm dashboard:dev          — start dashboard dev server"
echo "  pnpm dashboard:build        — production build"
echo "  pnpm indexer:codegen        — regenerate indexer types"
echo "  ./tools/trunk check --all   — lint everything"
