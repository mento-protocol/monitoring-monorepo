#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

paths_file="$(mktemp)"
output_file="$(mktemp)"
codex_hooks_backup="$(mktemp)"
claude_settings_backup="$(mktemp)"
untracked_skill_artifact=".claude/skills/.agent-quality-gate-test.tmp"
cp .codex/hooks.json "$codex_hooks_backup"
cp .claude/settings.json "$claude_settings_backup"

restore_hook_configs() {
  cp "$codex_hooks_backup" .codex/hooks.json
  cp "$claude_settings_backup" .claude/settings.json
}

trap 'restore_hook_configs; rm -f "$paths_file" "$output_file" "$output_file.pnpm-args" "$untracked_skill_artifact" "$codex_hooks_backup" "$claude_settings_backup"' EXIT

fail() {
  echo "agent-quality-gate test failed: $*" >&2
  echo >&2
  echo "Last gate output:" >&2
  sed 's/^/  /' "$output_file" >&2
  exit 1
}

run_gate() {
  : > "$paths_file"
  local path
  for path in "$@"; do
    printf '%s\n' "$path" >> "$paths_file"
  done

  AGENT_QUALITY_ALLOW_PACKAGE_SCRIPT_CHANGES=false \
    scripts/agent-quality-gate.sh \
    --changed-paths-file "$paths_file" \
    --base origin/test \
    > "$output_file"
}

run_gate_expect_failure() {
  : > "$paths_file"
  local path
  for path in "$@"; do
    printf '%s\n' "$path" >> "$paths_file"
  done

  set +e
  AGENT_QUALITY_ALLOW_PACKAGE_SCRIPT_CHANGES=false \
    scripts/agent-quality-gate.sh \
    --changed-paths-file "$paths_file" \
    --base origin/test \
    --run \
    > "$output_file" 2>&1
  local exit_code=$?
  set -e

  [[ "$exit_code" -ne 0 ]] ||
    fail "expected gate to fail, but it exited 0"
}

assert_contains() {
  local expected="$1"
  expected="$(normalize_expected_command "$expected")"
  grep -Fq -- "$expected" "$output_file" ||
    fail "expected output to contain: $expected"
}

assert_occurrences() {
  local expected_count="$1"
  local expected="$2"
  local actual_count
  expected="$(normalize_expected_command "$expected")"
  actual_count="$(awk -v expected="$expected" 'index($0, expected) { count++ } END { print count + 0 }' "$output_file")"
  [[ "$actual_count" == "$expected_count" ]] ||
    fail "expected $expected_count occurrence(s) of '$expected', found $actual_count"
}

assert_not_contains() {
  local unexpected="$1"
  if grep -Fq -- "$unexpected" "$output_file"; then
    fail "expected output not to contain: $unexpected"
  fi
}

assert_not_contains_mapped() {
  local unexpected="$1"
  unexpected="$(normalize_expected_command "$unexpected")"
  assert_not_contains "$unexpected"
}

run_context_check_expect_failure() {
  set +e
  node scripts/check-agent-context.mjs > "$output_file" 2>&1
  local exit_code=$?
  set -e

  [[ "$exit_code" -ne 0 ]] ||
    fail "expected agent context check to fail, but it exited 0"
}

line_number() {
  local needle="$1"
  needle="$(normalize_expected_command "$needle")"
  grep -nF -- "$needle" "$output_file" | head -n 1 | cut -d: -f1
}

normalize_expected_command() {
  local expected="$1"
  local package_name
  local task_name

  case "$expected" in
    *"pnpm dashboard:build"*)
      expected="${expected/pnpm dashboard:build/pnpm exec turbo run build --filter=@mento-protocol/ui-dashboard --cache=local:rw}"
      ;;
    *"pnpm dashboard:size-limit"*)
      expected="${expected/pnpm dashboard:size-limit/pnpm exec turbo run size-limit --filter=@mento-protocol/ui-dashboard --cache=local:rw}"
      ;;
    *"bash scripts/check-react-doctor-score.sh"*)
      expected="${expected/bash scripts\/check-react-doctor-score.sh/pnpm exec turbo run react-doctor:score --filter=@mento-protocol\/ui-dashboard --cache=local:rw}"
      ;;
    *"bash scripts/check-react-doctor-diff.sh "*)
      local base_ref="${expected#*bash scripts/check-react-doctor-diff.sh }"
      base_ref="${base_ref%% *}"
      expected="${expected/bash scripts\/check-react-doctor-diff.sh ${base_ref}/REACT_DOCTOR_BASE_REF=${base_ref} REACT_DOCTOR_BASE_CACHE_KEY=__unresolved__:${base_ref} pnpm exec turbo run react-doctor:diff --filter=@mento-protocol\/ui-dashboard --cache=local:rw}"
      ;;
    *"pnpm --filter @mento-protocol/"*" lint"*|*"pnpm --filter @mento-protocol/"*" typecheck"*|*"pnpm --filter @mento-protocol/"*" test"*|*"pnpm --filter @mento-protocol/"*" knip"*)
      package_name="${expected#*pnpm --filter }"
      package_name="${package_name%% *}"
      task_name="${expected#*pnpm --filter ${package_name} }"
      task_name="${task_name%% *}"
      case "$task_name" in
        lint|typecheck|test|test:browser|knip)
          expected="${expected/pnpm --filter ${package_name} ${task_name}/pnpm exec turbo run ${task_name} --filter=${package_name} --cache=local:rw}"
          ;;
      esac
      ;;
  esac

  printf '%s\n' "$expected"
}

assert_turbo_task_has_input() {
  local task_name="$1"
  local expected_input="$2"

  node - "$task_name" "$expected_input" <<'NODE' ||
const fs = require("node:fs");
const [taskName, expectedInput] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync("turbo.json", "utf8"));
const inputs = config.tasks?.[taskName]?.inputs ?? [];
if (!inputs.includes(expectedInput)) {
  console.error(`missing input ${expectedInput} for turbo task ${taskName}`);
  process.exit(1);
}
NODE
    fail "expected turbo task $task_name to include input: $expected_input"
}

assert_turbo_task_lacks_input() {
  local task_name="$1"
  local unexpected_input="$2"

  node - "$task_name" "$unexpected_input" <<'NODE' ||
const fs = require("node:fs");
const [taskName, unexpectedInput] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync("turbo.json", "utf8"));
const inputs = config.tasks?.[taskName]?.inputs ?? [];
if (inputs.includes(unexpectedInput)) {
  console.error(`unexpected input ${unexpectedInput} for turbo task ${taskName}`);
  process.exit(1);
}
NODE
    fail "expected turbo task $task_name not to include input: $unexpected_input"
}

assert_turbo_task_has_env() {
  local task_name="$1"
  local expected_env="$2"

  node - "$task_name" "$expected_env" <<'NODE' ||
const fs = require("node:fs");
const [taskName, expectedEnv] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync("turbo.json", "utf8"));
const env = config.tasks?.[taskName]?.env ?? [];
if (!env.includes(expectedEnv)) {
  console.error(`missing env ${expectedEnv} for turbo task ${taskName}`);
  process.exit(1);
}
NODE
    fail "expected turbo task $task_name to include env: $expected_env"
}

assert_turbo_task_has_output() {
  local task_name="$1"
  local expected_output="$2"

  node - "$task_name" "$expected_output" <<'NODE' ||
const fs = require("node:fs");
const [taskName, expectedOutput] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync("turbo.json", "utf8"));
const outputs = config.tasks?.[taskName]?.outputs ?? [];
if (!outputs.includes(expectedOutput)) {
  console.error(`missing output ${expectedOutput} for turbo task ${taskName}`);
  process.exit(1);
}
NODE
    fail "expected turbo task $task_name to include output: $expected_output"
}

assert_turbo_task_absent() {
  local task_name="$1"

  node - "$task_name" <<'NODE' ||
const fs = require("node:fs");
const [taskName] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync("turbo.json", "utf8"));
if (Object.prototype.hasOwnProperty.call(config.tasks ?? {}, taskName)) {
  console.error(`unexpected turbo task ${taskName}`);
  process.exit(1);
}
NODE
    fail "expected turbo task to be absent: $task_name"
}

assert_order() {
  local earlier="$1"
  local later="$2"
  local earlier_line
  local later_line

  earlier_line="$(line_number "$earlier" || true)"
  later_line="$(line_number "$later" || true)"

  [[ -n "$earlier_line" ]] || fail "missing ordered item: $earlier"
  [[ -n "$later_line" ]] || fail "missing ordered item: $later"
  [[ "$earlier_line" -lt "$later_line" ]] ||
    fail "expected '$earlier' before '$later'"
}

assert_script_occurrences() {
  local expected_count="$1"
  local expected="$2"
  local actual_count
  actual_count="$(awk -v expected="$expected" 'index($0, expected) { count++ } END { print count + 0 }' scripts/agent-quality-gate.sh)"
  [[ "$actual_count" == "$expected_count" ]] ||
    fail "expected $expected_count occurrence(s) of '$expected' in scripts/agent-quality-gate.sh, found $actual_count"
}

assert_script_occurrences 1 "trap cleanup_tmpfiles EXIT"
assert_script_occurrences 1 'changed_paths_file="$(make_tmpfile)"'
assert_script_occurrences 0 "trap 'rm -f \"\$changed_paths_file\"' EXIT"
assert_script_occurrences 1 "command -v sha256sum"
assert_script_occurrences 1 "command -v shasum"
assert_script_occurrences 0 "shasum -a 256 | awk"
assert_script_occurrences 0 'shasum -a 256 "$1"'

assert_turbo_task_has_input "build" '$TURBO_ROOT$/shared-config/src/**'
assert_turbo_task_has_input "build" '$TURBO_ROOT$/shared-config/*.json'
assert_turbo_task_has_input "build" "postcss.config.*"
assert_turbo_task_has_input "build" "next.config.*"
assert_turbo_task_has_input "build" "sentry.shared.ts"
assert_turbo_task_has_input "build" '$TURBO_ROOT$/package.json'
assert_turbo_task_has_input "build" '$TURBO_ROOT$/pnpm-lock.yaml'
assert_turbo_task_has_input "build" '$TURBO_ROOT$/pnpm-workspace.yaml'
assert_turbo_task_has_input "build" '$TURBO_ROOT$/.npmrc'
assert_turbo_task_has_input "build" '$TURBO_ROOT$/.node-version'
assert_turbo_task_has_input "build" '$TURBO_ROOT$/turbo.json'
assert_turbo_task_has_env "build" "VERCEL_ENV"
assert_turbo_task_has_output "build" ".next/**"
assert_turbo_task_has_output "build" "!.next/cache/**"
assert_turbo_task_has_output "build" "!.next/dev/**"
assert_turbo_task_has_input "size-limit" ".next/**"
assert_turbo_task_has_input "size-limit" "!.next/cache/**"
assert_turbo_task_has_input "size-limit" "!.next/dev/**"
node - <<'NODE' ||
const fs = require("node:fs");
const config = JSON.parse(fs.readFileSync("turbo.json", "utf8"));
const dependsOn = config.tasks?.["size-limit"]?.dependsOn ?? [];
if (!dependsOn.includes("build")) {
  console.error("size-limit must depend on build because it reads .next output");
  process.exit(1);
}
NODE
  fail "expected turbo size-limit task to depend on build"
