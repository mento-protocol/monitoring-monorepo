#!/bin/bash
#
# Project Variables Loader and Cache Manager
#
# Purpose:
#   Loads and caches project variables from Terraform configuration and state.
#   This script is typically sourced by other scripts that need project information
#   like project_id, region, function_name, etc.
#
# Usage:
#   # Source to load variables into current shell
#   source scripts/get-project-vars.sh
#
#   # Run directly to see cached values
#   ./scripts/get-project-vars.sh
#
#   # Invalidate cache and reload
#   ./scripts/get-project-vars.sh --invalidate-cache
#
# Requirements:
#   - gcloud CLI installed and authenticated
#   - terraform (for reading state)
#   - variables.tf must exist in project root
#
# What it does:
#   1. Checks for cached values in .project_vars_cache
#   2. If cache exists and valid, loads from cache
#   3. If cache missing or invalid, fetches from Terraform and gcloud
#   4. Caches values for faster subsequent loads
#   5. Sets gcloud default project and quota project
#   6. Updates .env file with project_id
#
# Variables exported:
#   - project_id: GCP project ID
#   - project_name: GCP project name
#   - region: GCP region
#   - service_account_email: Service account email
#   - function_name: Cloud Function name
#   - function_entry_point: Function entry point name

set -euo pipefail

# Determine script and directory paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ROOT_DIR="$(cd "${MODULE_DIR}/.." && pwd)"

# Source common utilities
# shellcheck source=../../scripts/common.sh
source "${ROOT_DIR}/scripts/common.sh"

set_project_id() {
	project_name=$(read_tfvar "project_name" "${ROOT_DIR}/variables.tf")

	if [[ -z ${project_name} ]]; then
		error "Could not read project_name from ${ROOT_DIR}/variables.tf"
		exit 1
	fi

	info "Looking up project name: ${project_name}"

	project_id=$(gcloud projects list --filter="name:${project_name}" --format="value(projectId)")

	if [[ -z ${project_id} ]]; then
		error "No project found with name '${project_name}'"
		error "This usually means the GCP project hasn't been created yet."
		error "Please ensure you've run the terraform apply in the root directory first."
		exit 1
	fi

	info "Found project ID: ${project_id}"

	# Set your local default project
	info "Setting default gcloud project to ${project_id}..."
	if ! gcloud config set project "${project_id}" &>/dev/null; then
		error "Failed to set gcloud project"
		exit 1
	fi

	# Set the quota project
	info "Setting quota project to ${project_id}..."
	if ! gcloud auth application-default set-quota-project "${project_id}" &>/dev/null; then
		error "Failed to set quota project"
		exit 1
	fi

	# Update the project ID in your .env file
	info "Updating .env file with project ID..."
	if [[ ! -f "${MODULE_DIR}/.env" ]]; then
		echo "GCP_PROJECT_ID=${project_id}" >"${MODULE_DIR}/.env"
	else
		sed -i '' "s/^GCP_PROJECT_ID=.*/GCP_PROJECT_ID=${project_id}/" "${MODULE_DIR}/.env"
	fi
}

cache_file="${MODULE_DIR}/.project_vars_cache"

# Function to load values from cache
load_cache() {
	if [[ -f ${cache_file} ]]; then
		# shellcheck disable=SC1090
		source "${cache_file}"
		return 0
	else
		return 1
	fi
}

# Function to write values to cache
write_cache() {
	{
		echo "project_id=${project_id}"
		echo "project_name=${project_name}"
		echo "region=${region}"
		echo "service_account_email=${service_account_email}"
		echo "function_name=${function_name}"
		echo "function_entry_point=${function_entry_point}"
	} >"${cache_file}"
}

# Read entry point from main.tf (shared helper)
read_entry_point_from_main_tf() {
	local main_tf="$1"
	local fallback="$2"
	read_tf_main_value "${main_tf}" '/build_config/{f=1} f==1&&/entry_point.*=/{gsub(/[^"]*"|".*/, ""); print; exit}' "${fallback}"
}

# Function to load & cache values
cache_values() {
	# Ensure we're in the root directory for terraform commands
	cd "${ROOT_DIR}" || exit 1

	info "Loading and caching project values..."

	project_name=$(read_tfvar "project_name" "${ROOT_DIR}/variables.tf")
	region=$(read_tfvar "region" "${ROOT_DIR}/variables.tf")
	function_name=$(read_tfvar "function_name" "${MODULE_DIR}/variables.tf")

	info "  Project Name: ${project_name}"
	info "  Region: ${region}"
	info "  Function Name: ${function_name}"

	# Service account from Terraform state
	service_account_email=$(terraform state show "google_service_account.project_sa" 2>/dev/null | grep email | awk '{print $3}' | tr -d '"' || echo "")
	info "  Service Account: ${service_account_email:-<not found>}"

	# Entry point from main.tf (using shared function)
	function_entry_point=$(read_entry_point_from_main_tf "${MODULE_DIR}/main.tf" "processQuicknodeWebhook")
	info "  Function Entry Point: ${function_entry_point}"

	info "Caching values in ${cache_file}..."
	write_cache
	info "Cache updated successfully"
}

# Function to invalidate cache
invalidate_cache() {
	# Ensure we're in the root directory for terraform commands
	cd "${ROOT_DIR}" || exit 1

	info "Clearing cache file: ${cache_file}"
	rm -f "${cache_file}"

	current_local_project_id=$(gcloud config get project 2>/dev/null || echo "")
	info "Current gcloud project: ${current_local_project_id:-<not set>}"

	current_tf_state_project_id=$(terraform state show module.project_factory.google_project.main 2>/dev/null | grep project_id | awk '{print $3}' | tr -d '"' || echo "")
	info "Terraform state project: ${current_tf_state_project_id:-<not found>}"

	if [[ -n ${current_local_project_id} ]] && [[ -n ${current_tf_state_project_id} ]] && [[ ${current_local_project_id} != "${current_tf_state_project_id}" ]]; then
		warn "Local gcloud project (${current_local_project_id}) differs from Terraform state (${current_tf_state_project_id})"
		info "Setting correct project ID..."
		set_project_id
	else
		project_id="${current_local_project_id:-${current_tf_state_project_id}}"
	fi

	cache_values
}

# Main script logic
main() {
	# Check for verbose flag in arguments
	for arg in "$@"; do
		if [[ ${arg} == "--verbose" || ${arg} == "-v" ]]; then
			export VERBOSE=1
		fi
	done

	if [[ ${1-} == "--invalidate-cache" ]]; then
		invalidate_cache
		return 0
	fi

	set +e
	load_cache
	cache_loaded=$?
	set -e

	if [[ ${cache_loaded} -eq 0 ]]; then
		if [[ ${VERBOSE:-0} -eq 1 ]]; then
			info "Using cached values from ${cache_file}:"
			info "  Project ID: ${project_id}"
			info "  Project Name: ${project_name}"
			info "  Region: ${region}"
			info "  Service Account: ${service_account_email}"
			info "  Function Name: ${function_name}"
			info "  Function Entry Point: ${function_entry_point}"
		else
			# Simple box display for non-verbose mode
			local box_width=$((${#project_id} + 18))
			local border
			border=$(printf '%*s' "${box_width}" '' | tr ' ' '-')
			printf "\n+%s+\n" "${border}"
			printf "| Project ID: %s |\n" "${project_id}"
			printf "+%s+\n" "${border}"
		fi
	else
		warn "No cache found. Setting project ID and fetching values..."
		# Ensure we're in the root directory for terraform commands
		cd "${ROOT_DIR}" || exit 1
		set_project_id
		cache_values
	fi
}

main "$@"
