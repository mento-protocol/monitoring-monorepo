#!/bin/bash
#
# Cloud Function Direct Deployment Script
#
# Purpose:
#   Deploys the Cloud Function using gcloud directly, bypassing Terraform's Cloud Build.
#   This is useful for debugging deployment issues or testing changes without going
#   through Terraform's deployment pipeline.
#
# Usage:
#   ./scripts/deploy.sh
#
# Requirements:
#   - gcloud CLI installed and authenticated
#   - jq installed
#   - terraform (for reading configuration from state)
#   - Project must be initialized (run get-project-vars.sh first or terraform apply)
#
# What it does:
#   1. Loads project variables (project_id, region, function_name, etc.)
#   2. Reads ALL function configuration from Terraform state (single source of truth)
#   3. Reads environment variables from Terraform state
#   4. Ensures safe-abi.json exists in module directory
#   5. Deploys function using gcloud with Cloud Build (runs npm install and build)
#   6. Displays function URL after successful deployment
#
# Single Source of Truth:
#   This script uses Terraform files (variables.tf and main.tf) as the single source
#   of truth for all function parameters including:
#   - Function name, runtime, entry point (from variables.tf and main.tf)
#   - Memory, timeout, instance counts (from variables.tf)
#   - Secret names (from main.tf)
#   Environment variables are read from Terraform state (computed values).
#   No Terraform state required for basic configuration - works before first terraform apply.
#
# Note:
#   Cloud Build will automatically run `npm install` and `npm run build` when it
#   detects package.json in the source directory.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ROOT_DIR="$(cd "${MODULE_DIR}/.." && pwd)"

# Source common utilities
if [[ -f "${ROOT_DIR}/scripts/common.sh" ]]; then
	# shellcheck source=../../scripts/common.sh
	source "${ROOT_DIR}/scripts/common.sh"
else
	# Can't use error() function here since we haven't sourced common.sh yet
	echo "Error: common.sh not found at ${ROOT_DIR}/scripts/common.sh" >&2
	exit 1
fi

# Helper function for reading entry_point from index.ts (single source of truth)
# Looks for: export const <functionName> = async
# Usage: read_entry_point_from_index_ts "index_ts_path" "fallback"
read_entry_point_from_index_ts() {
	local index_ts="$1"
	local fallback="$2"

	if [[ ! -f ${index_ts} ]]; then
		echo "${fallback}"
		return
	fi

	# Extract exported function name from: export const <functionName> = async
	local entry_point
	entry_point=$(grep -E '^export const [a-zA-Z_][a-zA-Z0-9_]*\s*=\s*async' "${index_ts}" 2>/dev/null |
		sed -E 's/^export const ([a-zA-Z_][a-zA-Z0-9_]*).*/\1/' | head -1)

	if [[ -n ${entry_point} ]]; then
		echo "${entry_point}"
	else
		echo "${fallback}"
	fi
}

# Extract environment variables from Terraform state (computed values)
# Returns JSON object with env vars or empty object
# Note: Environment variables are computed in Terraform, so we need state for these
get_env_vars_from_state() {
	local root_dir="$1"
	cd "${root_dir}" || return 1

	terraform show -json 2>/dev/null | jq -r '
		.values.root_module.child_modules[]? |
		select(.address == "module.onchain_event_handler") |
		.resources[]? |
		select(.type == "google_cloudfunctions2_function" and .name == "onchain_event_handler") |
		.values.service_config[0].environment_variables // {}
	' 2>/dev/null || echo "{}"
}