assert_turbo_task_has_input "test:browser" '$TURBO_ROOT$/shared-config/src/**'
assert_turbo_task_has_input "test:browser" '$TURBO_ROOT$/shared-config/*.json'
assert_turbo_task_has_input "test:browser" "playwright.config.ts"
assert_turbo_task_has_input "test:browser" "sentry.shared.ts"
assert_turbo_task_has_input "test:browser" "scripts/run-browser-tests.mjs"
assert_turbo_task_has_input "test:browser" "tests/browser/**"
assert_turbo_task_lacks_input "test:browser" ".size-limit.cjs"
assert_turbo_task_has_input "test:browser" '$TURBO_ROOT$/package.json'
assert_turbo_task_has_input "test:browser" '$TURBO_ROOT$/pnpm-lock.yaml'
assert_turbo_task_has_input "test:browser" '$TURBO_ROOT$/pnpm-workspace.yaml'
assert_turbo_task_has_input "test:browser" '$TURBO_ROOT$/.npmrc'
assert_turbo_task_has_input "test:browser" '$TURBO_ROOT$/.node-version'
assert_turbo_task_has_input "test:browser" '$TURBO_ROOT$/turbo.json'
assert_turbo_task_has_env "test:browser" "PLAYWRIGHT_NEXT_PORT"
assert_turbo_task_has_env "test:browser" "PLAYWRIGHT_FIXTURE_PORT"
assert_turbo_task_has_env "test:browser" "CI"
assert_turbo_task_has_env "test:browser" "NEXT_TELEMETRY_DISABLED"
assert_turbo_task_has_env "test:browser" "NEXT_PUBLIC_HASURA_URL"
assert_turbo_task_has_env "test:browser" "NEXT_PUBLIC_BROWSER_TEST_FIXTURES"
assert_turbo_task_has_env "test:browser" "VERCEL_ENV"
assert_turbo_task_absent "test:browser:update-snapshots"
node - <<'NODE' ||
const fs = require("node:fs");
const pkg = JSON.parse(fs.readFileSync("ui-dashboard/package.json", "utf8"));
if (pkg.scripts?.["react-doctor:diff"] !== 'bash ../scripts/check-react-doctor-diff.sh "${REACT_DOCTOR_BASE_REF:-origin/main}"') {
  console.error("ui-dashboard react-doctor:diff must delegate to the root diff wrapper");
  process.exit(1);
}
if (pkg.scripts?.["react-doctor:score"] !== "bash ../scripts/check-react-doctor-score.sh") {
  console.error("ui-dashboard react-doctor:score must delegate to the root score wrapper");
  process.exit(1);
}
NODE
  fail "expected ui-dashboard React Doctor package scripts to use root wrappers"
assert_turbo_task_has_input "react-doctor:diff" "react-doctor.config.json"
assert_turbo_task_has_input "react-doctor:diff" '$TURBO_ROOT$/scripts/check-react-doctor-diff.sh'
assert_turbo_task_lacks_input "react-doctor:diff" '$TURBO_ROOT$/scripts/agent-quality-gate.sh'
assert_turbo_task_lacks_input "react-doctor:diff" '$TURBO_ROOT$/scripts/agent-quality-gate.test.sh'
assert_turbo_task_has_input "react-doctor:diff" '$TURBO_ROOT$/package.json'
assert_turbo_task_has_input "react-doctor:diff" '$TURBO_ROOT$/pnpm-lock.yaml'
assert_turbo_task_has_input "react-doctor:diff" '$TURBO_ROOT$/pnpm-workspace.yaml'
assert_turbo_task_has_input "react-doctor:diff" '$TURBO_ROOT$/.npmrc'
assert_turbo_task_has_input "react-doctor:diff" '$TURBO_ROOT$/.node-version'
assert_turbo_task_has_input "react-doctor:diff" '$TURBO_ROOT$/turbo.json'
assert_turbo_task_has_env "react-doctor:diff" "REACT_DOCTOR_BASE_REF"
assert_turbo_task_has_env "react-doctor:diff" "REACT_DOCTOR_BASE_CACHE_KEY"
assert_turbo_task_has_input "react-doctor:score" "react-doctor.config.json"
assert_turbo_task_has_input "react-doctor:score" '$TURBO_ROOT$/scripts/check-react-doctor-score.sh'
assert_turbo_task_lacks_input "react-doctor:score" '$TURBO_ROOT$/scripts/agent-quality-gate.sh'
assert_turbo_task_lacks_input "react-doctor:score" '$TURBO_ROOT$/scripts/agent-quality-gate.test.sh'
assert_turbo_task_has_input "react-doctor:score" '$TURBO_ROOT$/package.json'
assert_turbo_task_has_input "react-doctor:score" '$TURBO_ROOT$/pnpm-lock.yaml'
assert_turbo_task_has_input "react-doctor:score" '$TURBO_ROOT$/pnpm-workspace.yaml'
assert_turbo_task_has_input "react-doctor:score" '$TURBO_ROOT$/.npmrc'
assert_turbo_task_has_input "react-doctor:score" '$TURBO_ROOT$/.node-version'
assert_turbo_task_has_input "react-doctor:score" '$TURBO_ROOT$/turbo.json'

printf 'scratch\n' > "$untracked_skill_artifact"
node scripts/check-agent-context.mjs > "$output_file"
assert_contains "Agent context check passed"
rm -f "$untracked_skill_artifact"

hook_repo="$(mktemp -d)"
(
  cd "$hook_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  mkdir -p scripts
  cp "$repo_root/scripts/agent-session-end-hook.sh" scripts/
  echo initial > README.md
  git add README.md scripts/agent-session-end-hook.sh
  git commit -qm init
  git reflog expire --expire=now --all
  echo changed >> README.md
  git add README.md
  git commit -qm "commit from session"
  minimal_bin="$(mktemp -d)"
  for tool in awk cat dirname git pwd tr wc; do
    ln -s "$(command -v "$tool")" "$minimal_bin/$tool"
  done
  printf '{"cwd":"%s"}' "$hook_repo" |
    env PATH="$minimal_bin" /bin/bash scripts/agent-session-end-hook.sh > "$output_file" 2>&1
  rm -rf "$minimal_bin"
)
rm -rf "$hook_repo"
assert_contains "Session touched the tree (1 recent commit(s), 0 unstaged file(s))."

hook_noop_repo="$(mktemp -d)"
(
  cd "$hook_noop_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  mkdir -p scripts
  cp "$repo_root/scripts/agent-session-end-hook.sh" scripts/
  echo initial > README.md
  git add README.md scripts/agent-session-end-hook.sh
  git commit -qm init
  git reflog expire --expire=now --all
  printf '{"cwd":"%s"}' "$hook_noop_repo" |
    bash scripts/agent-session-end-hook.sh > "$output_file" 2>&1
)
rm -rf "$hook_noop_repo"
assert_not_contains "Session touched the tree"

validator_repo="$(mktemp -d)"
(
  cd "$validator_repo"
  cat > package.json <<'JSON'
{
  "name": "fixture",
  "scripts": {
    "agent:quality-gate": "true",
    "agent:quality-gate:test": "bash scripts/agent-quality-gate.test.sh",
    "agent:context-check": "node scripts/check-agent-context.mjs",
    "agent:autoreview": "./scripts/agent-autoreview.sh",
    "agent:prewarm": "node scripts/agent-prewarm.mjs",
    "agent:prewarm:test": "node scripts/agent-prewarm.test.mjs",
    "pr:ready-state": "node scripts/pr-ready-state.mjs",
    "pr:ready-state:test": "node scripts/pr-ready-state.test.mjs",
    "lockfile:lint": "node scripts/lockfile-lint.mjs",
    "lockfile:lint:test": "node scripts/lockfile-lint.test.mjs"
  }
}
JSON
  set +e
  bash "$repo_root/scripts/check-agent-quality-gate-package-scripts.sh" > "$output_file" 2>&1
  exit_code=$?
  set -e
  [[ "$exit_code" -ne 0 ]]
)
rm -rf "$validator_repo"
assert_contains 'package.json scripts.agent:quality-gate must be "./scripts/agent-quality-gate.sh"'

run_gate "ui-dashboard/package.json"
assert_contains "- ./tools/trunk check --all (changed paths require full-repo Trunk checks)"
assert_contains "- pnpm install --frozen-lockfile (workspace package manifest changed)"
assert_order \
  "- pnpm install --frozen-lockfile (workspace package manifest changed)" \
  "- pnpm --filter @mento-protocol/ui-dashboard lint (ui-dashboard changed)"
assert_order \
  "- pnpm --filter @mento-protocol/ui-dashboard test (ui-dashboard changed)" \
  "- pnpm --filter @mento-protocol/ui-dashboard exec playwright install chromium (ui-dashboard changed)"
assert_order \
  "- pnpm --filter @mento-protocol/ui-dashboard exec playwright install chromium (ui-dashboard changed)" \
  "- pnpm --filter @mento-protocol/ui-dashboard test:browser (ui-dashboard changed)"

run_gate "metrics-bridge/src/main.ts"
assert_contains "- ./tools/trunk check metrics-bridge/src/main.ts (changed existing paths should pass targeted Trunk checks)"
assert_not_contains "- ./tools/trunk check --all"
assert_contains "- pnpm --filter @mento-protocol/metrics-bridge lint (metrics-bridge changed)"
assert_contains "- pnpm exec turbo run lint --filter=@mento-protocol/metrics-bridge --cache=local:rw (metrics-bridge changed)"
# `assert_contains` normalizes legacy package-task expectations to the Turbo
# command shape; keep a direct negative assertion so the old command cannot be
# emitted alongside the cached one unnoticed.
assert_not_contains "- pnpm --filter @mento-protocol/metrics-bridge lint (metrics-bridge changed)"

run_gate_expect_failure "ui-dashboard/package.json"
assert_contains "Refusing to run because package manifests or lockfile changed."
assert_contains "re-run with --allow-package-script-changes if they are safe."

run_gate_expect_failure "pnpm-lock.yaml"
assert_contains "Refusing to run because package manifests or lockfile changed."
assert_contains "dependency install scripts"

