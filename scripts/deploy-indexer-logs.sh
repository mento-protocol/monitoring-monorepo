#!/usr/bin/env bash
# Tail runtime logs for the latest Envio indexer deployment.
#
# Usage:
#   pnpm deploy:indexer:logs                → latest deployment logs
#   pnpm deploy:indexer:logs <commit>       → specific deployment logs
#   pnpm deploy:indexer:logs <commit> --follow       → follow/tail logs
#   pnpm deploy:indexer:logs <commit> --level error  → filter by level (trace,debug,info,warn,error)
#   pnpm deploy:indexer:logs <commit> --errors-only --since 2h → explicitly marked runtime errors only
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
ERRORS_ONLY=false
FOLLOW=false
BUILD_LOGS=false
LEVEL_FILTER_SET=false
OUTPUT_FORMAT_SET=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --errors-only)
      ERRORS_ONLY=true
      JSON_OUTPUT=true
      shift
      ;;
    --follow|-f)
      FOLLOW=true
      ARGS+=("$1")
      shift
      ;;
    --follow=*)
      case "${1#--follow=}" in
        true|True|TRUE|1|t|T)
          FOLLOW=true
          ;;
      esac
      ARGS+=("$1")
      shift
      ;;
    --build)
      BUILD_LOGS=true
      ARGS+=("$1")
      shift
      ;;
    --build=*)
      case "${1#--build=}" in
        true|True|TRUE|1|t|T)
          BUILD_LOGS=true
          ;;
      esac
      ARGS+=("$1")
      shift
      ;;
    --json|-j)
      JSON_OUTPUT=true
      ARGS+=(-o json)
      shift
      ;;
    --level)
      LEVEL_FILTER_SET=true
      ARGS+=("$1")
      shift
      if [[ $# -gt 0 ]]; then
        ARGS+=("$1")
        shift
      fi
      ;;
    --level=*)
      LEVEL_FILTER_SET=true
      ARGS+=("$1")
      shift
      ;;
    -o|--output)
      OUTPUT_FORMAT_SET=true
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
      OUTPUT_FORMAT_SET=true
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

if [[ "$ERRORS_ONLY" == "true" && "$FOLLOW" == "true" ]]; then
  echo "deploy:indexer:logs: --errors-only cannot be combined with --follow"
  exit 2
fi
if [[ "$ERRORS_ONLY" == "true" && "$BUILD_LOGS" == "true" ]]; then
  echo "deploy:indexer:logs: --errors-only filters runtime logs and cannot be combined with --build"
  exit 2
fi
if [[ "$ERRORS_ONLY" == "true" && "$LEVEL_FILTER_SET" == "true" ]]; then
  echo "deploy:indexer:logs: --errors-only owns the Envio --level filter"
  exit 2
fi
if [[ "$ERRORS_ONLY" == "true" && "$OUTPUT_FORMAT_SET" == "true" ]]; then
  echo "deploy:indexer:logs: --errors-only owns the Envio output format"
  exit 2
fi
if [[ "$ERRORS_ONLY" == "true" ]]; then
  ARGS+=(--level error)
  ARGS+=(-o json)
fi

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

# Pass normalized flags through. The Envio API's --level filter can retain
# stdout-carried records, so --errors-only applies a local filter to its JSON
# response and retains only records explicitly marked as errors.
if [[ "$ERRORS_ONLY" == "true" ]]; then
  pnpm exec envio-cloud deployment logs "$ENVIO_INDEXER" "$COMMIT" "$ENVIO_ORG" "${ARGS[@]}" |
    node scripts/filter-envio-runtime-errors.mjs
else
  pnpm exec envio-cloud deployment logs "$ENVIO_INDEXER" "$COMMIT" "$ENVIO_ORG" "${ARGS[@]}"
fi
