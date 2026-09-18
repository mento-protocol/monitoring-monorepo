#!/usr/bin/env bash
# Case subshells intentionally isolate environment mutations.
# shellcheck disable=SC2030,SC2031
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
  case_gh_log="$case_dir/gh.log"
  case_gh_state="$case_dir/gh-attach-state"
  case_apt_source="$case_dir/github-cli.list"
  case_apt_keyring="$case_dir/githubcli-archive-keyring.gpg"
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
  printf '%s\n' '[[ "${TEST_FOUNDRYUP_FAIL:-0}" != "1" ]] || exit 24'
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
  local foundryup_fail="${5:-0}"

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
    export TEST_FOUNDRYUP_FAIL="$foundryup_fail"
    export TEST_EXPECTED_URL="${url_value/__UNSET__/$default_url}"
    export CODEX_CLOUD_INSTALL_FOUNDRY=true
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

prepare_case "foundryup-failure"
if run_install "$custom_url" "$installer_sha256" 0 0 1; then
  fail "${case_name}: accepted a failing foundryup"
fi
grep -Fq "foundryup failed" "$case_stderr" ||
  fail "${case_name}: did not explain the foundryup failure"
grep -Fxq "foundryup" "$case_tool_log" || fail "${case_name}: did not run foundryup"
if grep -Fxq "forge" "$case_tool_log"; then
  fail "${case_name}: ran forge after foundryup failed"
fi
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

prepare_case "playwright-host-dependencies"
(
  # shellcheck source=scripts/bootstrap/codex-cloud-setup.sh
  source "$setup_script"
  pnpm() { printf '%s\n' "$*" >"$case_tool_log"; }
  install_playwright_host_dependencies
) >"$case_stdout" 2>"$case_stderr"
grep -Fxq -- "--filter @mento-protocol/ui-dashboard exec playwright install --with-deps chromium" "$case_tool_log" ||
  fail "${case_name}: did not install Chromium with Linux host dependencies"

prepare_case "playwright-host-dependencies-disabled"
(
  # shellcheck source=scripts/bootstrap/codex-cloud-setup.sh
  source "$setup_script"
  pnpm() { printf '%s\n' "$*" >"$case_tool_log"; }
  CODEX_CLOUD_INSTALL_PLAYWRIGHT_DEPS=false install_playwright_host_dependencies
) >"$case_stdout" 2>"$case_stderr"
[[ ! -s "$case_tool_log" ]] || fail "${case_name}: ran Playwright despite the explicit opt-out"

prepare_case "origin-write-access"
(
  # shellcheck source=scripts/bootstrap/codex-cloud-setup.sh
  source "$setup_script"
  git() {
    if [[ "$*" == "remote get-url origin" ]]; then
      echo "https://github.com/mento-protocol/monitoring-monorepo.git"
      return 0
    fi
    printf '%s\n' "$*" >>"$case_tool_log"
  }
  verify_origin_write_access
) >"$case_stdout" 2>"$case_stderr"
[[ "$(wc -l <"$case_tool_log")" -eq 2 ]] || fail "${case_name}: did not create and delete exactly one probe branch"
sed -n '1p' "$case_tool_log" | grep -Eq '^push origin HEAD:refs/heads/codex-cloud-write-probe-[0-9a-f]{32}$' ||
  fail "${case_name}: did not create a namespaced temporary branch"
sed -n '2p' "$case_tool_log" | grep -Eq '^push origin --delete codex-cloud-write-probe-[0-9a-f]{32}$' ||
  fail "${case_name}: did not delete the temporary branch"

prepare_case "github-api-origin-binding"
(
  # shellcheck source=scripts/bootstrap/codex-cloud-setup.sh
  source "$setup_script"
  git() {
    [[ "$*" == "remote get-url origin" ]] || return 1
    echo "https://github.com/mento-protocol/monitoring-monorepo.git"
  }
  gh() { printf '%s\n' "$*" >>"$case_tool_log"; }
  GH_REPO="wrong-owner/wrong-repo" verify_github_api_capabilities
) >"$case_stdout" 2>"$case_stderr"
[[ "$(wc -l <"$case_tool_log")" -eq 2 ]] || fail "${case_name}: did not run both API probes"
grep -Fxq "api repos/mento-protocol/monitoring-monorepo" "$case_tool_log" ||
  fail "${case_name}: repository probe did not target origin"
grep -Fxq "api repos/mento-protocol/monitoring-monorepo/pulls?state=open&per_page=1" "$case_tool_log" ||
  fail "${case_name}: pull-request probe did not target origin"
if grep -Fq "wrong-owner/wrong-repo" "$case_tool_log"; then
  fail "${case_name}: GH_REPO redirected an API probe"
fi

