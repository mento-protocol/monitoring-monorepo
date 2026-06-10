#!/usr/bin/env bash
# shellcheck disable=SC2310,SC2311,SC2312
set -euo pipefail

# =============================================================================
# DEPLOY QUICKNODE FILTER FUNCTIONS
#
# Webhooks use the evmAbiFilter template. Updates are applied live via:
#   PATCH /webhooks/{id}/template/evmAbiFilterGo
# No pause or downtime needed — template arg updates take effect immediately.
#
# Usage:
#   ./bin/deploy-quicknode-filter.sh [--webhook healthcheck|governor|all]
#
# Prerequisites:
#   - gcloud CLI authenticated with access to the governance-watchdog project
#   - curl, python3 available
#   - QuickNode API key stored in GCP Secret Manager as "quicknode-api-key"
# =============================================================================

WEBHOOK_TARGET="${1:-all}"
if [[ ${WEBHOOK_TARGET} == "--webhook" ]]; then
	WEBHOOK_TARGET="${2:-all}"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
FILTER_DIR="${REPO_ROOT}/infra/quicknode-filter-functions"

# Webhook IDs (from QuickNode API)
# Webhook IDs are server-assigned by QuickNode and will change if webhooks are deleted and recreated.
# To find current IDs: curl -s -H "x-api-key: <key>" https://api.quicknode.com/webhooks/rest/v1/webhooks | jq '.data[] | {id, name}'
# Or check the URL when viewing a webhook in the QuickNode dashboard.
HEALTHCHECK_WEBHOOK_ID="dc35c3c4-b839-49f6-836b-6ffb7c087419"
GOVERNOR_WEBHOOK_ID="73a99141-e8cb-411a-9732-c42a031cebe6"

QN_API_BASE="https://api.quicknode.com/webhooks/rest/v1/webhooks"

