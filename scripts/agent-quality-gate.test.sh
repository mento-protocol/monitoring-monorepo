#!/usr/bin/env bash
# Single-quoted strings below are literal substrings asserted against
# scripts/agent-quality-gate.sh's source text (e.g. turbo's `$TURBO_ROOT$`
# token, `"$(...)"` snippets); expanding them would break the assertions
# they're meant to check for.
# Trade-off (accepted): this disables SC2016 file-wide, so a future
# genuinely-unexpanded `$var` typo in this file won't be flagged.
# shellcheck disable=SC2016
set -euo pipefail

# A set -e abort outside fail() would otherwise die with no message at all —
# which is exactly how a CI-only failure stays undiagnosable. Name the dying
# command on stdout (some CI captures drop stderr).
trap 'echo "agent-quality-gate test suite aborted: line $LINENO: $BASH_COMMAND (exit $?)"' ERR

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

paths_file="$(mktemp)"
output_file="$(mktemp)"
gate_cache_dir="$(mktemp -d)"
turbo_facts_file="$(mktemp)"
codex_hooks_backup="$(mktemp)"
claude_settings_backup="$(mktemp)"
codex_hooks_fixture="$(mktemp)"
claude_settings_fixture="$(mktemp)"
untracked_skill_artifact=".claude/skills/.agent-quality-gate-test.tmp"
cp .codex/hooks.json "$codex_hooks_backup"
cp .claude/settings.json "$claude_settings_backup"
cp "$codex_hooks_backup" "$codex_hooks_fixture"
cp "$claude_settings_backup" "$claude_settings_fixture"

restore_hook_configs() {
  cp "$codex_hooks_backup" "$codex_hooks_fixture"
  cp "$claude_settings_backup" "$claude_settings_fixture"
}

trap 'restore_hook_configs; rm -rf "$gate_cache_dir"; rm -f "$paths_file" "$output_file" "$turbo_facts_file" "$output_file.pnpm-args" "$untracked_skill_artifact" "$codex_hooks_backup" "$claude_settings_backup" "$codex_hooks_fixture" "$claude_settings_fixture"' EXIT

fail() {
  # Stdout AND stderr: some CI log captures drop the suite's stderr, which
  # left failures reported only as a bare nonzero exit.
  {
    echo "agent-quality-gate test failed: $*"
    echo
    echo "Last gate output:"
    sed 's/^/  /' "$output_file"
  } | tee /dev/stderr
  exit 1
}

run_gate() {
  : > "$paths_file"
  local path
  for path in "$@"; do
    printf '%s\n' "$path" >> "$paths_file"
  done

  local cache_key
  local cache_output_file
  local cache_paths_file
  cache_key="$(run_gate_cache_key "$@")"
  cache_output_file="$gate_cache_dir/$cache_key.output"
  cache_paths_file="$gate_cache_dir/$cache_key.paths"
  if [[ -f "$cache_output_file" && -f "$cache_paths_file" ]] &&
    cmp -s "$paths_file" "$cache_paths_file"; then
    cp "$cache_output_file" "$output_file"
    return
  fi

  AGENT_QUALITY_ALLOW_PACKAGE_SCRIPT_CHANGES=false \
    scripts/agent-quality-gate.sh \
    --changed-paths-file "$paths_file" \
    --base origin/test \
    > "$output_file"

  cp "$paths_file" "$cache_paths_file"
  cp "$output_file" "$cache_output_file"
}

run_gate_cache_key() {
  local path
  {
    printf 'base=%s\n' "origin/test"
    printf 'repoState=%s\n' "$(run_gate_repo_state_key)"
    for path in "$@"; do
      printf 'path=%s\n' "$path"
    done
  } | cksum | awk '{ print $1 "-" $2 }'
}

run_gate_repo_state_key() {
  {
    git diff --no-ext-diff --binary
    git diff --cached --no-ext-diff --binary
    git ls-files --others --exclude-standard |
      while IFS= read -r path; do
        printf 'untracked=%s\n' "$path"
        if [[ -f "$path" ]]; then
          cksum "./$path"
        fi
      done
  } | cksum | awk '{ print $1 "-" $2 }'
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
  if grep -Fq -- "$expected" "$output_file"; then
    return
  fi
  if [[ -n "$(turbo_filter_line_number "$expected")" ]]; then
    return
  fi
  fail "expected output to contain: $expected"
}

assert_raw_contains() {
  local expected="$1"
  if grep -Fq -- "$expected" "$output_file"; then
    return
  fi
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
  NODE_ENV=test \
    AGENT_CONTEXT_CODEX_HOOKS_FILE="$codex_hooks_fixture" \
    AGENT_CONTEXT_CLAUDE_SETTINGS_FILE="$claude_settings_fixture" \
    node scripts/check-agent-context.mjs > "$output_file" 2>&1
  local exit_code=$?
  set -e

  [[ "$exit_code" -ne 0 ]] ||
    fail "expected agent context check to fail, but it exited 0"
}

append_claude_allow() {
  AGENT_CONTEXT_CLAUDE_SETTINGS_FILE="$claude_settings_fixture" node - "$1" <<'NODE'
const fs = require("node:fs");
const permission = process.argv[2];
const file = process.env.AGENT_CONTEXT_CLAUDE_SETTINGS_FILE;
const settings = JSON.parse(fs.readFileSync(file, "utf8"));
settings.permissions = settings.permissions || {};
settings.permissions.allow = Array.isArray(settings.permissions.allow)
  ? settings.permissions.allow
  : [];
settings.permissions.allow.push(permission);
fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
NODE
}

line_number() {
  local needle="$1"
  local turbo_line
  needle="$(normalize_expected_command "$needle")"
  if grep -Fq -- "$needle" "$output_file"; then
    grep -nF -- "$needle" "$output_file" | head -n 1 | cut -d: -f1
    return
  fi
  turbo_line="$(turbo_filter_line_number "$needle")"
  if [[ -n "$turbo_line" ]]; then
    echo "$turbo_line"
  fi
}

turbo_filter_line_number() {
  local normalized="$1"
  local rest
  local task_name
  local package_name
  local reason=""

  case "$normalized" in
    "- pnpm exec turbo run "*" --filter=@mento-protocol/"*" --cache=local:rw"*)
      rest="${normalized#- pnpm exec turbo run }"
      task_name="${rest%% *}"
      rest="${normalized#* --filter=}"
      package_name="${rest%% *}"
      if [[ "$normalized" == *" ("*")" ]]; then
        reason="${normalized#* (}"
        reason="${reason%)}"
      fi
      awk \
        -v task="$task_name" \
        -v package_filter="--filter=${package_name}" \
        -v reason="$reason" \
        'index($0, "- pnpm exec turbo run " task " ") && index($0, package_filter " ") && index($0, " --cache=local:rw") && (reason == "" || index($0, reason)) { print NR; exit }' \
        "$output_file"
      ;;
  esac
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
      expected="${expected/pnpm dashboard:size-limit/VERCEL_DEPLOYMENT_ID=local-quality-gate pnpm exec turbo run size-limit --filter=@mento-protocol/ui-dashboard --cache=local:rw}"
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
      task_name="${expected#*pnpm --filter "${package_name}" }"
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

  grep -Fxq -- "input	${task_name}	${expected_input}" "$turbo_facts_file" ||
    fail "expected turbo task $task_name to include input: $expected_input"
}

assert_turbo_task_lacks_input() {
  local task_name="$1"
  local unexpected_input="$2"

  ! grep -Fxq -- "input	${task_name}	${unexpected_input}" "$turbo_facts_file" ||
    fail "expected turbo task $task_name not to include input: $unexpected_input"
}

assert_turbo_task_has_env() {
  local task_name="$1"
  local expected_env="$2"

  grep -Fxq -- "env	${task_name}	${expected_env}" "$turbo_facts_file" ||
    fail "expected turbo task $task_name to include env: $expected_env"
}

assert_turbo_task_has_output() {
  local task_name="$1"
  local expected_output="$2"

  grep -Fxq -- "output	${task_name}	${expected_output}" "$turbo_facts_file" ||
    fail "expected turbo task $task_name to include output: $expected_output"
}

assert_turbo_task_depends_on() {
  local task_name="$1"
  local expected_dependency="$2"

  grep -Fxq -- "dependsOn	${task_name}	${expected_dependency}" "$turbo_facts_file" ||
    fail "expected turbo task $task_name to depend on: $expected_dependency"
}

assert_turbo_task_absent() {
  local task_name="$1"

  ! grep -Fxq -- "task	${task_name}" "$turbo_facts_file" ||
    fail "expected turbo task to be absent: $task_name"
}

write_turbo_facts() {
  node - <<'NODE' > "$turbo_facts_file"
const fs = require("node:fs");
const config = JSON.parse(fs.readFileSync("turbo.json", "utf8"));
for (const [taskName, taskConfig] of Object.entries(config.tasks ?? {})) {
  console.log(`task\t${taskName}`);
  for (const input of taskConfig.inputs ?? []) {
    console.log(`input\t${taskName}\t${input}`);
  }
  for (const env of taskConfig.env ?? []) {
    console.log(`env\t${taskName}\t${env}`);
  }
  for (const output of taskConfig.outputs ?? []) {
    console.log(`output\t${taskName}\t${output}`);
  }
  for (const dependency of taskConfig.dependsOn ?? []) {
    console.log(`dependsOn\t${taskName}\t${dependency}`);
  }
}
NODE
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
assert_script_occurrences 1 'Avoid overriding a usable TMPDIR'
assert_script_occurrences 1 'tmpdir_candidate="${TMPDIR:-${TMP:-${TEMP:-/tmp}}}"'
assert_script_occurrences 1 "command -v sha256sum"
assert_script_occurrences 1 "command -v shasum"
assert_script_occurrences 0 "shasum -a 256 | awk"
assert_script_occurrences 0 'shasum -a 256 "$1"'

write_turbo_facts

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
assert_turbo_task_has_env "build" "VERCEL_DEPLOYMENT_ID"
assert_turbo_task_has_env "build" "VERCEL_GIT_COMMIT_SHA"
assert_turbo_task_has_output "build" ".next/**"
assert_turbo_task_has_output "build" "!.next/cache/**"
assert_turbo_task_has_output "build" "!.next/dev/**"
assert_turbo_task_has_input "size-limit" ".next/**"
assert_turbo_task_has_input "size-limit" "!.next/cache/**"
assert_turbo_task_has_input "size-limit" "!.next/dev/**"
assert_turbo_task_depends_on "size-limit" "build"
node - <<'NODE' ||
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const config = require("./ui-dashboard/.size-limit.cjs");
const {
  collectManifestReferencedStaticAssets,
  manifestPathsOrFallback,
} = config._private;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "size-limit-manifest-"));
const originalCwd = process.cwd();
const originalStderrWrite = process.stderr.write;

function write(relativePath, contents = "") {
  const absolutePath = path.join(tmp, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, contents);
}

try {
  write(".next/static/chunks/client.js", 'import("/_next/static/chunks/transitive.js");');
  write(".next/static/chunks/current.js");
  write(".next/static/chunks/dotted..js");
  write(".next/static/chunks/transitive.js", 'import("/_next/static/chunks/client.js");');
  write(".next/static/chunks/current.css");
  write(".next/static/chunks/stale.js");
  write(".next/static/chunks/stale.css");
  write(".next/static/build-id/_buildManifest.js");
  write(
    ".next/build-manifest.json",
    JSON.stringify({
      lowPriorityFiles: ["static/build-id/_buildManifest.js"],
      rootMainFiles: ["static/chunks/current.js", "static/chunks/dotted..js"],
    }),
  );
  write(
    ".next/server/app/page/page_client-reference-manifest.js",
    'globalThis.__RSC_MANIFEST["/page"] = {"entryCSSFiles":{"layout":[{"path":"static/chunks/current.css"}]},"entryJSFiles":{"layout":["/_next/static/chunks/client.js"]}};',
  );

  assert.deepEqual(
    collectManifestReferencedStaticAssets({
      cwd: tmp,
      extension: ".js",
      prefixes: ["static/chunks/"],
    }),
    [
      ".next/static/chunks/client.js",
      ".next/static/chunks/current.js",
      ".next/static/chunks/dotted..js",
      ".next/static/chunks/transitive.js",
    ],
  );
  assert.deepEqual(
    collectManifestReferencedStaticAssets({
      cwd: tmp,
      extension: ".css",
      prefixes: ["static/"],
    }),
    [".next/static/chunks/current.css"],
  );

  const warnings = [];
  process.chdir(tmp);
  process.stderr.write = (chunk) => {
    warnings.push(String(chunk));
    return true;
  };
  assert.deepEqual(
    manifestPathsOrFallback(".woff2", ["static/"], ".next/static/**/*.woff2"),
    [".next/static/**/*.woff2"],
  );
  assert.match(
    warnings.join(""),
    /manifests found but no \.woff2 assets extracted/,
  );
} finally {
  process.chdir(originalCwd);
  process.stderr.write = originalStderrWrite;
  fs.rmSync(tmp, { recursive: true, force: true });
}
NODE
  fail "expected size-limit config to ignore stale static chunks"
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
assert_turbo_task_has_env "test:browser" "PLAYWRIGHT_NEXT_COMMAND"
assert_turbo_task_has_env "test:browser" "PLAYWRIGHT_NEXT_TIMEOUT_MS"
assert_turbo_task_has_env "test:browser" "PLAYWRIGHT_FORCE_SINGLE_PROCESS"
assert_turbo_task_has_env "test:browser" "PLAYWRIGHT_REUSE_FIXTURE_SERVER"
assert_turbo_task_has_env "test:browser" "CI"
assert_turbo_task_has_env "test:browser" "NEXT_TELEMETRY_DISABLED"
assert_turbo_task_has_env "test:browser" "NEXT_PUBLIC_HASURA_URL"
assert_turbo_task_has_env "test:browser" "NEXT_PUBLIC_BROWSER_TEST_FIXTURES"
assert_turbo_task_has_env "test:browser" "VERCEL_ENV"
assert_turbo_task_absent "test:browser:update-snapshots"

# Browser tests serve a cached fixture production build via `next start`; the
# build is a dedicated `fixture-build` task so it is produced at most once per
# run and reused across re-runs.
assert_turbo_task_depends_on "test:browser" "fixture-build"
assert_turbo_task_has_input "test:browser" "scripts/fixture-build.mjs"
assert_turbo_task_has_input "test:browser" "scripts/fixture-constants.mjs"
assert_turbo_task_has_env "test:browser" "NEXT_DIST_DIR"
assert_turbo_task_has_output "fixture-build" ".next-fixture/**"
assert_turbo_task_has_input "fixture-build" "scripts/fixture-build.mjs"
assert_turbo_task_has_input "fixture-build" "scripts/fixture-constants.mjs"
assert_turbo_task_has_env "fixture-build" "NEXT_PUBLIC_BROWSER_TEST_FIXTURES"
assert_turbo_task_has_env "fixture-build" "NEXT_PUBLIC_HASURA_URL"
assert_turbo_task_has_env "fixture-build" "NEXT_DIST_DIR"
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
  real_git="$(command -v git)"
  real_git_quoted="$(printf '%q' "$real_git")"
  IFS= read -r real_git_first_line < "$real_git" || real_git_first_line=""
  if [[ "$real_git_first_line" == '#!'* ]]; then
    # Codex Cloud exposes git as a bash wrapper; preserve that path even when
    # this test constrains PATH to a tiny fixture directory.
    cat > "$minimal_bin/git" <<EOF
#!/bin/bash
exec /bin/bash $real_git_quoted "\$@"
EOF
  else
    cat > "$minimal_bin/git" <<EOF
#!/bin/bash
exec $real_git_quoted "\$@"
EOF
  fi
  chmod +x "$minimal_bin/git"
  for tool in awk bash cat dirname pwd tr wc; do
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
    "agent:review-materiality": "node scripts/review-materiality.mjs",
    "agent:review-materiality:test": "node scripts/review-materiality.test.mjs",
    "docs:garden": "node scripts/docs-garden-issue.mjs",
    "docs:garden:test": "node scripts/docs-garden-issue.test.mjs",
    "docs:navigation-eval": "node scripts/docs-navigation-eval.mjs",
    "docs:navigation-eval:test": "node scripts/docs-navigation-eval.test.mjs",
    "issue:board": "node scripts/agent-issue-board.mjs",
    "issue:board:test": "node scripts/agent-issue-board.test.mjs",
    "issue:claim": "node scripts/agent-issue-board.mjs claim",
    "issue:review": "node scripts/agent-issue-board.mjs review",
    "issue:release": "node scripts/agent-issue-board.mjs release",
    "pr:feedback-state": "node scripts/pr-feedback-state.mjs",
    "pr:feedback-state:test": "node scripts/pr-feedback-state.test.mjs",
    "pr:ready-state": "node scripts/pr-ready-state.mjs",
    "pr:ready-state:test": "node scripts/pr-ready-state.test.mjs",
    "lockfile:lint": "node scripts/lockfile-lint.mjs",
    "lockfile:lint:test": "node scripts/lockfile-lint.test.mjs",
    "skew:check": "node scripts/version-skew-check.mjs",
    "skew:check:test": "node scripts/version-skew-check.test.mjs"
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
assert_contains "- pnpm skew:check (workspace package manifest changed)"
assert_order \
  "- pnpm install --frozen-lockfile (workspace package manifest changed)" \
  "- pnpm skew:check (workspace package manifest changed)"
assert_order \
  "- pnpm skew:check (workspace package manifest changed)" \
  "- pnpm --filter @mento-protocol/ui-dashboard lint (ui-dashboard changed)"
