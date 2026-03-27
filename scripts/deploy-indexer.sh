#!/usr/bin/env bash
# Deploy indexer to Envio Hosted by pushing to a deploy branch.
#
# Usage:
#   pnpm deploy:indexer              → push to `envio` branch (multichain mainnet, default)
#   pnpm deploy:indexer <network>    → push to `deploy/<network>` branch (legacy per-network)
#
# Envio project: https://envio.dev/app/mento-protocol/mento-v3-celo-sepolia
#   (repurposed for multichain; triggered by `envio` branch pushes)

set -euo pipefail

restore_cursor() {
  tput cnorm 2>/dev/null || true
}

trap restore_cursor EXIT

VALID_NETWORKS=(celo-sepolia celo-mainnet monad-testnet monad-mainnet)

validate_network() {
  local n="$1"
  for valid in "${VALID_NETWORKS[@]}"; do
    if [[ "$n" == "$valid" ]]; then return 0; fi
  done
  return 1
}

render_network_menu() {
  local selected="$1"
  local i

  printf 'Select network to deploy (use arrow keys, Enter to confirm):\n'
  for i in "${!VALID_NETWORKS[@]}"; do
    if [[ "$i" -eq "$selected" ]]; then
      printf ' > %s\n' "${VALID_NETWORKS[$i]}"
    else
      printf '   %s\n' "${VALID_NETWORKS[$i]}"
    fi
  done
}

choose_network_interactively() {
  local selected=0
  local key=""
  local menu_lines=$(( ${#VALID_NETWORKS[@]} + 1 ))

  tput civis 2>/dev/null || true
  render_network_menu "$selected"

  while IFS= read -rsn1 key; do
    if [[ "$key" == $'\x1b' ]]; then
      IFS= read -rsn2 key || true
      case "$key" in
        "[A")
          selected=$(( (selected - 1 + ${#VALID_NETWORKS[@]}) % ${#VALID_NETWORKS[@]} ))
          ;;
        "[B")
          selected=$(( (selected + 1) % ${#VALID_NETWORKS[@]} ))
          ;;
      esac
    elif [[ -z "$key" ]]; then
      break
    fi

    printf '\033[%sA' "$menu_lines"
    printf '\033[J'
    render_network_menu "$selected"
  done

  tput cnorm 2>/dev/null || true
  printf '\n'
  NETWORK="${VALID_NETWORKS[$selected]}"
}

prompt_for_network() {
  if [[ -t 0 && -t 1 ]]; then
    choose_network_interactively
    return
  fi

  echo "Select network to deploy:"
  for i in "${!VALID_NETWORKS[@]}"; do
    echo "  $((i + 1))) ${VALID_NETWORKS[$i]}"
  done
  echo ""
  read -p "Enter number or network name: " choice
  if [[ "$choice" =~ ^[1-4]$ ]]; then
    NETWORK="${VALID_NETWORKS[$((choice - 1))]}"
  else
    NETWORK="$choice"
  fi
}

if [[ "${1:-}" == "--" ]]; then
  shift
fi

NETWORK="${1:-}"

# Default (no arg): deploy multichain indexer via `envio` branch
if [[ -z "$NETWORK" ]]; then
  DEPLOY_BRANCH="envio"
  echo "🌐 Deploying multichain indexer (Celo + Monad) → branch: $DEPLOY_BRANCH"
else
  if ! validate_network "$NETWORK"; then
    echo "Invalid network: $NETWORK"
    echo "Available: ${VALID_NETWORKS[*]}"
    echo "Example: pnpm deploy:indexer celo-mainnet"
    exit 1
  fi
  DEPLOY_BRANCH="deploy/${NETWORK}"
  echo "🚀 Deploying indexer (network: $NETWORK) → branch: $DEPLOY_BRANCH"
fi

# Check if we're on a clean working tree
if [[ -n "$(git status --porcelain)" ]]; then
  echo "❌ Working directory is not clean. Commit or stash your changes first."
  git status --short
  exit 1
fi

# Check if deploy branch exists on remote
if ! git ls-remote --heads origin "$DEPLOY_BRANCH" | grep -q "$DEPLOY_BRANCH"; then
  echo "⚠️  Deploy branch '$DEPLOY_BRANCH' does not exist on remote."
  echo "Creating it now from current main..."
  git push --no-verify origin "main:refs/heads/$DEPLOY_BRANCH"
fi

echo "   Branch: $DEPLOY_BRANCH"
echo ""

# Get current commit info
COMMIT_SHA=$(git rev-parse HEAD)
COMMIT_MSG=$(git log -1 --pretty=format:"%s" "$COMMIT_SHA")

echo "   Commit: $COMMIT_SHA"
echo "   Message: $COMMIT_MSG"
echo ""

# Confirm
read -p "Push to $DEPLOY_BRANCH? [y/N] " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi

# Push current HEAD to deploy branch
git push --no-verify --force-with-lease origin "HEAD:refs/heads/$DEPLOY_BRANCH"

echo ""
echo "✅ Pushed to $DEPLOY_BRANCH"
echo "   Envio will automatically redeploy the indexer."
echo ""
echo "📋 POST-DEPLOY CHECKLIST:"
echo ""
echo "   1. Watch sync progress:"
echo "      https://envio.dev/app/mento-protocol/mento-v3-celo-sepolia"
echo ""
echo "   2. Once synced, verify the dashboard:"
echo "      https://monitoring.mento.org"
echo ""