run_gate_expect_failure "pnpm-workspace.yaml"
assert_contains "Refusing to run because package manifests or lockfile changed."
assert_contains "dependency install scripts"

run_gate_expect_failure ".npmrc"
assert_contains "Refusing to run because package manifests or lockfile changed."
assert_contains "dependency install scripts"

run_gate_expect_failure "indexer-envio/.npmrc"
assert_contains "Refusing to run because package manifests or lockfile changed."
assert_contains "dependency install scripts"
assert_contains "- ./tools/trunk check --all (changed paths require full-repo Trunk checks)"

run_gate_expect_failure "pnpmfile.cjs"
assert_contains "Refusing to run because package manifests or lockfile changed."
assert_contains "dependency install scripts"
assert_contains "- ./tools/trunk check --all (changed paths require full-repo Trunk checks)"

run_gate_expect_failure ".pnpmfile.cjs"
assert_contains "Refusing to run because package manifests or lockfile changed."
assert_contains "dependency install scripts"
assert_contains "- ./tools/trunk check --all (changed paths require full-repo Trunk checks)"

run_gate ".npmrc"
assert_contains "- pnpm install --frozen-lockfile (package manager config changed)"
assert_contains "- pnpm --filter @mento-protocol/indexer-envio indexer:bridge-only:codegen (package manager config changed)"
assert_contains "- pnpm --filter @mento-protocol/ui-dashboard typecheck (package manager config changed)"
# Workspace-wide triggers (npmrc, root pkg.json, ci.yml) intentionally do
# NOT run the dashboard playwright suite — chromium --single-process mode
# (required in sandbox) is flaky on keyboard/route-heavy tests, and CI's
# ui-dashboard job runs the full suite anyway. Direct ui-dashboard/*
# changes still trigger it via the per-package dispatch.
assert_not_contains "playwright install chromium (package manager config changed)"
assert_not_contains_mapped "- pnpm --filter @mento-protocol/ui-dashboard test:browser (package manager config changed)"
assert_contains "- bash scripts/check-react-doctor-score.sh (package manager config changed)"
assert_order \
  "- pnpm install --frozen-lockfile (package manager config changed)" \
  "- pnpm --filter @mento-protocol/indexer-envio indexer:bridge-only:codegen (package manager config changed)"
assert_order \
  "- pnpm install --frozen-lockfile (link generated package after indexer codegen)" \
  "- pnpm --filter @mento-protocol/indexer-envio lint (package manager config changed)"

run_gate "package.json"
assert_contains "- bash scripts/agent-quality-gate.test.sh (agent quality gate package script changed)"
assert_contains "- pnpm --filter @mento-protocol/indexer-envio indexer:bridge-only:codegen (workspace dependency/config changed)"
assert_contains "- bash scripts/check-react-doctor-score.sh (workspace dependency/config changed)"
assert_order \
  "- pnpm install --frozen-lockfile (workspace package manifest changed)" \
  "- pnpm --filter @mento-protocol/indexer-envio indexer:bridge-only:codegen (workspace dependency/config changed)"
assert_order \
  "- pnpm install --frozen-lockfile (link generated package after indexer codegen)" \
  "- pnpm --filter @mento-protocol/indexer-envio lint (workspace dependency/config changed)"

package_json_repo="$(mktemp -d)"
(
  cd "$package_json_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  cat > package.json <<'JSON'
{
  "name": "fixture",
  "scripts": {
    "agent:quality-gate": "./scripts/agent-quality-gate.sh",
    "agent:quality-gate:test": "bash scripts/agent-quality-gate.test.sh",
    "agent:context-check": "node scripts/check-agent-context.mjs",
    "agent:autoreview": "./scripts/agent-autoreview.sh",
    "agent:prewarm": "node scripts/agent-prewarm.mjs",
    "agent:prewarm:test": "node scripts/agent-prewarm.test.mjs",
    "pr:ready-state": "node scripts/pr-ready-state.mjs",
    "pr:ready-state:test": "node scripts/pr-ready-state.test.mjs",
    "lockfile:lint": "node scripts/lockfile-lint.mjs",
    "lockfile:lint:test": "node scripts/lockfile-lint.test.mjs"
  }
}
JSON
  git add package.json
  git commit -qm init
  node - <<'NODE'
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.scripts["agent:quality-gate:test"] = "bash scripts/agent-quality-gate.test.sh --fixture";
fs.writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
NODE
  "$repo_root/scripts/agent-quality-gate.sh" --base HEAD > "$output_file"
)
rm -rf "$package_json_repo"
assert_contains "- tooling"
assert_contains "- bash scripts/check-agent-quality-gate-package-scripts.sh (root package tooling script changed)"
assert_contains "- bash scripts/agent-quality-gate.test.sh (root package tooling script changed)"
assert_contains "- node scripts/agent-prewarm.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/pr-ready-state.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/tf-stacks.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/lockfile-lint.test.mjs (root package tooling script changed)"
assert_not_contains "- pnpm agent:quality-gate:test"
assert_not_contains "- pnpm install --frozen-lockfile"
assert_not_contains "- pnpm --filter @mento-protocol/indexer-envio indexer:bridge-only:codegen"
assert_not_contains "- pnpm --filter @mento-protocol/ui-dashboard lint"

lockfile_script_repo="$(mktemp -d)"
(
  cd "$lockfile_script_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  cat > package.json <<'JSON'
{
  "name": "fixture",
  "scripts": {
    "agent:quality-gate": "./scripts/agent-quality-gate.sh",
    "agent:quality-gate:test": "bash scripts/agent-quality-gate.test.sh",
    "agent:context-check": "node scripts/check-agent-context.mjs",
    "agent:autoreview": "./scripts/agent-autoreview.sh",
    "agent:prewarm": "node scripts/agent-prewarm.mjs",
    "agent:prewarm:test": "node scripts/agent-prewarm.test.mjs",
    "pr:ready-state": "node scripts/pr-ready-state.mjs",
    "pr:ready-state:test": "node scripts/pr-ready-state.test.mjs",
    "lockfile:lint": "node scripts/lockfile-lint.mjs",
    "lockfile:lint:test": "node scripts/lockfile-lint.test.mjs"
  }
}
JSON
  git add package.json
  git commit -qm init
  node - <<'NODE'
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.scripts["lockfile:lint:test"] = "node scripts/lockfile-lint.test.mjs --fixture";
fs.writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
NODE
  "$repo_root/scripts/agent-quality-gate.sh" --base HEAD > "$output_file"
)
rm -rf "$lockfile_script_repo"
assert_contains "- tooling"
assert_contains "- bash scripts/check-agent-quality-gate-package-scripts.sh (root package tooling script changed)"
assert_contains "- bash scripts/agent-quality-gate.test.sh (root package tooling script changed)"
assert_contains "- node scripts/agent-prewarm.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/pr-ready-state.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/tf-stacks.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/lockfile-lint.test.mjs (root package tooling script changed)"
assert_not_contains "- pnpm install --frozen-lockfile"
assert_not_contains "- pnpm --filter @mento-protocol/indexer-envio indexer:bridge-only:codegen"
assert_not_contains "- pnpm --filter @mento-protocol/ui-dashboard lint"

pr_ready_state_script_repo="$(mktemp -d)"
(
  cd "$pr_ready_state_script_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  cat > package.json <<'JSON'
{
  "name": "fixture",
  "scripts": {
    "agent:quality-gate": "./scripts/agent-quality-gate.sh",
    "agent:quality-gate:test": "bash scripts/agent-quality-gate.test.sh",
    "agent:context-check": "node scripts/check-agent-context.mjs",
    "agent:autoreview": "./scripts/agent-autoreview.sh",
    "agent:prewarm": "node scripts/agent-prewarm.mjs",
    "agent:prewarm:test": "node scripts/agent-prewarm.test.mjs",
    "pr:ready-state": "node scripts/pr-ready-state.mjs",
    "pr:ready-state:test": "node scripts/pr-ready-state.test.mjs",
    "lockfile:lint": "node scripts/lockfile-lint.mjs",
    "lockfile:lint:test": "node scripts/lockfile-lint.test.mjs"
  }
}
JSON
  git add package.json
  git commit -qm init
  node - <<'NODE'
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.scripts["pr:ready-state:test"] = "node scripts/pr-ready-state.test.mjs --fixture";
fs.writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
NODE
  "$repo_root/scripts/agent-quality-gate.sh" --base HEAD > "$output_file"
)
rm -rf "$pr_ready_state_script_repo"
assert_contains "- tooling"
assert_contains "- bash scripts/check-agent-quality-gate-package-scripts.sh (root package tooling script changed)"
assert_contains "- bash scripts/agent-quality-gate.test.sh (root package tooling script changed)"
assert_contains "- node scripts/agent-prewarm.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/pr-ready-state.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/tf-stacks.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/lockfile-lint.test.mjs (root package tooling script changed)"
assert_not_contains "- pnpm install --frozen-lockfile"
assert_not_contains "- pnpm --filter @mento-protocol/indexer-envio indexer:bridge-only:codegen"
assert_not_contains "- pnpm --filter @mento-protocol/ui-dashboard lint"

package_script_repo="$(mktemp -d)"
(
  cd "$package_script_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  cat > package.json <<'JSON'
{
  "name": "fixture",
  "scripts": {
    "agent:quality-gate": "./scripts/agent-quality-gate.sh",
    "agent:quality-gate:test": "bash scripts/agent-quality-gate.test.sh",
    "agent:context-check": "node scripts/check-agent-context.mjs",
    "postinstall": "node scripts/postinstall.js"
  }
}
JSON
  git add package.json
  git commit -qm init
  node - <<'NODE'
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.scripts.postinstall = "node scripts/postinstall-updated.js";
fs.writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
NODE
  "$repo_root/scripts/agent-quality-gate.sh" --base HEAD > "$output_file"
)
rm -rf "$package_script_repo"
assert_contains "- workspace"
assert_contains "- pnpm install --frozen-lockfile (root package script changed)"
assert_contains "- bash scripts/check-agent-quality-gate-package-scripts.sh (root package script changed)"
assert_contains "- bash scripts/agent-quality-gate.test.sh (root package script changed)"
assert_contains "- pnpm --filter @mento-protocol/ui-dashboard typecheck (root package script changed)"
# Workspace-wide triggers skip the dashboard playwright suite — see the
# matching `assert_not_contains` block above .npmrc for the rationale.
assert_not_contains_mapped "- pnpm --filter @mento-protocol/ui-dashboard test:browser (root package script changed)"
assert_contains "- bash scripts/check-react-doctor-score.sh (root package script changed)"

