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

COMMIT="${1:-}"
if [[ -n "$COMMIT" && "$COMMIT" != -* ]]; then
  shift
else
  COMMIT=""
fi

JSON_OUTPUT=false
for arg in "$@"; do
  case "$arg" in
    -o=json|--output=json) JSON_OUTPUT=true ;;
    -o|--output) ;;
    json) JSON_OUTPUT=true ;;
  esac
done

COMMIT=$(pnpm exec envio-cloud indexer get "$ENVIO_INDEXER" "$ENVIO_ORG" -o json \
  | node -e "
    const target = process.argv[1];
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    const deps = [...(d.data?.deployments ?? [])].sort((a,b) => b.created_time.localeCompare(a.created_time));
    if (!target) {
      process.stdout.write(deps[0]?.commit_hash ?? '');
      process.exit(0);
    }
    const matches = deps.filter((dep) => target.startsWith(dep.commit_hash) || dep.commit_hash.startsWith(target));
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
  echo "Metrics for deployment: $COMMIT"
  echo ""
fi
pnpm exec envio-cloud deployment metrics "$ENVIO_INDEXER" "$COMMIT" "$ENVIO_ORG" "$@"
