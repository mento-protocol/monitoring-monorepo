#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
tmp_dir="$(mktemp -d)"
repo_untracked="$repo_root/.agent-autoreview-test-untracked.txt"
trap 'rm -rf "$tmp_dir" "$repo_untracked"' EXIT

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

expect_stderr_contains() {
  local expected="$1"
  if ! grep -Fq "$expected" "$stderr"; then
    printf 'expected stderr to contain %s\nstderr:\n%s\n' "$expected" "$(cat "$stderr")" >&2
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
  if ! grep -Fq "$expected" "$path"; then
    printf 'expected %s to contain %s\nactual:\n%s\n' "$path" "$expected" "$(cat "$path")" >&2
    exit 1
  fi
}

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

run_adapter_expect_failure --prepare-bundle-dir "$repo_root/.autoreview-bundle" --mode branch --base HEAD
expect_stderr_contains "must be outside the repo worktree"

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