package_scripts_object_repo="$(mktemp -d)"
(
  cd "$package_scripts_object_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  cat > package.json <<'JSON'
{
  "name": "fixture",
  "scripts": {
    "agent:quality-gate": "./scripts/agent-quality-gate.sh",
    "agent:quality-gate:test": "bash scripts/agent-quality-gate.test.sh",
    "agent:context-check": "node scripts/check-agent-context.mjs",
    "postinstall": "node scripts/postinstall.js"
  }
}
JSON
  git add package.json
  git commit -qm init
  node - <<'NODE'
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
delete pkg.scripts;
fs.writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
NODE
  "$repo_root/scripts/agent-quality-gate.sh" --base HEAD > "$output_file"
)
rm -rf "$package_scripts_object_repo"
assert_contains "- workspace"
assert_contains "- pnpm install --frozen-lockfile (root package script changed)"
assert_contains "- bash scripts/check-agent-quality-gate-package-scripts.sh (root package script changed)"
assert_contains "- bash scripts/agent-quality-gate.test.sh (root package script changed)"
assert_contains "- pnpm --filter @mento-protocol/ui-dashboard typecheck (root package script changed)"
assert_not_contains_mapped "- pnpm --filter @mento-protocol/ui-dashboard test:browser (root package script changed)"

mixed_package_script_repo="$(mktemp -d)"
(
  cd "$mixed_package_script_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  cat > package.json <<'JSON'
{
  "name": "fixture",
  "scripts": {
    "agent:quality-gate": "./scripts/agent-quality-gate.sh",
    "agent:quality-gate:test": "bash scripts/agent-quality-gate.test.sh",
    "agent:context-check": "node scripts/check-agent-context.mjs"
  },
  "dependencies": {
    "left-pad": "1.3.0"
  }
}
JSON
  git add package.json
  git commit -qm init
  node - <<'NODE'
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.scripts["agent:quality-gate"] = "true";
pkg.dependencies["left-pad"] = "1.2.0";
fs.writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
NODE
  "$repo_root/scripts/agent-quality-gate.sh" --base HEAD > "$output_file"
)
rm -rf "$mixed_package_script_repo"
assert_contains "- workspace"
assert_contains "- pnpm install --frozen-lockfile (root package script changed)"
assert_contains "- bash scripts/check-agent-quality-gate-package-scripts.sh (root package script changed)"
assert_contains "- bash scripts/agent-quality-gate.test.sh (root package script changed)"
assert_contains "- pnpm --filter @mento-protocol/ui-dashboard typecheck (root package script changed)"
assert_not_contains_mapped "- pnpm --filter @mento-protocol/ui-dashboard test:browser (root package script changed)"

run_gate "indexer-envio/package.json"
assert_contains "- docs/pr-checklists/stateful-data-ui.md (indexer data flow changed)"
assert_occurrences 1 "- pnpm install --frozen-lockfile (link generated package after indexer codegen)"
assert_order \
  "- pnpm install --frozen-lockfile (workspace package manifest changed)" \
  "- pnpm --filter @mento-protocol/indexer-envio indexer:bridge-only:codegen (indexer schema/source/ABI/package path changed)"
assert_order \
  "- pnpm --filter @mento-protocol/indexer-envio indexer:bridge-only:codegen (indexer schema/source/ABI/package path changed)" \
  "- pnpm indexer:testnet:codegen (indexer schema/source/ABI/package path changed)"
assert_order \
  "- pnpm indexer:testnet:codegen (indexer schema/source/ABI/package path changed)" \
  "- pnpm indexer:codegen (indexer schema/source/ABI/package path changed)"
assert_order \
  "- pnpm indexer:codegen (indexer schema/source/ABI/package path changed)" \
  "- pnpm install --frozen-lockfile (link generated package after indexer codegen)"
assert_order \
  "- pnpm install --frozen-lockfile (link generated package after indexer codegen)" \
  "- pnpm --filter @mento-protocol/indexer-envio lint (indexer-envio changed)"

run_gate "indexer-envio/src/bridge.ts"
assert_contains "- docs/pr-checklists/stateful-data-ui.md (indexer data flow changed)"
assert_contains "- pnpm --filter @mento-protocol/indexer-envio test (indexer-envio changed)"
assert_not_contains "indexer:bridge-only:codegen"
assert_not_contains "indexer:testnet:codegen"
# Mainnet codegen now runs as a preflight for every indexer quality command
# because @typescript-eslint/no-unsafe-* (enabled in PR 4) and `tsc` both
# need .envio/types.d.ts to resolve Envio entity types. Bridge-only and
# testnet variants still only fire for handler-registration changes; mainnet
# is the canonical types source.
assert_contains "- pnpm indexer:codegen (indexer-envio changed (codegen needed before indexer typecheck/lint))"

run_gate "indexer-envio/src/EventHandlers.ts"
assert_order \
  "- pnpm indexer:testnet:codegen (indexer handler registration path changed)" \
  "- pnpm indexer:codegen (indexer handler registration path changed)"
assert_not_contains "- pnpm --filter @mento-protocol/indexer-envio indexer:bridge-only:codegen"

run_gate "indexer-envio/src/EventHandlersBridgeOnly.ts"
assert_order \
  "- pnpm --filter @mento-protocol/indexer-envio indexer:bridge-only:codegen (bridge handler registration path changed)" \
  "- pnpm indexer:codegen (restore full multichain generated package after non-mainnet codegen)"
assert_not_contains "- pnpm indexer:testnet:codegen"

run_gate "indexer-envio/src/handlers/fpmm.ts"
assert_order \
  "- pnpm indexer:testnet:codegen (indexer handler registration path changed)" \
  "- pnpm indexer:codegen (indexer handler registration path changed)"
assert_not_contains "- pnpm --filter @mento-protocol/indexer-envio indexer:bridge-only:codegen"

run_gate "indexer-envio/src/handlers/wormhole/nttManager.ts"
assert_order \
  "- pnpm --filter @mento-protocol/indexer-envio indexer:bridge-only:codegen (bridge handler registration path changed)" \
  "- pnpm indexer:testnet:codegen (indexer handler registration path changed)"
assert_order \
  "- pnpm indexer:testnet:codegen (indexer handler registration path changed)" \
  "- pnpm indexer:codegen (restore full multichain generated package after non-mainnet codegen)"

run_gate "indexer-envio/scripts/run-envio-with-env.mjs"
assert_order \
  "- pnpm --filter @mento-protocol/indexer-envio indexer:bridge-only:codegen (indexer schema/source/ABI/package path changed)" \
  "- pnpm indexer:testnet:codegen (indexer schema/source/ABI/package path changed)"
assert_order \
  "- pnpm indexer:testnet:codegen (indexer schema/source/ABI/package path changed)" \
  "- pnpm indexer:codegen (indexer schema/source/ABI/package path changed)"
assert_order \
  "- pnpm indexer:codegen (indexer schema/source/ABI/package path changed)" \
  "- pnpm install --frozen-lockfile (link generated package after indexer codegen)"

run_gate "indexer-envio/config.multichain.mainnet.yaml" "indexer-envio/src/handlers/fpmm.ts"
assert_not_contains "- pnpm --filter @mento-protocol/indexer-envio indexer:bridge-only:codegen"
assert_contains "- pnpm indexer:testnet:codegen (indexer handler registration path changed)"
assert_contains "- pnpm indexer:codegen (mainnet indexer config changed)"
assert_order \
  "- pnpm indexer:testnet:codegen (indexer handler registration path changed)" \
  "- pnpm indexer:codegen (mainnet indexer config changed)"
assert_order \
  "- pnpm indexer:codegen (mainnet indexer config changed)" \
  "- pnpm install --frozen-lockfile (link generated package after indexer codegen)"

run_gate "indexer-envio/config.multichain.bridge-only.yaml" "indexer-envio/src/bridge.ts"
assert_not_contains "- pnpm indexer:testnet:codegen"
assert_order \
  "- pnpm --filter @mento-protocol/indexer-envio indexer:bridge-only:codegen (bridge-only indexer config changed)" \
  "- pnpm indexer:codegen (restore full multichain generated package after non-mainnet codegen)"
assert_order \
  "- pnpm indexer:codegen (restore full multichain generated package after non-mainnet codegen)" \
  "- pnpm install --frozen-lockfile (link generated package after indexer codegen)"

run_gate "indexer-envio/config.multichain.mainnet.yaml" "indexer-envio/config.multichain.testnet.yaml"
assert_order \
  "- pnpm indexer:testnet:codegen (testnet indexer config changed)" \
  "- pnpm indexer:codegen (mainnet indexer config changed)"
assert_order \
  "- pnpm indexer:codegen (mainnet indexer config changed)" \
  "- pnpm install --frozen-lockfile (link generated package after indexer codegen)"

run_gate "indexer-envio/config.multichain.bridge-only.yaml"
assert_contains "- pnpm --filter @mento-protocol/indexer-envio indexer:bridge-only:codegen (bridge-only indexer config changed)"
assert_contains "- pnpm indexer:codegen (restore full multichain generated package after non-mainnet codegen)"
assert_order \
  "- pnpm --filter @mento-protocol/indexer-envio indexer:bridge-only:codegen (bridge-only indexer config changed)" \
  "- pnpm indexer:codegen (restore full multichain generated package after non-mainnet codegen)"
assert_order \
  "- pnpm indexer:codegen (restore full multichain generated package after non-mainnet codegen)" \
  "- pnpm install --frozen-lockfile (link generated package after indexer codegen)"
assert_order \
  "- pnpm install --frozen-lockfile (link generated package after indexer codegen)" \
  "- pnpm --filter @mento-protocol/indexer-envio lint (indexer-envio changed)"

run_gate "indexer-envio/config/aggregators.json"
assert_contains "- docs/pr-checklists/stateful-data-ui.md (indexer config data flow changed)"
assert_contains "- pnpm --filter @mento-protocol/indexer-envio test (indexer-envio changed)"

run_gate "metrics-bridge/src/graphql.ts"
assert_contains "- docs/pr-checklists/stateful-data-ui.md (metrics bridge data flow changed)"
assert_contains "- docs/pr-checklists/terraform-cloudrun.md (metrics bridge Cloud Run runtime changed)"

run_gate "metrics-bridge/src/poller.ts"
assert_contains "- docs/pr-checklists/stateful-data-ui.md (metrics bridge data flow changed)"
assert_contains "- docs/pr-checklists/terraform-cloudrun.md (metrics bridge Cloud Run runtime changed)"

run_gate "metrics-bridge/src/metrics.ts"
assert_contains "- docs/pr-checklists/stateful-data-ui.md (metrics bridge data flow changed)"
assert_contains "- docs/pr-checklists/terraform-cloudrun.md (metrics bridge Cloud Run runtime changed)"

