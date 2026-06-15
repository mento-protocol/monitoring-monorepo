#!/usr/bin/env bash
# Roll back the prod Envio indexer to a known-good commit after a bad promotion.
#
# Usage:
#   pnpm deploy:indexer:rollback <last-good-sha>
#   pnpm deploy:indexer:rollback <last-good-sha> --yes
#   pnpm deploy:indexer:rollback <last-good-sha> --dry-run
#
# Fast path: re-promote a still-registered Envio deployment.
# Slow path: force-push the last-good SHA to the envio branch for rebuild.

set -euo pipefail

ENVIO_ORG="mento-protocol"
ENVIO_INDEXER="mento"
DEPLOY_BRANCH="envio"

REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$REPO_ROOT"

TARGET=""
AUTO_YES=false
DRY_RUN=false

for arg in "$@"; do
  case "$arg" in
    --yes|-y) AUTO_YES=true ;;
    --dry-run) DRY_RUN=true ;;
    --) ;;
    -*) echo "Unknown flag: $arg"; exit 1 ;;
    *)
      if [[ -n "$TARGET" ]]; then
        echo "Unexpected extra target: $arg"
        exit 1
      fi
      TARGET="$arg"
      ;;
  esac
done

if [[ -z "$TARGET" ]]; then
  echo "Usage: pnpm deploy:indexer:rollback <last-good-sha> [--yes] [--dry-run]"
  echo ""
  echo "Find candidates (the 'prod' row is what is serving right now):"
  echo "  pnpm --silent exec envio-cloud indexer get $ENVIO_INDEXER $ENVIO_ORG -o json \\"
  echo "    | jq -r '.data.deployments[] | [.commit_hash, (.prod_status // \"-\"), .created_time] | @tsv'"
  exit 1
fi

DEPLOYMENTS_JSON=$(pnpm --silent exec envio-cloud indexer get "$ENVIO_INDEXER" "$ENVIO_ORG" -o json)
CURRENT_PROD=$(printf "%s" "$DEPLOYMENTS_JSON" \
  | jq -r 'first(.data.deployments[]? | select(.prod_status == "prod") | .commit_hash) // "unknown"')
REGISTERED=$(printf "%s" "$DEPLOYMENTS_JSON" | node scripts/resolve-envio-deployment.mjs "$TARGET")

echo "Indexer rollback"
echo "   Indexer: $ENVIO_ORG/$ENVIO_INDEXER"
echo "   Current prod deployment: $CURRENT_PROD"
echo "   Rollback target: $TARGET"
echo ""

if [[ -n "$REGISTERED" ]]; then
  echo "Deployment $REGISTERED is still registered on Envio: fast rollback."
  echo "   Plan: pnpm deploy:indexer:promote $REGISTERED --yes"
  echo "   Roll forward later with: pnpm deploy:indexer:promote <fixed-sha>"
  echo ""

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "Dry run: nothing promoted."
    exit 0
  fi

  # shellcheck source=scripts/lib/deploy-guard.sh
  source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/deploy-guard.sh"

  if [[ "$AUTO_YES" == "false" ]]; then
    read -r -p "Promote $REGISTERED back to production? [y/N] " confirm
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
      echo "Aborted."
      exit 0
    fi
  fi

  pnpm deploy:indexer:promote "$REGISTERED" --yes
  exit 0
fi

FULL_SHA=""
if ! FULL_SHA=$(git rev-parse --verify --quiet "$TARGET^{commit}"); then
  echo "Target $TARGET is not registered on Envio and is not a commit in this clone."
  echo "Run 'git fetch origin' and retry, or pick a SHA from:"
  echo "  pnpm --silent exec envio-cloud indexer get $ENVIO_INDEXER $ENVIO_ORG -o json | jq '.data.deployments'"
  exit 1
fi
SHORT_SHA=$(git rev-parse --short=7 "$FULL_SHA")

echo "Deployment $TARGET is no longer registered on Envio: slow rollback."
echo "   Plan: force-push $SHORT_SHA to '$DEPLOY_BRANCH', wait for full resync, then promote."
echo "   If Envio already has 3 live deployments, delete a stale non-prod deployment first:"
echo "   https://envio.dev/app/$ENVIO_ORG/$ENVIO_INDEXER"
echo ""
echo "   git push --no-verify --force-with-lease origin $FULL_SHA:refs/heads/$DEPLOY_BRANCH"
echo ""

if [[ "$DRY_RUN" == "true" ]]; then
  echo "Dry run: nothing pushed."
  exit 0
fi

# shellcheck source=scripts/lib/deploy-guard.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/deploy-guard.sh"

if [[ "$AUTO_YES" == "false" ]]; then
  read -r -p "Force-push $SHORT_SHA to $DEPLOY_BRANCH? [y/N] " confirm
  if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
  fi
fi

if ! PUSH_OUTPUT=$(LC_ALL=C git push --no-verify --force-with-lease origin "$FULL_SHA:refs/heads/$DEPLOY_BRANCH" 2>&1 | tee /dev/stderr); then
  echo "Push to $DEPLOY_BRANCH failed."
  exit 1
fi

if grep -q "Everything up-to-date" <<<"$PUSH_OUTPUT"; then
  echo ""
  echo "Push was a no-op: '$DEPLOY_BRANCH' already points at $SHORT_SHA,"
  echo "but Envio has no registered deployment for it, so no webhook will fire."
  echo "Retrigger with a fresh SHA:"
  echo "  git checkout $FULL_SHA"
  echo "  git commit --allow-empty -m 'chore: retrigger envio deploy for rollback'"
  echo "  git push --no-verify origin HEAD:refs/heads/$DEPLOY_BRANCH"
  exit 2
fi

echo ""
echo "Pushed $SHORT_SHA to $DEPLOY_BRANCH. Envio will rebuild and resync from scratch."
echo ""
echo "Rollback checklist:"
echo ""
echo "  1. Watch sync progress:"
echo "     pnpm deploy:indexer:status $FULL_SHA --watch"
echo ""
echo "  2. Check build and runtime logs:"
echo "     pnpm deploy:indexer:logs $FULL_SHA --build"
echo "     pnpm deploy:indexer:logs $FULL_SHA --level error,warn --since 2h"
echo ""
echo "  3. Once synced, promote back to prod:"
echo "     pnpm deploy:indexer:promote $FULL_SHA"
echo ""
echo "  4. Verify the dashboard:"
echo "     https://monitoring.mento.org"