assert_order \
  "- pnpm --filter @mento-protocol/ui-dashboard test:coverage (ui-dashboard changed (coverage floor))" \
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
assert_contains "Refusing to run because package manifests, patches, or lockfile changed."
assert_contains "re-run with --allow-package-script-changes if they are safe."

run_gate_expect_failure "pnpm-lock.yaml"
assert_contains "Refusing to run because package manifests, patches, or lockfile changed."
assert_contains "dependency install scripts"

run_gate_expect_failure "pnpm-workspace.yaml"
assert_contains "Refusing to run because package manifests, patches, or lockfile changed."
assert_contains "dependency install scripts"

run_gate_expect_failure "patches/@lhci__utils@0.15.1.patch"
assert_contains "Refusing to run because package manifests, patches, or lockfile changed."
assert_contains "dependency install scripts"
assert_contains "- ./tools/trunk check --all (changed paths require full-repo Trunk checks)"

run_gate_expect_failure ".npmrc"
assert_contains "Refusing to run because package manifests, patches, or lockfile changed."
assert_contains "dependency install scripts"

run_gate_expect_failure "indexer-envio/.npmrc"
assert_contains "Refusing to run because package manifests, patches, or lockfile changed."
assert_contains "dependency install scripts"
assert_contains "- ./tools/trunk check --all (changed paths require full-repo Trunk checks)"

run_gate_expect_failure "pnpmfile.cjs"
assert_contains "Refusing to run because package manifests, patches, or lockfile changed."
assert_contains "dependency install scripts"
assert_contains "- ./tools/trunk check --all (changed paths require full-repo Trunk checks)"

run_gate_expect_failure ".pnpmfile.cjs"
assert_contains "Refusing to run because package manifests, patches, or lockfile changed."
assert_contains "dependency install scripts"
assert_contains "- ./tools/trunk check --all (changed paths require full-repo Trunk checks)"

run_gate ".npmrc"
assert_contains "- pnpm install --frozen-lockfile (package manager config changed)"
assert_contains "- pnpm skew:check (package manager config changed)"
assert_contains "- pnpm --filter @mento-protocol/indexer-envio indexer:bridge-only:codegen (package manager config changed)"
assert_contains "- pnpm --filter @mento-protocol/ui-dashboard typecheck (package manager config changed)"
assert_contains "- pnpm exec turbo run lint --filter=@mento-protocol/ui-dashboard --filter=@mento-protocol/indexer-envio --filter=@mento-protocol/metrics-bridge --filter=@mento-protocol/integration-probes --filter=@mento-protocol/config --filter=@mento-protocol/aegis --cache=local:rw (package manager config changed)"
assert_contains "- pnpm exec turbo run typecheck --filter=@mento-protocol/ui-dashboard --filter=@mento-protocol/indexer-envio --filter=@mento-protocol/metrics-bridge --filter=@mento-protocol/integration-probes --filter=@mento-protocol/config --filter=@mento-protocol/aegis --cache=local:rw (package manager config changed)"
assert_contains "- pnpm exec turbo run knip --filter=@mento-protocol/ui-dashboard --filter=@mento-protocol/indexer-envio --filter=@mento-protocol/metrics-bridge --filter=@mento-protocol/integration-probes --filter=@mento-protocol/config --filter=@mento-protocol/aegis --cache=local:rw (package manager config changed (knip: unused files/deps/exports))"
assert_occurrences 1 "- pnpm exec turbo run lint --filter="
assert_occurrences 1 "- pnpm exec turbo run typecheck --filter="
assert_occurrences 1 "- pnpm exec turbo run knip --filter="
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

run_gate "patches/@lhci__utils@0.15.1.patch"
assert_contains "- pnpm install --frozen-lockfile (pnpm patch changed)"
assert_contains "- pnpm --filter @mento-protocol/indexer-envio indexer:bridge-only:codegen (pnpm patch changed)"
assert_contains "- pnpm --filter @mento-protocol/ui-dashboard typecheck (pnpm patch changed)"
assert_contains "- pnpm exec turbo run lint --filter=@mento-protocol/ui-dashboard --filter=@mento-protocol/indexer-envio --filter=@mento-protocol/metrics-bridge --filter=@mento-protocol/integration-probes --filter=@mento-protocol/config --filter=@mento-protocol/aegis --cache=local:rw (pnpm patch changed)"
assert_not_contains_mapped "- pnpm --filter @mento-protocol/ui-dashboard test:browser (pnpm patch changed)"

run_gate "package.json"
assert_contains "- bash scripts/agent-quality-gate.test.sh (agent quality gate package script changed)"
assert_contains "- pnpm skew:check (workspace dependency/config changed)"
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
    "agent:review-materiality": "node scripts/review-materiality.mjs",
    "agent:review-materiality:test": "node scripts/review-materiality.test.mjs",
    "issue:board": "node scripts/agent-issue-board.mjs",
    "issue:board:test": "node scripts/agent-issue-board.test.mjs",
    "issue:claim": "node scripts/agent-issue-board.mjs claim",
    "issue:review": "node scripts/agent-issue-board.mjs review",
    "issue:release": "node scripts/agent-issue-board.mjs release",
    "pr:feedback-state": "node scripts/pr-feedback-state.mjs",
    "pr:feedback-state:test": "node scripts/pr-feedback-state.test.mjs",
    "pr:ready-state": "node scripts/pr-ready-state.mjs",
    "pr:ready-state:test": "node scripts/pr-ready-state.test.mjs",
    "lockfile:lint": "node scripts/lockfile-lint.mjs",
    "lockfile:lint:test": "node scripts/lockfile-lint.test.mjs",
    "skew:check": "node scripts/version-skew-check.mjs",
    "skew:check:test": "node scripts/version-skew-check.test.mjs"
  }
}
JSON
  git add package.json
  git commit -qm init
  node - <<'NODE'
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.scripts["docs:garden:test"] = "node scripts/docs-garden-issue.test.mjs --fixture";
fs.writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
NODE
  "$repo_root/scripts/agent-quality-gate.sh" --base HEAD > "$output_file"
)
rm -rf "$package_json_repo"
assert_contains "- tooling"
assert_contains "- bash scripts/check-agent-quality-gate-package-scripts.sh (root package tooling script changed)"
assert_contains "- bash scripts/agent-quality-gate.test.sh (root package tooling script changed)"
assert_contains "- node scripts/agent-prewarm.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/review-materiality.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/agent-issue-board.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/docs-garden-issue.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/docs-navigation-eval.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/pr-feedback-state.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/pr-ready-state.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/tf-stacks.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/lockfile-lint.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/version-skew-check.test.mjs (root package tooling script changed)"
assert_not_contains "- pnpm agent:quality-gate:test"
assert_not_contains "- pnpm install --frozen-lockfile"
assert_not_contains "- pnpm --filter @mento-protocol/indexer-envio indexer:bridge-only:codegen"
assert_not_contains "- pnpm --filter @mento-protocol/ui-dashboard lint"

dedupe_quality_gate_alias_repo="$(mktemp -d)"
(
  cd "$dedupe_quality_gate_alias_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  mkdir -p scripts
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
    "agent:review-materiality": "node scripts/review-materiality.mjs",
    "agent:review-materiality:test": "node scripts/review-materiality.test.mjs",
    "issue:board": "node scripts/agent-issue-board.mjs",
    "issue:board:test": "node scripts/agent-issue-board.test.mjs",
    "issue:claim": "node scripts/agent-issue-board.mjs claim",
    "issue:review": "node scripts/agent-issue-board.mjs review",
    "issue:release": "node scripts/agent-issue-board.mjs release",
    "pr:feedback-state": "node scripts/pr-feedback-state.mjs",
    "pr:feedback-state:test": "node scripts/pr-feedback-state.test.mjs",
    "pr:ready-state": "node scripts/pr-ready-state.mjs",
    "pr:ready-state:test": "node scripts/pr-ready-state.test.mjs",
    "lockfile:lint": "node scripts/lockfile-lint.mjs",
    "lockfile:lint:test": "node scripts/lockfile-lint.test.mjs",
    "skew:check": "node scripts/version-skew-check.mjs",
    "skew:check:test": "node scripts/version-skew-check.test.mjs"
  }
}
JSON
  printf '#!/usr/bin/env bash\n' > scripts/agent-quality-gate.sh
  git add .
  git commit -qm init
  node - <<'NODE'
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.scripts["agent:quality-gate:test"] = "bash scripts/agent-quality-gate.test.sh --fixture";
fs.writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
NODE
  printf 'echo updated\n' >> scripts/agent-quality-gate.sh
  "$repo_root/scripts/agent-quality-gate.sh" --base HEAD > "$output_file"
)
rm -rf "$dedupe_quality_gate_alias_repo"
assert_occurrences 1 "- bash scripts/agent-quality-gate.test.sh"
assert_not_contains "- pnpm agent:quality-gate:test"

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
    "agent:review-materiality": "node scripts/review-materiality.mjs",
    "agent:review-materiality:test": "node scripts/review-materiality.test.mjs",
    "issue:board": "node scripts/agent-issue-board.mjs",
    "issue:board:test": "node scripts/agent-issue-board.test.mjs",
    "issue:claim": "node scripts/agent-issue-board.mjs claim",
    "issue:review": "node scripts/agent-issue-board.mjs review",
    "issue:release": "node scripts/agent-issue-board.mjs release",
    "pr:feedback-state": "node scripts/pr-feedback-state.mjs",
    "pr:feedback-state:test": "node scripts/pr-feedback-state.test.mjs",
    "pr:ready-state": "node scripts/pr-ready-state.mjs",
    "pr:ready-state:test": "node scripts/pr-ready-state.test.mjs",
    "lockfile:lint": "node scripts/lockfile-lint.mjs",
    "lockfile:lint:test": "node scripts/lockfile-lint.test.mjs",
    "skew:check": "node scripts/version-skew-check.mjs",
    "skew:check:test": "node scripts/version-skew-check.test.mjs"
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
assert_contains "- node scripts/review-materiality.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/agent-issue-board.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/pr-feedback-state.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/pr-ready-state.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/tf-stacks.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/lockfile-lint.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/version-skew-check.test.mjs (root package tooling script changed)"
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
    "agent:review-materiality": "node scripts/review-materiality.mjs",
    "agent:review-materiality:test": "node scripts/review-materiality.test.mjs",
    "issue:board": "node scripts/agent-issue-board.mjs",
    "issue:board:test": "node scripts/agent-issue-board.test.mjs",
    "issue:claim": "node scripts/agent-issue-board.mjs claim",
    "issue:review": "node scripts/agent-issue-board.mjs review",
    "issue:release": "node scripts/agent-issue-board.mjs release",
    "pr:feedback-state": "node scripts/pr-feedback-state.mjs",
    "pr:feedback-state:test": "node scripts/pr-feedback-state.test.mjs",
    "pr:ready-state": "node scripts/pr-ready-state.mjs",
    "pr:ready-state:test": "node scripts/pr-ready-state.test.mjs",
    "lockfile:lint": "node scripts/lockfile-lint.mjs",
    "lockfile:lint:test": "node scripts/lockfile-lint.test.mjs",
    "skew:check": "node scripts/version-skew-check.mjs",
    "skew:check:test": "node scripts/version-skew-check.test.mjs"
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
assert_contains "- node scripts/review-materiality.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/agent-issue-board.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/pr-feedback-state.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/pr-ready-state.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/tf-stacks.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/lockfile-lint.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/version-skew-check.test.mjs (root package tooling script changed)"
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

# ── Root package.json workspace-dev-metadata classification (issue #1414) ────

# devDependencies-only change → config canary set, not the full workspace suite.
dev_metadata_devdeps_repo="$(mktemp -d)"
(
  cd "$dev_metadata_devdeps_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  cat > package.json <<'JSON'
{
  "name": "fixture",
  "devDependencies": {
    "typescript": "5.4.0"
  }
}
JSON
  git add package.json
  git commit -qm init
  node - <<'NODE'
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.devDependencies.typescript = "5.5.0";
fs.writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
NODE
  "$repo_root/scripts/agent-quality-gate.sh" --base HEAD > "$output_file"
)
rm -rf "$dev_metadata_devdeps_repo"
# The preflight install is deduped to the first-arm reason ("workspace package
# manifest changed"); the scoped skew/lockfile-lint/canary lines below carry the
# dev-metadata reason and distinguish this class from the full suite.
assert_contains "- pnpm install --frozen-lockfile (workspace package manifest changed)"
assert_contains "- pnpm skew:check (workspace dev metadata changed)"
assert_contains "- pnpm lockfile:lint (workspace dev metadata changed)"
assert_contains "- pnpm --filter @mento-protocol/config test:coverage (workspace dev metadata changed"
assert_not_contains "cd aegis && forge test"
assert_not_contains "@mento-protocol/indexer-envio test:coverage"
assert_not_contains "workspace dependency/config changed"

# Metadata-only change (description) → same config canary set.
dev_metadata_only_repo="$(mktemp -d)"
(
  cd "$dev_metadata_only_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  cat > package.json <<'JSON'
{
  "name": "fixture",
  "description": "before"
}
JSON
  git add package.json
  git commit -qm init
  node - <<'NODE'
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.description = "after";
fs.writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
NODE
  "$repo_root/scripts/agent-quality-gate.sh" --base HEAD > "$output_file"
)
rm -rf "$dev_metadata_only_repo"
assert_contains "- pnpm --filter @mento-protocol/config test:coverage (workspace dev metadata changed"
assert_not_contains "cd aegis && forge test"
assert_not_contains "workspace dependency/config changed"

# devDependencies + a dependencies change → full suite (not dev-metadata).
dev_metadata_mixed_repo="$(mktemp -d)"
(
  cd "$dev_metadata_mixed_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  cat > package.json <<'JSON'
{
  "name": "fixture",
  "dependencies": {
    "left-pad": "1.3.0"
  },
  "devDependencies": {
    "typescript": "5.4.0"
  }
}
JSON
  git add package.json
  git commit -qm init
  node - <<'NODE'
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.devDependencies.typescript = "5.5.0";
pkg.dependencies["left-pad"] = "1.2.0";
fs.writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
NODE
  "$repo_root/scripts/agent-quality-gate.sh" --base HEAD > "$output_file"
)
rm -rf "$dev_metadata_mixed_repo"
assert_contains "- cd aegis && forge test (workspace dependency/config changed)"
assert_contains "- pnpm install --frozen-lockfile (workspace package manifest changed)"
assert_not_contains "workspace dev metadata changed"

# devDependencies + a script change → package-scripts refusal path, unchanged.
dev_metadata_scripts_repo="$(mktemp -d)"
(
  cd "$dev_metadata_scripts_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  cat > package.json <<'JSON'
{
  "name": "fixture",
  "scripts": {
    "agent:quality-gate": "./scripts/agent-quality-gate.sh"
  },
  "devDependencies": {
    "typescript": "5.4.0"
  }
}
JSON
  git add package.json
  git commit -qm init
  node - <<'NODE'
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.devDependencies.typescript = "5.5.0";
pkg.scripts.build = "tsc";
fs.writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
NODE
  "$repo_root/scripts/agent-quality-gate.sh" --base HEAD > "$output_file"
)
rm -rf "$dev_metadata_scripts_repo"
assert_contains "- bash scripts/check-agent-quality-gate-package-scripts.sh (root package script changed)"
assert_not_contains "workspace dev metadata changed"

# ── Lockfile-importer scoping (issue #1414) ─────────────────────────────────

# Reusable lockfile fixture body: writes a base pnpm-lock.yaml, commits, then
# overwrites the working copy with $1 before running the gate against HEAD.
lockfile_scope_base_yaml='lockfileVersion: '"'"'9.0'"'"'
settings:
  autoInstallPeers: true
overrides: {}
importers:
  .:
    dependencies: {}
  metrics-bridge:
    dependencies:
      viem:
        specifier: ^2.0.0
        version: 2.0.0
  integration-probes:
    dependencies:
      undici:
        specifier: ^6.0.0
        version: 6.0.0
packages:
  viem@2.0.0: {}
'

run_lockfile_scope_gate() {
  local head_yaml="$1"
  local repo
  repo="$(mktemp -d)"
  (
    cd "$repo"
    git init -q
    git config user.email test@example.invalid
    git config user.name "Quality Gate Test"
    printf '{ "name": "fixture" }\n' > package.json
    printf '%s' "$lockfile_scope_base_yaml" > pnpm-lock.yaml
    git add package.json pnpm-lock.yaml
    git commit -qm init
    printf '%s' "$head_yaml" > pnpm-lock.yaml
    "$repo_root/scripts/agent-quality-gate.sh" --base HEAD > "$output_file"
  )
  rm -rf "$repo"
}

# Single importer version bump → that package's bundle + scoped skew/lockfile
# lint, and NOT the full workspace suite.
run_lockfile_scope_gate 'lockfileVersion: '"'"'9.0'"'"'
settings:
  autoInstallPeers: true
overrides: {}
importers:
  .:
    dependencies: {}
  metrics-bridge:
    dependencies:
      viem:
        specifier: ^2.1.0
        version: 2.1.0
  integration-probes:
    dependencies:
      undici:
        specifier: ^6.0.0
        version: 6.0.0
packages:
  viem@2.0.0: {}
'
assert_contains "- pnpm skew:check (lockfile change scoped to importers)"
assert_contains "- pnpm lockfile:lint (lockfile change scoped to importers)"
assert_contains "- pnpm --filter @mento-protocol/metrics-bridge test:coverage (lockfile importer metrics-bridge changed (coverage floor))"
assert_not_contains "cd aegis && forge test"
assert_not_contains "@mento-protocol/integration-probes test:coverage"
assert_not_contains "workspace dependency/config changed (coverage floor)"

