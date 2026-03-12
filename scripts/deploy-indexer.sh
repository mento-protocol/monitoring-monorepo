#!/usr/bin/env bash
# Deploy indexer to Envio Hosted by pushing to deploy branch
#
# Usage: pnpm deploy:indexer [network]
#   With network: pnpm deploy:indexer celo-mainnet
#   Without: prompts interactively

set -euo pipefail

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

if [[ -z "$NETWORK" ]]; then
  echo "Select network to deploy:"
  for i in "${!VALID_NETWORKS[@]}"; do
    echo "  $((i + 1))) ${VALID_NETWORKS[$i]}"
  done
  echo ""
  read -p "Enter number or network name: " choice
  if [[ "$choice" =~ ^[1-4]$ ]]; then
    NETWORK="${VALID_NETWORKS[$((choice - 1))]}"
  else
    NETWORK="$choice"
  fi
fi

if [[ -z "$NETWORK" ]] || ! validate_network "$NETWORK"; then
  echo "Invalid or missing network."
  echo "Available: ${VALID_NETWORKS[*]}"
  echo "Example: pnpm deploy:indexer celo-mainnet"
  exit 1
fi

DEPLOY_BRANCH="deploy/${NETWORK}"

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
  git push origin "main:refs/heads/$DEPLOY_BRANCH"
fi

echo "🚀 Deploying indexer to Envio Hosted (network: $NETWORK)"
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
git push --force-with-lease origin "HEAD:refs/heads/$DEPLOY_BRANCH"

echo ""
echo "✅ Pushed to $DEPLOY_BRANCH"
echo "   Envio will automatically redeploy the indexer."
echo ""
echo "📋 POST-DEPLOY CHECKLIST:"
echo ""
echo "   1. Watch sync progress:"
echo "      https://envio.dev/app/mento-protocol/mento-v3-${NETWORK}"
echo ""
echo "   2. Once synced, verify the dashboard:"
echo "      https://monitoring.mento.org"
echo ""