# Parse all function parameters from Terraform files and source code (single source of truth)
# Reads from variables.tf and src/index.ts directly - no Terraform state required
# Sets local variables: function_name, runtime, entry_point, memory_mb, timeout_seconds,
#                       max_instances, min_instances, secret_name
parse_function_config_from_files() {
	local module_dir="$1"
	local vars_file="${module_dir}/variables.tf"

	# Read function name from variables.tf
	function_name=$(read_tfvar "function_name" "${vars_file}")

	# Read runtime from variables.tf
	runtime=$(read_tfvar "runtime" "${vars_file}")

	# Read entry point from index.ts (single source of truth - the actual exported function)
	local index_ts="${module_dir}/src/index.ts"
	entry_point=$(read_entry_point_from_index_ts "${index_ts}" "processQuicknodeWebhook")

	# Read numeric values from variables.tf and validate
	memory_mb=$(read_tfvar_default_number "memory_mb" "256" "${vars_file}")
	# Keep fallback in sync with variables.tf default (bumped to 300s to give
	# Promise.all batches headroom over the 60s old ceiling).
	timeout_seconds=$(read_tfvar_default_number "timeout_seconds" "300" "${vars_file}")
	max_instances=$(read_tfvar_default_number "max_instances" "10" "${vars_file}")
	min_instances=$(read_tfvar_default_number "min_instances" "0" "${vars_file}")

	# Read secret name from variables.tf
	secret_name=$(read_tfvar "secret_name" "${vars_file}")

	# Validate numeric values (using shared function from common.sh)
	memory_mb=$(validate_non_negative_int "${memory_mb}" "256" "memory_mb")
	timeout_seconds=$(validate_non_negative_int "${timeout_seconds}" "300" "timeout_seconds")
	max_instances=$(validate_non_negative_int "${max_instances}" "10" "max_instances")
	min_instances=$(validate_non_negative_int "${min_instances}" "0" "min_instances")
}

# Create temporary YAML file for environment variables
# Returns path to temp file via stdout, returns 1 on failure
# The caller is responsible for cleanup (use trap)
create_env_vars_file() {
	local env_vars_json="$1"

	if [[ ${env_vars_json} == "{}" ]] || [[ ${env_vars_json} == "null" ]] || [[ -z ${env_vars_json} ]]; then
		return 1
	fi

	local env_file
	env_file=$(mktemp)

	# Convert JSON to YAML format
	# Format: KEY: "VALUE" (values quoted to handle special characters)
	if ! echo "${env_vars_json}" | jq -r 'to_entries[] | "\(.key): \(.value | @json)"' >"${env_file}" 2>/dev/null; then
		warn "Could not parse environment variables from Terraform state"
		rm -f "${env_file}"
		return 1
	fi

	if [[ ! -s ${env_file} ]]; then
		rm -f "${env_file}"
		return 1
	fi

	local env_var_count
	env_var_count=$(echo "${env_vars_json}" | jq 'length' 2>/dev/null || echo "0")
	info "Found ${env_var_count} environment variables in Terraform state"

	echo "${env_file}"
}

# safe-abi.json is committed in the module directory — assert it's present
# rather than copying from a parent dir.
ensure_safe_abi() {
	if [[ -f "${MODULE_DIR}/safe-abi.json" ]]; then
		return 0
	fi

	error "safe-abi.json missing from module directory: ${MODULE_DIR}/safe-abi.json"
	return 1
}

# Get function URL after deployment
get_function_url() {
	local function_name="$1"
	local region="$2"
	local impersonate_sa="$3"

	local url
	if [[ -n ${impersonate_sa} ]]; then
		url=$(gcloud functions describe "${function_name}" --gen2 --region="${region}" --impersonate-service-account="${impersonate_sa}" --format="value(serviceConfig.uri)" 2>/dev/null || echo "")
	else
		url=$(gcloud functions describe "${function_name}" --gen2 --region="${region}" --format="value(serviceConfig.uri)" 2>/dev/null || echo "")
	fi

	if [[ -n ${url} ]]; then
		info "Function URL: ${url}"
	else
		warn "Could not retrieve function URL. You can get it with:"
		if [[ -n ${impersonate_sa} ]]; then
			warn "  gcloud functions describe ${function_name} --gen2 --region=${region} --impersonate-service-account=${impersonate_sa} --format='value(serviceConfig.uri)'"
		else
			warn "  gcloud functions describe ${function_name} --gen2 --region=${region} --format='value(serviceConfig.uri)'"
		fi
	fi
}

