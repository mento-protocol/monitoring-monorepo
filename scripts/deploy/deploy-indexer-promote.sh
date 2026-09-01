#!/usr/bin/env bash
# Promote the latest Envio indexer deployment to production.
#
# Usage:
#   pnpm deploy:indexer:promote             → promote latest deployment
#   pnpm deploy:indexer:promote <commit>    → promote specific deployment
#
# Requires: workspace envio-cloud CLI dependency, authenticated (run `pnpm exec envio-cloud login` first)

set -euo pipefail

ENVIO_ORG="mento-protocol"
ENVIO_INDEXER="mento"

COMMIT="${1:-}"
if [[ -n "$COMMIT" && "$COMMIT" != -* ]]; then
  shift
else
  COMMIT=""
fi

if [[ -z "$COMMIT" ]]; then
  # Auto-detect latest deployment
  COMMIT=$(pnpm exec envio-cloud indexer get "$ENVIO_INDEXER" "$ENVIO_ORG" -o json \
    | node scripts/deploy/resolve-envio-deployment.mjs "")

  if [[ -z "$COMMIT" ]]; then
    echo "❌ No deployments found for $ENVIO_ORG/$ENVIO_INDEXER"
    exit 1
  fi
else
  TARGET_COMMIT="$COMMIT"
  COMMIT=$(pnpm exec envio-cloud indexer get "$ENVIO_INDEXER" "$ENVIO_ORG" -o json \
    | node scripts/deploy/resolve-envio-deployment.mjs "$TARGET_COMMIT")

  if [[ -z "$COMMIT" ]]; then
    echo "❌ Deployment $TARGET_COMMIT not found for $ENVIO_ORG/$ENVIO_INDEXER"
    echo "   Wait for registration with: pnpm deploy:indexer:status $TARGET_COMMIT --watch --compact"
    exit 1
  fi
fi

echo "🚀 Promoting deployment $COMMIT to production..."
pnpm exec envio-cloud deployment promote "$ENVIO_INDEXER" "$COMMIT" "$ENVIO_ORG" "$@"
VERIFY_COMMIT="$COMMIT"
if RESOLVED_FULL_COMMIT=$(git rev-parse --verify "$COMMIT^{commit}" 2>/dev/null); then
  VERIFY_COMMIT="$RESOLVED_FULL_COMMIT"
fi
echo ""
echo "✅ Deployment $COMMIT is now production."
echo "   Wait the full 5-minute propagation window, then run:"
echo "      pnpm deploy:indexer:verify $VERIFY_COMMIT --prod"
echo "   Then follow .agents/skills/deploy-indexer/SKILL.md Phase 7 for the"
echo "   affected production API, dashboard page, and browser console."
