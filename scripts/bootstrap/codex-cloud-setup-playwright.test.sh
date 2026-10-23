#!/usr/bin/env bash
# Playwright host-dependency cases for codex-cloud-setup.test.sh.
# This file is sourced by codex-cloud-setup.test.sh. Do not execute it directly.
# Case subshells intentionally isolate environment mutations.
# shellcheck disable=SC2030,SC2031,SC2154 # the runner assigns suite_tmp, setup_script and the case_* globals

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  echo "codex-cloud-setup-playwright.test.sh: source this file from codex-cloud-setup.test.sh; do not run it directly." >&2
  exit 1
fi

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

# Execute the actual maintenance entrypoint with only external tools stubbed.
# No fixture command may configure Git, install packages, or access the network.
for maintenance_case in success browser-fails dependencies-fail; do
  prepare_case "maintenance-$maintenance_case"
  maintenance_exit=0
  # shellcheck disable=SC2329 # Exported stubs are invoked by the child Bash.
  (
    git() {
      if [[ "$*" == "remote get-url origin" ]]; then
        echo "https://github.com/mento-protocol/monitoring-monorepo.git"
      fi
    }
    gh() { return 0; }
    corepack() { return 0; }
    pnpm() {
      printf '%s\n' "$*" >>"$case_tool_log"
      if [[ "$maintenance_case" == browser-fails && "$*" == *"playwright install"* ]]; then
        return 71
      fi
      if [[ "$maintenance_case" == dependencies-fail && "$1" == install ]]; then
        return 72
      fi
    }
    export -f git gh corepack pnpm
    export case_tool_log maintenance_case
    bash "$repo_root/scripts/bootstrap/codex-cloud-maintenance.sh"
  ) >"$case_stdout" 2>"$case_stderr" || maintenance_exit=$?
  printf '%s\n' '--version' 'install --frozen-lockfile --prefer-offline' >"$case_dir/expected"
  if [[ "$maintenance_case" != dependencies-fail ]]; then
    printf '%s\n' '--filter @mento-protocol/ui-dashboard exec playwright install chromium' >>"$case_dir/expected"
  fi
  case "$maintenance_case" in
    success)
      expected_exit=0
      printf '%s\n' 'indexer:codegen' 'agent:context-check' >>"$case_dir/expected"
      ;;
    browser-fails) expected_exit=71 ;;
    dependencies-fail) expected_exit=72 ;;
  esac
  [[ "$maintenance_exit" == "$expected_exit" ]] || fail "${case_name}: exit $maintenance_exit, expected $expected_exit"
  diff -u "$case_dir/expected" "$case_tool_log" || fail "${case_name}: wrong maintenance order or failure handling"
done
