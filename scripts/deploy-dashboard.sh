#!/usr/bin/env bash
# Deploys the ui-dashboard to Vercel (production).
#
# The script operates from the MONOREPO ROOT so that pnpm-lock.yaml is
# included in the upload and `pnpm install` succeeds on Vercel's build servers.
# It sets the project's rootDirectory via the Vercel REST API so that Next.js
# is detected and built from the correct subdirectory.
#
# Usage:
#   ./scripts/deploy-dashboard.sh          # deploy only
#   ./scripts/deploy-dashboard.sh --setup  # link + push env vars + deploy (first run)
#
# Environment variables (all optional):
#   VERCEL_TOKEN  — auth token (falls back to local CLI session)
#   VERCEL_SCOPE  — Vercel team/org slug (default: mentolabs)

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DASHBOARD_DIR="$REPO_ROOT/ui-dashboard"
VERCEL_DIR="$REPO_ROOT/.vercel"
ENV_FILE="$DASHBOARD_DIR/.env.production.local"
VERCEL_PROJECT="monitoring-ui-dashboard"
GITHUB_REPO="mento-protocol/monitoring-monorepo"

# Scope is required when the account has multiple teams.
# Only used during `vercel link` — NOT passed to `vercel deploy`, which reads
# the team from the local .vercel/project.json instead.
VERCEL_SCOPE="${VERCEL_SCOPE:-mentolabs}"

# ── Helpers ──────────────────────────────────────────────────────────────────

log() { printf '\033[1;34m▶\033[0m %s\n' "$*"; }
ok()  { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "'$1' not found. Install it first."
}

# Returns the Vercel auth token: VERCEL_TOKEN env var takes precedence,
# then falls back to the local CLI auth file (Linux XDG or macOS).
get_token() {
  if [[ -n "${VERCEL_TOKEN:-}" ]]; then
    echo "$VERCEL_TOKEN"
    return
  fi
  local xdg_data="${XDG_DATA_HOME:-$HOME/.local/share}"
  local candidates=(
    "$xdg_data/com.vercel.cli/auth.json"                         # Linux (XDG)
    "$HOME/Library/Application Support/com.vercel.cli/auth.json" # macOS
  )
  for auth_file in "${candidates[@]}"; do
    if [[ -f "$auth_file" ]]; then
      python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['token'])" "$auth_file"
      return
    fi
  done
  die "No auth token found. Set VERCEL_TOKEN or run: vercel login"
}

# ── Preflight ────────────────────────────────────────────────────────────────

require_cmd vercel
require_cmd curl
require_cmd python3

# Token args only — no --scope here. Scope is added explicitly per-command.
VERCEL_TOKEN_ARGS=()
[[ -n "${VERCEL_TOKEN:-}" ]] && VERCEL_TOKEN_ARGS=(--token "$VERCEL_TOKEN")

log "Checking Vercel authentication…"
vercel whoami "${VERCEL_TOKEN_ARGS[@]}" 2>/dev/null \
  || die "Not logged in. Run: vercel login"
ok "Logged in as $(vercel whoami "${VERCEL_TOKEN_ARGS[@]}" 2>/dev/null)"

# ── Link (first-time or --setup) ─────────────────────────────────────────────

SETUP=false
[[ "${1:-}" == "--setup" ]] && SETUP=true

