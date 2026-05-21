#!/bin/bash
#
# Local Cloud Function Test Script
#
# Purpose:
#   Sends a test payload to a locally running Cloud Function instance.
#   Useful for testing function logic before deploying to GCP.
#
# Usage:
#   ./scripts/test-local.sh
#
# Prerequisites:
#   - Cloud Function must be running locally (e.g., via `npm start`)
#   - Function should be listening on http://localhost:8080/ (default)
#   - test-payload.json must exist in scripts directory
#
# Requirements:
#   - curl installed
#
# Environment Variables:
#   - FUNCTION_URL: Override default URL (default: http://localhost:8080/)
#
# What it does:
#   1. Checks for test-payload.json file
#   2. Sends POST request to local function URL
#   3. Displays HTTP status code and response
#
# Example:
#   # Start function locally in another terminal
#   cd onchain-event-handler && npm start
#
#   # In another terminal, run test
#   ./scripts/test-local.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ROOT_DIR="$(cd "${MODULE_DIR}/.." && pwd)"

# Source common utilities (required)
if [[ ! -f "${ROOT_DIR}/scripts/common.sh" ]]; then
	echo "Error: common.sh not found at ${ROOT_DIR}/scripts/common.sh" >&2
	exit 1
fi

# shellcheck source=../../scripts/common.sh
source "${ROOT_DIR}/scripts/common.sh"

# Check requirements
check_tools "curl"

FUNCTION_URL="${FUNCTION_URL:-http://localhost:8080/}"
PAYLOAD_FILE="${SCRIPT_DIR}/test-payload.json"

if [[ ! -f ${PAYLOAD_FILE} ]]; then
	error "Test payload file not found: ${PAYLOAD_FILE}"
	exit 1
fi

info "Sending test payload to ${FUNCTION_URL}..."

curl -s -w "\nHTTP Status: %{http_code}\n" \
	-X POST "${FUNCTION_URL}" \
	-H "Content-Type: application/json" \
	-d "@${PAYLOAD_FILE}"
