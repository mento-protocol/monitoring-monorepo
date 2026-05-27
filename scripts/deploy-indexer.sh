#!/usr/bin/env bash
# Deploy indexer to Envio Hosted by pushing to either:
# - `envio` (default multichain deployment), or
# - `deploy/<network>` (legacy per-network deployments)
#
# Usage:
#   pnpm deploy:indexer              → push to `envio` branch (multichain mainnet, default)
#   pnpm deploy:indexer <network>    → push to `deploy/<network>` branch (legacy per-network)
#   pnpm deploy:indexer --yes        → skip confirmation prompt (CI / agent friendly)
#
# After pushing, use companion scripts:
#   pnpm deploy:indexer:status <commit> --watch → watch sync progress
#   pnpm deploy:indexer:promote <commit>        → promote deployment to prod
#   pnpm deploy:indexer:logs         → tail runtime logs
#
# Envio project: https://envio.dev/app/mento-protocol/mento

set -euo pipefail

# Single cleanup function for all exit paths. Conditionally removes
# PUSH_OUTPUT_FILE (set later) and always restores the cursor. Bash only
# keeps the last EXIT trap; consolidating here prevents the cursor-restore
# from being silently dropped by a future trap registration.
PUSH_OUTPUT_FILE=""
cleanup() {
  [[ -n "$PUSH_OUTPUT_FILE" ]] && rm -f "$PUSH_OUTPUT_FILE"
  tput cnorm 2>/dev/null || true
}

trap cleanup EXIT

VALID_NETWORKS=(celo-sepolia celo-mainnet monad-testnet monad-mainnet)
ENVIO_ORG="mento-protocol"
ENVIO_INDEXER="mento"

validate_network() {
  local n="$1"
  for valid in "${VALID_NETWORKS[@]}"; do
    if [[ "$n" == "$valid" ]]; then return 0; fi
  done
  return 1
}

# Parse flags
AUTO_YES=false
NETWORK=""
for arg in "$@"; do
  case "$arg" in
    --yes|-y) AUTO_YES=true ;;
    --) ;;
    *) NETWORK="$arg" ;;
  esac
done

# Default (no arg): deploy multichain indexer via `envio` branch
if [[ -z "$NETWORK" ]]; then
  DEPLOY_BRANCH="envio"
  SYNC_URL="https://envio.dev/app/${ENVIO_ORG}/${ENVIO_INDEXER}"
  echo "🌐 Deploying multichain indexer (Celo + Monad) → branch: $DEPLOY_BRANCH"
else
  if ! validate_network "$NETWORK"; then
    echo "Invalid network: $NETWORK"
    echo "Available: ${VALID_NETWORKS[*]}"
    echo "Example: pnpm deploy:indexer celo-mainnet"
    exit 1
  fi
  DEPLOY_BRANCH="deploy/${NETWORK}"
  SYNC_URL="https://envio.dev/app/${ENVIO_ORG}/mento-v3-${NETWORK}"
  echo "🚀 Deploying indexer (network: $NETWORK) → branch: $DEPLOY_BRANCH"
fi

# Check if we're on a clean working tree
if [[ -n "$(git status --porcelain)" ]]; then
  echo "❌ Working directory is not clean. Commit or stash your changes first."
  git status --short
  exit 1
fi

# Check if deploy branch exists on remote. When it doesn't, the first-time
# create push below IS the webhook trigger; the subsequent `HEAD:refs/heads/...`
# push will be a no-op ("Everything up-to-date"), but that's the create-push
# already-took-effect, not a missed webhook. Track this so the no-op handler
# below skips the envio-cloud "not registered" probe (which would race the
# 2-3 min webhook latency and misclassify a legitimate first-time deploy).
BRANCH_JUST_CREATED=false
if ! git ls-remote --heads origin "$DEPLOY_BRANCH" | grep -q "$DEPLOY_BRANCH"; then
  echo "⚠️  Deploy branch '$DEPLOY_BRANCH' does not exist on remote."
  echo "Creating it now from current main..."
  git push --no-verify origin "main:refs/heads/$DEPLOY_BRANCH"
  BRANCH_JUST_CREATED=true
fi

echo "   Branch: $DEPLOY_BRANCH"
echo ""

# Get current commit info. `--short=7` is explicit: Envio's API stores
# `commit_hash` truncated to exactly 7 chars, and the no-op-recovery probe
# below does `startswith($target)` against that field. If a user has
# `core.abbrev` set above 7 or the repo grows past the 7-char unique
# threshold, bare `--short` returns 8+ chars and the predicate silently
# matches zero rows — misclassifying a registered deployment as missing.
COMMIT_SHA=$(git rev-parse HEAD)
COMMIT_SHORT=$(git rev-parse --short=7 HEAD)
COMMIT_MSG=$(git log -1 --pretty=format:"%s" "$COMMIT_SHA")

echo "   Commit: $COMMIT_SHA"
echo "   Message: $COMMIT_MSG"
echo ""

