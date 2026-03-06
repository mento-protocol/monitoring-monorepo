#!/usr/bin/env bash
# Deploy indexer to Envio Hosted by pushing to deploy branch

set -euo pipefail

NETWORK="${1:-}"

if [[ -z "$NETWORK" ]]; then
  echo "Usage: $0 <network>"
  echo ""
  echo "Available networks:"
  echo "  celo-sepolia"
  echo "  celo-mainnet"
  echo "  monad-mainnet"
  echo ""
  echo "Example: $0 celo-sepolia"
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
  git push --no-verify origin "main:refs/heads/$DEPLOY_BRANCH"
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
git push --no-verify --force-with-lease origin "HEAD:refs/heads/$DEPLOY_BRANCH"

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
