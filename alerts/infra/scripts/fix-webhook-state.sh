#!/usr/bin/env bash
#
# QuickNode Webhook State Repair Tool
#
# Purpose:
#   Automatically detect and fix Terraform state drift for QuickNode webhooks.
#   This script identifies webhooks that exist in Terraform state but have been
#   deleted in QuickNode (or vice versa) and offers to clean up the state.
#
# Usage:
#   ./scripts/fix-webhook-state.sh
#
# Requirements:
#   - terraform (must be initialized)
#   - curl
#   - jq (optional, for better output)
#   - QUICKNODE_API_KEY environment variable OR quicknode_api_key in terraform.tfvars
#
# What it does:
#   1. Finds all webhook resources in Terraform state
#   2. Checks if each webhook exists in QuickNode via API
#   3. Identifies orphaned webhooks (in state but not in QuickNode)
#   4. Offers to remove them from state (interactive prompt)
#   5. Provides next steps for running terraform apply
#
# When to use:
#   - Error: unexpected response code '404' during terraform apply
#   - Terraform trying to update webhooks that don't exist
#   - Webhooks were deleted manually in QuickNode dashboard
#   - Previous terraform apply failed and left state inconsistent

set -euo pipefail

# Source common utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

echo -e "${YELLOW}QuickNode Webhook State Repair Tool${NC}"
echo "======================================"
echo ""

# Check if we're in the terraform directory
check_terraform_root

# List all on-chain event listener webhook resources in state
echo "Finding webhook resources in Terraform state..."
WEBHOOK_RESOURCES=$(terraform state list | grep -E 'onchain_event_listeners\[.*\]\.restapi_object\.multisig_webhook' || echo "")

if [[ -z ${WEBHOOK_RESOURCES} ]]; then
	warn "No webhook resources found in state."
	exit 0
fi

echo "Found the following webhook resources:"
echo "${WEBHOOK_RESOURCES}"
echo ""

# Get QuickNode API key from (in order of priority):
# 1. Environment variable
# 2. terraform.tfvars file
if [[ -z ${QUICKNODE_API_KEY-} ]]; then
	info "QUICKNODE_API_KEY not set, trying to read from terraform.tfvars..."
	QUICKNODE_API_KEY=$(read_tfvars_value "quicknode_api_key")

	if [[ -n ${QUICKNODE_API_KEY} ]]; then
		info "Found QuickNode API key in terraform.tfvars"
	fi
fi

# Check if we have an API key now
if [[ -z ${QUICKNODE_API_KEY-} ]]; then
	error "QUICKNODE_API_KEY not found."
	echo ""
	echo "Please provide your QuickNode API key in one of these ways:"
	echo ""
	echo "Option 1: Export as environment variable"
	echo "  export QUICKNODE_API_KEY='your-api-key-here'"
	echo "  ./scripts/fix-webhook-state.sh"
	echo ""
	echo "Option 2: Add to terraform.tfvars"
	echo '  quicknode_api_key = "your-api-key-here"'
	echo ""
	echo "Get your API key from: https://dashboard.quicknode.com/api-keys"
	exit 1
fi

echo "Checking webhook existence in QuickNode..."
echo ""

MISSING_WEBHOOKS=()

while IFS= read -r resource; do
	if [[ -z ${resource} ]]; then
		continue
	fi

	echo "Checking: ${resource}"

	# Extract webhook ID from state
	WEBHOOK_ID=$(terraform state show "${resource}" 2>/dev/null | grep -E '^\s+id\s+=' | awk '{print $3}' | tr -d '"' || echo "")

	if [[ -z ${WEBHOOK_ID} ]]; then
		warn "  ⚠ Could not extract webhook ID from state"
		continue
	fi

	echo "  Webhook ID: ${WEBHOOK_ID}"

	# Check if webhook exists in QuickNode
	HTTP_CODE=$(curl -s -o /tmp/webhook_check.json -w "%{http_code}" \
		-H "x-api-key: ${QUICKNODE_API_KEY}" \
		-H "accept: application/json" \
		"https://api.quicknode.com/webhooks/rest/v1/webhooks/${WEBHOOK_ID}")

	if [[ ${HTTP_CODE} == "200" ]]; then
		info "  ✓ Webhook exists in QuickNode"
	elif [[ ${HTTP_CODE} == "404" ]]; then
		error "  ✗ Webhook NOT FOUND in QuickNode (404)"
		MISSING_WEBHOOKS+=("${resource}")
	else
		warn "  ⚠ Unexpected response code: ${HTTP_CODE}"
		cat /tmp/webhook_check.json 2>/dev/null || true
	fi

	rm -f /tmp/webhook_check.json
	echo ""
done <<<"${WEBHOOK_RESOURCES}"

# If we found missing webhooks, offer to remove them from state
if [[ ${#MISSING_WEBHOOKS[@]} -gt 0 ]]; then
	warn "Found ${#MISSING_WEBHOOKS[@]} webhook(s) in Terraform state that don't exist in QuickNode:"
	for webhook in "${MISSING_WEBHOOKS[@]}"; do
		echo "  - ${webhook}"
	done
	echo ""

	read -p "Remove these from Terraform state? (y/N) " -n 1 -r
	echo

	if [[ ${REPLY} =~ ^[Yy]$ ]]; then
		for webhook in "${MISSING_WEBHOOKS[@]}"; do
			echo "Removing: ${webhook}"
			terraform state rm -lock=false "${webhook}"
		done
		info "✓ Removed missing webhooks from state"
		echo ""
		echo "Next steps:"
		echo "  1. Run 'terraform plan' to see what will be created"
		echo "  2. Run 'terraform apply' to recreate the missing webhooks"
	else
		echo "Skipped state cleanup."
		echo ""
		echo "To manually remove a webhook from state, run:"
		echo "  terraform state rm 'module.onchain_event_listeners[\"<network>\"].restapi_object.multisig_webhook'"
	fi
else
	info "✓ All webhooks in Terraform state exist in QuickNode"
fi