prepare_case "github-api-ssh-uri-origin"
(
  # shellcheck source=scripts/bootstrap/codex-cloud-setup.sh
  source "$setup_script"
  git() {
    [[ "$*" == "remote get-url origin" ]] || return 1
    echo "ssh://git@github.com/mento-protocol/monitoring-monorepo.git"
  }
  gh() { printf '%s\n' "$*" >>"$case_tool_log"; }
  verify_github_api_capabilities
) >"$case_stdout" 2>"$case_stderr"
grep -Fxq "api repos/mento-protocol/monitoring-monorepo" "$case_tool_log" ||
  fail "${case_name}: repository probe did not normalize the SSH URI origin"
grep -Fxq "api repos/mento-protocol/monitoring-monorepo/pulls?state=open&per_page=1" "$case_tool_log" ||
  fail "${case_name}: pull-request probe did not normalize the SSH URI origin"

prepare_case "origin-write-access-refused"
(
  # shellcheck source=scripts/bootstrap/codex-cloud-setup.sh
  source "$setup_script"
  git() {
    if [[ "$*" == "remote get-url origin" ]]; then
      echo "https://github.com/mento-protocol/monitoring-monorepo.git"
      return 0
    fi
    printf '%s\n' "$*" >>"$case_tool_log"
    return 1
  }
  verify_origin_write_access
) >"$case_stdout" 2>"$case_stderr" && fail "${case_name}: accepted a read-only GitHub credential"
grep -Fq "Contents read/write permission" "$case_stderr" ||
  fail "${case_name}: did not explain the required GitHub permission"
[[ "$(grep -c '^push origin --delete ' "$case_tool_log")" -eq 1 ]] ||
  fail "${case_name}: did not attempt cleanup after an ambiguous create failure"

prepare_case "origin-write-access-delete-retry"
(
  # shellcheck source=scripts/bootstrap/codex-cloud-setup.sh
  source "$setup_script"
  delete_attempts=0
  git() {
    if [[ "$*" == "remote get-url origin" ]]; then
      echo "https://github.com/mento-protocol/monitoring-monorepo.git"
      return 0
    fi
    printf '%s\n' "$*" >>"$case_tool_log"
    if [[ "$*" == push\ origin\ --delete* ]]; then
      delete_attempts=$((delete_attempts + 1))
      [[ "$delete_attempts" -gt 1 ]]
      return
    fi
  }
  verify_origin_write_access
) >"$case_stdout" 2>"$case_stderr" && fail "${case_name}: accepted an initial cleanup failure"
[[ "$(grep -c '^push origin --delete ' "$case_tool_log")" -eq 2 ]] ||
  fail "${case_name}: EXIT cleanup did not retry the failed deletion"

# `gh pr edit --attach` (gh 2.99.0 or later) uploads the Before/After
# screenshots docs/notes/dashboard-verification.md requires. This mock gh
# answers only the help probe, so an implementation that reads `gh --version`
# instead fails the probe and shows up in the invocation log.
attach_bin="$suite_tmp/attach-bin"
mkdir -p "$attach_bin"
cat >"$attach_bin/gh" <<'MOCK_GH'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >>"$TEST_GH_LOG"
case "$*" in
  "pr edit --help")
    echo "Edit a pull request in GitHub."
    if [[ "$(cat "$TEST_GH_ATTACH_STATE")" == "supported" ]]; then
      echo "      --attach file   Attach an image or video file"
    fi
    ;;
  *)
    echo "unexpected gh invocation: $*" >&2
    exit 95
    ;;
esac
MOCK_GH
chmod +x "$attach_bin/gh"
# Present only so `command -v apt-get` matches on macOS as well as on the CI
# image. Every apt command runs through the mocked run_as_root, so this binary
# is never the thing that installs anything.
printf '#!/usr/bin/env bash\nexit 0\n' >"$attach_bin/apt-get"
printf '#!/usr/bin/env bash\necho amd64\n' >"$attach_bin/dpkg"
cat >"$attach_bin/curl" <<'MOCK_ATTACH_CURL'
#!/usr/bin/env bash
set -euo pipefail

