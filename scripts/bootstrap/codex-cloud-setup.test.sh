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

suite_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=scripts/bootstrap/codex-cloud-setup-foundry.test.sh
source "$suite_dir/codex-cloud-setup-foundry.test.sh"
# shellcheck source=scripts/bootstrap/codex-cloud-setup-playwright.test.sh
source "$suite_dir/codex-cloud-setup-playwright.test.sh"
# shellcheck source=scripts/bootstrap/codex-cloud-setup-github-probes.test.sh
source "$suite_dir/codex-cloud-setup-github-probes.test.sh"
# shellcheck source=scripts/bootstrap/codex-cloud-setup-gh-attach.test.sh
source "$suite_dir/codex-cloud-setup-gh-attach.test.sh"

echo "codex-cloud-setup.test.sh: all checks passed"
