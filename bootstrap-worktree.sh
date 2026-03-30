#!/usr/bin/env bash
# bootstrap-worktree.sh — monitoring-monorepo
# Run after worktree creation to get a fully working environment.
set -euo pipefail
cd "$(dirname "$0")"

echo "📦 Installing dependencies..."
pnpm install --frozen-lockfile

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
