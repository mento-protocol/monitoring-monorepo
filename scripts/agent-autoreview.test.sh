#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
node_bin="$(command -v node)"

helper="$tmp_dir/autoreview-helper"
capture="$tmp_dir/args"
stdout="$tmp_dir/stdout"
stderr="$tmp_dir/stderr"

cat >"$helper" <<'HELPER'
#!/usr/bin/env bash
printf '%s\n' "$@" >"$AUTOREVIEW_CAPTURE"
HELPER
chmod +x "$helper"

run_adapter() {
  : >"$capture"
  : >"$stdout"
  : >"$stderr"
  local env_args=(
    "PATH=$PATH"
    "HOME=$HOME"
    "TMPDIR=${TMPDIR:-/tmp}"
    "AUTOREVIEW_HELPER=$helper"
    "AUTOREVIEW_CAPTURE=$capture"
  )
  while [[ $# -gt 0 && "$1" == *=* ]]; do
    env_args+=("$1")
    shift
  done

  env -i "${env_args[@]}" "$repo_root/scripts/agent-autoreview.sh" "$@" >"$stdout" 2>"$stderr"
}

expect_args() {
  local expected="$1"
  local actual
  actual="$(cat "$capture")"
  if [[ "$actual" != "$expected" ]]; then
    printf 'unexpected helper args\nexpected:\n%s\nactual:\n%s\n' "$expected" "$actual" >&2
    exit 1
  fi
}

expect_stderr_contains() {
  local expected="$1"
  if ! grep -Fq "$expected" "$stderr"; then
    printf 'expected stderr to contain %s\nstderr:\n%s\n' "$expected" "$(cat "$stderr")" >&2
    exit 1
  fi
}

expect_stdout_contains() {
  local expected="$1"
  if ! grep -Fq "$expected" "$stdout"; then
    printf 'expected stdout to contain %s\nstdout:\n%s\n' "$expected" "$(cat "$stdout")" >&2
    exit 1
  fi
}

expect_stdout_not_contains() {
  local unexpected="$1"
  if grep -Fq "$unexpected" "$stdout"; then
    printf 'expected stdout not to contain %s\nstdout:\n%s\n' "$unexpected" "$(cat "$stdout")" >&2
    exit 1
  fi
}

expect_empty_stderr() {
  if [[ -s "$stderr" ]]; then
    printf 'expected empty stderr, got:\n%s\n' "$(cat "$stderr")" >&2
    exit 1
  fi
}

run_default_adapter() {
  : >"$stdout"
  : >"$stderr"
  env -i \
    "PATH=$PATH" \
    "HOME=$HOME" \
    "TMPDIR=${TMPDIR:-/tmp}" \
    "$repo_root/scripts/agent-autoreview.sh" \
    --engine local --dry-run >"$stdout" 2>"$stderr"
}

run_default_adapter_in_clean_main() {
  local clean_repo="$tmp_dir/clean-main"
  mkdir "$clean_repo"
  git -C "$clean_repo" init -b main >/dev/null
  printf 'clean\n' >"$clean_repo/README.md"
  git -C "$clean_repo" add README.md
  git -C "$clean_repo" \
    -c user.name="Agent Test" \
    -c user.email="agent-test@example.invalid" \
    commit -m init >/dev/null

  : >"$stdout"
  : >"$stderr"
  (
    cd "$clean_repo"
    env -i \
      "PATH=$PATH" \
      "HOME=$HOME" \
      "TMPDIR=${TMPDIR:-/tmp}" \
      "$repo_root/scripts/agent-autoreview.sh" \
      --engine local --dry-run >"$stdout" 2>"$stderr"
  )
}

init_review_repo() {
  local review_repo="$1"
  mkdir "$review_repo"
  git -C "$review_repo" init -b main >/dev/null
  git -C "$review_repo" config user.name "Agent Test"
  git -C "$review_repo" config user.email "agent-test@example.invalid"
}

commit_review_repo() {
  local review_repo="$1"
  local message="$2"
  git -C "$review_repo" add -A
  git -C "$review_repo" commit -m "$message" >/dev/null
}

run_helper_in_repo() {
  local review_repo="$1"
  shift
  : >"$stdout"
  : >"$stderr"
  (
    cd "$review_repo"
    env -i \
      "PATH=$PATH" \
      "HOME=$HOME" \
      "TMPDIR=${TMPDIR:-/tmp}" \
      "$repo_root/scripts/agent-autoreview.sh" \
      "$@" >"$stdout" 2>"$stderr"
  )
}

run_helper_in_repo_expect_failure() {
  local review_repo="$1"
  shift
  : >"$stdout"
  : >"$stderr"
  local status=0
  (
    cd "$review_repo"
    env -i \
      "PATH=$PATH" \
      "HOME=$HOME" \
      "TMPDIR=${TMPDIR:-/tmp}" \
      "$repo_root/scripts/agent-autoreview.sh" \
      "$@" >"$stdout" 2>"$stderr"
  ) || status=$?
  if [[ "$status" -eq 0 ]]; then
    printf 'expected helper to fail\nstdout:\n%s\nstderr:\n%s\n' "$(cat "$stdout")" "$(cat "$stderr")" >&2
    exit 1
  fi
}

run_node_helper_in_repo_expect_failure() {
  local review_repo="$1"
  shift
  : >"$stdout"
  : >"$stderr"
  local status=0
  (
    cd "$review_repo"
    env -i \
      "PATH=/bin:/usr/bin" \
      "HOME=$HOME" \
      "TMPDIR=${TMPDIR:-/tmp}" \
      "GIT_CONFIG_GLOBAL=/dev/null" \
      "$node_bin" "$repo_root/scripts/agent-autoreview.mjs" \
      "$@" >"$stdout" 2>"$stderr"
  ) || status=$?
  if [[ "$status" -eq 0 ]]; then
    printf 'expected helper to fail\nstdout:\n%s\nstderr:\n%s\n' "$(cat "$stdout")" "$(cat "$stderr")" >&2
    exit 1
  fi
}

run_parallel_tests_completion_regression() {
  local review_repo="$tmp_dir/parallel-tests"
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  printf 'change\n' >>"$review_repo/README.md"

  run_helper_in_repo "$review_repo" --mode local --engine local --parallel-tests true
  expect_stdout_contains "tests: true"
  expect_stdout_contains "autoreview clean"
  expect_empty_stderr
}

run_branch_diff_check_regression() {
  local review_repo="$tmp_dir/branch-diff-check"
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  git -C "$review_repo" switch -c feature >/dev/null 2>&1
  printf 'bad trailing   \n' >>"$review_repo/README.md"
  commit_review_repo "$review_repo" "add trailing whitespace"

  run_helper_in_repo_expect_failure "$review_repo" --mode branch --base main --engine local
  expect_stdout_contains "Diff contains whitespace"
  expect_empty_stderr
}

run_local_deleted_reference_regression() {
  local review_repo="$tmp_dir/deleted-reference"
  init_review_repo "$review_repo"
  mkdir "$review_repo/docs"
  printf 'old docs\n' >"$review_repo/docs/old.md"
  printf 'See docs/old.md\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  rm "$review_repo/docs/old.md"
  printf 'No old docs\n' >"$review_repo/README.md"

  run_helper_in_repo "$review_repo" --mode local --engine local
  expect_stdout_contains "autoreview clean"
  expect_stdout_not_contains "Deleted file is still referenced"
  expect_empty_stderr
}

run_commit_target_reads_selected_ref_regression() {
  local review_repo="$tmp_dir/commit-target"
  init_review_repo "$review_repo"
  mkdir -p "$review_repo/.github/workflows"
  cat >"$review_repo/.github/workflows/terraform-drift.yml" <<'BAD_WORKFLOW'
name: drift
jobs:
  drift:
    steps:
      - run: terraform plan | tee /tmp/tf-plan.txt
BAD_WORKFLOW
  commit_review_repo "$review_repo" "add unsafe drift workflow"
  local unsafe_commit
  unsafe_commit="$(git -C "$review_repo" rev-parse HEAD)"
  cat >"$review_repo/.github/workflows/terraform-drift.yml" <<'FIXED_WORKFLOW'
name: drift
jobs:
  drift:
    steps:
      - run: terraform plan >/tmp/tf-plan.raw
FIXED_WORKFLOW
  commit_review_repo "$review_repo" "fix drift workflow"

  run_helper_in_repo_expect_failure "$review_repo" --mode commit --commit "$unsafe_commit" --engine local
  expect_stdout_contains "autoreview target: commit"
  expect_stdout_contains "Drift workflow logs raw Terraform plan output"
  expect_empty_stderr
}

run_auto_dirty_branch_regression() {
  local review_repo="$tmp_dir/dirty-branch"
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  git -C "$review_repo" switch -c feature >/dev/null 2>&1
  printf 'branch trailing   \n' >>"$review_repo/README.md"
  commit_review_repo "$review_repo" "add branch change"
  printf 'local clean\n' >"$review_repo/local.txt"

  run_helper_in_repo_expect_failure "$review_repo" --base main --engine local
  expect_stdout_contains "autoreview target: branch-local"
  expect_stdout_contains "Diff contains whitespace"
  expect_empty_stderr
}

run_requested_codex_missing_regression() {
  local review_repo="$tmp_dir/missing-codex"
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  printf 'change\n' >>"$review_repo/README.md"

  run_node_helper_in_repo_expect_failure "$review_repo" --mode local --engine codex
  expect_stdout_contains "autoreview target: local"
  expect_stderr_contains "codex CLI is not available"
  expect_stdout_not_contains "autoreview clean"
}

run_default_adapter
expect_stdout_contains "engine: local"
expect_empty_stderr

run_default_adapter_in_clean_main
expect_stdout_contains "autoreview target: none"
expect_stdout_contains "branch: main"
expect_stdout_contains "engine: local"
expect_empty_stderr

run_parallel_tests_completion_regression
run_branch_diff_check_regression
run_local_deleted_reference_regression
run_commit_target_reads_selected_ref_regression
run_auto_dirty_branch_regression
run_requested_codex_missing_regression

run_adapter CODEX_SANDBOX=seatbelt --dry-run
expect_args $'--engine\nlocal\n--dry-run'
expect_stderr_contains "detected Codex sandbox"

run_adapter CODEX_THREAD_ID=example-thread --dry-run
expect_args $'--engine\nlocal\n--dry-run'
expect_stderr_contains "detected Codex sandbox"

run_adapter CODEX_SANDBOX=seatbelt --engine claude --dry-run
expect_args $'--engine\nclaude\n--dry-run'
expect_empty_stderr

run_adapter CODEX_SANDBOX=seatbelt AUTOREVIEW_ENGINE=claude --dry-run
expect_args "--dry-run"
expect_empty_stderr

run_adapter CODEX_SANDBOX=seatbelt --prepare-only --dry-run
expect_args $'--prepare-only\n--dry-run'
expect_empty_stderr

run_adapter --dry-run
expect_args "--dry-run"
expect_empty_stderr

run_adapter CODEX_SANDBOX=seatbelt -- --dry-run
expect_args $'--engine\nlocal\n--dry-run'
expect_stderr_contains "detected Codex sandbox"

printf 'agent-autoreview adapter tests passed\n'
