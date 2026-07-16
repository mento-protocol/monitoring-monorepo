#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
tmp_dir="$(mktemp -d)"
repo_untracked="$repo_root/.agent-autoreview-test-untracked.txt"
trap 'rm -rf "$tmp_dir" "$repo_untracked"' EXIT
node_bin="$(command -v node)"

"$node_bin" "$repo_root/scripts/agent-autoreview-core.test.mjs"

helper="$tmp_dir/autoreview-helper"
capture="$tmp_dir/args"
stdout="$tmp_dir/stdout"
stderr="$tmp_dir/stderr"

cat >"$helper" <<'HELPER'
#!/usr/bin/env bash
if [[ "${1:-}" == "--source-snapshot-only" ]]; then
  printf 'invoked\n' >>"$AUTOREVIEW_CAPTURE.snapshot"
  if [[ -n "${AUTOREVIEW_FAKE_BAD_SNAPSHOT:-}" ]]; then
    printf 'not-a-source-snapshot\n'
    exit 0
  fi
  exec "$AUTOREVIEW_SNAPSHOT_HELPER" --source-snapshot-only
fi
printf '%s\n' "$@" >"$AUTOREVIEW_CAPTURE"
pwd >"$AUTOREVIEW_CAPTURE.cwd"
bundle_output=""
bundle_output_display=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundle-output)
      bundle_output="$2"
      shift 2
      ;;
    --bundle-output-display)
      bundle_output_display="$2"
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
  reported_bundle_output="${bundle_output_display:-$bundle_output}"
  printf 'bundle_output: %s\n' "$reported_bundle_output"
  printf '{"bundle_output":"%s","bundle_outputs":["%s"]}\n' \
    "$reported_bundle_output" "$reported_bundle_output"
fi
if [[ -n "${AUTOREVIEW_MUTATE_PATH:-}" ]]; then
  printf 'concurrent mutation\n' >>"$AUTOREVIEW_MUTATE_PATH"
fi
printf 'fake helper complete\n'
HELPER
chmod +x "$helper"

