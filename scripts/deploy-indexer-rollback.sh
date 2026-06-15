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
ENVIO_MAX_DEPLOYMENTS=3

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
DEPLOYMENT_COUNT=$(printf "%s" "$DEPLOYMENTS_JSON" | jq -r '(.data.deployments // []) | length')
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

  # `envio-cloud deployment promote` supports --yes; this wrapper already asked
  # the operator to confirm before delegating to the promote wrapper.
  pnpm deploy:indexer:promote "$REGISTERED" --yes
  exit 0
fi

FULL_SHA=""
git fetch --quiet origin "+refs/heads/$DEPLOY_BRANCH:refs/remotes/origin/$DEPLOY_BRANCH"
if ! FULL_SHA=$(git rev-parse --verify --quiet "$TARGET^{commit}"); then
  echo "Target $TARGET is not registered on Envio and is not a commit in this clone."
  echo "Run 'git fetch origin' and retry, or pick a SHA from:"
  echo "  pnpm --silent exec envio-cloud indexer get $ENVIO_INDEXER $ENVIO_ORG -o json | jq '.data.deployments'"
  exit 1
fi
SHORT_SHA=$(git rev-parse --short=7 "$FULL_SHA")

if ! git merge-base --is-ancestor "$FULL_SHA" "origin/$DEPLOY_BRANCH"; then
  echo "Target $SHORT_SHA is not in origin/$DEPLOY_BRANCH history."
  echo "Refusing slow rollback to a commit that is not known on the deploy branch."
  echo "Pick a last-good deployed commit from:"
  echo "  git log --oneline origin/$DEPLOY_BRANCH"
  exit 1
fi

echo "Deployment $TARGET is no longer registered on Envio: slow rollback."
echo "   Plan: force-push $SHORT_SHA to '$DEPLOY_BRANCH', wait for full resync, then promote."
echo "   Envio live deployments: $DEPLOYMENT_COUNT/$ENVIO_MAX_DEPLOYMENTS"
echo ""
echo "   git push --force-with-lease origin $FULL_SHA:refs/heads/$DEPLOY_BRANCH"
echo ""

if (( DEPLOYMENT_COUNT >= ENVIO_MAX_DEPLOYMENTS )); then
  echo "Envio already has $DEPLOYMENT_COUNT live deployments."
  echo "Delete a stale non-prod deployment first, then rerun rollback before pushing:"
  echo "  https://envio.dev/app/$ENVIO_ORG/$ENVIO_INDEXER"
  exit 1
fi

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

if ! PUSH_OUTPUT=$(LC_ALL=C git push --force-with-lease origin "$FULL_SHA:refs/heads/$DEPLOY_BRANCH" 2>&1 | tee /dev/stderr); then
  echo "Push to $DEPLOY_BRANCH failed."
  exit 1
fi

POST_PUSH_MESSAGE="Pushed $SHORT_SHA to $DEPLOY_BRANCH. Envio will rebuild and resync from scratch."

if grep -q "Everything up-to-date" <<<"$PUSH_OUTPUT"; then
  set +e
  DEPLOYMENTS_AFTER_NOOP_JSON=$(pnpm --silent exec envio-cloud indexer get "$ENVIO_INDEXER" "$ENVIO_ORG" -o json 2>/dev/null)
  DEPLOYMENTS_AFTER_NOOP_STATUS=$?
  REGISTERED_AFTER_NOOP=""
  if [[ "$DEPLOYMENTS_AFTER_NOOP_STATUS" -eq 0 ]]; then
    REGISTERED_AFTER_NOOP=$(printf "%s" "$DEPLOYMENTS_AFTER_NOOP_JSON" \
      | node scripts/resolve-envio-deployment.mjs "$FULL_SHA" 2>/dev/null)
  fi
  set -e
  REGISTERED_AFTER_NOOP="${REGISTERED_AFTER_NOOP:-}"

  if [[ -n "$REGISTERED_AFTER_NOOP" ]]; then
    POST_PUSH_MESSAGE="Push was a no-op: '$DEPLOY_BRANCH' already points at $SHORT_SHA and Envio has registered deployment $REGISTERED_AFTER_NOOP."
  else
    echo ""
    echo "Push was a no-op: '$DEPLOY_BRANCH' already points at $SHORT_SHA,"
    echo "and Envio has no registered deployment for it, so no webhook will fire."
    echo "Retrigger with a fresh SHA:"
    echo "  git checkout $FULL_SHA"
    echo "  git commit --allow-empty -m 'chore: retrigger envio deploy for rollback'"
    echo "  git push origin HEAD:refs/heads/$DEPLOY_BRANCH"
    exit 2
  fi
fi

echo ""
echo "$POST_PUSH_MESSAGE"
if [[ "$POST_PUSH_MESSAGE" == Push\ was\ a\ no-op:* ]]; then
  echo "Continue with the post-deploy checklist for that existing deployment."
fi
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
