#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
setup_script="$repo_root/scripts/bootstrap/codex-cloud-setup.sh"
suite_tmp="$(mktemp -d)"
trap 'rm -rf -- "$suite_tmp"' EXIT

fail() {
  local message="$1"
  echo "codex-cloud-setup.test.sh: ${message}" >&2
  if [[ -n "${case_stdout:-}" && -s "$case_stdout" ]]; then
    echo "stdout:" >&2
    sed 's/^/  /' "$case_stdout" >&2
  fi
  if [[ -n "${case_stderr:-}" && -s "$case_stderr" ]]; then
    echo "stderr:" >&2
    sed 's/^/  /' "$case_stderr" >&2
  fi
  exit 1
}

assert_no_fetch_or_execution() {
  [[ ! -s "$case_curl_log" ]] || fail "${case_name}: called curl before rejecting the installer configuration"
  [[ ! -s "$case_exec_log" ]] || fail "${case_name}: executed an installer before rejecting the installer configuration"
  [[ ! -s "$case_tool_log" ]] || fail "${case_name}: ran a Foundry tool before rejecting the installer configuration"
}

assert_download_was_cleaned() {
  [[ -s "$case_download_log" ]] || fail "${case_name}: did not record a temporary download path"
  local download_path
  download_path="$(tail -n 1 "$case_download_log")"
  [[ ! -e "$download_path" ]] || fail "${case_name}: left the temporary installer at ${download_path}"
}

prepare_case() {
  case_name="$1"
  case_dir="$suite_tmp/$case_name"
  case_home="$case_dir/home"
  case_tmp="$case_dir/tmp"
  case_stdout="$case_dir/stdout"
  case_stderr="$case_dir/stderr"
  case_curl_log="$case_dir/curl.log"
  case_download_log="$case_dir/download.log"
  case_exec_log="$case_dir/installer-exec.log"
  case_tool_log="$case_dir/tool.log"
  mkdir -p "$case_home" "$case_tmp"
}

mock_bin="$suite_tmp/bin"
installer_source="$suite_tmp/foundry-installer.sh"
mkdir -p "$mock_bin"

cat >"$installer_source" <<'INSTALLER'
#!/usr/bin/env bash
set -euo pipefail

printf 'installer\n' >>"$TEST_EXEC_LOG"
if [[ "${TEST_INSTALLER_FAIL:-0}" == "1" ]]; then
  exit 23
fi

mkdir -p "$HOME/.foundry/bin"
{
  printf '%s\n' '#!/usr/bin/env bash'
  printf '%s\n' 'set -euo pipefail'
  printf '%s\n' 'printf "foundryup\\n" >>"$TEST_TOOL_LOG"'
  printf '%s\n' 'echo "foundryup test fixture"'
} >"$HOME/.foundry/bin/foundryup"
{
  printf '%s\n' '#!/usr/bin/env bash'
  printf '%s\n' 'set -euo pipefail'
  printf '%s\n' 'printf "forge\\n" >>"$TEST_TOOL_LOG"'
  printf '%s\n' 'echo "forge test fixture"'
} >"$HOME/.foundry/bin/forge"
chmod +x "$HOME/.foundry/bin/foundryup" "$HOME/.foundry/bin/forge"
INSTALLER
chmod +x "$installer_source"

cat >"$mock_bin/curl" <<'MOCK_CURL'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >>"$TEST_CURL_LOG"