run_gate "metrics-bridge/src/rpc.ts"
assert_contains "- docs/pr-checklists/terraform-cloudrun.md (metrics bridge Cloud Run runtime changed)"

run_gate "metrics-bridge/src/rebalance-probe.ts"
assert_contains "- docs/pr-checklists/terraform-cloudrun.md (metrics bridge Cloud Run runtime changed)"

run_gate "metrics-bridge/src/rebalance-check.ts"
assert_contains "- docs/pr-checklists/terraform-cloudrun.md (metrics bridge Cloud Run runtime changed)"

run_gate "metrics-bridge/Dockerfile"
assert_contains "- docs/pr-checklists/terraform-cloudrun.md (metrics bridge Cloud Run runtime changed)"

run_gate "metrics-bridge/.dockerignore"
assert_contains "- docs/pr-checklists/terraform-cloudrun.md (metrics bridge Cloud Run runtime changed)"
assert_contains "- pnpm --filter @mento-protocol/metrics-bridge typecheck (metrics-bridge changed)"

run_gate "metrics-bridge/src/main.ts"
assert_contains "- docs/pr-checklists/terraform-cloudrun.md (metrics bridge Cloud Run runtime changed)"

run_gate "metrics-bridge/src/config.ts"
assert_contains "- docs/pr-checklists/terraform-cloudrun.md (metrics bridge Cloud Run runtime changed)"

run_gate "metrics-bridge/src/server.ts"
assert_contains "- docs/pr-checklists/terraform-cloudrun.md (metrics bridge Cloud Run runtime changed)"

run_gate "ui-dashboard/src/lib/gql-retry.ts"
assert_contains "- docs/pr-checklists/swr-polling-hasura.md (Hasura/SWR/query path changed)"
assert_contains "- bash scripts/check-react-doctor-diff.sh origin/test (ui-dashboard client code should keep React Doctor clean)"
assert_contains "- bash scripts/check-react-doctor-score.sh (ui-dashboard React Doctor score should stay 100)"
assert_contains "- pnpm --filter @mento-protocol/ui-dashboard exec playwright install chromium (ui-dashboard changed)"
assert_contains "- pnpm --filter @mento-protocol/ui-dashboard test:browser (ui-dashboard changed)"
assert_contains "- pnpm dashboard:build (ui-dashboard bundle inputs changed)"
assert_contains "- pnpm dashboard:size-limit (ui-dashboard bundle inputs changed)"
assert_occurrences 1 "- pnpm --filter @mento-protocol/ui-dashboard test:browser (ui-dashboard changed)"
assert_occurrences 1 "- pnpm dashboard:build (ui-dashboard bundle inputs changed)"
assert_occurrences 1 "- pnpm dashboard:size-limit (ui-dashboard bundle inputs changed)"

run_gate "ui-dashboard/react-doctor.config.json"
assert_contains "- bash scripts/check-react-doctor-diff.sh origin/test (ui-dashboard client code should keep React Doctor clean)"
assert_contains "- bash scripts/check-react-doctor-score.sh (ui-dashboard React Doctor score should stay 100)"
assert_not_contains_mapped "- pnpm dashboard:build"

run_gate "ui-dashboard/tests/browser/fixtures/hasura-fixture-server.mjs"
assert_contains "- pnpm --filter @mento-protocol/ui-dashboard test:browser (ui-dashboard changed)"
assert_not_contains_mapped "- pnpm dashboard:build"
assert_not_contains_mapped "- pnpm dashboard:size-limit"

run_gate "ui-dashboard/playwright.config.ts"
assert_contains "- pnpm --filter @mento-protocol/ui-dashboard test:browser (ui-dashboard changed)"
assert_not_contains_mapped "- pnpm dashboard:build"
assert_not_contains_mapped "- pnpm dashboard:size-limit"

run_gate "ui-dashboard/postcss.config.mjs"
assert_contains "- pnpm dashboard:build (ui-dashboard bundle inputs changed)"
assert_contains "- pnpm dashboard:size-limit (ui-dashboard bundle inputs changed)"

run_gate "ui-dashboard/next.config.ts"
assert_contains "- pnpm dashboard:build (ui-dashboard bundle inputs changed)"
assert_contains "- pnpm dashboard:size-limit (ui-dashboard bundle inputs changed)"

run_gate "ui-dashboard/sentry.shared.ts"
assert_contains "- pnpm dashboard:build (ui-dashboard bundle inputs changed)"
assert_contains "- pnpm dashboard:size-limit (ui-dashboard bundle inputs changed)"

run_gate "ui-dashboard/src/instrumentation-client.ts"
assert_contains "- pnpm dashboard:build (ui-dashboard bundle inputs changed)"
assert_contains "- pnpm dashboard:size-limit (ui-dashboard bundle inputs changed)"

run_gate "ui-dashboard/src/lib/weekend.ts"
assert_contains "- docs/pr-checklists/mutation-testing.md (dashboard mutation baseline changed)"
assert_contains "- pnpm dashboard:mutation (dashboard mutation baseline changed)"

run_gate "ui-dashboard/src/lib/__tests__/weekend.test.ts"
assert_contains "- docs/pr-checklists/mutation-testing.md (dashboard mutation baseline changed)"
assert_contains "- pnpm dashboard:mutation (dashboard mutation baseline changed)"

run_gate "ui-dashboard/stryker.config.mjs"
assert_contains "- docs/pr-checklists/mutation-testing.md (dashboard mutation baseline changed)"
assert_contains "- pnpm dashboard:mutation (dashboard mutation baseline changed)"

run_gate "ui-dashboard/vitest.mutation.config.ts"
assert_contains "- docs/pr-checklists/mutation-testing.md (dashboard mutation baseline changed)"
assert_contains "- pnpm dashboard:mutation (dashboard mutation baseline changed)"

run_gate "ui-dashboard/src/lib/pool-id.ts"
assert_contains "- docs/pr-checklists/mutation-testing.md (dashboard mutation baseline changed)"
assert_contains "- pnpm dashboard:mutation (dashboard mutation baseline changed)"

run_gate "ui-dashboard/src/lib/__tests__/pool-id.test.ts"
assert_contains "- docs/pr-checklists/mutation-testing.md (dashboard mutation baseline changed)"
assert_contains "- pnpm dashboard:mutation (dashboard mutation baseline changed)"

run_gate "metrics-bridge/stryker.config.mjs"
assert_contains "- docs/pr-checklists/mutation-testing.md (metrics bridge mutation baseline changed)"
assert_contains "- pnpm bridge:mutation (metrics bridge mutation baseline changed)"

run_gate "metrics-bridge/vitest.mutation.config.ts"
assert_contains "- docs/pr-checklists/mutation-testing.md (metrics bridge mutation baseline changed)"
assert_contains "- pnpm bridge:mutation (metrics bridge mutation baseline changed)"

run_gate "metrics-bridge/src/rebalance-probe.ts"
assert_contains "- docs/pr-checklists/mutation-testing.md (metrics bridge mutation baseline changed)"
assert_contains "- pnpm bridge:mutation (metrics bridge mutation baseline changed)"

run_gate "metrics-bridge/test/rebalance-probe.test.ts"
assert_contains "- docs/pr-checklists/mutation-testing.md (metrics bridge mutation baseline changed)"
assert_contains "- pnpm bridge:mutation (metrics bridge mutation baseline changed)"

run_gate "indexer-envio/stryker.config.mjs"
assert_contains "- docs/pr-checklists/mutation-testing.md (indexer mutation baseline changed)"
assert_contains "- pnpm indexer:mutation (indexer mutation baseline changed)"

run_gate "indexer-envio/vitest.mutation.config.ts"
assert_contains "- docs/pr-checklists/mutation-testing.md (indexer mutation baseline changed)"
assert_contains "- pnpm indexer:mutation (indexer mutation baseline changed)"

run_gate "indexer-envio/src/helpers.ts"
assert_contains "- docs/pr-checklists/mutation-testing.md (indexer mutation baseline changed)"
assert_contains "- pnpm indexer:mutation (indexer mutation baseline changed)"

run_gate "indexer-envio/test/code-quality-invariants.test.ts"
assert_contains "- docs/pr-checklists/mutation-testing.md (indexer mutation baseline changed)"
assert_contains "- pnpm indexer:mutation (indexer mutation baseline changed)"

run_gate "ui-dashboard/src/components/breach-history-panel.tsx"
assert_contains "- docs/pr-checklists/swr-polling-hasura.md (Hasura/SWR/query path changed)"

run_gate "ui-dashboard/src/lib/use-roving-tab-index.ts"
assert_contains "- docs/pr-checklists/keyboard-a11y-controlled-widgets.md (controlled dashboard component changed)"

run_gate "ui-dashboard/src/app/pool/[poolId]/_tabs/swaps-tab.tsx"
assert_contains "- docs/pr-checklists/swr-polling-hasura.md (Hasura/SWR/query path changed)"

run_gate "ui-dashboard/src/app/pool/[poolId]/_components/pool-detail-page-client.tsx"
assert_contains "- docs/pr-checklists/swr-polling-hasura.md (Hasura/SWR/query path changed)"

run_gate "ui-dashboard/src/lib/fetch-all-networks.ts"
assert_contains "- docs/pr-checklists/swr-polling-hasura.md (Hasura/SWR/query path changed)"

run_gate "ui-dashboard/src/lib/fetch-json.ts"
assert_contains "- docs/pr-checklists/swr-polling-hasura.md (Hasura/SWR/query path changed)"

run_gate "ui-dashboard/src/lib/network-fetcher/fetch.ts"
assert_contains "- docs/pr-checklists/swr-polling-hasura.md (Hasura/SWR/query path changed)"

run_gate "ui-dashboard/src/lib/queries.ts"
assert_contains "- docs/pr-checklists/swr-polling-hasura.md (Hasura/SWR/query path changed)"

run_gate "ui-dashboard/scripts/vercel-ignore-build.sh"
assert_contains "- bash -n ui-dashboard/scripts/vercel-ignore-build.sh (shell script changed)"
assert_contains "- bash ui-dashboard/scripts/vercel-ignore-build.test.sh (Vercel ignore build script changed)"
assert_not_contains "- pnpm --filter @mento-protocol/ui-dashboard lint"
assert_not_contains_mapped "- pnpm --filter @mento-protocol/ui-dashboard test:browser"

run_gate "terraform/metrics-bridge.tf"
assert_contains "- TF_DATA_DIR=terraform/.terraform-agent-gate terraform -chdir=terraform fmt -check -recursive (Terraform changed)"
assert_contains "- TF_DATA_DIR=terraform/.terraform-agent-gate terraform -chdir=terraform init -backend=false -input=false (Terraform changed)"
assert_contains "- TF_DATA_DIR=terraform/.terraform-agent-gate terraform -chdir=terraform validate -no-color (Terraform changed)"
assert_contains "- docs/pr-checklists/terraform-cloudrun.md (Terraform/Cloud Run path changed)"

