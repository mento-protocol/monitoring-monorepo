#!/usr/bin/env bash
# Deploy indexer to Envio Hosted by pushing to either:
# - `envio` (default multichain deployment), or
# - `deploy/<network>` (legacy per-network deployments)
#
# Usage:
#   pnpm deploy:indexer              → push to `envio` branch (multichain mainnet, default)
#   pnpm deploy:indexer <network>    → push to `deploy/<network>` branch (legacy per-network)
#
# Envio project: https://envio.dev/app/mento-protocol/mento

set -euo pipefail

restore_cursor() {
  tput cnorm 2>/dev/null || true
}

trap restore_cursor EXIT

VALID_NETWORKS=(celo-sepolia celo-mainnet monad-testnet monad-mainnet)

validate_network() {
  local n="$1"
  for valid in "${VALID_NETWORKS[@]}"; do
    if [[ "$n" == "$valid" ]]; then return 0; fi
  done
  return 1
}

if [[ "${1:-}" == "--" ]]; then
  shift
fi

NETWORK="${1:-}"

# Default (no arg): deploy multichain indexer via `envio` branch
if [[ -z "$NETWORK" ]]; then
  DEPLOY_BRANCH="envio"
  SYNC_URL="https://envio.dev/app/mento-protocol/mento"
  echo "🌐 Deploying multichain indexer (Celo + Monad) → branch: $DEPLOY_BRANCH"
else
  if ! validate_network "$NETWORK"; then
    echo "Invalid network: $NETWORK"
    echo "Available: ${VALID_NETWORKS[*]}"
    echo "Example: pnpm deploy:indexer celo-mainnet"
    exit 1
  fi
  DEPLOY_BRANCH="deploy/${NETWORK}"
  SYNC_URL="https://envio.dev/app/mento-protocol/mento-v3-${NETWORK}"
  echo "🚀 Deploying indexer (network: $NETWORK) → branch: $DEPLOY_BRANCH"
fi

# Check if we're on a clean working tree
if [[ -n "$(git status --porcelain)" ]]; then
  echo "❌ Working directory is not clean. Commit or stash your changes first."
  git status --short
  exit 1
fi

# Check if deploy branch exists on remote
if ! git ls-remote --heads origin "$DEPLOY_BRANCH" | grep -q "$DEPLOY_BRANCH"; then
  echo "⚠️  Deploy branch '$DEPLOY_BRANCH' does not exist on remote."
  echo "Creating it now from current main..."
  git push --no-verify origin "main:refs/heads/$DEPLOY_BRANCH"
fi

echo "   Branch: $DEPLOY_BRANCH"
echo ""

# Get current commit info
COMMIT_SHA=$(git rev-parse HEAD)
COMMIT_MSG=$(git log -1 --pretty=format:"%s" "$COMMIT_SHA")

echo "   Commit: $COMMIT_SHA"
echo "   Message: $COMMIT_MSG"
echo ""

# Confirm
read -p "Push to $DEPLOY_BRANCH? [y/N] " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi

# Push current HEAD to deploy branch
git push --no-verify --force-with-lease origin "HEAD:refs/heads/$DEPLOY_BRANCH"

echo ""
echo "✅ Pushed to $DEPLOY_BRANCH"
echo "   Envio will automatically redeploy the indexer."
echo ""
echo "📋 POST-DEPLOY CHECKLIST:"
echo ""
echo "   1. Watch sync progress:"
echo "      $SYNC_URL"
echo ""
echo "   2. Once synced, verify the dashboard:"
echo "      https://monitoring.mento.org"
echo ""
