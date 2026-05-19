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
    --limit)
      if [[ "${2:-}" =~ ^[0-9]+$ && "$2" -gt 50 ]]; then
        echo "⚠️  envio-cloud deployment logs caps --limit at 50; using 50 instead of $2" >&2
        ARGS+=(--limit 50)
        shift 2
      else
        ARGS+=("$1")
        shift
        if [[ $# -gt 0 ]]; then
          ARGS+=("$1")
          shift
        fi
      fi
      ;;
    --limit=*)
      limit="${1#--limit=}"
      if [[ "$limit" =~ ^[0-9]+$ && "$limit" -gt 50 ]]; then
        echo "⚠️  envio-cloud deployment logs caps --limit at 50; using 50 instead of $limit" >&2
        ARGS+=(--limit=50)
      else
        ARGS+=("$1")
      fi
      shift
      ;;
    *)
      ARGS+=("$1")
      shift
      ;;
  esac
done

DEPLOYMENTS_JSON=$(pnpm exec envio-cloud indexer get "$ENVIO_INDEXER" "$ENVIO_ORG" -o json)
COMMIT=$(printf '%s' "$DEPLOYMENTS_JSON" | node -e "
    const target = process.argv[1];
    const { execFileSync } = require('child_process');
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    const deps = [...(d.data?.deployments ?? [])].sort((a,b) => b.created_time.localeCompare(a.created_time));
    if (!target) {
      process.stdout.write(deps[0]?.commit_hash ?? '');
      process.exit(0);
    }
    let verifiedTarget = '';
    try {
      verifiedTarget = execFileSync('git', ['rev-parse', '--verify', target + '^{commit}'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {}
    const matches = deps.filter((dep) =>
      dep.commit_hash.startsWith(target) ||
      (verifiedTarget && verifiedTarget.startsWith(dep.commit_hash))
    );
    if (matches.length > 1) {
      console.error('Ambiguous deployment commit ' + target + ' matches: ' + matches.map((dep) => dep.commit_hash).join(', '));
      process.exit(2);
    }
    const match = matches[0];
    process.stdout.write(match?.commit_hash ?? '');
  " "$COMMIT")

if [[ -z "$COMMIT" ]]; then
  echo "❌ Deployment not found for $ENVIO_ORG/$ENVIO_INDEXER"
  echo "   Pass a registered short/full commit, or run deploy:indexer:status <commit> --watch first."
  exit 1
fi

if [[ "$JSON_OUTPUT" != "true" ]]; then
  echo "📋 Logs for deployment: $COMMIT"
  echo ""
fi

# Pass normalized flags through
pnpm exec envio-cloud deployment logs "$ENVIO_INDEXER" "$COMMIT" "$ENVIO_ORG" "${ARGS[@]}"