# Confirm (skip with --yes)
if [[ "$AUTO_YES" == "false" ]]; then
  read -p "Push to $DEPLOY_BRANCH? [y/N] " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
  fi
fi

# Push current HEAD to deploy branch. Capture stdout+stderr so we can detect
# the "Everything up-to-date" no-op case: when the deploy branch already
# points at HEAD, git does not contact the remote, no push event is fired,
# and Envio's webhook never runs — but the script otherwise looks successful.
# Surface the case loudly so callers don't sit watching a non-existent build.
# LC_ALL=C forces English output so the grep sentinel below isn't broken
# by a non-English shell locale (gettext localises "Everything up-to-date").
PUSH_OUTPUT_FILE=$(mktemp)
if ! LC_ALL=C git push --no-verify --force-with-lease origin "HEAD:refs/heads/$DEPLOY_BRANCH" 2>&1 | tee "$PUSH_OUTPUT_FILE"; then
  echo "❌ Push to $DEPLOY_BRANCH failed."
  exit 1
fi

if grep -q "Everything up-to-date" "$PUSH_OUTPUT_FILE"; then
  if [[ "$BRANCH_JUST_CREATED" == "true" ]]; then
    # The earlier branch-create push (main:refs/heads/$DEPLOY_BRANCH) IS the
    # webhook trigger; this follow-up HEAD:refs/heads/... push is a no-op
    # because the ref already points at HEAD. The Envio webhook needs the
    # documented 2-3 min to register, so don't probe envio-cloud here — that
    # would race the latency and misclassify a legitimate first-time deploy
    # as a missed webhook. Continue to the post-deploy checklist.
    echo ""
    echo "ℹ️  Push was a no-op — '$DEPLOY_BRANCH' was just created from main and"
    echo "   already points at HEAD. The branch-create push is the webhook trigger;"
    echo "   skipping the no-op probe (registration normally takes 2-3 min)."
    echo ""
  else
    # No-op push has two distinct meanings depending on whether Envio already
    # has a registered deployment for this SHA:
    #   (a) registered → legitimate idempotent re-run (interrupted babysit /
    #       fresh shell wanting to resume status/promote). Continue to the
    #       post-deploy checklist; the operator already has a deployment to
    #       watch / promote.
    #   (b) not registered → the webhook missed the original push event and
    #       there's nothing for Envio to react to. Stop and tell the operator
    #       to retrigger with a fresh-SHA empty commit.
    # The multichain `envio` branch maps to the `mento` indexer; legacy
    # per-network deploy branches each have their own `mento-v3-<network>`
    # indexer. Probe the right one.
    if [[ -z "$NETWORK" ]]; then
      PROBE_INDEXER="$ENVIO_INDEXER"
    else
      PROBE_INDEXER="mento-v3-$NETWORK"
    fi
    REGISTERED_FOR_SHA=$(pnpm exec envio-cloud indexer get "$PROBE_INDEXER" "$ENVIO_ORG" -o json 2>/dev/null \
      | jq -r --arg target "$COMMIT_SHORT" \
          'first(.data.deployments[]? | select(.commit_hash | startswith($target)) | .commit_hash) // ""')

    if [[ -n "$REGISTERED_FOR_SHA" ]]; then
      echo ""
      echo "ℹ️  Push was a no-op — '$DEPLOY_BRANCH' already at $COMMIT_SHORT."
      echo "   Envio already has a registered deployment for this commit, so this is a"
      echo "   legitimate re-run (e.g. resuming after an interrupted babysit). Continuing"
      echo "   with the post-deploy checklist so you can watch / promote the existing"
      echo "   deployment."
      echo ""
    else
      echo ""
      echo "⚠️  Push was a no-op — '$DEPLOY_BRANCH' already at $COMMIT_SHORT,"
      echo "   and Envio has NO registered deployment for this commit. Their webhook"
      echo "   missed the original push event; pushing the same SHA again won't help"
      echo "   because git skips the ref-update over the wire. Retrigger with a"
      echo "   fresh-SHA empty commit:"
      echo ""
      echo "     git commit --allow-empty -m 'chore: re-trigger envio webhook'"
      if [[ -z "$NETWORK" ]]; then
        echo "     pnpm deploy:indexer --yes"
      else
        echo "     pnpm deploy:indexer $NETWORK --yes"
      fi
      echo ""
      echo "   If Envio's webhook keeps dropping events, escalate via"
      echo "   https://discord.gg/envio — the CLI has no manual build-trigger."
      exit 2
    fi
  fi
fi

echo ""
echo "✅ Pushed to $DEPLOY_BRANCH"
echo "   Envio will automatically redeploy the indexer."
echo ""
echo "📋 POST-DEPLOY CHECKLIST:"
echo ""
echo "   1. Watch sync progress:"
echo "      pnpm deploy:indexer:status $COMMIT_SHA --watch"
echo "      $SYNC_URL"
echo ""
echo "   2. Once synced, promote to prod:"
echo "      pnpm deploy:indexer:promote $COMMIT_SHA"
echo ""
echo "   3. Verify the dashboard:"
echo "      https://monitoring.mento.org"
echo ""
