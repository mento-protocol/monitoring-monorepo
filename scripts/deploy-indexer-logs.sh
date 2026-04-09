#!/usr/bin/env bash
# Tail runtime logs for the latest Envio indexer deployment.
#
# Usage:
#   pnpm deploy:indexer:logs                → last 100 log lines
#   pnpm deploy:indexer:logs --follow       → follow/tail logs
#   pnpm deploy:indexer:logs --level error  → filter by level (trace,debug,info,warn,error)
#   pnpm deploy:indexer:logs --build        → show build logs instead
#   pnpm deploy:indexer:logs --json         → JSON output
#
# Requires: npx envio-cloud, authenticated (run `npx envio-cloud login` first)

set -euo pipefail

ENVIO_ORG="mento-protocol"
ENVIO_INDEXER="mento"

# Get latest deployment commit hash
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

echo "📋 Logs for deployment: $COMMIT"
echo ""

# Pass all flags through
npx -q envio-cloud deployment logs "$ENVIO_INDEXER" "$COMMIT" "$ENVIO_ORG" "$@"