# Scoped dashboard/indexer importer bumps keep the workspace route's extra
# coverage: size-limit (dependency-driven bundle regressions) and the full
# indexer codegen matrix (testnet/bridge-only resolutions can break even when
# mainnet codegen passes).
run_lockfile_scope_gate 'lockfileVersion: '"'"'9.0'"'"'
settings:
  autoInstallPeers: true
overrides: {}
importers:
  .:
    dependencies: {}
  ui-dashboard:
    dependencies:
      viem:
        specifier: ^2.1.0
        version: 2.1.0
  indexer-envio:
    dependencies:
      viem:
        specifier: ^2.1.0
        version: 2.1.0
packages:
  viem@2.0.0: {}
'
assert_contains "turbo run size-limit --filter=@mento-protocol/ui-dashboard"
assert_contains "- pnpm indexer:testnet:codegen (lockfile importer indexer-envio changed)"
assert_contains "- pnpm --filter @mento-protocol/indexer-envio test:coverage (lockfile importer indexer-envio changed (coverage floor))"
assert_not_contains "workspace dependency/config changed (coverage floor)"

# An importer version bump PLUS an unrelated small source edit in that same
# package must still run the package's FULL test:coverage — the
# lockfile-triggered coverage floor stands in for the dependency-bump
# regression check (issue #1414), so scoped-tests (issue #1413) must not
# narrow it down to just the unrelated edit's related tests.
lockfile_and_source_repo="$(mktemp -d)"
(
  cd "$lockfile_and_source_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  printf '{ "name": "fixture" }\n' > package.json
  printf '%s' "$lockfile_scope_base_yaml" > pnpm-lock.yaml
  mkdir -p metrics-bridge/src
  echo "export const x = 1;" > metrics-bridge/src/existing.ts
  git add package.json pnpm-lock.yaml metrics-bridge/src/existing.ts
  git commit -qm init
  cat > pnpm-lock.yaml <<'YAML'
lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
overrides: {}
importers:
  .:
    dependencies: {}
  metrics-bridge:
    dependencies:
      viem:
        specifier: ^2.1.0
        version: 2.1.0
  integration-probes:
    dependencies:
      undici:
        specifier: ^6.0.0
        version: 6.0.0
packages:
  viem@2.0.0: {}
YAML
  echo "export const x = 2;" > metrics-bridge/src/existing.ts
  "$repo_root/scripts/agent-quality-gate.sh" --base HEAD > "$output_file"
)
rm -rf "$lockfile_and_source_repo"
assert_contains "- pnpm --filter @mento-protocol/metrics-bridge test:coverage (metrics-bridge changed (coverage floor))"
assert_not_contains "exec vitest related --run"

# Two importers changed → both bundles.
run_lockfile_scope_gate 'lockfileVersion: '"'"'9.0'"'"'
settings:
  autoInstallPeers: true
overrides: {}
importers:
  .:
    dependencies: {}
  metrics-bridge:
    dependencies:
      viem:
        specifier: ^2.1.0
        version: 2.1.0
  integration-probes:
    dependencies:
      undici:
        specifier: ^6.1.0
        version: 6.1.0
packages:
  viem@2.0.0: {}
'
assert_contains "- pnpm --filter @mento-protocol/metrics-bridge test:coverage (lockfile importer metrics-bridge changed (coverage floor))"
assert_contains "- pnpm --filter @mento-protocol/integration-probes test:coverage (lockfile importer integration-probes changed (coverage floor))"
assert_not_contains "cd aegis && forge test"

# Overrides section change → full workspace suite (fail toward full).
run_lockfile_scope_gate 'lockfileVersion: '"'"'9.0'"'"'
settings:
  autoInstallPeers: true
overrides:
  cross-spawn: '"'"'>=7.0.5'"'"'
importers:
  .:
    dependencies: {}
  metrics-bridge:
    dependencies:
      viem:
        specifier: ^2.0.0
        version: 2.0.0
  integration-probes:
    dependencies:
      undici:
        specifier: ^6.0.0
        version: 6.0.0
packages:
  viem@2.0.0: {}
'
assert_contains "- cd aegis && forge test (workspace dependency/config changed)"
assert_not_contains "lockfile change scoped to importers"

