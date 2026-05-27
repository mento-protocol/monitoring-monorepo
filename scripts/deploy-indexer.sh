#!/usr/bin/env bash
# Deploy indexer to Envio Hosted by pushing to either:
# - `envio` (default multichain deployment), or
# - `deploy/<network>` (legacy per-network deployments)
#
# Usage:
#   pnpm deploy:indexer              → push to `envio` branch (multichain mainnet, default)
#   pnpm deploy:indexer <network>    → push to `deploy/<network>` branch (legacy per-network)
#   pnpm deploy:indexer --yes        → skip confirmation prompt (CI / agent friendly)
#
# After pushing, use companion scripts:
#   pnpm deploy:indexer:status <commit> --watch → watch sync progress
#   pnpm deploy:indexer:promote <commit>        → promote deployment to prod
#   pnpm deploy:indexer:logs         → tail runtime logs
#
# Envio project: https://envio.dev/app/mento-protocol/mento

set -euo pipefail

restore_cursor() {
  tput cnorm 2>/dev/null || true
}

trap restore_cursor EXIT

VALID_NETWORKS=(celo-sepolia celo-mainnet monad-testnet monad-mainnet)
ENVIO_ORG="mento-protocol"
ENVIO_INDEXER="mento"

validate_network() {
  local n="$1"
  for valid in "${VALID_NETWORKS[@]}"; do
    if [[ "$n" == "$valid" ]]; then return 0; fi
  done
  return 1
}

# Parse flags
AUTO_YES=false
NETWORK=""
for arg in "$@"; do
  case "$arg" in
    --yes|-y) AUTO_YES=true ;;
    --) ;;
    *) NETWORK="$arg" ;;
  esac
done

# Default (no arg): deploy multichain indexer via `envio` branch
if [[ -z "$NETWORK" ]]; then
  DEPLOY_BRANCH="envio"
  SYNC_URL="https://envio.dev/app/${ENVIO_ORG}/${ENVIO_INDEXER}"
  echo "🌐 Deploying multichain indexer (Celo + Monad) → branch: $DEPLOY_BRANCH"
else
  if ! validate_network "$NETWORK"; then
    echo "Invalid network: $NETWORK"
    echo "Available: ${VALID_NETWORKS[*]}"
    echo "Example: pnpm deploy:indexer celo-mainnet"
    exit 1
  fi
  DEPLOY_BRANCH="deploy/${NETWORK}"
  SYNC_URL="https://envio.dev/app/${ENVIO_ORG}/mento-v3-${NETWORK}"
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
COMMIT_SHORT=$(git rev-parse --short HEAD)
COMMIT_MSG=$(git log -1 --pretty=format:"%s" "$COMMIT_SHA")

echo "   Commit: $COMMIT_SHA"
echo "   Message: $COMMIT_MSG"
echo ""

# Confirm (skip with --yes)
if [[ "$AUTO_YES" == "false" ]]; then
  read -p "Push to $DEPLOY_BRANCH? [y/N] " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
  fi
fi

# Push current HEAD to deploy branch. Capture stdout+stderr so we can detect
# the "Everything up-to-date" no-op case: when the deploy branch already
# points at HEAD, git does not contact the remote, no push event is fired,
# and Envio's webhook never runs — but the script otherwise looks successful.
# Surface the case loudly so callers don't sit watching a non-existent build.
PUSH_OUTPUT_FILE=$(mktemp)
trap 'rm -f "$PUSH_OUTPUT_FILE"; restore_cursor' EXIT
if ! git push --no-verify --force-with-lease origin "HEAD:refs/heads/$DEPLOY_BRANCH" 2>&1 | tee "$PUSH_OUTPUT_FILE"; then
  echo "❌ Push to $DEPLOY_BRANCH failed."
  exit 1
fi

if grep -q "Everything up-to-date" "$PUSH_OUTPUT_FILE"; then
  echo ""
  echo "⚠️  Push was a no-op — '$DEPLOY_BRANCH' already at $COMMIT_SHORT."
  echo "   Envio's GitHub App webhook only fires on real ref updates, so NO new"
  echo "   build will be triggered. If you intended to retrigger a deploy that"
  echo "   never registered, push a commit with a different SHA:"
  echo ""
  echo "     git commit --allow-empty -m 'chore: re-trigger envio webhook'"
  echo "     pnpm deploy:indexer --yes"
  echo ""
  echo "   Otherwise, the existing deployment at $COMMIT_SHORT is what's live."
  exit 2
fi

echo ""
echo "✅ Pushed to $DEPLOY_BRANCH"
echo "   Envio will automatically redeploy the indexer."
echo ""
echo "📋 POST-DEPLOY CHECKLIST:"
echo ""
echo "   1. Watch sync progress:"
echo "      pnpm deploy:indexer:status $COMMIT_SHA --watch"
echo "      $SYNC_URL"
echo ""
echo "   2. Once synced, promote to prod:"
echo "      pnpm deploy:indexer:promote $COMMIT_SHA"
echo ""
echo "   3. Verify the dashboard:"
echo "      https://monitoring.mento.org"
echo ""