run_gate "alerts/rules/rules-fpmms.tf"
assert_contains "- TF_DATA_DIR=alerts/rules/.terraform-agent-gate terraform -chdir=alerts/rules fmt -check -recursive (alerts/rules Terraform changed)"
assert_contains "- TF_DATA_DIR=alerts/rules/.terraform-agent-gate terraform -chdir=alerts/rules init -backend=false -input=false (alerts/rules Terraform changed)"
assert_contains "- TF_DATA_DIR=alerts/rules/.terraform-agent-gate terraform -chdir=alerts/rules validate -no-color (alerts/rules Terraform changed)"

run_gate "alerts/infra/main.tf"
assert_contains "- TF_DATA_DIR=alerts/infra/.terraform-agent-gate terraform -chdir=alerts/infra fmt -check -recursive (alerts/infra Terraform changed)"
assert_contains "- TF_DATA_DIR=alerts/infra/.terraform-agent-gate terraform -chdir=alerts/infra init -backend=false -input=false (alerts/infra Terraform changed)"
assert_contains "- TF_DATA_DIR=alerts/infra/.terraform-agent-gate terraform -chdir=alerts/infra validate -no-color (alerts/infra Terraform changed)"
assert_contains "- docs/pr-checklists/terraform-cloudrun.md (alerts/infra Cloud Function path changed)"

run_gate "alerts/infra/channels/sentry-bridge/main.tf"
assert_contains "- TF_DATA_DIR=alerts/infra/.terraform-agent-gate terraform -chdir=alerts/infra fmt -check -recursive (alerts/infra Terraform changed)"

run_gate "alerts/infra/onchain-event-handler/main.tf"
assert_contains "- TF_DATA_DIR=alerts/infra/.terraform-agent-gate terraform -chdir=alerts/infra fmt -check -recursive (alerts/infra Terraform changed)"
assert_contains "- docs/pr-checklists/terraform-cloudrun.md (alerts/infra Cloud Function path changed)"

run_gate "alerts/infra/onchain-event-handler/src/discord.ts"
assert_contains "- pnpm exec turbo run lint --filter=@mento-protocol/alerts-onchain-event-handler --cache=local:rw (alerts onchain-event-handler changed)"
assert_contains "- pnpm exec turbo run typecheck --filter=@mento-protocol/alerts-onchain-event-handler --cache=local:rw (alerts onchain-event-handler changed)"
assert_contains "- pnpm exec turbo run test --filter=@mento-protocol/alerts-onchain-event-handler --cache=local:rw (alerts onchain-event-handler changed)"

run_gate "alerts/infra/onchain-event-handler/src/safe-abi.json"
assert_contains "- pnpm exec turbo run lint --filter=@mento-protocol/alerts-onchain-event-handler --cache=local:rw (Safe ABI changed (handler imports it))"
assert_contains "- pnpm exec turbo run typecheck --filter=@mento-protocol/alerts-onchain-event-handler --cache=local:rw (Safe ABI changed (handler imports it))"
assert_contains "- pnpm exec turbo run test --filter=@mento-protocol/alerts-onchain-event-handler --cache=local:rw (Safe ABI changed (handler imports it))"
assert_contains "- TF_DATA_DIR=alerts/infra/.terraform-agent-gate terraform -chdir=alerts/infra fmt -check -recursive (Safe ABI changed (listener filter uses it at plan time))"
assert_contains "- TF_DATA_DIR=alerts/infra/.terraform-agent-gate terraform -chdir=alerts/infra init -backend=false -input=false (Safe ABI changed (listener filter uses it at plan time))"
assert_contains "- TF_DATA_DIR=alerts/infra/.terraform-agent-gate terraform -chdir=alerts/infra validate -no-color (Safe ABI changed (listener filter uses it at plan time))"

run_gate ".github/workflows/metrics-bridge.yml"
assert_contains "- docs/pr-checklists/ci-workflow-gates.md (GitHub Actions workflow/action changed)"
assert_contains "- docs/pr-checklists/terraform-cloudrun.md (metrics bridge Cloud Run workflow changed)"
assert_contains "- pnpm agent:context-check (Cloud Run revision suffix guard changed)"

run_gate ".github/workflows/ci.yml"
assert_contains "- docs/pr-checklists/ci-workflow-gates.md (GitHub Actions workflow/action changed)"
assert_contains "- pnpm install --frozen-lockfile (central CI workflow changed)"
assert_contains "- pnpm --filter @mento-protocol/indexer-envio indexer:bridge-only:codegen (central CI workflow changed)"
assert_contains "- pnpm tf:test (Terraform registry-backed CI workflow changed)"
assert_contains "- TF_DATA_DIR=terraform/.terraform-agent-gate terraform -chdir=terraform fmt -check -recursive (Terraform registry-backed CI workflow changed)"
assert_contains "- TF_DATA_DIR=alerts/rules/.terraform-agent-gate terraform -chdir=alerts/rules fmt -check -recursive (Terraform registry-backed CI workflow changed)"
assert_contains "- TF_DATA_DIR=aegis/terraform/.terraform-agent-gate terraform -chdir=aegis/terraform fmt -check -recursive (Terraform registry-backed CI workflow changed)"
# Workspace-wide triggers (ci.yml here) deliberately skip the playwright
# suite — CI runs it in its own ui-dashboard job and the local --single-process
# chromium mode is flaky on keyboard/route-heavy tests.
assert_not_contains "playwright install chromium (central CI workflow changed)"
assert_not_contains_mapped "- pnpm --filter @mento-protocol/ui-dashboard test:browser (central CI workflow changed)"
assert_contains "- bash scripts/check-react-doctor-score.sh (central CI workflow changed)"
assert_order \
  "- pnpm install --frozen-lockfile (central CI workflow changed)" \
  "- pnpm --filter @mento-protocol/indexer-envio indexer:bridge-only:codegen (central CI workflow changed)"
assert_order \
  "- pnpm install --frozen-lockfile (link generated package after indexer codegen)" \
  "- pnpm --filter @mento-protocol/indexer-envio lint (central CI workflow changed)"

run_gate ".github/workflows/infra.yml"
assert_contains "- docs/pr-checklists/ci-workflow-gates.md (GitHub Actions workflow/action changed)"
assert_contains "- pnpm tf:test (Terraform registry workflow changed)"
assert_contains "- TF_DATA_DIR=terraform/.terraform-agent-gate terraform -chdir=terraform fmt -check -recursive (Terraform registry workflow changed)"
assert_contains "- TF_DATA_DIR=alerts/rules/.terraform-agent-gate terraform -chdir=alerts/rules fmt -check -recursive (Terraform registry workflow changed)"
assert_contains "- TF_DATA_DIR=alerts/infra/.terraform-agent-gate terraform -chdir=alerts/infra fmt -check -recursive (Terraform registry workflow changed)"
assert_contains "- TF_DATA_DIR=aegis/terraform/.terraform-agent-gate terraform -chdir=aegis/terraform fmt -check -recursive (Terraform registry workflow changed)"

run_gate ".github/actions/pnpm-install/action.yml"
assert_contains "- docs/pr-checklists/ci-workflow-gates.md (GitHub Actions workflow/action changed)"
assert_contains "- pnpm install --frozen-lockfile (pnpm install action changed)"
assert_contains "- pnpm --filter @mento-protocol/indexer-envio indexer:bridge-only:codegen (pnpm install action changed)"
assert_contains "- bash scripts/check-react-doctor-score.sh (pnpm install action changed)"
assert_order \
  "- pnpm install --frozen-lockfile (pnpm install action changed)" \
  "- pnpm --filter @mento-protocol/indexer-envio indexer:bridge-only:codegen (pnpm install action changed)"
assert_order \
  "- pnpm install --frozen-lockfile (link generated package after indexer codegen)" \
  "- pnpm --filter @mento-protocol/indexer-envio lint (pnpm install action changed)"

run_gate ".gcloudignore"
assert_contains "- docs/pr-checklists/terraform-cloudrun.md (Cloud Build ignore file changed)"
assert_contains "- pnpm --filter @mento-protocol/metrics-bridge typecheck (metrics bridge build context changed)"
assert_contains "- pnpm --filter @mento-protocol/metrics-bridge test (metrics bridge build context changed)"

run_gate "cloudbuild.yaml"
assert_contains "- docs/pr-checklists/terraform-cloudrun.md (Cloud Build config changed)"
assert_contains "- pnpm --filter @mento-protocol/metrics-bridge lint (metrics bridge build context changed)"
assert_contains "- pnpm --filter @mento-protocol/metrics-bridge typecheck (metrics bridge build context changed)"
assert_contains "- pnpm --filter @mento-protocol/metrics-bridge test (metrics bridge build context changed)"

run_gate "shared-config/deployment-namespaces.json"
assert_order \
  "- pnpm --filter @mento-protocol/indexer-envio indexer:bridge-only:codegen (shared-config vendored indexer fixture changed)" \
  "- pnpm indexer:testnet:codegen (shared-config vendored indexer fixture changed)"
assert_order \
  "- pnpm indexer:testnet:codegen (shared-config vendored indexer fixture changed)" \
  "- pnpm indexer:codegen (shared-config vendored indexer fixture changed)"
assert_order \
  "- pnpm indexer:codegen (shared-config vendored indexer fixture changed)" \
  "- pnpm install --frozen-lockfile (link generated package after indexer codegen)"
assert_order \
  "- pnpm install --frozen-lockfile (link generated package after indexer codegen)" \
  "- pnpm --filter @mento-protocol/indexer-envio lint (shared-config vendored indexer fixture changed)"

run_gate "shared-config/fx-calendar.json"
assert_order \
  "- pnpm indexer:codegen (shared-config vendored indexer fixture changed)" \
  "- pnpm install --frozen-lockfile (link generated package after indexer codegen)"
assert_order \
  "- pnpm install --frozen-lockfile (link generated package after indexer codegen)" \
  "- pnpm --filter @mento-protocol/indexer-envio typecheck (shared-config vendored indexer fixture changed)"
assert_contains "- pnpm dashboard:build (shared-config exports feed the dashboard bundle)"
assert_contains "- pnpm dashboard:size-limit (shared-config exports feed the dashboard bundle)"

run_gate "shared-config/src/chains.ts"
assert_contains "- pnpm dashboard:build (shared-config exports feed the dashboard bundle)"
assert_contains "- pnpm dashboard:size-limit (shared-config exports feed the dashboard bundle)"
# The cache key includes shared-config inputs for browser tests, but the local
# gate still does not broaden shared-config-only edits into Playwright runs.
assert_not_contains_mapped "- pnpm --filter @mento-protocol/ui-dashboard test:browser (shared-config exports feed the dashboard bundle)"

