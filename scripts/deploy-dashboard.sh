#!/usr/bin/env bash
# Deploys the ui-dashboard to Vercel (production).
#
# The script operates from the MONOREPO ROOT so that pnpm-lock.yaml is
# included in the upload and `pnpm install` succeeds on Vercel's build servers.
#
# Project setup (creation, rootDirectory, env vars, GitHub secrets) is managed
# by Terraform. Run `terraform apply` in terraform/ before the first deploy.
#
# Usage:
#   ./scripts/deploy-dashboard.sh
#
# Environment variables (optional):
#   VERCEL_TOKEN  — auth token (falls back to local CLI session)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERCEL_DIR="$REPO_ROOT/.vercel"

# ── Helpers ───────────────────────────────────────────────────────────────────

log() { printf '\033[1;34m▶\033[0m %s\n' "$*"; }
ok()  { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "'$1' not found. Install it first."
}

# ── Preflight ─────────────────────────────────────────────────────────────────

require_cmd vercel

VERCEL_TOKEN_ARGS=()
[[ -n "${VERCEL_TOKEN:-}" ]] && VERCEL_TOKEN_ARGS=(--token "$VERCEL_TOKEN")

[[ -d "$VERCEL_DIR" ]] \
  || die ".vercel/ not found. Run 'terraform apply' in terraform/ first."

log "Checking Vercel authentication…"
vercel whoami "${VERCEL_TOKEN_ARGS[@]}" 2>/dev/null \
  || die "Not logged in. Set VERCEL_TOKEN or run: vercel login"
ok "Logged in as $(vercel whoami "${VERCEL_TOKEN_ARGS[@]}" 2>/dev/null)"

# ── Deploy ────────────────────────────────────────────────────────────────────
# No --scope: vercel deploy reads project/team from .vercel/project.json,
# which is written by Terraform's local_file resource.

log "Deploying to production…"
(cd "$REPO_ROOT" && vercel deploy --prod "${VERCEL_TOKEN_ARGS[@]}")
ok "Deploy complete!"
