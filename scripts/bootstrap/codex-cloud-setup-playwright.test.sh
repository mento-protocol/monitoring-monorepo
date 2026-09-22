#!/usr/bin/env bash
# Playwright host-dependency cases for codex-cloud-setup.test.sh.
# This file is sourced by codex-cloud-setup.test.sh. The guard below refuses
# direct execution.
# Case subshells intentionally isolate environment mutations. The runner owns
# suite_tmp, setup_script and every case_* global read below (SC2154).
# shellcheck disable=SC2030,SC2031,SC2154

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
