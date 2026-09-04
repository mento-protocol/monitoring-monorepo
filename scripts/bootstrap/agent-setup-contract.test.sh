#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

output_file="$(mktemp)"
hook_repo=""
hook_noop_repo=""
minimal_bin=""
marker_scratch=""
validator_repo=""

cleanup() {
  rm -f "$output_file"
  for path in \
    "$hook_repo" \
    "$hook_noop_repo" \
    "$minimal_bin" \
    "$marker_scratch" \
    "$validator_repo"; do
    [[ -z "$path" ]] || rm -rf "$path"
  done
}
trap cleanup EXIT

fail() {
  {
    echo "agent setup contract failed: $*"
    echo
    echo "Last command output:"
    sed 's/^/  /' "$output_file"
  } | tee /dev/stderr
  exit 1
}

assert_contains() {
  local expected="$1"
  grep -Fq -- "$expected" "$output_file" ||
    fail "missing expected output: $expected"
}

assert_not_contains() {
  local unexpected="$1"
  if grep -Fq -- "$unexpected" "$output_file"; then
    fail "found unexpected output: $unexpected"
  fi
}

# The SessionEnd hook must report a recent committed change and stay quiet for
# a clean session. Use a minimal PATH for the changed-session case so the hook
# cannot pass through an undeclared tool dependency.
hook_repo="$(mktemp -d)"
(
  cd "$hook_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Setup Contract Test"
  mkdir -p scripts/bootstrap
  cp "$repo_root/scripts/bootstrap/agent-session-end-hook.sh" scripts/bootstrap/
  echo initial > README.md
  git add README.md scripts/bootstrap/agent-session-end-hook.sh
  git commit -qm init
  git reflog expire --expire=now --all
  echo changed >> README.md
  git add README.md
  git commit -qm "commit from session"

  minimal_bin="$(mktemp -d)"
  real_git="$(command -v git)"
  real_git_quoted="$(printf '%q' "$real_git")"
  IFS= read -r real_git_first_line < "$real_git" || real_git_first_line=""
  if [[ "$real_git_first_line" == '#!'* ]]; then
    # Codex Cloud can expose git as a Bash wrapper. Preserve that path under
    # the constrained fixture PATH.
    printf '#!/bin/bash\nexec /bin/bash %s "$@"\n' \
      "$real_git_quoted" > "$minimal_bin/git"
  else
    printf '#!/bin/bash\nexec %s "$@"\n' \
      "$real_git_quoted" > "$minimal_bin/git"
  fi
  chmod +x "$minimal_bin/git"
  for tool in awk bash cat dirname pwd tr wc; do
    ln -s "$(command -v "$tool")" "$minimal_bin/$tool"
  done
  printf '{"cwd":"%s"}' "$hook_repo" |
    env PATH="$minimal_bin" /bin/bash scripts/bootstrap/agent-session-end-hook.sh \
      > "$output_file" 2>&1
  rm -rf "$minimal_bin"
  minimal_bin=""
)
rm -rf "$hook_repo"
hook_repo=""
assert_contains "Session touched the tree (1 recent commit(s), 0 unstaged file(s))."

hook_noop_repo="$(mktemp -d)"
(
  cd "$hook_noop_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Setup Contract Test"
  mkdir -p scripts/bootstrap
  cp "$repo_root/scripts/bootstrap/agent-session-end-hook.sh" scripts/bootstrap/
  echo initial > README.md
  git add README.md scripts/bootstrap/agent-session-end-hook.sh
  git commit -qm init
  git reflog expire --expire=now --all
  printf '{"cwd":"%s"}' "$hook_noop_repo" |
    bash scripts/bootstrap/agent-session-end-hook.sh > "$output_file" 2>&1
)
rm -rf "$hook_noop_repo"
hook_noop_repo=""
assert_not_contains "Session touched the tree"

# scripts/lib/install-marker.sh is shared by local and hosted setup. Exercise
# its skip behavior with a path that contains a space. The old inline version
# split such paths and omitted them from the hash.
# shellcheck source=scripts/lib/install-marker.sh
source "$repo_root/scripts/lib/install-marker.sh"

marker_scratch="$(mktemp -d "${TMPDIR:-/tmp}/install marker test.XXXXXX")"
mkdir -p "$marker_scratch/inputs"
printf 'one\n' > "$marker_scratch/inputs/plain.txt"
printf 'two\n' > "$marker_scratch/inputs/name with space.txt"
marker_file="$marker_scratch/marker.sha256"