# Writes a non-empty body to the -o destination so the keyring install can
# proceed. TEST_CURL_FAIL=1 makes the download fail the way a blocked host
# does: non-zero, with nothing written.
output_path=""
while (($# > 0)); do
  case "$1" in
    -o)
      output_path="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

[[ "${TEST_CURL_FAIL:-0}" != "1" ]] || exit 22
[[ -z "$output_path" ]] || printf 'keyring-bytes\n' >"$output_path"
MOCK_ATTACH_CURL
chmod +x "$attach_bin/apt-get" "$attach_bin/dpkg" "$attach_bin/curl"

run_attach_support() {
  local initial_state="$1"
  local upgrade_mode="$2"

  printf '%s\n' "$initial_state" >"$case_gh_state"
  (
    export PATH="$attach_bin:$PATH"
    export TEST_GH_LOG="$case_gh_log"
    export TEST_GH_ATTACH_STATE="$case_gh_state"
    # shellcheck source=scripts/bootstrap/codex-cloud-setup.sh
    source "$setup_script"
    CODEX_CLOUD_GH_APT_SOURCE="$case_apt_source"
    CODEX_CLOUD_GH_APT_KEYRING="$case_apt_keyring"
    # No apt command may reach the host running this suite.
    run_as_root() { printf '%s\n' "$*" >>"$case_tool_log"; }
    install_github_cli_from_official_apt_repo() {
      printf 'apt-repo-install\n' >>"$case_tool_log"
      [[ "$upgrade_mode" != "deliver" ]] || printf 'supported\n' >"$TEST_GH_ATTACH_STATE"
      [[ "$upgrade_mode" == "fail" ]] && return 1
      return 0
    }
    ensure_github_cli_attach_support
  ) >"$case_stdout" 2>"$case_stderr"
}

prepare_case "gh-attach-already-supported"
if ! run_attach_support supported deliver; then
  fail "${case_name}: rejected a gh that already supports --attach"
fi
grep -Fxq "pr edit --help" "$case_gh_log" ||
  fail "${case_name}: did not probe 'gh pr edit --help'"
[[ ! -s "$case_tool_log" ]] ||
  fail "${case_name}: reinstalled gh although --attach was already present"
[[ ! -s "$case_stderr" ]] ||
  fail "${case_name}: warned although --attach was already present"

prepare_case "gh-attach-upgrade-delivers"
if ! run_attach_support unsupported deliver; then
  fail "${case_name}: failed after the upgrade delivered --attach"
fi
[[ "$(grep -c '^apt-repo-install$' "$case_tool_log")" -eq 1 ]] ||
  fail "${case_name}: did not upgrade gh exactly once through the official apt repository"
[[ "$(grep -c '^pr edit --help$' "$case_gh_log")" -eq 2 ]] ||
  fail "${case_name}: did not re-probe the capability after the upgrade"
[[ ! -s "$case_stderr" ]] ||
  fail "${case_name}: reported a blocker after a successful upgrade"

prepare_case "gh-attach-upgrade-unavailable"
if ! run_attach_support unsupported fail; then
  fail "${case_name}: failed the whole setup over a missing visual-evidence capability"
fi
[[ "$(grep -c '^apt-repo-install$' "$case_tool_log")" -eq 1 ]] ||
  fail "${case_name}: did not attempt the upgrade before reporting a blocker"
grep -Fq 'gh pr edit --attach' "$case_stderr" ||
  fail "${case_name}: did not name the missing capability"
grep -Fq "cli.github.com" "$case_stderr" ||
  fail "${case_name}: did not name the upgrade source an operator must unblock"
grep -Fq "docs/notes/dashboard-verification.md" "$case_stderr" ||
  fail "${case_name}: did not name the evidence contract the gap blocks"
if grep -Fq -- "--version" "$case_gh_log"; then
  fail "${case_name}: read the gh version string instead of probing the flag"
fi

# The cases below run the real apt installer with a mocked run_as_root and both
# apt paths redirected into the case directory, so nothing here touches a host's
# /etc. The mock performs writes only for those redirected paths, which is what
# lets the assertions read real file state.
run_attach_upgrade_with_apt() {
  local fail_match="${1:-__no_such_step__}"
  local curl_fail="${2:-0}"

  printf 'unsupported\n' >"$case_gh_state"
  (
    export PATH="$attach_bin:$PATH"
    export TEST_GH_LOG="$case_gh_log"
    export TEST_GH_ATTACH_STATE="$case_gh_state"
    export TEST_CURL_FAIL="$curl_fail"
    # shellcheck source=scripts/bootstrap/codex-cloud-setup.sh
    source "$setup_script"
    CODEX_CLOUD_GH_APT_SOURCE="$case_apt_source"
    CODEX_CLOUD_GH_APT_KEYRING="$case_apt_keyring"
    run_as_root() {
      printf '%s\n' "$*" >>"$case_tool_log"
      [[ "$*" != *"$fail_match"* ]] || return 1
      case "$1" in
        tee)
          [[ "$2" != "$case_dir"/* ]] || cat >"$2"
          ;;
        install)
          local install_dest="${*: -1}"
          [[ "$install_dest" != "$case_dir"/* ]] || cp "${*: -2:1}" "$install_dest"
          ;;
        rm)
          shift
          rm -f "$@"
          ;;
      esac
      return 0
    }
    ensure_github_cli_attach_support
  ) >"$case_stdout" 2>"$case_stderr"
}

# Fail the keyring DIRECTORY step, which matches exactly one installer command,
# so the assertions below prove the chain stopped rather than that a later
# command happened to share the match.
prepare_case "gh-attach-apt-installer-stops-at-first-failure"
if ! run_attach_upgrade_with_apt "install -m 0755 -d"; then
  fail "${case_name}: failed setup after an optional upgrade step failed"
fi
grep -Fq "install -m 0755 -d /etc/apt/keyrings" "$case_tool_log" ||
  fail "${case_name}: never attempted the keyring directory step"
if grep -Fq "githubcli-archive-keyring.gpg" "$case_tool_log"; then
  fail "${case_name}: kept installing the keyring after its directory step failed"
fi
if grep -Fq "$case_apt_source" "$case_tool_log"; then
  fail "${case_name}: wrote the apt source after an earlier installer step failed"
fi
[[ ! -e "$case_apt_source" ]] ||
  fail "${case_name}: left an apt source behind a keyring it never installed"

prepare_case "gh-attach-apt-source-rolled-back"
if ! run_attach_upgrade_with_apt "apt-get install -y gh"; then
  fail "${case_name}: failed setup after an optional upgrade step failed"
fi
grep -Fq "tee $case_apt_source" "$case_tool_log" ||
  fail "${case_name}: never wrote the apt source it is expected to roll back"
grep -Fq "rm -f $case_apt_source" "$case_tool_log" ||
  fail "${case_name}: did not roll back the apt source it added"
[[ ! -e "$case_apt_source" ]] ||
  fail "${case_name}: left an unusable apt source in place"
grep -Fq "docs/notes/dashboard-verification.md" "$case_stderr" ||
  fail "${case_name}: did not report the visual-evidence blocker"

# An image that already carries a GitHub CLI apt source, such as an approved
# mirror, must be upgraded through it: this optional step cannot restore a file
# it overwrites.
prepare_case "gh-attach-apt-source-preexisting-kept"
printf 'preexisting\n' >"$case_apt_source"
if ! run_attach_upgrade_with_apt "apt-get install -y gh"; then
  fail "${case_name}: failed setup after an optional upgrade step failed"
fi
[[ "$(cat "$case_apt_source")" == "preexisting" ]] ||
  fail "${case_name}: overwrote an apt source this run did not add"
if grep -Fq "rm -f $case_apt_source" "$case_tool_log"; then
  fail "${case_name}: attempted to roll back an apt source this run did not add"
fi
if grep -Fq "githubcli-archive-keyring.gpg" "$case_tool_log"; then
  fail "${case_name}: reconfigured the official repository over an existing source"
fi
grep -Fq "apt-get install -y gh" "$case_tool_log" ||
  fail "${case_name}: did not upgrade gh through the source already configured"

# The apt lists can be absent on an image that shipped an old gh, because
# ensure_github_cli only refreshes them when gh is missing.
grep -Fq "apt-get update" "$case_tool_log" ||
  fail "${case_name}: did not refresh the apt lists before installing"

# A blocked keyring download must leave a working keyring alone. Piping curl
# into `tee` would empty this file before the failure surfaced.
prepare_case "gh-attach-keyring-survives-download-failure"
printf 'existing-keyring\n' >"$case_apt_keyring"
if ! run_attach_upgrade_with_apt "" 1; then
  fail "${case_name}: failed setup after a blocked keyring download"
fi
[[ "$(cat "$case_apt_keyring")" == "existing-keyring" ]] ||
  fail "${case_name}: overwrote the existing keyring with a failed download"
[[ ! -e "$case_apt_source" ]] ||
  fail "${case_name}: wrote an apt source after the keyring download failed"
grep -Fq "docs/notes/dashboard-verification.md" "$case_stderr" ||
  fail "${case_name}: did not report the visual-evidence blocker"

prepare_case "non-github-origin-probes"
(
  # shellcheck source=scripts/bootstrap/codex-cloud-setup.sh
  source "$setup_script"
  git() {
    [[ "$*" == "remote get-url origin" ]] || fail "${case_name}: attempted git mutation for non-GitHub origin"
    echo "https://git.example.test/mento/monitoring-monorepo.git"
  }
  gh() { fail "${case_name}: attempted GitHub API access for non-GitHub origin"; }
  verify_github_api_capabilities
  verify_origin_write_access
) >"$case_stdout" 2>"$case_stderr"
grep -Fq "Skipping GitHub API probes for non-GitHub origin" "$case_stdout" ||
  fail "${case_name}: did not skip GitHub API probes"
grep -Fq "Skipping GitHub write probe for non-GitHub origin" "$case_stdout" ||
  fail "${case_name}: did not skip GitHub write probe"

echo "codex-cloud-setup.test.sh: all checks passed"