if [[ "$SETUP" == "true" || ! -d "$VERCEL_DIR" ]]; then
  # Remove any stale links from previous attempts.
  rm -rf "$VERCEL_DIR" "$DASHBOARD_DIR/.vercel"

  log "Linking Vercel project from monorepo root (scope: $VERCEL_SCOPE)…"
  # --scope is required here to find the project by name in the right team.
  (cd "$REPO_ROOT" && vercel link --yes \
    --project "$VERCEL_PROJECT" \
    --scope "$VERCEL_SCOPE" \
    "${VERCEL_TOKEN_ARGS[@]}")
  ok "Project linked → $VERCEL_DIR/project.json"

  # ── Set rootDirectory via Vercel REST API ───────────────────────────────────
  DASHBOARD_SUBDIR="${DASHBOARD_DIR##*/}"
  log "Configuring project rootDirectory = ${DASHBOARD_SUBDIR}…"
  PROJECT_ID=$(python3 -c "import json; print(json.load(open('$VERCEL_DIR/project.json'))['projectId'])")
  TEAM_ID=$(python3 -c "import json; print(json.load(open('$VERCEL_DIR/project.json'))['orgId'])")
  TOKEN=$(get_token)

  # Only deploy when files inside ui-dashboard actually changed.
  IGNORED_BUILD_CMD="git diff HEAD^ HEAD --quiet -- ui-dashboard"

  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -X PATCH "https://api.vercel.com/v9/projects/$PROJECT_ID?teamId=$TEAM_ID" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"rootDirectory\": \"$DASHBOARD_SUBDIR\", \"commandForIgnoringBuildStep\": \"$IGNORED_BUILD_CMD\"}")

  [[ "$HTTP_STATUS" == "200" ]] \
    || die "Failed to configure project (HTTP $HTTP_STATUS). Check your token/permissions."
  ok "rootDirectory set to $DASHBOARD_SUBDIR"
  ok "Ignored build step: $IGNORED_BUILD_CMD"

  # ── Env vars ───────────────────────────────────────────────────────────────

  if [[ ! -f "$ENV_FILE" ]]; then
    die "No env file found at $ENV_FILE — copy $DASHBOARD_DIR/.env.production.local.example and fill in values."
  fi

  log "Pushing env vars to Vercel (production + preview)…"

  while IFS= read -r line || [[ -n "$line" ]]; do
    # Skip blanks and comments
    [[ -z "$line" || "$line" == \#* ]] && continue

    KEY="${line%%=*}"
    VALUE="${line#*=}"
    # Strip surrounding quotes if present
    VALUE="${VALUE%\"}"
    VALUE="${VALUE#\"}"
    VALUE="${VALUE%\'}"
    VALUE="${VALUE#\'}"

    # Skip vars with no value — piping an empty string to vercel env add stores
    # a newline character, which Next.js treats as a truthy non-empty string.
    if [[ -z "$VALUE" ]]; then
      log "  Skipping $KEY (empty value)"
      continue
    fi

    for env in production preview; do
      printf '%s\n' "$VALUE" \
        | (cd "$REPO_ROOT" && vercel env add "$KEY" "$env" \
            --scope "$VERCEL_SCOPE" \
            "${VERCEL_TOKEN_ARGS[@]}" \
            --force) \
        && ok "  $KEY → $env"
    done
  done < "$ENV_FILE"

  # ── GitHub Actions secrets ─────────────────────────────────────────────────
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    log "Setting GitHub Actions secrets for CI auto-deploy…"

    gh secret set VERCEL_TOKEN      --body "$TOKEN"      --repo "$GITHUB_REPO"
    gh secret set VERCEL_ORG_ID     --body "$TEAM_ID"    --repo "$GITHUB_REPO"
    gh secret set VERCEL_PROJECT_ID --body "$PROJECT_ID" --repo "$GITHUB_REPO"
    ok "GitHub secrets set (VERCEL_TOKEN, VERCEL_ORG_ID, VERCEL_PROJECT_ID)"
  else
    log "gh CLI not found or not authenticated — skipping GitHub secrets."
    log "Set these secrets manually at github.com/$GITHUB_REPO/settings/secrets/actions:"
    log "  VERCEL_TOKEN      = (create at vercel.com → Account Settings → Tokens)"
    log "  VERCEL_ORG_ID     = $TEAM_ID"
    log "  VERCEL_PROJECT_ID = $PROJECT_ID"
  fi
fi

# ── Deploy ───────────────────────────────────────────────────────────────────
# No --scope here: vercel deploy reads the project/team from .vercel/project.json.
# Passing --scope triggers a project lookup that can fail with API inconsistencies.

log "Deploying to production…"
(cd "$REPO_ROOT" && vercel deploy --prod "${VERCEL_TOKEN_ARGS[@]}")
ok "Deploy complete!"