marker_hash="$(install_marker_hash_inputs "$marker_scratch/inputs" || true)"
[[ -n "$marker_hash" ]] || fail "install_marker_hash_inputs produced no hash"
if install_marker_matches "$marker_file" "$marker_hash"; then
  fail "install-marker matched before any marker was written"
fi
install_marker_write "$marker_file" "$marker_hash"
if ! install_marker_matches "$marker_file" "$marker_hash"; then
  fail "install-marker did not match the marker it just wrote"
fi

marker_rerun_hash="$(install_marker_hash_inputs "$marker_scratch/inputs" || true)"
[[ "$marker_rerun_hash" == "$marker_hash" ]] ||
  fail "install-marker hash changed across two runs over identical inputs"
if ! install_marker_matches "$marker_file" "$marker_rerun_hash"; then
  fail "install-marker skip did not fire on an unchanged rerun"
fi

printf 'changed\n' > "$marker_scratch/inputs/name with space.txt"
marker_changed_hash="$(install_marker_hash_inputs "$marker_scratch/inputs" || true)"
[[ -n "$marker_changed_hash" ]] ||
  fail "install-marker produced no hash after an input changed"
[[ "$marker_changed_hash" != "$marker_hash" ]] ||
  fail "install-marker ignored a change to an input path containing a space"
if install_marker_matches "$marker_file" "$marker_changed_hash"; then
  fail "install-marker matched a stale marker after its inputs changed"
fi

marker_empty_hash="$(install_marker_hash_inputs "$marker_scratch/absent" || true)"
[[ -z "$marker_empty_hash" ]] || fail "install-marker hashed a missing input set"
if install_marker_matches "$marker_scratch/never-written.sha256" "$marker_empty_hash"; then
  fail "install-marker matched an empty hash against an absent marker"
fi
if install_marker_matches "$marker_file" "$marker_empty_hash"; then
  fail "install-marker matched on an empty hash"
fi

# Root can read mode-000 files, so this case applies only to unprivileged runs.
if [[ "$(id -u)" != "0" ]]; then
  printf 'three\n' > "$marker_scratch/inputs/unreadable.txt"
  chmod 000 "$marker_scratch/inputs/unreadable.txt"
  marker_partial_hash="$(install_marker_hash_inputs "$marker_scratch/inputs" || true)"
  chmod 644 "$marker_scratch/inputs/unreadable.txt"
  if [[ -n "$marker_partial_hash" ]]; then
    fail "install-marker returned a hash that omits an unreadable input"
  fi
  rm -f "$marker_scratch/inputs/unreadable.txt"
fi

install_marker_write "$marker_file" ""
if ! install_marker_matches "$marker_file" "$marker_hash"; then
  fail "install_marker_write overwrote a marker with an empty hash"
fi

rm -rf "$marker_scratch"
marker_scratch=""

for marker_consumer in scripts/setup.sh scripts/bootstrap/claude-code-web-setup.sh; do
  # Match the literal variable reference.
  # shellcheck disable=SC2016
  grep -q 'source "\$REPO_ROOT/scripts/lib/install-marker.sh"' "$marker_consumer" ||
    fail "$marker_consumer no longer sources scripts/lib/install-marker.sh"
  grep -q 'install_marker_hash_inputs' "$marker_consumer" ||
    fail "$marker_consumer no longer uses the shared install-marker hash"
done

setup_shared_config_marker_block="$(
  sed -n '/^shared_config_hash=/,/^)"$/p' scripts/setup.sh
)"
grep -q 'shared-config/scripts/build.mjs' <<< "$setup_shared_config_marker_block" ||
  fail "scripts/setup.sh no longer invalidates its shared-config build marker when the clean-build wrapper changes"

web_deps_marker_block="$(
  sed -n '/^deps_hash=/,/^)"$/p' scripts/bootstrap/claude-code-web-setup.sh
)"
grep -q 'shared-config/scripts/build.mjs' <<< "$web_deps_marker_block" ||
  fail "scripts/bootstrap/claude-code-web-setup.sh no longer invalidates its dependency marker when the clean-build wrapper changes"

# M5 keeps staged formatting and removes repository checks from pre-push.
[[ -x .trunk/hooks/pre-commit ]] ||
  fail ".trunk/hooks/pre-commit must remain executable"