# Corrupt (unparsable) lockfile head → full workspace suite (fail toward full).
run_lockfile_scope_gate 'lockfileVersion: '"'"'9.0'"'"'
importers:
  metrics-bridge: [unterminated
'
assert_contains "- cd aegis && forge test (workspace dependency/config changed)"
assert_not_contains "lockfile change scoped to importers"

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
# Single production-source edit → scoped `vitest related` (issue #1413); the
# full test:coverage floor still runs in CI.
assert_raw_contains "- pnpm --filter @mento-protocol/indexer-envio exec vitest related --run src/bridge.ts (indexer-envio changed (coverage floor) (scoped-tests))"
assert_not_contains "- pnpm --filter @mento-protocol/indexer-envio test:coverage"
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
# Non-module files (JSON/YAML/assets) may be read by tests via fs rather than
# the import graph `vitest related` follows, so they disqualify scoping and
# the full coverage floor runs (fail toward full).
assert_contains "- pnpm --filter @mento-protocol/indexer-envio test:coverage"
assert_not_contains "vitest related --run config/aggregators.json"

run_gate "metrics-bridge/src/graphql.ts"
assert_contains "- docs/pr-checklists/stateful-data-ui.md (metrics bridge data flow changed)"
assert_contains "- docs/pr-checklists/terraform-cloudrun.md (metrics bridge Cloud Run runtime changed)"
assert_raw_contains "- pnpm --filter @mento-protocol/metrics-bridge exec vitest related --run src/graphql.ts (metrics-bridge changed (coverage floor) (scoped-tests))"
assert_not_contains "- pnpm --filter @mento-protocol/metrics-bridge test:coverage"

run_gate "metrics-bridge/src/poller.ts"
assert_contains "- docs/pr-checklists/stateful-data-ui.md (metrics bridge data flow changed)"
assert_contains "- docs/pr-checklists/terraform-cloudrun.md (metrics bridge Cloud Run runtime changed)"

run_gate "metrics-bridge/src/metrics.ts"
assert_contains "- docs/pr-checklists/stateful-data-ui.md (metrics bridge data flow changed)"
assert_contains "- docs/pr-checklists/terraform-cloudrun.md (metrics bridge Cloud Run runtime changed)"
assert_contains "- pnpm alerts:rules:lint (metrics-bridge gauge registry changed (alerts cross-check))"

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
assert_raw_contains "- pnpm --filter @mento-protocol/ui-dashboard exec vitest related --run src/lib/gql-retry.ts (ui-dashboard changed (coverage floor) (scoped-tests))"
assert_not_contains "- pnpm --filter @mento-protocol/ui-dashboard test:coverage"
assert_contains "- pnpm --filter @mento-protocol/ui-dashboard exec playwright install chromium (ui-dashboard changed)"
assert_contains "- pnpm --filter @mento-protocol/ui-dashboard test:browser (ui-dashboard changed)"
assert_contains "- pnpm dashboard:size-limit (ui-dashboard bundle inputs changed)"
assert_occurrences 1 "- pnpm --filter @mento-protocol/ui-dashboard test:browser (ui-dashboard changed)"
assert_occurrences 1 "- pnpm dashboard:size-limit (ui-dashboard bundle inputs changed)"
assert_not_contains_mapped "- pnpm dashboard:build"

# A shared-config change alongside a small consumer edit must disable scoping
# globally: `vitest related` only follows imports from the changed files, so a
# scoped consumer run would miss shared-config-induced regressions in tests
# that import @mento-protocol/config through OTHER consumer source.
run_gate "shared-config/src/chains.ts" "ui-dashboard/src/lib/gql-retry.ts"
assert_contains "- pnpm --filter @mento-protocol/ui-dashboard test:coverage"
assert_not_contains "vitest related --run src/lib/gql-retry.ts"

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
assert_contains "- pnpm dashboard:size-limit (ui-dashboard bundle inputs changed)"

run_gate "ui-dashboard/next.config.ts"
assert_contains "- pnpm dashboard:size-limit (ui-dashboard bundle inputs changed)"

run_gate "ui-dashboard/sentry.shared.ts"
assert_contains "- pnpm dashboard:size-limit (ui-dashboard bundle inputs changed)"

run_gate "ui-dashboard/src/instrumentation-client.ts"
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
assert_contains "- node scripts/check-hermetic-vitest-setup.mjs (hermetic Vitest config changed)"
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
assert_contains "- node scripts/check-hermetic-vitest-setup.mjs (hermetic Vitest config changed)"
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
assert_contains "- node scripts/check-hermetic-vitest-setup.mjs (hermetic Vitest config changed)"
assert_contains "- docs/pr-checklists/mutation-testing.md (indexer mutation baseline changed)"
assert_contains "- pnpm indexer:mutation (indexer mutation baseline changed)"

run_gate "indexer-envio/src/helpers.ts"
assert_contains "- docs/pr-checklists/mutation-testing.md (indexer mutation baseline changed)"
assert_contains "- pnpm indexer:mutation (indexer mutation baseline changed)"

run_gate "indexer-envio/src/EventHandlers.ts"
assert_contains "- pnpm --filter @mento-protocol/indexer-envio indexer:reserve-yield:test (reserve-yield handler registration path changed)"
assert_contains "- docs/pr-checklists/stateful-data-ui.md (indexer data flow changed)"

run_gate "indexer-envio/src/handlers/susdsEvents.ts"
assert_contains "- pnpm --filter @mento-protocol/indexer-envio indexer:reserve-yield:test (reserve-yield handler path changed)"
assert_contains "- docs/pr-checklists/stateful-data-ui.md (indexer data flow changed)"

run_gate "indexer-envio/src/handlers/steth/shared.ts"
assert_contains "- pnpm --filter @mento-protocol/indexer-envio indexer:reserve-yield:test (reserve-yield handler path changed)"
assert_contains "- docs/pr-checklists/stateful-data-ui.md (indexer data flow changed)"

run_gate "indexer-envio/src/rpc/susds.ts"
assert_contains "- pnpm --filter @mento-protocol/indexer-envio indexer:reserve-yield:test (reserve-yield RPC path changed)"
assert_contains "- docs/pr-checklists/stateful-data-ui.md (indexer data flow changed)"

run_gate "indexer-envio/src/rpc/effects.ts"
assert_contains "- pnpm --filter @mento-protocol/indexer-envio indexer:reserve-yield:test (reserve-yield RPC path changed)"
assert_contains "- docs/pr-checklists/stateful-data-ui.md (indexer data flow changed)"

run_gate "indexer-envio/config.multichain.mainnet.yaml"
assert_contains "- pnpm --filter @mento-protocol/indexer-envio indexer:reserve-yield:test (reserve-yield indexer config changed)"
assert_contains "- docs/pr-checklists/stateful-data-ui.md (indexer data flow changed)"

run_gate "indexer-envio/src/handlers/stables/classifyKind.ts"
assert_contains "- docs/pr-checklists/mutation-testing.md (indexer mutation baseline changed)"
assert_contains "- pnpm indexer:mutation (indexer mutation baseline changed)"

run_gate "indexer-envio/test/code-quality-invariants.test.ts"
assert_contains "- docs/pr-checklists/mutation-testing.md (indexer mutation baseline changed)"
assert_contains "- pnpm indexer:mutation (indexer mutation baseline changed)"

run_gate "indexer-envio/test/stables.test.ts"
assert_contains "- docs/pr-checklists/mutation-testing.md (indexer mutation baseline changed)"
assert_contains "- pnpm indexer:mutation (indexer mutation baseline changed)"

run_gate "indexer-envio/config/protocolActors.json"
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
assert_contains "- TF_DATA_DIR=terraform/.terraform-agent-gate node scripts/terraform-fmt-check.mjs terraform (Terraform changed)"
assert_contains "- TF_DATA_DIR=terraform/.terraform-agent-gate terraform -chdir=terraform init -backend=false -input=false (Terraform changed)"
assert_contains "- TF_DATA_DIR=terraform/.terraform-agent-gate terraform -chdir=terraform validate -no-color (Terraform changed)"
assert_contains "- docs/pr-checklists/terraform-cloudrun.md (Terraform/Cloud Run path changed)"

run_gate "alerts/rules/rules-fpmms.tf"
assert_contains "- TF_DATA_DIR=alerts/rules/.terraform-agent-gate node scripts/terraform-fmt-check.mjs alerts/rules (alerts/rules Terraform changed)"
assert_contains "- TF_DATA_DIR=alerts/rules/.terraform-agent-gate terraform -chdir=alerts/rules init -backend=false -input=false (alerts/rules Terraform changed)"
assert_contains "- TF_DATA_DIR=alerts/rules/.terraform-agent-gate terraform -chdir=alerts/rules validate -no-color (alerts/rules Terraform changed)"
assert_contains "- pnpm alerts:rules:lint (alerts/rules PromQL lint + metric cross-check)"
assert_contains "- node scripts/check-deviation-threshold-drift.mjs (deviation threshold Terraform consumer changed)"

run_gate "alerts/rules/main.tf"
assert_contains "- TF_DATA_DIR=alerts/rules/.terraform-agent-gate node scripts/terraform-fmt-check.mjs alerts/rules (alerts/rules Terraform changed)"
assert_contains "- TF_DATA_DIR=alerts/rules/.terraform-agent-gate terraform -chdir=alerts/rules init -backend=false -input=false (alerts/rules Terraform changed)"
assert_contains "- TF_DATA_DIR=alerts/rules/.terraform-agent-gate terraform -chdir=alerts/rules validate -no-color (alerts/rules Terraform changed)"
assert_contains "- node scripts/check-deviation-threshold-drift.mjs (deviation threshold Terraform consumer changed)"

run_gate "alerts/infra/main.tf"
assert_contains "- TF_DATA_DIR=alerts/infra/.terraform-agent-gate node scripts/terraform-fmt-check.mjs alerts/infra (alerts/infra Terraform changed)"
assert_contains "- TF_DATA_DIR=alerts/infra/.terraform-agent-gate terraform -chdir=alerts/infra init -backend=false -input=false (alerts/infra Terraform changed)"
assert_contains "- TF_DATA_DIR=alerts/infra/.terraform-agent-gate terraform -chdir=alerts/infra validate -no-color (alerts/infra Terraform changed)"
assert_contains "- docs/pr-checklists/terraform-cloudrun.md (alerts/infra Cloud Function path changed)"

run_gate "alerts/infra/channels/sentry-bridge/main.tf"
assert_contains "- TF_DATA_DIR=alerts/infra/.terraform-agent-gate node scripts/terraform-fmt-check.mjs alerts/infra (alerts/infra Terraform changed)"

run_gate "alerts/infra/onchain-event-listeners/main.tf"
assert_contains "- bash alerts/infra/scripts/fix-webhook-state.test.sh (QuickNode replacement state parser changed)"

run_gate "alerts/infra/scripts/common.sh"
assert_contains "- bash -n alerts/infra/scripts/common.sh (shell script changed)"
assert_contains "- bash alerts/infra/scripts/fix-webhook-state.test.sh (QuickNode state parser changed)"

run_gate "alerts/infra/scripts/fix-webhook-state.test.sh"
assert_contains "- bash -n alerts/infra/scripts/fix-webhook-state.test.sh (shell script changed)"
assert_contains "- bash alerts/infra/scripts/fix-webhook-state.test.sh (QuickNode state parser changed)"

run_gate "alerts/infra/onchain-event-handler/main.tf"
assert_contains "- TF_DATA_DIR=alerts/infra/.terraform-agent-gate node scripts/terraform-fmt-check.mjs alerts/infra (alerts/infra Terraform changed)"
assert_contains "- docs/pr-checklists/terraform-cloudrun.md (alerts/infra Cloud Function path changed)"

run_gate "alerts/infra/onchain-event-handler/src/slack.ts"
assert_contains "- pnpm exec turbo run lint --filter=@mento-protocol/alerts-onchain-event-handler --cache=local:rw (alerts onchain-event-handler changed)"
assert_contains "- pnpm exec turbo run typecheck --filter=@mento-protocol/alerts-onchain-event-handler --cache=local:rw (alerts onchain-event-handler changed)"
assert_raw_contains "- pnpm --filter @mento-protocol/alerts-onchain-event-handler exec vitest related --run src/slack.ts (alerts onchain-event-handler changed (coverage floor) (scoped-tests))"
assert_not_contains "- pnpm --filter @mento-protocol/alerts-onchain-event-handler test:coverage"

run_gate "alerts/infra/onchain-event-handler/src/safe-abi.json"
assert_contains "- pnpm exec turbo run lint --filter=@mento-protocol/alerts-onchain-event-handler --cache=local:rw (Safe ABI changed (handler imports it))"
assert_contains "- pnpm exec turbo run typecheck --filter=@mento-protocol/alerts-onchain-event-handler --cache=local:rw (Safe ABI changed (handler imports it))"
# Even though this JSON is genuinely imported, non-module files may be fs-read
# elsewhere and the gate cannot tell statically — they disqualify scoping, so
# the full coverage floor runs (fail toward full).
assert_contains "- pnpm --filter @mento-protocol/alerts-onchain-event-handler test:coverage"
assert_not_contains "vitest related --run src/safe-abi.json"
assert_contains "- TF_DATA_DIR=alerts/infra/.terraform-agent-gate node scripts/terraform-fmt-check.mjs alerts/infra (Safe ABI changed (listener filter uses it at plan time))"
assert_contains "- TF_DATA_DIR=alerts/infra/.terraform-agent-gate terraform -chdir=alerts/infra init -backend=false -input=false (Safe ABI changed (listener filter uses it at plan time))"
assert_contains "- TF_DATA_DIR=alerts/infra/.terraform-agent-gate terraform -chdir=alerts/infra validate -no-color (Safe ABI changed (listener filter uses it at plan time))"

run_gate ".github/workflows/metrics-bridge.yml"
assert_contains "- docs/pr-checklists/ci-workflow-gates.md (GitHub Actions workflow/action changed)"
assert_contains "- node scripts/check-github-action-pins.mjs (GitHub Actions workflow/action changed)"
assert_contains "- docs/pr-checklists/terraform-cloudrun.md (metrics bridge Cloud Run workflow changed)"
assert_contains "- pnpm agent:context-check (Cloud Run revision suffix guard changed)"

run_gate ".github/workflows/documentation-garden.yml"
assert_contains "- docs/pr-checklists/ci-workflow-gates.md (GitHub Actions workflow/action changed)"
assert_contains "- node scripts/check-github-action-pins.mjs (GitHub Actions workflow/action changed)"
assert_contains "- pnpm docs:garden:test (documentation garden workflow changed)"
assert_contains "- pnpm docs:navigation-eval:test (documentation navigation scheduler workflow changed)"
assert_contains "node scripts/check-adr-reminder.mjs"

run_gate ".lighthouserc.cjs"
assert_contains "- node scripts/lighthouse-config.test.mjs (Lighthouse CI budget config changed)"

run_gate "scripts/lighthouse-config.test.mjs"
assert_contains "- node scripts/lighthouse-config.test.mjs (Lighthouse config assertion suite changed)"

run_gate ".github/workflows/ci.yml"
assert_contains "- docs/pr-checklists/ci-workflow-gates.md (GitHub Actions workflow/action changed)"
assert_contains "- node scripts/check-github-action-pins.mjs (GitHub Actions workflow/action changed)"
assert_contains "- pnpm install --frozen-lockfile (central CI workflow changed)"
assert_contains "- pnpm --filter @mento-protocol/indexer-envio indexer:bridge-only:codegen (central CI workflow changed)"
assert_contains "- pnpm tf:test (Terraform registry-backed CI workflow changed)"
assert_contains "- TF_DATA_DIR=terraform/.terraform-agent-gate node scripts/terraform-fmt-check.mjs terraform (Terraform registry-backed CI workflow changed)"
assert_contains "- TF_DATA_DIR=alerts/rules/.terraform-agent-gate node scripts/terraform-fmt-check.mjs alerts/rules (Terraform registry-backed CI workflow changed)"
assert_contains "- TF_DATA_DIR=aegis/terraform/.terraform-agent-gate node scripts/terraform-fmt-check.mjs aegis/terraform (Terraform registry-backed CI workflow changed)"
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
assert_contains "- node scripts/check-github-action-pins.mjs (GitHub Actions workflow/action changed)"
assert_contains "- pnpm tf:test (Terraform registry workflow changed)"
assert_contains "- TF_DATA_DIR=terraform/.terraform-agent-gate node scripts/terraform-fmt-check.mjs terraform (Terraform registry workflow changed)"
assert_contains "- TF_DATA_DIR=alerts/rules/.terraform-agent-gate node scripts/terraform-fmt-check.mjs alerts/rules (Terraform registry workflow changed)"
assert_contains "- TF_DATA_DIR=alerts/infra/.terraform-agent-gate node scripts/terraform-fmt-check.mjs alerts/infra (Terraform registry workflow changed)"
assert_contains "- TF_DATA_DIR=aegis/terraform/.terraform-agent-gate node scripts/terraform-fmt-check.mjs aegis/terraform (Terraform registry workflow changed)"

run_gate ".github/actions/pnpm-install/action.yml"
assert_contains "- docs/pr-checklists/ci-workflow-gates.md (GitHub Actions workflow/action changed)"
assert_contains "- node scripts/check-github-action-pins.mjs (GitHub Actions workflow/action changed)"
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
assert_contains "- pnpm --filter @mento-protocol/metrics-bridge test:coverage (metrics bridge build context changed (coverage floor))"

run_gate "cloudbuild.yaml"
assert_contains "- docs/pr-checklists/terraform-cloudrun.md (Cloud Build config changed)"
assert_contains "- pnpm --filter @mento-protocol/metrics-bridge lint (metrics bridge build context changed)"
assert_contains "- pnpm --filter @mento-protocol/metrics-bridge typecheck (metrics bridge build context changed)"
assert_contains "- pnpm --filter @mento-protocol/metrics-bridge test:coverage (metrics bridge build context changed (coverage floor))"

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
assert_contains "- pnpm dashboard:size-limit (shared-config exports feed the dashboard bundle)"

run_gate "shared-config/src/chains.ts"
assert_contains "- pnpm --filter @mento-protocol/config test:coverage (shared-config changed (coverage floor))"
assert_contains "- pnpm dashboard:size-limit (shared-config exports feed the dashboard bundle)"
# The cache key includes shared-config inputs for browser tests, but the local
# gate still does not broaden shared-config-only edits into Playwright runs.
assert_not_contains_mapped "- pnpm --filter @mento-protocol/ui-dashboard test:browser (shared-config exports feed the dashboard bundle)"

run_gate "shared-config/src/thresholds.ts"
assert_contains "- node scripts/check-deviation-threshold-drift.mjs (shared deviation threshold source changed)"
assert_raw_contains "- pnpm --filter @mento-protocol/indexer-envio exec vitest run deviationThresholdSharedConfigSync (shared deviation threshold source changed)"
# shared-config's downstream blast radius is the point — it keeps the full suite
# and never scopes to `vitest related` (issue #1413, condition c).
assert_contains "- pnpm --filter @mento-protocol/config test:coverage (shared-config changed (coverage floor))"
assert_not_contains "exec vitest related --run"
assert_contains "- pnpm dashboard:size-limit (shared-config exports feed the dashboard bundle)"

# ── Scoped local test runs (GitHub issue #1413) ─────────────────────────────
# A small production-source-only edit narrows a package's full `test:coverage`
# floor to `pnpm exec vitest related --run <files>` locally. CI always runs the
# full coverage floors, so this only trims the local signal.

# Two production-source files in one package → both listed (sorted) + scoped.
# Real, existing files: scoping now requires each changed path to exist at
# head (see the deletion test below), so placeholder paths would no longer
# qualify.
run_gate "ui-dashboard/src/lib/address-book.ts" "ui-dashboard/src/lib/arkham.ts"
assert_raw_contains "- pnpm --filter @mento-protocol/ui-dashboard exec vitest related --run src/lib/address-book.ts src/lib/arkham.ts (ui-dashboard changed (coverage floor) (scoped-tests))"
assert_not_contains "- pnpm --filter @mento-protocol/ui-dashboard test:coverage"

# A deleted production-source file (or the old side of a --no-renames rename)
# keeps the full suite: `vitest related --run <missing path>` silently finds
# zero tests instead of erroring, which would otherwise skip the coverage
# floor entirely rather than failing toward it.
run_gate "ui-dashboard/src/lib/this-file-does-not-exist.ts"
assert_contains "- pnpm --filter @mento-protocol/ui-dashboard test:coverage"
assert_not_contains "exec vitest related --run"

# A test-file-only edit keeps the full suite (test files are not scopable source).
run_gate "ui-dashboard/src/lib/__tests__/scope-probe.test.ts"
assert_contains "- pnpm --filter @mento-protocol/ui-dashboard test:coverage"
assert_not_contains "exec vitest related --run"

# A source edit co-changed with a test file in the same package keeps the full
# suite — any non-source path inside the package disqualifies scoping (b).
run_gate "ui-dashboard/src/lib/scope-probe.ts" "ui-dashboard/src/lib/scope-probe.test.ts"
assert_contains "- pnpm --filter @mento-protocol/ui-dashboard test:coverage"
assert_not_contains "exec vitest related --run"

# 16+ changed paths → too broad to scope; full suite (a).
scope_probe_paths=()
for scope_probe_i in $(seq 1 16); do
  scope_probe_paths+=("ui-dashboard/src/lib/scope-probe-$scope_probe_i.ts")
done
run_gate "${scope_probe_paths[@]}"
assert_contains "- pnpm --filter @mento-protocol/ui-dashboard test:coverage"
assert_not_contains "exec vitest related --run"

# A test-infra change anywhere disables scoping globally (e).
run_gate "ui-dashboard/src/lib/scope-probe.ts" "scripts/envio-schema-stubs.graphql"
assert_contains "- pnpm --filter @mento-protocol/ui-dashboard test:coverage"
assert_not_contains "exec vitest related --run"

# Escape hatch: --full-local-tests forces the full suite for a lone source edit.
: > "$paths_file"
printf 'ui-dashboard/src/lib/scope-probe.ts\n' > "$paths_file"
AGENT_QUALITY_ALLOW_PACKAGE_SCRIPT_CHANGES=false \
  scripts/agent-quality-gate.sh \
  --changed-paths-file "$paths_file" \
  --base origin/test \
  --full-local-tests \
  > "$output_file"
assert_contains "- pnpm --filter @mento-protocol/ui-dashboard test:coverage"
assert_not_contains "exec vitest related --run"

# Escape hatch: AGENT_GATE_FULL_TESTS=1 forces the full suite too.
: > "$paths_file"
printf 'ui-dashboard/src/lib/scope-probe.ts\n' > "$paths_file"
AGENT_QUALITY_ALLOW_PACKAGE_SCRIPT_CHANGES=false \
  AGENT_GATE_FULL_TESTS=1 \
  scripts/agent-quality-gate.sh \
  --changed-paths-file "$paths_file" \
  --base origin/test \
  > "$output_file"
assert_contains "- pnpm --filter @mento-protocol/ui-dashboard test:coverage"
assert_not_contains "exec vitest related --run"

assert_hermetic_setup_routes() {
  local path="$1"
  local package_name="$2"
  local reason="$3"

  run_gate "$path"
  assert_contains "- node scripts/check-hermetic-vitest-setup.mjs (hermetic Vitest setup changed)"
  assert_contains "- pnpm --filter $package_name typecheck ($reason)"
  assert_contains "- pnpm --filter $package_name test:coverage ($reason (coverage floor))"
}

assert_hermetic_setup_routes \
  "alerts/infra/oncall-announcer/vitest.hermetic-setup.ts" \
  "@mento-protocol/alerts-oncall-announcer" \
  "alerts oncall-announcer hermetic Vitest setup changed"

assert_hermetic_setup_routes \
  "alerts/infra/onchain-event-handler/vitest.hermetic-setup.ts" \
  "@mento-protocol/alerts-onchain-event-handler" \
  "alerts onchain-event-handler hermetic Vitest setup changed"

assert_hermetic_setup_routes \
  "governance-watchdog/vitest.hermetic-setup.ts" \
  "@mento-protocol/governance-watchdog" \
  "governance-watchdog hermetic Vitest setup changed"

assert_hermetic_setup_routes \
  "indexer-envio/vitest.hermetic-setup.ts" \
  "@mento-protocol/indexer-envio" \
  "indexer-envio hermetic Vitest setup changed"
assert_contains "- pnpm indexer:codegen (indexer-envio hermetic Vitest setup changed (codegen needed before indexer typecheck))"

assert_hermetic_setup_routes \
  "integration-probes/vitest.hermetic-setup.ts" \
  "@mento-protocol/integration-probes" \
  "integration-probes hermetic Vitest setup changed"

assert_hermetic_setup_routes \
  "metrics-bridge/vitest.hermetic-setup.ts" \
  "@mento-protocol/metrics-bridge" \
  "metrics-bridge hermetic Vitest setup changed"

assert_hermetic_setup_routes \
  "shared-config/vitest.hermetic-setup.ts" \
  "@mento-protocol/config" \
  "shared-config hermetic Vitest setup changed"

assert_hermetic_setup_routes \
  "ui-dashboard/vitest.hermetic-setup.ts" \
  "@mento-protocol/ui-dashboard" \
  "ui-dashboard hermetic Vitest setup changed"

run_gate "ui-dashboard/vitest.config.ts"
assert_contains "- node scripts/check-hermetic-vitest-setup.mjs (hermetic Vitest config changed)"

run_gate "metrics-bridge/vitest.config.ts"
assert_contains "- node scripts/check-hermetic-vitest-setup.mjs (hermetic Vitest config changed)"

run_gate "indexer-envio/vitest.config.ts"
assert_contains "- node scripts/check-hermetic-vitest-setup.mjs (hermetic Vitest config changed)"

run_gate "bootstrap-worktree.sh"
assert_contains "- bash -n bootstrap-worktree.sh (shell script changed)"

run_gate "scripts/deploy-indexer.sh"
assert_contains "- bash -n scripts/deploy-indexer.sh (shell script changed)"
assert_contains "- node scripts/check-deploy-root-anchors.test.mjs (deploy wrapper changed)"

run_gate "scripts/deploy-indexer-status.sh"
assert_contains "- bash -n scripts/deploy-indexer-status.sh (shell script changed)"
assert_contains "- node scripts/check-deploy-root-anchors.test.mjs (deploy wrapper changed)"

run_gate "scripts/deploy-indexer-verify.mjs"
assert_contains "- pnpm lint:scripts (root build script changed)"
assert_contains "- node scripts/deploy-indexer-verify.test.mjs (indexer deploy verifier changed)"

run_gate "scripts/deploy-indexer-verify.test.mjs"
assert_contains "- pnpm lint:scripts (root build script changed)"
assert_contains "- node scripts/deploy-indexer-verify.test.mjs (indexer deploy verifier changed)"

run_gate "scripts/deploy-indexer-perf.mjs"
assert_contains "- pnpm lint:scripts (root build script changed)"
assert_contains "- node scripts/deploy-indexer-perf.test.mjs (indexer deploy perf helper changed)"

run_gate "scripts/deploy-indexer-perf.test.mjs"
assert_contains "- pnpm lint:scripts (root build script changed)"
assert_contains "- node scripts/deploy-indexer-perf.test.mjs (indexer deploy perf helper changed)"

run_gate "scripts/deploy-bridge.sh"
assert_contains "- docs/pr-checklists/terraform-cloudrun.md (Cloud Run deploy script changed)"
assert_occurrences 1 "- bash -n scripts/deploy-bridge.sh (shell script changed)"
assert_contains "- node scripts/check-deploy-root-anchors.test.mjs (deploy wrapper changed)"

run_gate "scripts/check-deploy-root-anchors.test.mjs"
assert_contains "- pnpm lint:scripts (root build script changed)"
assert_contains "- node scripts/check-deploy-root-anchors.test.mjs (deploy root-anchor test changed)"

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
assert_contains "- node scripts/check-github-action-pins.mjs (Trunk workflow/action setup changed)"
assert_contains "- pnpm agent:quality-gate:test (agent quality gate trunk hook changed)"
assert_contains "- ./tools/trunk check --all (changed paths require full-repo Trunk checks)"
assert_not_contains "- pnpm --filter @mento-protocol/ui-dashboard typecheck"

# .shellcheckrc disables/options apply repo-wide, so a targeted single-file
# Trunk check on it alone is a no-op; the gate must additionally route to a
# full ShellCheck-only scan (see trunk_requires_shellcheck_full_scan) or a
# future disable/option change here could pass local checks without
# re-validating the scripts it governs.
run_gate ".shellcheckrc"
assert_contains "- tooling"
assert_contains "- ./tools/trunk check --all --filter=shellcheck (ShellCheck config changed; re-validate every script it governs)"
assert_not_contains "- ./tools/trunk check --all ("

run_gate "turbo.json"
assert_contains "- tooling"
assert_contains "- pnpm agent:quality-gate:test (turbo task config changed)"

run_gate "terraform.stacks.json"
assert_contains "- terraform"
assert_contains "- pnpm tf:test (Terraform stack registry changed)"
assert_contains "- TF_DATA_DIR=terraform/.terraform-agent-gate node scripts/terraform-fmt-check.mjs terraform (Terraform stack registry changed)"
assert_contains "- TF_DATA_DIR=alerts/rules/.terraform-agent-gate node scripts/terraform-fmt-check.mjs alerts/rules (Terraform stack registry changed)"
assert_contains "- TF_DATA_DIR=alerts/infra/.terraform-agent-gate node scripts/terraform-fmt-check.mjs alerts/infra (Terraform stack registry changed)"
assert_contains "- TF_DATA_DIR=aegis/terraform/.terraform-agent-gate node scripts/terraform-fmt-check.mjs aegis/terraform (Terraform stack registry changed)"

run_gate "scripts/tf-stacks.mjs"
assert_contains "- pnpm tf:test (Terraform stack wrapper changed)"
assert_contains "- TF_DATA_DIR=terraform/.terraform-agent-gate node scripts/terraform-fmt-check.mjs terraform (Terraform stack wrapper changed)"
assert_contains "- TF_DATA_DIR=alerts/rules/.terraform-agent-gate node scripts/terraform-fmt-check.mjs alerts/rules (Terraform stack wrapper changed)"
assert_contains "- TF_DATA_DIR=alerts/infra/.terraform-agent-gate node scripts/terraform-fmt-check.mjs alerts/infra (Terraform stack wrapper changed)"
assert_contains "- TF_DATA_DIR=aegis/terraform/.terraform-agent-gate node scripts/terraform-fmt-check.mjs aegis/terraform (Terraform stack wrapper changed)"

run_gate "scripts/terraform-fmt-check.mjs"
assert_contains "- node scripts/terraform-fmt-check.test.mjs (Terraform format helper changed)"
assert_contains "- pnpm tf:test (Terraform format helper changed)"
assert_contains "- TF_DATA_DIR=terraform/.terraform-agent-gate node scripts/terraform-fmt-check.mjs terraform (Terraform format helper changed)"
assert_contains "- TF_DATA_DIR=alerts/rules/.terraform-agent-gate node scripts/terraform-fmt-check.mjs alerts/rules (Terraform format helper changed)"
assert_contains "- TF_DATA_DIR=alerts/infra/.terraform-agent-gate node scripts/terraform-fmt-check.mjs alerts/infra (Terraform format helper changed)"
assert_contains "- TF_DATA_DIR=aegis/terraform/.terraform-agent-gate node scripts/terraform-fmt-check.mjs aegis/terraform (Terraform format helper changed)"
assert_contains "- TF_DATA_DIR=governance-watchdog/infra/.terraform-agent-gate node scripts/terraform-fmt-check.mjs governance-watchdog/infra (Terraform format helper changed)"

run_gate "scripts/terraform-fmt-check.test.mjs"
assert_contains "- node scripts/terraform-fmt-check.test.mjs (Terraform format helper test changed)"

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
  printf 'fixture\n' > fixture.txt
  mkdir -p tools
  cat > tools/trunk <<'STUB'
#!/usr/bin/env bash
echo "[RPC_FAILURE] expected fixture failure that should stay quiet"
echo "successful command noise that should stay quiet"
STUB
  chmod +x tools/trunk
  git add .
  git commit -qm init
  printf 'changed\n' >> fixture.txt
  "$repo_root/scripts/agent-quality-gate.sh" --base HEAD --run > "$output_file" 2>&1
)
quiet_success_durations_file="$quiet_success_repo/.tmp/agent-quality-gate/durations.jsonl"
[[ -f "$quiet_success_durations_file" ]] ||
  fail "expected durations file to exist: $quiet_success_durations_file"
