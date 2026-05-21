#!/bin/bash
#
# QuickNode Webhook Filter Function Retriever
#
# Purpose:
#   Retrieves the filter function from an existing QuickNode webhook and converts
#   it to a Terraform template format. This is useful when you need to update the
#   filter function template or migrate webhook configurations.
#
# Usage:
#   ./scripts/get-webhook-filter.sh
#
# Requirements:
#   - curl
#   - jq (recommended for better output)
#   - base64 (for decoding filter function)
#   - perl (for template conversion)
#   - quicknode_api_key in terraform.tfvars OR QUICKNODE_API_KEY environment variable
#
# What it does:
#   1. Reads QuickNode API key from terraform.tfvars
#   2. Retrieves all webhooks from QuickNode API
#   3. Finds webhook matching "safe-multisig-monitor-*" pattern
#   4. Fetches webhook details including filter function
#   5. Decodes base64 filter function
#   6. Converts to Terraform template format (replaces contracts array)
#   7. Saves to onchain-event-listeners/filter-function.js.tpl
#   8. Copies Terraform code snippet to clipboard (if available)
#
# Output:
#   - Updates filter-function.js.tpl with template syntax
#   - Displays Terraform code snippet for locals.tf
#   - Copies code to clipboard (macOS/Linux)

set -euo pipefail

# Source common utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

PROJECT_ROOT=$(get_project_root)

# Step 1: Read QuickNode API key from terraform.tfvars
info "Step 1: Reading QuickNode API key from terraform.tfvars..."

QUICKNODE_API_KEY=$(read_tfvars_value "quicknode_api_key")

if [[ -z ${QUICKNODE_API_KEY} ]]; then
	error "Could not find quicknode_api_key in terraform.tfvars"
	exit 1
fi

info "✓ Found API key"

# Step 2: Retrieve all webhooks
info "Step 2: Retrieving all webhooks from QuickNode..."
WEBHOOKS_RESPONSE=$(curl -s -w "\n%{http_code}" \
	-X GET "https://api.quicknode.com/webhooks/rest/v1/webhooks?limit=100&offset=0" \
	-H "accept: application/json" \
	-H "x-api-key: ${QUICKNODE_API_KEY}")

HTTP_CODE=$(echo "${WEBHOOKS_RESPONSE}" | tail -1)
WEBHOOKS_JSON=$(echo "${WEBHOOKS_RESPONSE}" | sed '$d')

if [[ ${HTTP_CODE} != "200" ]]; then
	error "Failed to retrieve webhooks (HTTP ${HTTP_CODE})"
	echo "${WEBHOOKS_JSON}" | jq '.' 2>/dev/null || echo "${WEBHOOKS_JSON}"
	exit 1
fi

# Check if jq is available
if ! command -v jq &>/dev/null; then
	warn "jq not found. Installing jq is recommended for better output."
fi

# Step 3: Find webhook matching pattern from main.tf
# Pattern: "safe-multisig-monitor-*" (matches webhooks created by the module)
info "Step 3: Finding webhook matching 'safe-multisig-monitor-*' pattern..."

if command -v jq &>/dev/null; then
	# Extract webhook IDs and names
	WEBHOOK_IDS=$(echo "${WEBHOOKS_JSON}" | jq -r '.data[]? | select(.name | startswith("safe-multisig-monitor-")) | .id' 2>/dev/null || true)
	WEBHOOK_NAMES=$(echo "${WEBHOOKS_JSON}" | jq -r '.data[]? | select(.name | startswith("safe-multisig-monitor-")) | .name' 2>/dev/null || true)
else
	# Fallback: use grep/awk (less reliable)
	echo -e "${YELLOW}Using fallback method (jq not available)${NC}"
	WEBHOOK_IDS=$(echo "${WEBHOOKS_JSON}" | grep -o '"id"[[:space:]]*:[[:space:]]*"[^"]*"' | awk -F'"' '{print $4}' | head -1 || true)
	WEBHOOK_NAMES=$(echo "${WEBHOOKS_JSON}" | grep -o '"name"[[:space:]]*:[[:space:]]*"safe-multisig-monitor-[^"]*"' | awk -F'"' '{print $4}' | head -1 || true)
fi

if [[ -z ${WEBHOOK_IDS} ]] || [[ -z ${WEBHOOK_NAMES} ]]; then
	error "No webhook found matching pattern 'safe-multisig-monitor-*'"
	warn "Available webhooks:"
	if command -v jq &>/dev/null; then
		echo "${WEBHOOKS_JSON}" | jq -r '.data[]? | "  - \(.name) (ID: \(.id))"' 2>/dev/null || echo "${WEBHOOKS_JSON}"
	else
		echo "${WEBHOOKS_JSON}"
	fi
	exit 1
fi

# Handle multiple webhooks (take first match)
WEBHOOK_ID=$(echo "${WEBHOOK_IDS}" | head -1)
WEBHOOK_NAME=$(echo "${WEBHOOK_NAMES}" | head -1)

WEBHOOK_COUNT=$(echo "${WEBHOOK_IDS}" | wc -l)
if [[ ${WEBHOOK_COUNT} -gt 1 ]]; then
	warn "Multiple webhooks found. Using first match: ${WEBHOOK_NAME}"
fi

