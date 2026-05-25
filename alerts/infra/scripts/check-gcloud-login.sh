#!/bin/bash
#
# Google Cloud Authentication Checker
#
# Purpose:
#   Checks for an active Google Cloud login and application-default credentials.
#   If no active account or valid credentials are found, it prompts the user to log in.
#   This is typically used as a prerequisite before running Terraform commands.
#
# Usage:
#   ./scripts/check-gcloud-login.sh
#   OR source it from another script:
#   source scripts/check-gcloud-login.sh
#
# Requirements:
#   - gcloud CLI installed and configured
#
# What it does:
#   1. Checks if there's an active gcloud account
#   2. Prompts for login if no active account found
#   3. Checks for application-default credentials
#   4. Prompts for application-default login if needed

set -euo pipefail

# Source common utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

# Checks for an active Google Cloud login and application-default credentials.
# If no active account or valid credentials are found, it prompts the user to log in.
check_gcloud_login() {
	printf "\n"
	info "Checking gcloud login..."
	# Check if there's an active account
	if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" | grep -q .; then
		info "No active Google Cloud account found. Initiating login..."
		gcloud auth login
		info "Successfully logged in to gcloud"
	else
		info "Already logged in to Google Cloud."
	fi
	printf "\n"

	info "Checking gcloud application-default credentials..."
	if ! gcloud auth application-default print-access-token &>/dev/null; then
		info "No valid application-default credentials found. Initiating login..."
		gcloud auth application-default login
		info "Successfully logged in to gcloud"
	else
		info "Already logged in with valid application-default credentials."
	fi
	printf "\n"
}

# Only run if script is executed directly (not sourced)
if [[ ${BASH_SOURCE[0]} == "${0}" ]]; then
	check_gcloud_login
fi
