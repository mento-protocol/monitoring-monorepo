#!/usr/bin/env bash
# setup.sh — run this once after creating a new worktree or cloning the repo.
#
# What it does:
#   1. Install all pnpm workspace dependencies
#   2. Run Envio codegen (required for indexer-envio TypeScript to compile)
#
# Why codegen is needed:
#   The indexer-envio package imports from a `generated/` directory that Envio
#   produces at codegen time. This directory is gitignored. Without it, `tsc`
#   fails with "Cannot find module 'generated'" and the pre-push typecheck hook
#   blocks every push. Run this script once per fresh worktree to unblock it.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "▶ Configuring git hooks..."
git config core.hooksPath .trunk/hooks
echo "  core.hooksPath → .trunk/hooks"

echo "▶ Installing dependencies..."
pnpm install --frozen-lockfile

echo "▶ Running Envio codegen (multichain config)..."
pnpm indexer:codegen

echo ""
echo "✅ Setup complete. You're ready to work and push."
echo ""
echo "Before every push from a server/worktree, run the pre-push checks manually:"
echo "  ./tools/trunk fmt --all"
echo "  ./tools/trunk check --all"
echo "  pnpm --filter @mento-protocol/ui-dashboard typecheck"
echo "  pnpm --filter @mento-protocol/indexer-envio typecheck"
echo "  pnpm --filter @mento-protocol/ui-dashboard test:coverage"