run_gate "bootstrap-worktree.sh"
assert_contains "- bash -n bootstrap-worktree.sh (shell script changed)"

run_gate "scripts/deploy-bridge.sh"
assert_contains "- docs/pr-checklists/terraform-cloudrun.md (Cloud Run deploy script changed)"
assert_occurrences 1 "- bash -n scripts/deploy-bridge.sh (shell script changed)"

run_gate "scripts/agent-session-end-hook.sh"
assert_contains "- bash -n scripts/agent-session-end-hook.sh (shell script changed)"
assert_contains "- pnpm agent:context-check (agent SessionEnd hook changed)"

run_gate "scripts/check-react-doctor-diff.sh"
assert_contains "- bash -n scripts/check-react-doctor-diff.sh (shell script changed)"
assert_contains "- pnpm agent:quality-gate:test (agent quality gate mapping changed)"

run_gate "scripts/check-react-doctor-score.sh"
assert_contains "- bash -n scripts/check-react-doctor-score.sh (shell script changed)"
assert_contains "- pnpm agent:quality-gate:test (agent quality gate mapping changed)"

run_gate "scripts/check-agent-quality-gate-package-scripts.sh"
assert_contains "- bash -n scripts/check-agent-quality-gate-package-scripts.sh (shell script changed)"
assert_contains "- bash scripts/check-agent-quality-gate-package-scripts.sh (agent quality gate package script validator changed)"
assert_contains "- pnpm agent:quality-gate:test (agent quality gate mapping changed)"

run_gate ".trunk/trunk.yaml"
assert_contains "- tooling"
assert_contains "- pnpm agent:quality-gate:test (agent quality gate trunk hook changed)"
assert_not_contains "- pnpm --filter @mento-protocol/ui-dashboard typecheck"

run_gate "turbo.json"
assert_contains "- tooling"
assert_contains "- pnpm agent:quality-gate:test (turbo task config changed)"

run_gate "terraform.stacks.json"
assert_contains "- terraform"
assert_contains "- pnpm tf:test (Terraform stack registry changed)"
assert_contains "- TF_DATA_DIR=terraform/.terraform-agent-gate terraform -chdir=terraform fmt -check -recursive (Terraform stack registry changed)"
assert_contains "- TF_DATA_DIR=alerts/rules/.terraform-agent-gate terraform -chdir=alerts/rules fmt -check -recursive (Terraform stack registry changed)"
assert_contains "- TF_DATA_DIR=alerts/infra/.terraform-agent-gate terraform -chdir=alerts/infra fmt -check -recursive (Terraform stack registry changed)"
assert_contains "- TF_DATA_DIR=aegis/terraform/.terraform-agent-gate terraform -chdir=aegis/terraform fmt -check -recursive (Terraform stack registry changed)"

run_gate "scripts/tf-stacks.mjs"
assert_contains "- pnpm tf:test (Terraform stack wrapper changed)"
assert_contains "- TF_DATA_DIR=terraform/.terraform-agent-gate terraform -chdir=terraform fmt -check -recursive (Terraform stack wrapper changed)"
assert_contains "- TF_DATA_DIR=alerts/rules/.terraform-agent-gate terraform -chdir=alerts/rules fmt -check -recursive (Terraform stack wrapper changed)"
assert_contains "- TF_DATA_DIR=alerts/infra/.terraform-agent-gate terraform -chdir=alerts/infra fmt -check -recursive (Terraform stack wrapper changed)"
assert_contains "- TF_DATA_DIR=aegis/terraform/.terraform-agent-gate terraform -chdir=aegis/terraform fmt -check -recursive (Terraform stack wrapper changed)"

fail_fast_repo="$(mktemp -d)"
(
  cd "$fail_fast_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  mkdir -p .trunk
  printf 'version: 0.1\n' > .trunk/trunk.yaml
  git add .
  git commit -qm init
  printf 'version: 0.2\n' > .trunk/trunk.yaml
  set +e
  "$repo_root/scripts/agent-quality-gate.sh" --base HEAD --run --fail-fast > "$output_file" 2>&1
  exit_code=$?
  set -e
  [[ "$exit_code" -ne 0 ]]
)
rm -rf "$fail_fast_repo"
assert_contains "+ ./tools/trunk check --all"
assert_contains "Stopping after first failed mapped command (--fail-fast)."
assert_contains "Command elapsed-time summary:"
assert_contains "- fail "
assert_not_contains "+ pnpm agent:quality-gate:test"

quiet_success_repo="$(mktemp -d)"
(
  cd "$quiet_success_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  printf 'fixture\n' > README.md
  mkdir -p tools
  cat > tools/trunk <<'STUB'
#!/usr/bin/env bash
echo "[RPC_FAILURE] expected fixture failure that should stay quiet"
echo "successful command noise that should stay quiet"
STUB
  chmod +x tools/trunk
  git add .
  git commit -qm init
  printf 'changed\n' >> README.md
  "$repo_root/scripts/agent-quality-gate.sh" --base HEAD --run > "$output_file" 2>&1
)
rm -rf "$quiet_success_repo"
assert_contains "+ ./tools/trunk check README.md"
assert_contains "Command elapsed-time summary:"
assert_contains "- ok "
assert_not_contains "expected fixture failure that should stay quiet"
assert_not_contains "successful command noise that should stay quiet"

fresh_stamp_repo="$(mktemp -d)"
(
  cd "$fresh_stamp_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  printf 'fixture\n' > README.md
  mkdir -p tools
  cat > tools/trunk <<'STUB'
#!/usr/bin/env bash
counter_file="${COUNTER_FILE:?}"
count=0
if [[ -f "$counter_file" ]]; then
  count="$(cat "$counter_file")"
fi
count=$((count + 1))
printf '%s\n' "$count" > "$counter_file"
STUB
  chmod +x tools/trunk
  git add .
  git commit -qm init
  base_ref="$(git rev-parse --verify HEAD)"
  printf 'changed\n' >> README.md
  COUNTER_FILE="$fresh_stamp_repo/.tmp/agent-quality-gate/trunk-count" \
    "$repo_root/scripts/agent-quality-gate.sh" --base "$base_ref" --run > "$output_file" 2>&1
  git add README.md
  git commit -qm "commit validated content"
  COUNTER_FILE="$fresh_stamp_repo/.tmp/agent-quality-gate/trunk-count" \
    "$repo_root/scripts/agent-quality-gate.sh" --base "$base_ref" --run --skip-if-fresh >> "$output_file" 2>&1
  [[ "$(cat "$fresh_stamp_repo/.tmp/agent-quality-gate/trunk-count")" == "1" ]] ||
    fail "fresh gate stamp did not skip duplicate run"
)
rm -rf "$fresh_stamp_repo"
assert_contains "Previous successful agent quality gate run is still fresh; skipping mapped commands."

stale_stamp_repo="$(mktemp -d)"
(
  cd "$stale_stamp_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  printf 'fixture\n' > README.md
  mkdir -p tools
  cat > tools/trunk <<'STUB'
#!/usr/bin/env bash
counter_file="${COUNTER_FILE:?}"
count=0
if [[ -f "$counter_file" ]]; then
  count="$(cat "$counter_file")"
fi
count=$((count + 1))
printf '%s\n' "$count" > "$counter_file"
STUB
  chmod +x tools/trunk
  git add .
  git commit -qm init
  base_ref="$(git rev-parse --verify HEAD)"
  printf 'changed\n' >> README.md
  COUNTER_FILE="$stale_stamp_repo/.tmp/agent-quality-gate/trunk-count" \
    "$repo_root/scripts/agent-quality-gate.sh" --base "$base_ref" --run > "$output_file" 2>&1
  printf 'changed again\n' >> README.md
  COUNTER_FILE="$stale_stamp_repo/.tmp/agent-quality-gate/trunk-count" \
    "$repo_root/scripts/agent-quality-gate.sh" --base "$base_ref" --run --skip-if-fresh >> "$output_file" 2>&1
  [[ "$(cat "$stale_stamp_repo/.tmp/agent-quality-gate/trunk-count")" == "2" ]] ||
    fail "fresh gate stamp was reused after worktree content changed"
)
rm -rf "$stale_stamp_repo"
assert_not_contains "Previous successful agent quality gate run is still fresh; skipping mapped commands."

sha256sum_repo="$(mktemp -d)"
(
  cd "$sha256sum_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  printf 'fixture\n' > README.md
  mkdir -p bin tools
  cat > bin/sha256sum <<'STUB'
#!/usr/bin/env bash
counter_file="${SHA256SUM_COUNTER_FILE:?}"
count=0
if [[ -f "$counter_file" ]]; then
  count="$(cat "$counter_file")"
fi
count=$((count + 1))
printf '%s\n' "$count" > "$counter_file"
if [[ "$#" -eq 0 ]]; then
  cat >/dev/null
fi
printf 'fixturehash  %s\n' "${1:--}"
STUB
  cat > tools/trunk <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  chmod +x bin/sha256sum tools/trunk
  git add .
  git commit -qm init
  printf 'changed\n' >> README.md
  SHA256SUM_COUNTER_FILE="$sha256sum_repo/sha256sum-count" \
    PATH="$sha256sum_repo/bin:$PATH" \
    "$repo_root/scripts/agent-quality-gate.sh" --base HEAD --run > "$output_file" 2>&1
  [[ -s "$sha256sum_repo/sha256sum-count" ]] ||
    fail "gate did not use sha256sum when it was available"
)
rm -rf "$sha256sum_repo"
assert_contains "+ ./tools/trunk check README.md"

quiet_failure_repo="$(mktemp -d)"
(
  cd "$quiet_failure_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  printf 'fixture\n' > README.md
  mkdir -p tools
  cat > tools/trunk <<'STUB'
#!/usr/bin/env bash
echo "[RPC_FAILURE] expected fixture failure that should be filtered"
echo "real failure line"
exit 1
STUB
  chmod +x tools/trunk
  git add .
  git commit -qm init
  printf 'changed\n' >> README.md
  set +e
  "$repo_root/scripts/agent-quality-gate.sh" --base HEAD --run --fail-fast > "$output_file" 2>&1
  exit_code=$?
  set -e
  [[ "$exit_code" -ne 0 ]]
)
rm -rf "$quiet_failure_repo"
assert_contains "Command failed after"
assert_contains "real failure line"
assert_contains "Command elapsed-time summary:"
assert_not_contains "expected fixture failure that should be filtered"

