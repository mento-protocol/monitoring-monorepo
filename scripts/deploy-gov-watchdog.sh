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

pnpm --filter @mento-protocol/governance-watchdog run deploy
