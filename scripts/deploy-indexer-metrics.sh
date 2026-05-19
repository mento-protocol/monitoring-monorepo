#!/usr/bin/env bash
# Show Envio deployment indexing metrics.
#
# Usage:
#   pnpm deploy:indexer:metrics                -> latest deployment metrics
#   pnpm deploy:indexer:metrics <commit>       -> specific deployment metrics
#
# Requires: workspace envio-cloud CLI dependency, authenticated (run `pnpm exec envio-cloud login` first)

set -euo pipefail

ENVIO_ORG="mento-protocol"
ENVIO_INDEXER="mento"

COMMIT=""
if [[ $# -gt 0 && "$1" != -* ]]; then
  COMMIT="$1"
  shift
fi

ARGS=()
JSON_OUTPUT=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --json|-j)
      JSON_OUTPUT=true
      ARGS+=(-o json)
      shift
      ;;
    -o|--output)
      ARGS+=("$1")
      shift
      if [[ $# -gt 0 ]]; then
        if [[ "$1" == "json" ]]; then
          JSON_OUTPUT=true
        fi
        ARGS+=("$1")
        shift
      fi
      ;;
    --output=*)
      if [[ "${1#--output=}" == "json" ]]; then
        JSON_OUTPUT=true
      fi
      ARGS+=("$1")
      shift
      ;;
    *)
      ARGS+=("$1")
      shift
      ;;
  esac
done

COMMIT=$(pnpm exec envio-cloud indexer get "$ENVIO_INDEXER" "$ENVIO_ORG" -o json \
  | node scripts/resolve-envio-deployment.mjs "$COMMIT")

if [[ -z "$COMMIT" ]]; then
  echo "Deployment not found for $ENVIO_ORG/$ENVIO_INDEXER"
  echo "Wait for registration with: pnpm deploy:indexer:status <commit> --watch"
  exit 1
fi

if [[ "$JSON_OUTPUT" != "true" ]]; then
  echo "Metrics for deployment: $COMMIT"
  echo ""
fi
pnpm exec envio-cloud deployment metrics "$ENVIO_INDEXER" "$COMMIT" "$ENVIO_ORG" "${ARGS[@]}"
