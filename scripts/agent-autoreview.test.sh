#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
tmp_dir="$(mktemp -d)"
repo_untracked="$repo_root/.agent-autoreview-test-untracked.txt"
trap 'rm -rf "$tmp_dir" "$repo_untracked"' EXIT
node_bin="$(command -v node)"

helper="$tmp_dir/autoreview-helper"
capture="$tmp_dir/args"
stdout="$tmp_dir/stdout"
stderr="$tmp_dir/stderr"

cat >"$helper" <<'HELPER'
#!/usr/bin/env bash
printf '%s\n' "$@" >"$AUTOREVIEW_CAPTURE"
pwd >"$AUTOREVIEW_CAPTURE.cwd"
bundle_output=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundle-output)
      bundle_output="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
if [[ -n "$bundle_output" ]]; then
  mkdir -p "$(dirname "$bundle_output")"
  printf '# fake autoreview prompt\n' >"$bundle_output"
fi
printf 'fake helper complete\n'
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

run_adapter_expect_failure() {
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

  set +e
  env -i "${env_args[@]}" "$repo_root/scripts/agent-autoreview.sh" "$@" >"$stdout" 2>"$stderr"
  local status=$?
  set -e
  if [[ "$status" -eq 0 ]]; then
    printf 'expected adapter to fail\nstdout:\n%s\nstderr:\n%s\n' "$(cat "$stdout")" "$(cat "$stderr")" >&2
    exit 1
  fi
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

expect_capture_contains_line() {
  local expected="$1"
  if ! grep -Fxq -- "$expected" "$capture"; then
    printf 'expected captured args to contain line %s\nargs:\n%s\n' "$expected" "$(cat "$capture")" >&2
    exit 1
  fi
}

expect_capture_not_contains_line() {
  local unexpected="$1"
  if grep -Fxq -- "$unexpected" "$capture"; then
    printf 'expected captured args not to contain line %s\nargs:\n%s\n' "$unexpected" "$(cat "$capture")" >&2
    exit 1
  fi
}

expect_stderr_contains() {
  local expected="$1"
  if ! grep -Fq -- "$expected" "$stderr"; then
    printf 'expected stderr to contain %s\nstderr:\n%s\n' "$expected" "$(cat "$stderr")" >&2
    exit 1
  fi
}

expect_stdout_contains() {
  local expected="$1"
  if ! grep -Fq -- "$expected" "$stdout"; then
    printf 'expected stdout to contain %s\nstdout:\n%s\n' "$expected" "$(cat "$stdout")" >&2
    exit 1
  fi
}

expect_stdout_not_contains() {
  local unexpected="$1"
  if grep -Fq -- "$unexpected" "$stdout"; then
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

expect_file_exists() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    printf 'expected file to exist: %s\n' "$path" >&2
    exit 1
  fi
}

expect_file_contains() {
  local path="$1"
  local expected="$2"
  if ! grep -Fq -- "$expected" "$path"; then
    printf 'expected %s to contain %s\nactual:\n%s\n' "$path" "$expected" "$(cat "$path")" >&2
    exit 1
  fi
}

expect_file_not_contains() {
  local path="$1"
  local unexpected="$2"
  if grep -Fq -- "$unexpected" "$path"; then
    printf 'expected %s not to contain %s\nactual:\n%s\n' "$path" "$unexpected" "$(cat "$path")" >&2
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

run_default_adapter_with_inline_engine() {
  : >"$stdout"
  : >"$stderr"
  env -i \
    "PATH=$PATH" \
    "HOME=$HOME" \
    "TMPDIR=${TMPDIR:-/tmp}" \
    "$repo_root/scripts/agent-autoreview.sh" \
    --engine=local --dry-run >"$stdout" 2>"$stderr"
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

run_helper_with_path_in_repo() {
  local review_repo="$1"
  local extra_path="$2"
  shift 2
  : >"$capture"
  : >"$stdout"
  : >"$stderr"
  (
    cd "$review_repo"
    env -i \
      "PATH=$extra_path:$PATH" \
      "HOME=$HOME" \
      "TMPDIR=${TMPDIR:-/tmp}" \
      "AUTOREVIEW_CAPTURE=$capture" \
      "$repo_root/scripts/agent-autoreview.sh" \
      "$@" >"$stdout" 2>"$stderr"
  )
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

run_branch_local_diff_check_fixed_regression() {
  local review_repo="$tmp_dir/dirty-branch-fixed"
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  git -C "$review_repo" switch -c feature >/dev/null 2>&1
  printf 'branch trailing   \n' >>"$review_repo/README.md"
  commit_review_repo "$review_repo" "add branch whitespace"
  printf 'base\nbranch trailing\n' >"$review_repo/README.md"

  run_helper_in_repo "$review_repo" --base main --engine local
  expect_stdout_contains "autoreview target: branch-local"
  expect_stdout_contains "autoreview clean"
  expect_stdout_not_contains "Diff contains whitespace"
  expect_empty_stderr
}

run_branch_local_deleted_reference_regression() {
  local review_repo="$tmp_dir/branch-local-deleted-reference"
  init_review_repo "$review_repo"
  mkdir "$review_repo/docs"
  printf 'old docs\n' >"$review_repo/docs/old.md"
  printf 'See docs/old.md\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  git -C "$review_repo" switch -c feature >/dev/null 2>&1
  rm "$review_repo/docs/old.md"
  commit_review_repo "$review_repo" "delete stale docs without reference fix"
  printf 'local clean\n' >"$review_repo/local.txt"

  run_helper_in_repo_expect_failure "$review_repo" --base main --engine local
  expect_stdout_contains "autoreview target: branch-local"
  expect_stdout_contains "Deleted file is still referenced"
  expect_empty_stderr
}

run_branch_local_deleted_reference_fixed_regression() {
  local review_repo="$tmp_dir/branch-local-deleted-reference-fixed"
  init_review_repo "$review_repo"
  mkdir "$review_repo/docs"
  printf 'old docs\n' >"$review_repo/docs/old.md"
  printf 'See docs/old.md\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  git -C "$review_repo" switch -c feature >/dev/null 2>&1
  rm "$review_repo/docs/old.md"
  commit_review_repo "$review_repo" "delete stale docs without reference fix"
  printf 'No old docs\n' >"$review_repo/README.md"

  run_helper_in_repo "$review_repo" --base main --engine local
  expect_stdout_contains "autoreview target: branch-local"
  expect_stdout_contains "autoreview clean"
  expect_stdout_not_contains "Deleted file is still referenced"
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

run_claude_no_tools_regression() {
  local review_repo="$tmp_dir/claude-no-tools"
  local fake_bin="$tmp_dir/fake-claude-bin"
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  printf 'change\n' >>"$review_repo/README.md"
  mkdir "$fake_bin"
  cat >"$fake_bin/claude" <<'CLAUDE'
#!/usr/bin/env bash
printf '%s\n' "$@" >"$AUTOREVIEW_CAPTURE"
cat <<'JSON'
{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"clean","overall_confidence":0.9}
JSON
CLAUDE
  chmod +x "$fake_bin/claude"

  run_helper_with_path_in_repo "$review_repo" "$fake_bin" --mode local --engine claude --no-tools
  expect_capture_contains_line "--tools"
  expect_capture_contains_line "--mcp-config"
  expect_capture_contains_line '{"mcpServers":{}}'
  expect_capture_contains_line "--strict-mcp-config"
  expect_capture_not_contains_line "--allowedTools"
  expect_capture_not_contains_line "--allowed-tools"
  expect_stdout_contains "autoreview clean"
  expect_empty_stderr
}

run_default_adapter
expect_stdout_contains "engine: local"
expect_empty_stderr

run_default_adapter_in_clean_main
expect_stdout_contains "autoreview target: none"
expect_stdout_contains "branch: main"
expect_stdout_contains "engine: local"
expect_empty_stderr

run_default_adapter_with_inline_engine
expect_stdout_contains "engine: local"
expect_empty_stderr

run_parallel_tests_completion_regression
run_branch_diff_check_regression
run_local_deleted_reference_regression
run_commit_target_reads_selected_ref_regression
run_auto_dirty_branch_regression
run_branch_local_diff_check_fixed_regression
run_branch_local_deleted_reference_regression
run_branch_local_deleted_reference_fixed_regression
run_requested_codex_missing_regression
run_claude_no_tools_regression

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

run_adapter_expect_failure --feedback-pr 1040
expect_stderr_contains "requires --prepare-bundle-dir"

bundle_dir="$tmp_dir/context-bundle"
canonical_bundle_dir="$(cd "$(dirname "$bundle_dir")" && pwd -P)/$(basename "$bundle_dir")"
run_adapter --prepare-bundle-dir "$bundle_dir" --mode branch --base HEAD --dry-run
expect_args $'--mode\nbranch\n--base\nHEAD\n--dry-run\n--prompt-file\ndocs/pr-checklists/recurring-review-patterns.md\n--prompt-file\ndocs/pr-checklists/review-prompt-exclusions.md\n--bundle-output\n'"$canonical_bundle_dir"$'/autoreview-prompt.md\n--prepare-only'
expect_empty_stderr
expect_file_exists "$canonical_bundle_dir/README.md"
expect_file_exists "$canonical_bundle_dir/changed-paths.txt"
expect_file_exists "$canonical_bundle_dir/patches/branch.diff"
expect_file_exists "$canonical_bundle_dir/checklists/recurring-review-patterns.md"
expect_file_exists "$canonical_bundle_dir/checklists/review-prompt-exclusions.md"
expect_file_exists "$canonical_bundle_dir/autoreview-prompt.md"
expect_file_contains "$canonical_bundle_dir/README.md" "Autoreview Context Bundle"
expect_file_contains "$canonical_bundle_dir/selected-checklists.txt" "docs/pr-checklists/review-prompt-exclusions.md"
expect_file_contains "$stdout" "agent:autoreview context bundle: $canonical_bundle_dir"

auto_branch_local_repo="$tmp_dir/auto-branch-local-bundle"
init_review_repo "$auto_branch_local_repo"
printf 'base\n' >"$auto_branch_local_repo/README.md"
commit_review_repo "$auto_branch_local_repo" init
git -C "$auto_branch_local_repo" switch -c feature >/dev/null 2>&1
printf 'branch\n' >"$auto_branch_local_repo/branch.txt"
commit_review_repo "$auto_branch_local_repo" "add branch file"
printf 'local body\n' >"$auto_branch_local_repo/local.txt"
external_diff="$tmp_dir/external-diff"
cat >"$external_diff" <<'EXTERNAL_DIFF'
#!/usr/bin/env bash
printf 'external diff invoked\n'
EXTERNAL_DIFF
chmod +x "$external_diff"
auto_branch_local_bundle="$tmp_dir/context-bundle-auto-branch-local"
(cd "$auto_branch_local_repo" && run_adapter "GIT_EXTERNAL_DIFF=$external_diff" --prepare-bundle-dir "$auto_branch_local_bundle" --base main --dry-run)
expect_file_contains "$auto_branch_local_bundle/README.md" "- Target: branch-local main"
expect_file_exists "$auto_branch_local_bundle/patches/branch.diff"
expect_file_exists "$auto_branch_local_bundle/patches/untracked.diff"
expect_file_contains "$auto_branch_local_bundle/changed-paths.txt" "branch.txt"
expect_file_contains "$auto_branch_local_bundle/changed-paths.txt" "local.txt"
expect_file_contains "$auto_branch_local_bundle/patches/branch.diff" "diff --git"
expect_file_not_contains "$auto_branch_local_bundle/patches/branch.diff" "external diff invoked"
expect_file_contains "$auto_branch_local_bundle/patches/untracked.diff" "local body"

pr_base_repo="$tmp_dir/pr-base-bundle"
init_review_repo "$pr_base_repo"
printf 'base\n' >"$pr_base_repo/README.md"
commit_review_repo "$pr_base_repo" init
git -C "$pr_base_repo" update-ref refs/remotes/origin/release HEAD
git -C "$pr_base_repo" switch -c feature >/dev/null 2>&1
printf 'feature\n' >"$pr_base_repo/feature.txt"
commit_review_repo "$pr_base_repo" "add feature file"
fake_gh_bin="$tmp_dir/fake-gh-bin"
mkdir "$fake_gh_bin"
cat >"$fake_gh_bin/gh" <<'GH'
#!/usr/bin/env bash
if [[ "$1" == "pr" && "$2" == "view" ]]; then
  printf 'release\n'
  exit 0
fi
exit 1
GH
chmod +x "$fake_gh_bin/gh"
pr_base_bundle="$tmp_dir/context-bundle-pr-base"
(cd "$pr_base_repo" && run_adapter "PATH=$fake_gh_bin:$PATH" --prepare-bundle-dir "$pr_base_bundle" --mode branch --dry-run)
expect_file_contains "$pr_base_bundle/README.md" "- Target: branch origin/release"
expect_file_contains "$pr_base_bundle/changed-paths.txt" "feature.txt"

run_adapter_expect_failure --prepare-bundle-dir "$repo_root/.autoreview-bundle" --mode branch --base HEAD
expect_stderr_contains "must be outside the repo worktree"

nested_in_repo_parent="$repo_root/.autoreview-test-parent"
rm -rf "$nested_in_repo_parent"
run_adapter_expect_failure --prepare-bundle-dir "$nested_in_repo_parent/review" --mode branch --base HEAD
expect_stderr_contains "must be outside the repo worktree"
if [[ -e "$nested_in_repo_parent" ]]; then
  printf 'expected rejected in-repo bundle parent not to be created: %s\n' "$nested_in_repo_parent" >&2
  exit 1
fi

nonempty_bundle="$tmp_dir/nonempty-bundle"
mkdir -p "$nonempty_bundle"
printf 'stale\n' >"$nonempty_bundle/stale.txt"
run_adapter_expect_failure --prepare-bundle-dir "$nonempty_bundle" --mode branch --base HEAD
expect_stderr_contains "must be empty or absent"

ln -s "$repo_root" "$tmp_dir/repo-link"
run_adapter_expect_failure --prepare-bundle-dir "$tmp_dir/repo-link" --mode branch --base HEAD
expect_stderr_contains "must not be a symlink"

subdir_bundle="$tmp_dir/context-bundle-subdir"
(cd "$repo_root/scripts" && run_adapter --prepare-bundle-dir "$subdir_bundle" --mode branch --base HEAD --dry-run)
expect_file_contains "$capture.cwd" "$repo_root"

printf 'untracked review body\n' >"$repo_untracked"
untracked_bundle="$tmp_dir/context-bundle-untracked"
canonical_untracked_bundle="$(cd "$(dirname "$untracked_bundle")" && pwd -P)/$(basename "$untracked_bundle")"
run_adapter --prepare-bundle-dir "$untracked_bundle" --mode local --dry-run
expect_file_contains "$canonical_untracked_bundle/patches/untracked.diff" "untracked review body"

printf 'agent-autoreview adapter tests passed\n'
