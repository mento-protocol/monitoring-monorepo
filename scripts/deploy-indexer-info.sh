#!/usr/bin/env bash
# Show Envio deployment aggregator/configuration info.
#
# Usage:
#   pnpm deploy:indexer:info                -> latest deployment info
#   pnpm deploy:indexer:info <commit>       -> specific deployment info
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
  | node -e "
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
  echo "Deployment not found for $ENVIO_ORG/$ENVIO_INDEXER"
  echo "Wait for registration with: pnpm deploy:indexer:status <commit> --watch"
  exit 1
fi

if [[ "$JSON_OUTPUT" != "true" ]]; then
  echo "Info for deployment: $COMMIT"
  echo ""
fi
pnpm exec envio-cloud deployment info "$ENVIO_INDEXER" "$COMMIT" "$ENVIO_ORG" "${ARGS[@]}"
