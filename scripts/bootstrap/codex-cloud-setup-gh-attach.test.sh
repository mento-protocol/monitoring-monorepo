#!/usr/bin/env bash
# gh `--attach` capability and apt installer cases for codex-cloud-setup.test.sh.
# This file is sourced by codex-cloud-setup.test.sh. Do not execute it directly.
# Case subshells intentionally isolate environment mutations. The runner owns
# suite_tmp, setup_script and every case_* global read below (SC2154).
# shellcheck disable=SC2030,SC2031,SC2154

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
