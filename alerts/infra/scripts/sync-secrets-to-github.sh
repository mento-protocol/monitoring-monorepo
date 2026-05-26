#!/bin/bash
#
# GitHub Actions Secret Sync Script (alerts/infra)
#
# Purpose:
#   Push the 8 `TF_VAR_*` repo secrets that `.github/workflows/alerts-infra.yml`
#   needs to plan + apply the `alerts/infra/` Terraform stack. Values come
#   from the local (gitignored) `terraform.tfvars` so the workflow's env
#   block can read them as `${{ secrets.TF_VAR_* }}`.
#
#   Without these secrets set, the workflow's plan and apply jobs run with
#   empty `TF_VAR_*` env vars; `terraform plan/apply` then fails at
#   variable validation (each input has `length(var.X) > 0` or similar).
#
# Usage:
#   ./alerts/infra/scripts/sync-secrets-to-github.sh
#
# Requirements:
#   - `gh` CLI authenticated with `repo` scope (`gh auth status`).
#   - `alerts/infra/terraform.tfvars` populated with all 8 variables.
#
# What it does:
#   1. Pre-flights: tfvars file exists, `gh` is authenticated.
#   2. For each of 8 mapped variables, reads the value from tfvars and
#      sends it via `gh secret set --body-file -` (stdin, no shell expansion).
#   3. Reports which secrets were set; fails loudly if any tfvars value is
#      missing or empty.
#
# Safety:
#   - Idempotent — re-running overwrites existing secrets with current values.
#   - Never echoes secret VALUES; only the secret NAMES.
#   - `gh secret set --body-file -` reads stdin verbatim — no shell
#     interpolation of secret content (handles `$`, backticks, etc.).
#
# When to re-run:
#   - After rotating any of: sentry_auth_token, discord_bot_token,
#     quicknode_api_key, quicknode_signing_secret.
#   - After changing discord_server_id / discord_category_id /
#     discord_sentry_role_id (e.g. moving Discord servers).
#   - After adding a new TF_VAR_* in this script (update the SECRET_MAP).

set -euo pipefail

# Source common utilities for info/warn/error/check_tools/read_tfvars_value
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

# Operate from the alerts/infra module dir so read_tfvars_value finds
# terraform.tfvars relative to itself (matches the other scripts here).
MODULE_DIR="$(get_module_dir)"
cd "${MODULE_DIR}"

check_tools "gh"

# Map: tfvars key (lowercase, as it appears in terraform.tfvars) →
# GitHub Actions secret name (uppercase, matches `secrets.TF_VAR_*` in
# the workflow file). When adding a new TF_VAR_* in variables.tf and the
# workflow, mirror it here.
declare -a SECRET_KEYS=(
	"sentry_auth_token:TF_VAR_SENTRY_AUTH_TOKEN"
	"discord_bot_token:TF_VAR_DISCORD_BOT_TOKEN"
	"discord_server_id:TF_VAR_DISCORD_SERVER_ID"
	"discord_category_id:TF_VAR_DISCORD_CATEGORY_ID"
	"discord_sentry_role_id:TF_VAR_DISCORD_SENTRY_ROLE_ID"
	"billing_account:TF_VAR_BILLING_ACCOUNT"
	"quicknode_api_key:TF_VAR_QUICKNODE_API_KEY"
	"quicknode_signing_secret:TF_VAR_QUICKNODE_SIGNING_SECRET"
)

if [ ! -f "terraform.tfvars" ]; then
	error "terraform.tfvars not found in ${MODULE_DIR}. Populate it before running this script."
	exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
	error "gh CLI is not authenticated. Run 'gh auth login' first."
	exit 1
fi

info "Syncing ${#SECRET_KEYS[@]} secrets from terraform.tfvars to GitHub Actions..."
echo

missing=()
set_count=0
for entry in "${SECRET_KEYS[@]}"; do
	tfvar_key="${entry%%:*}"
	secret_name="${entry##*:}"

	# read_tfvars_value (from common.sh) does an exact-key match and
	# strips surrounding quotes. Returns empty if the key isn't found.
	value="$(read_tfvars_value "${tfvar_key}" || true)"

	if [ -z "${value}" ]; then
		missing+=("${tfvar_key}")
		continue
	fi

	# --body-file - reads stdin verbatim. printf %s (no trailing newline)
	# avoids a stray \n at the end of the secret value, which would break
	# tokens / IDs that GitHub stores byte-exact.
	if printf '%s' "${value}" | gh secret set "${secret_name}" --body-file - >/dev/null; then
		echo "  ✓ ${secret_name}"
		set_count=$((set_count + 1))
	else
		error "Failed to set ${secret_name}"
		exit 1
	fi
done

echo

if [ "${#missing[@]}" -gt 0 ]; then
	error "Missing values in terraform.tfvars for: ${missing[*]}"
	error "Populate these keys and re-run."
	exit 1
fi

info "Synced ${set_count} secrets. The alerts-infra workflow can now plan + apply."
