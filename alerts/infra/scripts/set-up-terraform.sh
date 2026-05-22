#!/bin/bash
#
# Terraform Setup Script
#
# Purpose:
#   Sets up Terraform for the project by checking gcloud authentication,
#   verifying IAM permissions, and initializing Terraform.
#   This should be run before the first terraform plan/apply.
#
# Usage:
#   ./scripts/set-up-terraform.sh
#
# Requirements:
#   - gcloud CLI installed and configured
#   - terraform installed
#   - jq installed
#   - variables.tf must contain terraform_seed_project_id and terraform_service_account
#
# What it does:
#   1. Checks gcloud login (via check-gcloud-login.sh)
#   2. Verifies user has Service Account Token Creator role
#   3. Attempts to grant role if missing (may require project owner)
#   4. Runs terraform init

set -euo pipefail

# Source common utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

# Checks if the user has the "Service Account Token Creator" role in the Terraform Seed Project
# This role is necessary to access the Terraform state bucket in Google Cloud
check_gcloud_iam_permissions() {
	printf "Looking up Terraform Seed Project ID..."
	terraform_seed_project_id=$(awk '/variable "terraform_seed_project_id"/{f=1} f==1&&/default/{print $3; exit}' ./variables.tf | tr -d '",')
	if [[ -z ${terraform_seed_project_id} ]]; then
		error "Variable \$terraform_seed_project_id is empty. Please ensure it's set in ./variables.tf"
		exit 1
	fi
	printf ' \033[1m%s\033[0m\n' "${terraform_seed_project_id}"

	printf "Looking up Terraform Service Account email..."
	terraform_service_account=$(awk '/variable "terraform_service_account"/{f=1} f==1&&/default/{print $3; exit}' ./variables.tf | tr -d '",')
	if [[ -z ${terraform_service_account} ]]; then
		error "Variable \$terraform_service_account is empty. Please ensure it's set in ./variables.tf"
		exit 1
	fi
	printf ' \033[1m%s\033[0m\n\n' "${terraform_service_account}"

	# Check if the user has access to the Terraform state via the Service Account Token Creator role.
	# Token Creator can be granted EITHER project-wide OR directly on the
	# target service account (recommended least-privilege). Check both before
	# concluding the role is missing — otherwise the direct-grant case
	# reports a false failure and the script tries to bind project-wide.
	#
	# IMPORTANT: only `roles/iam.serviceAccountTokenCreator` enables
	# impersonation. `roles/iam.serviceAccountUser` is similar-sounding but
	# does NOT mint access tokens, so accepting it here would let the
	# preflight pass while subsequent impersonating terraform commands
	# fail with permission errors.
	#
	# Member match is exact (==) not substring (contains), so principals
	# like `deleted:user:alice@example.com?uid=...` that happen to contain
	# the same email don't satisfy the check.
	info "Checking if you have the 'Service Account Token Creator' role in the terraform seed project..."
	user_account_to_check="$(gcloud config get-value account)"
	local check_result project_result sa_result
	project_result=$(gcloud projects get-iam-policy "${terraform_seed_project_id}" --format=json |
		jq -r \
			--arg MEMBER "user:${user_account_to_check}" \
			'.bindings[] | select(.members[]? == $MEMBER) | select(.role == "roles/iam.serviceAccountTokenCreator") | .role')
	sa_result=$(gcloud iam service-accounts get-iam-policy "${terraform_service_account}" \
		--project="${terraform_seed_project_id}" --format=json 2>/dev/null |
		jq -r \
			--arg MEMBER "user:${user_account_to_check}" \
			'.bindings[]? | select(.members[]? == $MEMBER) | select(.role == "roles/iam.serviceAccountTokenCreator") | .role' \
		|| echo "")
	check_result="${project_result}
${sa_result}"

	if echo "${check_result}" | grep -q "roles/iam.serviceAccountTokenCreator"; then
		info "Permission check passed: ${user_account_to_check} has the Service Account Token Creator role in the terraform seed project."
		printf "\n"
	else
		# If not, try to give the user the Service Account Token Creator role.
		# Try the SA-scoped binding FIRST — it's the least-privilege fix and
		# typically works for operators who have SA-IAM-write but not project-
		# IAM-write. Fall back to the project-scoped binding only if the SA
		# binding fails.
		warn "Permission check failed: ${user_account_to_check} does not have the Service Account Token Creator role in the terraform seed project."
		printf "\n"
		info "Trying to grant Service Account Token Creator on the target SA (${terraform_service_account}) to ${user_account_to_check}"
		if gcloud iam service-accounts add-iam-policy-binding "${terraform_service_account}" \
			--project="${terraform_seed_project_id}" \
			--member="user:${user_account_to_check}" \
			--role="roles/iam.serviceAccountTokenCreator"; then
			info "Successfully added the Service Account Token Creator role (SA-scoped) to ${user_account_to_check}"
		else
			warn "SA-scoped binding failed; falling back to project-scoped binding."
			if gcloud projects add-iam-policy-binding "${terraform_seed_project_id}" \
				--member="user:${user_account_to_check}" \
				--role="roles/iam.serviceAccountTokenCreator"; then
				info "Successfully added the Service Account Token Creator role (project-scoped) to ${user_account_to_check}"
			else
				error "Failed to add the Service Account Token Creator role to ${user_account_to_check}"
				echo "You may have to ask a project owner of '${terraform_seed_project_id}' to add the role manually via one of:"
				echo "  gcloud iam service-accounts add-iam-policy-binding \"${terraform_service_account}\" --project=\"${terraform_seed_project_id}\" --member=\"user:${user_account_to_check}\" --role=\"roles/iam.serviceAccountTokenCreator\""
				echo "  gcloud projects add-iam-policy-binding \"${terraform_seed_project_id}\" --member=\"user:${user_account_to_check}\" --role=\"roles/iam.serviceAccountTokenCreator\""
				exit 1
			fi
		fi
		printf "\n"
	fi
}

# Set up Terraform variables
set_up_terraform() {
	script_dir=$(dirname "$0")
	# shellcheck source=check-gcloud-login.sh
	source "${script_dir}/check-gcloud-login.sh"

	check_tools "terraform" "jq" "gcloud"

	# Actually invoke the login check — sourcing alone doesn't run it. Without
	# this, a workstation with an expired ADC falls through to the IAM probe /
	# terraform init below and fails with a confusing "permission denied"
	# instead of prompting for `gcloud auth login`.
	check_gcloud_login

	check_gcloud_iam_permissions

	info "Initializing Terraform..."
	terraform init
	printf "\n"
}

set_up_terraform
