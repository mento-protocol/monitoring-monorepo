#!/usr/bin/env bash
# GitHub origin and API probe cases for codex-cloud-setup.test.sh.
# This file is sourced by codex-cloud-setup.test.sh. Do not execute it directly.
# Case subshells intentionally isolate environment mutations. The runner owns
# suite_tmp, setup_script and every case_* global read below (SC2154).
# shellcheck disable=SC2030,SC2031,SC2154

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