quiet_stack_repo="$(mktemp -d)"
(
  cd "$quiet_stack_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  printf 'fixture\n' > README.md
  mkdir -p tools
  cat > tools/trunk <<'STUB'
#!/usr/bin/env bash
echo "[address-labels] expected API failure"
echo "Command failed at step 3"
echo "    at Object.fixture (/tmp/fixture.js:1:1)"
exit 1
STUB
  chmod +x tools/trunk
  git add .
  git commit -qm init
  printf 'changed\n' >> README.md
  set +e
  "$repo_root/scripts/agent-quality-gate.sh" --base HEAD --run --fail-fast > "$output_file" 2>&1
  exit_code=$?
  set -e
  [[ "$exit_code" -ne 0 ]]
)
rm -rf "$quiet_stack_repo"
assert_contains "Command failed at step 3"
assert_not_contains "[address-labels] expected API failure"
assert_not_contains "Object.fixture"

react_doctor_repo="$(mktemp -d)"
(
  cd "$react_doctor_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  printf 'fixture\n' > README.md
  git add README.md
  git commit -qm init
  original_head="$(git rev-parse --verify HEAD)"
  mkdir -p bin scripts
  cp "$repo_root/scripts/check-react-doctor-diff.sh" scripts/check-react-doctor-diff.sh
  cat > bin/pnpm <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$PNPM_ARGS_FILE"
STUB
  chmod +x bin/pnpm
  git switch --detach HEAD >/dev/null 2>&1
  PNPM_ARGS_FILE="$output_file.pnpm-args" PATH="$PWD/bin:$PATH" bash scripts/check-react-doctor-diff.sh origin/test
  [[ "$(git rev-parse --abbrev-ref HEAD)" == "HEAD" ]] ||
    fail "React Doctor diff helper did not restore detached HEAD"
  [[ "$(git rev-parse --verify HEAD)" == "$original_head" ]] ||
    fail "React Doctor diff helper did not restore original commit"
  [[ -z "$(git for-each-ref --format='%(refname:short)' refs/heads/__react_doctor_scan*)" ]] ||
    fail "React Doctor diff helper left a temporary branch behind"
  grep -Fxq -- "--diff" "$output_file.pnpm-args" ||
    fail "React Doctor diff helper did not forward --diff"
  grep -Fxq -- "origin/test" "$output_file.pnpm-args" ||
    fail "React Doctor diff helper did not forward the base ref"
)
rm -rf "$react_doctor_repo"

rename_repo="$(mktemp -d)"
(
  cd "$rename_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  mkdir -p scripts
  printf '#!/usr/bin/env bash\n' > scripts/deploy-bridge.sh
  git add .
  git commit -qm init
  git mv scripts/deploy-bridge.sh docs.md
  "$repo_root/scripts/agent-quality-gate.sh" --base HEAD > "$output_file"
)
rm -rf "$rename_repo"
assert_contains "- docs/pr-checklists/terraform-cloudrun.md (Cloud Run deploy script changed)"

rename_repo="$(mktemp -d)"
(
  cd "$rename_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  mkdir -p .github/workflows
  printf 'name: Metrics Bridge\n' > .github/workflows/metrics-bridge.yml
  git add .
  git commit -qm init
  git mv .github/workflows/metrics-bridge.yml docs.md
  "$repo_root/scripts/agent-quality-gate.sh" --base HEAD > "$output_file"
)
rm -rf "$rename_repo"
assert_contains "- docs/pr-checklists/ci-workflow-gates.md (GitHub Actions workflow/action changed)"
assert_contains "- docs/pr-checklists/terraform-cloudrun.md (metrics bridge Cloud Run workflow changed)"
assert_contains "- pnpm agent:context-check (Cloud Run revision suffix guard changed)"

rename_repo="$(mktemp -d)"
(
  cd "$rename_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  mkdir -p indexer-envio/src/rpc
  printf 'module.exports = {}\n' > pnpmfile.cjs
  printf 'export {}\n' > indexer-envio/src/rpc/client.ts
  git add .
  git commit -qm init
  git mv pnpmfile.cjs docs.md
  printf 'export const changed = true;\n' >> indexer-envio/src/rpc/client.ts
  set +e
  AGENT_QUALITY_ALLOW_PACKAGE_SCRIPT_CHANGES=false \
    "$repo_root/scripts/agent-quality-gate.sh" --base HEAD --run > "$output_file" 2>&1
  exit_code=$?
  set -e
  [[ "$exit_code" -ne 0 ]]
)
rm -rf "$rename_repo"
assert_contains "Refusing to run because package manifests or lockfile changed."
assert_contains "dependency install scripts"

scripts/agent-quality-gate.sh \
  --changed-paths-file <(printf '%s\n' "docs/deployment.md") \
  --base origin/test \
  > "$output_file"
assert_contains "- docs"
assert_contains "- ./tools/trunk check docs/deployment.md (changed existing paths should pass targeted Trunk checks)"
assert_not_contains "- ./tools/trunk check --all"

run_gate "docs/deployment.md"
assert_contains "Detected surfaces:"
assert_contains "- docs"
assert_contains "- ./tools/trunk check docs/deployment.md (changed existing paths should pass targeted Trunk checks)"
assert_not_contains "- ./tools/trunk check --all"

run_gate "docs/pr-checklists/recurring-review-patterns.md"
assert_contains "- docs"
assert_contains "- pnpm agent:context-check (agent context standards changed)"

run_gate ".codex/hooks.json"
assert_contains "- agent-context"
assert_contains "- pnpm agent:context-check (agent context files changed)"

: > .codex/hooks.json
run_context_check_expect_failure
assert_contains ".codex/hooks.json: invalid JSON"
restore_hook_configs

node - <<'NODE'
const fs = require("node:fs");
const hooks = JSON.parse(fs.readFileSync(".codex/hooks.json", "utf8"));
hooks.hooks.SessionEnd[0].hooks[0].command =
  "bash -lc 'echo git rev-parse --show-toplevel && echo scripts/agent-session-end-hook.sh'";
fs.writeFileSync(".codex/hooks.json", `${JSON.stringify(hooks, null, 2)}\n`);
NODE
run_context_check_expect_failure
assert_contains ".codex/hooks.json: expected SessionEnd command to execute scripts/agent-session-end-hook.sh via resolved repo root"
restore_hook_configs

run_gate ".claude/settings.json"
assert_contains "- agent-context"
assert_contains "- pnpm agent:context-check (agent context files changed)"

: > .claude/settings.json
run_context_check_expect_failure
assert_contains ".claude/settings.json: invalid JSON"
restore_hook_configs

node - <<'NODE'
const fs = require("node:fs");
const settings = JSON.parse(fs.readFileSync(".claude/settings.json", "utf8"));
settings.hooks.SessionEnd[0].hooks[0].command =
  "echo ${CLAUDE_PROJECT_DIR}/scripts/agent-session-end-hook.sh";
fs.writeFileSync(".claude/settings.json", `${JSON.stringify(settings, null, 2)}\n`);
NODE
run_context_check_expect_failure
assert_contains '.claude/settings.json: expected SessionEnd command to execute quoted ${CLAUDE_PROJECT_DIR}/scripts/agent-session-end-hook.sh with bash'
restore_hook_configs

run_gate "docs/deleted.md"
assert_contains "- docs"
assert_contains "- ./tools/trunk check --all (changed paths require full-repo Trunk checks)"
assert_not_contains "- ./tools/trunk check docs/deleted.md"

# Code-health routing: ensure a `.dependency-cruiser.cjs` change schedules
# the cross-package dep-cruiser gate + surfaces the code-health checklist.
run_gate ".dependency-cruiser.cjs"
assert_contains "- tooling"
assert_contains "- pnpm code-health:deps (dep-cruiser config changed (cross-package boundaries + cycles))"
assert_contains "- docs/pr-checklists/code-health.md (dep-cruiser config changed)"

# Code-health routing: each package's knip.json routes to the matching
# `pnpm --filter <pkg> knip` command + the same checklist. A typo in the
# case branch (e.g. swapping package names) would silently misroute the
# gate, so test all four packages.
run_gate "shared-config/knip.json"
assert_contains "- pnpm --filter @mento-protocol/monitoring-config knip (knip config changed)"
assert_contains "- docs/pr-checklists/code-health.md (knip config changed)"

run_gate "ui-dashboard/knip.json"
assert_contains "- pnpm --filter @mento-protocol/ui-dashboard knip (knip config changed)"
assert_contains "- docs/pr-checklists/code-health.md (knip config changed)"

run_gate "indexer-envio/knip.json"
assert_contains "- pnpm --filter @mento-protocol/indexer-envio knip (knip config changed)"
assert_contains "- docs/pr-checklists/code-health.md (knip config changed)"

run_gate "metrics-bridge/knip.json"
assert_contains "- pnpm --filter @mento-protocol/metrics-bridge knip (knip config changed)"
assert_contains "- docs/pr-checklists/code-health.md (knip config changed)"

# Root-script routing: ESLint baseline wrapper changes must re-run every
# package's lint, run the wrapper's own semantic tests, AND lint the
# wrapper itself. A regression here would mask all per-package baseline
# drift.
run_gate "scripts/eslint-baseline-diff.mjs"
assert_contains "- pnpm lint:scripts (root build script changed)"
assert_contains "- node scripts/eslint-baseline-diff.test.mjs (ESLint baseline wrapper changed)"
assert_contains "- pnpm --filter @mento-protocol/monitoring-config lint (ESLint baseline wrapper changed)"
assert_contains "- pnpm --filter @mento-protocol/ui-dashboard lint (ESLint baseline wrapper changed)"
assert_contains "- pnpm --filter @mento-protocol/indexer-envio lint (ESLint baseline wrapper changed)"
assert_contains "- pnpm --filter @mento-protocol/metrics-bridge lint (ESLint baseline wrapper changed)"

# Editing the test file itself should also run the test.
run_gate "scripts/eslint-baseline-diff.test.mjs"
assert_contains "- node scripts/eslint-baseline-diff.test.mjs (ESLint baseline wrapper test changed)"

run_gate "scripts/lockfile-lint.mjs"
assert_contains "- pnpm lockfile:lint:test (lockfile lint helper changed)"

run_gate "scripts/lockfile-lint.test.mjs"
assert_contains "- pnpm lockfile:lint:test (lockfile lint helper changed)"

# Other root-script changes only need the standalone scripts ESLint.
run_gate "scripts/code-health-history.mjs"
assert_contains "- pnpm lint:scripts (root build script changed)"
assert_not_contains "(ESLint baseline wrapper changed)"

# Root ESLint config changes trigger scripts lint.
run_gate "eslint.config.mjs"
assert_contains "- pnpm lint:scripts (root build script changed)"

echo "agent quality gate tests passed"