info "✓ Found webhook: ${WEBHOOK_NAME} (ID: ${WEBHOOK_ID})"

# Step 4: Fetch filter function via webhook details endpoint
info "Step 4: Fetching webhook details..."
WEBHOOK_DETAILS_RESPONSE=$(curl -s -w "\n%{http_code}" \
	-X GET "https://api.quicknode.com/webhooks/rest/v1/webhooks/${WEBHOOK_ID}" \
	-H "accept: application/json" \
	-H "x-api-key: ${QUICKNODE_API_KEY}")

HTTP_CODE=$(echo "${WEBHOOK_DETAILS_RESPONSE}" | tail -1)
WEBHOOK_DETAILS_JSON=$(echo "${WEBHOOK_DETAILS_RESPONSE}" | sed '$d')

if [[ ${HTTP_CODE} != "200" ]]; then
	error "Failed to retrieve webhook details (HTTP ${HTTP_CODE})"
	echo "${WEBHOOK_DETAILS_JSON}" | jq '.' 2>/dev/null || echo "${WEBHOOK_DETAILS_JSON}"
	exit 1
fi

# Step 5: Extract and decode filter function
info "Step 5: Extracting and decoding filter function..."

if command -v jq &>/dev/null; then
	FILTER_FUNCTION_B64=$(echo "${WEBHOOK_DETAILS_JSON}" | jq -r '.filter_function // empty' 2>/dev/null || echo "")
else
	# Fallback: extract with grep/sed
	FILTER_FUNCTION_B64=$(echo "${WEBHOOK_DETAILS_JSON}" | grep -o '"filter_function"[[:space:]]*:[[:space:]]*"[^"]*"' | sed -E 's/.*"filter_function"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/' || echo "")
fi

if [[ -z ${FILTER_FUNCTION_B64} ]]; then
	error "filter_function not found in webhook details"
	echo "${WEBHOOK_DETAILS_JSON}" | jq '.' 2>/dev/null || echo "${WEBHOOK_DETAILS_JSON}"
	exit 1
fi

# Decode base64 filter function (try both -d and -D for compatibility)
FILTER_FUNCTION=""
if command -v base64 &>/dev/null; then
	# Try Linux-style first, then macOS-style
	FILTER_FUNCTION=$(echo "${FILTER_FUNCTION_B64}" | base64 -d 2>/dev/null) ||
		FILTER_FUNCTION=$(echo "${FILTER_FUNCTION_B64}" | base64 -D 2>/dev/null) ||
		FILTER_FUNCTION=""
fi

# If decoding failed or base64 not available, use original (may already be decoded)
if [[ -z ${FILTER_FUNCTION} ]]; then
	warn "Could not decode filter function (may already be decoded or base64 not available)"
	FILTER_FUNCTION="${FILTER_FUNCTION_B64}"
fi

# Step 6: Save filter function to file and copy to clipboard
echo -e "\n${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}Filter Function for Webhook: ${WEBHOOK_NAME}${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}\n"

# Determine the filter function template file path (in onchain-event-listeners directory)
FILTER_FUNCTION_FILE="${PROJECT_ROOT}/onchain-event-listeners/filter-function.js.tpl"

# Replace hardcoded contracts array with Terraform template syntax
# This allows contracts to be injected from var.multisig_addresses
# Use perl to handle the replacement properly (handles special characters)
FILTER_FUNCTION_TEMPLATE=$(echo "${FILTER_FUNCTION}" | perl -pe 's/const contracts = \[.*?\];/const contracts = \${jsonencode([for addr in contracts : lower(addr)])};/')

# Save filter function template to file
echo "${FILTER_FUNCTION_TEMPLATE}" >"${FILTER_FUNCTION_FILE}"
info "✓ Saved filter function template to: ${FILTER_FUNCTION_FILE}"
info "  (Contracts will be injected from Terraform config)"

# Build the Terraform templatefile() format for locals.tf
# shellcheck disable=SC2016
TERRAFORM_OUTPUT='  filter_function_js = templatefile("${path.module}/filter-function.js.tpl", {
    contracts = var.multisig_addresses
  })'

# Print to console
echo -e "\n${YELLOW}# Update your locals.tf with:${NC}\n"
echo "${TERRAFORM_OUTPUT}"

# Copy Terraform code to clipboard
CLIPBOARD_COPIED=false
UNAME_OS=$(uname)
if [[ ${UNAME_OS} == "Darwin" ]]; then
	# macOS
	if echo -n "${TERRAFORM_OUTPUT}" | pbcopy; then
		CLIPBOARD_COPIED=true
	fi
elif command -v xclip &>/dev/null; then
	# Linux with xclip
	if echo -n "${TERRAFORM_OUTPUT}" | xclip -selection clipboard; then
		CLIPBOARD_COPIED=true
	fi
elif command -v xsel &>/dev/null; then
	# Linux with xsel
	if echo -n "${TERRAFORM_OUTPUT}" | xsel --clipboard --input; then
		CLIPBOARD_COPIED=true
	fi
fi

if [[ ${CLIPBOARD_COPIED} == "true" ]]; then
	info "✓ Copied Terraform code to clipboard!"
else
	warn "Note: Could not copy to clipboard (install pbcopy on macOS or xclip/xsel on Linux)"
fi

echo -e "\n${GREEN}═══════════════════════════════════════════════════════════════${NC}"
