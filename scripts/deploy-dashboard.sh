#!/usr/bin/env bash
# Deploys the ui-dashboard to Vercel (production).
#
# The script operates from the MONOREPO ROOT so that pnpm-lock.yaml is
# included in the upload and `pnpm install` succeeds on Vercel's build servers.
# It sets the project's rootDirectory to "ui-dashboard" via the Vercel REST API
# so that Next.js is detected and built from the correct subdirectory.
#
# Usage:
#   ./scripts/deploy-dashboard.sh          # deploy only
#   ./scripts/deploy-dashboard.sh --setup  # link + push env vars + deploy (first run)
#
# Environment variables (all optional):
#   VERCEL_TOKEN  — auth token (falls back to local CLI session)
#   VERCEL_SCOPE  — Vercel team/org slug (default: chapatis-projects)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERCEL_DIR="$REPO_ROOT/.vercel"
ENV_FILE="$REPO_ROOT/ui-dashboard/.env.production.local"

# Scope is required when the account has multiple teams.
# Only used during `vercel link` — NOT passed to `vercel deploy`, which reads
# the team from the local .vercel/project.json instead.
VERCEL_SCOPE="${VERCEL_SCOPE:-chapatis-projects}"

# ── Helpers ──────────────────────────────────────────────────────────────────

log() { printf '\033[1;34m▶\033[0m %s\n' "$*"; }
ok()  { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "'$1' not found. Install it first."
}

# Returns the Vercel auth token: VERCEL_TOKEN env var takes precedence,
# then falls back to the local CLI auth file (macOS).
get_token() {
  if [[ -n "${VERCEL_TOKEN:-}" ]]; then
    echo "$VERCEL_TOKEN"
    return
  fi
  local auth_file="$HOME/Library/Application Support/com.vercel.cli/auth.json"
  if [[ -f "$auth_file" ]]; then
    python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['token'])" "$auth_file"
    return
  fi
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
  rm -rf "$VERCEL_DIR" "$REPO_ROOT/ui-dashboard/.vercel"

  log "Linking Vercel project from monorepo root (scope: $VERCEL_SCOPE)…"
  # --scope is required here to find the project by name in the right team.
  (cd "$REPO_ROOT" && vercel link --yes \
    --project monitoring-ui-dashboard \
    --scope "$VERCEL_SCOPE" \
    "${VERCEL_TOKEN_ARGS[@]}")
  ok "Project linked → $VERCEL_DIR/project.json"

  # ── Set rootDirectory = "ui-dashboard" via Vercel REST API ─────────────────
  log "Configuring project rootDirectory = ui-dashboard…"
  PROJECT_ID=$(python3 -c "import json; print(json.load(open('$VERCEL_DIR/project.json'))['projectId'])")
  TEAM_ID=$(python3 -c "import json; print(json.load(open('$VERCEL_DIR/project.json'))['orgId'])")
  TOKEN=$(get_token)

  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -X PATCH "https://api.vercel.com/v9/projects/$PROJECT_ID?teamId=$TEAM_ID" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"rootDirectory": "ui-dashboard"}')

  [[ "$HTTP_STATUS" == "200" ]] \
    || die "Failed to set rootDirectory (HTTP $HTTP_STATUS). Check your token/permissions."
  ok "rootDirectory set to ui-dashboard"

  # ── Env vars ───────────────────────────────────────────────────────────────

  if [[ ! -f "$ENV_FILE" ]]; then
    die "No env file found at $ENV_FILE — copy ui-dashboard/.env.production.local.example and fill in values."
  fi

  log "Pushing env vars to Vercel (production)…"

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

    printf '%s\n' "$VALUE" \
      | (cd "$REPO_ROOT" && vercel env add "$KEY" production \
          --scope "$VERCEL_SCOPE" \
          "${VERCEL_TOKEN_ARGS[@]}" \
          --force) \
      && ok "  $KEY"
  done < "$ENV_FILE"
fi

# ── Deploy ───────────────────────────────────────────────────────────────────
# No --scope here: vercel deploy reads the project/team from .vercel/project.json.
# Passing --scope triggers a project lookup that can fail with API inconsistencies.

log "Deploying to production…"
(cd "$REPO_ROOT" && vercel deploy --prod "${VERCEL_TOKEN_ARGS[@]}")
ok "Deploy complete!"
