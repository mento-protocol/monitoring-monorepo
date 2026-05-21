#!/bin/bash
#
# Health Check Script
#
# Purpose:
#   Sends a GET request to the deployed Cloud Function health check endpoint
#   to verify the function is running and responding correctly.
#
# Usage:
#   ./scripts/test-healthcheck.sh
#   npm run test:healthcheck
#   npm run health
#
# Requirements:
#   - terraform (for reading outputs)
#   - curl (for making HTTP requests)
#   - jq (for parsing JSON)
#

set -euo pipefail

# Determine script and directory paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ROOT_DIR="$(cd "${MODULE_DIR}/.." && pwd)"

# Source common utilities
# shellcheck source=../../scripts/common.sh
source "${ROOT_DIR}/scripts/common.sh"

# Check for required tools
check_tools "terraform" "curl" "jq"

# Ensure we're in the root directory for terraform commands
cd "${ROOT_DIR}" || exit 1

info "Fetching Cloud Function URL from Terraform outputs..."

# Get the function URL from terraform outputs
# Try the root-level output first (google_cloud.cloud_function_url)
FUNCTION_URL=$(terraform output -json 2>/dev/null | jq -r '.google_cloud.value.cloud_function_url // empty' || echo "")

if [[ -z ${FUNCTION_URL} ]]; then
	# Try module-level output as fallback
	FUNCTION_URL=$(terraform output -json 2>/dev/null | jq -r '.onchain_event_handler.value.function_url // empty' || echo "")
fi

if [[ -z ${FUNCTION_URL} ]]; then
	# Try direct module output path
	FUNCTION_URL=$(terraform output -raw module.onchain_event_handler.function_url 2>/dev/null || echo "")
fi

if [[ -z ${FUNCTION_URL} ]]; then
	error "Could not retrieve function URL from Terraform outputs"
	error "Make sure Terraform has been applied and the function is deployed"
	exit 1
fi

info "Function URL: ${FUNCTION_URL}"
info ""
info "Sending GET request to health check endpoint..."

# Send GET request and capture response
HTTP_CODE=$(curl -s -o /tmp/healthcheck_response.json -w "%{http_code}" "${FUNCTION_URL}" || echo "000")

if [[ ${HTTP_CODE} == "000" ]]; then
	error "Failed to connect to Cloud Function"
	error "The function may not be deployed or the URL may be incorrect"
	exit 1
fi

# Display response
info "HTTP Status Code: ${HTTP_CODE}"
info ""
info "Response Body:"
jq . /tmp/healthcheck_response.json
echo ""

# Clean up temp file
rm -f /tmp/healthcheck_response.json

# Check if health check passed (200 OK)
if [[ ${HTTP_CODE} == "200" ]]; then
	info "✓ Health check passed!"
	exit 0
else
	warn "✗ Health check returned status code ${HTTP_CODE}"
	exit 1
fi
