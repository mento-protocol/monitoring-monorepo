#!/bin/bash
set -euo pipefail

# shellcheck source=scripts/lib/deploy-guard.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/deploy-guard.sh"

# Anchor subsequent git and pnpm commands to the guarded repo root so the guard
# and deploy operate on the same checkout even when invoked by absolute path.
REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$REPO_ROOT"

COMMIT_SHA=$(git rev-parse --short HEAD)
COMMIT_MSG=$(git log -1 --pretty=%s)

echo "🚀 Deploying governance-watchdog Cloud Function via Terraform"
echo "   Target: governance-watchdog/infra (terraform apply, manual-approval stack)"
echo "   Commit: ${COMMIT_SHA}"
echo "   Message: ${COMMIT_MSG}"
echo ""
echo "   Verify after apply: pnpm gov-watchdog:logs"
echo "   Rollback: git checkout <last-good-sha>, then re-run pnpm gov-watchdog:deploy"
echo ""

pnpm --filter @mento-protocol/governance-watchdog run deploy:terraform

echo ""
echo "✅ Deploy finished for commit ${COMMIT_SHA}. Verify with: pnpm gov-watchdog:logs"