quiet_success_last_duration_line="$(tail -n1 "$quiet_success_durations_file")"
node -e '
  const parsed = JSON.parse(process.argv[1]);
  if (parsed.command !== "__run_total__") {
    process.exit(1);
  }
' -- "$quiet_success_last_duration_line" ||
  fail "expected last durations.jsonl line to be __run_total__, got: $quiet_success_last_duration_line"
rm -rf "$quiet_success_repo"
assert_contains "+ ./tools/trunk check fixture.txt"
assert_contains "Command elapsed-time summary:"
assert_contains "- ok "
assert_not_contains "expected fixture failure that should stay quiet"
assert_not_contains "successful command noise that should stay quiet"

parallel_quality_repo="$(mktemp -d)"
(
  cd "$parallel_quality_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  mkdir -p bin scripts tools
  printf 'console.log("fixture");\n' > scripts/agent-prewarm.mjs
  cat > tools/trunk <<'STUB'
#!/usr/bin/env bash
marker="${PARALLEL_MARKER:?}"
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if [[ -f "$marker" ]]; then
    exit 0
  fi
  sleep 0.05
done
echo "parallel marker was not created while trunk was running"
exit 1
STUB
  cat > bin/pnpm <<'STUB'
#!/usr/bin/env bash
: > "${PARALLEL_MARKER:?}"
sleep 0.1
STUB
  chmod +x bin/pnpm tools/trunk
  git add .
  git commit -qm init
  printf 'scripts/agent-prewarm.mjs\n' > changed-paths.txt
  PARALLEL_MARKER="$parallel_quality_repo/parallel-marker" \
    PATH="$parallel_quality_repo/bin:$PATH" \
    "$repo_root/scripts/agent-quality-gate.sh" \
      --changed-paths-file changed-paths.txt \
      --base HEAD \
      --run \
      --parallel 4 \
      > "$output_file" 2>&1
)
rm -rf "$parallel_quality_repo"
assert_contains "Running quality commands with parallelism 4."
assert_contains "+ ./tools/trunk check scripts/agent-prewarm.mjs"
assert_contains "+ pnpm lint:scripts"
assert_contains "+ pnpm agent:prewarm:test"
assert_contains "All mapped commands passed."
assert_not_contains "parallel marker was not created"

autoreview_progress_repo="$(mktemp -d)"
(
  cd "$autoreview_progress_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  mkdir -p bin scripts tools
  cat > scripts/agent-autoreview.test.sh <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
/bin/sleep 0.1
printf '%s\n' \
  'AUTOREVIEW_TEST_PROGRESS family=target-selection elapsed=1s' \
  'AUTOREVIEW_TEST_PROGRESS family=adapter elapsed=2s'
echo 'successful autoreview noise that should stay quiet'
/bin/sleep 2
printf '%s\n' \
  'AUTOREVIEW_TEST_TIMING family=target-selection status=ok elapsed=3s' \
  'AUTOREVIEW_TEST_TIMING family=adapter status=ok elapsed=4s'
STUB
  cat > tools/trunk <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  cat > bin/pnpm <<'STUB'
#!/usr/bin/env bash
if [[ "$*" == agent:autoreview:test* ]]; then
  /bin/bash scripts/agent-autoreview.test.sh
fi
STUB
  # Advance the gate's clock by 30 seconds per read so the 20-second heartbeat
  # can be exercised without adding 20 real seconds to this regression suite.
  cat > bin/date <<'STUB'
#!/usr/bin/env bash
if [[ "$*" != "+%s" ]]; then
  exec /bin/date "$@"
fi
lock_dir="${DATE_COUNTER_FILE:?}.lock"
while ! mkdir "$lock_dir" 2>/dev/null; do
  /bin/sleep 0.01
done
trap 'rmdir "$lock_dir"' EXIT
value=0
if [[ -f "$DATE_COUNTER_FILE" ]]; then
  value="$(cat "$DATE_COUNTER_FILE")"
else
  value="$(/bin/date +%s)"
fi
value=$((value + 30))
printf '%s\n' "$value" > "$DATE_COUNTER_FILE"
printf '%s\n' "$value"
STUB
  chmod +x bin/date bin/pnpm scripts/agent-autoreview.test.sh tools/trunk
  git add .
  git commit -qm init
  printf 'scripts/agent-autoreview.test.sh\n' > changed-paths.txt
  DATE_COUNTER_FILE="$autoreview_progress_repo/date-counter" \
    PATH="$autoreview_progress_repo/bin:$PATH" \
    "$repo_root/scripts/agent-quality-gate.sh" \
      --changed-paths-file changed-paths.txt \
      --base HEAD \
      --run \
      --parallel 4 \
      > "$output_file" 2>&1
)
assert_contains "AUTOREVIEW_TEST_PROGRESS family=adapter elapsed=2s"
assert_not_contains "AUTOREVIEW_TEST_PROGRESS family=target-selection elapsed=1s"
assert_contains "AUTOREVIEW_TEST_TIMING family=target-selection status=ok elapsed=3s"
assert_contains "AUTOREVIEW_TEST_TIMING family=adapter status=ok elapsed=4s"
assert_not_contains "successful autoreview noise that should stay quiet"

for sequential_mode in parallel-one fail-fast; do
  sequential_args=(--fail-fast)
  if [[ "$sequential_mode" == parallel-one ]]; then
    sequential_args=(--parallel 1)
  fi
  (
    cd "$autoreview_progress_repo"
    # This block re-runs the same unchanged fixture to exercise the progress
    # monitor; per-command reuse (issue #1410) would otherwise skip the
    # autoreview test on later runs, so drop the stamps to force re-execution.
    rm -f "$autoreview_progress_repo/.tmp/agent-quality-gate/command-stamps.tsv"
    DATE_COUNTER_FILE="$autoreview_progress_repo/date-counter" \
      PATH="$autoreview_progress_repo/bin:$PATH" \
      "$repo_root/scripts/agent-quality-gate.sh" \
        --changed-paths-file changed-paths.txt \
        --base HEAD \
        --run \
        "${sequential_args[@]}" \
        > "$output_file" 2>&1
  )
  assert_contains "AUTOREVIEW_TEST_PROGRESS family=adapter elapsed=2s"
  assert_contains "AUTOREVIEW_TEST_TIMING family=adapter status=ok elapsed=4s"
  assert_not_contains "successful autoreview noise that should stay quiet"
done

(
  cd "$autoreview_progress_repo"
  cat > scripts/agent-autoreview.test.sh <<'STUB'
#!/usr/bin/env bash
echo 'AUTOREVIEW_TEST_PROGRESS family=runtime-trust elapsed=5s'
echo 'AUTOREVIEW_TEST_TIMING family=runtime-trust status=failed elapsed=6s'
echo 'complete autoreview failure diagnostic'
exit 7
STUB
  chmod +x scripts/agent-autoreview.test.sh
  set +e
  DATE_COUNTER_FILE="$autoreview_progress_repo/date-counter" \
    PATH="$autoreview_progress_repo/bin:$PATH" \
    "$repo_root/scripts/agent-quality-gate.sh" \
      --changed-paths-file changed-paths.txt \
      --base HEAD \
      --run \
      --parallel 4 \
      > "$output_file" 2>&1
  exit_code=$?
  set -e
  [[ "$exit_code" -ne 0 ]] ||
    fail "gate did not fail when the autoreview test command failed"
)
assert_contains "AUTOREVIEW_TEST_PROGRESS family=runtime-trust elapsed=5s"
assert_contains "AUTOREVIEW_TEST_TIMING family=runtime-trust status=failed elapsed=6s"
assert_contains "complete autoreview failure diagnostic"

(
  cd "$autoreview_progress_repo"
  cat > scripts/agent-autoreview.test.sh <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$$" > "${AUTOREVIEW_TEST_PID_FILE:?}"
echo 'AUTOREVIEW_TEST_PROGRESS family=adapter elapsed=7s'
sleep 30
STUB
  chmod +x scripts/agent-autoreview.test.sh
  autoreview_pid_file="$autoreview_progress_repo/autoreview-child-pid"
  gate_output_fifo="$autoreview_progress_repo/gate-output.fifo"
  rm -f "$autoreview_pid_file" "$gate_output_fifo"
  mkfifo "$gate_output_fifo"
  cat "$gate_output_fifo" > "$output_file" &
  output_reader_pid=$!
  AUTOREVIEW_TEST_PID_FILE="$autoreview_pid_file" \
    DATE_COUNTER_FILE="$autoreview_progress_repo/date-counter" \
    PATH="$autoreview_progress_repo/bin:$PATH" \
    "$repo_root/scripts/agent-quality-gate.sh" \
      --changed-paths-file changed-paths.txt \
      --base HEAD \
      --run \
      --parallel 1 \
      > "$gate_output_fifo" 2>&1 &
  gate_pid=$!
  launched=0
  for _ in {1..200}; do
    if [[ -s "$autoreview_pid_file" ]]; then
      launched=1
      break
    fi
    if ! kill -0 "$gate_pid" 2>/dev/null; then
      break
    fi
    sleep 0.05
  done
  if [[ "$launched" -ne 1 ]]; then
    kill -KILL "$gate_pid" 2>/dev/null || true
    wait "$gate_pid" 2>/dev/null || true
    kill -KILL "$output_reader_pid" 2>/dev/null || true
    wait "$output_reader_pid" 2>/dev/null || true
    fail "sequential autoreview cancellation fixture did not launch"
  fi

  kill -KILL "$gate_pid"
  wait "$gate_pid" 2>/dev/null || true
  kill -KILL "$(cat "$autoreview_pid_file")" 2>/dev/null || true
  reader_exited=0
  for _ in {1..100}; do
    if ! kill -0 "$output_reader_pid" 2>/dev/null; then
      reader_exited=1
      break
    fi
    sleep 0.05
  done
  if [[ "$reader_exited" -ne 1 ]]; then
    kill -KILL "$output_reader_pid" 2>/dev/null || true
    wait "$output_reader_pid" 2>/dev/null || true
    fail "sequential autoreview progress monitor survived its killed gate parent"
  fi
  wait "$output_reader_pid" 2>/dev/null || true
  rm -f "$gate_output_fifo"
)
rm -rf "$autoreview_progress_repo"

serialized_repo_mutation_repo="$(mktemp -d)"
(
  cd "$serialized_repo_mutation_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  mkdir -p bin scripts tools
  cat > scripts/agent-quality-gate.sh <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  cat > scripts/agent-autoreview.sh <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  cat > scripts/agent-autoreview.test.sh <<'STUB'
#!/usr/bin/env bash
if [[ ! -f "${SERIAL_MUTATION_MARKER:?}" ]]; then
  echo "autoreview test overlapped the repo-mutating quality-gate self-test"
  exit 1
fi
STUB
  cat > tools/trunk <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
cat > bin/pnpm <<'STUB'
#!/usr/bin/env bash
case "$*" in
  "agent:quality-gate:test")
    sleep 0.2
    : > "${SERIAL_MUTATION_MARKER:?}"
    ;;
  agent:autoreview:test*)
    /bin/bash scripts/agent-autoreview.test.sh
    ;;
esac
STUB
  chmod +x bin/pnpm scripts/agent-autoreview.sh scripts/agent-autoreview.test.sh scripts/agent-quality-gate.sh tools/trunk
  git add .
  git commit -qm init
  printf '%s\n' \
    "scripts/agent-autoreview.sh" \
    "scripts/agent-quality-gate.sh" \
    > changed-paths.txt
  SERIAL_MUTATION_MARKER="$serialized_repo_mutation_repo/serial-marker" \
    PATH="$serialized_repo_mutation_repo/bin:$PATH" \
    "$repo_root/scripts/agent-quality-gate.sh" \
      --changed-paths-file changed-paths.txt \
      --base HEAD \
      --run \
      --parallel 4 \
      > "$output_file" 2>&1
)
rm -rf "$serialized_repo_mutation_repo"
assert_contains "+ pnpm agent:quality-gate:test"
assert_contains "+ pnpm agent:autoreview:test"
assert_contains "All mapped commands passed."
assert_not_contains "autoreview test overlapped the repo-mutating quality-gate self-test"

auto_parallel_quality_repo="$(mktemp -d)"
(
  cd "$auto_parallel_quality_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  mkdir -p bin scripts tools
  printf 'console.log("fixture");\n' > scripts/agent-prewarm.mjs
  cat > tools/trunk <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  cat > bin/pnpm <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  cat > bin/getconf <<'STUB'
#!/usr/bin/env bash
if [[ "${1:-}" == "_NPROCESSORS_ONLN" ]]; then
  echo 8
  exit 0
fi
exit 1
STUB
  chmod +x bin/getconf bin/pnpm tools/trunk
  git add .
  git commit -qm init
  printf 'scripts/agent-prewarm.mjs\n' > changed-paths.txt
  PATH="$auto_parallel_quality_repo/bin:$PATH" \
    "$repo_root/scripts/agent-quality-gate.sh" \
      --changed-paths-file changed-paths.txt \
      --base HEAD \
      --run \
      > "$output_file" 2>&1
)
rm -rf "$auto_parallel_quality_repo"
assert_contains "Running quality commands with parallelism 4."
assert_contains "All mapped commands passed."

quality_setup_repo="$(mktemp -d)"
(
  cd "$quality_setup_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  mkdir -p bin shared-config/src tools
  printf 'export const fixture = true;\n' > shared-config/src/config.ts
  cat > tools/trunk <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  cat > bin/pnpm <<'STUB'
#!/usr/bin/env bash
args="$*"
case "$args" in
  "--filter @mento-protocol/config build")
    sleep 0.2
    : > "${BUILD_MARKER:?}"
    ;;
  "--filter @mento-protocol/ui-dashboard typecheck")
    if [[ ! -f "${BUILD_MARKER:?}" ]]; then
      echo "consumer typecheck started before shared-config build"
      exit 1
    fi
    ;;
esac
STUB
  chmod +x bin/pnpm tools/trunk
  git add .
  git commit -qm init
  printf 'shared-config/src/config.ts\n' > changed-paths.txt
  BUILD_MARKER="$quality_setup_repo/build-marker" \
    PATH="$quality_setup_repo/bin:$PATH" \
    "$repo_root/scripts/agent-quality-gate.sh" \
      --changed-paths-file changed-paths.txt \
      --base HEAD \
      --run \
      --parallel 8 \
      > "$output_file" 2>&1
)
rm -rf "$quality_setup_repo"
assert_contains "+ pnpm --filter @mento-protocol/config build"
grep -Fq -- "+ pnpm --filter @mento-protocol/ui-dashboard typecheck" "$output_file" ||
  fail "expected direct shared-config consumer typecheck to run"
assert_contains "All mapped commands passed."
assert_not_contains "consumer typecheck started before shared-config build"

dashboard_serial_repo="$(mktemp -d)"
(
  cd "$dashboard_serial_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  mkdir -p bin tools ui-dashboard/src/app
  printf 'export default function Page() { return null; }\n' > ui-dashboard/src/app/page.tsx
  cat > tools/trunk <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  cat > bin/pnpm <<'STUB'
#!/usr/bin/env bash
args="$*"
case "$args" in
  exec\ turbo\ run\ test:browser*|exec\ turbo\ run\ size-limit*)
    if [[ "$args" == exec\ turbo\ run\ size-limit* && "${VERCEL_DEPLOYMENT_ID:-}" != "local-quality-gate" ]]; then
      echo "size-limit did not receive the gate-owned deployment identity"
      exit 1
    fi
    if ! mkdir "${DASHBOARD_NEXT_LOCK:?}"; then
      echo "dashboard .next command overlapped"
      exit 1
    fi
    sleep 0.2
    rmdir "$DASHBOARD_NEXT_LOCK"
    ;;
