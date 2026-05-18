#!/usr/bin/env bash
# Show sync status for an Envio indexer deployment.
#
# Usage:
#   pnpm deploy:indexer:status                  → show latest deployment status
#   pnpm deploy:indexer:status <commit>         → show specific deployment status
#   pnpm deploy:indexer:status <commit> --watch → poll until synced
#   pnpm deploy:indexer:status --json           → JSON output
#
# Requires: workspace envio-cloud CLI dependency

set -euo pipefail

ENVIO_ORG="mento-protocol"
ENVIO_INDEXER="mento"

# Parse flags
COMMIT=""
WATCH=false
JSON=false
for arg in "$@"; do
  case "$arg" in
    --watch|-w) WATCH=true ;;
    --json|-j) JSON=true ;;
    --) ;;
    *)
      if [[ -n "$COMMIT" ]]; then
        echo "❌ Unexpected argument: $arg"
        echo "Usage: pnpm deploy:indexer:status [<commit>] [--watch] [--json]"
        exit 1
      fi
      COMMIT="$arg"
      ;;
  esac
done

if [[ -z "$COMMIT" ]]; then
  # Get latest deployment commit hash
  COMMIT=$(pnpm exec envio-cloud indexer get "$ENVIO_INDEXER" "$ENVIO_ORG" -o json 2>/dev/null \
    | node -e "
      const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      const deps = d.data.deployments.sort((a,b) => b.created_time.localeCompare(a.created_time));
      console.log(deps[0]?.commit_hash ?? '');
    ")

  if [[ -z "$COMMIT" ]]; then
    echo "❌ No deployments found for $ENVIO_ORG/$ENVIO_INDEXER" >&2
    exit 1
  fi

  if [[ "$JSON" != "true" ]]; then
    echo "📊 Latest deployment: $COMMIT"
  fi
else
  if [[ "$JSON" != "true" ]]; then
    echo "📊 Deployment: $COMMIT"
  fi
fi

if [[ "$JSON" != "true" ]]; then
  echo ""
fi

EXTRA_FLAGS=()
if [[ "$WATCH" == "true" ]]; then
  EXTRA_FLAGS+=(--watch-till-synced)
fi
if [[ "$JSON" == "true" ]]; then
  EXTRA_FLAGS+=(-o json)
fi

pnpm exec envio-cloud deployment status "$ENVIO_INDEXER" "$COMMIT" "$ENVIO_ORG" "${EXTRA_FLAGS[@]}"
