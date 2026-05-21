#!/bin/bash
# Manage QuickNode webhook lifecycle (pause/delete)
# This script handles pausing and deleting QuickNode webhooks before Terraform operations

set -euo pipefail

# Usage: manage-quicknode-webhook.sh <action> <webhook_id> [api_key]
# Actions: pause, delete, pause-and-delete
# If api_key is not provided, uses QUICKNODE_API_KEY environment variable

ACTION="${1-}"
WEBHOOK_ID="${2-}"
API_KEY="${3:-${QUICKNODE_API_KEY-}}"

if [[ -z ${ACTION} ]]; then
	echo "Error: Action required (pause, delete, pause-and-delete)"
	exit 1
fi

if [[ -z ${WEBHOOK_ID} ]]; then
	echo "Error: Webhook ID required"
	exit 1
fi

if [[ -z ${API_KEY} ]]; then
	echo "Error: QuickNode API key required (provide as argument or set QUICKNODE_API_KEY environment variable)"
	exit 1
fi

QUICKNODE_API_BASE="https://api.quicknode.com/webhooks/rest/v1/webhooks"

pause_webhook() {
	local webhook_id="$1"
	local api_key="$2"

	echo "Pausing webhook ${webhook_id}..."

	HTTP_CODE=$(curl -s -o /tmp/webhook_pause.json -w "%{http_code}" -X PUT \
		"${QUICKNODE_API_BASE}/${webhook_id}" \
		-H "x-api-key: ${api_key}" \
		-H "Content-Type: application/json" \
		-H "accept: application/json" \
		-d '{"status": "paused"}')

	if [[ ${HTTP_CODE} == "200" ]] || [[ ${HTTP_CODE} == "204" ]]; then
		echo "Webhook paused successfully (HTTP ${HTTP_CODE})"
		rm -f /tmp/webhook_pause.json
		return 0
	else
		BODY=$(cat /tmp/webhook_pause.json 2>/dev/null || echo "No response body")
		echo "Warning: Failed to pause webhook (HTTP ${HTTP_CODE}): ${BODY}"
		rm -f /tmp/webhook_pause.json
		return 1
	fi
}

delete_webhook() {
	local webhook_id="$1"
	local api_key="$2"

	echo "Deleting webhook ${webhook_id}..."

	DELETE_CODE=$(curl -s -o /tmp/webhook_delete.json -w "%{http_code}" -X DELETE \
		"${QUICKNODE_API_BASE}/${webhook_id}" \
		-H "x-api-key: ${api_key}" \
		-H "accept: application/json")

	if [[ ${DELETE_CODE} == "200" ]] || [[ ${DELETE_CODE} == "204" ]]; then
		echo "Webhook deleted successfully (HTTP ${DELETE_CODE})"
		rm -f /tmp/webhook_delete.json
		return 0
	else
		DELETE_BODY=$(cat /tmp/webhook_delete.json 2>/dev/null || echo "No response body")
		echo "Warning: Failed to delete webhook (HTTP ${DELETE_CODE}): ${DELETE_BODY}"
		rm -f /tmp/webhook_delete.json
		return 1
	fi
}

case "${ACTION}" in
pause)
	pause_webhook "${WEBHOOK_ID}" "${API_KEY}"
	;;
delete)
	delete_webhook "${WEBHOOK_ID}" "${API_KEY}"
	;;
pause-and-delete)
	set +e
	pause_webhook "${WEBHOOK_ID}" "${API_KEY}"
	PAUSE_RESULT=$?
	set -e
	if [[ ${PAUSE_RESULT} -eq 0 ]]; then
		delete_webhook "${WEBHOOK_ID}" "${API_KEY}"
	else
		echo "Failed to pause webhook, skipping delete"
		exit 1
	fi
	;;
*)
	echo "Error: Unknown action: ${ACTION}"
	echo "Valid actions: pause, delete, pause-and-delete"
	exit 1
	;;
esac
