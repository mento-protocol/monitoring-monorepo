#!/usr/bin/env bash
# Tail runtime logs for the latest Envio indexer deployment.
#
# Usage:
#   pnpm deploy:indexer:logs                → latest deployment logs
#   pnpm deploy:indexer:logs <commit>       → specific deployment logs
#   pnpm deploy:indexer:logs <commit> --follow       → follow/tail logs
#   pnpm deploy:indexer:logs <commit> --level error  → filter by level (trace,debug,info,warn,error)
#   pnpm deploy:indexer:logs <commit> --build        → show build logs instead
#   pnpm deploy:indexer:logs --json         → JSON output
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

DEPLOYMENTS_JSON=$(pnpm exec envio-cloud indexer get "$ENVIO_INDEXER" "$ENVIO_ORG" -o json)
COMMIT=$(printf '%s' "$DEPLOYMENTS_JSON" | node scripts/resolve-envio-deployment.mjs "$COMMIT")

if [[ -z "$COMMIT" ]]; then
  echo "❌ Deployment not found for $ENVIO_ORG/$ENVIO_INDEXER"
  echo "   Pass a registered short/full commit, or run deploy:indexer:status <commit> --watch --compact first."
  exit 1
fi

if [[ "$JSON_OUTPUT" != "true" ]]; then
  echo "📋 Logs for deployment: $COMMIT"
  echo ""
fi

# Pass normalized flags through
pnpm exec envio-cloud deployment logs "$ENVIO_INDEXER" "$COMMIT" "$ENVIO_ORG" "${ARGS[@]}"
