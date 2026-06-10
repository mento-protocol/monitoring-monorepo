#!/bin/bash
set -euo pipefail

# Deploy scripts must refuse dirty working trees before mutating external
# systems (scripts/AGENTS.md). `terraform apply` archives the local checkout
# into the Cloud Function source, so uncommitted edits would ship unreviewed
# and make rollback/audit unreliable.
if [[ -n "$(git status --porcelain)" ]]; then
  echo "❌ Working directory is not clean. Commit or stash your changes first."
  git status --short
  exit 1
fi

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