esac
STUB
  chmod +x bin/pnpm tools/trunk
  git add .
  git commit -qm init
  printf 'ui-dashboard/src/app/page.tsx\n' > changed-paths.txt
  DASHBOARD_NEXT_LOCK="$dashboard_serial_repo/next-lock" \
    PATH="$dashboard_serial_repo/bin:$PATH" \
    "$repo_root/scripts/agent-quality-gate.sh" \
      --changed-paths-file changed-paths.txt \
      --base HEAD \
      --run \
      --parallel 8 \
      > "$output_file" 2>&1
)
rm -rf "$dashboard_serial_repo"
assert_contains "+ pnpm exec turbo run test:browser --filter=@mento-protocol/ui-dashboard --cache=local:rw"
assert_contains "+ VERCEL_DEPLOYMENT_ID=local-quality-gate pnpm exec turbo run size-limit --filter=@mento-protocol/ui-dashboard --cache=local:rw"
assert_contains "All mapped commands passed."
assert_not_contains "dashboard .next command overlapped"

dashboard_setup_failure_repo="$(mktemp -d)"
(
  cd "$dashboard_setup_failure_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  mkdir -p bin tools ui-dashboard
  printf 'fixture\n' > ui-dashboard/README.md
  cat > tools/trunk <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  cat > bin/pnpm <<'STUB'
#!/usr/bin/env bash
args="$*"
case "$args" in
  --filter\ @mento-protocol/ui-dashboard\ exec\ playwright\ install\ chromium)
    echo "chromium install unavailable"
    exit 1
    ;;
  exec\ turbo\ run\ lint*|exec\ turbo\ run\ typecheck*|exec\ turbo\ run\ knip*|--filter\ @mento-protocol/ui-dashboard\ test:coverage|code-health:deps)
    printf 'ran\n' >> "${QUALITY_MARKER:?}"
    ;;
esac
STUB
  chmod +x bin/pnpm tools/trunk
  git add .
  git commit -qm init
  printf 'ui-dashboard/README.md\n' > changed-paths.txt
  if QUALITY_MARKER="$dashboard_setup_failure_repo/.tmp/quality-ran" \
    PATH="$dashboard_setup_failure_repo/bin:$PATH" \
    "$repo_root/scripts/agent-quality-gate.sh" \
      --changed-paths-file changed-paths.txt \
      --base HEAD \
      --run \
      --parallel 8 \
      > "$output_file" 2>&1; then
    fail "gate did not fail when dashboard Chromium install failed"
  fi
  [[ -f "$dashboard_setup_failure_repo/.tmp/quality-ran" ]] ||
    fail "independent quality pool did not run after dashboard Chromium install failed"
)
rm -rf "$dashboard_setup_failure_repo"
assert_contains "chromium install unavailable"
assert_contains "Running quality commands with parallelism 8."

fresh_stamp_repo="$(mktemp -d)"
(
  cd "$fresh_stamp_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  printf 'fixture\n' > fixture.txt
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
  printf 'changed\n' >> fixture.txt
  # Warm WITH --allow-package-script-changes; the skip run below passes NO such
  # flag (like the pre-push hook). With no package-script risk they must still
  # share a freshness stamp, so the flag-less run skips (allowPackageScripts is
  # folded out of the stamp when packageRisk is false).
  COUNTER_FILE="$fresh_stamp_repo/.tmp/agent-quality-gate/trunk-count" \
    "$repo_root/scripts/agent-quality-gate.sh" --base "$base_ref" --run --allow-package-script-changes > "$output_file" 2>&1
  git add fixture.txt
  git commit -qm "commit validated content"
  stamp_file="$fresh_stamp_repo/.tmp/agent-quality-gate/last-success.stamp"
  stamp_value="$(sed -n '2s/^stamp=//p' "$stamp_file")"
  printf 'created_at=%s\nstamp=%s\n' \
    "$(( $(date +%s) - 60 * 60 ))" \
    "$stamp_value" \
    > "$stamp_file"
  COUNTER_FILE="$fresh_stamp_repo/.tmp/agent-quality-gate/trunk-count" \
    "$repo_root/scripts/agent-quality-gate.sh" --base "$base_ref" --run --skip-if-fresh >> "$output_file" 2>&1
  [[ "$(cat "$fresh_stamp_repo/.tmp/agent-quality-gate/trunk-count")" == "1" ]] ||
    fail "one-hour-old exact gate stamp did not skip flag-less run after allow-flag warm"
  grep -Fq -- "Previous successful agent quality gate run is still fresh; skipping mapped commands." "$output_file" ||
    fail "one-hour-old exact gate stamp did not report a freshness skip"

  printf 'created_at=%s\nstamp=%s\n' \
    "$(( $(date +%s) - 2 * 60 * 60 - 1 ))" \
    "$stamp_value" \
    > "$stamp_file"
  : > "$output_file"
  COUNTER_FILE="$fresh_stamp_repo/.tmp/agent-quality-gate/trunk-count" \
    "$repo_root/scripts/agent-quality-gate.sh" --base "$base_ref" --run --skip-if-fresh >> "$output_file" 2>&1
  [[ "$(cat "$fresh_stamp_repo/.tmp/agent-quality-gate/trunk-count")" == "2" ]] ||
    fail "gate reused an exact success stamp older than the hard two-hour cap"
)
rm -rf "$fresh_stamp_repo"
assert_not_contains "Previous successful agent quality gate run is still fresh; skipping mapped commands."

# Workflow changes add the ADR reminder command, whose execution argument uses
# a randomized changed-paths scratch file. That volatile path must be
# normalized out of the command-plan hash or an identical pre-push run can
# never reuse the fresh success stamp.
workflow_fresh_stamp_repo="$(mktemp -d)"
(
  cd "$workflow_fresh_stamp_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  mkdir -p .github/workflows bin tools
  printf 'name: Metrics Bridge\n' > .github/workflows/metrics-bridge.yml
  cat > tools/trunk <<'STUB'
#!/usr/bin/env bash
counter_file="${COUNTER_FILE:?}"
count=0
if [[ -f "$counter_file" ]]; then
  count="$(cat "$counter_file")"
fi
printf '%s\n' "$((count + 1))" > "$counter_file"
STUB
  cat > bin/node <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  cat > bin/pnpm <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  chmod +x bin/node bin/pnpm tools/trunk
  git add .
  git commit -qm init
  base_ref="$(git rev-parse --verify HEAD)"
  printf '# changed\n' >> .github/workflows/metrics-bridge.yml
  COUNTER_FILE="$workflow_fresh_stamp_repo/.tmp/agent-quality-gate/trunk-count" \
    PATH="$workflow_fresh_stamp_repo/bin:$PATH" \
    "$repo_root/scripts/agent-quality-gate.sh" --base "$base_ref" --run > "$output_file" 2>&1
  COUNTER_FILE="$workflow_fresh_stamp_repo/.tmp/agent-quality-gate/trunk-count" \
    PATH="$workflow_fresh_stamp_repo/bin:$PATH" \
    "$repo_root/scripts/agent-quality-gate.sh" --base "$base_ref" --run --skip-if-fresh >> "$output_file" 2>&1
  [[ "$(cat "$workflow_fresh_stamp_repo/.tmp/agent-quality-gate/trunk-count")" == "1" ]] ||
    fail "workflow fresh stamp changed with randomized changed-paths scratch file"
)
rm -rf "$workflow_fresh_stamp_repo"
assert_contains "Previous successful agent quality gate run is still fresh; skipping mapped commands."

package_risk_fresh_stamp_repo="$(mktemp -d)"
(
  cd "$package_risk_fresh_stamp_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  mkdir -p bin tools
  printf 'fixture\n' > fixture.txt
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
  cat > bin/pnpm <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  chmod +x bin/pnpm tools/trunk
  git add .
  git commit -qm init
  printf 'packages/fixture/package.json\n' > changed-paths.txt
  COUNTER_FILE="$package_risk_fresh_stamp_repo/.tmp/agent-quality-gate/trunk-count" \
    PATH="$package_risk_fresh_stamp_repo/bin:$PATH" \
    "$repo_root/scripts/agent-quality-gate.sh" \
      --changed-paths-file changed-paths.txt \
      --base HEAD \
      --run \
      --allow-package-script-changes \
      > "$output_file" 2>&1
  COUNTER_FILE="$package_risk_fresh_stamp_repo/.tmp/agent-quality-gate/trunk-count" \
    PATH="$package_risk_fresh_stamp_repo/bin:$PATH" \
    "$repo_root/scripts/agent-quality-gate.sh" \
      --changed-paths-file changed-paths.txt \
      --base HEAD \
      --run \
      --skip-if-fresh \
      --allow-package-script-changes \
      >> "$output_file" 2>&1
  [[ "$(cat "$package_risk_fresh_stamp_repo/.tmp/agent-quality-gate/trunk-count")" == "1" ]] ||
    fail "fresh gate stamp did not skip duplicate package-risk run"
  grep -Fq -- "Previous successful agent quality gate run is still fresh; skipping mapped commands." "$output_file" ||
    fail "acknowledged duplicate package-risk run did not reuse its exact stamp"

  : > "$output_file"
  if COUNTER_FILE="$package_risk_fresh_stamp_repo/.tmp/agent-quality-gate/trunk-count" \
    PATH="$package_risk_fresh_stamp_repo/bin:$PATH" \
    "$repo_root/scripts/agent-quality-gate.sh" \
      --changed-paths-file changed-paths.txt \
      --base HEAD \
      --run \
      --skip-if-fresh \
      > "$output_file" 2>&1; then
    fail "unacknowledged package-risk run reused an acknowledged success stamp"
  fi
  [[ "$(cat "$package_risk_fresh_stamp_repo/.tmp/agent-quality-gate/trunk-count")" == "1" ]] ||
    fail "unacknowledged package-risk run executed mapped commands"
)
rm -rf "$package_risk_fresh_stamp_repo"
assert_contains "Refusing to run because package manifests, patches, or lockfile changed."
assert_not_contains "Previous successful agent quality gate run is still fresh; skipping mapped commands."

# A failed ORDERED prerequisite phase (here the preflight `pnpm install`) must
# stop the run before the parallel quality pool executes. Prerequisite phases
# (preflight / codegen / quality-setup) run fail-fast even though the pre-push
# hook drops global --fail-fast, so a failed install stops before its
# dependents; only the independent quality pool keeps going.
abort_prereq_repo="$(mktemp -d)"
(
  cd "$abort_prereq_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  mkdir -p bin tools
  printf 'fixture\n' > README.md
  # Marks that the quality pool ran; it must NOT run if a prerequisite failed.
  cat > tools/trunk <<'STUB'
#!/usr/bin/env bash
printf 'ran\n' > "${QUALITY_MARKER:?}"
STUB
  # Fail the preflight install; succeed for every other pnpm invocation.
  cat > bin/pnpm <<'STUB'
#!/usr/bin/env bash
case "$*" in
  *install*) exit 1 ;;
  *) exit 0 ;;
esac
STUB
  chmod +x bin/pnpm tools/trunk
  git add .
  git commit -qm init
  printf 'packages/fixture/package.json\n' > changed-paths.txt
  if QUALITY_MARKER="$abort_prereq_repo/.tmp/quality-ran" \
    PATH="$abort_prereq_repo/bin:$PATH" \
    "$repo_root/scripts/agent-quality-gate.sh" \
      --changed-paths-file changed-paths.txt \
      --base HEAD \
      --run \
      --parallel 3 \
      --allow-package-script-changes \
      > "$output_file" 2>&1; then
    fail "gate did not fail when the preflight prerequisite failed"
  fi
  [[ ! -f "$abort_prereq_repo/.tmp/quality-ran" ]] ||
    fail "quality pool ran despite a failed prerequisite phase"
)
rm -rf "$abort_prereq_repo"
assert_contains "Stopping after first failed mapped command (--fail-fast)."

stale_stamp_repo="$(mktemp -d)"
(
  cd "$stale_stamp_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  printf 'fixture\n' > fixture.txt
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
  printf 'changed\n' >> fixture.txt
  COUNTER_FILE="$stale_stamp_repo/.tmp/agent-quality-gate/trunk-count" \
    "$repo_root/scripts/agent-quality-gate.sh" --base "$base_ref" --run > "$output_file" 2>&1
  printf 'changed again\n' >> fixture.txt
  COUNTER_FILE="$stale_stamp_repo/.tmp/agent-quality-gate/trunk-count" \
    "$repo_root/scripts/agent-quality-gate.sh" --base "$base_ref" --run --skip-if-fresh >> "$output_file" 2>&1
  [[ "$(cat "$stale_stamp_repo/.tmp/agent-quality-gate/trunk-count")" == "2" ]] ||
    fail "fresh gate stamp was reused after worktree content changed"
)
rm -rf "$stale_stamp_repo"
assert_not_contains "Previous successful agent quality gate run is still fresh; skipping mapped commands."

# Extending the reuse window must not weaken any exact-signature binding. Use
# equal-tree base commits to isolate the base OID, then change the validation
# path/command plan and the fixture's gate implementation independently. Every
# change must execute the mapped command again instead of reusing the stamp.
signature_stamp_repo="$(mktemp -d)"
(
  cd "$signature_stamp_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  mkdir -p scripts tools
  printf 'fixture\n' > fixture.txt
  printf 'second fixture\n' > second.txt
  printf '# fixture gate implementation\n' > scripts/agent-quality-gate.sh
  cat > tools/trunk <<'STUB'
#!/usr/bin/env bash
counter_file="${COUNTER_FILE:?}"
count=0
if [[ -f "$counter_file" ]]; then
  count="$(cat "$counter_file")"
fi
printf '%s\n' "$((count + 1))" > "$counter_file"
STUB
  chmod +x tools/trunk
  git add .
  git commit -qm init
  base_one="$(git rev-parse --verify HEAD)"
  git commit --allow-empty -qm "equal-tree alternate base"
  base_two="$(git rev-parse --verify HEAD)"
  printf 'changed\n' >> fixture.txt
  printf 'fixture.txt\n' > changed-paths-one.txt
  printf 'fixture.txt\nsecond.txt\n' > changed-paths-two.txt

  COUNTER_FILE="$signature_stamp_repo/.tmp/agent-quality-gate/trunk-count" \
    "$repo_root/scripts/agent-quality-gate.sh" \
      --changed-paths-file changed-paths-one.txt \
      --base "$base_one" \
      --run \
      > "$output_file" 2>&1
  COUNTER_FILE="$signature_stamp_repo/.tmp/agent-quality-gate/trunk-count" \
    "$repo_root/scripts/agent-quality-gate.sh" \
      --changed-paths-file changed-paths-one.txt \
      --base "$base_two" \
      --run \
      --skip-if-fresh \
      > "$output_file" 2>&1
  [[ "$(cat "$signature_stamp_repo/.tmp/agent-quality-gate/trunk-count")" == "2" ]] ||
    fail "fresh gate stamp was reused after the base OID changed"

  COUNTER_FILE="$signature_stamp_repo/.tmp/agent-quality-gate/trunk-count" \
    "$repo_root/scripts/agent-quality-gate.sh" \
      --changed-paths-file changed-paths-two.txt \
      --base "$base_two" \
      --run \
      --skip-if-fresh \
      > "$output_file" 2>&1
  [[ "$(cat "$signature_stamp_repo/.tmp/agent-quality-gate/trunk-count")" == "3" ]] ||
    fail "fresh gate stamp was reused after the validation path/command plan changed"

  printf '# changed fixture gate implementation\n' >> scripts/agent-quality-gate.sh
  COUNTER_FILE="$signature_stamp_repo/.tmp/agent-quality-gate/trunk-count" \
    "$repo_root/scripts/agent-quality-gate.sh" \
      --changed-paths-file changed-paths-two.txt \
      --base "$base_two" \
      --run \
      --skip-if-fresh \
      > "$output_file" 2>&1
  [[ "$(cat "$signature_stamp_repo/.tmp/agent-quality-gate/trunk-count")" == "4" ]] ||
    fail "fresh gate stamp was reused after the gate implementation changed"
)
rm -rf "$signature_stamp_repo"
assert_not_contains "Previous successful agent quality gate run is still fresh; skipping mapped commands."

sha256sum_repo="$(mktemp -d)"
(
  cd "$sha256sum_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  printf 'fixture\n' > fixture.txt
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
  printf 'changed\n' >> fixture.txt
  SHA256SUM_COUNTER_FILE="$sha256sum_repo/sha256sum-count" \
    PATH="$sha256sum_repo/bin:$PATH" \
    "$repo_root/scripts/agent-quality-gate.sh" --base HEAD --run > "$output_file" 2>&1
  [[ -s "$sha256sum_repo/sha256sum-count" ]] ||
    fail "gate did not use sha256sum when it was available"
)
rm -rf "$sha256sum_repo"
assert_contains "+ ./tools/trunk check fixture.txt"

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
assert_contains "Refusing to run because package manifests, patches, or lockfile changed."
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
assert_contains "- pnpm docs:index --check (tracked documentation changed)"
assert_contains "- ./tools/trunk check docs/deployment.md (changed existing paths should pass targeted Trunk checks)"
assert_not_contains "- ./tools/trunk check --all"

run_gate "docs/pr-checklists/recurring-review-patterns.md"
assert_contains "- docs"
assert_contains "- pnpm agent:context-check (agent context standards changed)"