run_adapter() {
  : >"$capture"
  : >"$capture.snapshot"
  : >"$stdout"
  : >"$stderr"
  local env_args=(
    "PATH=$PATH"
    "HOME=$HOME"
    "TMPDIR=${TMPDIR:-/tmp}"
    "AUTOREVIEW_HELPER=$helper"
    "AUTOREVIEW_CAPTURE=$capture"
    "AUTOREVIEW_SNAPSHOT_HELPER=$repo_root/scripts/agent-autoreview.mjs"
  )
  while [[ $# -gt 0 && "$1" == *=* ]]; do
    env_args+=("$1")
    shift
  done

  env -i "${env_args[@]}" "$repo_root/scripts/agent-autoreview.sh" "$@" >"$stdout" 2>"$stderr"
}

run_adapter_expect_failure() {
  : >"$capture"
  : >"$capture.snapshot"
  : >"$stdout"
  : >"$stderr"
  local env_args=(
    "PATH=$PATH"
    "HOME=$HOME"
    "TMPDIR=${TMPDIR:-/tmp}"
    "AUTOREVIEW_HELPER=$helper"
    "AUTOREVIEW_CAPTURE=$capture"
    "AUTOREVIEW_SNAPSHOT_HELPER=$repo_root/scripts/agent-autoreview.mjs"
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
  local unrelated_secret_value="must-not-${BASHPID}-reach-reviewer"
  local env_args=(
    "PATH=$extra_path:$PATH"
    "HOME=$HOME"
    "TMPDIR=${TMPDIR:-/tmp}"
    "AUTOREVIEW_CAPTURE=$capture"
    "AUTOREVIEW_FAKE_CAPTURE=$capture"
    "AUTOREVIEW_HEARTBEAT_SECONDS=${AUTOREVIEW_HEARTBEAT_SECONDS:-60}"
    "UNRELATED_SECRET=$unrelated_secret_value"
  )
  local key
  local value
  for key in \
    ANTHROPIC_VERTEX_PROJECT_ID \
    AWS_CONFIG_FILE \
    AWS_CONTAINER_AUTHORIZATION_TOKEN \
    AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE \
    AWS_CONTAINER_CREDENTIALS_FULL_URI \
    AWS_CONTAINER_CREDENTIALS_RELATIVE_URI \
    AWS_EC2_METADATA_DISABLED \
    AWS_ROLE_ARN \
    AWS_ROLE_SESSION_NAME \
    AWS_SDK_LOAD_CONFIG \
    AWS_SHARED_CREDENTIALS_FILE \
    AWS_WEB_IDENTITY_TOKEN_FILE \
    GOOGLE_APPLICATION_CREDENTIALS; do
    value="${!key-}"
    if [[ -n "$value" ]]; then
      env_args+=("$key=$value")
    fi
  done
  (
    cd "$review_repo"
    env -i "${env_args[@]}" \
      "$repo_root/scripts/agent-autoreview.sh" \
      "$@" >"$stdout" 2>"$stderr"
  )
}

run_helper_with_path_in_repo_expect_failure() {
  local review_repo="$1"
  local extra_path="$2"
  shift 2
  local status=0
  set +e
  run_helper_with_path_in_repo "$review_repo" "$extra_path" "$@"
  status=$?
  set -e
  if [[ "$status" -eq 0 ]]; then
    printf 'expected isolated helper to fail\nstdout:\n%s\nstderr:\n%s\n' "$(cat "$stdout")" "$(cat "$stderr")" >&2
    exit 1
  fi
}

run_parallel_tests_removed_regression() {
  local review_repo="$tmp_dir/parallel-tests"
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  printf 'change\n' >>"$review_repo/README.md"

  run_helper_in_repo_expect_failure "$review_repo" --mode local --engine local --parallel-tests true
  expect_stderr_contains "--parallel-tests was removed"
  expect_stderr_contains "pnpm agent:quality-gate --run"
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
  local aws_config_file="$tmp_dir/aws-config"
  local aws_credentials_file="$tmp_dir/aws-credentials"
  local aws_container_auth_file="$tmp_dir/aws-container-authorization"
  local aws_web_identity_target="$tmp_dir/aws-web-identity-token"
  local aws_web_identity_file="$tmp_dir/aws-web-identity-token-link"
  local google_application_credentials="$tmp_dir/google-application-credentials.json"
  local canonical_aws_config_file
  local canonical_aws_credentials_file
  local canonical_aws_container_auth_file
  local canonical_aws_web_identity_file
  local canonical_google_application_credentials
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  printf 'change\n' >>"$review_repo/README.md"
  printf '[default]\nregion = us-east-1\n' >"$aws_config_file"
  printf '[default]\naws_access_key_id = test\n' >"$aws_credentials_file"
  printf 'container-authorization-placeholder\n' >"$aws_container_auth_file"
  printf 'web-identity-placeholder\n' >"$aws_web_identity_target"
  printf '{"type":"external_account"}\n' >"$google_application_credentials"
  ln -s "$(basename "$aws_web_identity_target")" "$aws_web_identity_file"
  canonical_aws_config_file="$(cd "$(dirname "$aws_config_file")" && printf '%s/%s' "$(pwd -P)" "$(basename "$aws_config_file")")"
  canonical_aws_credentials_file="$(cd "$(dirname "$aws_credentials_file")" && printf '%s/%s' "$(pwd -P)" "$(basename "$aws_credentials_file")")"
  canonical_aws_container_auth_file="$(cd "$(dirname "$aws_container_auth_file")" && printf '%s/%s' "$(pwd -P)" "$(basename "$aws_container_auth_file")")"
  canonical_aws_web_identity_file="$(cd "$(dirname "$aws_web_identity_target")" && printf '%s/%s' "$(pwd -P)" "$(basename "$aws_web_identity_target")")"
  canonical_google_application_credentials="$(cd "$(dirname "$google_application_credentials")" && printf '%s/%s' "$(pwd -P)" "$(basename "$google_application_credentials")")"
  mkdir "$fake_bin"
  cat >"$fake_bin/claude" <<'CLAUDE'
#!/usr/bin/env bash
printf 'invoked\n' >"$AUTOREVIEW_FAKE_CAPTURE.invoked"
if [[ "${1:-}" == "--version" ]]; then
  printf '2.1.210\n'
  exit 0
fi
if [[ "${1:-}" == "--help" ]]; then
  printf '%s\n' --safe-mode --setting-sources --strict-mcp-config --disallowedTools --tools
  exit 0
fi
printf '%s\n' "$@" >"$AUTOREVIEW_FAKE_CAPTURE"
pwd >"$AUTOREVIEW_FAKE_CAPTURE.cwd"
env >"$AUTOREVIEW_FAKE_CAPTURE.env"
cat >/dev/null
cat <<'JSON'
{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"clean","overall_confidence":0.9}
JSON
CLAUDE
  chmod +x "$fake_bin/claude"

  ANTHROPIC_VERTEX_PROJECT_ID="autoreview-vertex-project" \
    AWS_CONFIG_FILE="$aws_config_file" \
    AWS_CONTAINER_AUTHORIZATION_TOKEN="container-authorization-placeholder" \
    AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE="$aws_container_auth_file" \
    AWS_CONTAINER_CREDENTIALS_FULL_URI="http://169.254.170.2/v2/credentials" \
    AWS_CONTAINER_CREDENTIALS_RELATIVE_URI="/v2/credentials" \
    AWS_EC2_METADATA_DISABLED="true" \
    AWS_ROLE_ARN="arn:aws:iam::123456789012:role/autoreview-test" \
    AWS_ROLE_SESSION_NAME="autoreview-session" \
    AWS_SDK_LOAD_CONFIG="1" \
    AWS_SHARED_CREDENTIALS_FILE="$aws_credentials_file" \
    AWS_WEB_IDENTITY_TOKEN_FILE="$aws_web_identity_file" \
    GOOGLE_APPLICATION_CREDENTIALS="$google_application_credentials" \
    run_helper_with_path_in_repo "$review_repo" "$fake_bin" --mode local --engine claude --no-tools
  expect_capture_contains_line "--tools"
  expect_capture_contains_line "--mcp-config"
  expect_capture_contains_line '{"mcpServers":{}}'
  expect_capture_contains_line "--strict-mcp-config"
  expect_capture_contains_line "--safe-mode"
  expect_capture_contains_line "--setting-sources"
  expect_capture_contains_line "--disallowedTools"
  expect_capture_not_contains_line "--allowedTools"
  expect_capture_not_contains_line "--allowed-tools"
  expect_capture_not_contains_line "Read,Grep,Glob"
  expect_file_not_contains "$capture.cwd" "$review_repo"
  expect_file_contains "$capture.cwd" "autoreview-claude-workspace."
  expect_file_contains "$capture.env" "ANTHROPIC_VERTEX_PROJECT_ID=autoreview-vertex-project"
  expect_file_contains "$capture.env" "AWS_CONFIG_FILE=$canonical_aws_config_file"
  expect_file_contains "$capture.env" "AWS_CONTAINER_AUTHORIZATION_TOKEN=container-authorization-placeholder"
  expect_file_contains "$capture.env" "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE=$canonical_aws_container_auth_file"
  expect_file_contains "$capture.env" "AWS_CONTAINER_CREDENTIALS_FULL_URI=http://169.254.170.2/v2/credentials"
  expect_file_contains "$capture.env" "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI=/v2/credentials"
  expect_file_contains "$capture.env" "AWS_EC2_METADATA_DISABLED=true"
  expect_file_contains "$capture.env" "AWS_ROLE_ARN=arn:aws:iam::123456789012:role/autoreview-test"
  expect_file_contains "$capture.env" "AWS_ROLE_SESSION_NAME=autoreview-session"
  expect_file_contains "$capture.env" "AWS_SDK_LOAD_CONFIG=1"
  expect_file_contains "$capture.env" "AWS_SHARED_CREDENTIALS_FILE=$canonical_aws_credentials_file"
  expect_file_contains "$capture.env" "AWS_WEB_IDENTITY_TOKEN_FILE=$canonical_aws_web_identity_file"
  expect_file_contains "$capture.env" "GOOGLE_APPLICATION_CREDENTIALS=$canonical_google_application_credentials"
  expect_file_not_contains "$capture.env" "UNRELATED_SECRET"
  expect_stdout_contains "autoreview clean"
  expect_empty_stderr

  printf 'repo-controlled-token\n' >"$review_repo/.git/aws-web-identity-token"
  rm -f "$capture.invoked"
  AWS_WEB_IDENTITY_TOKEN_FILE="$review_repo/.git/aws-web-identity-token" \
    run_helper_with_path_in_repo_expect_failure "$review_repo" "$fake_bin" --mode local --engine claude --no-tools
  expect_stderr_contains "AWS_WEB_IDENTITY_TOKEN_FILE must point to an existing regular file outside the reviewed repository"
  if [[ -e "$capture.invoked" ]]; then
    printf 'Claude executed despite a repo-contained AWS credential path\n' >&2
    exit 1
  fi

  printf '{"type":"external_account"}\n' >"$review_repo/.git/google-application-credentials.json"
  rm -f "$capture.invoked"
  GOOGLE_APPLICATION_CREDENTIALS="$review_repo/.git/google-application-credentials.json" \
    run_helper_with_path_in_repo_expect_failure "$review_repo" "$fake_bin" --mode local --engine claude --no-tools
  expect_stderr_contains "GOOGLE_APPLICATION_CREDENTIALS must point to an existing regular file outside the reviewed repository"
  if [[ -e "$capture.invoked" ]]; then
    printf 'Claude executed despite a repo-contained Google credential path\n' >&2
    exit 1
  fi
}

run_codex_isolation_regression() {
  local review_repo="$tmp_dir/codex-isolation"
  local fake_bin="$tmp_dir/fake-codex-bin"
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  printf 'change\n' >>"$review_repo/README.md"
  mkdir "$fake_bin"
  cat >"$fake_bin/codex" <<'CODEX'
#!/usr/bin/env bash
printf '%s\n' "$@" >"$AUTOREVIEW_FAKE_CAPTURE"
pwd >"$AUTOREVIEW_FAKE_CAPTURE.cwd"
env >"$AUTOREVIEW_FAKE_CAPTURE.env"
output=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o)
      output="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
cat >/dev/null
printf '%s\n' '{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"clean","overall_confidence":0.9}' >"$output"
CODEX
  chmod +x "$fake_bin/codex"

  run_helper_with_path_in_repo "$review_repo" "$fake_bin" --mode local --engine codex
  expect_capture_contains_line "--ask-for-approval"
  expect_capture_contains_line "never"
  expect_capture_contains_line "--ignore-user-config"
  expect_capture_contains_line "--ignore-rules"
  expect_capture_contains_line "--skip-git-repo-check"
  expect_capture_contains_line "project_doc_max_bytes=0"
  expect_capture_contains_line "features.hooks=false"
  expect_capture_contains_line "features.plugins=false"
  expect_capture_contains_line "skills.include_instructions=false"
  expect_file_not_contains "$capture.cwd" "$review_repo"
  expect_file_contains "$capture.cwd" "/workspace"
  expect_file_not_contains "$capture.env" "UNRELATED_SECRET"
  expect_stdout_contains "autoreview clean"
  expect_empty_stderr
}

run_symlinked_node_codex_regression() {
  local review_repo="$tmp_dir/symlinked-node-codex"
  local fake_bin="$tmp_dir/symlinked-node-codex-bin"
  local fake_target_dir="$tmp_dir/symlinked-node-codex-target"
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  printf 'change\n' >>"$review_repo/README.md"
  mkdir "$fake_bin" "$fake_target_dir"
  cat >"$fake_target_dir/codex.js" <<'CODEX'
#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const outputIndex = args.indexOf("-o");
process.stdin.resume();
process.stdin.on("end", () => {
  fs.writeFileSync(
    args[outputIndex + 1],
    '{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"clean","overall_confidence":0.9}\n',
  );
});
CODEX
  chmod +x "$fake_target_dir/codex.js"
  ln -s "$fake_target_dir/codex.js" "$fake_bin/codex"

  run_helper_with_path_in_repo "$review_repo" "$fake_bin" --mode local --engine codex
  expect_stdout_contains "autoreview clean"
  expect_empty_stderr
}

run_pr_base_detection_regression() {
  local review_repo="$tmp_dir/pr-base-detection"
  local fake_bin="$tmp_dir/pr-base-detection-bin"
  local fake_pr_list="$tmp_dir/pr-base-detection.json"
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  local release_oid
  release_oid="$(git -C "$review_repo" rev-parse HEAD)"
  git -C "$review_repo" update-ref refs/remotes/origin/release "$release_oid"
  git -C "$review_repo" switch -c feature >/dev/null 2>&1
  printf 'feature\n' >"$review_repo/feature.txt"
  commit_review_repo "$review_repo" feature
  mkdir "$fake_bin"
  printf '%s\n' '[{"baseRefName":"release"}]' >"$fake_pr_list"
  cat >"$fake_bin/gh" <<GH
#!/usr/bin/env bash
git rev-parse --show-toplevel >/dev/null || exit 81
if [[ "\$1" == "pr" && "\$2" == "list" ]]; then
  cat "$fake_pr_list"
  exit 0
fi
exit 82
GH
  chmod +x "$fake_bin/gh"

  : >"$stdout"
  : >"$stderr"
  (
    cd "$review_repo"
    env -i \
      "PATH=$fake_bin:$PATH" \
      "HOME=$HOME" \
      "TMPDIR=${TMPDIR:-/tmp}" \
      "$node_bin" "$repo_root/scripts/agent-autoreview.mjs" \
      --engine local --dry-run >"$stdout" 2>"$stderr"
  )
  expect_stdout_contains "requested_ref: origin/release"
  expect_stdout_contains "ref: $release_oid"
  expect_empty_stderr

  printf '%s\n' '[{"baseRefName":"release"},{"baseRefName":"main"}]' >"$fake_pr_list"
  : >"$stdout"
  : >"$stderr"
  local status=0
  (
    cd "$review_repo"
    env -i \
      "PATH=$fake_bin:$PATH" \
      "HOME=$HOME" \
      "TMPDIR=${TMPDIR:-/tmp}" \
      "$node_bin" "$repo_root/scripts/agent-autoreview.mjs" \
      --engine local --dry-run >"$stdout" 2>"$stderr"
  ) || status=$?
  if [[ "$status" -eq 0 ]]; then
    printf 'ambiguous PR base lookup unexpectedly succeeded\n' >&2
    exit 1
  fi
  expect_stderr_contains "multiple open PRs match head branch feature"
}

run_dirty_source_drift_regression() {
  local review_repo="$tmp_dir/dirty-source-drift"
  local fake_bin="$tmp_dir/dirty-source-drift-bin"
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  printf 'review me\n' >>"$review_repo/README.md"
  mkdir "$fake_bin"
  cat >"$fake_bin/claude" <<CLAUDE
#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then
  printf '2.1.210\n'
  exit 0
fi
if [[ "\${1:-}" == "--help" ]]; then
  printf '%s\n' --safe-mode --setting-sources --strict-mcp-config --disallowedTools --tools
  exit 0
fi
cat >/dev/null
printf 'concurrent change\n' >>"$review_repo/README.md"
cat <<'JSON'
{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"clean","overall_confidence":0.9}
JSON
CLAUDE
  chmod +x "$fake_bin/claude"

  run_helper_with_path_in_repo_expect_failure "$review_repo" "$fake_bin" --mode local --engine claude --no-tools
  expect_stderr_contains "source changed during semantic review"
  expect_stdout_not_contains "autoreview clean"
}

run_index_source_drift_regression() {
  local review_repo="$tmp_dir/index-source-drift"
  local fake_bin="$tmp_dir/index-source-drift-bin"
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  printf 'staged review\n' >>"$review_repo/README.md"
  git -C "$review_repo" add README.md
  git -C "$review_repo" restore --source=HEAD --worktree README.md
  mkdir "$fake_bin"
  cat >"$fake_bin/claude" <<CLAUDE
#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then
  printf '2.1.210\n'
  exit 0
fi
if [[ "\${1:-}" == "--help" ]]; then
  printf '%s\n' --safe-mode --setting-sources --strict-mcp-config --disallowedTools --tools
  exit 0
fi
cat >/dev/null
git -C "$review_repo" restore --staged README.md
cat <<'JSON'
{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"clean","overall_confidence":0.9}
JSON
CLAUDE
  chmod +x "$fake_bin/claude"

  run_helper_with_path_in_repo_expect_failure "$review_repo" "$fake_bin" --mode local --engine claude --no-tools
  expect_stderr_contains "source changed during semantic review"
  expect_stdout_not_contains "autoreview clean"
}

run_mode_source_drift_regression() {
  local review_repo="$tmp_dir/mode-source-drift"
  local fake_bin="$tmp_dir/mode-source-drift-bin"
  local snapshot_before
  local snapshot_after
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  printf '#!/usr/bin/env bash\nprintf test\n' >"$review_repo/script.sh"
  chmod 0644 "$review_repo/script.sh"
  snapshot_before="$(cd "$review_repo" && "$node_bin" "$repo_root/scripts/agent-autoreview.mjs" --source-snapshot-only)"
  chmod 0755 "$review_repo/script.sh"
  snapshot_after="$(cd "$review_repo" && "$node_bin" "$repo_root/scripts/agent-autoreview.mjs" --source-snapshot-only)"
  if [[ "$snapshot_before" == "$snapshot_after" ]]; then
    printf 'expected executable-mode change to alter the source snapshot\n' >&2
    exit 1
  fi
  chmod 0644 "$review_repo/script.sh"
  mkdir "$fake_bin"
  cat >"$fake_bin/claude" <<CLAUDE
#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then
  printf '2.1.210\n'
  exit 0
fi
if [[ "\${1:-}" == "--help" ]]; then
  printf '%s\n' --safe-mode --setting-sources --strict-mcp-config --disallowedTools --tools
  exit 0
fi
cat >/dev/null
chmod 0755 "$review_repo/script.sh"
cat <<'JSON'
{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"clean","overall_confidence":0.9}
JSON
CLAUDE
  chmod +x "$fake_bin/claude"

  run_helper_with_path_in_repo_expect_failure "$review_repo" "$fake_bin" --mode local --engine claude --no-tools
  expect_stderr_contains "source changed during semantic review"
  expect_stdout_not_contains "autoreview clean"
}

run_branch_identity_source_drift_regression() {
  local review_repo="$tmp_dir/branch-identity-source-drift"
  local fake_bin="$tmp_dir/branch-identity-source-drift-bin"
  local feature_snapshot
  local sibling_snapshot
  local detached_snapshot
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  git -C "$review_repo" switch -c feature >/dev/null 2>&1
  git -C "$review_repo" -c branch.autoSetupMerge=false branch sibling
  printf 'review me\n' >>"$review_repo/README.md"
  feature_snapshot="$(cd "$review_repo" && "$node_bin" "$repo_root/scripts/agent-autoreview.mjs" --source-snapshot-only)"
  git -C "$review_repo" switch sibling >/dev/null 2>&1
  sibling_snapshot="$(cd "$review_repo" && "$node_bin" "$repo_root/scripts/agent-autoreview.mjs" --source-snapshot-only)"
  if [[ "$feature_snapshot" == "$sibling_snapshot" ]]; then
    printf 'expected same-OID branch switch to alter the source snapshot\n' >&2
    exit 1
  fi
  git -C "$review_repo" switch --detach >/dev/null 2>&1
  detached_snapshot="$(cd "$review_repo" && "$node_bin" "$repo_root/scripts/agent-autoreview.mjs" --source-snapshot-only)"
  if [[ "$sibling_snapshot" == "$detached_snapshot" ]]; then
    printf 'expected detached HEAD to alter the source snapshot\n' >&2
    exit 1
  fi
  git -C "$review_repo" switch feature >/dev/null 2>&1
  mkdir "$fake_bin"
  cat >"$fake_bin/claude" <<CLAUDE
#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then
  printf '2.1.210\n'
  exit 0
fi
if [[ "\${1:-}" == "--help" ]]; then
  printf '%s\n' --safe-mode --setting-sources --strict-mcp-config --disallowedTools --tools
  exit 0
fi
cat >/dev/null
git -C "$review_repo" switch sibling >/dev/null 2>&1
cat <<'JSON'
{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"clean","overall_confidence":0.9}
JSON
CLAUDE
  chmod +x "$fake_bin/claude"

  run_helper_with_path_in_repo_expect_failure "$review_repo" "$fake_bin" --mode local --engine claude --no-tools
  expect_stderr_contains "source changed during semantic review"
  expect_stdout_not_contains "autoreview clean"
}

run_large_untracked_bound_regression() {
  local review_repo="$tmp_dir/large-untracked-bound"
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  dd if=/dev/zero of="$review_repo/large.bin" bs=1048576 count=5 2>/dev/null

  run_node_helper_in_repo_expect_failure "$review_repo" --source-snapshot-only
  expect_stderr_contains "untracked file is too large to review safely"
  run_node_helper_in_repo_expect_failure "$review_repo" --mode local --engine local
  expect_stderr_contains "untracked file is too large to review safely"
}

run_aggregate_untracked_bound_regression() {
  local review_repo="$tmp_dir/aggregate-untracked-bound"
  local bundle_output="$tmp_dir/aggregate-untracked-prompt.md"
  local adapter_bundle="$tmp_dir/aggregate-untracked-bundle"
  local index
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  for index in 1 2 3 4 5 6; do
    dd if=/dev/zero bs=819200 count=1 2>/dev/null |
      tr '\000' 'a' >"$review_repo/large-$index.txt"
  done

  run_node_helper_in_repo_expect_failure "$review_repo" \
    --mode local \
    --engine local \
    --prepare-only \
    --bundle-output "$bundle_output"
  expect_stderr_contains "aggregate limit"

  run_helper_in_repo_expect_failure "$review_repo" \
    --prepare-bundle-dir "$adapter_bundle" \
    --mode local \
    --engine local
  expect_stderr_contains "capture budget"
  if [[ -e "$adapter_bundle" ]]; then
    printf 'aggregate-overflow prepared bundle was published\n' >&2
    exit 1
  fi
}

run_bundle_output_deferred_regression() {
  local review_repo="$tmp_dir/bundle-output-deferred"
  local fake_bin="$tmp_dir/bundle-output-deferred-bin"
  local bundle_output="$review_repo/review-output.md"
  local bundle_output_display="/published/review-output.md"
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  printf 'change\n' >>"$review_repo/README.md"
  printf 'review-output.md\n' >>"$review_repo/.git/info/exclude"
  mkdir "$fake_bin"
  cat >"$fake_bin/claude" <<CLAUDE
#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then
  printf '2.1.210\n'
  exit 0
fi
if [[ "\${1:-}" == "--help" ]]; then
  printf '%s\n' --safe-mode --setting-sources --strict-mcp-config --disallowedTools --tools
  exit 0
fi
cat >/dev/null
if [[ -e "$bundle_output" ]]; then
  printf 'bundle output existed before semantic review\n' >&2
  exit 91
fi
cat <<'JSON'
{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"clean","overall_confidence":0.9}
JSON
CLAUDE
  chmod +x "$fake_bin/claude"

  run_helper_with_path_in_repo "$review_repo" "$fake_bin" --mode local --engine claude --no-tools --bundle-output review-output.md --bundle-output-display "$bundle_output_display"
  expect_file_exists "$bundle_output"
  expect_stdout_contains "bundle_output: $bundle_output_display"
  expect_stdout_contains "autoreview clean"
  expect_empty_stderr
}

run_claude_multi_pass_regression() {
  local review_repo="$tmp_dir/claude-multi-pass"
  local fake_bin="$tmp_dir/fake-claude-multi-bin"
  local bundle_output="$tmp_dir/claude-multi-pass-prompt.md"
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  awk 'BEGIN { for (i = 1; i <= 26000; i += 1) printf "review-line-%06d payload payload payload\n", i; print "TAIL_SENTINEL" }' >"$review_repo/large.txt"
  mkdir "$fake_bin"
  cat >"$fake_bin/claude" <<'CLAUDE'
#!/usr/bin/env bash
printf 'invoked\n' >"$AUTOREVIEW_FAKE_CAPTURE.invoked"
if [[ "${1:-}" == "--version" ]]; then
  printf '2.1.210\n'
  exit 0
fi
if [[ "${1:-}" == "--help" ]]; then
  printf '%s\n' --safe-mode --setting-sources --strict-mcp-config --disallowedTools --tools
  exit 0
fi
cat >/dev/null
cat <<'JSON'
{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"clean","overall_confidence":0.9}
JSON
CLAUDE
  chmod +x "$fake_bin/claude"

  run_helper_with_path_in_repo "$review_repo" "$fake_bin" --mode local --engine claude --no-tools --prepare-only --bundle-output "$bundle_output"
  local pass_files=("$tmp_dir"/claude-multi-pass-prompt.pass-*.md)
  local pass_count="${#pass_files[@]}"
  local index_pass_count
  if [[ ! -f "${pass_files[0]}" ]]; then
    printf 'expected prepare-only to emit bounded pass files\n' >&2
    exit 1
  fi
  if [[ "$pass_count" -lt 2 || "$pass_count" -gt 8 ]]; then
    printf 'expected 2-8 prepared review passes, got %s\n' "$pass_count" >&2
    exit 1
  fi
  expect_file_contains "$bundle_output" "One reviewer must inspect every pass"
  index_pass_count="$(grep -c '^- Pass ' "$bundle_output")"
  if [[ "$index_pass_count" -ne "$pass_count" ]]; then
    printf 'expected prompt index to list all %s passes, listed %s\n' "$pass_count" "$index_pass_count" >&2
    exit 1
  fi
  local pass_file
  for pass_file in "${pass_files[@]}"; do
    expect_file_contains "$bundle_output" "$(basename "$pass_file")"
  done
  expect_file_contains "${pass_files[0]}" "Do not issue a final verdict until you have inspected every pass"
  expect_file_not_contains "${pass_files[0]}" "Reports from all passes are merged"
  if [[ -e "$capture.invoked" ]]; then
    printf 'Claude executed during prepare-only multi-pass bundle creation\n' >&2
    exit 1
  fi
  if ! grep -Fq -- "TAIL_SENTINEL" "${pass_files[@]}"; then
    printf 'expected the final sentinel in one prepared review pass\n' >&2
    exit 1
  fi
  expect_empty_stderr

  rm -f "$capture.invoked"
  run_helper_with_path_in_repo_expect_failure "$review_repo" "$fake_bin" --mode local --engine claude --no-tools
  expect_stderr_contains "independent engine invocations cannot safely detect cross-pass defects"
  expect_stderr_contains "--prepare-only --bundle-output <path>"
  if [[ -e "$capture.invoked" ]]; then
    printf 'Claude executed despite an unsafe multi-pass semantic target\n' >&2
    exit 1
  fi
  expect_stdout_not_contains "autoreview clean"
}

run_heartbeat_regression() {
  local review_repo="$tmp_dir/heartbeat"
  local fake_bin="$tmp_dir/fake-claude-heartbeat-bin"
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  printf 'change\n' >>"$review_repo/README.md"
  mkdir "$fake_bin"
  cat >"$fake_bin/claude" <<'CLAUDE'
#!/usr/bin/env bash
if [[ "${1:-}" == "--version" ]]; then
  printf '2.1.210\n'
  exit 0
fi
if [[ "${1:-}" == "--help" ]]; then
  printf '%s\n' --safe-mode --setting-sources --strict-mcp-config --disallowedTools --tools
  exit 0
fi
cat >/dev/null
sleep 2
cat <<'JSON'
{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"clean","overall_confidence":0.9}
JSON
CLAUDE
  chmod +x "$fake_bin/claude"

  AUTOREVIEW_HEARTBEAT_SECONDS=1 run_helper_with_path_in_repo "$review_repo" "$fake_bin" --mode local --engine claude --no-tools
  expect_stderr_contains "review still running: claude elapsed=1s pid="
  expect_stdout_contains "autoreview clean"
}

run_hostile_git_path_regression() {
  local review_repo="$tmp_dir/hostile-git-path"
  local fake_bin="$review_repo/bin"
  local outside_symlink_bin="$tmp_dir/outside-symlink-git-bin"
  local external_bin="$tmp_dir/external-git-bin"
  local repo_marker="$tmp_dir/repo-git-ran"
  local external_marker="$tmp_dir/external-git-ran"
  local system_git
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  printf 'change\n' >>"$review_repo/README.md"
  mkdir "$fake_bin" "$outside_symlink_bin" "$external_bin"
  cat >"$fake_bin/git" <<GIT
#!/usr/bin/env bash
printf 'unsafe\n' >"$repo_marker"
exit 99
GIT
  chmod +x "$fake_bin/git"
  ln -s "$fake_bin/git" "$outside_symlink_bin/git"
  system_git="$(command -v git)"
  cat >"$external_bin/git" <<GIT
#!/usr/bin/env bash
printf 'safe external git\n' >"$external_marker"
exec "$system_git" "\$@"
GIT
  chmod +x "$external_bin/git"

  run_helper_with_path_in_repo "$review_repo" "$fake_bin:$outside_symlink_bin:$external_bin" --mode local --engine local
  if [[ -e "$repo_marker" ]]; then
    printf 'repo-local git shim executed\n' >&2
    exit 1
  fi
  expect_file_exists "$external_marker"
  expect_stdout_contains "autoreview clean"
  expect_empty_stderr
}

run_sensitive_input_regressions() {
  local review_repo="$tmp_dir/sensitive-inputs"
  local bundle_output="$tmp_dir/sensitive-prompt.md"
  local adapter_bundle="$tmp_dir/sensitive-adapter-bundle"
  init_review_repo "$review_repo"
  printf 'base\n' >"$review_repo/README.md"
  commit_review_repo "$review_repo" init
  printf 'api_key = "%s%s"\n' "live-value-" "abcdefghijklmnopqrstuvwxyz" >>"$review_repo/README.md"

  run_helper_in_repo_expect_failure "$review_repo" --mode local --engine local --bundle-output "$bundle_output" --prepare-only
  expect_stderr_contains "refusing to include secret-like content"
  if grep -Fq -- "live-value-abcdefghijklmnopqrstuvwxyz" "$stderr"; then
    printf 'secret scanner disclosed the rejected value\n' >&2
    exit 1
  fi

  run_helper_in_repo_expect_failure "$review_repo" --prepare-bundle-dir "$adapter_bundle" --mode local --engine local
  expect_stderr_contains "refusing to include secret-like content"
  if [[ -e "$adapter_bundle" ]]; then
    printf 'rejected sensitive prepared bundle was published: %s\n' "$adapter_bundle" >&2
    exit 1
  fi

  git -C "$review_repo" restore README.md
  mkdir "$review_repo/.aws"
  {
    printf '[default]\n'
    printf 'aws_access_key_id = ASIA%s\n' "AAAAAAAAAAAAAAAA"
    printf 'aws_secret_access_key = aws-secret-%s\n' "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    printf 'aws_session_token = aws-session-%s\n' "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  } >"$review_repo/.aws/credentials.example"
  run_helper_in_repo_expect_failure "$review_repo" --mode local --engine local --bundle-output "$bundle_output" --prepare-only
  expect_stderr_contains "refusing to include secret-like content"
  rm -rf "$review_repo/.aws"

  printf 'public=true\n' >"$review_repo/.env"
  run_helper_in_repo_expect_failure "$review_repo" --mode local --engine local --bundle-output "$bundle_output" --prepare-only
  expect_stderr_contains "refusing sensitive untracked file"

  rm "$review_repo/.env"
  ln -s README.md "$review_repo/linked.md"
  run_helper_in_repo_expect_failure "$review_repo" --mode local --engine local --bundle-output "$bundle_output" --prepare-only
  expect_stderr_contains "refusing symlinked untracked file"

  rm "$review_repo/linked.md"
  printf 'api_key = "%c%s"\n' 36 '{SERVICE_API_KEY}' >"$review_repo/.env"
  commit_review_repo "$review_repo" "add placeholder environment file"
  git -C "$review_repo" mv .env public-config.txt
  run_helper_in_repo_expect_failure "$review_repo" --mode local --engine local --bundle-output "$bundle_output" --prepare-only
  expect_stderr_contains "refusing to include sensitive changed paths"
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

run_parallel_tests_removed_regression
run_branch_diff_check_regression
run_local_deleted_reference_regression
run_commit_target_reads_selected_ref_regression
run_auto_dirty_branch_regression
run_branch_local_diff_check_fixed_regression
run_branch_local_deleted_reference_regression
run_branch_local_deleted_reference_fixed_regression
run_requested_codex_missing_regression
run_claude_no_tools_regression
run_codex_isolation_regression
run_symlinked_node_codex_regression
run_pr_base_detection_regression
run_dirty_source_drift_regression
run_index_source_drift_regression
run_mode_source_drift_regression
run_branch_identity_source_drift_regression
run_large_untracked_bound_regression
run_aggregate_untracked_bound_regression
run_bundle_output_deferred_regression
run_claude_multi_pass_regression
run_heartbeat_regression
run_hostile_git_path_regression
run_sensitive_input_regressions

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

conflicting_bundle="$tmp_dir/conflicting-context-bundle"
conflicting_output="$tmp_dir/conflicting-prompt.md"
run_adapter_expect_failure \
  --prepare-bundle-dir "$conflicting_bundle" \
  --bundle-output "$conflicting_output" \
  --mode branch \
  --base HEAD
expect_stderr_contains "--bundle-output cannot be combined with --prepare-bundle-dir"
if [[ -e "$conflicting_bundle" || -e "$conflicting_output" ]]; then
  printf 'conflicting prepared-bundle output was created\n' >&2
  exit 1
fi

bad_snapshot_bundle="$tmp_dir/bad-snapshot-context-bundle"
run_adapter_expect_failure \
  AUTOREVIEW_FAKE_BAD_SNAPSHOT=1 \
  --prepare-bundle-dir "$bad_snapshot_bundle" \
  --mode branch \
  --base HEAD
expect_stderr_contains "AUTOREVIEW_HELPER --source-snapshot-only must print exactly one SHA-256 fingerprint"
if [[ -e "$bad_snapshot_bundle" ]]; then
  printf 'prepared bundle was published with an invalid replacement-helper snapshot\n' >&2
  exit 1
fi

bundle_dir="$tmp_dir/context-bundle"
canonical_bundle_dir="$(cd "$(dirname "$bundle_dir")" && pwd -P)/$(basename "$bundle_dir")"
frozen_head="$(git -C "$repo_root" rev-parse HEAD)"
run_adapter --prepare-bundle-dir "$bundle_dir" --mode branch --base HEAD --dry-run
captured_bundle_output="$(awk 'previous == "--bundle-output" { print; exit } { previous = $0 }' "$capture")"
case "$captured_bundle_output" in
  "$(dirname "$canonical_bundle_dir")"/.agent-autoreview-context.*/autoreview-prompt.md) ;;
  *)
    printf 'unexpected staged bundle output path: %s\n' "$captured_bundle_output" >&2
    exit 1
    ;;
esac
expect_args $'--mode\nbranch\n--base\nHEAD\n--dry-run\n--base\n'"$frozen_head"$'\n--prompt-file\ndocs/pr-checklists/recurring-review-patterns.md\n--prompt-file\ndocs/pr-checklists/review-prompt-exclusions.md\n--bundle-output\n'"$captured_bundle_output"$'\n--bundle-output-display\n'"$canonical_bundle_dir"$'/autoreview-prompt.md\n--prepare-only'
expect_empty_stderr
expect_file_exists "$canonical_bundle_dir/README.md"
expect_file_exists "$canonical_bundle_dir/changed-paths.txt"
expect_file_exists "$canonical_bundle_dir/patches/branch.diff"
expect_file_exists "$canonical_bundle_dir/checklists/recurring-review-patterns.md"
expect_file_exists "$canonical_bundle_dir/checklists/review-prompt-exclusions.md"
expect_file_exists "$canonical_bundle_dir/autoreview-prompt.md"
expect_file_exists "$canonical_bundle_dir/helper-output.txt"
expect_file_contains "$canonical_bundle_dir/README.md" "Autoreview Context Bundle"
expect_file_contains "$canonical_bundle_dir/selected-checklists.txt" "docs/pr-checklists/review-prompt-exclusions.md"
expect_file_contains "$canonical_bundle_dir/helper-output.txt" "$canonical_bundle_dir/autoreview-prompt.md"
expect_file_not_contains "$canonical_bundle_dir/helper-output.txt" ".agent-autoreview-context."
expect_stdout_contains "$canonical_bundle_dir/autoreview-prompt.md"
expect_stdout_not_contains ".agent-autoreview-context."
expect_file_contains "$stdout" "agent:autoreview context bundle: $canonical_bundle_dir"
if [[ "$(wc -l <"$capture.snapshot" | tr -d ' ')" != "2" ]]; then
  printf 'replacement helper did not provide both prepared-bundle source snapshots\n' >&2
  exit 1
fi

bundle_mutation_repo="$tmp_dir/bundle-mutation"
init_review_repo "$bundle_mutation_repo"
printf 'base\n' >"$bundle_mutation_repo/README.md"
commit_review_repo "$bundle_mutation_repo" init
printf 'review me\n' >>"$bundle_mutation_repo/README.md"
bundle_mutation_output="$tmp_dir/context-bundle-mutation"
(
  cd "$bundle_mutation_repo"
  run_adapter_expect_failure \
    "AUTOREVIEW_MUTATE_PATH=$bundle_mutation_repo/README.md" \
    --prepare-bundle-dir "$bundle_mutation_output" \
    --mode local \
    --dry-run
)
expect_stderr_contains "source changed while the prepared bundle was being created"
if [[ -e "$bundle_mutation_output" ]]; then
  printf 'source-drifted prepared bundle was published: %s\n' "$bundle_mutation_output" >&2
  exit 1
fi

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
hostile_gh_bin="$pr_base_repo/bin"
hostile_gh_marker="$tmp_dir/repo-gh-ran"
mkdir "$fake_gh_bin"
mkdir "$hostile_gh_bin"
cat >"$hostile_gh_bin/gh" <<GH
#!/usr/bin/env bash
printf 'unsafe\n' >"$hostile_gh_marker"
exit 99
GH
chmod +x "$hostile_gh_bin/gh"
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
(cd "$pr_base_repo" && run_adapter "PATH=$hostile_gh_bin:$fake_gh_bin:$PATH" --prepare-bundle-dir "$pr_base_bundle" --mode branch --dry-run)
expect_file_contains "$pr_base_bundle/README.md" "- Target: branch origin/release"
expect_file_contains "$pr_base_bundle/changed-paths.txt" "feature.txt"
if [[ -e "$hostile_gh_marker" ]]; then
  printf 'repo-local gh shim executed\n' >&2
  exit 1
fi

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