# Main deployment function
main() {
	# Check tools first
	check_tools "gcloud" "jq" "terraform"

	# Load project variables using existing script
	info "Loading project variables..."
	if [[ -f "${SCRIPT_DIR}/get-project-vars.sh" ]]; then
		# Source the script to get variables (suppress output unless verbose)
		if [[ ${VERBOSE:-0} -eq 1 ]]; then
			source "${SCRIPT_DIR}/get-project-vars.sh" --verbose
		else
			source "${SCRIPT_DIR}/get-project-vars.sh" >/dev/null 2>&1
		fi
	else
		error "get-project-vars.sh not found at ${SCRIPT_DIR}/get-project-vars.sh"
		exit 1
	fi

	# Ensure safe-abi.json exists
	local ensure_result
	ensure_safe_abi
	ensure_result=$?
	if [[ ${ensure_result} -ne 0 ]]; then
		exit 1
	fi

	# Parse all function parameters from Terraform files (single source of truth)
	info "Reading function configuration from Terraform files..."
	local function_name runtime entry_point memory_mb timeout_seconds max_instances min_instances secret_name
	# Initialize with defaults to avoid unbound variable errors
	function_name=""
	runtime=""
	entry_point="processQuicknodeWebhook"
	memory_mb="256"
	timeout_seconds="300"
	max_instances="10"
	min_instances="0"
	secret_name=""
	parse_function_config_from_files "${MODULE_DIR}"

	# Read terraform_service_account from root variables.tf for impersonation
	local terraform_service_account
	terraform_service_account=$(read_tfvar "terraform_service_account" "${ROOT_DIR}/variables.tf")

	# Get environment variables from Terraform state (computed values)
	# Note: Environment variables are computed in Terraform, so we need state for these
	info "Reading environment variables from Terraform state..."
	cd "${ROOT_DIR}"
	local env_vars_json
	env_vars_json=$(get_env_vars_from_state "${ROOT_DIR}")

	# Create environment variables file if we have env vars.
	# `set -e` aborts on assignment-with-failed-command-substitution, so we
	# capture the result via an `if`-guarded block instead — that lets the
	# fallback "no env vars" branch actually run on first-deploy / missing-
	# state cases instead of aborting the whole script.
	local env_vars_file=""
	local create_result=1
	if env_vars_file=$(create_env_vars_file "${env_vars_json}"); then
		create_result=0
	fi
	if [[ ${create_result} -eq 0 ]] && [[ -n ${env_vars_file} ]]; then
		# Set up cleanup trap for temporary file
		# Store the file path in a way that's accessible to the trap
		local cleanup_file="${env_vars_file}"
		cleanup_env_file() {
			if [[ -n ${cleanup_file-} ]] && [[ -f ${cleanup_file} ]]; then
				rm -f "${cleanup_file}"
			fi
		}
		trap cleanup_env_file EXIT INT TERM
	else
		warn "Could not read environment variables from Terraform state"
		warn "The function may not have the correct environment variables set"
		warn "You may need to set them manually or deploy via Terraform first"
	fi

	# Change to module directory for deployment
	cd "${MODULE_DIR}"

	# Display deployment information with better formatting
	echo ""
	echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
	echo -e "${CYAN}  Deployment Configuration${NC}"
	echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
	echo ""
	echo -e "  ${GREEN}Function:${NC}     ${function_name}"
	echo -e "  ${GREEN}Project:${NC}      ${project_id}"
	echo -e "  ${GREEN}Region:${NC}       ${region}"
	echo -e "  ${GREEN}Runtime:${NC}      ${runtime}"
	echo -e "  ${GREEN}Entry Point:${NC}  ${entry_point}"
	echo ""
	echo -e "  ${GREEN}Memory:${NC}        ${memory_mb}MB"
	echo -e "  ${GREEN}Timeout:${NC}      ${timeout_seconds}s"
	echo -e "  ${GREEN}Instances:${NC}    ${min_instances} - ${max_instances}"
	echo ""
	echo -e "  ${GREEN}Secret:${NC}       ${secret_name}"
	echo -e "  ${GREEN}Impersonating:${NC} ${terraform_service_account}"
	echo ""

	# Fail fast if the runtime SA wasn't resolved from state. Passing
	# `--service-account=` (empty) to gcloud aborts with an opaque flag-
	# parse error; a clear message here pushes the operator back to
	# `pnpm alerts:infra:apply` (which creates the SA) rather than
	# letting the deploy fall back to the project default SA, which
	# wouldn't have Secret Manager access anyway.
	if [[ -z ${service_account_email} ]]; then
		error "Runtime service account not found in Terraform state."
		error "Run 'pnpm alerts:infra:apply' first so module.onchain_event_handler.google_service_account.function_runtime exists."
		exit 1
	fi

	# Fail fast if get-project-vars.sh couldn't resolve project_id. This can
	# happen if Terraform state is missing or stale.
	if [[ -z ${project_id} ]]; then
		error "GCP project_id not found in Terraform state."
		error "Run 'pnpm alerts:infra:apply' first."
		exit 1
	fi

	# Build the gcloud deploy command as an array to properly handle special characters
	# Cloud Build will automatically run `npm install` and `npm run build` when it detects package.json
	# All parameters come from Terraform files (single source of truth)
	local deploy_cmd_args=(
		"functions" "deploy" "${function_name}"
		"--gen2"
		"--runtime=${runtime}"
		"--region=${region}"
		# Pin the project explicitly: `gcloud config` can be stale (especially
		# since get-project-vars.sh has a cache that doesn't always re-run
		# `gcloud config set project`). Without --project, an operator who
		# switched gcloud config between runs would silently deploy to the
		# wrong GCP project.
		"--project=${project_id}"
		"--source=${MODULE_DIR}"
		"--service-account=${service_account_email}"
		"--entry-point=${entry_point}"
		"--trigger-http"
		"--allow-unauthenticated"
		"--memory=${memory_mb}MB"
		"--timeout=${timeout_seconds}s"
		"--max-instances=${max_instances}"
		"--min-instances=${min_instances}"
		# Keep this list in sync with the secret_environment_variables block
		# in alerts/infra/onchain-event-handler/main.tf. Cloud Function refuses
		# to boot if any required env var (per src/config.ts) is missing.
		"--set-secrets=QUICKNODE_SIGNING_SECRET=${secret_name}:latest,DISCORD_WEBHOOK_ALERTS=${secret_name}-discord-alerts:latest,DISCORD_WEBHOOK_EVENTS=${secret_name}-discord-events:latest"
		"--impersonate-service-account=${terraform_service_account}"
	)

	# Add environment variables if we have them
	if [[ -n ${env_vars_file} ]] && [[ -f ${env_vars_file} ]]; then
		deploy_cmd_args+=("--env-vars-file=${env_vars_file}")
	fi

	# Display deployment command in a more readable format
	echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
	echo -e "${CYAN}  Deployment Command${NC}"
	echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
	echo ""
	echo -e "${BLUE}gcloud${NC} ${deploy_cmd_args[*]}"
	echo ""

	# Execute deployment
	echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
	info "Starting deployment..."
	echo ""
	if gcloud "${deploy_cmd_args[@]}"; then
		info "Deployment successful!"
		info "Getting function URL..."
		get_function_url "${function_name}" "${region}" "${terraform_service_account}"
	else
		error "Deployment failed"
		exit 1
	fi
}

main "$@"
