#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
repair_script="${repo_root}/alerts/infra/scripts/fix-webhook-state.sh"
listener_main="${repo_root}/alerts/infra/onchain-event-listeners/main.tf"
tmp_dir="$(mktemp -d)"
fake_bin="${tmp_dir}/bin"
fixture_root="${tmp_dir}/terraform-root"
call_log="${tmp_dir}/calls.log"

cleanup() {
	rm -rf "${tmp_dir}"
}
trap cleanup EXIT

fail() {
	echo "fix-webhook-state test failed: $*" >&2
	exit 1
}

mkdir -p "${fake_bin}" "${fixture_root}"
touch "${fixture_root}/main.tf" "${call_log}"

cat >"${fake_bin}/terraform" <<'FAKE_TERRAFORM'
#!/usr/bin/env bash
set -euo pipefail

printf 'terraform' >>"${FAKE_CALL_LOG}"
printf ' %q' "$@" >>"${FAKE_CALL_LOG}"
printf '\n' >>"${FAKE_CALL_LOG}"

if [[ ${1-} == "state" && ${2-} == "list" ]]; then
	printf '%s\n' 'module.onchain_event_listeners["celo"].restapi_object.multisig_webhook'
	exit 0
fi

if [[ ${1-} == "state" && ${2-} == "show" ]]; then
	cat <<'STATE'
# module.onchain_event_listeners["celo"].restapi_object.multisig_webhook:
resource "restapi_object" "multisig_webhook" {
    api_data = jsonencode(
        {
            destination_attributes = {
                id = "nested-destination-id"
            }
            id = "nested-api-data-id"
        }
    )
    api_response = jsonencode(
        {
            id = "nested-api-response-id"
        }
    )
    id = "canonical-webhook-id"
STATE
	if [[ ${FAKE_STATE_MODE:-normal} == "duplicate-top-level" ]]; then
		printf '%s\n' '    id = "second-top-level-id"'
	fi
	printf '%s\n' '}'
	exit 0
fi

if [[ ${1-} == "state" && ${2-} == "rm" ]]; then
	echo "unexpected terraform state rm" >&2
	exit 97
fi

echo "unexpected terraform invocation: $*" >&2
exit 98
FAKE_TERRAFORM

cat >"${fake_bin}/curl" <<'FAKE_CURL'
#!/usr/bin/env bash
set -euo pipefail

output_file=""
url=""
while [[ $# -gt 0 ]]; do
	case "$1" in
	-o | --output)
		output_file="${2-}"
		shift 2
		;;
	https://*)
		url="$1"
		shift
		;;
	*)
		shift
		;;
	esac
done

printf 'curl %s\n' "${url}" >>"${FAKE_CALL_LOG}"
expected_url="https://api.quicknode.com/webhooks/rest/v1/webhooks/canonical-webhook-id"
if [[ ${url} != "${expected_url}" ]]; then
	echo "unexpected QuickNode URL: ${url}" >&2
	exit 96
fi

printf '%s\n' '{"diagnostic":"must not be printed"}' >"${output_file}"
printf '%s' "${FAKE_HTTP_CODE:-200}"
FAKE_CURL

chmod +x "${fake_bin}/terraform" "${fake_bin}/curl"

run_repair() {
	local http_code="$1"
	local state_mode="${2:-normal}"
	(
		cd "${fixture_root}"
		PATH="${fake_bin}:${PATH}" \
			QUICKNODE_API_KEY="fixture-api-key" \
			FAKE_CALL_LOG="${call_log}" \
			FAKE_HTTP_CODE="${http_code}" \
			FAKE_STATE_MODE="${state_mode}" \
			bash "${repair_script}"
	)
}

# shellcheck disable=SC2016 # assertion intentionally matches literal HCL shell text
grep -Fq 'terraform_state_resource_id "$STATE_PATH"' "${listener_main}" ||
	fail "replacement provisioner does not use the shared state-ID parser"

output=""
if ! output=$(run_repair 200 2>&1); then
	echo "${output}" >&2
	fail "provider-v3 fixture should pass"
fi
grep -Fq "Webhook ID: canonical-webhook-id" <<<"${output}" ||
	fail "repair tool did not select the resource-level ID"
grep -Fq "curl https://api.quicknode.com/webhooks/rest/v1/webhooks/canonical-webhook-id" "${call_log}" ||
	fail "curl did not receive exactly the resource-level ID"
if grep -Fq "nested-" "${call_log}"; then
	fail "a nested provider response ID leaked into the QuickNode URL"
fi

: >"${call_log}"
set +e
output=$(run_repair 503 2>&1)
status=$?
set -e
[[ ${status} -ne 0 ]] || fail "transient QuickNode failure should fail closed"
grep -Fq "no Terraform state changes were made" <<<"${output}" ||
	fail "transient failure did not report the fail-closed state verdict"
if grep -Fq "terraform state rm" "${call_log}"; then
	fail "transient failure attempted to remove Terraform state"
fi
if grep -Fq "must not be printed" <<<"${output}"; then
	fail "unexpected QuickNode response body leaked to output"
fi

: >"${call_log}"
set +e
output=$(run_repair 200 duplicate-top-level 2>&1)
status=$?
set -e
[[ ${status} -ne 0 ]] || fail "ambiguous top-level IDs should fail closed"
if grep -Fq "curl " "${call_log}"; then
	fail "ambiguous state should not call QuickNode"
fi

echo "fix-webhook-state tests passed"
