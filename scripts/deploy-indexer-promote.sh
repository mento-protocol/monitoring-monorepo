#!/usr/bin/env bash
# Promote the latest Envio indexer deployment to production.
#
# Usage:
#   pnpm deploy:indexer:promote             → promote latest deployment
#   pnpm deploy:indexer:promote <commit>    → promote specific deployment
#
# Requires: npx envio-cloud, authenticated (run `npx envio-cloud login` first)

set -euo pipefail

ENVIO_ORG="mento-protocol"
ENVIO_INDEXER="mento"

COMMIT="${1:-}"

if [[ -z "$COMMIT" ]]; then
  # Auto-detect latest deployment
  COMMIT=$(npx -q envio-cloud indexer get "$ENVIO_INDEXER" "$ENVIO_ORG" -o json 2>/dev/null \
    | node -e "
      const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      const deps = d.data.deployments.sort((a,b) => b.created_time.localeCompare(a.created_time));
      console.log(deps[0]?.commit_hash ?? '');
    ")

  if [[ -z "$COMMIT" ]]; then
    echo "❌ No deployments found for $ENVIO_ORG/$ENVIO_INDEXER"
    exit 1
  fi
fi

echo "🚀 Promoting deployment $COMMIT to production..."
npx -q envio-cloud deployment promote "$ENVIO_INDEXER" "$COMMIT" "$ENVIO_ORG"
echo ""
echo "✅ Deployment $COMMIT is now production."
echo "   Verify: https://monitoring.mento.org"