run_gate "SPEC.md"
assert_contains "- docs"
assert_contains "- pnpm docs:index --check (tracked documentation changed)"
assert_contains "- pnpm agent:context-check (technical specification changed)"

run_gate "aegis/README.md"
assert_contains "- docs"
assert_contains "- pnpm docs:index --check (tracked documentation changed)"
assert_contains "- pnpm agent:context-check (README metadata may enroll canonical context)"

run_gate "ui-dashboard/AGENTS.md"
assert_contains "- pnpm docs:index --check (tracked documentation changed)"
assert_contains "- pnpm agent:context-budget --strict (agent instruction budget input changed)"

run_gate ".codex/config.toml"
assert_contains "- agent-context"
assert_contains "- pnpm agent:context-budget --strict (agent instruction budget input changed)"

# Any docs markdown may carry canonical: true frontmatter (discovery in
# check-agent-context.mjs), so a discovered doc path must route through the
# context check locally, not just in CI.
run_gate "docs/terraform.md"
assert_contains "- docs"
assert_contains "- pnpm agent:context-check (docs markdown may be canonical (frontmatter discovery))"

run_gate ".codex/hooks.json"
assert_contains "- agent-context"
assert_contains "- pnpm agent:context-check (agent context files changed)"

set +e
AGENT_CONTEXT_CODEX_HOOKS_FILE="$codex_hooks_fixture" \
  node scripts/check-agent-context.mjs > "$output_file" 2>&1
unscoped_override_status=$?
set -e
[[ "$unscoped_override_status" -ne 0 ]] ||
  fail "expected an unscoped test input override to fail"
assert_contains "AGENT_CONTEXT_CODEX_HOOKS_FILE: test-only override requires NODE_ENV=test"

: > "$codex_hooks_fixture"
run_context_check_expect_failure
assert_contains ".codex/hooks.json: invalid JSON"
restore_hook_configs

AGENT_CONTEXT_CODEX_HOOKS_FILE="$codex_hooks_fixture" node - <<'NODE'
const fs = require("node:fs");
const file = process.env.AGENT_CONTEXT_CODEX_HOOKS_FILE;
const hooks = JSON.parse(fs.readFileSync(file, "utf8"));
hooks.hooks.SessionEnd[0].hooks[0].command =
  "bash -lc 'echo git rev-parse --show-toplevel && echo scripts/agent-session-end-hook.sh'";
fs.writeFileSync(file, `${JSON.stringify(hooks, null, 2)}\n`);
NODE
run_context_check_expect_failure
assert_contains ".codex/hooks.json: expected SessionEnd command to execute scripts/agent-session-end-hook.sh via resolved repo root"
restore_hook_configs

run_gate ".claude/settings.json"
assert_contains "- agent-context"
assert_contains "- pnpm agent:context-check (agent context files changed)"

: > "$claude_settings_fixture"
run_context_check_expect_failure
assert_contains ".claude/settings.json: invalid JSON"
restore_hook_configs

AGENT_CONTEXT_CLAUDE_SETTINGS_FILE="$claude_settings_fixture" node - <<'NODE'
const fs = require("node:fs");
const file = process.env.AGENT_CONTEXT_CLAUDE_SETTINGS_FILE;
const settings = JSON.parse(fs.readFileSync(file, "utf8"));
settings.hooks.SessionEnd[0].hooks[0].command =
  "echo ${CLAUDE_PROJECT_DIR}/scripts/agent-session-end-hook.sh";
fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
NODE
run_context_check_expect_failure
assert_contains '.claude/settings.json: expected SessionEnd command to execute quoted ${CLAUDE_PROJECT_DIR}/scripts/agent-session-end-hook.sh with bash'
restore_hook_configs

append_claude_allow "Bash(until *)"
run_context_check_expect_failure
assert_contains ".claude/settings.json: permissions.allow must not allow shell-loop commands: Bash(until *)"
restore_hook_configs

append_claude_allow "Bash(bash scripts/*)"
run_context_check_expect_failure
assert_contains ".claude/settings.json: unexpected bash scripts allow: Bash(bash scripts/*)"
restore_hook_configs

append_claude_allow "Bash(bash ./scripts/*)"
run_context_check_expect_failure
assert_contains ".claude/settings.json: unexpected bash scripts allow: Bash(bash ./scripts/*)"
restore_hook_configs

append_claude_allow "Bash(bash ./scripts/deploy-dashboard.sh:*)"
run_context_check_expect_failure
assert_contains ".claude/settings.json: must not allow deploy/promote scripts: Bash(bash ./scripts/deploy-dashboard.sh:*)"
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
assert_contains "- pnpm --filter @mento-protocol/config knip (knip config changed)"
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
assert_contains "- pnpm --filter @mento-protocol/config lint (ESLint baseline wrapper changed)"
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

run_gate "scripts/sentry-triage-digest.mjs"
assert_contains "- pnpm sentry:digest:test (Sentry triage digest helper changed)"

run_gate "scripts/sentry-triage-digest.test.mjs"
assert_contains "- pnpm sentry:digest:test (Sentry triage digest helper changed)"

run_gate "scripts/sentry-triage-project.mjs"
assert_contains "- pnpm sentry:project:test (Sentry triage projection helper changed)"

run_gate "scripts/sentry-triage-project-core.mjs"
assert_contains "- pnpm sentry:project:test (Sentry triage projection helper changed)"

run_gate "scripts/sentry-triage-project.test.mjs"
assert_contains "- pnpm sentry:project:test (Sentry triage projection helper changed)"

run_gate "scripts/sentry-triage-archive.mjs"
assert_contains "- pnpm sentry:archive:test (Sentry triage archive helper changed)"

run_gate "scripts/sentry-triage-archive.test.mjs"
assert_contains "- pnpm sentry:archive:test (Sentry triage archive helper changed)"

run_gate "scripts/sanitize-terraform-output.sh"
assert_contains "- pnpm sanitize:test (Terraform output sanitizer changed)"

run_gate "scripts/sanitize-terraform-output.test.mjs"
assert_contains "- pnpm sanitize:test (Terraform output sanitizer test changed)"

run_gate "scripts/review-materiality.mjs"
assert_contains "- pnpm agent:review-materiality:test (agent review materiality helper changed)"

run_gate "scripts/review-materiality-context.mjs"
assert_contains "- pnpm agent:review-materiality:test (agent review materiality helper changed)"

run_gate "scripts/review-materiality.test.mjs"
assert_contains "- pnpm agent:review-materiality:test (agent review materiality helper changed)"

run_gate "scripts/review-process-metrics.mjs"
assert_contains "- node scripts/review-process-metrics.test.mjs (review-process metrics collector changed)"

run_gate "scripts/review-process-metrics.test.mjs"
assert_contains "- node scripts/review-process-metrics.test.mjs (review-process metrics collector changed)"

run_gate "scripts/agent-issue-board.mjs"
assert_contains "- pnpm issue:board:test (agent issue board helper changed)"

run_gate "scripts/agent-issue-board.test.mjs"
assert_contains "- pnpm issue:board:test (agent issue board helper changed)"

run_gate "scripts/version-skew-check.mjs"
assert_contains "- pnpm skew:check:test (version skew checker changed)"

run_gate "scripts/version-skew-check.test.mjs"
assert_contains "- pnpm skew:check:test (version skew checker changed)"

run_gate "scripts/check-hermetic-vitest-setup.mjs"
assert_contains "- pnpm lint:scripts (root build script changed)"
assert_contains "- node scripts/check-hermetic-vitest-setup.mjs (hermetic Vitest setup checker changed)"
assert_contains "- node scripts/check-hermetic-vitest-setup.test.mjs (hermetic Vitest setup checker changed)"

run_gate "scripts/check-hermetic-vitest-setup.test.mjs"
assert_contains "- pnpm lint:scripts (root build script changed)"
assert_contains "- node scripts/check-hermetic-vitest-setup.mjs (hermetic Vitest setup checker changed)"
assert_contains "- node scripts/check-hermetic-vitest-setup.test.mjs (hermetic Vitest setup checker changed)"

run_gate "scripts/check-github-action-pins.mjs"
assert_contains "- node scripts/check-github-action-pins.mjs (GitHub Actions pin checker changed)"
assert_contains "- node scripts/check-github-action-pins.test.mjs (GitHub Actions pin checker changed)"

run_gate "scripts/check-github-action-pins.test.mjs"
assert_contains "- node scripts/check-github-action-pins.test.mjs (GitHub Actions pin checker test changed)"

run_gate "scripts/alert-rules-lint.mjs"
assert_contains "- pnpm alerts:rules:lint:test (alert-rules lint helper changed)"

run_gate "scripts/alert-rules-lint.test.mjs"
assert_contains "- pnpm alerts:rules:lint:test (alert-rules lint helper changed)"

run_gate "scripts/check-pr-description.mjs"
assert_contains "- node scripts/check-pr-description.test.mjs (PR description validator changed)"

run_gate "scripts/check-pr-description.test.mjs"
assert_contains "- node scripts/check-pr-description.test.mjs (PR description validator changed)"

run_gate "scripts/agent-autoreview.mjs"
assert_contains "- pnpm lint:scripts (root build script changed)"
assert_contains "- pnpm agent:autoreview:test (agent autoreview helper changed)"

run_gate "scripts/agent-autoreview-core.mjs"
assert_contains "- pnpm lint:scripts (root build script changed)"
assert_contains "- pnpm agent:autoreview:test (agent autoreview helper changed)"

run_gate "scripts/agent-autoreview-core.test.mjs"
assert_contains "- pnpm lint:scripts (root build script changed)"
assert_contains "- pnpm agent:autoreview:test (agent autoreview helper changed)"

run_gate "scripts/agent-autoreview-target-guard.test.mjs"
assert_contains "- pnpm lint:scripts (root build script changed)"
assert_contains "- pnpm agent:autoreview:test (agent autoreview helper changed)"

run_gate "scripts/check-agent-context.mjs"
assert_contains "- pnpm agent:context-check (agent context checker changed)"
assert_contains "- node scripts/check-agent-context.test.mjs (agent context checker changed)"

run_gate "scripts/check-agent-context-helpers.mjs"
assert_contains "- pnpm agent:context-check (agent context checker changed)"
assert_contains "- node scripts/check-agent-context.test.mjs (agent context checker changed)"

run_gate "scripts/check-agent-context.test.mjs"
assert_contains "- pnpm agent:context-check (agent context checker changed)"
assert_contains "- node scripts/check-agent-context.test.mjs (agent context checker changed)"

run_gate "scripts/docs-index.mjs"
assert_contains "- pnpm docs:index:test (documentation catalog helper changed)"
assert_contains "- pnpm docs:index --check (documentation catalog helper changed)"
assert_contains "- pnpm agent:context-check (documentation catalog metadata contract changed)"

run_gate "scripts/docs-index-helpers.mjs"
assert_contains "- pnpm docs:index:test (documentation catalog helper changed)"

run_gate "scripts/docs-index.test.mjs"
assert_contains "- pnpm docs:index:test (documentation catalog helper changed)"

run_gate "scripts/docs-audit.mjs"
assert_contains "- pnpm docs:audit:test (documentation audit planner changed)"
assert_contains "- pnpm docs:audit --dry-run (documentation audit planner changed)"
assert_contains "- pnpm docs:index --check (documentation audit planner consumes the catalog)"

run_gate "scripts/docs-audit-helpers.mjs"
assert_contains "- pnpm docs:audit:test (documentation audit planner changed)"

run_gate "scripts/docs-audit.test.mjs"
assert_contains "- pnpm docs:audit:test (documentation audit planner changed)"

run_gate "scripts/docs-garden-issue.mjs"
assert_contains "- pnpm docs:garden:test (documentation garden issue automation changed)"
assert_contains "- pnpm docs:audit --dry-run (documentation garden issue automation consumes the planner)"
assert_contains "- pnpm docs:index --check (documentation garden issue automation consumes the catalog)"

run_gate "scripts/docs-garden-issue-helpers.mjs"
assert_contains "- pnpm docs:garden:test (documentation garden issue automation changed)"

run_gate "scripts/docs-garden-issue.test.mjs"
assert_contains "- pnpm docs:garden:test (documentation garden issue automation changed)"

run_gate "scripts/docs-navigation-eval.mjs"
assert_contains "- pnpm docs:navigation-eval:test (documentation navigation evaluation changed)"
assert_contains "- pnpm docs:navigation-eval -- --check-fixtures (documentation navigation evaluation changed)"
assert_contains "- pnpm docs:navigation-eval -- --validate docs/evals/documentation-navigation-baseline.json (documentation navigation evaluation changed)"
assert_contains "- pnpm docs:index --check (documentation navigation evaluation consumes the catalog)"

run_gate "scripts/docs-navigation-eval-helpers.mjs"
assert_contains "- pnpm docs:navigation-eval:test (documentation navigation evaluation changed)"

run_gate "scripts/docs-navigation-eval-result.mjs"
assert_contains "- pnpm docs:navigation-eval:test (documentation navigation evaluation changed)"

run_gate "scripts/docs-navigation-eval.test.mjs"
assert_contains "- pnpm docs:navigation-eval:test (documentation navigation evaluation changed)"

run_gate "docs/evals/documentation-navigation-fixtures.json"
assert_contains "- pnpm docs:navigation-eval:test (documentation navigation evaluation contract changed)"
assert_contains "- pnpm docs:navigation-eval -- --check-fixtures (documentation navigation evaluation contract changed)"
assert_contains "- pnpm docs:navigation-eval -- --validate docs/evals/documentation-navigation-baseline.json (documentation navigation evaluation contract changed)"

run_gate "docs/evals/documentation-navigation-2026-08-post-garden.json"
assert_contains "- pnpm docs:navigation-eval:test (documentation navigation evaluation contract changed)"
assert_contains "- pnpm docs:navigation-eval -- --validate docs/evals/documentation-navigation-baseline.json (documentation navigation evaluation contract changed)"

run_gate "docs/evals/documentation-navigation-baseline.json"
assert_contains "- pnpm docs:navigation-eval:test (documentation navigation baseline changed)"
assert_contains "- pnpm docs:navigation-eval -- --validate docs/evals/documentation-navigation-baseline.json (documentation navigation baseline changed)"

run_gate "scripts/agent-context-budget.mjs"
assert_contains "- pnpm agent:context-budget:test (agent context budget helper changed)"
assert_contains "- pnpm agent:context-budget --strict (agent context budget helper changed)"

run_gate "scripts/agent-context-budget.test.mjs"
assert_contains "- pnpm agent:context-budget:test (agent context budget helper changed)"

run_gate "scripts/check-deviation-threshold-drift.mjs"
assert_contains "- node scripts/check-deviation-threshold-drift.mjs (deviation threshold drift checker changed)"
assert_contains "- node scripts/check-deviation-threshold-drift.test.mjs (deviation threshold drift checker changed)"

run_gate "scripts/check-deviation-threshold-drift.test.mjs"
assert_contains "- node scripts/check-deviation-threshold-drift.test.mjs (deviation threshold drift checker test changed)"

run_gate "scripts/verify-github-environment-protection.mjs"
assert_contains "- node scripts/verify-github-environment-protection.test.mjs (GitHub environment protection checker changed)"

run_gate "scripts/verify-github-environment-protection.test.mjs"
assert_contains "- node scripts/verify-github-environment-protection.test.mjs (GitHub environment protection checker changed)"

run_gate "scripts/agent-autoreview.sh"
assert_contains "- pnpm agent:autoreview:test (agent autoreview adapter changed)"

run_gate "scripts/agent-autoreview.test.sh"
assert_contains "- pnpm agent:autoreview:test (agent autoreview adapter changed)"

run_gate "scripts/dev-janitor.sh"
assert_contains "- bash scripts/dev-janitor.test.sh (dev janitor script changed)"

run_gate "scripts/dev-janitor.test.sh"
assert_contains "- bash scripts/dev-janitor.test.sh (dev janitor script changed)"

# Other root-script changes only need the standalone scripts ESLint.
run_gate "scripts/code-health-history.mjs"
assert_contains "- pnpm lint:scripts (root build script changed)"
assert_not_contains "(ESLint baseline wrapper changed)"

# Root ESLint config changes trigger scripts lint.
run_gate "eslint.config.mjs"
assert_contains "- pnpm lint:scripts (root build script changed)"

# GitHub issue #1410: a run that fails on one flaky command must, on rerun,
# reuse the commands that already passed against unchanged content instead of
# re-executing them. `pnpm lint:scripts` appends a side-effect line every time
# it runs; it must run exactly once across a failing run plus a passing rerun.
command_stamp_resume_repo="$(mktemp -d)"
(
  cd "$command_stamp_resume_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  mkdir -p bin scripts tools
  printf 'console.log("fixture");\n' > scripts/agent-prewarm.mjs
  cat > tools/trunk <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  cat > bin/pnpm <<'STUB'
#!/usr/bin/env bash
case "$*" in
  "lint:scripts")
    printf 'ran\n' >> "${LINT_SIDE_EFFECT:?}"
    ;;
  "agent:prewarm:test")
    if [[ -f "${PREWARM_FAIL_FLAG:?}" ]]; then
      echo "prewarm intentional failure"
      exit 1
    fi
    ;;