output_path=""
url=""
while (( $# > 0 )); do
  case "$1" in
    -o)
      [[ $# -ge 2 ]] || exit 2
      output_path="$2"
      shift 2
      ;;
    -*)
      shift
      ;;
    *)
      url="$1"
      shift
      ;;
  esac
done

[[ "$url" == "$TEST_EXPECTED_URL" ]] || {
  echo "unexpected URL: ${url}" >&2
  exit 96
}

if [[ -n "$output_path" ]]; then
  printf '%s\n' "$output_path" >>"$TEST_DOWNLOAD_LOG"
  [[ -f "$output_path" && ! -L "$output_path" ]] || {
    echo "curl destination was not a temporary regular file: ${output_path}" >&2
    exit 97
  }
fi

if [[ "${TEST_CURL_FAIL:-0}" == "1" ]]; then
  exit 22
fi

if [[ -n "$output_path" ]]; then
  cp "$TEST_INSTALLER_SOURCE" "$output_path"
else
  cat "$TEST_INSTALLER_SOURCE"
fi
MOCK_CURL
chmod +x "$mock_bin/curl"

installer_sha256="$(sha256sum "$installer_source" | awk '{print $1}')"
custom_url="https://mirror.example.test/foundryup"
default_url="https://foundry.paradigm.xyz"

run_install() {
  local url_value="${1-__UNSET__}"
  local sha_value="${2-__UNSET__}"
  local installer_fail="${3:-0}"
  local curl_fail="${4:-0}"

  (
    export HOME="$case_home"
    export TMPDIR="$case_tmp"
    export PATH="$mock_bin:/usr/bin:/bin:/usr/sbin:/sbin"
    export TEST_CURL_LOG="$case_curl_log"
    export TEST_DOWNLOAD_LOG="$case_download_log"
    export TEST_EXEC_LOG="$case_exec_log"
    export TEST_TOOL_LOG="$case_tool_log"
    export TEST_INSTALLER_SOURCE="$installer_source"
    export TEST_INSTALLER_FAIL="$installer_fail"
    export TEST_CURL_FAIL="$curl_fail"
    export TEST_EXPECTED_URL="${url_value/__UNSET__/$default_url}"
    unset CODEX_CLOUD_FOUNDRYUP_URL CODEX_CLOUD_FOUNDRYUP_SHA256
    if [[ "$url_value" != "__UNSET__" ]]; then
      export CODEX_CLOUD_FOUNDRYUP_URL="$url_value"
    fi
    if [[ "$sha_value" != "__UNSET__" ]]; then
      export CODEX_CLOUD_FOUNDRYUP_SHA256="$sha_value"
    fi

    # shellcheck source=scripts/bootstrap/codex-cloud-setup.sh
    source "$setup_script"
    persist_user_path_entry() { :; }
    install_foundry
  ) >"$case_stdout" 2>"$case_stderr"
}

prepare_case "custom-url-without-sha"
if run_install "$custom_url"; then
  fail "${case_name}: accepted a custom URL without a sha256"
fi
grep -Fq "CODEX_CLOUD_FOUNDRYUP_SHA256 is required" "$case_stderr" ||
  fail "${case_name}: did not explain the required sha256"
assert_no_fetch_or_execution

for malformed_sha256 in abc123 "$(printf 'a%.0s' {1..63})" "$(printf 'g%.0s' {1..64})"; do
  prepare_case "malformed-sha-${#malformed_sha256}"
  if run_install "$custom_url" "$malformed_sha256"; then
    fail "${case_name}: accepted a malformed sha256"
  fi
  grep -Fq "exactly 64 hexadecimal characters" "$case_stderr" ||
    fail "${case_name}: did not explain the sha256 syntax requirement"
  assert_no_fetch_or_execution
done

prepare_case "custom-url-sha-mismatch"
mismatched_sha256="$(printf '0%.0s' {1..64})"
[[ "$mismatched_sha256" != "$installer_sha256" ]] || fail "test fixture unexpectedly has the all-zero sha256"
if run_install "$custom_url" "$mismatched_sha256"; then
  fail "${case_name}: accepted a mismatched sha256"
fi
[[ -s "$case_curl_log" ]] || fail "${case_name}: did not download the configured installer"
[[ ! -s "$case_exec_log" ]] || fail "${case_name}: executed the installer after a checksum mismatch"
[[ ! -s "$case_tool_log" ]] || fail "${case_name}: ran Foundry tools after a checksum mismatch"
assert_download_was_cleaned

prepare_case "custom-url-download-failure"
if run_install "$custom_url" "$installer_sha256" 0 1; then
  fail "${case_name}: accepted a failed installer download"
fi
[[ ! -s "$case_exec_log" ]] || fail "${case_name}: executed the installer after a download failure"
assert_download_was_cleaned

prepare_case "custom-url-matching-sha"
if ! run_install "$custom_url" "$installer_sha256"; then
  fail "${case_name}: rejected a matching sha256"
fi
grep -Fq -- "-o " "$case_curl_log" || fail "${case_name}: did not use a file download"
[[ "$(wc -l <"$case_exec_log")" -eq 1 ]] || fail "${case_name}: did not execute the verified installer exactly once"
grep -Fxq "foundryup" "$case_tool_log" || fail "${case_name}: did not run foundryup"
grep -Fxq "forge" "$case_tool_log" || fail "${case_name}: did not verify forge"
assert_download_was_cleaned

prepare_case "custom-url-installer-failure"
if run_install "$custom_url" "$installer_sha256" 1; then
  fail "${case_name}: accepted a failing verified installer"
fi
[[ "$(wc -l <"$case_exec_log")" -eq 1 ]] || fail "${case_name}: did not execute the verified failing installer exactly once"
[[ ! -s "$case_tool_log" ]] || fail "${case_name}: ran Foundry tools after the installer failed"
assert_download_was_cleaned

prepare_case "default-public-installer"
if ! run_install; then
  fail "${case_name}: rejected the documented default public installer path"
fi
grep -Fq "$default_url" "$case_curl_log" || fail "${case_name}: did not request the default public installer URL"
if grep -Fq -- "-o " "$case_curl_log"; then
  fail "${case_name}: changed the default public installer from its documented pipeline"
fi
[[ ! -s "$case_download_log" ]] || fail "${case_name}: used the custom verified-file path"
[[ "$(wc -l <"$case_exec_log")" -eq 1 ]] || fail "${case_name}: did not execute the default installer exactly once"
grep -Fxq "foundryup" "$case_tool_log" || fail "${case_name}: did not run foundryup"
grep -Fxq "forge" "$case_tool_log" || fail "${case_name}: did not verify forge"

echo "codex-cloud-setup.test.sh: all checks passed"