[[ ! -e .trunk/hooks/pre-push ]] ||
  fail ".trunk/hooks/pre-push must stay absent after local cutover"
sed -n '/^actions:$/,$p' .trunk/trunk.yaml |
  sed -n '/^  enabled:$/,/^  [^[:space:]]/p' |
  grep -Fqx -- "    - trunk-fmt-pre-commit" ||
  fail ".trunk/trunk.yaml must keep trunk-fmt-pre-commit enabled"
! grep -Eq -- \
  'trunk-check-pre-push|agent-quality-gate-pre-push|git_hooks: \[pre-push\]|--pre-push' \
  .trunk/trunk.yaml || fail ".trunk/trunk.yaml retained a pre-push marker"

for hosted_setup in \
  scripts/bootstrap/claude-code-web-setup.sh \
  scripts/bootstrap/codex-cloud-maintenance.sh \
  scripts/bootstrap/codex-cloud-setup.sh; do
  grep -Fq -- "git config core.hooksPath .trunk/hooks" "$hosted_setup" ||
    fail "$hosted_setup no longer installs the tracked pre-commit hook path"
  ! grep -Fq -- "agent.qualityGate.cloudPrePushRequireFresh" "$hosted_setup" ||
    fail "$hosted_setup restored hosted pre-push freshness"
done
! grep -Fq -- "agent.qualityGate.cloudPrePushRequireFresh" \
  .claude/hooks/session-start.sh ||
  fail ".claude/hooks/session-start.sh restored hosted pre-push freshness"
! grep -Fq -- "Before every push from a server/worktree" scripts/setup.sh ||
  fail "scripts/setup.sh restored the mandatory manual pre-push checklist"

# The pre-install validator must reject a changed trusted alias. This fixture
# proves the validator itself fails closed without running pnpm install.
validator_repo="$(mktemp -d)"
(
  cd "$validator_repo"
  cat > package.json <<'JSON'
{
  "name": "fixture",
  "scripts": {
    "agent:quality-gate": "true",
    "agent:quality-gate:test": "bash scripts/agent-quality-gate.test.sh",
    "agent:context-check": "node scripts/context/check-agent-context.mjs",
    "agent:autoreview": "./scripts/agent-autoreview.sh",
    "agent:prewarm": "node scripts/gate/agent-prewarm.mjs",
    "agent:prewarm:test": "node scripts/gate/agent-prewarm.test.mjs",
    "agent:review-materiality": "node scripts/pr/review-materiality.mjs",
    "agent:review-materiality:test": "node scripts/pr/review-materiality.test.mjs",
    "docs:garden": "node scripts/docs/docs-garden-issue.mjs",
    "docs:garden:test": "node scripts/docs/docs-garden-issue.test.mjs",
    "docs:navigation-eval": "node scripts/docs/docs-navigation-eval.mjs",
    "docs:navigation-eval:test": "node scripts/docs/docs-navigation-eval.test.mjs",
    "issue:board": "node scripts/pr/agent-issue-board.mjs",
    "issue:board:test": "node scripts/pr/agent-issue-board.test.mjs",
    "issue:claim": "node scripts/pr/agent-issue-board.mjs claim",
    "issue:review": "node scripts/pr/agent-issue-board.mjs review",
    "issue:release": "node scripts/pr/agent-issue-board.mjs release",
    "pr:feedback-state": "node scripts/pr/pr-feedback-state.mjs",
    "pr:feedback-state:test": "node scripts/pr/pr-feedback-state.test.mjs",
    "pr:ready-state": "node scripts/pr/pr-ready-state.mjs",
    "pr:ready-state:test": "node scripts/pr/pr-ready-state.test.mjs",
    "lockfile:lint": "node scripts/supply-chain/lockfile-lint.mjs",
    "lockfile:lint:test": "node scripts/supply-chain/lockfile-lint.test.mjs",
    "skew:check": "node scripts/supply-chain/version-skew-check.mjs",
    "skew:check:test": "node scripts/supply-chain/version-skew-check.test.mjs"
  }
}
JSON
  set +e
  node "$repo_root/scripts/check-agent-quality-gate-package-scripts.mjs" \
    > "$output_file" 2>&1
  exit_code=$?
  set -e
  [[ "$exit_code" -ne 0 ]]
)
rm -rf "$validator_repo"
validator_repo=""
assert_contains 'package.json scripts.agent:quality-gate must be "./scripts/agent-quality-gate.sh"'

echo "agent setup contract tests passed"