esac
STUB
  chmod +x bin/pnpm tools/trunk
  git add .
  git commit -qm init
  printf 'scripts/agent-prewarm.mjs\n' > changed-paths.txt
  : > "$command_stamp_resume_repo/prewarm-fail"
  set +e
  LINT_SIDE_EFFECT="$command_stamp_resume_repo/lint-side-effect" \
    PREWARM_FAIL_FLAG="$command_stamp_resume_repo/prewarm-fail" \
    PATH="$command_stamp_resume_repo/bin:$PATH" \
    "$repo_root/scripts/agent-quality-gate.sh" \
      --changed-paths-file changed-paths.txt \
      --base HEAD \
      --run \
      --parallel 1 \
      > "$output_file" 2>&1
  first_exit=$?
  set -e
  [[ "$first_exit" -ne 0 ]] ||
    fail "expected the first resume run to fail on the flaky command"
  [[ "$(wc -l < "$command_stamp_resume_repo/lint-side-effect" | tr -d ' ')" == "1" ]] ||
    fail "expected lint:scripts to run once on the first resume run"

  rm -f "$command_stamp_resume_repo/prewarm-fail"
  LINT_SIDE_EFFECT="$command_stamp_resume_repo/lint-side-effect" \
    PREWARM_FAIL_FLAG="$command_stamp_resume_repo/prewarm-fail" \
    PATH="$command_stamp_resume_repo/bin:$PATH" \
    "$repo_root/scripts/agent-quality-gate.sh" \
      --changed-paths-file changed-paths.txt \
      --base HEAD \
      --run \
      --parallel 1 \
      > "$output_file" 2>&1
  [[ "$(wc -l < "$command_stamp_resume_repo/lint-side-effect" | tr -d ' ')" == "1" ]] ||
    fail "expected lint:scripts to be reused (not re-run) on the resume rerun"

  # PR 1492 review: the resumed (partially reused) success must NOT write the
  # whole-run fast-path stamp — re-dating reused work would let --skip-if-fresh
  # extend validation reuse past the two-hour ceiling. A third run with
  # --skip-if-fresh therefore still executes/reuses commands instead of
  # whole-run skipping.
  LINT_SIDE_EFFECT="$command_stamp_resume_repo/lint-side-effect" \
    PREWARM_FAIL_FLAG="$command_stamp_resume_repo/prewarm-fail" \
    PATH="$command_stamp_resume_repo/bin:$PATH" \
    "$repo_root/scripts/agent-quality-gate.sh" \
      --changed-paths-file changed-paths.txt \
      --base HEAD \
      --run \
      --parallel 1 \
      --skip-if-fresh \
      > "$command_stamp_resume_repo/third-run-output" 2>&1
  if grep -q "skipping mapped commands" "$command_stamp_resume_repo/third-run-output"; then
    fail "a resumed run's success must not enable the whole-run fast-path skip"
  fi
)
rm -rf "$command_stamp_resume_repo"
assert_raw_contains "↻ pnpm lint:scripts (fresh from previous run)"
assert_raw_contains "- reused 0s pnpm lint:scripts"
assert_contains "+ pnpm agent:prewarm:test"
assert_contains "All mapped commands passed."

# GitHub issue #1410: any content change to a validated file changes the whole-
# run fingerprint, which must invalidate every per-command stamp so the command
# re-executes. `pnpm lint:scripts` runs once on the first success, then again
# after the changed file is edited.
command_stamp_invalidation_repo="$(mktemp -d)"
(
  cd "$command_stamp_invalidation_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  mkdir -p bin scripts tools
  printf 'console.log("fixture");\n' > scripts/agent-prewarm.mjs
  cat > tools/trunk <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  cat > bin/pnpm <<'STUB'
#!/usr/bin/env bash
[[ "$*" == "lint:scripts" ]] && printf 'ran\n' >> "${LINT_SIDE_EFFECT:?}"
exit 0
STUB
  chmod +x bin/pnpm tools/trunk
  git add .
  git commit -qm init
  printf 'scripts/agent-prewarm.mjs\n' > changed-paths.txt
  LINT_SIDE_EFFECT="$command_stamp_invalidation_repo/lint-side-effect" \
    PATH="$command_stamp_invalidation_repo/bin:$PATH" \
    "$repo_root/scripts/agent-quality-gate.sh" \
      --changed-paths-file changed-paths.txt \
      --base HEAD \
      --run \
      --parallel 1 \
      > "$output_file" 2>&1
  [[ "$(wc -l < "$command_stamp_invalidation_repo/lint-side-effect" | tr -d ' ')" == "1" ]] ||
    fail "expected lint:scripts to run once on the first invalidation run"

  printf 'console.log("changed");\n' >> scripts/agent-prewarm.mjs
  LINT_SIDE_EFFECT="$command_stamp_invalidation_repo/lint-side-effect" \
    PATH="$command_stamp_invalidation_repo/bin:$PATH" \
    "$repo_root/scripts/agent-quality-gate.sh" \
      --changed-paths-file changed-paths.txt \
      --base HEAD \
      --run \
      --parallel 1 \
      > "$output_file" 2>&1
  [[ "$(wc -l < "$command_stamp_invalidation_repo/lint-side-effect" | tr -d ' ')" == "2" ]] ||
    fail "expected lint:scripts to re-execute after the changed file was edited"
)
rm -rf "$command_stamp_invalidation_repo"
assert_not_contains "↻ pnpm lint:scripts (fresh from previous run)"

# GitHub issue #1410: the Trunk check and the gate self-test validate repo/gate
# state cheaply and self-referentially, so they must ALWAYS re-execute — never be
# reused from a prior run's stamp — while ordinary commands still reuse.
command_stamp_exempt_repo="$(mktemp -d)"
(
  cd "$command_stamp_exempt_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  mkdir -p bin scripts tools
  printf 'console.log("fixture");\n' > scripts/agent-prewarm.mjs
  printf '#!/usr/bin/env bash\nexit 0\n' > scripts/agent-quality-gate.sh
  cat > tools/trunk <<'STUB'
#!/usr/bin/env bash
printf 'ran\n' >> "${TRUNK_COUNT:?}"
exit 0
STUB
  cat > bin/pnpm <<'STUB'
#!/usr/bin/env bash
case "$*" in
  "lint:scripts") printf 'ran\n' >> "${LINT_SIDE_EFFECT:?}" ;;
  "agent:quality-gate:test") printf 'ran\n' >> "${SELFTEST_COUNT:?}" ;;
esac
exit 0
STUB
  chmod +x bin/pnpm scripts/agent-quality-gate.sh tools/trunk
  git add .
  git commit -qm init
  printf '%s\n' scripts/agent-prewarm.mjs scripts/agent-quality-gate.sh > changed-paths.txt
  for _ in 1 2; do
    TRUNK_COUNT="$command_stamp_exempt_repo/trunk-count" \
      SELFTEST_COUNT="$command_stamp_exempt_repo/selftest-count" \
      LINT_SIDE_EFFECT="$command_stamp_exempt_repo/lint-side-effect" \
      PATH="$command_stamp_exempt_repo/bin:$PATH" \
      "$repo_root/scripts/agent-quality-gate.sh" \
        --changed-paths-file changed-paths.txt \
        --base HEAD \
        --run \
        --parallel 1 \
        > "$output_file" 2>&1
  done
  [[ "$(wc -l < "$command_stamp_exempt_repo/trunk-count" | tr -d ' ')" == "2" ]] ||
    fail "expected the Trunk check to re-run on every gate run (never reused)"
  [[ "$(wc -l < "$command_stamp_exempt_repo/selftest-count" | tr -d ' ')" == "2" ]] ||
    fail "expected the gate self-test to re-run on every gate run (never reused)"
  [[ "$(wc -l < "$command_stamp_exempt_repo/lint-side-effect" | tr -d ' ')" == "1" ]] ||
    fail "expected an ordinary command to be reused on the second run"
)
rm -rf "$command_stamp_exempt_repo"
assert_raw_contains "↻ pnpm lint:scripts (fresh from previous run)"
assert_not_contains "↻ pnpm agent:quality-gate:test"
assert_not_contains "↻ ./tools/trunk check"

# GitHub issue #1410: no mapped command may hang forever. A command that sleeps
# past --command-timeout is killed (whole process tree) and reported as a normal
# failure that names the command and the timeout, leaving no background process.
command_timeout_repo="$(mktemp -d)"
(
  cd "$command_timeout_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  mkdir -p bin scripts tools
  printf 'console.log("fixture");\n' > scripts/agent-prewarm.mjs
  cat > tools/trunk <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  # A distinctively-named victim so pgrep can prove the tree was reaped. The
  # parent exits on TERM while its child ignores TERM (PR 1492 review): the
  # watchdog must snapshot the tree before TERM and KILL the saved list, or
  # the reparented child survives the escalation.
  cat > bin/qg-timeout-orphan <<'STUB'
#!/usr/bin/env bash
trap '' TERM
while :; do sleep 1; done
STUB
  cat > bin/qg-timeout-victim <<'STUB'
#!/usr/bin/env bash
trap 'exit 0' TERM
qg-timeout-orphan &
sleep 45 &
wait
STUB
  cat > bin/pnpm <<'STUB'
#!/usr/bin/env bash
if [[ "$*" == "agent:prewarm:test" ]]; then
  exec qg-timeout-victim
fi
exit 0
STUB
  chmod +x bin/pnpm bin/qg-timeout-victim bin/qg-timeout-orphan tools/trunk
  git add .
  git commit -qm init
  printf 'scripts/agent-prewarm.mjs\n' > changed-paths.txt
  set +e
  PATH="$command_timeout_repo/bin:$PATH" \
    "$repo_root/scripts/agent-quality-gate.sh" \
      --changed-paths-file changed-paths.txt \
      --base HEAD \
      --run \
      --parallel 1 \
      --command-timeout 2 \
      > "$output_file" 2>&1
  timeout_exit=$?
  set -e
  [[ "$timeout_exit" -ne 0 ]] ||
    fail "expected the gate to fail when a mapped command exceeded --command-timeout"
  # TERM lands at ~2s; give the KILL backstop a moment, then assert no leak.
  sleep 4
  if pgrep -f "qg-timeout-victim" >/dev/null 2>&1; then
    pkill -KILL -f "qg-timeout-victim" 2>/dev/null || true
    fail "timed-out command left a leaked background process"
  fi
  if pgrep -f "qg-timeout-orphan" >/dev/null 2>&1; then
    pkill -KILL -f "qg-timeout-orphan" 2>/dev/null || true
    fail "timed-out command's TERM-ignoring child escaped the watchdog KILL pass"
  fi
)
rm -rf "$command_timeout_repo"
assert_raw_contains "Command timed out after 2s: pnpm agent:prewarm:test"

# GitHub issue #1410: a manual interrupt (TERM sent to the gate process) must
# escalate to KILL exactly like the timeout watchdog, so a SIGTERM-ignoring
# mapped command cannot survive an interactive Ctrl-C/TERM teardown. The TERM
# below targets ONLY the gate's pid — never a process group — so the test
# suite itself is not signalled.
command_interrupt_repo="$(mktemp -d)"
(
  cd "$command_interrupt_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  mkdir -p bin scripts tools
  printf 'console.log("fixture");\n' > scripts/agent-prewarm.mjs
  cat > tools/trunk <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  # Ignores TERM and respawns its sleep child each second, so only the KILL
  # escalation can reap it.
  cat > bin/qg-interrupt-victim <<'STUB'
#!/usr/bin/env bash
trap '' TERM
while :; do sleep 1; done
STUB
  cat > bin/pnpm <<'STUB'
#!/usr/bin/env bash
if [[ "$*" == "agent:prewarm:test" ]]; then
  exec qg-interrupt-victim
fi
exit 0
STUB
  chmod +x bin/pnpm bin/qg-interrupt-victim tools/trunk
  git add .
  git commit -qm init
  printf 'scripts/agent-prewarm.mjs\n' > changed-paths.txt
  set +e
  PATH="$command_interrupt_repo/bin:$PATH" \
    "$repo_root/scripts/agent-quality-gate.sh" \
      --changed-paths-file changed-paths.txt \
      --base HEAD \
      --run \
      --parallel 1 \
      > "$output_file" 2>&1 &
  gate_pid=$!
  waited=0
  until pgrep -f "qg-interrupt-victim" >/dev/null 2>&1; do
    sleep 1
    waited=$((waited + 1))
    if [[ "$waited" -ge 20 ]]; then
      kill -KILL "$gate_pid" 2>/dev/null
      pkill -KILL -f "qg-interrupt-victim" 2>/dev/null
      fail "interrupt fixture never started its victim"
    fi
  done
  kill -TERM "$gate_pid" 2>/dev/null
  wait "$gate_pid"
  interrupt_exit=$?
  set -e
  [[ "$interrupt_exit" -ne 0 ]] ||
    fail "expected the gate to exit nonzero when interrupted by TERM"
  # The trap teardown TERMs immediately, then KILLs after its 3s grace.
  sleep 5
  if pgrep -f "qg-interrupt-victim" >/dev/null 2>&1; then
    pkill -KILL -f "qg-interrupt-victim" 2>/dev/null || true
    fail "interrupted gate left a SIGTERM-ignoring process running"
  fi
)
rm -rf "$command_interrupt_repo"

# PR 1492 review: with --parallel greater than 1 the timed commands' pids live
# only inside the worker subshells, so the parent's interrupt teardown must
# signal the tracked worker pids (active_worker_pids) or a SIGTERM-ignoring
# mapped command survives the gate's death. TERM targets ONLY the gate pid.
parallel_interrupt_repo="$(mktemp -d)"
(
  cd "$parallel_interrupt_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  mkdir -p bin scripts tools
  printf 'console.log("fixture");\n' > scripts/agent-prewarm.mjs
  printf 'console.log("fixture");\n' > scripts/agent-context-budget.mjs
  cat > tools/trunk <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  cat > bin/qg-par-victim <<'STUB'
#!/usr/bin/env bash
trap '' TERM
while :; do sleep 1; done
STUB
  cat > bin/pnpm <<'STUB'
#!/usr/bin/env bash
if [[ "$*" == "agent:prewarm:test" ]]; then
  exec qg-par-victim
fi
if [[ "$*" == "agent:context-budget:test" ]]; then
  exec sleep 45
fi
exit 0
STUB
  chmod +x bin/pnpm bin/qg-par-victim tools/trunk
  git add .
  git commit -qm init
  printf 'scripts/agent-prewarm.mjs\nscripts/agent-context-budget.mjs\n' > changed-paths.txt
  set +e
  PATH="$parallel_interrupt_repo/bin:$PATH" \
    "$repo_root/scripts/agent-quality-gate.sh" \
      --changed-paths-file changed-paths.txt \
      --base HEAD \
      --run \
      --parallel 2 \
      > "$output_file" 2>&1 &
  gate_pid=$!
  waited=0
  until pgrep -f "qg-par-victim" >/dev/null 2>&1; do
    sleep 1
    waited=$((waited + 1))
    if [[ "$waited" -ge 20 ]]; then
      kill -KILL "$gate_pid" 2>/dev/null
      pkill -KILL -f "qg-par-victim" 2>/dev/null
      fail "parallel interrupt fixture never started its victim"
    fi
  done
  kill -TERM "$gate_pid" 2>/dev/null
  wait "$gate_pid"
  parallel_interrupt_exit=$?
  set -e
  [[ "$parallel_interrupt_exit" -ne 0 ]] ||
    fail "expected the gate to exit nonzero when interrupted during the parallel pool"
  sleep 5
  if pgrep -f "qg-par-victim" >/dev/null 2>&1; then
    pkill -KILL -f "qg-par-victim" 2>/dev/null || true
    fail "interrupted parallel gate left a SIGTERM-ignoring worker command running"
  fi
)
rm -rf "$parallel_interrupt_repo"

# PR 1492 review: prerequisite commands (install/codegen/setup) produce outputs
# the source fingerprint cannot see, so they must never be stamped or reused —
# two identical successful runs execute the preflight install twice, while a
# stampable quality command is reused on the second run.
prereq_reuse_repo="$(mktemp -d)"
(
  cd "$prereq_reuse_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  mkdir -p bin scripts sub tools
  printf '{"name":"sub"}\n' > sub/package.json
  printf 'process.exit(0);\n' > scripts/check-adr-reminder.mjs
  cat > tools/trunk <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  cat > bin/pnpm <<'STUB'
#!/usr/bin/env bash
if [[ "$*" == "install --frozen-lockfile" ]]; then
  echo run >> "$INSTALL_SIDE_EFFECT"
  exit 0
fi
if [[ "$*" == "skew:check" ]]; then
  echo run >> "$SKEW_SIDE_EFFECT"
  exit 0
fi
exit 0
STUB
  chmod +x bin/pnpm tools/trunk
  git add .
  git commit -qm init
  printf 'sub/package.json\n' > changed-paths.txt
  for _ in 1 2; do
    INSTALL_SIDE_EFFECT="$prereq_reuse_repo/install-side-effect" \
      SKEW_SIDE_EFFECT="$prereq_reuse_repo/skew-side-effect" \
      PATH="$prereq_reuse_repo/bin:$PATH" \
      "$repo_root/scripts/agent-quality-gate.sh" \
        --changed-paths-file changed-paths.txt \
        --base HEAD \
        --run \
        --parallel 1 \
        --allow-package-script-changes \
        > "$output_file" 2>&1 ||
      fail "prerequisite-reuse fixture run failed unexpectedly"
  done
  [[ "$(wc -l < "$prereq_reuse_repo/install-side-effect" | tr -d ' ')" == "2" ]] ||
    fail "expected the preflight install to run on BOTH runs (prerequisites are never reused)"
  [[ "$(wc -l < "$prereq_reuse_repo/skew-side-effect" | tr -d ' ')" == "1" ]] ||
    fail "expected the quality command to be reused on the second run"
)
rm -rf "$prereq_reuse_repo"

echo "agent quality gate tests passed"
