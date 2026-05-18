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

DEPLOYMENTS_JSON=$(pnpm exec envio-cloud indexer get "$ENVIO_INDEXER" "$ENVIO_ORG" -o json 2>/dev/null)
COMMIT=$(printf '%s' "$DEPLOYMENTS_JSON" | node -e "
    const target = process.argv[1];
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    const deps = [...(d.data?.deployments ?? [])].sort((a,b) => b.created_time.localeCompare(a.created_time));
    const match = target
      ? deps.find((dep) => target.startsWith(dep.commit_hash) || dep.commit_hash.startsWith(target))
      : deps[0];
    process.stdout.write(match?.commit_hash ?? '');
  " "$COMMIT")

if [[ -z "$COMMIT" ]]; then
  echo "❌ Deployment not found for $ENVIO_ORG/$ENVIO_INDEXER"
  echo "   Pass a registered short/full commit, or run deploy:indexer:status <commit> --watch first."
  exit 1
fi

echo "📋 Logs for deployment: $COMMIT"
echo ""

# Pass all flags through
pnpm exec envio-cloud deployment logs "$ENVIO_INDEXER" "$COMMIT" "$ENVIO_ORG" "$@"