# Global array to track temp files created by deploy_webhook invocations.
# A single EXIT trap at script level cleans them all up, avoiding the problem
# of per-call traps overwriting the previous trap registration.
TMP_FILES=()
cleanup_temp_files() {
	if ((${#TMP_FILES[@]} > 0)); then
		rm -f "${TMP_FILES[@]}"
	fi
}
trap cleanup_temp_files EXIT

# ------------------------------------------------------------------------------
log() { printf '\n\033[1m%s\033[0m\n' "$*"; }
success() { printf '✅ %s\n' "$*"; }
info() { printf '   %s\n' "$*"; }

# curl wrapper: captures body + HTTP status, returns body via stdout.
# Exits non-zero and prints the response body when HTTP status is not 2xx.
curl_api() {
	local raw http_code body
	raw=$(curl -s -w "\n__HTTP_STATUS__%{http_code}" "$@" 2>&1)
	http_code=$(printf '%s' "${raw}" | grep -o '__HTTP_STATUS__[0-9]*' | grep -o '[0-9]*')
	body=$(printf '%s' "${raw}" | sed 's/__HTTP_STATUS__[0-9]*$//')
	if [[ ! ${http_code} =~ ^2 ]]; then
		printf '%s\n' "${body}"
		return 1
	fi
	printf '%s\n' "${body}"
}
# ------------------------------------------------------------------------------

fetch_api_key() {
	log "Fetching QuickNode API key from Secret Manager..."
	project_id=$(gcloud config get-value project 2>/dev/null)
	if [[ -z ${project_id} ]]; then
		echo "❌ No gcloud project set. Run: gcloud config set project <project-id>"
		exit 1
	fi
	QN_API_KEY=$(gcloud secrets versions access latest \
		--secret=quicknode-api-key \
		--project="${project_id}" 2>/dev/null)
	if [[ -z ${QN_API_KEY} ]]; then
		echo "❌ Could not fetch QuickNode API key from Secret Manager."
		echo "   Make sure your gcloud account has secretmanager.secretAccessor on the project."
		exit 1
	fi
	success "API key fetched (${#QN_API_KEY} chars)"
}

deploy_webhook() {
	local webhook_id="$1"
	local filter_file="$2"
	local webhook_name="$3"

	log "Deploying filter for webhook: ${webhook_name} (${webhook_id})"
	info "Filter file: ${filter_file}"

	if [[ ! -f ${filter_file} ]]; then
		echo "❌ Filter file not found: ${filter_file}"
		exit 1
	fi

	# These are evmAbiFilter template-based webhooks. The .js filter file embeds the
	# ABI and contract addresses in the comment header and in the JS code itself.
	# Template-based webhooks cannot have filter_function updated directly via PATCH
	# /webhooks/{id} — they require PATCH /webhooks/{id}/template/{templateId} with
	# templateArgs: { abi, contracts }.

	# Extract abi JSON array and contracts array from the .js file comment header
	# Parse ABI (as raw JSON string) and contracts from the .js file comment header.
	# templateArgs.abiJson must be a string (not a parsed object).
	# The internal template ID for PATCH is "evmAbiFilterGo" (evmAbiFilter is the display name).
	local payload_file
	payload_file=$(mktemp /tmp/qn_payload.XXXXXX.json)
	TMP_FILES+=("${payload_file}")

	# Build templateArgs payload: abiJson must be a raw JSON string (not a parsed object).
	# Use env vars to avoid shell quoting issues with large ABI strings.
	# Regex anchors on "contracts:" newline to avoid truncating multi-event ABIs.
	QN_FILTER_FILE="${filter_file}" QN_PAYLOAD_FILE="${payload_file}" python3 -c '
import re, json, os, sys
content = open(os.environ["QN_FILTER_FILE"]).read()
m = re.search(r"/[*].*?template: evmAbiFilter\s+abi: (\[.*?\])\s*\ncontracts: (.+?)\s*[*]/", content, re.DOTALL)
if not m:
    print("ERROR: could not parse abi/contracts from comment header", file=sys.stderr)
    sys.exit(1)
abi_str = m.group(1)
# Validate ABI is well-formed JSON before sending to API
try:
    json.loads(abi_str)
except json.JSONDecodeError as e:
    print(f"ERROR: ABI is not valid JSON: {e}", file=sys.stderr)
    sys.exit(1)
contracts = [c.strip() for c in m.group(2).strip().split(",")]
payload = {"templateArgs": {"abiJson": abi_str, "contracts": contracts}}
with open(os.environ["QN_PAYLOAD_FILE"], "w") as f:
    json.dump(payload, f)
' || {
		echo "❌ Failed to parse ABI/contracts from ${filter_file}"
		exit 1
	}

	info "Contracts: $(python3 -c "import json; d=json.load(open('${payload_file}')); print(', '.join(d['templateArgs']['contracts']))")"

	# Update via template endpoint.
	# NOTE on field names vs the OpenAPI spec:
	#   The public OpenAPI spec (evmAbiFilter schema) lists the field as "abi".
	#   The actual live endpoint (evmAbiFilterGo) requires "abiJson" — empirically
	#   confirmed: sending "abi" returns a 500, sending "abiJson" succeeds.
	#   The display name in the UI is "evmAbiFilter"; the internal PATCH path uses
	#   "evmAbiFilterGo". Both discrepancies are QuickNode API inconsistencies.
	# No pause/unpause needed — template updates are applied hot.
	log "Updating template args via /template/evmAbiFilterGo endpoint..."
	local update_response
	update_response=$(curl_api -X PATCH "${QN_API_BASE}/${webhook_id}/template/evmAbiFilterGo" \
		-H "x-api-key: ${QN_API_KEY}" \
		-H "Content-Type: application/json" \
		--data-binary "@${payload_file}") || {
		echo "❌ Failed to update template args. API response:"
		echo "${update_response}"
		exit 1
	}
	success "Template args updated"

	# Verify
	log "Verifying deployment..."
	local verify_response
	verify_response=$(curl_api "${QN_API_BASE}/${webhook_id}" \
		-H "x-api-key: ${QN_API_KEY}" \
		-H "Content-Type: application/json") || {
		echo "❌ Failed to verify webhook. API response:"
		echo "${verify_response}"
		exit 1
	}
	local live_status
	live_status=$(echo "${verify_response}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('status','unknown'))")
	local template_id
	template_id=$(echo "${verify_response}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('templateId','none'))")

	info "Status: ${live_status}"
	info "Template: ${template_id}"

	if [[ ${live_status} == "active" ]]; then
		success "Webhook ${webhook_name} deployed successfully!"
	else
		echo "⚠️  Unexpected status '${live_status}' after deploy. Check QuickNode dashboard."
		exit 1
	fi
}

main() {
	log "QuickNode Filter Deployment Script"
	printf "Target: %s\n" "${WEBHOOK_TARGET}"

	fetch_api_key

	case "${WEBHOOK_TARGET}" in
	healthcheck)
		deploy_webhook \
			"${HEALTHCHECK_WEBHOOK_ID}" \
			"${FILTER_DIR}/sorted-oracles.js" \
			"SortedOracles (healthcheck)"
		;;
	governor)
		deploy_webhook \
			"${GOVERNOR_WEBHOOK_ID}" \
			"${FILTER_DIR}/governor.js" \
			"MentoGovernor"
		;;
	all)
		deploy_webhook \
			"${HEALTHCHECK_WEBHOOK_ID}" \
			"${FILTER_DIR}/sorted-oracles.js" \
			"SortedOracles (healthcheck)"
		deploy_webhook \
			"${GOVERNOR_WEBHOOK_ID}" \
			"${FILTER_DIR}/governor.js" \
			"MentoGovernor"
		;;
	*)
		echo "❌ Unknown target: ${WEBHOOK_TARGET}"
		echo "Usage: $0 [--webhook healthcheck|governor|all]"
		exit 1
		;;
	esac

	log "🎉 All done!"
}

main
