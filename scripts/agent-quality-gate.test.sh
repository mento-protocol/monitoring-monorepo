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
# command on stdout (some CI captures drop stderr) and dump the in-flight
# gate output, which usually holds the actual error.
#
# Bash resets the ERR trap on entry to a shell function and every test lives in
# one, so arming is a helper that each family calls on entry as well. `set -E`
# would arm it globally, but it also fires inside the fixture subshells and
# command substitutions that run failing commands on purpose — output this
# suite never had, and which a capture would swallow.
#
# The trap is armed before the scratch files exist, so it must survive a failure
# in between: under `set -u` a bare $output_file there kills the handler with an
# unbound-variable error instead of printing what died.
arm_suite_abort_trap() {
  trap 'echo "agent-quality-gate test suite aborted: line $LINENO: $BASH_COMMAND (exit $?)"; echo "Last gate output (tail):"; tail -40 "${output_file:-/dev/null}" 2>/dev/null | sed "s/^/  /"' ERR
}
arm_suite_abort_trap

# This suite's own path, resolved before the cd below moves the ground under a
# relative BASH_SOURCE. verify_gate_family_partition reads the file itself, so
# it needs a path that survives the move and names no location of its own.
gate_test_suite_source="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

# Every fixture gate run below drives `--run` against a throwaway repo. None of
# them is the machine's real gate, so none should queue behind one — or make a
# real one queue behind them (GitHub issue #1802). The lock tests near the end
# re-enable exclusion explicitly against their own lock directory.
export AGENT_QUALITY_GATE_LOCK=0

paths_file="$(mktemp)"
output_file="$(mktemp)"
gate_cache_dir="$(mktemp -d)"
turbo_facts_file="$(mktemp)"
codex_hooks_backup="$(mktemp)"
claude_settings_backup="$(mktemp)"
codex_hooks_fixture="$(mktemp)"
claude_settings_fixture="$(mktemp)"
untracked_skill_artifact=".claude/skills/.agent-quality-gate-test.tmp"
# A real symlink under scripts/ is needed to exercise the gate's `-L` symlink
# routing (Codex 3754355168); the extensionless path is registered for cleanup
# so a failed assertion cannot leave it in the working tree.
sentry_symlink_probe="scripts/.sentry-symlink-probe.test.tmp"
# Finding 3754704280: a change beneath an EXISTING scripts/ directory symlink's
# real target must route the check too. This needs a real directory symlink under
# scripts/ pointing at a repo-relative directory (the gate resolves the target
# with `pwd -P`), so a target dir at the repo root and the link are both
# registered for cleanup.
sentry_symlink_target_dir=".sentry-symlink-target.test.tmp"
sentry_symlink_to_target="scripts/.sentry-symlink-to-target.test.tmp"
cp .codex/hooks.json "$codex_hooks_backup"
cp .claude/settings.json "$claude_settings_backup"
cp "$codex_hooks_backup" "$codex_hooks_fixture"
cp "$claude_settings_backup" "$claude_settings_fixture"

restore_hook_configs() {
  cp "$codex_hooks_backup" "$codex_hooks_fixture"
  cp "$claude_settings_backup" "$claude_settings_fixture"
}

trap 'restore_hook_configs; rm -rf "$gate_cache_dir" "$sentry_symlink_target_dir"; rm -f "$paths_file" "$output_file" "$turbo_facts_file" "$output_file.pnpm-args" "$untracked_skill_artifact" "$sentry_symlink_probe" "$sentry_symlink_to_target" "$codex_hooks_backup" "$claude_settings_backup" "$codex_hooks_fixture" "$claude_settings_fixture"' EXIT

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

# A PID that is dead at the moment a fixture writes it into a lock record.
# Spawning a real child and reaping it is what makes the number dead; asking
# the gate's own two liveness probes about it afterwards is what keeps a
# recycled number from being planted as a "dead" holder. Never a guessed
# number, and never one captured once and reused: PIDs are handed out
# sequentially, so the number just freed here is the last one the allocator
# will return until it wraps the whole PID space — but a capture reused across
# a family that runs for minutes gives a busy CI runner time to wrap onto it,
# and a live runner process planted as a dead holder fails the family it was
# written for (GitHub issue 1919). Call this immediately before each write.
# The residual window is between the check below and the caller's write; it
# takes a full PID-space wrap inside it to matter.
fresh_dead_pid() {
  local candidate
  local attempt=0
  while [[ "$attempt" -lt 20 ]]; do
    attempt=$((attempt + 1))
    sleep 0 &
    candidate=$!
    wait "$candidate" 2>/dev/null || true
    # Both probes, in the order acquire_gate_run_lock asks them: `kill -0` for
    # the common case and `ps` for a live process this user may not signal.
    if ! kill -0 "$candidate" 2>/dev/null &&
      ! ps -p "$candidate" > /dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
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
    node scripts/context/check-agent-context.mjs > "$output_file" 2>&1
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
  local match
  local package_name
  local replacement
  local task_name

  case "$expected" in
    *"pnpm dashboard:build"*)
      expected="${expected/pnpm dashboard:build/pnpm exec turbo run build --filter=@mento-protocol/ui-dashboard --cache=local:rw}"
      ;;
    *"pnpm dashboard:size-limit"*)
      expected="${expected/pnpm dashboard:size-limit/VERCEL_DEPLOYMENT_ID=local-quality-gate pnpm exec turbo run size-limit --filter=@mento-protocol/ui-dashboard --cache=local:rw}"
      ;;
    *"bash ui-dashboard/scripts/check-react-doctor-score.sh"*)
      match="bash ui-dashboard/scripts/check-react-doctor-score.sh"
      replacement="pnpm exec turbo run react-doctor:score --filter=@mento-protocol/ui-dashboard --cache=local:rw"
      expected="${expected/$match/$replacement}"
      ;;
    *"bash ui-dashboard/scripts/check-react-doctor-diff.sh "*)
      local base_ref="${expected#*bash ui-dashboard/scripts/check-react-doctor-diff.sh }"
      base_ref="${base_ref%% *}"
      match="bash ui-dashboard/scripts/check-react-doctor-diff.sh ${base_ref}"
      replacement="REACT_DOCTOR_BASE_REF=${base_ref} REACT_DOCTOR_BASE_CACHE_KEY=__unresolved__:${base_ref} pnpm exec turbo run react-doctor:diff --filter=@mento-protocol/ui-dashboard --cache=local:rw"
      expected="${expected/$match/$replacement}"
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

# ── Family partition (GATE_TEST_FOCUS) ───────────────────────────────────────
# Every test below lives inside exactly one `run_<family>_family` function, and
# nothing but blank lines and comments may sit between those functions. Set
# GATE_TEST_FOCUS to a comma-separated list of family names to run just those
# subjects while iterating; with the variable unset or empty the dispatch at the
# bottom of this file runs every family in file order, which is the sequence
# this suite ran before the partition existed. Adding a test means adding it
# inside the family that owns its subject — see the families' documented
# subjects and docs/notes/agent-quality-gate-mechanics.md.
#
# verify_gate_family_partition reds the suite when a test lands outside a
# family, when a family is missing from the registry, or when the definitions
# drift out of registry order — so a test added without a family cannot
# silently run in none of the focused modes. It runs before the definitions, so
# an unassigned test is caught before it executes, and it covers the file from
# the marker below to the end: past the closing marker exactly one dispatch call
# may run, and nothing else.
#
# The bodies are deliberately NOT re-indented. They carry heredoc fixtures whose
# bytes are asserted, so a mechanical re-indent would rewrite fixture content;
# leaving the columns alone also keeps this partition's diff to its wrapper
# lines, where a reviewer can see that no test moved. The one line added inside
# each family is the `arm_suite_abort_trap` call on its first line, which bash
# requires: it resets the ERR trap on entry to a function.

# ── Family registry ──────────────────────────────────────────────────────────
# The single source of truth for both the dispatch and the structural check
# below: registry order is the file order of the definitions that follow, so an
# unfocused run executes the families in the order this suite has always used.
# Both properties are enforced by verify_gate_family_partition, not assumed.
gate_test_families=(
  gate-contract
  install-wiring
  routing-packaging
  routing-sources
  execution-phases
  stamps-freshness
  failure-output
  routing-docs
  stamps-commands
  execution-parallel
  lock-drain
)

fail_partition() {
  # Same both-streams reporting as fail(), without the gate-output dump: a
  # partition failure is about this file's structure, not about a gate run.
  {
    echo "agent-quality-gate family partition failed: $*"
  } | tee /dev/stderr
  exit 1
}

# Structural completeness. The families' union must be the whole suite body: a
# test line between the body markers that sits outside every family function is
# a test no focused mode would run, and it reds the suite here instead of
# passing quietly. Also pins the definition set and its order against the
# registry. It reads this file rather than the shell's state, so it runs BEFORE
# the family definitions below — an unassigned test never gets to execute.
verify_gate_family_partition() {
  local source_file="$gate_test_suite_source"
  local expected
  local observed
  # Fail closed: a suite that cannot read itself cannot vouch for its partition,
  # and skipping the check is exactly the silence it exists to prevent.
  [[ -f "$source_file" ]] ||
    fail_partition "cannot read this suite's own source at $source_file"
  expected="$(printf '%s\n' "${gate_test_families[@]}")"
  if ! observed="$(
    awk '
      $0 == "# >>> gate family body start" {
        if (previous != "verify_gate_family_partition") {
          printf "line %d must be the verify_gate_family_partition call, not: %s\n", \
            NR - 1, previous > "/dev/stderr"
          failed = 1
          exit 1
        }
        body = 1
        next
      }
      $0 == "# <<< gate family body end" { body = 2; seen_end = 1; next }
      body == 0 { previous = $0; next }
      body == 2 {
        # Past the partition, the suite may only make its one dispatch call —
        # counted, because a second one would run every family twice and a
        # missing one would exit 0 having run nothing. Everything else here
        # would run in every focused mode and, at the bottom of the file, after
        # the success line has been printed.
        if ($0 ~ /^[[:space:]]*$/ || $0 ~ /^[[:space:]]*#/) { next }
        if ($0 == "dispatch_gate_test_families") { dispatch_calls++; next }
        printf "line %d runs outside the family partition: %s\n", NR, $0 > "/dev/stderr"
        failed = 1
        exit 1
      }
      /^run_[a-z0-9_]+_family\(\) \{$/ {
        if (open != "") {
          printf "family %s is still open at line %d\n", open, NR > "/dev/stderr"
          failed = 1
          exit 1
        }
        open = substr($0, 5, length($0) - 15)
        gsub(/_/, "-", open)
        print open
        next
      }
      /^\} # end family: / {
        closing = substr($0, 17)
        if (open == "") {
          printf "family end without a start at line %d\n", NR > "/dev/stderr"
          failed = 1
          exit 1
        }
        if (closing != open) {
          printf "family %s closed as %s at line %d\n", open, closing, NR > "/dev/stderr"
          failed = 1
          exit 1
        }
        open = ""
        next
      }
      open != "" { next }
      /^[[:space:]]*$/ { next }
      /^[[:space:]]*#/ { next }
      {
        printf "line %d belongs to no family: %s\n", NR, $0 > "/dev/stderr"
        failed = 1
        exit 1
      }
      END {
        if (failed == 1) { exit 1 }
        if (open != "") {
          printf "family %s is never closed\n", open > "/dev/stderr"
          exit 1
        }
        if (seen_end != 1) {
          print "the gate family body end marker is missing" > "/dev/stderr"
          exit 1
        }
        if (dispatch_calls != 1) {
          printf "expected exactly one dispatch_gate_test_families call after the body, found %d\n", \
            dispatch_calls > "/dev/stderr"
          exit 1
        }
      }
    ' "$source_file"
  )"; then
    fail_partition "the suite body is not fully covered by the family functions"
  fi
  if [[ "$observed" != "$expected" ]]; then
    printf 'registry (expected) vs definitions (observed):\n' >&2
    diff -u <(printf '%s\n' "$expected") <(printf '%s\n' "$observed") >&2 || true
    fail_partition "the family definitions do not match gate_test_families in order and membership"
  fi
}

# ── Focus dispatch ───────────────────────────────────────────────────────────
# The dispatch is a function, defined here rather than run at the bottom of the
# file, so that the only line after the partition's end marker is a single call
# to it. Appending a test to the bottom of this file — the habit this suite grew
# up with — would otherwise run it in every focused mode, and after the success
# line had already been printed. verify_gate_family_partition enforces that.
dispatch_gate_test_families() {
  local gate_test_focus="${GATE_TEST_FOCUS:-}"
  local gate_test_family
  local gate_test_request
  local gate_test_known
  local -a gate_test_requested=()
  local -a gate_test_selected=()

  # GATE_TEST_FOCUS is a developer convenience for iterating on one subject, and
  # it must never be able to answer for the whole suite. The gate schedules this
  # file as a mapped command, so a focus exported in a developer's shell would
  # otherwise be inherited and silently shrink the gate's own self-test; the same
  # goes for CI's `pnpm agent:quality-gate:test`. Refuse loudly when any of these
  # holds a non-empty value — the test below reads the value, not the presence,
  # so a marker exported empty reads the same as one that was never exported:
  #
  # - AGENTQG_RUN, which the gate puts on the argv of every mapped command it
  #   runs, in every mode. This is the one that has to be here: the lock marker
  #   below is absent under `--no-lock` and AGENT_QUALITY_GATE_LOCK=0, because
  #   acquire_gate_run_lock returns before exporting it, so a focus would have
  #   survived into the self-test of exactly the runs that skip the lock.
  # - AGENT_QUALITY_GATE_LOCK_HELD, exported by a `--run` holding the
  #   machine-wide lock and inherited by nested runs. Kept as a second key on the
  #   same door.
  # - GITHUB_ACTIONS, which marks CI itself. CI="${CI:-true}" is not usable
  #   here: the gate exports that to mapped commands AND agent shells set it,
  #   which would refuse the focus on the very machines it is for.
  if [[ -n "$gate_test_focus" ]]; then
    if [[ -n "${AGENTQG_RUN:-}" ||
      -n "${AGENT_QUALITY_GATE_LOCK_HELD:-}" ||
      -n "${GITHUB_ACTIONS:-}" ]]; then
      printf 'GATE_TEST_FOCUS is not honored inside a gate run or in CI: unset it to run the full suite\n' >&2
      exit 2
    fi
  fi

  if [[ -z "$gate_test_focus" ]]; then
    gate_test_selected=("${gate_test_families[@]}")
  else
    IFS=',' read -r -a gate_test_requested <<< "$gate_test_focus"
    for gate_test_request in "${gate_test_requested[@]}"; do
      gate_test_request="${gate_test_request// /}"
      [[ -n "$gate_test_request" ]] || continue
      gate_test_known=false
      for gate_test_family in "${gate_test_families[@]}"; do
        if [[ "$gate_test_family" == "$gate_test_request" ]]; then
          gate_test_known=true
          break
        fi
      done
      if [[ "$gate_test_known" != true ]]; then
        printf 'unknown GATE_TEST_FOCUS family: %s\n' "$gate_test_request" >&2
        printf 'known families: %s\n' "${gate_test_families[*]}" >&2
        exit 2
      fi
    done
    # Selection follows registry order, not the order the caller listed, so a
    # focused run can never claim an ordering the full run does not have. It also
    # collapses a repeated family to one run.
    for gate_test_family in "${gate_test_families[@]}"; do
      for gate_test_request in "${gate_test_requested[@]}"; do
        if [[ "${gate_test_request// /}" == "$gate_test_family" ]]; then
          gate_test_selected+=("$gate_test_family")
          break
        fi
      done
    done
    if [[ "${#gate_test_selected[@]}" -eq 0 ]]; then
      printf 'GATE_TEST_FOCUS selected no families: %s\n' "$gate_test_focus" >&2
      exit 2
    fi
  fi

  for gate_test_family in "${gate_test_selected[@]}"; do
    "run_${gate_test_family//-/_}_family"
  done

  if [[ -z "$gate_test_focus" ]]; then
    echo "agent quality gate tests passed"
  else
    echo "agent quality gate focused tests passed: ${gate_test_selected[*]}"
  fi
}

verify_gate_family_partition
# >>> gate family body start

# family: gate-contract
# Pins on the gate's own source text, the routing and lockfile-scope
# classifier resolution contracts, the Turbo task-graph inputs, and the
# agent context check.
run_gate_contract_family() {
arm_suite_abort_trap
assert_script_occurrences 1 "trap cleanup_tmpfiles EXIT"
assert_script_occurrences 1 'changed_paths_file="$(make_tmpfile)"'
assert_script_occurrences 0 "trap 'rm -f \"\$changed_paths_file\"' EXIT"
assert_script_occurrences 1 'Avoid overriding a usable TMPDIR'
assert_script_occurrences 1 'tmpdir_candidate="${TMPDIR:-${TMP:-${TEMP:-/tmp}}}"'
assert_script_occurrences 1 "command -v sha256sum"
assert_script_occurrences 1 "command -v shasum"
assert_script_occurrences 0 "shasum -a 256 | awk"
assert_script_occurrences 0 'shasum -a 256 "$1"'

classifier_missing_helper_dir="$(mktemp -d)"
cp scripts/agent-quality-gate.sh "$classifier_missing_helper_dir/agent-quality-gate.sh"
mkdir -p "$classifier_missing_helper_dir/gate"
cp scripts/gate/run-handles.sh "$classifier_missing_helper_dir/gate/run-handles.sh"
printf 'ui-dashboard/src/app/page.tsx\n' > "$paths_file"
classifier_missing_helper_exit=0
if bash "$classifier_missing_helper_dir/agent-quality-gate.sh" \
    --changed-paths-file "$paths_file" \
    --base origin/test \
    > "$output_file" 2>&1; then
  classifier_missing_helper_exit=0
else
  classifier_missing_helper_exit=$?
fi
rm -rf "$classifier_missing_helper_dir"
[[ "$classifier_missing_helper_exit" -eq 2 ]] ||
  fail "missing routing classifier helper exited $classifier_missing_helper_exit instead of 2"
assert_contains "error: routing-sensitive path classifier could not be loaded from"
assert_contains "error: failed to classify routing-sensitive changed paths"

run_handles_literal="$(
  awk -F'"' '/^run_handles_path=/ { print $2; exit }' \
    scripts/agent-quality-gate.sh
)"
[[ "$run_handles_literal" == '$script_source_dir/gate/run-handles.sh' ]] ||
  fail "run_handles_path must stay anchored on \$script_source_dir (got '$run_handles_literal')"
run_handles_relative="${run_handles_literal/\$script_source_dir/scripts}"
[[ -f "$repo_root/$run_handles_relative" && ! -L "$repo_root/$run_handles_relative" && -r "$repo_root/$run_handles_relative" ]] ||
  fail "gate run-handle helper is not a readable regular file: $run_handles_relative"
bash -n "$repo_root/$run_handles_relative" ||
  fail "gate run-handle helper failed bash syntax validation: $run_handles_relative"

run_gate "scripts/gate/run-handles.sh"
assert_contains "- pnpm agent:quality-gate:test (agent quality gate mapping changed)"

run_handles_missing_dir="$(mktemp -d)"
cp scripts/agent-quality-gate.sh "$run_handles_missing_dir/agent-quality-gate.sh"
run_handles_missing_exit=0
if bash "$run_handles_missing_dir/agent-quality-gate.sh" --base origin/test > "$output_file" 2>&1; then
  run_handles_missing_exit=0
else
  run_handles_missing_exit=$?
fi
rm -rf "$run_handles_missing_dir"
[[ "$run_handles_missing_exit" -eq 2 ]] ||
  fail "missing gate run-handle helper exited $run_handles_missing_exit instead of 2"
assert_contains "error: gate run-handle helper is missing or not a readable regular file"

# The gate resolves the routing classifier from its own source directory. No CI
# job runs the gate for real, so this suite is the only place that import is
# exercised outside a developer's pre-push — which makes these three assertions
# the machine control on a stale path after a move. Read the literal out of the
# gate, prove it resolves against the real tree, and prove it still exports the
# classifier the gate destructures.
routing_classifier_literal="$(
  awk -F'"' '/^routing_classifier_path=/ { print $2; exit }' \
    scripts/agent-quality-gate.sh
)"
routing_classifier_relative="${routing_classifier_literal/\$script_source_dir/scripts}"
[[ "$routing_classifier_relative" == scripts/*.mjs ]] ||
  fail "could not read routing_classifier_path from scripts/agent-quality-gate.sh (got '$routing_classifier_literal')"
[[ -f "$repo_root/$routing_classifier_relative" ]] ||
  fail "gate routing classifier path does not exist: $routing_classifier_relative"
if ! node --input-type=module - "$repo_root/$routing_classifier_relative" \
  > "$output_file" 2>&1 <<'NODE'
import { pathToFileURL } from "node:url";

const [modulePath] = process.argv.slice(2);
const classifier = await import(pathToFileURL(modulePath).href);
if (typeof classifier.isRoutingSensitivePath !== "function") {
  throw new Error(`${modulePath} does not export isRoutingSensitivePath`);
}
NODE
then
  fail "gate routing classifier at $routing_classifier_relative does not import cleanly"
fi

# The other half of the same contract: a routing-sensitive documentation path
# must still reach the classifier and schedule the fixture check.
run_gate "docs/notes/quick-commands.md"
assert_contains "- pnpm docs:navigation-eval -- --check-fixtures (routing-sensitive source changed)"

# The lockfile scope classifier is the quieter sibling of the routing classifier
# and needs the same machine control. Its caller reads a nonzero exit as "cannot
# narrow", so a stale path would widen every lockfile change back to the full
# workspace suite — a run that stays green and only gets slower. D5c moved the
# resolution into the mapping engine with the rest of the routing, so the literal
# is read out of scripts/gate/mapping.mjs now; it must still be anchored on the
# gate's own source directory, so a fixture-repo run reaches the real checkout.
lockfile_scope_literal="$(
  awk -F'"' '/const classifier = join\(scriptSourceDir,/ {
    print $2 "/" $4; exit
  }' scripts/gate/mapping.mjs
)"
[[ "$lockfile_scope_literal" == "gate/lockfile-scope.mjs" ]] ||
  fail "could not read the lockfile scope classifier path out of scripts/gate/mapping.mjs (got '$lockfile_scope_literal')"
lockfile_scope_relative="scripts/$lockfile_scope_literal"
[[ -f "$repo_root/$lockfile_scope_relative" ]] ||
  fail "gate lockfile scope classifier path does not exist: $lockfile_scope_relative"
grep -q 'join(scriptSourceDir, "gate", "lockfile-scope.mjs")' scripts/gate/mapping.mjs ||
  fail "the lockfile scope classifier must stay anchored on scriptSourceDir so fixture-repo runs reach the real checkout"
lockfile_scope_probe_dir="$(mktemp -d)"
printf 'importers:\n  metrics-bridge:\n    dependencies:\n      viem: 2.0.0\n' \
  > "$lockfile_scope_probe_dir/base.yaml"
printf 'importers:\n  metrics-bridge:\n    dependencies:\n      viem: 2.1.0\n' \
  > "$lockfile_scope_probe_dir/head.yaml"
if ! node "$repo_root/$lockfile_scope_relative" \
  "$lockfile_scope_probe_dir/base.yaml" \
  "$lockfile_scope_probe_dir/head.yaml" > "$output_file" 2>&1; then
  rm -rf "$lockfile_scope_probe_dir"
  fail "gate lockfile scope classifier at $lockfile_scope_relative did not run cleanly"
fi
rm -rf "$lockfile_scope_probe_dir"
[[ "$(cat "$output_file")" == "metrics-bridge" ]] ||
  fail "gate lockfile scope classifier did not narrow to the changed importer"

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
assert_turbo_task_has_input "test:browser" "scripts/fixture-identity.mjs"
assert_turbo_task_has_env "test:browser" "PLAYWRIGHT_FIXTURE_SERVER_IDENTITY"
assert_turbo_task_has_env "test:browser" "HASURA_FIXTURE_SCENARIO"
assert_turbo_task_has_env "test:browser" "HASURA_FIXTURE_CLIENT_DELAY_MS"
assert_turbo_task_has_env "test:browser" "NEXT_DIST_DIR"
assert_turbo_task_has_output "fixture-build" ".next-fixture/**"
assert_turbo_task_has_input "fixture-build" "scripts/fixture-build.mjs"
assert_turbo_task_has_input "fixture-build" "scripts/fixture-constants.mjs"
assert_turbo_task_has_input "fixture-build" "scripts/fixture-identity.mjs"
assert_turbo_task_has_env "fixture-build" "NEXT_PUBLIC_BROWSER_TEST_FIXTURES"
assert_turbo_task_has_env "fixture-build" "NEXT_PUBLIC_HASURA_URL"
assert_turbo_task_has_env "fixture-build" "NEXT_DIST_DIR"
node - <<'NODE' ||
const fs = require("node:fs");
const pkg = JSON.parse(fs.readFileSync("ui-dashboard/package.json", "utf8"));
if (pkg.scripts?.["react-doctor:diff"] !== 'bash ./scripts/check-react-doctor-diff.sh "${REACT_DOCTOR_BASE_REF:-origin/main}"') {
  console.error("ui-dashboard react-doctor:diff must delegate to the package-local diff wrapper");
  process.exit(1);
}
if (pkg.scripts?.["react-doctor:score"] !== "bash ./scripts/check-react-doctor-score.sh") {
  console.error("ui-dashboard react-doctor:score must delegate to the package-local score wrapper");
  process.exit(1);
}
NODE
  fail "expected ui-dashboard React Doctor package scripts to use the package-local wrappers"
assert_turbo_task_has_input "react-doctor:diff" "react-doctor.config.json"
assert_turbo_task_has_input "react-doctor:diff" "scripts/check-react-doctor-diff.sh"
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
assert_turbo_task_has_input "react-doctor:score" "scripts/check-react-doctor-score.sh"
assert_turbo_task_lacks_input "react-doctor:score" '$TURBO_ROOT$/scripts/agent-quality-gate.sh'
assert_turbo_task_lacks_input "react-doctor:score" '$TURBO_ROOT$/scripts/agent-quality-gate.test.sh'
assert_turbo_task_has_input "react-doctor:score" '$TURBO_ROOT$/package.json'
assert_turbo_task_has_input "react-doctor:score" '$TURBO_ROOT$/pnpm-lock.yaml'
assert_turbo_task_has_input "react-doctor:score" '$TURBO_ROOT$/pnpm-workspace.yaml'
assert_turbo_task_has_input "react-doctor:score" '$TURBO_ROOT$/.npmrc'
assert_turbo_task_has_input "react-doctor:score" '$TURBO_ROOT$/.node-version'
assert_turbo_task_has_input "react-doctor:score" '$TURBO_ROOT$/turbo.json'

printf 'scratch\n' > "$untracked_skill_artifact"
node scripts/context/check-agent-context.mjs > "$output_file"
assert_contains "Agent context check passed"
rm -f "$untracked_skill_artifact"
} # end family: gate-contract

# family: install-wiring
# Pre-push hook installation, the shared install-marker library, and the
# package-script pin validator.
run_install_wiring_family() {
arm_suite_abort_trap
hook_repo="$(mktemp -d)"
(
  cd "$hook_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
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
    env PATH="$minimal_bin" /bin/bash scripts/bootstrap/agent-session-end-hook.sh > "$output_file" 2>&1
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
assert_not_contains "Session touched the tree"

# scripts/lib/install-marker.sh is sourced by scripts/setup.sh and
# scripts/bootstrap/claude-code-web-setup.sh, which skip install and codegen work
# when a marker still holds the hash of their inputs. `bash -n` cannot see those
# semantics, so exercise them here. The scratch path carries a space: the inline
# copy this fragment replaced fed the file list to `xargs` unquoted, so such a
# path split into two nonexistent files and dropped out of the hash entirely.
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

# A missing input set yields an empty hash, which never matches, so the caller
# rebuilds instead of trusting a marker it cannot verify. Assert that against an
# absent marker: `cat` of a missing file is also empty, so a matcher without the
# empty-hash guard would compare "" to "" and report a match.
marker_empty_hash="$(install_marker_hash_inputs "$marker_scratch/absent" || true)"
[[ -z "$marker_empty_hash" ]] || fail "install-marker hashed a missing input set"
if install_marker_matches "$marker_scratch/never-written.sha256" "$marker_empty_hash"; then
  fail "install-marker matched an empty hash against an absent marker"
fi
if install_marker_matches "$marker_file" "$marker_empty_hash"; then
  fail "install-marker matched on an empty hash"
fi

# An input that cannot be hashed must not silently drop out: a hash that omits
# the same file on every run still matches its marker, so the guarded work never
# reruns. Skipped as root, where mode 000 does not deny a read.
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

for marker_consumer in scripts/setup.sh scripts/bootstrap/claude-code-web-setup.sh; do
  grep -q 'source "\$REPO_ROOT/scripts/lib/install-marker.sh"' "$marker_consumer" ||
    fail "$marker_consumer no longer sources scripts/lib/install-marker.sh"
  grep -q 'install_marker_hash_inputs' "$marker_consumer" ||
    fail "$marker_consumer no longer uses the shared install-marker hash"
done

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
  node "$repo_root/scripts/check-agent-quality-gate-package-scripts.mjs" > "$output_file" 2>&1
  exit_code=$?
  set -e
  [[ "$exit_code" -ne 0 ]]
)
rm -rf "$validator_repo"
assert_contains 'package.json scripts.agent:quality-gate must be "./scripts/agent-quality-gate.sh"'
} # end family: install-wiring

# family: routing-packaging
# Routing for packaging inputs: workspace manifests, package-manager
# config, root package-script and dev-metadata classification, the Turbo
# shared-cache export, and lockfile-importer scoping.
run_routing_packaging_family() {
arm_suite_abort_trap
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
assert_contains "- pnpm --filter @mento-protocol/metrics-bridge build (metrics-bridge changed)"
# `assert_contains` normalizes legacy package-task expectations to the Turbo
# command shape; keep a direct negative assertion so the old command cannot be
# emitted alongside the cached one unnoticed.
assert_not_contains "- pnpm --filter @mento-protocol/metrics-bridge lint (metrics-bridge changed)"

# Shared Turbo cache across worktrees (GitHub issue #1411): with TURBO_CACHE_DIR
# unset the gate exports the stable per-repo default so all worktrees share one
# cache; a caller-provided TURBO_CACHE_DIR is preserved untouched.
# Pin a temporary writable HOME and explicitly clear AGENT_TURBO_SHARED_CACHE so
# this default-path case stays valid when the suite itself is invoked under the
# supported opt-out or a restricted real HOME.
: > "$paths_file"
printf 'metrics-bridge/src/main.ts\n' >> "$paths_file"
node_executable_dir="$(dirname "$(node -p 'process.execPath')")"
turbo_cache_writable_home="$(mktemp -d)"
env -u TURBO_CACHE_DIR -u AGENT_TURBO_SHARED_CACHE \
  HOME="$turbo_cache_writable_home" \
  PATH="$node_executable_dir:$PATH" \
  AGENT_QUALITY_ALLOW_PACKAGE_SCRIPT_CHANGES=false \
  scripts/agent-quality-gate.sh \
  --changed-paths-file "$paths_file" \
  --base origin/test \
  > "$output_file"
assert_raw_contains "Turbo cache dir: "
assert_raw_contains "/.cache/turbo-monitoring-monorepo"
rm -rf "$turbo_cache_writable_home"

TURBO_CACHE_DIR="/tmp/agentqg-caller-turbo-cache" \
  AGENT_QUALITY_ALLOW_PACKAGE_SCRIPT_CHANGES=false \
  scripts/agent-quality-gate.sh \
  --changed-paths-file "$paths_file" \
  --base origin/test \
  > "$output_file"
assert_raw_contains "Turbo cache dir: /tmp/agentqg-caller-turbo-cache"
assert_not_contains "/.cache/turbo-monitoring-monorepo"

# AGENT_TURBO_SHARED_CACHE=0/false is the documented operator escape hatch;
# assert it actually suppresses the export, not just documented intent.
env -u TURBO_CACHE_DIR AGENT_TURBO_SHARED_CACHE=0 \
  AGENT_QUALITY_ALLOW_PACKAGE_SCRIPT_CHANGES=false \
  scripts/agent-quality-gate.sh \
  --changed-paths-file "$paths_file" \
  --base origin/test \
  > "$output_file"
assert_not_contains "Turbo cache dir: "

env -u TURBO_CACHE_DIR AGENT_TURBO_SHARED_CACHE=false \
  AGENT_QUALITY_ALLOW_PACKAGE_SCRIPT_CHANGES=false \
  scripts/agent-quality-gate.sh \
  --changed-paths-file "$paths_file" \
  --base origin/test \
  > "$output_file"
assert_not_contains "Turbo cache dir: "

# Falls back to Turbo's per-worktree default (no TURBO_CACHE_DIR export) when
# the shared-cache candidate cannot be created, e.g. a sandboxed agent
# environment whose writable allowlist excludes it.
turbo_cache_unwritable_home="$(mktemp -d)"
: > "$turbo_cache_unwritable_home/.cache"
env -u TURBO_CACHE_DIR \
  HOME="$turbo_cache_unwritable_home" \
  PATH="$node_executable_dir:$PATH" \
  AGENT_QUALITY_ALLOW_PACKAGE_SCRIPT_CHANGES=false \
  scripts/agent-quality-gate.sh \
  --changed-paths-file "$paths_file" \
  --base origin/test \
  > "$output_file"
assert_not_contains "Turbo cache dir: "
rm -rf "$turbo_cache_unwritable_home"

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
assert_contains "- bash ui-dashboard/scripts/check-react-doctor-score.sh (package manager config changed)"
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
assert_contains "- bash ui-dashboard/scripts/check-react-doctor-score.sh (workspace dependency/config changed)"
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
    "agent:context-check": "node scripts/context/check-agent-context.mjs",
    "agent:autoreview": "./scripts/agent-autoreview.sh",
    "agent:prewarm": "node scripts/gate/agent-prewarm.mjs",
    "agent:prewarm:test": "node scripts/gate/agent-prewarm.test.mjs",
    "agent:review-materiality": "node scripts/pr/review-materiality.mjs",
    "agent:review-materiality:test": "node scripts/pr/review-materiality.test.mjs",
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
  git add package.json
  git commit -qm init
  node - <<'NODE'
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.scripts["docs:garden:test"] = "node scripts/docs/docs-garden-issue.test.mjs --fixture";
fs.writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
NODE
  "$repo_root/scripts/agent-quality-gate.sh" --base HEAD > "$output_file"
)
rm -rf "$package_json_repo"
assert_contains "- tooling"
assert_contains "- node scripts/check-agent-quality-gate-package-scripts.mjs (root package tooling script changed)"
assert_contains "- bash scripts/agent-quality-gate.test.sh (root package tooling script changed)"
assert_contains "- node scripts/gate/agent-prewarm.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/pr/review-materiality.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/pr/agent-issue-board.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/docs/docs-garden-issue.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/docs/docs-navigation-eval.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/pr/pr-feedback-state.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/pr/pr-ready-state.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/tf-stacks.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/supply-chain/lockfile-lint.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/supply-chain/version-skew-check.test.mjs (root package tooling script changed)"
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
    "agent:context-check": "node scripts/context/check-agent-context.mjs",
    "agent:autoreview": "./scripts/agent-autoreview.sh",
    "agent:prewarm": "node scripts/gate/agent-prewarm.mjs",
    "agent:prewarm:test": "node scripts/gate/agent-prewarm.test.mjs",
    "agent:review-materiality": "node scripts/pr/review-materiality.mjs",
    "agent:review-materiality:test": "node scripts/pr/review-materiality.test.mjs",
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
    "agent:context-check": "node scripts/context/check-agent-context.mjs",
    "agent:autoreview": "./scripts/agent-autoreview.sh",
    "agent:prewarm": "node scripts/gate/agent-prewarm.mjs",
    "agent:prewarm:test": "node scripts/gate/agent-prewarm.test.mjs",
    "agent:review-materiality": "node scripts/pr/review-materiality.mjs",
    "agent:review-materiality:test": "node scripts/pr/review-materiality.test.mjs",
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
  git add package.json
  git commit -qm init
  node - <<'NODE'
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.scripts["lockfile:lint:test"] = "node scripts/supply-chain/lockfile-lint.test.mjs --fixture";
fs.writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
NODE
  "$repo_root/scripts/agent-quality-gate.sh" --base HEAD > "$output_file"
)
rm -rf "$lockfile_script_repo"
assert_contains "- tooling"
assert_contains "- node scripts/check-agent-quality-gate-package-scripts.mjs (root package tooling script changed)"
assert_contains "- bash scripts/agent-quality-gate.test.sh (root package tooling script changed)"
assert_contains "- node scripts/gate/agent-prewarm.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/pr/review-materiality.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/pr/agent-issue-board.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/pr/pr-feedback-state.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/pr/pr-ready-state.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/tf-stacks.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/supply-chain/lockfile-lint.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/supply-chain/version-skew-check.test.mjs (root package tooling script changed)"
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
    "agent:context-check": "node scripts/context/check-agent-context.mjs",
    "agent:autoreview": "./scripts/agent-autoreview.sh",
    "agent:prewarm": "node scripts/gate/agent-prewarm.mjs",
    "agent:prewarm:test": "node scripts/gate/agent-prewarm.test.mjs",
    "agent:review-materiality": "node scripts/pr/review-materiality.mjs",
    "agent:review-materiality:test": "node scripts/pr/review-materiality.test.mjs",
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
  git add package.json
  git commit -qm init
  node - <<'NODE'
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.scripts["pr:ready-state:test"] = "node scripts/pr/pr-ready-state.test.mjs --fixture";
fs.writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
NODE
  "$repo_root/scripts/agent-quality-gate.sh" --base HEAD > "$output_file"
)
rm -rf "$pr_ready_state_script_repo"
assert_contains "- tooling"
assert_contains "- node scripts/check-agent-quality-gate-package-scripts.mjs (root package tooling script changed)"
assert_contains "- bash scripts/agent-quality-gate.test.sh (root package tooling script changed)"
assert_contains "- node scripts/gate/agent-prewarm.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/pr/review-materiality.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/pr/agent-issue-board.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/pr/pr-feedback-state.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/pr/pr-ready-state.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/tf-stacks.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/supply-chain/lockfile-lint.test.mjs (root package tooling script changed)"
assert_contains "- node scripts/supply-chain/version-skew-check.test.mjs (root package tooling script changed)"
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
    "agent:context-check": "node scripts/context/check-agent-context.mjs",
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
assert_contains "- node scripts/check-agent-quality-gate-package-scripts.mjs (root package script changed)"
assert_contains "- bash scripts/agent-quality-gate.test.sh (root package script changed)"
assert_contains "- pnpm --filter @mento-protocol/ui-dashboard typecheck (root package script changed)"
# Workspace-wide triggers skip the dashboard playwright suite — see the
# matching `assert_not_contains` block above .npmrc for the rationale.
assert_not_contains_mapped "- pnpm --filter @mento-protocol/ui-dashboard test:browser (root package script changed)"
assert_contains "- bash ui-dashboard/scripts/check-react-doctor-score.sh (root package script changed)"

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
    "agent:context-check": "node scripts/context/check-agent-context.mjs",
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
assert_contains "- node scripts/check-agent-quality-gate-package-scripts.mjs (root package script changed)"
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
    "agent:context-check": "node scripts/context/check-agent-context.mjs"
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
assert_contains "- node scripts/check-agent-quality-gate-package-scripts.mjs (root package script changed)"
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
assert_contains "- node scripts/check-agent-quality-gate-package-scripts.mjs (root package script changed)"
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
assert_contains "- node scripts/alerts/check-peg-registry-integrity.mjs (root lockfile changed (peg registry authority dependency))"
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

# A missing classifier is NOT an ambiguous lockfile, and must not be answered
# with fail-toward-full: that reads as a slow-but-green run and nobody looks.
# Mirror the real hazard by giving the gate a source directory that has every
# sibling, and a gate/ holding everything except lockfile-scope.mjs — so ONLY
# the lockfile scope spawn goes stale — and require a loud exit 2. Since D5c
# the mapper resolves this path, so gate/mapping.mjs and the routing table have
# to be present or the run refuses earlier for a different reason.
lockfile_scope_missing_dir="$(mktemp -d)"
for lockfile_scope_sibling in "$repo_root"/scripts/*; do
  lockfile_scope_sibling_name="$(basename "$lockfile_scope_sibling")"
  if [[ "$lockfile_scope_sibling_name" != "gate" ]]; then
    ln -s "$lockfile_scope_sibling" \
      "$lockfile_scope_missing_dir/$lockfile_scope_sibling_name"
  fi
done
mkdir -p "$lockfile_scope_missing_dir/gate"
for lockfile_scope_gate_entry in "$repo_root"/scripts/gate/*; do
  lockfile_scope_gate_entry_name="$(basename "$lockfile_scope_gate_entry")"
  if [[ "$lockfile_scope_gate_entry_name" != "lockfile-scope.mjs" &&
    "$lockfile_scope_gate_entry_name" != "run-handles.sh" ]]; then
    ln -s "$lockfile_scope_gate_entry" \
      "$lockfile_scope_missing_dir/gate/$lockfile_scope_gate_entry_name"
  fi
done
cp "$repo_root/scripts/gate/run-handles.sh" \
  "$lockfile_scope_missing_dir/gate/run-handles.sh"
lockfile_scope_missing_repo="$(mktemp -d)"
(
  cd "$lockfile_scope_missing_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  printf '{ "name": "fixture" }\n' > package.json
  printf '%s' "$lockfile_scope_base_yaml" > pnpm-lock.yaml
  git add package.json pnpm-lock.yaml
  git commit -qm init
  printf 'lockfileVersion: %s\nsettings:\n  autoInstallPeers: true\noverrides: {}\nimporters:\n  .:\n    dependencies: {}\n  metrics-bridge:\n    dependencies:\n      viem:\n        specifier: ^2.1.0\n        version: 2.1.0\n  integration-probes:\n    dependencies:\n      undici:\n        specifier: ^6.0.0\n        version: 6.0.0\npackages:\n  viem@2.0.0: {}\n' \
    "'9.0'" > pnpm-lock.yaml
  set +e
  bash "$lockfile_scope_missing_dir/agent-quality-gate.sh" --base HEAD > "$output_file" 2>&1
  printf '%s\n' "$?" > exit-code
  set -e
)
lockfile_scope_missing_exit="$(cat "$lockfile_scope_missing_repo/exit-code")"
rm -rf "$lockfile_scope_missing_dir" "$lockfile_scope_missing_repo"
[[ "$lockfile_scope_missing_exit" -eq 2 ]] ||
  fail "missing lockfile scope classifier exited $lockfile_scope_missing_exit instead of 2"
# The message names the module, and the gate turns the mapper's exit into its
# own refusal. Both halves matter: the first is what tells a reader WHICH path
# went stale, the second is what stops the run.
assert_contains "lockfile scope classifier could not be loaded from"
assert_contains "error: gate mapping engine failed (exit 2); refusing to run on a plan it did not produce"
assert_not_contains "lockfile change scoped to importers"
assert_not_contains "- cd aegis && forge test (workspace dependency/config changed)"

# The mapping engine is the routing (ADR 0069), and since D5c it is the ONLY
# routing — a gate that cannot find it has no plan to fall back to and must
# refuse. Before D5c the bash arms were still sitting there and using them would
# have looked like resilience; the refusal is what has to survive the deletion.
#
# Same mirror trick as the classifier case above, one level deeper: every
# scripts/ entry is symlinked, and `gate` is rebuilt as a real directory whose
# contents are symlinks minus mapping.mjs.
mapper_missing_dir="$(mktemp -d)"
for mapper_sibling in "$repo_root"/scripts/*; do
  mapper_sibling_name="$(basename "$mapper_sibling")"
  if [[ "$mapper_sibling_name" != "gate" ]]; then
    ln -s "$mapper_sibling" "$mapper_missing_dir/$mapper_sibling_name"
  fi
done
mkdir -p "$mapper_missing_dir/gate"
for mapper_gate_entry in "$repo_root"/scripts/gate/*; do
  mapper_gate_entry_name="$(basename "$mapper_gate_entry")"
  if [[ "$mapper_gate_entry_name" != "mapping.mjs" && "$mapper_gate_entry_name" != "run-handles.sh" ]]; then
    ln -s "$mapper_gate_entry" "$mapper_missing_dir/gate/$mapper_gate_entry_name"
  fi
done
cp "$repo_root/scripts/gate/run-handles.sh" "$mapper_missing_dir/gate/run-handles.sh"
mapper_missing_repo="$(mktemp -d)"
(
  cd "$mapper_missing_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  printf '{ "name": "fixture" }\n' > package.json
  git add package.json
  git commit -qm init
  printf 'export const changed = 1;\n' > changed.mjs
  set +e
  bash "$mapper_missing_dir/agent-quality-gate.sh" --base HEAD > "$output_file" 2>&1
  printf '%s\n' "$?" > exit-code
  set -e
)
mapper_missing_exit="$(cat "$mapper_missing_repo/exit-code")"
rm -rf "$mapper_missing_dir" "$mapper_missing_repo"
[[ "$mapper_missing_exit" -eq 2 ]] ||
  fail "missing gate mapping engine exited $mapper_missing_exit instead of 2"
assert_contains "error: gate mapping engine could not be loaded from"
assert_not_contains "Mapped safe local commands:"

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
} # end family: routing-packaging

# family: routing-sources
# Routing for source paths: scoped `vitest related` selection, indexer
# codegen order, shared-config blast radius, the deploy/status/terraform
# arms, and the hermetic setup routes.
run_routing_sources_family() {
arm_suite_abort_trap
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

indexer_invariant_positive_paths=(
  "indexer-envio/abis/liquity/FXPriceFeed.json"
  "indexer-envio/config/fx-calendar.json"
  "indexer-envio/config.yaml"
  "indexer-envio/config.multichain.mainnet.yaml"
  "indexer-envio/scripts/test-reserve-yield.mjs"
  "indexer-envio/stryker.config.mjs"
  "indexer-envio/vitest.fail-closed.config.ts"
  "indexer-envio/vitest.mutation.config.ts"
  "indexer-envio/src/rpc/http-test-mocks.ts"
  "indexer-envio/src/startupChecks.ts"
  "indexer-envio/src/handlers/broker.ts"
  "indexer-envio/src/pool/self-heal.ts"
  "indexer-envio/src/wormhole/status.ts"
  "indexer-envio/test/feeTokenAllowlist.test.ts"
  "indexer-envio/test/helpers/indexerTestHarness.ts"
)
for indexer_invariant_path in "${indexer_invariant_positive_paths[@]}"; do
  run_gate "$indexer_invariant_path"
  assert_contains "- node --test scripts/gate/routing-table/indexer-invariant-parity.test.mjs (indexer invariant routing inventory changed)"
  assert_contains "- docs/pr-checklists/indexer-handler-invariants.md (indexer handler/RPC/self-heal invariant path changed)"
done

indexer_invariant_negative_inventory_paths=(
  "indexer-envio/abis/liquity/AddressesRegistry.json"
  "indexer-envio/abis/wormhole/NttDeployHelper.json"
  "indexer-envio/config.multichain.owner-probe.yaml"
  "indexer-envio/scripts/test-future-runtime.mjs"
  "indexer-envio/vitest.future-runtime.config.mjs"
  "indexer-envio/src/handlers/liquity/troveManagerPreloadContext.ts"
  "indexer-envio/src/pool/types.ts"
  "indexer-envio/src/rpc/log.ts"
  "indexer-envio/src/future-unowned.json"
  "indexer-envio/src/wormhole/handlerContext.ts"
  "indexer-envio/src/wormhole/scratchWarnings.ts"
  "indexer-envio/test/aggregators-parity.test.ts"
  "indexer-envio/test/documentation-catalog.test.ts"
)
for indexer_invariant_path in "${indexer_invariant_negative_inventory_paths[@]}"; do
  run_gate "$indexer_invariant_path"
  assert_not_contains "docs/pr-checklists/indexer-handler-invariants.md"
  assert_contains "- node --test scripts/gate/routing-table/indexer-invariant-parity.test.mjs (indexer invariant routing inventory changed)"
done

indexer_invariant_unrelated_paths=(
  "indexer-envio/.env.example"
)
for indexer_invariant_path in "${indexer_invariant_unrelated_paths[@]}"; do
  run_gate "$indexer_invariant_path"
  assert_not_contains "docs/pr-checklists/indexer-handler-invariants.md"
  assert_not_contains "indexer invariant routing inventory changed"
done

indexer_invariant_future_paths=()
for indexer_invariant_future_extension in ts tsx mts cts js jsx mjs cjs; do
  for indexer_invariant_future_scope in src test; do
    indexer_invariant_future_paths+=(
      "indexer-envio/${indexer_invariant_future_scope}/future-handler.${indexer_invariant_future_extension}"
    )
  done
done
run_gate "${indexer_invariant_future_paths[@]}"
assert_contains "- node --test scripts/gate/routing-table/indexer-invariant-parity.test.mjs (indexer invariant routing inventory changed)"
assert_not_contains "docs/pr-checklists/indexer-handler-invariants.md"

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

run_gate "metrics-bridge/src/peg/metrics.ts"
assert_contains "- pnpm alerts:rules:lint (metrics-bridge gauge registry changed (alerts cross-check))"

run_gate "metrics-bridge/peg-registry.json"
assert_contains "- node scripts/alerts/check-peg-registry-integrity.mjs (peg registry changed)"

run_gate "metrics-bridge/src/rpc.ts"
assert_contains "- docs/pr-checklists/terraform-cloudrun.md (metrics bridge Cloud Run runtime changed)"
assert_not_contains "node scripts/alerts/check-peg-registry-integrity.mjs"

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
assert_contains "- bash ui-dashboard/scripts/check-react-doctor-diff.sh origin/test (ui-dashboard client code should keep React Doctor clean)"
assert_contains "- bash ui-dashboard/scripts/check-react-doctor-score.sh (ui-dashboard React Doctor score should stay 100)"
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
assert_contains "- bash ui-dashboard/scripts/check-react-doctor-diff.sh origin/test (ui-dashboard client code should keep React Doctor clean)"
assert_contains "- bash ui-dashboard/scripts/check-react-doctor-score.sh (ui-dashboard React Doctor score should stay 100)"
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
assert_contains "- node scripts/repo-health/check-hermetic-vitest-setup.mjs (hermetic Vitest config changed)"
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
assert_contains "- node scripts/repo-health/check-hermetic-vitest-setup.mjs (hermetic Vitest config changed)"
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
assert_contains "- node scripts/repo-health/check-hermetic-vitest-setup.mjs (hermetic Vitest config changed)"
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
assert_contains "- TF_DATA_DIR=terraform/.terraform-agent-gate node scripts/terraform/terraform-fmt-check.mjs terraform (Terraform changed)"
assert_contains "- TF_DATA_DIR=terraform/.terraform-agent-gate terraform -chdir=terraform init -backend=false -input=false (Terraform changed)"
assert_contains "- TF_DATA_DIR=terraform/.terraform-agent-gate terraform -chdir=terraform validate -no-color (Terraform changed)"
assert_contains "- docs/pr-checklists/terraform-cloudrun.md (Terraform/Cloud Run path changed)"

run_gate "alerts/rules/rules-fpmms.tf"
assert_contains "- TF_DATA_DIR=alerts/rules/.terraform-agent-gate node scripts/terraform/terraform-fmt-check.mjs alerts/rules (alerts/rules Terraform changed)"
assert_contains "- TF_DATA_DIR=alerts/rules/.terraform-agent-gate terraform -chdir=alerts/rules init -backend=false -input=false (alerts/rules Terraform changed)"
assert_contains "- TF_DATA_DIR=alerts/rules/.terraform-agent-gate terraform -chdir=alerts/rules validate -no-color (alerts/rules Terraform changed)"
assert_contains "- pnpm alerts:rules:lint (alerts/rules PromQL lint + metric cross-check)"
assert_contains "- node scripts/alerts/check-deviation-threshold-drift.mjs (deviation threshold Terraform consumer changed)"
assert_not_contains "node scripts/alerts/check-peg-registry-integrity.mjs"

run_gate "alerts/rules/peg-thresholds.json"
assert_contains "- TF_DATA_DIR=alerts/rules/.terraform-agent-gate node scripts/terraform/terraform-fmt-check.mjs alerts/rules (alerts/rules Terraform changed)"
assert_contains "- TF_DATA_DIR=alerts/rules/.terraform-agent-gate terraform -chdir=alerts/rules init -backend=false -input=false (alerts/rules Terraform changed)"
assert_contains "- TF_DATA_DIR=alerts/rules/.terraform-agent-gate terraform -chdir=alerts/rules validate -no-color (alerts/rules Terraform changed)"
assert_contains "- pnpm alerts:rules:lint (alerts/rules PromQL lint + metric cross-check)"
assert_contains "- node scripts/alerts/check-peg-registry-integrity.mjs (peg threshold policy changed)"

run_gate "alerts/rules/main.tf"
assert_contains "- TF_DATA_DIR=alerts/rules/.terraform-agent-gate node scripts/terraform/terraform-fmt-check.mjs alerts/rules (alerts/rules Terraform changed)"
assert_contains "- TF_DATA_DIR=alerts/rules/.terraform-agent-gate terraform -chdir=alerts/rules init -backend=false -input=false (alerts/rules Terraform changed)"
assert_contains "- TF_DATA_DIR=alerts/rules/.terraform-agent-gate terraform -chdir=alerts/rules validate -no-color (alerts/rules Terraform changed)"
assert_contains "- node scripts/alerts/check-deviation-threshold-drift.mjs (deviation threshold Terraform consumer changed)"

run_gate "alerts/infra/main.tf"
assert_contains "- TF_DATA_DIR=alerts/infra/.terraform-agent-gate node scripts/terraform/terraform-fmt-check.mjs alerts/infra (alerts/infra Terraform changed)"
assert_contains "- TF_DATA_DIR=alerts/infra/.terraform-agent-gate terraform -chdir=alerts/infra init -backend=false -input=false (alerts/infra Terraform changed)"
assert_contains "- TF_DATA_DIR=alerts/infra/.terraform-agent-gate terraform -chdir=alerts/infra validate -no-color (alerts/infra Terraform changed)"
assert_contains "- docs/pr-checklists/terraform-cloudrun.md (alerts/infra Cloud Function path changed)"

run_gate "alerts/infra/channels/sentry-bridge/main.tf"
assert_contains "- TF_DATA_DIR=alerts/infra/.terraform-agent-gate node scripts/terraform/terraform-fmt-check.mjs alerts/infra (alerts/infra Terraform changed)"

run_gate "alerts/infra/onchain-event-listeners/main.tf"
assert_contains "- bash alerts/infra/scripts/fix-webhook-state.test.sh (QuickNode replacement state parser changed)"

run_gate "alerts/infra/scripts/common.sh"
assert_contains "- bash -n alerts/infra/scripts/common.sh (shell script changed)"
assert_contains "- bash alerts/infra/scripts/fix-webhook-state.test.sh (QuickNode state parser changed)"

run_gate "alerts/infra/scripts/fix-webhook-state.test.sh"
assert_contains "- bash -n alerts/infra/scripts/fix-webhook-state.test.sh (shell script changed)"
assert_contains "- bash alerts/infra/scripts/fix-webhook-state.test.sh (QuickNode state parser changed)"

run_gate "alerts/infra/onchain-event-handler/main.tf"
assert_contains "- TF_DATA_DIR=alerts/infra/.terraform-agent-gate node scripts/terraform/terraform-fmt-check.mjs alerts/infra (alerts/infra Terraform changed)"
assert_contains "- docs/pr-checklists/terraform-cloudrun.md (alerts/infra Cloud Function path changed)"

run_gate "alerts/infra/onchain-event-handler/src/slack.ts"
assert_contains "- pnpm exec turbo run lint --filter=@mento-protocol/alerts-onchain-event-handler --cache=local:rw (alerts onchain-event-handler changed)"
assert_contains "- pnpm exec turbo run typecheck --filter=@mento-protocol/alerts-onchain-event-handler --cache=local:rw (alerts onchain-event-handler changed)"
assert_raw_contains "- pnpm --filter @mento-protocol/alerts-onchain-event-handler exec vitest related --run src/slack.ts (alerts onchain-event-handler changed (coverage floor) (scoped-tests))"
assert_not_contains "- pnpm --filter @mento-protocol/alerts-onchain-event-handler test:coverage"

run_gate "alerts/infra/onchain-event-handler/pnpm-workspace.yaml"
assert_contains "- node --test scripts/supply-chain/alerts-uuid-overrides.test.mjs (alerts uuid override policy changed)"

run_gate "alerts/infra/oncall-announcer/pnpm-workspace.yaml"
assert_contains "- node --test scripts/supply-chain/alerts-uuid-overrides.test.mjs (alerts uuid override policy changed)"

run_gate "scripts/supply-chain/alerts-uuid-overrides.test.mjs"
assert_contains "- node --test scripts/supply-chain/alerts-uuid-overrides.test.mjs (alerts uuid override contract changed)"

run_gate "alerts/infra/onchain-event-handler/src/safe-abi.json"
assert_contains "- pnpm exec turbo run lint --filter=@mento-protocol/alerts-onchain-event-handler --cache=local:rw (Safe ABI changed (handler imports it))"
assert_contains "- pnpm exec turbo run typecheck --filter=@mento-protocol/alerts-onchain-event-handler --cache=local:rw (Safe ABI changed (handler imports it))"
# Even though this JSON is genuinely imported, non-module files may be fs-read
# elsewhere and the gate cannot tell statically — they disqualify scoping, so
# the full coverage floor runs (fail toward full).
assert_contains "- pnpm --filter @mento-protocol/alerts-onchain-event-handler test:coverage"
assert_not_contains "vitest related --run src/safe-abi.json"
assert_contains "- TF_DATA_DIR=alerts/infra/.terraform-agent-gate node scripts/terraform/terraform-fmt-check.mjs alerts/infra (Safe ABI changed (listener filter uses it at plan time))"
assert_contains "- TF_DATA_DIR=alerts/infra/.terraform-agent-gate terraform -chdir=alerts/infra init -backend=false -input=false (Safe ABI changed (listener filter uses it at plan time))"
assert_contains "- TF_DATA_DIR=alerts/infra/.terraform-agent-gate terraform -chdir=alerts/infra validate -no-color (Safe ABI changed (listener filter uses it at plan time))"

run_gate ".github/workflows/metrics-bridge.yml"
assert_contains "- docs/pr-checklists/ci-workflow-gates.md (GitHub Actions workflow/action changed)"
assert_contains "- node scripts/workflows/check-github-action-pins.mjs (GitHub Actions workflow/action changed)"
assert_contains "- docs/pr-checklists/terraform-cloudrun.md (metrics bridge Cloud Run workflow changed)"
assert_contains "- pnpm agent:context-check (Cloud Run revision suffix guard changed)"

run_gate ".github/workflows/documentation-garden.yml"
assert_contains "- docs/pr-checklists/ci-workflow-gates.md (GitHub Actions workflow/action changed)"
assert_contains "- node scripts/workflows/check-github-action-pins.mjs (GitHub Actions workflow/action changed)"
assert_contains "- pnpm docs:garden:test (documentation garden workflow changed)"
assert_contains "- pnpm docs:navigation-eval:test (documentation navigation scheduler workflow changed)"
assert_contains "node scripts/pr/check-adr-reminder.mjs"

run_gate ".lighthouserc.cjs"
assert_contains "- node scripts/lighthouse-config.test.mjs (Lighthouse CI budget config changed)"

run_gate "scripts/lighthouse-config.test.mjs"
assert_contains "- node scripts/lighthouse-config.test.mjs (Lighthouse config assertion suite changed)"

# The routing table (ADR 0069) is where this gate's routing lives, and
# routing-table.test.mjs is what proves the table and this file agree about the
# pins they share. It only does that if it RUNS in both drift directions, so
# both are pinned here.
#
# Table side: EVERY module under scripts/gate/routing-table/, enumerated from the
# real tree rather than named here. Naming two would leave the rest resting on
# the assumption that one glob covers them all — and a narrowed arm, or a new
# module whose name an earlier arm happens to claim, would drop one while these
# assertions stayed green. Enumerating means a module added later is covered the
# day it lands, by construction.
#
# The names come from `$repo_root` because `run_gate` drives a fixture repository
# that has no scripts/ tree; the routing itself only ever sees the path string.
routing_table_modules=()
while IFS= read -r routing_table_module; do
  routing_table_modules+=("$routing_table_module")
done < <(cd "$repo_root" && git ls-files 'scripts/gate/routing-table/*.mjs')
((${#routing_table_modules[@]} >= 15)) ||
  fail "expected the routing table to have at least 15 tracked modules, found ${#routing_table_modules[@]} — enumeration found nothing to check"
for routing_table_module in "${routing_table_modules[@]}"; do
  run_gate "$routing_table_module"
  assert_contains "- pnpm gate:routing-table:test (gate routing table changed)"
  assert_contains "- pnpm agent:quality-gate:test (gate routing table is an implementation-signature input)"
done

# Gate side: `implementation_signature()` lives in this file and must list every
# routing-table module. A missing entry hashes as `__missing__` and freezes the
# freshness signature, so `--skip-if-fresh` reuses a stale stamp. The suite that
# checks that reads this file, so editing it has to schedule the suite.
run_gate "scripts/agent-quality-gate.sh"
assert_contains "- pnpm agent:quality-gate:test (agent quality gate mapping changed)"
assert_contains "- pnpm gate:routing-table:test (gate holds the routing table's implementation-signature pin)"

# The bash-from-Node machinery the routing-table suite runs on: runProbeShell
# and probeDirs back the /bin/bash pattern oracle, bashFunctionSource backs the
# implementation-signature pin. Its own suite already runs through the
# CI-coverage check; this is the second consumer, which nothing routed.
run_gate "scripts/sentry/ci-wiring/check-sentry-suites-in-ci-gate-extract.mjs"
assert_contains "- pnpm gate:routing-table:test (the routing table's bash oracle and signature pin run on this machinery)"
assert_contains "- node scripts/sentry/ci-wiring/check-sentry-suites-in-ci.test.mjs (Sentry CI-coverage check reads this file)"

# Negative control: the routing-table arm sits BELOW the per-module arms in the
# same `case`, so a sibling under scripts/gate/ must still reach its own suite
# and not this one. Without this the two assertions above would also pass for a
# blanket arm over scripts/gate/, which would schedule the table suite for every
# unrelated gate satellite.
run_gate "scripts/gate/agent-prewarm.mjs"
assert_contains "- pnpm agent:prewarm:test (agent prewarm helper changed)"
assert_not_contains "- pnpm gate:routing-table:test"

run_gate ".github/workflows/ci.yml"
assert_contains "- docs/pr-checklists/ci-workflow-gates.md (GitHub Actions workflow/action changed)"
assert_contains "- node scripts/workflows/check-github-action-pins.mjs (GitHub Actions workflow/action changed)"
assert_contains "- pnpm install --frozen-lockfile (central CI workflow changed)"
assert_contains "- pnpm --filter @mento-protocol/indexer-envio indexer:bridge-only:codegen (central CI workflow changed)"
assert_contains "- pnpm tf:test (Terraform registry-backed CI workflow changed)"
assert_contains "- TF_DATA_DIR=terraform/.terraform-agent-gate node scripts/terraform/terraform-fmt-check.mjs terraform (Terraform registry-backed CI workflow changed)"
assert_contains "- TF_DATA_DIR=alerts/rules/.terraform-agent-gate node scripts/terraform/terraform-fmt-check.mjs alerts/rules (Terraform registry-backed CI workflow changed)"
assert_contains "- TF_DATA_DIR=aegis/terraform/.terraform-agent-gate node scripts/terraform/terraform-fmt-check.mjs aegis/terraform (Terraform registry-backed CI workflow changed)"
# Workspace-wide triggers (ci.yml here) deliberately skip the playwright
# suite — CI runs it in its own ui-dashboard job and the local --single-process
# chromium mode is flaky on keyboard/route-heavy tests.
assert_not_contains "playwright install chromium (central CI workflow changed)"
assert_not_contains_mapped "- pnpm --filter @mento-protocol/ui-dashboard test:browser (central CI workflow changed)"
assert_contains "- bash ui-dashboard/scripts/check-react-doctor-score.sh (central CI workflow changed)"
assert_order \
  "- pnpm install --frozen-lockfile (central CI workflow changed)" \
  "- pnpm --filter @mento-protocol/indexer-envio indexer:bridge-only:codegen (central CI workflow changed)"
assert_order \
  "- pnpm install --frozen-lockfile (link generated package after indexer codegen)" \
  "- pnpm --filter @mento-protocol/indexer-envio lint (central CI workflow changed)"

run_gate ".github/workflows/infra.yml"
assert_contains "- docs/pr-checklists/ci-workflow-gates.md (GitHub Actions workflow/action changed)"
assert_contains "- node scripts/workflows/check-github-action-pins.mjs (GitHub Actions workflow/action changed)"
assert_contains "- pnpm tf:test (Terraform registry workflow changed)"
assert_contains "- TF_DATA_DIR=terraform/.terraform-agent-gate node scripts/terraform/terraform-fmt-check.mjs terraform (Terraform registry workflow changed)"
assert_contains "- TF_DATA_DIR=alerts/rules/.terraform-agent-gate node scripts/terraform/terraform-fmt-check.mjs alerts/rules (Terraform registry workflow changed)"
assert_contains "- TF_DATA_DIR=alerts/infra/.terraform-agent-gate node scripts/terraform/terraform-fmt-check.mjs alerts/infra (Terraform registry workflow changed)"
assert_contains "- TF_DATA_DIR=aegis/terraform/.terraform-agent-gate node scripts/terraform/terraform-fmt-check.mjs aegis/terraform (Terraform registry workflow changed)"

run_gate ".github/actions/pnpm-install/action.yml"
assert_contains "- docs/pr-checklists/ci-workflow-gates.md (GitHub Actions workflow/action changed)"
assert_contains "- node scripts/workflows/check-github-action-pins.mjs (GitHub Actions workflow/action changed)"
assert_contains "- pnpm install --frozen-lockfile (pnpm install action changed)"
assert_contains "- pnpm --filter @mento-protocol/indexer-envio indexer:bridge-only:codegen (pnpm install action changed)"
assert_contains "- bash ui-dashboard/scripts/check-react-doctor-score.sh (pnpm install action changed)"
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
assert_contains "- node scripts/alerts/check-peg-registry-integrity.mjs (peg registry authority input changed)"
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
assert_contains "- node scripts/alerts/check-peg-registry-integrity.mjs (peg registry authority input changed)"
# The cache key includes shared-config inputs for browser tests, but the local
# gate still does not broaden shared-config-only edits into Playwright runs.
assert_not_contains_mapped "- pnpm --filter @mento-protocol/ui-dashboard test:browser (shared-config exports feed the dashboard bundle)"

run_gate "shared-config/oracle-reporters.json"
assert_contains "- node scripts/alerts/check-peg-registry-integrity.mjs (peg registry authority input changed)"

run_gate "shared-config/chain-metadata.json"
assert_contains "- node scripts/alerts/check-peg-registry-integrity.mjs (peg registry authority input changed)"

run_gate "shared-config/src/oracle-reporters.ts"
assert_contains "- node scripts/alerts/check-peg-registry-integrity.mjs (peg registry authority input changed)"

run_gate "shared-config/src/tokens.ts"
assert_contains "- node scripts/alerts/check-peg-registry-integrity.mjs (peg registry authority input changed)"

run_gate "shared-config/src/thresholds.ts"
assert_contains "- node scripts/alerts/check-deviation-threshold-drift.mjs (shared deviation threshold source changed)"
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
  assert_contains "- node scripts/repo-health/check-hermetic-vitest-setup.mjs (hermetic Vitest setup changed)"
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
assert_contains "- node scripts/repo-health/check-hermetic-vitest-setup.mjs (hermetic Vitest config changed)"

run_gate "metrics-bridge/vitest.config.ts"
assert_contains "- node scripts/repo-health/check-hermetic-vitest-setup.mjs (hermetic Vitest config changed)"

run_gate "indexer-envio/vitest.config.ts"
assert_contains "- node scripts/repo-health/check-hermetic-vitest-setup.mjs (hermetic Vitest config changed)"

run_gate "bootstrap-worktree.sh"
assert_contains "- bash -n bootstrap-worktree.sh (shell script changed)"

run_gate "scripts/deploy/deploy-indexer.sh"
assert_contains "- bash -n scripts/deploy/deploy-indexer.sh (shell script changed)"
assert_contains "- node scripts/check-deploy-root-anchors.test.mjs (deploy wrapper changed)"

# The status command is Node now (P15). Its own suite is the only thing that
# covers its argument parsing, renderers and cadence bands, so assert the arm
# routes it from both the module and the test — and assert it does NOT pick up
# the deploy-wrapper root-anchor contract, which is for `deploy-*.sh` files that
# source the guard and has nothing to say about a read-only Node command.
run_gate "scripts/deploy/deploy-indexer-status.mjs"
assert_contains "- pnpm lint:scripts (root build script changed)"
assert_contains "- node scripts/deploy/deploy-indexer-status.test.mjs (indexer deploy status command changed)"
assert_not_contains "- node scripts/check-deploy-root-anchors.test.mjs (deploy wrapper changed)"

run_gate "scripts/deploy/deploy-indexer-status.test.mjs"
assert_contains "- node scripts/deploy/deploy-indexer-status.test.mjs (indexer deploy status command changed)"

# The retired shell path must route nothing status-specific, so a half-finished
# rewrite that left both spellings in the arm cannot pass review.
run_gate "scripts/deploy-indexer-status.sh"
assert_not_contains "- node scripts/deploy/deploy-indexer-status.test.mjs (indexer deploy status command changed)"

run_gate "scripts/deploy/deploy-indexer-logs.sh"
assert_contains "- bash -n scripts/deploy/deploy-indexer-logs.sh (shell script changed)"
assert_contains "- node scripts/check-deploy-root-anchors.test.mjs (deploy wrapper changed)"
assert_contains "- node scripts/deploy/filter-envio-runtime-errors.test.mjs (indexer runtime-log filter changed)"

run_gate "scripts/deploy/filter-envio-runtime-errors.mjs"
assert_contains "- pnpm lint:scripts (root build script changed)"
assert_contains "- node scripts/deploy/filter-envio-runtime-errors.test.mjs (indexer runtime-log filter changed)"

run_gate "scripts/deploy/filter-envio-runtime-errors.test.mjs"
assert_contains "- pnpm lint:scripts (root build script changed)"
assert_contains "- node scripts/deploy/filter-envio-runtime-errors.test.mjs (indexer runtime-log filter changed)"

for path in \
  scripts/repo-health/file-size-watchlist.mjs \
  scripts/repo-health/file-size-watchlist-issue.mjs \
  scripts/repo-health/file-size-watchlist.test.mjs; do
  run_gate "$path"
  assert_contains "- pnpm lint:scripts (root build script changed)"
  assert_contains "- node --test scripts/repo-health/file-size-watchlist.test.mjs (file-size watchlist automation changed)"
done

# The Node deploy helpers moved with the wrappers. Their arms match exact paths,
# so a stale pattern stops routing the focused suite silently — assert each of
# the four moved specifiers reaches its own test.
run_gate "scripts/deploy/deploy-indexer-verify.mjs"
assert_contains "- pnpm lint:scripts (root build script changed)"
assert_contains "- node scripts/deploy/deploy-indexer-verify.test.mjs (indexer deploy verifier changed)"

run_gate "scripts/deploy/deploy-indexer-verify.test.mjs"
assert_contains "- pnpm lint:scripts (root build script changed)"
assert_contains "- node scripts/deploy/deploy-indexer-verify.test.mjs (indexer deploy verifier changed)"

run_gate "scripts/deploy/deploy-indexer-perf.mjs"
assert_contains "- pnpm lint:scripts (root build script changed)"
assert_contains "- node scripts/deploy/deploy-indexer-perf.test.mjs (indexer deploy perf helper changed)"

run_gate "scripts/deploy/deploy-indexer-perf.test.mjs"
assert_contains "- pnpm lint:scripts (root build script changed)"
assert_contains "- node scripts/deploy/deploy-indexer-perf.test.mjs (indexer deploy perf helper changed)"

# The pre-move paths must route NOTHING helper-specific any more. Without this
# the suite would still pass if an arm kept both spellings, which is how a
# half-finished move survives review.
run_gate "scripts/deploy-indexer-verify.mjs"
assert_not_contains "- node scripts/deploy/deploy-indexer-verify.test.mjs (indexer deploy verifier changed)"

run_gate "scripts/deploy-indexer-perf.mjs"
assert_not_contains "- node scripts/deploy/deploy-indexer-perf.test.mjs (indexer deploy perf helper changed)"

run_gate "scripts/deploy/deploy-bridge.sh"
assert_contains "- docs/pr-checklists/terraform-cloudrun.md (Cloud Run deploy script changed)"
assert_occurrences 1 "- bash -n scripts/deploy/deploy-bridge.sh (shell script changed)"
assert_contains "- node scripts/check-deploy-root-anchors.test.mjs (deploy wrapper changed)"
assert_contains "- pnpm agent:context-check (Cloud Run revision suffix guard changed)"

run_gate "scripts/check-deploy-root-anchors.test.mjs"
assert_contains "- pnpm lint:scripts (root build script changed)"
assert_contains "- node scripts/check-deploy-root-anchors.test.mjs (deploy root-anchor test changed)"

# The wrappers themselves are asserted at their real paths above. What is left to
# pin is the routing the move does NOT make concrete: depth beyond one level, the
# sibling path the pattern also reaches, and the Node negative control.
#
# Two levels down. The wrappers sit at scripts/deploy/ today, so a one-level
# assertion alone would not notice a pattern narrowed to exactly that directory.
# `*` matches `/` in a `case` pattern, so the pair reaches any depth — assert a
# generic wrapper and a specialized one, because the specialized arm matches an
# exact basename and could be narrowed independently of the glob.
run_gate "scripts/deploy/region/deploy-probe.sh"
assert_contains "- node scripts/check-deploy-root-anchors.test.mjs (deploy wrapper changed)"

run_gate "scripts/deploy/region/deploy-indexer-logs.sh"
assert_contains "- node scripts/check-deploy-root-anchors.test.mjs (deploy wrapper changed)"
assert_contains "- node scripts/deploy/filter-envio-runtime-errors.test.mjs (indexer runtime-log filter changed)"

# The Node helpers get the same depth pin, and need it more: a wrapper that moves
# again still lands on the generic deploy glob, while a .mjs has no
# deploy-specific fallback — it would keep only `pnpm lint:scripts` and stop
# running its suite with nothing red.
run_gate "scripts/deploy/region/deploy-indexer-verify.mjs"
assert_contains "- node scripts/deploy/deploy-indexer-verify.test.mjs (indexer deploy verifier changed)"

run_gate "scripts/deploy/region/deploy-indexer-perf.test.mjs"
assert_contains "- node scripts/deploy/deploy-indexer-perf.test.mjs (indexer deploy perf helper changed)"

run_gate "scripts/deploy/region/filter-envio-runtime-errors.mjs"
assert_contains "- node scripts/deploy/filter-envio-runtime-errors.test.mjs (indexer runtime-log filter changed)"

run_gate "scripts/deploy/region/deploy-indexer-status.mjs"
assert_contains "- node scripts/deploy/deploy-indexer-status.test.mjs (indexer deploy status command changed)"

# The bridge carries the most to lose at depth — narrowing its arm back to the
# exact path would drop the Cloud Run checklist and the revision-suffix guard,
# and only this case would notice.
run_gate "scripts/deploy/region/deploy-bridge.sh"
assert_contains "- node scripts/check-deploy-root-anchors.test.mjs (deploy wrapper changed)"
assert_contains "- docs/pr-checklists/terraform-cloudrun.md (Cloud Run deploy script changed)"
assert_contains "- pnpm agent:context-check (Cloud Run revision suffix guard changed)"

run_gate "scripts/filter-envio-runtime-errors.mjs"
assert_not_contains "- node scripts/deploy/filter-envio-runtime-errors.test.mjs (indexer runtime-log filter changed)"

# `*` matches `/`, so the paired arm reaches a `deploy-*.sh` basename under ANY
# scripts/ subdirectory, not only a future scripts/deploy/. That breadth is the
# point: check-deploy-root-anchors.test.mjs walks scripts/ recursively too, so
# routing that stopped at one fixed directory would again be narrower than the
# check it schedules. The live path it newly reaches is the shared guard every
# wrapper sources — the one file whose change can break all of them at once —
# and the check exists to assert they still source it. Pin it so the reach is a
# recorded decision, and so a later arm of the same shape has to be placed
# BEFORE this one rather than being silently shadowed by it.
run_gate "scripts/lib/deploy-guard.sh"
assert_contains "- node scripts/check-deploy-root-anchors.test.mjs (deploy wrapper changed)"
# The reach is purely additive: this live path keeps everything it routed before
# the pair existed. Assert that too, so a future arm ordering that swallows it
# reds here instead of quietly thinning the guard's routing.
assert_contains "- bash -n scripts/lib/deploy-guard.sh (shell script changed)"

# The arm stays shell-scoped on purpose: the check's subject set is `deploy-*.sh`
# files that source lib/deploy-guard.sh, so a Node helper moving into the same
# directory must NOT pick it up. Pin that, or the next widening quietly schedules
# a shell contract for files it cannot assert anything about.
run_gate "scripts/deploy/deploy-indexer-perf.mjs"
assert_contains "- pnpm lint:scripts (root build script changed)"
assert_not_contains "- node scripts/check-deploy-root-anchors.test.mjs (deploy wrapper changed)"

run_gate "scripts/bootstrap/agent-session-end-hook.sh"
assert_contains "- bash -n scripts/bootstrap/agent-session-end-hook.sh (shell script changed)"
assert_contains "- pnpm agent:context-check (agent SessionEnd hook changed)"

for path in \
  scripts/bootstrap/codex-cloud-setup.sh \
  scripts/bootstrap/codex-cloud-setup.test.sh; do
  run_gate "$path"
  assert_contains "- bash -n $path (shell script changed)"
  assert_contains "- bash scripts/bootstrap/codex-cloud-setup.test.sh (Codex Cloud Foundry installer contract changed)"
done

run_gate "scripts/lib/install-marker.sh"
assert_contains "- bash -n scripts/lib/install-marker.sh (shell script changed)"
assert_contains "- pnpm agent:quality-gate:test (shared install-marker fragment changed)"

run_gate "scripts/setup.sh"
assert_contains "- bash -n scripts/setup.sh (shell script changed)"
assert_contains "- pnpm agent:quality-gate:test (install-marker consumer changed)"

run_gate "scripts/bootstrap/claude-code-web-setup.sh"
assert_contains "- bash -n scripts/bootstrap/claude-code-web-setup.sh (shell script changed)"
assert_contains "- pnpm agent:quality-gate:test (install-marker consumer changed)"

# The React Doctor wrappers live in ui-dashboard/scripts/, not scripts/. The
# routing suite still owns them because it copies and runs the diff wrapper in
# a stub repo, so assert both that the package path routes and that the retired
# root path no longer does.
run_gate "ui-dashboard/scripts/check-react-doctor-diff.sh"
assert_contains "- bash -n ui-dashboard/scripts/check-react-doctor-diff.sh (shell script changed)"
assert_contains "- pnpm agent:quality-gate:test (React Doctor wrapper changed)"

run_gate "ui-dashboard/scripts/check-react-doctor-score.sh"
assert_contains "- bash -n ui-dashboard/scripts/check-react-doctor-score.sh (shell script changed)"
assert_contains "- pnpm agent:quality-gate:test (React Doctor wrapper changed)"

run_gate "scripts/check-react-doctor-diff.sh"
assert_not_contains "(React Doctor wrapper changed)"
assert_not_contains "(agent quality gate mapping changed)"

run_gate "scripts/check-react-doctor-score.sh"
assert_not_contains "(React Doctor wrapper changed)"
assert_not_contains "(agent quality gate mapping changed)"

run_gate "scripts/check-agent-quality-gate-package-scripts.mjs"
# The validator is Node, so it routes through the `scripts/*.mjs` arm: ESLint
# replaces the `bash -n` syntax check it got as a shell script.
assert_not_contains "- bash -n scripts/check-agent-quality-gate-package-scripts"
assert_contains "- pnpm lint:scripts (root build script changed)"
assert_contains "- node scripts/check-agent-quality-gate-package-scripts.mjs (agent quality gate package script validator changed)"
assert_contains "- pnpm agent:quality-gate:test (agent quality gate mapping changed)"

run_gate ".agents/skills/ship/SKILL.md"
assert_contains "- agent-context"
assert_contains "- pnpm agent:context-check (agent context files changed)"
assert_contains "- node scripts/repo-health/check-skills-mirror.test.mjs (skills mirror content changed)"
assert_contains "- node scripts/repo-health/check-skills-mirror.mjs (skills mirror content changed)"

run_gate ".claude/skills/ship/SKILL.md"
assert_contains "- agent-context"
assert_contains "- pnpm agent:context-check (agent context files changed)"
assert_contains "- node scripts/repo-health/check-skills-mirror.test.mjs (skills mirror content changed)"
assert_contains "- node scripts/repo-health/check-skills-mirror.mjs (skills mirror content changed)"

run_gate "scripts/repo-health/check-skills-mirror.mjs"
assert_contains "- pnpm lint:scripts (root build script changed)"
assert_contains "- node scripts/repo-health/check-skills-mirror.test.mjs (skills mirror checker changed)"
assert_contains "- node scripts/repo-health/check-skills-mirror.mjs (skills mirror checker changed)"

run_gate "scripts/repo-health/check-skills-mirror.test.mjs"
assert_contains "- pnpm lint:scripts (root build script changed)"
assert_contains "- node scripts/repo-health/check-skills-mirror.test.mjs (skills mirror checker changed)"
assert_contains "- node scripts/repo-health/check-skills-mirror.mjs (skills mirror checker changed)"

run_gate ".trunk/trunk.yaml"
assert_contains "- tooling"
assert_contains "- node scripts/workflows/check-github-action-pins.mjs (Trunk workflow/action setup changed)"
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
assert_contains "- TF_DATA_DIR=terraform/.terraform-agent-gate node scripts/terraform/terraform-fmt-check.mjs terraform (Terraform stack registry changed)"
assert_contains "- TF_DATA_DIR=alerts/rules/.terraform-agent-gate node scripts/terraform/terraform-fmt-check.mjs alerts/rules (Terraform stack registry changed)"
assert_contains "- TF_DATA_DIR=alerts/infra/.terraform-agent-gate node scripts/terraform/terraform-fmt-check.mjs alerts/infra (Terraform stack registry changed)"
assert_contains "- TF_DATA_DIR=aegis/terraform/.terraform-agent-gate node scripts/terraform/terraform-fmt-check.mjs aegis/terraform (Terraform stack registry changed)"

run_gate "scripts/tf-stacks.mjs"
assert_contains "- pnpm tf:test (Terraform stack wrapper changed)"
assert_contains "- TF_DATA_DIR=terraform/.terraform-agent-gate node scripts/terraform/terraform-fmt-check.mjs terraform (Terraform stack wrapper changed)"
assert_contains "- TF_DATA_DIR=alerts/rules/.terraform-agent-gate node scripts/terraform/terraform-fmt-check.mjs alerts/rules (Terraform stack wrapper changed)"
assert_contains "- TF_DATA_DIR=alerts/infra/.terraform-agent-gate node scripts/terraform/terraform-fmt-check.mjs alerts/infra (Terraform stack wrapper changed)"
assert_contains "- TF_DATA_DIR=aegis/terraform/.terraform-agent-gate node scripts/terraform/terraform-fmt-check.mjs aegis/terraform (Terraform stack wrapper changed)"

run_gate "scripts/terraform/tf-platform-plan-guard.mjs"
assert_contains "- pnpm tf:test (Terraform stack wrapper changed)"
assert_contains "- TF_DATA_DIR=terraform/.terraform-agent-gate node scripts/terraform/terraform-fmt-check.mjs terraform (Terraform stack wrapper changed)"

run_gate "scripts/terraform/check-metrics-bridge-template-plan.mjs"
assert_contains "- pnpm tf:test (Terraform stack wrapper changed)"
assert_contains "- TF_DATA_DIR=terraform/.terraform-agent-gate node scripts/terraform/terraform-fmt-check.mjs terraform (Terraform stack wrapper changed)"

for deploy_staging_contract_case in \
  '.github/workflows/metrics-bridge.yml|docs/pr-checklists/terraform-cloudrun.md (metrics bridge Cloud Run workflow changed)' \
  'scripts/deploy/deploy-bridge.sh|node scripts/check-deploy-root-anchors.test.mjs (deploy wrapper changed)' \
  'aegis/grafana-agent/deploy.sh|docs/pr-checklists/ci-workflow-gates.md (Aegis deploy path changed)' \
  'aegis/bin/deploy.sh|docs/pr-checklists/ci-workflow-gates.md (Aegis deploy path changed)' \
  'aegis/grafana-agent/cloudbuild.yaml|docs/pr-checklists/ci-workflow-gates.md (Aegis deploy path changed)' \
  'scripts/deploy-staging-callsite-discovery.mjs|pnpm lint:scripts (root build script changed)' \
  'scripts/deploy-staging-contract.mjs|pnpm lint:scripts (root build script changed)' \
  'scripts/deploy-staging-contract.test.mjs|pnpm lint:scripts (root build script changed)'; do
  IFS='|' read -r deploy_staging_contract_path existing_mapping <<< "$deploy_staging_contract_case"
  run_gate "$deploy_staging_contract_path"
  assert_contains "- $existing_mapping"
  assert_occurrences 1 "- pnpm tf:test ("
done

# The production infrastructure contract is not path-scoped: an ordinary
# application change must still route exactly one canonical tf:test command.
run_gate "ui-dashboard/src/deploy.ts"
assert_occurrences 1 "- pnpm tf:test (non-empty change set validates production infrastructure contract)"

run_gate "scripts/terraform/terraform-fmt-check.mjs"
assert_contains "- node scripts/terraform/terraform-fmt-check.test.mjs (Terraform format helper changed)"
assert_contains "- pnpm tf:test (Terraform format helper changed)"
assert_contains "- TF_DATA_DIR=terraform/.terraform-agent-gate node scripts/terraform/terraform-fmt-check.mjs terraform (Terraform format helper changed)"
assert_contains "- TF_DATA_DIR=alerts/rules/.terraform-agent-gate node scripts/terraform/terraform-fmt-check.mjs alerts/rules (Terraform format helper changed)"
assert_contains "- TF_DATA_DIR=alerts/infra/.terraform-agent-gate node scripts/terraform/terraform-fmt-check.mjs alerts/infra (Terraform format helper changed)"
assert_contains "- TF_DATA_DIR=aegis/terraform/.terraform-agent-gate node scripts/terraform/terraform-fmt-check.mjs aegis/terraform (Terraform format helper changed)"
assert_contains "- TF_DATA_DIR=governance-watchdog/infra/.terraform-agent-gate node scripts/terraform/terraform-fmt-check.mjs governance-watchdog/infra (Terraform format helper changed)"

run_gate "scripts/terraform/terraform-fmt-check.test.mjs"
assert_contains "- node scripts/terraform/terraform-fmt-check.test.mjs (Terraform format helper test changed)"

# The two apply-pipeline notifiers moved with the guards (P10) and had no
# routing assertion before. A missed repoint drops their focused suite without
# failing anything.
run_gate "scripts/terraform/notify-terraform-apply.mjs"
assert_contains "- node scripts/terraform/notify-terraform-apply.test.mjs (Terraform apply Slack notifier changed)"

run_gate "scripts/terraform/check-terraform-deploy-queue.mjs"
assert_contains "- node scripts/terraform/check-terraform-deploy-queue.test.mjs (Terraform deploy queue watcher changed)"

# The fmt check is a fail-fast prerequisite, not a parallel-pool command.
# `add_terraform_validate_commands` builds the command string;
# `is_quality_setup_command` recognizes it with a literal glob. Repointing one
# without the other fails silently — the check still runs, just demoted into the
# parallel pool with keep-going semantics. Read the classifier's pattern out of
# the gate source and match it against the command the gate actually emitted, so
# the two cannot drift apart unnoticed.
terraform_fmt_setup_pattern="$(
  awk '/^is_quality_setup_command\(\) \{/,/^\}/' scripts/agent-quality-gate.sh |
    awk '/^    TF_DATA_DIR=.*terraform-fmt-check[^)]*\)$/ {
      sub(/\)$/, ""); sub(/^    /, ""); print
    }'
)"
[[ -n "$terraform_fmt_setup_pattern" ]] ||
  fail "is_quality_setup_command has no terraform-fmt-check setup pattern"
# The source pattern escapes its spaces for `case`; an unquoted `[[ ]]` right
# operand needs them plain.
terraform_fmt_setup_pattern="${terraform_fmt_setup_pattern//\\ / }"
run_gate "terraform/main.tf"
terraform_fmt_mapped_command="$(
  awk '/^- TF_DATA_DIR=.*terraform-fmt-check\.mjs / {
    line = $0
    sub(/^- /, "", line)
    sub(/ \([^(]*\)$/, "", line)
    print line
    exit
  }' "$output_file"
)"
[[ -n "$terraform_fmt_mapped_command" ]] ||
  fail "gate mapped no terraform-fmt-check command for a terraform/ change"
# shellcheck disable=SC2053 # deliberate glob match against a source-derived pattern
[[ "$terraform_fmt_mapped_command" == $terraform_fmt_setup_pattern ]] ||
  fail "is_quality_setup_command no longer classifies '$terraform_fmt_mapped_command' as a setup command"
# Negative control: the pre-P10 flat path must not satisfy the pattern, or the
# match above would pass for the wrong reason.
# shellcheck disable=SC2053 # deliberate glob match against a source-derived pattern
if [[ "${terraform_fmt_mapped_command/scripts\/terraform\//scripts/}" == $terraform_fmt_setup_pattern ]]; then
  fail "is_quality_setup_command still matches the pre-move flat terraform-fmt-check path"
fi
} # end family: routing-sources

# family: execution-phases
# Real fixture runs: phase order, fail-fast prerequisites, the parallel
# quality pool, quality-setup commands, and dashboard serialization.
run_execution_phases_family() {
arm_suite_abort_trap
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
  mkdir -p bin scripts/gate tools
  printf 'console.log("fixture");\n' > scripts/gate/agent-prewarm.mjs
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
  printf 'scripts/gate/agent-prewarm.mjs\n' > changed-paths.txt
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
assert_contains "+ ./tools/trunk check scripts/gate/agent-prewarm.mjs"
assert_contains "+ pnpm lint:scripts"
assert_contains "+ pnpm agent:prewarm:test"
assert_contains "All mapped commands passed."
assert_not_contains "parallel marker was not created"

# A package.json edit confined to allowlisted aliases classifies as
# root-tooling-scripts and is exempt from --allow-package-script-changes. That
# exemption is only safe while every allowlisted alias is pinned to an exact
# command, so the pin validator has to be a fail-fast PREREQUISITE: if it runs
# in the same pool as the aliases, an edit appending `&& <anything>` to a
# trusted alias executes on the developer's machine before the gate reports the
# unpinned command. The stub pnpm here touches a marker; it must never run.
pin_prerequisite_repo="$(mktemp -d)"
pin_prerequisite_marker="$pin_prerequisite_repo/pool-marker"
(
  cd "$pin_prerequisite_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  mkdir -p bin scripts tools
  cat > package.json <<'JSON'
{
  "name": "quality-gate-pin-fixture",
  "scripts": {
    "sentry:project:test": "node ok.mjs"
  }
}
JSON
  cat > scripts/check-agent-quality-gate-package-scripts.mjs <<'STUB'
console.error('package.json scripts.sentry:project:test must be "node ok.mjs"');
process.exit(1);
STUB
  cat > tools/trunk <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  cat > bin/pnpm <<'STUB'
#!/usr/bin/env bash
: > "${POOL_MARKER:?}"
STUB
  chmod +x bin/pnpm tools/trunk
  git add .
  git commit -qm init
  cat > package.json <<'JSON'
{
  "name": "quality-gate-pin-fixture",
  "scripts": {
    "sentry:project:test": "node ok.mjs && echo appended"
  }
}
JSON
  set +e
  POOL_MARKER="$pin_prerequisite_marker" \
    PATH="$pin_prerequisite_repo/bin:$PATH" \
    "$repo_root/scripts/agent-quality-gate.sh" \
    --base HEAD \
    --run \
    --parallel 4 \
    > "$output_file" 2>&1
  exit_code=$?
  set -e
  [[ "$exit_code" -ne 0 ]]
)
if [[ -f "$pin_prerequisite_marker" ]]; then
  rm -rf "$pin_prerequisite_repo"
  fail "the quality pool ran a trusted pnpm alias even though the pin validator failed"
fi
rm -rf "$pin_prerequisite_repo"
assert_contains "+ node scripts/check-agent-quality-gate-package-scripts.mjs"
assert_contains "Stopping after first failed mapped command (--fail-fast)."
assert_not_contains "Running quality commands with parallelism 4."

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
  mkdir -p bin scripts/gate tools
  printf 'console.log("fixture");\n' > scripts/gate/agent-prewarm.mjs
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
  printf 'scripts/gate/agent-prewarm.mjs\n' > changed-paths.txt
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
} # end family: execution-phases

# family: stamps-freshness
# The fresh-run stamp: what busts it (content, file mode, index state,
# command plan, base OID, gate implementation) and what may reuse it.
run_stamps_freshness_family() {
arm_suite_abort_trap
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
  # The stub exists to make the MAPPED commands free, not to break the gate's
  # own Node helpers. Those are the `--input-type=module` heredocs and, since
  # D5b part 2, the mapping engine the gate runs to build its plan at all — a
  # stubbed-out mapper produces an empty plan and the gate refuses the run,
  # which is the guard working, not the fixture.
  cat > bin/node <<'STUB'
#!/usr/bin/env bash
if [[ "${1:-}" == "--input-type=module" ]]; then
  exec "${REAL_NODE:?}" "$@"
fi
case "${1:-}" in
  *"/scripts/gate/mapping.mjs") exec "${REAL_NODE:?}" "$@" ;;
esac
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
  REAL_NODE="$(command -v node)" \
    COUNTER_FILE="$workflow_fresh_stamp_repo/.tmp/agent-quality-gate/trunk-count" \
    PATH="$workflow_fresh_stamp_repo/bin:$PATH" \
    "$repo_root/scripts/agent-quality-gate.sh" --base "$base_ref" --run > "$output_file" 2>&1
  REAL_NODE="$(command -v node)" \
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

# GitHub issue #1899: staging a file the gate was already validating changes
# nothing about what it validates. An untracked path is invisible to
# `git diff`, so `git add` alone used to start a ` create mode` summary line
# and cost a warm stamp a full re-run — with the changed-path set, the mapped
# command plan, the base OID and the file's own bytes provably unchanged. The
# three cases that must still bust the stamp are here beside it: content,
# file mode, and an add that genuinely changes what the gate routes.
index_state_stamp_repo="$(mktemp -d)"
(
  cd "$index_state_stamp_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  printf 'fixture\n' > fixture.txt
  printf 'ignored-*\n' > .gitignore
  mkdir -p tools
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
  base_ref="$(git rev-parse --verify HEAD)"
  counter="$index_state_stamp_repo/.tmp/agent-quality-gate/trunk-count"
  printf 'changed\n' >> fixture.txt
  printf 'brand new\n' > new.txt

  index_state_gate() {
    COUNTER_FILE="$counter" \
      "$repo_root/scripts/agent-quality-gate.sh" --base "$base_ref" "$@" \
      > "$output_file" 2>&1
  }

  index_state_gate --run
  index_state_before="$(sed -n '2s/^stamp=//p' \
    "$index_state_stamp_repo/.tmp/agent-quality-gate/last-success.stamp")"

  # Bytes untouched, tracking state changed.
  git add new.txt
  index_state_gate --run --skip-if-fresh
  [[ "$(cat "$counter")" == "1" ]] ||
    fail "staging an already-validated untracked file re-ran the mapped commands"
  grep -Fq -- "Previous successful agent quality gate run is still fresh; skipping mapped commands." \
    "$output_file" ||
    fail "staging an already-validated untracked file lost the freshness stamp"

  # The same transition must not have quietly frozen the signature: the stamp
  # a skip reuses is still the one the warm run wrote.
  index_state_after="$(sed -n '2s/^stamp=//p' \
    "$index_state_stamp_repo/.tmp/agent-quality-gate/last-success.stamp")"
  [[ "$index_state_after" == "$index_state_before" ]] ||
    fail "the reused stamp is not the one the warm run wrote"

  # Content still moves it.
  printf 'edited after staging\n' >> new.txt
  index_state_gate --run --skip-if-fresh
  [[ "$(cat "$counter")" == "2" ]] ||
    fail "editing a staged file reused the stamp warmed before the edit"

  # So does the file mode, which the dropped summary line used to carry.
  chmod +x new.txt
  index_state_gate --run --skip-if-fresh
  [[ "$(cat "$counter")" == "3" ]] ||
    fail "making a validated file executable reused the stamp warmed before it"

  # An ignored file is not routed, so creating one changes nothing …
  printf 'hidden\n' > ignored-file.txt
  index_state_gate --run --skip-if-fresh
  [[ "$(cat "$counter")" == "3" ]] ||
    fail "an ignored file the gate never routes invalidated the stamp"

  # … but forcing it into the index adds a path the gate routes, and that is a
  # different validation plan, not an index-state transition.
  git add -f ignored-file.txt
  index_state_gate --run --skip-if-fresh
  [[ "$(cat "$counter")" == "4" ]] ||
    fail "an add that changed the routed path set reused the stamp warmed before it"
  grep -Fq -- "- ignored-file.txt" "$output_file" ||
    fail "the forced add did not reach the gate's routed path set"
)
rm -rf "$index_state_stamp_repo"

# Extending the reuse window must not weaken any exact-signature binding. Use
# equal-tree base commits to isolate the base OID, then change the validation
# path/command plan and the fixture's gate implementation independently. Every
# change must execute the mapped command again instead of reusing the stamp.
signature_stamp_repo="$(mktemp -d)"
signature_runtime_root="$gate_cache_dir/signature-runtime-source"
mkdir -p \
  "$signature_runtime_root/scripts/docs" \
  "$signature_runtime_root/scripts/gate/mapping" \
  "$signature_runtime_root/scripts/gate/routing-table"
cp "$repo_root/scripts/agent-quality-gate.sh" \
  "$signature_runtime_root/scripts/agent-quality-gate.sh"
cp "$repo_root/scripts/agent-autoreview-core.mjs" \
  "$signature_runtime_root/scripts/agent-autoreview-core.mjs"
cp "$repo_root/scripts/gate/run-handles.sh" \
  "$signature_runtime_root/scripts/gate/run-handles.sh"
cp "$repo_root/scripts/gate/mapping.mjs" \
  "$signature_runtime_root/scripts/gate/mapping.mjs"
cp "$repo_root"/scripts/gate/mapping/*.mjs \
  "$signature_runtime_root/scripts/gate/mapping/"
cp "$repo_root"/scripts/gate/routing-table/*.mjs \
  "$signature_runtime_root/scripts/gate/routing-table/"
printf 'export function isRoutingSensitivePath() { return false; }\n' \
  > "$signature_runtime_root/scripts/docs/docs-navigation-eval-helpers.mjs"
printf '#!/usr/bin/env node\nprocess.exit(1);\n' \
  > "$signature_runtime_root/scripts/gate/lockfile-scope.mjs"
chmod +x "$signature_runtime_root/scripts/agent-quality-gate.sh"
(
  cd "$signature_stamp_repo"
  signature_gate="$signature_runtime_root/scripts/agent-quality-gate.sh"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  mkdir -p \
    scripts/docs \
    scripts/gate/mapping \
    scripts/gate/routing-table \
    scripts/terraform \
    tools
  printf 'fixture\n' > fixture.txt
  printf 'second fixture\n' > second.txt
  printf '# fixture gate implementation\n' > scripts/agent-quality-gate.sh
  printf '// fixture autoreview core routing source\n' > scripts/agent-autoreview-core.mjs
  printf '// fixture alias validator\n' > scripts/check-agent-quality-gate-package-scripts.mjs
  printf '# fixture routing classifier\n' > scripts/docs/docs-navigation-eval-helpers.mjs
  printf '# fixture lockfile scope classifier\n' > scripts/gate/lockfile-scope.mjs
  printf '# fixture run-handle helper\n' > scripts/gate/run-handles.sh
  printf '// fixture mapper entry\n' > scripts/gate/mapping.mjs
  printf '// fixture mapper runtime module\n' > scripts/gate/mapping/facts.mjs
  printf '// fixture mapper suite\n' > scripts/gate/mapping/engine.test.mjs
  printf '// fixture routing-table runtime module\n' > scripts/gate/routing-table/index.mjs
  printf '// fixture routing-table suite\n' > scripts/gate/routing-table/routing-table.test.mjs
  printf '# fixture terraform format checker\n' > scripts/terraform/terraform-fmt-check.mjs
  printf '# fixture terraform format checker suite\n' > scripts/terraform/terraform-fmt-check.test.mjs
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

  run_signature_gate_again() {
    COUNTER_FILE="$signature_stamp_repo/.tmp/agent-quality-gate/trunk-count" \
      "$signature_gate" \
        --changed-paths-file changed-paths-two.txt \
        --base "$base_two" \
        --run \
        --skip-if-fresh \
        > "$output_file" 2>&1
  }

  COUNTER_FILE="$signature_stamp_repo/.tmp/agent-quality-gate/trunk-count" \
    "$signature_gate" \
      --changed-paths-file changed-paths-one.txt \
      --base "$base_one" \
      --run \
      > "$output_file" 2>&1
  COUNTER_FILE="$signature_stamp_repo/.tmp/agent-quality-gate/trunk-count" \
    "$signature_gate" \
      --changed-paths-file changed-paths-one.txt \
      --base "$base_two" \
      --run \
      --skip-if-fresh \
      > "$output_file" 2>&1
  [[ "$(cat "$signature_stamp_repo/.tmp/agent-quality-gate/trunk-count")" == "2" ]] ||
    fail "fresh gate stamp was reused after the base OID changed"

  COUNTER_FILE="$signature_stamp_repo/.tmp/agent-quality-gate/trunk-count" \
    "$signature_gate" \
      --changed-paths-file changed-paths-two.txt \
      --base "$base_two" \
      --run \
      --skip-if-fresh \
      > "$output_file" 2>&1
  [[ "$(cat "$signature_stamp_repo/.tmp/agent-quality-gate/trunk-count")" == "3" ]] ||
    fail "fresh gate stamp was reused after the validation path/command plan changed"

  printf '# changed runtime gate implementation\n' >> "$signature_gate"
  COUNTER_FILE="$signature_stamp_repo/.tmp/agent-quality-gate/trunk-count" \
    "$signature_gate" \
      --changed-paths-file changed-paths-two.txt \
      --base "$base_two" \
      --run \
      --skip-if-fresh \
      > "$output_file" 2>&1
  [[ "$(cat "$signature_stamp_repo/.tmp/agent-quality-gate/trunk-count")" == "4" ]] ||
    fail "fresh gate stamp was reused after the gate implementation changed"

  printf '// changed runtime routing classifier\n' \
    >> "$signature_runtime_root/scripts/docs/docs-navigation-eval-helpers.mjs"
  COUNTER_FILE="$signature_stamp_repo/.tmp/agent-quality-gate/trunk-count" \
    "$signature_gate" \
      --changed-paths-file changed-paths-two.txt \
      --base "$base_two" \
      --run \
      --skip-if-fresh \
      > "$output_file" 2>&1
  [[ "$(cat "$signature_stamp_repo/.tmp/agent-quality-gate/trunk-count")" == "5" ]] ||
    fail "fresh gate stamp was reused after the routing classifier changed"

  # The mapper and routing-table runtime load from this gate's source tree.
  # Placeholders in the repository under test must not affect the signature;
  # changing the loaded copies must invalidate it.
  printf '// changed fixture mapper placeholders\n' >> scripts/gate/mapping.mjs
  printf '// changed fixture mapper module placeholder\n' >> scripts/gate/mapping/facts.mjs
  run_signature_gate_again
  [[ "$(cat "$signature_stamp_repo/.tmp/agent-quality-gate/trunk-count")" == "5" ]] ||
    fail "non-runtime mapper placeholders invalidated the fresh stamp"

  printf '// changed runtime mapper entry\n' \
    >> "$signature_runtime_root/scripts/gate/mapping.mjs"
  printf '// changed runtime mapper module\n' \
    >> "$signature_runtime_root/scripts/gate/mapping/facts.mjs"
  run_signature_gate_again
  [[ "$(cat "$signature_stamp_repo/.tmp/agent-quality-gate/trunk-count")" == "6" ]] ||
    fail "fresh gate stamp was reused after the loaded mapper changed"

  printf '// changed fixture routing-table placeholder\n' \
    >> scripts/gate/routing-table/index.mjs
  run_signature_gate_again
  [[ "$(cat "$signature_stamp_repo/.tmp/agent-quality-gate/trunk-count")" == "6" ]] ||
    fail "a non-runtime routing-table placeholder invalidated the fresh stamp"

  printf '// changed runtime routing-table module\n' \
    >> "$signature_runtime_root/scripts/gate/routing-table/index.mjs"
  run_signature_gate_again
  [[ "$(cat "$signature_stamp_repo/.tmp/agent-quality-gate/trunk-count")" == "7" ]] ||
    fail "fresh gate stamp was reused after the loaded routing table changed"

  # Suites and the parity harness are mapped target-tree commands, not modules
  # loaded by the mapper. Their source-tree copies must stay outside the pin.
  printf '// changed source mapper suite copy\n' \
    >> "$signature_runtime_root/scripts/gate/mapping/engine.test.mjs"
  run_signature_gate_again
  [[ "$(cat "$signature_stamp_repo/.tmp/agent-quality-gate/trunk-count")" == "7" ]] ||
    fail "a non-runtime source mapper suite invalidated the fresh stamp"
  printf '// changed fixture mapper suite\n' >> scripts/gate/mapping/engine.test.mjs
  run_signature_gate_again
  [[ "$(cat "$signature_stamp_repo/.tmp/agent-quality-gate/trunk-count")" == "8" ]] ||
    fail "fresh gate stamp was reused after the target mapper suite changed"

  printf '// changed source routing-table suite copy\n' \
    >> "$signature_runtime_root/scripts/gate/routing-table/routing-table.test.mjs"
  run_signature_gate_again
  [[ "$(cat "$signature_stamp_repo/.tmp/agent-quality-gate/trunk-count")" == "8" ]] ||
    fail "a non-runtime source routing-table suite invalidated the fresh stamp"
  printf '// changed fixture routing-table suite\n' \
    >> scripts/gate/routing-table/routing-table.test.mjs
  run_signature_gate_again
  [[ "$(cat "$signature_stamp_repo/.tmp/agent-quality-gate/trunk-count")" == "9" ]] ||
    fail "fresh gate stamp was reused after the target routing-table suite changed"

  # The routing table imports the indexer family view from the gate's source
  # tree. A target-repo placeholder must not affect the signature, while the
  # loaded source-tree copy must invalidate it independently.
  printf '// changed fixture autoreview core routing source\n' \
    >> scripts/agent-autoreview-core.mjs
  run_signature_gate_again
  [[ "$(cat "$signature_stamp_repo/.tmp/agent-quality-gate/trunk-count")" == "9" ]] ||
    fail "a non-runtime autoreview core placeholder invalidated the fresh stamp"

  printf '// changed runtime autoreview core routing source\n' \
    >> "$signature_runtime_root/scripts/agent-autoreview-core.mjs"
  COUNTER_FILE="$signature_stamp_repo/.tmp/agent-quality-gate/trunk-count" \
    "$signature_gate" \
      --changed-paths-file changed-paths-two.txt \
      --base "$base_two" \
      --run \
      --skip-if-fresh \
      > "$output_file" 2>&1
  [[ "$(cat "$signature_stamp_repo/.tmp/agent-quality-gate/trunk-count")" == "10" ]] ||
    fail "fresh gate stamp was reused after the indexer routing source changed"

  # The signature has two path roots. Runtime modules come from the gate's own
  # checkout, while commands and configuration come from the repository under
  # test. The runtime gate and routing checks above cover the first root. These
  # Terraform command checks cover the second root.
  printf '# changed fixture terraform format checker\n' >> scripts/terraform/terraform-fmt-check.mjs
  COUNTER_FILE="$signature_stamp_repo/.tmp/agent-quality-gate/trunk-count" \
    "$signature_gate" \
      --changed-paths-file changed-paths-two.txt \
      --base "$base_two" \
      --run \
      --skip-if-fresh \
      > "$output_file" 2>&1
  [[ "$(cat "$signature_stamp_repo/.tmp/agent-quality-gate/trunk-count")" == "11" ]] ||
    fail "fresh gate stamp was reused after the Terraform format checker changed"

  printf '# changed fixture terraform format checker suite\n' >> scripts/terraform/terraform-fmt-check.test.mjs
  COUNTER_FILE="$signature_stamp_repo/.tmp/agent-quality-gate/trunk-count" \
    "$signature_gate" \
      --changed-paths-file changed-paths-two.txt \
      --base "$base_two" \
      --run \
      --skip-if-fresh \
      > "$output_file" 2>&1
  [[ "$(cat "$signature_stamp_repo/.tmp/agent-quality-gate/trunk-count")" == "12" ]] ||
    fail "fresh gate stamp was reused after the Terraform format checker suite changed"

  # GitHub issue #1905: the lockfile scope classifier is a gate runtime pin, so
  # editing it has to move the signature. Its caller reads a nonzero exit as
  # "cannot narrow", so a stale stamp here hides a routing change nothing else
  # reports.
  printf '// changed runtime lockfile scope classifier\n' \
    >> "$signature_runtime_root/scripts/gate/lockfile-scope.mjs"
  COUNTER_FILE="$signature_stamp_repo/.tmp/agent-quality-gate/trunk-count" \
    "$signature_gate" \
      --changed-paths-file changed-paths-two.txt \
      --base "$base_two" \
      --run \
      --skip-if-fresh \
      > "$output_file" 2>&1
  [[ "$(cat "$signature_stamp_repo/.tmp/agent-quality-gate/trunk-count")" == "13" ]] ||
    fail "fresh gate stamp was reused after the lockfile scope classifier changed"

  # A placeholder in the repository under test is not the helper this gate
  # loaded. Changing it must keep the stamp warm.
  printf '# changed fixture run-handle placeholder\n' >> scripts/gate/run-handles.sh
  COUNTER_FILE="$signature_stamp_repo/.tmp/agent-quality-gate/trunk-count" \
    "$signature_gate" \
      --changed-paths-file changed-paths-two.txt \
      --base "$base_two" \
      --run \
      --skip-if-fresh \
      > "$output_file" 2>&1
  [[ "$(cat "$signature_stamp_repo/.tmp/agent-quality-gate/trunk-count")" == "13" ]] ||
    fail "a non-runtime run-handle placeholder invalidated the fresh stamp"

  printf '# changed runtime run-handle helper\n' \
    >> "$signature_runtime_root/scripts/gate/run-handles.sh"
  COUNTER_FILE="$signature_stamp_repo/.tmp/agent-quality-gate/trunk-count" \
    "$signature_gate" \
      --changed-paths-file changed-paths-two.txt \
      --base "$base_two" \
      --run \
      --skip-if-fresh \
      > "$output_file" 2>&1
  [[ "$(cat "$signature_stamp_repo/.tmp/agent-quality-gate/trunk-count")" == "14" ]] ||
    fail "fresh gate stamp was reused after the loaded run-handle helper changed"

  # P12 renamed the pinned alias registry from .sh to .mjs. Left stale, the
  # signature entry hashes as `__missing__` on every run, so an edit to the one
  # check that stops a package-only PR redirecting a trusted command would be
  # skipped behind a stamp warmed before it.
  printf '// changed fixture alias validator\n' >> scripts/check-agent-quality-gate-package-scripts.mjs
  COUNTER_FILE="$signature_stamp_repo/.tmp/agent-quality-gate/trunk-count" \
    "$signature_gate" \
      --changed-paths-file changed-paths-two.txt \
      --base "$base_two" \
      --run \
      --skip-if-fresh \
      > "$output_file" 2>&1
  [[ "$(cat "$signature_stamp_repo/.tmp/agent-quality-gate/trunk-count")" == "15" ]] ||
    fail "fresh gate stamp was reused after the pinned alias registry changed"
)
rm -rf "$signature_stamp_repo" "$signature_runtime_root"
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
} # end family: stamps-freshness

# family: failure-output
# How a run reports trouble: quiet failure output, stack traces, the React
# Doctor wrapper, renames, and the manifest-change refusal.
run_failure_output_family() {
arm_suite_abort_trap
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
  mkdir -p bin ui-dashboard/scripts
  cp "$repo_root/ui-dashboard/scripts/check-react-doctor-diff.sh" ui-dashboard/scripts/check-react-doctor-diff.sh
  cat > bin/pnpm <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$PNPM_ARGS_FILE"
STUB
  chmod +x bin/pnpm
  git switch --detach HEAD >/dev/null 2>&1
  PNPM_ARGS_FILE="$output_file.pnpm-args" PATH="$PWD/bin:$PATH" bash ui-dashboard/scripts/check-react-doctor-diff.sh origin/test
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
  mkdir -p scripts/deploy
  printf '#!/usr/bin/env bash\n' > scripts/deploy/deploy-bridge.sh
  git add .
  git commit -qm init
  git mv scripts/deploy/deploy-bridge.sh docs.md
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
} # end family: failure-output

# family: routing-docs
# Routing for documentation, agent context, code-health, Sentry and PR
# tooling paths, including the scripts/ symlink reach cases.
run_routing_docs_family() {
arm_suite_abort_trap
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
assert_contains "- node --test scripts/mcp/upstash-mcp-config.test.mjs (Upstash MCP transport contract changed)"

run_gate ".codex/upstash-mcp.example.toml"
assert_contains "- node --test scripts/mcp/upstash-mcp-config.test.mjs (Upstash MCP transport contract changed)"

run_gate ".gitattributes"
assert_contains "- node --test scripts/mcp/upstash-mcp-config.test.mjs (Upstash MCP transport contract changed)"

run_gate ".agents/skills/forensic-report/references/upload.md"
assert_contains "- node --test scripts/mcp/upstash-mcp-config.test.mjs (Upstash MCP transport contract changed)"

run_gate "docs/notes/upstash-mcp-operator.md"
assert_contains "- node --test scripts/mcp/upstash-mcp-config.test.mjs (Upstash MCP transport contract changed)"

run_gate "terraform/variables.tf"
assert_contains "- node --test scripts/mcp/upstash-mcp-config.test.mjs (Upstash MCP transport contract changed)"

run_gate "pnpm-lock.yaml"
assert_contains "- node --test scripts/mcp/upstash-mcp-config.test.mjs (Upstash MCP transport contract changed)"

# Any docs markdown may carry canonical: true frontmatter (discovery in
# scripts/context/check-agent-context.mjs), so a discovered doc path must
# context check locally, not just in CI.
run_gate "docs/terraform.md"
assert_contains "- docs"
assert_contains "- pnpm agent:context-check (docs markdown may be canonical (frontmatter discovery))"

run_gate ".codex/hooks.json"
assert_contains "- agent-context"
assert_contains "- pnpm agent:context-check (agent context files changed)"

if AGENT_CONTEXT_CODEX_HOOKS_FILE="$codex_hooks_fixture" \
  node scripts/context/check-agent-context.mjs > "$output_file" 2>&1; then
  unscoped_override_status=0
else
  unscoped_override_status=$?
fi
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
  "bash -lc 'echo git rev-parse --show-toplevel && echo scripts/bootstrap/agent-session-end-hook.sh'";
fs.writeFileSync(file, `${JSON.stringify(hooks, null, 2)}\n`);
NODE
run_context_check_expect_failure
assert_contains ".codex/hooks.json: expected SessionEnd command to execute scripts/bootstrap/agent-session-end-hook.sh via resolved repo root"
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
  "echo ${CLAUDE_PROJECT_DIR}/scripts/bootstrap/agent-session-end-hook.sh";
fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
NODE
run_context_check_expect_failure
assert_contains '.claude/settings.json: expected SessionEnd command to execute quoted ${CLAUDE_PROJECT_DIR}/scripts/bootstrap/agent-session-end-hook.sh with bash'
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

append_claude_allow "Bash(bash ./scripts/deploy/deploy-dashboard.sh:*)"
run_context_check_expect_failure
assert_contains ".claude/settings.json: must not allow deploy/promote scripts: Bash(bash ./scripts/deploy/deploy-dashboard.sh:*)"
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

run_gate "scripts/supply-chain/lockfile-lint.mjs"
assert_contains "- pnpm lockfile:lint:test (lockfile lint helper changed)"

run_gate "scripts/supply-chain/lockfile-lint.test.mjs"
assert_contains "- pnpm lockfile:lint:test (lockfile lint helper changed)"

# The two gate modules lockfile-lint.mjs delegates to.
run_gate "scripts/supply-chain/lockfile-lint-registry-sources.mjs"
assert_contains "- pnpm lockfile:lint:test (lockfile lint helper changed)"

run_gate "scripts/supply-chain/lockfile-lint-override-ranges.mjs"
assert_contains "- pnpm lockfile:lint:test (lockfile lint helper changed)"

# The shared override selector parser routes BOTH readers: the CI-failing
# lockfile-lint gate and the never-failing override prune advisor.
run_gate "scripts/lib/pnpm-override-selector.mjs"
assert_contains "- node --test scripts/lib/pnpm-override-selector.test.mjs (shared pnpm override selector parser changed)"
assert_contains "- pnpm lockfile:lint:test (shared pnpm override selector parser changed)"
assert_contains "- pnpm override:prune-report:test (shared pnpm override selector parser changed)"

run_gate "scripts/lib/pnpm-override-selector.test.mjs"
assert_contains "- node --test scripts/lib/pnpm-override-selector.test.mjs (shared pnpm override selector parser changed)"
assert_contains "- pnpm lockfile:lint:test (shared pnpm override selector parser changed)"
assert_contains "- pnpm override:prune-report:test (shared pnpm override selector parser changed)"

run_gate "scripts/supply-chain/override-prune-report.mjs"
assert_contains "- pnpm override:prune-report:test (override prune report helper changed)"

run_gate "scripts/supply-chain/pnpm-audit-high-gate.mjs"
assert_contains "- node scripts/supply-chain/pnpm-audit-high-gate.test.mjs (pnpm audit high gate changed)"

run_gate "scripts/sentry/triage/sentry-triage-digest.mjs"
assert_contains "- pnpm sentry:digest:test (Sentry triage digest helper changed)"
assert_contains "- pnpm sentry:project:test (Sentry triage digest helper changed)"

run_gate "scripts/sentry/triage/sentry-triage-digest.test.mjs"
assert_contains "- pnpm sentry:digest:test (Sentry triage digest helper changed)"

# The pure Slack-render / section-taxonomy layer split out of digest.mjs (#1812)
# must route the digest suite too — a render-only change still needs the snapshot
# and Slack-safety tests.
run_gate "scripts/sentry/triage/sentry-triage-digest-render.mjs"
assert_contains "- pnpm sentry:digest:test (Sentry triage digest helper changed)"

# The MCP pre-flight probe (#1938) has no suite of its own — its tests live in
# the broker's, so it must route there. Pinned one path at a time: a sibling in
# the same change set would pull the suite in anyway and hide the miss.
run_gate "scripts/sentry/broker/sentry-mcp-probe.mjs"
assert_contains "- pnpm sentry:broker:test (Sentry MCP broker or pre-flight probe changed)"

run_gate "scripts/sentry/broker/sentry-mcp-broker.mjs"
assert_contains "- pnpm sentry:broker:test (Sentry MCP broker or pre-flight probe changed)"

run_gate "scripts/sentry/triage/sentry-triage-queue-contract.mjs"
assert_contains "- pnpm sentry:requeue:test (Sentry re-queue chokepoint changed)"
assert_contains "- pnpm sentry:project:test (Sentry re-queue chokepoint changed)"

# The settlement-sentinel unwind, split out of the chokepoint for the 1,000-line
# hard cap (#1929, ADR 0070). It has no suite of its own — its cases live in the
# re-queue suite — and it decides the end state of the archive compensation, so
# an unrouted change to it would ship without the archive suite ever running.
# Pinned one path at a time: a sibling in the same change set would pull the
# suites in anyway and hide the miss.
run_gate "scripts/sentry/triage/sentry-triage-requeue-sentinel.mjs"
assert_contains "- pnpm sentry:requeue:test (Sentry re-queue chokepoint changed)"
assert_contains "- pnpm sentry:archive:test (Sentry re-queue chokepoint changed)"
assert_contains "- pnpm sentry:ingest:test (Sentry re-queue chokepoint changed)"

run_gate "scripts/sentry/triage/sentry-triage-project.mjs"
assert_contains "- pnpm sentry:project:test (Sentry triage projection helper changed)"

# The route module owns external-PAT versus local-config I/O. A route-only
# edit must still run the projection contract suite.
run_gate "scripts/sentry/triage/sentry-triage-project-route.mjs"
assert_contains "- pnpm sentry:project:test (Sentry triage projection helper changed)"

# The argv surface and the settlement label self-heal, split out of the entry
# module for the 1,000-line hard cap (#1827). Both are reached only through that
# leg, so an unrouted change to either would ship untested.
run_gate "scripts/sentry/triage/sentry-triage-project-cli.mjs"
assert_contains "- pnpm sentry:project:test (Sentry triage projection helper changed)"

run_gate "scripts/sentry/triage/sentry-triage-label-ensure.mjs"
assert_contains "- pnpm sentry:project:test (Sentry triage projection helper changed)"
assert_contains "- pnpm sentry:brief:test (Sentry triage projection helper changed)"

run_gate "scripts/sentry/triage/sentry-triage-project-core.mjs"
assert_contains "- pnpm sentry:project:test (Sentry triage projection helper changed)"
assert_contains "- node scripts/sentry/triage/sentry-triage-agent-comment.test.mjs (Sentry triage projection helper changed)"
# Both brief emitters and the archive leg consume this module's exports (the
# verdict parser + shared selection, and the marker/trusted-author contract), so
# a change here must run their focused suites too (#1769 round 15).
assert_contains "- pnpm sentry:brief:test (Sentry triage projection helper changed)"
assert_contains "- pnpm sentry:archive:test (Sentry triage projection helper changed)"

run_gate "scripts/sentry/triage/sentry-triage-project.test.mjs"
assert_contains "- pnpm sentry:project:test (Sentry triage projection helper changed)"

# The needs-human brief (#1748) reads the verdict contract, the prompt that
# produces it, the note that documents it, and the workflow step that runs it —
# every one of those must route its suite, or the drift lands unnoticed.
run_gate "scripts/sentry/triage/sentry-triage-brief.mjs"
assert_contains "- pnpm sentry:brief:test (Sentry needs-human brief helper changed)"
assert_contains "- pnpm sentry:digest:test (Sentry needs-human brief helper changed)"
# The brief leg is a shared dependency of BOTH legs that call clearBriefComments,
# so a brief change must run each one's focused suite (#1769 round 15): the
# archive leg (settleQueueStub) and the projection leg (runProjectionBatch),
# whose close guard clears a stale brief before it closes the stub.
assert_contains "- pnpm sentry:archive:test (Sentry needs-human brief helper changed)"
assert_contains "- pnpm sentry:project:test (Sentry needs-human brief helper changed)"

run_gate "scripts/sentry/triage/sentry-triage-brief.test.mjs"
assert_contains "- pnpm sentry:brief:test (Sentry needs-human brief helper changed)"

run_gate ".github/prompts/sentry-triage.md"
assert_contains "- pnpm sentry:brief:test (Sentry triage prompt changed)"
# The broker suite pins the prompt's "losing the toolset posts nothing" rule
# (#1938); without this route a prompt-only edit could drop it with nothing red.
assert_contains "- pnpm sentry:broker:test (Sentry triage prompt changed)"

run_gate "docs/notes/sentry-triage-pipeline.md"
assert_contains "- pnpm sentry:brief:test (Sentry verdict contract note changed)"

run_gate ".github/workflows/sentry-triage-agent.yml"
assert_contains "- pnpm sentry:brief:test (Sentry triage agent workflow changed)"

run_gate "scripts/sentry/triage/sentry-triage-agent-comment.mjs"
assert_contains "- node scripts/sentry/triage/sentry-triage-agent-comment.test.mjs (Sentry triage agent comment wrapper changed)"

run_gate "scripts/sentry/triage/sentry-triage-agent-comment.test.mjs"
assert_contains "- node scripts/sentry/triage/sentry-triage-agent-comment.test.mjs (Sentry triage agent comment wrapper changed)"

run_gate "scripts/sentry/triage/sentry-triage-archive.mjs"
assert_contains "- pnpm sentry:archive:test (Sentry triage archive helper changed)"

run_gate "scripts/sentry/triage/sentry-triage-archive.test.mjs"
assert_contains "- pnpm sentry:archive:test (Sentry triage archive helper changed)"

# The #1943/#1970 fixture drift canary (ADR 0068). Three routes, all pinned:
# its own file, the scanner whose credential-key vocabulary decides whether the
# renamed fixtures still scan clean, and each of the four suites that carry
# those fixtures. The canary's own arm sits ABOVE the per-suite arms in the
# gate: a single combined pattern there would match those four paths first and
# silently drop each suite's focused test, which is the routing bug #1974
# shipped. The per-suite assertions below are what would red if someone
# collapsed these arms that way.
fixture_canary="- node scripts/sentry/fixture-scan-canary.test.mjs"

run_gate "scripts/sentry/fixture-scan-canary.test.mjs"
assert_contains "$fixture_canary (Sentry fixture drift canary changed)"

run_gate "scripts/agent-autoreview-core.mjs"
assert_contains "- pnpm agent:autoreview:test (agent autoreview helper changed)"
assert_contains "- docs/pr-checklists/indexer-handler-invariants.md (indexer invariant routing source changed)"
assert_contains "$fixture_canary (autoreview secret scanner changed)"
assert_contains "- pnpm gate:routing-table:test (indexer invariant routing source changed)"
assert_contains "- pnpm agent:quality-gate:test (indexer invariant routing source changed)"

# The protected-main classifier sees both targets below as route:false. A
# candidate core can add the new owner or reclassify the existing owner, so the
# changed core path must carry the checklist independently of those decisions.
run_gate \
  "scripts/agent-autoreview-core.mjs" \
  "indexer-envio/src/futureProtectedSkew.ts"
assert_contains "- docs/pr-checklists/indexer-handler-invariants.md (indexer invariant routing source changed)"

run_gate \
  "scripts/agent-autoreview-core.mjs" \
  "indexer-envio/src/rpc/log.ts"
assert_contains "- docs/pr-checklists/indexer-handler-invariants.md (indexer invariant routing source changed)"

run_gate "scripts/sentry/autofix/sentry-autofix-finalize.test.mjs"
assert_contains "- pnpm sentry:autofix:finalize:test (Sentry autofix finalize helper changed)"
assert_contains "$fixture_canary (Sentry suite carrying scanned fixtures changed)"

run_gate "scripts/sentry/broker/sentry-mcp-broker.test.mjs"
assert_contains "- pnpm sentry:broker:test (Sentry MCP broker or pre-flight probe changed)"
assert_contains "$fixture_canary (Sentry suite carrying scanned fixtures changed)"

run_gate "scripts/sentry/triage/sentry-triage-agent-comment.test.mjs"
assert_contains "- node scripts/sentry/triage/sentry-triage-agent-comment.test.mjs (Sentry triage agent comment wrapper changed)"
assert_contains "$fixture_canary (Sentry suite carrying scanned fixtures changed)"

run_gate "scripts/sentry/triage/sentry-triage-archive.test.mjs"
assert_contains "- pnpm sentry:archive:test (Sentry triage archive helper changed)"
assert_contains "$fixture_canary (Sentry suite carrying scanned fixtures changed)"

# The handled-family lookup, split out of sentry-autofix-queue-io.mjs for the
# 600-line soft cap. Pinned ALONE — a module added to this leg without a routing
# case matches nothing and its edits run zero tests, and a pin that lists several
# paths at once lets a sibling's route mask the miss. It carries
# MAX_HANDLED_ID_QUERIES, a term in the finalize suite's select-job timeout pin,
# so both suites must be routed.
run_gate "scripts/sentry/autofix/sentry-autofix-family-handled.mjs"
assert_contains "- pnpm sentry:autofix:select:test (Sentry autofix handled-family lookup changed)"
assert_contains "- pnpm sentry:autofix:finalize:test (Sentry autofix per-run cost cap changed)"

# The record-run Search API inventory is not part of selector routing or its
# gh-call budget. It shares the run-record suite and finalize wiring, so a
# helper-only edit must still run both focused suites.
run_gate "scripts/sentry/autofix/sentry-autofix-refused-inventory.mjs"
assert_contains "- pnpm sentry:autofix:run-record:test (Sentry autofix run-record builder changed)"
assert_contains "- pnpm sentry:autofix:finalize:test (Sentry autofix run-record builder changed)"

# The self-run Sentry-suite gate (#1779, ADR 0062) asserts, at runtime, that the
# suites actually ran. A contributor who edits the gate script, its own suite, or
# the manifest it reconciles against must run scripts/sentry/gate/sentry-suite-gate.test.mjs
# locally — or the gate could ship broken. The manifest .json is included on
# purpose: the gate reconciles set membership and per-suite floors against it, so
# a floor edit is exactly the kind of change that must run the gate test.
# Both gate commands must be routed, for the gate's own files AND for every
# manifest-owned suite. Neither command substitutes for the other: the self-test
# only exercises the gate's logic against throwaway fixture manifests in a temp
# dir and never reads the committed scripts/sentry/gate/sentry-suite-manifest.json, while
# only the real gate reconciles that file against the real suites. Proven with
# the requeue floor bumped 31 -> 999: `sentry-suite-gate.test.mjs` still exits 0
# while `sentry-suite-gate.mjs` exits 1 and names the suite.
#
# Both carry the `/usr/bin/env -u NODE_OPTIONS -u NODE_PATH` prefix so they match
# the CI entry point and still run for a developer with an ambient NODE_OPTIONS —
# without it the gate refuses to start and 10 of the self-test's 20 cases fail.
sentry_gate_env="/usr/bin/env -u NODE_OPTIONS -u NODE_PATH"
sentry_gate_reason="Sentry-suite gate, manifest, or a manifest-owned suite changed"
sentry_gate_test="- $sentry_gate_env node scripts/sentry/gate/sentry-suite-gate.test.mjs ($sentry_gate_reason)"
sentry_gate_run="- $sentry_gate_env node scripts/sentry/gate/sentry-suite-gate.mjs ($sentry_gate_reason (validate the committed manifest against the real suites))"

run_gate "scripts/sentry/gate/sentry-suite-gate.mjs"
assert_contains "$sentry_gate_test"
assert_contains "$sentry_gate_run"

run_gate "scripts/sentry/gate/sentry-suite-gate.test.mjs"
assert_contains "$sentry_gate_test"
assert_contains "$sentry_gate_run"

run_gate "scripts/sentry/gate/sentry-suite-manifest.json"
assert_contains "$sentry_gate_test"
assert_contains "$sentry_gate_run"

# A manifest-owned suite that is NOT one of the gate's own files: editing it
# moves its pass count against its committed floor, so it must route the gate
# too. Deleting one test here leaves `pnpm sentry:requeue:test` green at
# "30 passed" while the gate reds on `pass 30 < floor 31`.
run_gate "scripts/sentry/triage/sentry-triage-requeue.test.mjs"
assert_contains "- pnpm sentry:requeue:test (Sentry re-queue chokepoint changed)"
assert_contains "$sentry_gate_test"
assert_contains "$sentry_gate_run"

# A second, unrelated manifest-owned suite, to prove the routing is the generic
# glob and not a per-suite arm.
run_gate "scripts/sentry/triage/sentry-triage-archive.test.mjs"
assert_contains "$sentry_gate_run"

# EVERY file the round-8 split created must route the gate, not just the ones
# that happen to match `sentry-*.test.mjs`. The fixtures module owns fixture
# environment isolation, the step-summary redirection and the shared harness, and
# it scheduled neither gate suite until the arm was widened to
# `sentry-suite-gate*.mjs` — the second routing gap a split has introduced.
run_gate "scripts/sentry/gate/sentry-suite-gate-fixtures.mjs"
assert_contains "$sentry_gate_test"
assert_contains "$sentry_gate_run"

run_gate "scripts/sentry/gate/sentry-suite-gate-integrity.test.mjs"
assert_contains "$sentry_gate_test"
assert_contains "$sentry_gate_run"

# The shared V8 import parser sits under neither the `sentry-*` nor the
# `check-sentry-suites-in-ci*` prefix, yet it decides the gate's watch set and
# exemption proof AND the coverage check's import proof. Extracted, it scheduled
# only Trunk, lint:scripts and tf:test — the third routing gap a file-creating
# change has opened here (Codex 3761572721). It must route BOTH consumers.
run_gate "scripts/lib/static-imports.mjs"
assert_contains "$sentry_gate_test"
assert_contains "$sentry_gate_run"

# check-sentry-suites-in-ci.test.mjs asserts that every Sentry suite runs in
# CI. Every file it reads must route it, or the drift it exists to catch is
# only caught after push. Its first home was an arm nested under `scripts/*.sh`,
# where a `.mjs` path could never reach it — hence a case per reader here.
sentry_ci_check="- node scripts/sentry/ci-wiring/check-sentry-suites-in-ci.test.mjs (Sentry CI-coverage check reads this file)"

run_gate "scripts/sentry/ci-wiring/check-sentry-suites-in-ci.test.mjs"
assert_contains "$sentry_ci_check"

run_gate "scripts/sentry/ci-wiring/check-sentry-suites-in-ci-core.mjs"
assert_contains "$sentry_ci_check"

# The core-grammar and probes siblings are read the same way; the glob covers
# every `check-sentry-suites-in-ci*.mjs`, not just the two named modules.
run_gate "scripts/sentry/ci-wiring/check-sentry-suites-in-ci-core-commands.mjs"
assert_contains "$sentry_ci_check"

run_gate "scripts/sentry/ci-wiring/check-sentry-suites-in-ci-probes.mjs"
assert_contains "$sentry_ci_check"

# `staticImports` is the check's import proof, imported from outside the prefix.
run_gate "scripts/lib/static-imports.mjs"
assert_contains "$sentry_ci_check"

# The gate's exemption proof parses the `tf:test` alias with the checker's shell
# grammar, so this module decides a gate verdict despite its checker name — the
# fourth gap of this shape, found by sweeping the dry-run over every path the
# round touched rather than by reading the globs.
run_gate "scripts/sentry/ci-wiring/check-sentry-suites-in-ci-core-commands.mjs"
assert_contains "$sentry_gate_test"
assert_contains "$sentry_gate_run"

# The check parses EVERY workflow (contextOwnershipBlockers proves no decoy job
# owns the `ci` check-run name), so a non-ci workflow edit must route it too.
run_gate ".github/workflows/sentry-triage-agent.yml"
assert_contains "$sentry_ci_check"

# The env scan recurses into the composite actions the trusted jobs pull in, so
# editing a local action.yml must route it — the reader the one-level scan and
# the ci.yml-only arm both missed.
run_gate ".github/actions/pnpm-install/action.yml"
assert_contains "$sentry_ci_check"

run_gate "package.json"
assert_contains "$sentry_ci_check"

run_gate "scripts/agent-quality-gate.sh"
assert_contains "$sentry_ci_check"

run_gate "scripts/check-agent-quality-gate-package-scripts.mjs"
assert_contains "$sentry_ci_check"

run_gate "scripts/tf-stacks.test.mjs"
assert_contains "$sentry_ci_check"

# A suite that lands without a dedicated arm of its own still routes.
run_gate "scripts/sentry-not-yet-written.test.mjs"
assert_contains "$sentry_ci_check"

# A directory symlink under scripts/ routes both Sentry checks even though its
# path is extensionless and matches none of the suite globs: findSentrySuites and
# the gate's own enumerator each follow the link, so both must run to reach any
# suite behind it (Codex 3754355168). Needs a real symlink in the tree because
# the gate reads `-L`.
#
# The GATE assertions are what this arm now turns on. #1779 PR C retired the
# checker's demand for a direct CI step per suite — the unconditional CI gate
# runs the suites instead — so the checker alone exits 0 on a suite exposed here
# and only the manifest reconciliation reds. Measured on this branch before the
# fix: with a link whose target held an unwired suite, `node
# scripts/sentry/ci-wiring/check-sentry-suites-in-ci.test.mjs` exited 0 while `node
# scripts/sentry/gate/sentry-suite-gate.mjs` exited 1 naming the missing manifest entry, and
# this arm scheduled only the former (Codex 3766397748).
symlink_target="$(mktemp -d)"
ln -sfn "$symlink_target" "$sentry_symlink_probe"
run_gate "$sentry_symlink_probe"
sentry_symlink_reason="symlink under scripts/ can expose an unwired Sentry suite"
assert_contains "- node scripts/sentry/ci-wiring/check-sentry-suites-in-ci.test.mjs ($sentry_symlink_reason)"
assert_contains "- $sentry_gate_env node scripts/sentry/gate/sentry-suite-gate.test.mjs ($sentry_symlink_reason)"
assert_contains "- $sentry_gate_env node scripts/sentry/gate/sentry-suite-gate.mjs ($sentry_symlink_reason (validate the committed manifest against the real suites))"
rm -f "$sentry_symlink_probe"
rm -rf "$symlink_target"

# The mirror case: a change BENEATH an existing scripts/ directory symlink's real
# TARGET routes both checks too. Both enumerators follow the committed link and
# reach a suite added under the target, yet that path matches neither scripts/*
# nor the rootScripts filter — so this gate would skip it entirely without this
# routing (Codex 3754704280, 3766397748). Needs a real link to a repo-relative
# directory because the gate resolves the target with `pwd -P`. The changed path
# under the target need not exist; only the link and its target must.
mkdir -p "$sentry_symlink_target_dir"
ln -sfn "../$sentry_symlink_target_dir" "$sentry_symlink_to_target"
run_gate "$sentry_symlink_target_dir/sentry-new.test.mjs"
sentry_symlink_target_reason="change beneath a scripts/ symlink target can expose an unwired Sentry suite"
assert_contains "- node scripts/sentry/ci-wiring/check-sentry-suites-in-ci.test.mjs ($sentry_symlink_target_reason)"
assert_contains "- $sentry_gate_env node scripts/sentry/gate/sentry-suite-gate.test.mjs ($sentry_symlink_target_reason)"
assert_contains "- $sentry_gate_env node scripts/sentry/gate/sentry-suite-gate.mjs ($sentry_symlink_target_reason (validate the committed manifest against the real suites))"
rm -f "$sentry_symlink_to_target"
rm -rf "$sentry_symlink_target_dir"

# findSentrySuites enumerates recursively, so a nested suite is one the check
# will demand a CI step for. Routing has to reach the same depth or the drift
# is only caught after push.
run_gate "scripts/nested/sentry-new.test.mjs"
assert_contains "$sentry_ci_check"

run_gate "scripts/a/b/sentry-deep.test.mjs"
assert_contains "$sentry_ci_check"

# An existing suite keeps its specific helper command and gains this one.
run_gate "scripts/sentry/triage/sentry-triage-requeue.test.mjs"
assert_contains "- pnpm sentry:requeue:test (Sentry re-queue chokepoint changed)"
assert_contains "$sentry_ci_check"

# ci.yml routes it too, under its own more specific reason.
run_gate ".github/workflows/ci.yml"
assert_contains "- node scripts/sentry/ci-wiring/check-sentry-suites-in-ci.test.mjs (central CI workflow changed)"

# scripts/pr/ is the canonical location: the aliases and the suites live there.
# Neither arm is a glob, so every path routes only because it is named outright;
# a miss here is silent, the suite simply stops running for the changed file.
run_gate "scripts/pr/pr-feedback-state.mjs"
assert_contains "- pnpm pr:feedback-state:test (PR feedback-state helper changed)"

run_gate "scripts/pr/pr-feedback-state-core.mjs"
assert_contains "- pnpm pr:feedback-state:test (PR feedback-state helper changed)"

run_gate "scripts/pr/pr-feedback-state-claude.mjs"
assert_contains "- pnpm pr:feedback-state:test (PR feedback-state helper changed)"

run_gate "scripts/pr/pr-feedback-state.test.mjs"
assert_contains "- pnpm pr:feedback-state:test (PR feedback-state helper changed)"

run_gate "scripts/pr/pr-ready-state.mjs"
assert_contains "- pnpm pr:ready-state:test (PR ready-state helper changed)"

run_gate "scripts/pr/pr-ready-state-core.mjs"
assert_contains "- pnpm pr:ready-state:test (PR ready-state helper changed)"

run_gate "scripts/pr/pr-ready-state-format.mjs"
assert_contains "- pnpm pr:ready-state:test (PR ready-state helper changed)"

run_gate "scripts/pr/pr-ready-state.test.mjs"
assert_contains "- pnpm pr:ready-state:test (PR ready-state helper changed)"

run_gate "scripts/sanitize-terraform-output.sh"
assert_contains "- pnpm sanitize:test (Terraform output sanitizer changed)"

run_gate "scripts/sanitize-terraform-output.test.mjs"
assert_contains "- pnpm sanitize:test (Terraform output sanitizer test changed)"

run_gate "scripts/pr/review-materiality.mjs"
assert_contains "- pnpm agent:review-materiality:test (agent review materiality helper changed)"

run_gate "scripts/pr/review-materiality-context.mjs"
assert_contains "- pnpm agent:review-materiality:test (agent review materiality helper changed)"

run_gate "scripts/pr/review-materiality.test.mjs"
assert_contains "- pnpm agent:review-materiality:test (agent review materiality helper changed)"

run_gate "scripts/pr/review-process-metrics.mjs"
assert_contains "- node scripts/pr/review-process-metrics.test.mjs (review-process metrics collector changed)"

run_gate "scripts/pr/review-process-metrics.test.mjs"
assert_contains "- node scripts/pr/review-process-metrics.test.mjs (review-process metrics collector changed)"

# The CodeRabbit config pin (ADR 0066). The config is a repo-root .yaml, so it
# reaches no `scripts/*` arm and needs its own top-level route; both halves of
# the pair must run the pin.
run_gate ".coderabbit.yaml"
assert_contains "- pnpm coderabbit:config:test (CodeRabbit review config changed)"

run_gate "scripts/coderabbit-config.test.mjs"
assert_contains "- pnpm coderabbit:config:test (CodeRabbit config pin changed)"

run_gate "scripts/pr/agent-issue-board.mjs"
assert_contains "- pnpm issue:board:test (agent issue board helper changed)"

run_gate "scripts/pr/agent-issue-board.test.mjs"
assert_contains "- pnpm issue:board:test (agent issue board helper changed)"

run_gate "scripts/pr/issue-board-backfill.mjs"
assert_contains "- pnpm issue:board:test (agent issue board helper changed)"

run_gate "scripts/pr/issue-board-cli.mjs"
assert_contains "- pnpm issue:board:test (agent issue board helper changed)"

run_gate "scripts/pr/issue-board-transport.mjs"
assert_contains "- pnpm issue:board:test (agent issue board helper changed)"

run_gate "scripts/pr/issue-board-state.mjs"
assert_contains "- pnpm issue:board:test (agent issue board helper changed)"

run_gate "scripts/pr/issue-board-projects.mjs"
assert_contains "- pnpm issue:board:test (agent issue board helper changed)"

run_gate "scripts/pr/issue-board-commands.mjs"
assert_contains "- pnpm issue:board:test (agent issue board helper changed)"

run_gate "scripts/supply-chain/version-skew-check.mjs"
assert_contains "- pnpm skew:check:test (version skew checker changed)"

run_gate "scripts/supply-chain/version-skew-check.test.mjs"
assert_contains "- pnpm skew:check:test (version skew checker changed)"

run_gate "scripts/repo-health/check-hermetic-vitest-setup.mjs"
assert_contains "- pnpm lint:scripts (root build script changed)"
assert_contains "- node scripts/repo-health/check-hermetic-vitest-setup.mjs (hermetic Vitest setup checker changed)"
assert_contains "- node scripts/repo-health/check-hermetic-vitest-setup.test.mjs (hermetic Vitest setup checker changed)"

run_gate "scripts/repo-health/check-hermetic-vitest-setup.test.mjs"
assert_contains "- pnpm lint:scripts (root build script changed)"
assert_contains "- node scripts/repo-health/check-hermetic-vitest-setup.mjs (hermetic Vitest setup checker changed)"
assert_contains "- node scripts/repo-health/check-hermetic-vitest-setup.test.mjs (hermetic Vitest setup checker changed)"

run_gate "scripts/workflows/check-github-action-pins.mjs"
assert_contains "- node scripts/workflows/check-github-action-pins.mjs (GitHub Actions pin checker changed)"
assert_contains "- node scripts/workflows/check-github-action-pins.test.mjs (GitHub Actions pin checker changed)"

run_gate "scripts/workflows/check-autofix-ci-trust.mjs"
assert_contains "- node scripts/workflows/check-autofix-ci-trust.mjs (autofix CI trust checker changed)"
assert_contains "- node scripts/workflows/check-autofix-ci-trust.test.mjs (autofix CI trust checker changed)"

run_gate "scripts/workflows/check-autofix-ci-trust.test.mjs"
assert_contains "- node scripts/workflows/check-autofix-ci-trust.mjs (autofix CI trust checker changed)"
assert_contains "- node scripts/workflows/check-autofix-ci-trust.test.mjs (autofix CI trust checker changed)"

# The annotation-scoping module the checker imports. It carries no `check-`
# prefix, so nothing but this arm routes it to the checker it is half of.
run_gate "scripts/workflows/autofix-trust-annotations.mjs"
assert_contains "- pnpm lint:scripts (root build script changed)"
assert_contains "- node scripts/workflows/check-autofix-ci-trust.mjs (autofix CI trust checker changed)"
assert_contains "- node scripts/workflows/check-autofix-ci-trust.test.mjs (autofix CI trust checker changed)"

run_gate "scripts/workflows/check-workflow-permissions-drift.mjs"
assert_contains "- node scripts/workflows/check-workflow-permissions-drift.test.mjs (platform-settings workflow-permissions drift checker changed)"

run_gate "scripts/workflows/check-workflow-permissions-drift.test.mjs"
assert_contains "- node scripts/workflows/check-workflow-permissions-drift.test.mjs (platform-settings workflow-permissions drift checker changed)"

run_gate "scripts/workflows/check-github-action-pins.test.mjs"
assert_contains "- node scripts/workflows/check-github-action-pins.test.mjs (GitHub Actions pin checker test changed)"

run_gate "scripts/alerts/alert-rules-lint.mjs"
assert_contains "- pnpm alerts:rules:lint:test (alert-rules lint helper changed)"

run_gate "scripts/alerts/alert-rules-lint.test.mjs"
assert_contains "- pnpm alerts:rules:lint:test (alert-rules lint helper changed)"

run_gate "scripts/alerts/alert-rules-lint-extract.mjs"
assert_contains "- pnpm alerts:rules:lint:test (alert-rules lint helper changed)"

run_gate "scripts/alerts/alert-rules-lint-peg-policy.mjs"
assert_contains "- pnpm alerts:rules:lint:test (alert-rules lint helper changed)"

run_gate "scripts/alerts/check-peg-registry-integrity.mjs"
assert_contains "- node scripts/alerts/check-peg-registry-integrity.mjs (peg registry integrity checker changed)"
assert_contains "- node scripts/alerts/check-peg-registry-integrity.test.mjs (peg registry integrity checker changed)"

run_gate "scripts/alerts/check-peg-registry-integrity-lineage.mjs"
assert_contains "- node scripts/alerts/check-peg-registry-integrity.mjs (peg registry integrity checker changed)"
assert_contains "- node scripts/alerts/check-peg-registry-integrity.test.mjs (peg registry integrity checker changed)"

run_gate "scripts/alerts/check-peg-registry-integrity.test.mjs"
assert_contains "- node scripts/alerts/check-peg-registry-integrity.mjs (peg registry integrity checker changed)"
assert_contains "- node scripts/alerts/check-peg-registry-integrity.test.mjs (peg registry integrity checker changed)"

run_gate "scripts/alerts/check-peg-policy-publication.mjs"
assert_contains "- pnpm tf:test (peg policy publication boundary changed)"

run_gate "scripts/alerts/check-peg-policy-publication.test.mjs"
assert_contains "- pnpm tf:test (peg policy publication boundary changed)"

# The shared digest both peg validators compare against: one file, both suites.
run_gate "scripts/lib/peg-policy-digest.mjs"
assert_contains "- pnpm alerts:rules:lint:test (peg policy version digest changed)"
assert_contains "- node scripts/alerts/check-peg-registry-integrity.mjs (peg policy version digest changed)"
assert_contains "- node scripts/alerts/check-peg-registry-integrity.test.mjs (peg policy version digest changed)"

run_gate "scripts/pr/check-pr-description.mjs"
assert_contains "- node scripts/pr/check-pr-description.test.mjs (PR description validator changed)"

run_gate "scripts/pr/check-pr-description.test.mjs"
assert_contains "- node scripts/pr/check-pr-description.test.mjs (PR description validator changed)"

run_gate "scripts/agent-autoreview.mjs"
assert_contains "- pnpm lint:scripts (root build script changed)"
assert_contains "- pnpm agent:autoreview:test (agent autoreview helper changed)"

run_gate "scripts/agent-autoreview-core.mjs"
assert_contains "- pnpm lint:scripts (root build script changed)"
assert_contains "- pnpm agent:autoreview:test (agent autoreview helper changed)"
assert_contains "- docs/pr-checklists/indexer-handler-invariants.md (indexer invariant routing source changed)"
assert_contains "- pnpm gate:routing-table:test (indexer invariant routing source changed)"
assert_contains "- pnpm agent:quality-gate:test (indexer invariant routing source changed)"

run_gate "scripts/agent-autoreview-core.test.mjs"
assert_contains "- pnpm lint:scripts (root build script changed)"
assert_contains "- pnpm agent:autoreview:test (agent autoreview helper changed)"
assert_not_contains "indexer invariant routing source changed"

run_gate "scripts/agent-autoreview-target-guard.test.mjs"
assert_contains "- pnpm lint:scripts (root build script changed)"
assert_contains "- pnpm agent:autoreview:test (agent autoreview helper changed)"

run_gate "scripts/context/check-agent-context.mjs"
assert_contains "- pnpm agent:context-check (agent context checker changed)"
assert_contains "- node scripts/context/check-agent-context.test.mjs (agent context checker changed)"

run_gate "scripts/context/check-agent-context-helpers.mjs"
assert_contains "- pnpm agent:context-check (agent context checker changed)"
assert_contains "- node scripts/context/check-agent-context.test.mjs (agent context checker changed)"

run_gate "scripts/context/check-agent-context.test.mjs"
assert_contains "- pnpm agent:context-check (agent context checker changed)"
assert_contains "- node scripts/context/check-agent-context.test.mjs (agent context checker changed)"

# The settings/hook contract module split out of the context checker (#1887).
# Its own suite plus the caller's wiring test plus the real enforcement pass.
run_gate "scripts/context/check-settings-contract.mjs"
assert_contains "- pnpm lint:scripts (root build script changed)"
assert_contains "- pnpm agent:context-check (agent settings contract changed)"
assert_contains "- node scripts/context/check-settings-contract.test.mjs (agent settings contract changed)"
assert_contains "- node scripts/context/check-agent-context.test.mjs (agent settings contract changed)"

run_gate "scripts/context/check-settings-contract.test.mjs"
assert_contains "- pnpm lint:scripts (root build script changed)"
assert_contains "- pnpm agent:context-check (agent settings contract changed)"
assert_contains "- node scripts/context/check-settings-contract.test.mjs (agent settings contract changed)"
assert_contains "- node scripts/context/check-agent-context.test.mjs (agent settings contract changed)"

run_gate "scripts/mcp/build-upstash-mcp-runtime.mjs"
assert_contains "- pnpm lint:scripts (root build script changed)"
assert_contains "- node --test scripts/mcp/upstash-mcp-config.test.mjs (Upstash MCP transport contract changed)"

run_gate "scripts/mcp/upstash-mcp-config.test.mjs"
assert_contains "- pnpm lint:scripts (root build script changed)"
assert_contains "- node --test scripts/mcp/upstash-mcp-config.test.mjs (Upstash MCP transport contract changed)"

run_gate "scripts/mcp/upstash-mcp-launcher.mjs"
assert_contains "- pnpm lint:scripts (root build script changed)"
assert_contains "- node --test scripts/mcp/upstash-mcp-config.test.mjs (Upstash MCP transport contract changed)"

run_gate "scripts/mcp/render-upstash-mcp-config.mjs"
assert_contains "- pnpm lint:scripts (root build script changed)"
assert_contains "- node --test scripts/mcp/upstash-mcp-config.test.mjs (Upstash MCP transport contract changed)"

run_gate "scripts/context/docs-index.mjs"
assert_contains "- pnpm docs:index:test (documentation catalog helper changed)"
assert_contains "- pnpm docs:index --check (documentation catalog helper changed)"
assert_contains "- pnpm agent:context-check (documentation catalog metadata contract changed)"

run_gate "scripts/context/docs-index-helpers.mjs"
assert_contains "- pnpm docs:index:test (documentation catalog helper changed)"

run_gate "scripts/context/claude-runtime-document-registry.mjs"
assert_contains "- pnpm docs:index:test (documentation catalog helper changed)"
assert_contains "- pnpm docs:index --check (documentation catalog helper changed)"
assert_contains "- pnpm agent:context-check (documentation catalog metadata contract changed)"

run_gate "docs/claude-runtime-document-registry.json"
assert_contains "- pnpm docs:index --check (Claude runtime document registry changed)"
assert_contains "- pnpm agent:context-check (Claude runtime document registry changed)"

run_gate "scripts/context/docs-index.test.mjs"
assert_contains "- pnpm docs:index:test (documentation catalog helper changed)"

run_gate "scripts/docs/docs-audit.mjs"
assert_contains "- pnpm docs:audit:test (documentation audit planner changed)"
assert_contains "- pnpm docs:audit --dry-run (documentation audit planner changed)"
assert_contains "- pnpm docs:index --check (documentation audit planner consumes the catalog)"

run_gate "scripts/docs/docs-audit-helpers.mjs"
assert_contains "- pnpm docs:audit:test (documentation audit planner changed)"

run_gate "scripts/docs/docs-audit.test.mjs"
assert_contains "- pnpm docs:audit:test (documentation audit planner changed)"

run_gate "scripts/docs/docs-garden-issue.mjs"
assert_contains "- pnpm docs:garden:test (documentation garden issue automation changed)"
assert_contains "- pnpm docs:audit --dry-run (documentation garden issue automation consumes the planner)"
assert_contains "- pnpm docs:index --check (documentation garden issue automation consumes the catalog)"

run_gate "scripts/docs/docs-garden-issue-helpers.mjs"
assert_contains "- pnpm docs:garden:test (documentation garden issue automation changed)"

run_gate "scripts/docs/docs-garden-issue.test.mjs"
assert_contains "- pnpm docs:garden:test (documentation garden issue automation changed)"

run_gate "scripts/docs/docs-navigation-eval.mjs"
assert_contains "- pnpm docs:navigation-eval:test (documentation navigation evaluation changed)"
assert_contains "- pnpm docs:navigation-eval -- --check-fixtures (documentation navigation evaluation changed)"
assert_occurrences 1 "- pnpm docs:navigation-eval -- --check-fixtures"
assert_contains "- pnpm docs:navigation-eval -- --validate docs/evals/documentation-navigation-baseline.json --fixtures docs/evals/documentation-navigation-baseline-fixtures.json (documentation navigation evaluation changed)"
assert_contains "- pnpm docs:index --check (documentation navigation evaluation consumes the catalog)"

run_gate "scripts/docs/docs-navigation-eval-helpers.mjs"
assert_contains "- pnpm docs:navigation-eval:test (documentation navigation evaluation changed)"
assert_contains "- pnpm docs:navigation-eval -- --check-fixtures (documentation navigation evaluation changed)"
assert_occurrences 1 "- pnpm docs:navigation-eval -- --check-fixtures"

run_gate "scripts/docs/docs-navigation-eval-result.mjs"
assert_contains "- pnpm docs:navigation-eval:test (documentation navigation evaluation changed)"
assert_contains "- pnpm docs:navigation-eval -- --check-fixtures (documentation navigation evaluation changed)"
assert_occurrences 1 "- pnpm docs:navigation-eval -- --check-fixtures"

run_gate "scripts/docs/docs-navigation-eval-result-shape.mjs"
assert_contains "- pnpm docs:navigation-eval:test (documentation navigation evaluation changed)"
assert_contains "- pnpm docs:navigation-eval -- --check-fixtures (documentation navigation evaluation changed)"
assert_occurrences 1 "- pnpm docs:navigation-eval -- --check-fixtures"

run_gate "scripts/docs/docs-navigation-eval.test.mjs"
assert_contains "- pnpm docs:navigation-eval:test (documentation navigation evaluation changed)"
assert_contains "- pnpm docs:navigation-eval -- --check-fixtures (documentation navigation evaluation changed)"
assert_occurrences 1 "- pnpm docs:navigation-eval -- --check-fixtures"

run_gate "scripts/lib/gh-issue-lifecycle.mjs"
assert_contains "- pnpm lint:scripts (root build script changed)"
assert_contains "- pnpm docs:garden:test (shared GitHub issue lifecycle module changed)"
assert_contains "- pnpm docs:navigation-eval:test (shared GitHub issue lifecycle module changed)"
assert_contains "- pnpm sentry:project:test (shared GitHub issue lifecycle module changed)"

run_gate "docs/evals/documentation-navigation-fixtures.json"
assert_contains "- pnpm docs:navigation-eval:test (documentation navigation evaluation contract changed)"
assert_contains "- pnpm docs:navigation-eval -- --check-fixtures (documentation navigation evaluation contract changed)"
assert_occurrences 1 "- pnpm docs:navigation-eval -- --check-fixtures"
assert_contains "- pnpm docs:navigation-eval -- --validate docs/evals/documentation-navigation-baseline.json --fixtures docs/evals/documentation-navigation-baseline-fixtures.json (documentation navigation evaluation contract changed)"

run_gate "docs/evals/documentation-navigation-2026-08-post-garden.json"
assert_contains "- pnpm docs:navigation-eval:test (documentation navigation evaluation contract changed)"
assert_contains "- pnpm docs:navigation-eval -- --check-fixtures (documentation navigation evaluation contract changed)"
assert_occurrences 1 "- pnpm docs:navigation-eval -- --check-fixtures"
assert_contains "- pnpm docs:navigation-eval -- --validate docs/evals/documentation-navigation-baseline.json --fixtures docs/evals/documentation-navigation-baseline-fixtures.json (documentation navigation evaluation contract changed)"

run_gate "docs/evals/documentation-navigation-baseline.json"
assert_contains "- pnpm docs:navigation-eval:test (documentation navigation baseline changed)"
assert_contains "- pnpm docs:navigation-eval -- --check-fixtures (documentation navigation baseline changed)"
assert_occurrences 1 "- pnpm docs:navigation-eval -- --check-fixtures"
assert_contains "- pnpm docs:navigation-eval -- --validate docs/evals/documentation-navigation-baseline.json --fixtures docs/evals/documentation-navigation-baseline-fixtures.json (documentation navigation baseline changed)"

run_gate "docs/notes/agent-quality-gate-mechanics.md"
assert_contains "- pnpm docs:navigation-eval -- --check-fixtures (routing-sensitive source changed)"
assert_occurrences 1 "- pnpm docs:navigation-eval -- --check-fixtures"

run_gate "ui-dashboard/src/app/page.tsx"
assert_not_contains_mapped "- pnpm docs:navigation-eval -- --check-fixtures"

run_gate "scripts/context/agent-context-budget.mjs"
assert_contains "- pnpm agent:context-budget:test (agent context budget helper changed)"
assert_contains "- pnpm agent:context-budget --strict (agent context budget helper changed)"

run_gate "scripts/context/agent-context-budget.test.mjs"
assert_contains "- pnpm agent:context-budget:test (agent context budget helper changed)"

run_gate "scripts/alerts/check-deviation-threshold-drift.mjs"
assert_contains "- node scripts/alerts/check-deviation-threshold-drift.mjs (deviation threshold drift checker changed)"
assert_contains "- node scripts/alerts/check-deviation-threshold-drift.test.mjs (deviation threshold drift checker changed)"

run_gate "scripts/alerts/check-deviation-threshold-drift.test.mjs"
assert_contains "- node scripts/alerts/check-deviation-threshold-drift.test.mjs (deviation threshold drift checker test changed)"

run_gate "scripts/verify-github-environment-protection.mjs"
assert_contains "- node scripts/verify-github-environment-protection.test.mjs (GitHub environment protection checker changed)"

run_gate "scripts/verify-github-environment-protection.test.mjs"
assert_contains "- node scripts/verify-github-environment-protection.test.mjs (GitHub environment protection checker changed)"

run_gate "scripts/agent-autoreview.sh"
assert_contains "- pnpm agent:autoreview:test (agent autoreview adapter changed)"

run_gate "scripts/agent-autoreview.test.sh"
assert_contains "- pnpm agent:autoreview:test (agent autoreview adapter changed)"

run_gate "scripts/repo-health/dev-janitor.sh"
assert_contains "- bash scripts/repo-health/dev-janitor.test.sh (dev janitor script changed)"

run_gate "scripts/repo-health/dev-janitor.test.sh"
assert_contains "- bash scripts/repo-health/dev-janitor.test.sh (dev janitor script changed)"

# Other root-script changes only need the standalone scripts ESLint.
run_gate "scripts/repo-health/code-health-history.mjs"
assert_contains "- pnpm lint:scripts (root build script changed)"
assert_not_contains "(ESLint baseline wrapper changed)"

# Root ESLint config changes trigger scripts lint.
run_gate "eslint.config.mjs"
assert_contains "- pnpm lint:scripts (root build script changed)"
} # end family: routing-docs

# family: stamps-commands
# Per-command stamps: resume after a flaky failure, invalidation on any
# content change, always-rerun exemptions, command timeouts and interrupts.
run_stamps_commands_family() {
arm_suite_abort_trap
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
  mkdir -p bin scripts/gate tools
  printf 'console.log("fixture");\n' > scripts/gate/agent-prewarm.mjs
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
  printf 'scripts/gate/agent-prewarm.mjs\n' > changed-paths.txt
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
  mkdir -p bin scripts/gate tools
  printf 'console.log("fixture");\n' > scripts/gate/agent-prewarm.mjs
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
  printf 'scripts/gate/agent-prewarm.mjs\n' > changed-paths.txt
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

  printf 'console.log("changed");\n' >> scripts/gate/agent-prewarm.mjs
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
  mkdir -p bin scripts/gate tools
  printf 'console.log("fixture");\n' > scripts/gate/agent-prewarm.mjs
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
  printf '%s\n' scripts/gate/agent-prewarm.mjs scripts/agent-quality-gate.sh > changed-paths.txt
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
  mkdir -p bin scripts/gate tools
  printf 'console.log("fixture");\n' > scripts/gate/agent-prewarm.mjs
  cat > tools/trunk <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  # A distinctively-named victim so pgrep can prove the tree was reaped. The
  # parent exits on TERM while its child ignores TERM (PR 1492 review): the
  # watchdog must snapshot the tree before TERM and KILL the saved list, or
  # the reparented child survives the escalation.
  #
  # GitHub issue #1898: distinctive is not the same as unique. `pgrep` scans the
  # whole machine, so a fixed name also matched a sibling worktree's fixture and
  # four parallel suite runs failed each other's assertions — and `pkill` would
  # have reaped a sibling's live fixture on the way out. The name therefore
  # carries this run's own PID, and every scan below is scoped to that name.
  # Same construction as the lock-race fixtures further down.
  timeout_fixture_tag="$((RANDOM % 900 + 100))-$$"
  timeout_victim="$command_timeout_repo/bin/qg-timeout-victim-$timeout_fixture_tag"
  timeout_orphan="$command_timeout_repo/bin/qg-timeout-orphan-$timeout_fixture_tag"
  cat > "$timeout_orphan" <<'STUB'
#!/usr/bin/env bash
trap '' TERM
while :; do sleep 1; done
STUB
  cat > "$timeout_victim" <<'STUB'
#!/usr/bin/env bash
trap 'exit 0' TERM
"${QG_TIMEOUT_ORPHAN:?}" &
sleep 45 &
wait
STUB
  cat > bin/pnpm <<'STUB'
#!/usr/bin/env bash
if [[ "$*" == "agent:prewarm:test" ]]; then
  exec "${QG_TIMEOUT_VICTIM:?}"
fi
exit 0
STUB
  chmod +x bin/pnpm "$timeout_victim" "$timeout_orphan" tools/trunk
  git add .
  git commit -qm init
  printf 'scripts/gate/agent-prewarm.mjs\n' > changed-paths.txt
  set +e
  PATH="$command_timeout_repo/bin:$PATH" \
    QG_TIMEOUT_VICTIM="$timeout_victim" \
    QG_TIMEOUT_ORPHAN="$timeout_orphan" \
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
  if pgrep -f "qg-timeout-victim-$timeout_fixture_tag" >/dev/null 2>&1; then
    pkill -KILL -f "qg-timeout-victim-$timeout_fixture_tag" 2>/dev/null || true
    fail "timed-out command left a leaked background process"
  fi
  if pgrep -f "qg-timeout-orphan-$timeout_fixture_tag" >/dev/null 2>&1; then
    pkill -KILL -f "qg-timeout-orphan-$timeout_fixture_tag" 2>/dev/null || true
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
  mkdir -p bin scripts/gate tools
  printf 'console.log("fixture");\n' > scripts/gate/agent-prewarm.mjs
  cat > tools/trunk <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  # Ignores TERM and respawns its sleep child each second, so only the KILL
  # escalation can reap it. Run-unique for the same reason as the timeout
  # fixture above (GitHub issue #1898): this suite waits on `pgrep` to decide
  # the victim started, so a sibling worktree's fixture would satisfy the wait
  # before this run's victim exists.
  interrupt_fixture_tag="$((RANDOM % 900 + 100))-$$"
  interrupt_victim="$command_interrupt_repo/bin/qg-interrupt-victim-$interrupt_fixture_tag"
  cat > "$interrupt_victim" <<'STUB'
#!/usr/bin/env bash
trap '' TERM
while :; do sleep 1; done
STUB
  cat > bin/pnpm <<'STUB'
#!/usr/bin/env bash
if [[ "$*" == "agent:prewarm:test" ]]; then
  exec "${QG_INTERRUPT_VICTIM:?}"
fi
exit 0
STUB
  chmod +x bin/pnpm "$interrupt_victim" tools/trunk
  git add .
  git commit -qm init
  printf 'scripts/gate/agent-prewarm.mjs\n' > changed-paths.txt
  set +e
  PATH="$command_interrupt_repo/bin:$PATH" \
    QG_INTERRUPT_VICTIM="$interrupt_victim" \
    "$repo_root/scripts/agent-quality-gate.sh" \
      --changed-paths-file changed-paths.txt \
      --base HEAD \
      --run \
      --parallel 1 \
      > "$output_file" 2>&1 &
  gate_pid=$!
  waited=0
  until pgrep -f "qg-interrupt-victim-$interrupt_fixture_tag" >/dev/null 2>&1; do
    sleep 1
    waited=$((waited + 1))
    if [[ "$waited" -ge 20 ]]; then
      kill -KILL "$gate_pid" 2>/dev/null
      pkill -KILL -f "qg-interrupt-victim-$interrupt_fixture_tag" 2>/dev/null
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
  if pgrep -f "qg-interrupt-victim-$interrupt_fixture_tag" >/dev/null 2>&1; then
    pkill -KILL -f "qg-interrupt-victim-$interrupt_fixture_tag" 2>/dev/null || true
    fail "interrupted gate left a SIGTERM-ignoring process running"
  fi
)
rm -rf "$command_interrupt_repo"
} # end family: stamps-commands

# family: execution-parallel
# Parallel teardown process groups, the production identity contract, and
# prerequisite commands that are never stamped or reused.
run_execution_parallel_family() {
arm_suite_abort_trap
# GitHub issue #1522: every parallel mapped command must be registered as a
# dedicated process group before INT/TERM teardown can run. Cover both sides of
# the original race:
# - registration: INT lands after launch but before the parent records the PGID;
# - execution: the worker leader dies first, so only its still-live process
#   group can reach the reparented TERM-ignoring descendants.
run_parallel_interrupt_regression() {
  local phase="$1"
  local signal="$2"
  local expected_exit="$3"
  local parallel_interrupt_repo
  parallel_interrupt_repo="$(mktemp -d)"
  (
    cd "$parallel_interrupt_repo"
    git init -q
    git config user.email test@example.invalid
    git config user.name "Quality Gate Test"
    mkdir -p bin scripts/gate tools
    printf 'console.log("fixture");\n' > scripts/gate/agent-prewarm.mjs
    mkdir -p scripts/context
    printf 'console.log("fixture");\n' > scripts/context/agent-context-budget.mjs
    cat > tools/trunk <<'STUB'
#!/usr/bin/env bash
if [[ "${QG_FAST_RUN:-0}" == "1" ]]; then
  exit 0
fi
exec qg-par-victim
STUB
    cat > bin/qg-par-descendant <<'STUB'
#!/usr/bin/env bash
trap '' TERM
printf '%s\n' "$$" > "${QG_DESCENDANT_PID_FILE:?}"
while :; do sleep 1; done
STUB
    cat > bin/qg-par-victim <<'STUB'
#!/usr/bin/env bash
trap '' TERM
printf '%s\n' "$$" > "${QG_VICTIM_PID_FILE:?}"
qg-par-descendant &
wait
STUB
    cat > bin/pnpm <<'STUB'
#!/usr/bin/env bash
if [[ "${QG_FAST_RUN:-0}" == "1" ]]; then
  exit 0
fi
exec sleep 45
STUB
    chmod +x bin/pnpm bin/qg-par-victim bin/qg-par-descendant tools/trunk
    git add .
    git commit -qm init
    printf 'scripts/gate/agent-prewarm.mjs\nscripts/context/agent-context-budget.mjs\n' > changed-paths.txt

    local barrier="$parallel_interrupt_repo/registration"
    local gate_output="$parallel_interrupt_repo/gate-output"
    local next_gate_output="$parallel_interrupt_repo/next-gate-output"
    local victim_pid_file="$parallel_interrupt_repo/victim.pid"
    local descendant_pid_file="$parallel_interrupt_repo/descendant.pid"
    local gate_pid=""
    local next_gate_pid=""
    local worker_pgid=""
    local victim_pid=""
    local descendant_pid=""
    local launched=0
    local settled=0
    local attempt
    local interrupt_exit
    local next_gate_exit

    # Invoked indirectly by the EXIT trap below.
    # shellcheck disable=SC2329
    cleanup_parallel_interrupt_fixture() {
      if [[ "$worker_pgid" =~ ^[1-9][0-9]*$ ]]; then
        kill -KILL -- "-$worker_pgid" 2>/dev/null || true
      fi
      if [[ "$gate_pid" =~ ^[1-9][0-9]*$ ]]; then
        kill -CONT "$gate_pid" 2>/dev/null || true
        kill -KILL "$gate_pid" 2>/dev/null || true
        wait "$gate_pid" 2>/dev/null || true
      fi
      if [[ "$next_gate_pid" =~ ^[1-9][0-9]*$ ]]; then
        kill -KILL "$next_gate_pid" 2>/dev/null || true
        wait "$next_gate_pid" 2>/dev/null || true
      fi
    }
    fail_parallel_interrupt_fixture() {
      cp "$gate_output" "$output_file" 2>/dev/null || true
      fail "$*"
    }
    trap cleanup_parallel_interrupt_fixture EXIT

    if [[ "$phase" == "execution" ]]; then
      : > "${barrier}.release"
    fi

    QG_VICTIM_PID_FILE="$victim_pid_file" \
      QG_DESCENDANT_PID_FILE="$descendant_pid_file" \
      NODE_ENV=test \
      AGENT_QUALITY_GATE_TEST_WORKER_REGISTRATION_BARRIER="$barrier" \
      PATH="$parallel_interrupt_repo/bin:$PATH" \
      /usr/bin/perl -e \
        '$SIG{INT} = "DEFAULT"; $SIG{TERM} = "DEFAULT"; exec @ARGV; die "exec failed: $!\n";' \
        /bin/bash "$repo_root/scripts/agent-quality-gate.sh" \
          --changed-paths-file changed-paths.txt \
          --base HEAD \
          --run \
          --parallel 2 \
          > "$gate_output" 2>&1 &
    gate_pid=$!

    for ((attempt = 0; attempt < 200; attempt++)); do
      if [[
        -s "${barrier}.ready" &&
          -s "$victim_pid_file" &&
          -s "$descendant_pid_file"
      ]]; then
        launched=1
        break
      fi
      if ! kill -0 "$gate_pid" 2>/dev/null; then
        break
      fi
      sleep 0.05
    done
    [[ "$launched" -eq 1 ]] ||
      fail_parallel_interrupt_fixture \
        "parallel $phase interrupt fixture never reached its worker"

    worker_pgid="$(cat "${barrier}.ready")"
    victim_pid="$(cat "$victim_pid_file")"
    descendant_pid="$(cat "$descendant_pid_file")"
    [[ "$worker_pgid" =~ ^[1-9][0-9]*$ ]] ||
      fail_parallel_interrupt_fixture \
        "parallel $phase interrupt fixture recorded an invalid worker PGID"
    kill -0 -- "-$worker_pgid" 2>/dev/null ||
      fail_parallel_interrupt_fixture \
        "parallel $phase worker did not launch in a dedicated process group"

    if [[ "$phase" == "registration" ]]; then
      # The gate is blocked after worker launch and before registry insertion.
      # The signal must remain pending until the PGID is registered.
      kill "-$signal" "$gate_pid"
      sleep 0.2 || true
      : > "${barrier}.release"
    else
      # Freeze the parent with the group registered, remove only the group
      # leader, then interrupt the parent. A PID-tree snapshot rooted at the
      # dead leader cannot find the surviving group members.
      sleep 0.2
      kill -STOP "$gate_pid"
      kill -KILL "$worker_pgid"
      sleep 0.1
      kill "-$signal" "$gate_pid"
      kill -CONT "$gate_pid"
    fi

    for ((attempt = 0; attempt < 300; attempt++)); do
      if ! jobs -pr | grep -Fxq "$gate_pid"; then
        settled=1
        break
      fi
      sleep 0.05
    done
    [[ "$settled" -eq 1 ]] ||
      fail_parallel_interrupt_fixture \
        "parallel $phase interrupt did not terminate the gate within 15s"

    set +e
    wait "$gate_pid"
    interrupt_exit=$?
    set -e
    gate_pid=""
    [[ "$interrupt_exit" -eq "$expected_exit" ]] ||
      fail_parallel_interrupt_fixture \
        "parallel $phase interrupt exited $interrupt_exit, expected $expected_exit"

    for ((attempt = 0; attempt < 100; attempt++)); do
      if ! kill -0 -- "-$worker_pgid" 2>/dev/null; then
        break
      fi
      sleep 0.05
    done
    if kill -0 -- "-$worker_pgid" 2>/dev/null; then
      fail_parallel_interrupt_fixture \
        "parallel $phase interrupt left the registered worker group running"
    fi
    if kill -0 "$victim_pid" 2>/dev/null ||
      kill -0 "$descendant_pid" 2>/dev/null; then
      fail_parallel_interrupt_fixture \
        "parallel $phase interrupt left a TERM-ignoring descendant running"
    fi
    worker_pgid=""

    # The interrupted run must leave no process that a later gate can inherit
    # or join. Run the same plan with fast fixtures and bound its completion.
    QG_FAST_RUN=1 \
      PATH="$parallel_interrupt_repo/bin:$PATH" \
      /bin/bash "$repo_root/scripts/agent-quality-gate.sh" \
        --changed-paths-file changed-paths.txt \
        --base HEAD \
        --run \
        --parallel 2 \
        > "$next_gate_output" 2>&1 &
    next_gate_pid=$!
    settled=0
    for ((attempt = 0; attempt < 200; attempt++)); do
      if ! jobs -pr | grep -Fxq "$next_gate_pid"; then
        settled=1
        break
      fi
      sleep 0.05
    done
    [[ "$settled" -eq 1 ]] ||
      fail_parallel_interrupt_fixture \
        "gate after parallel $phase interrupt did not finish cleanly within 10s"
    set +e
    wait "$next_gate_pid"
    next_gate_exit=$?
    set -e
    next_gate_pid=""
    [[ "$next_gate_exit" -eq 0 ]] ||
      fail_parallel_interrupt_fixture \
        "gate after parallel $phase interrupt exited $next_gate_exit"

    trap - EXIT
  )
  rm -rf "$parallel_interrupt_repo"
}

run_parallel_interrupt_regression registration INT 130
run_parallel_interrupt_regression execution TERM 143

# Keep the production identity contract reachable from every protected source
# in CI and from the local changed-path router.
node scripts/production-infra-identity-contract/routing.test.mjs

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
  mkdir -p bin scripts/pr shared-config/src sub tools
  printf '{"name":"sub"}\n' > sub/package.json
  printf 'export const x = 1;\n' > shared-config/src/x.ts
  printf 'process.exit(0);\n' > scripts/pr/check-adr-reminder.mjs
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
if [[ "$*" == "--filter @mento-protocol/config build" ]]; then
  echo run >> "$BUILD_SIDE_EFFECT"
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
  printf 'sub/package.json\nshared-config/src/x.ts\n' > changed-paths.txt
  for _ in 1 2; do
    INSTALL_SIDE_EFFECT="$prereq_reuse_repo/install-side-effect" \
      BUILD_SIDE_EFFECT="$prereq_reuse_repo/build-side-effect" \
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
  # PR 1492 review: the --parallel 1 sequential branch bypasses
  # run_prerequisite_phase, so setup exemption must come from the command
  # classification — the shared-config build (a quality-setup command whose
  # dist/ output the fingerprint cannot see) must also run on BOTH runs.
  [[ "$(wc -l < "$prereq_reuse_repo/build-side-effect" | tr -d ' ')" == "2" ]] ||
    fail "expected the quality-setup config build to run on BOTH runs (setup commands are never reused)"
  [[ "$(wc -l < "$prereq_reuse_repo/skew-side-effect" | tr -d ' ')" == "1" ]] ||
    fail "expected the quality command to be reused on the second run"
)
rm -rf "$prereq_reuse_repo"
} # end family: execution-parallel

# family: lock-drain
# Cross-run mutual exclusion: lock acquisition, stale-holder reclaim, drain
# obligations, and crash-point recovery.
run_lock_drain_family() {
arm_suite_abort_trap
gate_test_outer_pid="$$"
gate_test_executor_pid="$PPID"
gate_test_signal_shell_pid="$gate_test_outer_pid"
gate_test_signal_trace_file="${GATE_TEST_SIGNAL_TRACE_FILE:-}"
gate_test_captured_shell_pid=""
gate_test_captured_start=""
gate_test_captured_parent=""

gate_test_process_start() {
  local pid="$1"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  TZ=UTC LC_ALL=C LANG=C ps -p "$pid" -o lstart= 2>/dev/null | head -n1 || true
}

gate_test_process_parent() {
  local pid="$1"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  TZ=UTC LC_ALL=C LANG=C ps -p "$pid" -o ppid= 2>/dev/null |
    awk 'NF { print $1; exit }' || true
}

gate_test_process_state() {
  local pid="$1"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  TZ=UTC LC_ALL=C LANG=C ps -p "$pid" -o stat= 2>/dev/null |
    awk 'NF { print $1; exit }' || true
}

gate_test_process_is_expected() {
  local pid="$1"
  local expected_start="$2"
  local expected_parent="$3"
  local current_start current_parent
  [[ "$pid" =~ ^[0-9]+$ && -n "$expected_start" && "$expected_parent" =~ ^[0-9]+$ ]] || return 1
  current_start="$(gate_test_process_start "$pid")"
  [[ -n "$current_start" && "$current_start" == "$expected_start" ]] || return 1
  current_parent="$(gate_test_process_parent "$pid")"
  [[ -n "$current_parent" && "$current_parent" == "$expected_parent" ]] || return 1
}

gate_test_process_has_start() {
  local pid="$1"
  local expected_start="$2"
  local current_start
  [[ "$pid" =~ ^[0-9]+$ && -n "$expected_start" ]] || return 1
  current_start="$(gate_test_process_start "$pid")"
  [[ -n "$current_start" && "$current_start" == "$expected_start" ]]
}

# Return success only while the recorded fixture identity can still execute. A
# zombie can retain the same PID and start time forever under a non-reaping PID
# 1, but it cannot run fixture code. An unreadable state stays live so cleanup
# fails closed instead of claiming an uncertain process absent. The production
# orphan drain applies the same rule only after it revalidates the exact PID and
# start time; lock-holder reclamation remains separate.
gate_test_process_has_live_start() {
  local pid="$1"
  local expected_start="$2"
  local current_start current_state
  [[ "$pid" =~ ^[0-9]+$ && -n "$expected_start" ]] || return 1
  current_start="$(gate_test_process_start "$pid")"
  [[ -n "$current_start" && "$current_start" == "$expected_start" ]] || return 1
  current_state="$(gate_test_process_state "$pid")"
  [[ -z "$current_state" || "$current_state" != Z* ]]
}

# Bash 3.2 has no nameref or safe command-substitution assignment to caller
# variables. Publish the exact identity through these family-scoped outputs.
gate_test_capture_identity() {
  local pid="$1"
  local expected_parent="${2:-}"
  gate_test_captured_start="$(gate_test_process_start "$pid")"
  gate_test_captured_parent="$(gate_test_process_parent "$pid")"
  [[ -n "$gate_test_captured_start" && "$gate_test_captured_parent" =~ ^[0-9]+$ ]] || return 1
  [[ -z "$expected_parent" || "$gate_test_captured_parent" == "$expected_parent" ]] || return 1
  gate_test_process_is_expected \
    "$pid" "$gate_test_captured_start" "$gate_test_captured_parent"
}

gate_test_trace_signal() {
  local event="$1"
  local label="$2"
  local signal="$3"
  local target="$4"
  local expected_start="${5:-}"
  local current_start="${6:-}"
  local expected_parent="${7:-}"
  local current_parent="${8:-}"
  [[ -n "$gate_test_signal_trace_file" ]] || return 0
  printf '%s|event=%s|label=%s|sender=%s|target=%s|signal=%s|expected_start=%s|current_start=%s|expected_ppid=%s|current_ppid=%s\n' \
    "$(date +%s)" "$event" "$label" "$gate_test_signal_shell_pid" "$target" "$signal" \
    "$expected_start" "$current_start" "$expected_parent" "$current_parent" \
    >> "$gate_test_signal_trace_file" 2>/dev/null || true
}

gate_test_pid_is_protected() {
  local pid="$1"
  [[ "$pid" == "$gate_test_outer_pid" ||
    "$pid" == "$gate_test_executor_pid" ||
    "$pid" == "$gate_test_signal_shell_pid" ]]
}

# Return 0 after sending the signal, 1 when the recorded process is already
# gone, and 2 when the target cannot be proved safe. The final identity read is
# deliberately adjacent to kill: macOS has no pidfd, so this is the narrowest
# fail-closed selector available to the Bash 3.2 test runtime.
gate_test_signal_expected() {
  local label="$1"
  local signal="$2"
  local pid="$3"
  local expected_start="$4"
  local expected_parent="$5"
  local current_start current_parent
  case "$signal" in
    TERM|KILL|STOP|CONT) ;;
    *) return 2 ;;
  esac
  [[ "$pid" =~ ^[0-9]+$ && -n "$expected_start" && "$expected_parent" =~ ^[0-9]+$ ]] || return 2
  if gate_test_pid_is_protected "$pid"; then
    gate_test_trace_signal refused-protected "$label" "$signal" "$pid" "$expected_start"
    return 2
  fi
  current_start="$(gate_test_process_start "$pid")"
  if [[ -z "$current_start" ]]; then
    gate_test_trace_signal already-gone "$label" "$signal" "$pid" "$expected_start"
    return 1
  fi
  current_parent="$(gate_test_process_parent "$pid")"
  if [[ "$current_start" != "$expected_start" ||
    "$current_parent" != "$expected_parent" ]]; then
    gate_test_trace_signal refused-mismatch "$label" "$signal" "$pid" \
      "$expected_start" "$current_start" "$expected_parent" "$current_parent"
    return 2
  fi
  gate_test_trace_signal send "$label" "$signal" "$pid" \
    "$expected_start" "$current_start" "$expected_parent" "$current_parent"
  kill "-$signal" "$pid" 2>/dev/null || return 1
}

# Use this for an exact process that was reparented after capture. Keep the
# recorded start time, then bind the signal to its current parent immediately
# before the final identity check and signal.
# shellcheck disable=SC2329 # invoked by the EXIT cleanup below
gate_test_signal_with_current_parent() {
  local label="$1"
  local signal="$2"
  local pid="$3"
  local expected_start="$4"
  local current_parent
  current_parent="$(gate_test_process_parent "$pid")"
  [[ "$current_parent" =~ ^[0-9]+$ ]] || return 2
  gate_test_signal_expected \
    "$label" "$signal" "$pid" "$expected_start" "$current_parent"
}

# Bash 3.2 has no BASHPID, while $$ and PPID keep the outer shell's values in a
# parenthesized subshell. A directly launched sh sees the real current shell as
# its parent and writes that PID through a path already owned by this fixture.
gate_test_capture_current_shell_pid() {
  local capture_file="$1"
  gate_test_captured_shell_pid=""
  /bin/sh -c 'printf "%s\n" "$PPID"' > "$capture_file" || return 1
  IFS= read -r gate_test_captured_shell_pid < "$capture_file" || return 1
  rm -f "$capture_file"
  [[ "$gate_test_captured_shell_pid" =~ ^[0-9]+$ ]]
}

# shellcheck disable=SC2329 # invoked by the opt-in TERM traps below
gate_test_on_term() {
  local label="$1"
  local shell_pid="$2"
  gate_test_trace_signal received "$label" TERM "$shell_pid"
  trap - TERM
  kill -TERM "$shell_pid"
}

if [[ -n "$gate_test_signal_trace_file" ]]; then
  trap 'gate_test_on_term outer-suite "$gate_test_outer_pid"' TERM
fi
# --- Cross-run mutual exclusion (GitHub issue #1802) -------------------------
# Two gate runs on one machine starve each other, and the pre-push hook starts
# one of its own while a manual run is still going, so `--run` takes a
# machine-wide mkdir lock. What has to hold: a live holder makes the second run
# wait rather than race, a holder that was killed never wedges the next run,
# and both escape hatches (--no-lock, an inherited nested-run marker) still
# start immediately.
gate_lock_repo="$(mktemp -d)"
gate_lock_root="$(mktemp -d)"
(
  cd "$gate_lock_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  printf 'fixture\n' > fixture.txt
  mkdir -p tools
  cat > tools/trunk <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  chmod +x tools/trunk
  git add .
  git commit -qm init
  printf 'changed\n' >> fixture.txt

  run_locked_gate() {
    # AGENT_QUALITY_GATE_LOCK_HELD is cleared deliberately: when this suite runs
    # as a mapped command of a real gate it inherits the outer run's marker,
    # and every contention assertion below would pass vacuously through the
    # nested-run escape hatch.
    set +e
    AGENT_QUALITY_GATE_LOCK=1 \
      AGENT_QUALITY_GATE_LOCK_HELD='' \
      AGENT_QUALITY_GATE_LOCK_DIR="$gate_lock_root" \
      AGENT_QUALITY_GATE_LOCK_POLL_SECONDS=1 \
      "$repo_root/scripts/agent-quality-gate.sh" \
      --base HEAD --run --lock-wait 2 "$@" \
      > "$output_file" 2>&1
    local exit_code=$?
    set -e
    printf '%s\n' "$exit_code"
  }

  write_lock_owner() {
    mkdir -p "$gate_lock_root/run.lock"
    {
      printf 'pid=%s\n' "$1"
      printf 'host=%s\n' "$(uname -n)"
      printf 'started_at=%s\n' "$(date +%s)"
      printf 'worktree=%s\n' "$gate_lock_repo"
      printf 'token=fixture-holder-1-1\n'
    } > "$gate_lock_root/run.lock/owner"
  }

  # A live holder: the second run announces who it is waiting for, keeps
  # waiting, and gives up with a bounded, actionable failure instead of hanging.
  sleep 120 &
  live_holder_pid=$!
  write_lock_owner "$live_holder_pid"
  lock_exit="$(run_locked_gate)"
  kill "$live_holder_pid" 2>/dev/null || true
  [[ "$lock_exit" == "2" ]] ||
    fail "expected a contended gate run to exit 2 after --lock-wait, got $lock_exit"
  assert_contains "Waiting for the agent quality gate run lock"
  assert_contains "held by pid ${live_holder_pid}"
  assert_contains "timed out after"
  # The pre-push hook cannot pass --no-lock, so the timeout must also name the
  # recovery that works from a failed push.
  assert_contains "--skip-if-fresh cache-hits and exits before this lock"
  [[ -d "$gate_lock_root/run.lock" ]] ||
    fail "a run that never acquired the lock must not delete the holder's lock"

  # GitHub issue #1894: the same expiry, read the way a piped caller reads it.
  # Every other outcome states itself on stdout — a green run ends "All mapped
  # commands passed." — but the expiry used to speak on stderr alone, leaving a
  # stdout stream that ended on the reassuring "waiting up to Ns" banner. A
  # caller that piped the gate then had two signals and both lied: that stream,
  # and a pipeline status that belongs to the READER unless the caller set
  # `pipefail`. So this asserts the shape that misled — stdout piped, stderr
  # discarded — on both halves: the gate's own status, and a stdout stream that
  # names the wait expiry and says nothing ran.
  sleep 120 &
  piped_holder_pid=$!
  write_lock_owner "$piped_holder_pid"
  set +e
  AGENT_QUALITY_GATE_LOCK=1 \
    AGENT_QUALITY_GATE_LOCK_HELD='' \
    AGENT_QUALITY_GATE_LOCK_DIR="$gate_lock_root" \
    AGENT_QUALITY_GATE_LOCK_POLL_SECONDS=1 \
    "$repo_root/scripts/agent-quality-gate.sh" \
    --base HEAD --run --lock-wait 2 \
    2>/dev/null | cat > "$output_file"
  piped_exit="${PIPESTATUS[0]}"
  set -e
  kill "$piped_holder_pid" 2>/dev/null || true
  [[ "$piped_exit" == "2" ]] ||
    fail "expected a piped contended gate run to exit 2 after --lock-wait, got $piped_exit"
  assert_raw_contains "Gate run lock wait expired after"
  assert_raw_contains "No mapped command ran; this gate exits 2."
  assert_raw_contains "read \${PIPESTATUS[0]} or set -o pipefail"
  [[ -d "$gate_lock_root/run.lock" ]] ||
    fail "a piped run that never acquired the lock must not delete the holder's lock"

  # The same expiry against a reader that closes the pipe. Whether the run
  # reaches the verdict (exit 2) or dies writing the wait banner (a SIGPIPE
  # death) is a race with the reader, so what is pinned here is the invariant
  # the whole path owes its caller rather than one of the two statuses: a run
  # that executed nothing never reports success.
  sleep 120 &
  closed_pipe_holder_pid=$!
  write_lock_owner "$closed_pipe_holder_pid"
  set +e
  AGENT_QUALITY_GATE_LOCK=1 \
    AGENT_QUALITY_GATE_LOCK_HELD='' \
    AGENT_QUALITY_GATE_LOCK_DIR="$gate_lock_root" \
    AGENT_QUALITY_GATE_LOCK_POLL_SECONDS=1 \
    "$repo_root/scripts/agent-quality-gate.sh" \
    --base HEAD --run --lock-wait 2 \
    2> "$output_file" | head -c 1 > /dev/null
  closed_pipe_exit="${PIPESTATUS[0]}"
  set -e
  kill "$closed_pipe_holder_pid" 2>/dev/null || true
  [[ "$closed_pipe_exit" != "0" ]] ||
    fail "a contended gate whose reader closed the pipe reported success without executing anything"
  [[ -d "$gate_lock_root/run.lock" ]] ||
    fail "a run killed by a closed pipe must not delete the holder's lock"

  # A dead holder whose record carries a token the gate would never generate
  # is waited out, never reclaimed: reclaiming would later drain by that
  # token, matching processes with a value another writer chose. On a shared
  # root that record can be crafted, so fail-closed here means the timeout.
  malformed_dead_pid="$(fresh_dead_pid)" ||
    fail "could not obtain a reaped PID that reads as dead for the malformed-token case"
  mkdir -p "$gate_lock_root/run.lock"
  {
    printf 'pid=%s\n' "$malformed_dead_pid"
    printf 'host=%s\n' "$(uname -n)"
    printf 'started_at=%s\n' "$(date +%s)"
    printf 'worktree=%s\n' "$gate_lock_repo"
    printf 'token=crafted.*\n'
  } > "$gate_lock_root/run.lock/owner"
  lock_exit="$(run_locked_gate)"
  [[ "$lock_exit" == "2" ]] ||
    fail "a malformed-token record must be waited out and fail closed, got $lock_exit"
  assert_contains "timed out after"
  [[ -d "$gate_lock_root/run.lock" ]] ||
    fail "a malformed-token record must never be reclaimed"
  rm -rf "$gate_lock_root/run.lock"

  # An inherited nested-run marker (the gate's own self-test runs the gate)
  # starts immediately instead of deadlocking behind its own ancestor.
  sleep 120 &
  nested_holder_pid=$!
  write_lock_owner "$nested_holder_pid"
  set +e
  AGENT_QUALITY_GATE_LOCK=1 \
    AGENT_QUALITY_GATE_LOCK_HELD=outer-run \
    AGENT_QUALITY_GATE_LOCK_DIR="$gate_lock_root" \
    "$repo_root/scripts/agent-quality-gate.sh" \
    --base HEAD --run --lock-wait 5 \
    > "$output_file" 2>&1
  nested_exit=$?
  set -e
  kill "$nested_holder_pid" 2>/dev/null || true
  [[ "$nested_exit" == "0" ]] ||
    fail "expected a nested gate run to ignore the lock, got $nested_exit"
  assert_not_contains "Waiting for the agent quality gate run lock"

  # --no-lock is the documented escape hatch: it starts despite a live holder
  # and leaves that holder's lock alone.
  sleep 120 &
  bypass_holder_pid=$!
  write_lock_owner "$bypass_holder_pid"
  bypass_exit="$(run_locked_gate --no-lock)"
  kill "$bypass_holder_pid" 2>/dev/null || true
  [[ "$bypass_exit" == "0" ]] ||
    fail "expected --no-lock to run despite a live holder, got $bypass_exit"
  assert_not_contains "Waiting for the agent quality gate run lock"
  [[ -d "$gate_lock_root/run.lock" ]] ||
    fail "--no-lock must not delete another run's lock"

  # A killed holder (SIGKILL leaves the directory behind, EXIT trap and all)
  # must never wedge the next run: it reclaims the lock unattended, then
  # releases its own on the way out.
  dead_holder_pid="$(fresh_dead_pid)" ||
    fail "could not obtain a reaped PID that reads as dead for the stale-lock case"
  write_lock_owner "$dead_holder_pid"
  stale_exit="$(run_locked_gate)"
  [[ "$stale_exit" == "0" ]] ||
    fail "expected a stale lock to be reclaimed without manual cleanup, got $stale_exit"
  assert_contains "is stale (holder pid ${dead_holder_pid} is gone); reclaiming it."
  [[ ! -d "$gate_lock_root/run.lock" ]] ||
    fail "a successful run must release the lock it acquired"
)
rm -rf "$gate_lock_repo" "$gate_lock_root"

# Reclaiming a lock spans two decisions — "this lock is stale" and "take it" —
# and creating one spans two more: win `mkdir`, then record ownership. Both
# windows are sub-millisecond in production, which is why the gate exposes
# test-only delays that hold them open. What has to hold either way: exactly
# one run executes mapped commands at a time. The fixture's only mapped command
# is a trunk stub recording when it starts and stops, so two overlapping
# records are the failure these two cases exist to catch.
gate_race_repo="$(mktemp -d)"
gate_race_root="$(mktemp -d)"
# Logs and per-run output live outside the fixture repo on purpose: written
# inside it they become untracked changed paths, so every run would map
# commands over the suite's own artifacts and the mapped set would grow as
# the suite went on.
gate_race_out="$(mktemp -d)"
gate_race_log="$gate_race_out/race.log"
gate_race_sync="$(mktemp -d)"
(
  gate_test_capture_current_shell_pid "$gate_race_sync/race-shell.pid" ||
    fail "could not capture the lock-race subshell PID under Bash 3.2"
  gate_test_signal_shell_pid="$gate_test_captured_shell_pid"
  [[ "$gate_test_signal_shell_pid" != "$gate_test_outer_pid" &&
    "$gate_test_signal_shell_pid" != "$gate_test_executor_pid" ]] ||
    fail "the lock-race subshell PID aliases a protected outer identity"
  if [[ -n "$gate_test_signal_trace_file" ]]; then
    gate_test_trace_signal identity race-subshell NONE "$gate_test_signal_shell_pid" \
      "$(gate_test_process_start "$gate_test_signal_shell_pid")" \
      "$(gate_test_process_start "$gate_test_signal_shell_pid")" \
      "$gate_test_outer_pid" \
      "$(gate_test_process_parent "$gate_test_signal_shell_pid")"
    trap 'gate_test_on_term race-subshell "$gate_test_signal_shell_pid"' TERM
  fi
  gate_race_fixture_epoch="$(date +%s)"
  race_inherited_token="$(printf "fixture-inherited-%s-%s" "$gate_test_outer_pid" "$gate_race_fixture_epoch")"
  race_drained_first_token="$(printf "fixture-drained-first-%s-%s" "$gate_test_outer_pid" "$gate_race_fixture_epoch")"
  race_arrived_late_token="$(printf "fixture-arrived-late-%s-%s" "$gate_test_outer_pid" "$gate_race_fixture_epoch")"
  race_zombie_token="$(printf "fixture-zombie-%s-%s" "$gate_test_outer_pid" "$gate_race_fixture_epoch")"
  for race_fixture_token in \
    "$race_inherited_token" "$race_drained_first_token" \
    "$race_arrived_late_token" "$race_zombie_token"; do
    [[ "$race_fixture_token" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,180}-[0-9]{1,10}-[0-9]{1,12}$ ]] ||
      fail "suite-unique live fixture token is malformed: ${race_fixture_token}"
  done
  race_drain_cleanup_active=0
  race_drain_hold_file=""
  race_drain_orphan=""
  race_drain_orphan_start=""
  race_drain_a_wrapper=""
  race_drain_a_wrapper_start=""
  race_drain_a_wrapper_parent=""
  race_drain_b_wrapper=""
  race_drain_b_wrapper_start=""
  race_drain_b_wrapper_parent=""
  race_drain_c_wrapper=""
  race_drain_c_wrapper_start=""
  race_drain_c_wrapper_parent=""
  race_drain_watchdog_identities=""
  race_fork_record=""
  race_fork_ack=""
  race_fork_wrapper=""
  race_fork_wrapper_start=""
  race_fork_wrapper_parent=""
  race_fork_bystander=""
  race_fork_bystander_start=""
  race_fork_bystander_parent=""
  race_forkexit_record=""
  race_forkexit_ack=""
  race_forkexit_wrapper=""
  race_forkexit_wrapper_start=""
  race_forkexit_wrapper_parent=""
  race_forkexit_bystander=""
  race_forkexit_bystander_start=""
  race_forkexit_bystander_parent=""
  race_fork_probe_record=""
  race_fork_unit_bystander=""
  race_fork_unit_bystander_start=""
  race_fork_unit_bystander_parent=""
  race_zombie_supervisor=""
  race_zombie_supervisor_start=""
  race_zombie_supervisor_parent=""
  race_zombie_supervisor_release=""
  race_zombie_child=""
  race_zombie_child_start=""
  race_drain_owned_survivors=""
  race_drain_owned_record_error=""
  race_drain_pair_observation_file=""
  race_drain_pair_require_change=0

  race_drain_process_is_expected() {
    local pid="$1"
    local expected_start="$2"
    local expected_parent="$3"
    gate_test_process_is_expected "$pid" "$expected_start" "$expected_parent"
  }

  race_drain_victim_is_expected() {
    [[ "$race_drain_cleanup_active" -eq 1 && -n "$race_drain_orphan" && -n "$race_drain_orphan_start" ]] || return 1
    gate_test_process_has_live_start "$race_drain_orphan" "$race_drain_orphan_start"
  }

  race_drain_process_is_stopped() {
    local pid="$1"
    local expected_start="$2"
    local expected_parent="$3"
    local current_state
    race_drain_process_is_expected "$pid" "$expected_start" "$expected_parent" || return 1
    current_state="$(ps -p "$pid" -o stat= 2>/dev/null || true)"
    [[ -n "$current_state" && "$current_state" == *T* ]]
  }

  race_drain_suspend_direct_watchdogs() {
    local label="$1"
    local gate_pid="$2"
    local watchdog_deadline watchdogs watchdog_scan_status race_wd
    race_drain_watchdog_identities=""
    race_drain_watchdog_count=0
    race_drain_watchdog_pid=""
    race_drain_watchdog_start=""
    race_drain_watchdog_parent=""
    watchdog_deadline=$(( $(date +%s) + 10 ))
    while :; do
      if watchdogs="$(pgrep -P "$gate_pid" -f "collect_tree" 2>/dev/null)"; then
        watchdog_scan_status=0
      else
        watchdog_scan_status=$?
      fi
      [[ "$watchdog_scan_status" -le 1 ]] || return 2
      [[ -n "$watchdogs" ]] && break
      [[ "$(date +%s)" -lt "$watchdog_deadline" ]] || return 2
      sleep 1
    done
    for race_wd in $watchdogs; do
      gate_test_capture_identity "$race_wd" "$gate_pid" || return 2
      race_drain_watchdog_pid="$race_wd"
      race_drain_watchdog_start="$gate_test_captured_start"
      race_drain_watchdog_parent="$gate_test_captured_parent"
      race_drain_watchdog_identities="${race_drain_watchdog_identities}${race_wd}|${race_drain_watchdog_start}|${race_drain_watchdog_parent}"$'\n'
      gate_test_signal_expected "$label" STOP \
        "$race_wd" "$race_drain_watchdog_start" "$race_drain_watchdog_parent" ||
        return 2
      race_drain_watchdog_count=$((race_drain_watchdog_count + 1))
    done
  }

  # Return 0 only when a direct child is confirmed gone or a zombie, so a
  # following wait cannot block. Return 1 for its exact live identity, 2 when
  # it still answers but its identity/state cannot be read, and 3 for a PID
  # that now names something else.
  race_drain_direct_wrapper_reap_state() {
    local wrapper_pid="$1"
    local wrapper_start="$2"
    local wrapper_parent="$3"
    local current_start current_parent current_state
    [[ "$wrapper_pid" =~ ^[0-9]+$ && -n "$wrapper_start" ]] || return 2
    if ! kill -0 "$wrapper_pid" 2>/dev/null; then
      return 0
    fi
    current_start="$(TZ=UTC LC_ALL=C LANG=C ps -p "$wrapper_pid" -o lstart= 2>/dev/null || true)"
    [[ -n "$current_start" ]] || return 2
    [[ "$current_start" == "$wrapper_start" ]] || return 3
    current_parent="$(gate_test_process_parent "$wrapper_pid")"
    [[ -n "$current_parent" ]] || return 2
    [[ -z "$wrapper_parent" || "$current_parent" == "$wrapper_parent" ]] || return 3
    current_state="$(ps -p "$wrapper_pid" -o stat= 2>/dev/null || true)"
    [[ -n "$current_state" ]] || return 2
    [[ "$current_state" == Z* ]] && return 0
    return 1
  }

  race_drain_direct_wrapper_is_expected() {
    local wrapper_pid="$1"
    local wrapper_start="$2"
    local wrapper_parent="$3"
    local reap_state
    if race_drain_direct_wrapper_reap_state "$wrapper_pid" "$wrapper_start" "$wrapper_parent"; then
      return 1
    else
      reap_state=$?
    fi
    [[ "$reap_state" -eq 1 ]]
  }

  race_drain_reap_direct_wrapper() {
    local label="$1"
    local wrapper_pid="$2"
    local wrapper_start="$3"
    local wrapper_parent="$4"
    local reap_state wait_status deadline current_start current_parent
    if race_drain_direct_wrapper_reap_state "$wrapper_pid" "$wrapper_start" "$wrapper_parent"; then
      # The probe confirmed a zombie or that this PID no longer answers, so a
      # wait on this direct child cannot block.
      if wait "$wrapper_pid" 2>/dev/null; then
        wait_status=0
      else
        wait_status=$?
      fi
      # `wait` can return a command's signal/non-zero status without proving
      # that this exact PID/start identity left the process table. Do not let a
      # successor inherit the stale owner record until that absence is bounded
      # and explicit. PPID is intentionally not part of this death proof: a
      # dead child can be reparented before it disappears.
      deadline=$(( $(date +%s) + 10 ))
      while gate_test_process_has_start "$wrapper_pid" "$wrapper_start" && \
        [[ "$(date +%s)" -lt "$deadline" ]]; do
        sleep 1
      done
      if gate_test_process_has_start "$wrapper_pid" "$wrapper_start"; then
        current_start="$(gate_test_process_start "$wrapper_pid")"
        current_parent="$(gate_test_process_parent "$wrapper_pid")"
        gate_test_trace_signal post-reap-timeout "$label" NONE "$wrapper_pid" \
          "$wrapper_start" "$current_start" "$wrapper_parent" "$current_parent"
        return 124
      fi
      gate_test_trace_signal post-reap-gone "$label" NONE "$wrapper_pid" \
        "$wrapper_start" "" "$wrapper_parent" ""
      return "$wait_status"
    else
      reap_state=$?
    fi
    case "$reap_state" in
      1)
        echo "interrupted-drain cleanup: ${label} wrapper ${wrapper_pid} is still live; refusing an unbounded reap" >&2
        ;;
      2)
        echo "interrupted-drain cleanup: ${label} wrapper ${wrapper_pid} still answers but its identity/state cannot be read; refusing an unbounded reap" >&2
        ;;
      3)
        echo "interrupted-drain cleanup: ${label} wrapper ${wrapper_pid} no longer has its recorded identity; refusing an unbounded reap" >&2
        ;;
      *)
        echo "interrupted-drain cleanup: ${label} wrapper ${wrapper_pid} had an unknown reap state; refusing an unbounded reap" >&2
        ;;
    esac
    return 124
  }

  race_drain_cleanup_direct_wrapper() {
    local label="$1"
    local wrapper_pid="$2"
    local wrapper_start="$3"
    local wrapper_parent="$4"
    local deadline reap_status signal_status
    [[ -n "$wrapper_pid" && -n "$wrapper_start" && -n "$wrapper_parent" ]] || return 0

    if race_drain_direct_wrapper_is_expected "$wrapper_pid" "$wrapper_start" "$wrapper_parent"; then
      if gate_test_signal_expected "$label" TERM "$wrapper_pid" "$wrapper_start" "$wrapper_parent"; then
        :
      else
        signal_status=$?
        [[ "$signal_status" -eq 1 ]] || return 124
      fi
      deadline=$(( $(date +%s) + 10 ))
      while race_drain_direct_wrapper_is_expected "$wrapper_pid" "$wrapper_start" "$wrapper_parent" && [[ "$(date +%s)" -lt "$deadline" ]]; do sleep 1; done
    fi
    if race_drain_direct_wrapper_is_expected "$wrapper_pid" "$wrapper_start" "$wrapper_parent"; then
      if gate_test_signal_expected "$label" KILL "$wrapper_pid" "$wrapper_start" "$wrapper_parent"; then
        :
      else
        signal_status=$?
        [[ "$signal_status" -eq 1 ]] || return 124
      fi
      deadline=$(( $(date +%s) + 10 ))
      while race_drain_direct_wrapper_is_expected "$wrapper_pid" "$wrapper_start" "$wrapper_parent" && [[ "$(date +%s)" -lt "$deadline" ]]; do sleep 1; done
    fi
    if race_drain_reap_direct_wrapper "$label" "$wrapper_pid" "$wrapper_start" "$wrapper_parent"; then
      return 0
    else
      reap_status=$?
    fi
    # A reaped child can report its command's signal/non-zero status. Cleanup
    # still completed in that case; 124 is reserved for an unsafe reap.
    [[ "$reap_status" -eq 124 ]] && return 124
    return 0
  }

  race_drain_wait_for_direct_wrapper() {
    local label="$1"
    local wrapper_pid="$2"
    local wrapper_start="$3"
    local wrapper_parent="$4"
    local wait_seconds="${5:-10}"
    local deadline
    [[ -n "$wrapper_pid" && -n "$wrapper_start" && -n "$wrapper_parent" ]] || return 0
    if ! [[ "$wait_seconds" =~ ^[0-9]+$ && "$wait_seconds" -ge 1 ]]; then
      echo "interrupted-drain fixture: ${label} has an invalid wait bound" >&2
      return 64
    fi

    deadline=$(( $(date +%s) + wait_seconds ))
    while race_drain_direct_wrapper_is_expected "$wrapper_pid" "$wrapper_start" "$wrapper_parent" && [[ "$(date +%s)" -lt "$deadline" ]]; do sleep 1; done
    if race_drain_direct_wrapper_is_expected "$wrapper_pid" "$wrapper_start" "$wrapper_parent"; then
      race_drain_cleanup_direct_wrapper "$label" "$wrapper_pid" "$wrapper_start" "$wrapper_parent"
      return 124
    fi
    race_drain_reap_direct_wrapper "$label" "$wrapper_pid" "$wrapper_start" "$wrapper_parent"
  }

  race_drain_kill_and_reap_direct_wrapper() {
    local label="$1"
    local wrapper_pid="$2"
    local wrapper_start="$3"
    local wrapper_parent="$4"
    local deadline reap_status signal_status
    [[ -n "$wrapper_pid" && -n "$wrapper_start" && -n "$wrapper_parent" ]] || return 0

    if race_drain_direct_wrapper_is_expected "$wrapper_pid" "$wrapper_start" "$wrapper_parent"; then
      if gate_test_signal_expected "$label" KILL "$wrapper_pid" "$wrapper_start" "$wrapper_parent"; then
        :
      else
        signal_status=$?
        [[ "$signal_status" -eq 1 ]] || return 124
      fi
    fi
    deadline=$(( $(date +%s) + 10 ))
    while race_drain_direct_wrapper_is_expected "$wrapper_pid" "$wrapper_start" "$wrapper_parent" && [[ "$(date +%s)" -lt "$deadline" ]]; do sleep 1; done
    if race_drain_reap_direct_wrapper "$label" "$wrapper_pid" "$wrapper_start" "$wrapper_parent"; then
      return 0
    else
      reap_status=$?
    fi
    [[ "$reap_status" -eq 124 ]] && return 124
    return 0
  }

  race_drain_snapshot_identity_file() {
    local label="$1"
    local source_path="$2"
    local snapshot_path="$3"
    local deadline last_byte owned_pid owned_start
    race_drain_owned_record_error=""
    case "$source_path" in
      "$gate_race_out"/*) ;;
      *)
        race_drain_owned_record_error="${label} path is outside the private fixture output directory: ${source_path}"
        return 124
        ;;
    esac
    if [[ -L "$source_path" || ! -f "$source_path" ||
      ! -O "$source_path" || ! -r "$source_path" || ! -w "$source_path" ]]; then
      race_drain_owned_record_error="${label} path must be an owned readable writable regular file, not a symlink: ${source_path}"
      return 124
    fi
    case "$snapshot_path" in
      "$gate_race_out"/*) ;;
      *)
        race_drain_owned_record_error="${label} snapshot path is outside the private fixture output directory: ${snapshot_path}"
        return 124
        ;;
    esac
    if [[ -L "$snapshot_path" ||
      ( -e "$snapshot_path" &&
        ( ! -f "$snapshot_path" || ! -O "$snapshot_path" ||
          ! -r "$snapshot_path" || ! -w "$snapshot_path" ) ) ]]; then
      race_drain_owned_record_error="${label} snapshot path must be an owned readable writable regular file, not a symlink: ${snapshot_path}"
      return 124
    fi
    : > "$snapshot_path" || {
      race_drain_owned_record_error="${label} snapshot could not be created: ${snapshot_path}"
      return 124
    }
    if [[ -L "$snapshot_path" || ! -f "$snapshot_path" ||
      ! -O "$snapshot_path" || ! -r "$snapshot_path" || ! -w "$snapshot_path" ]]; then
      race_drain_owned_record_error="${label} snapshot path changed ownership, access, or type"
      return 124
    fi
    deadline=$(( $(date +%s) + 5 ))
    while :; do
      if ! cp "$source_path" "$snapshot_path"; then
        race_drain_owned_record_error="${label} could not be copied into its private snapshot"
        return 124
      fi
      if [[ ! -L "$source_path" && -f "$source_path" &&
        -O "$source_path" && -r "$source_path" && -w "$source_path" ]] &&
        cmp -s "$source_path" "$snapshot_path"; then
        break
      fi
      if [[ "$(date +%s)" -ge "$deadline" ]]; then
        race_drain_owned_record_error="${label} did not become stable before the bounded snapshot deadline"
        return 124
      fi
      sleep 1
    done
    if [[ -s "$snapshot_path" ]]; then
      last_byte="$(tail -c 1 "$snapshot_path" 2>/dev/null || true)"
      if [[ -n "$last_byte" ]]; then
        race_drain_owned_record_error="${label} ends with an incomplete identity record"
        return 124
      fi
    fi
    if ! awk -F '|' '
      (NF != 2 && NF != 3) || $1 !~ /^[1-9][0-9]*$/ || length($1) > 10 ||
        $2 == "" || (NF == 3 && $3 !~ /^[1-9][0-9]*$/) || seen[$1]++ { exit 1 }
    ' "$snapshot_path"; then
      race_drain_owned_record_error="${label} contains a malformed or duplicate identity record"
      return 124
    fi
    while IFS='|' read -r owned_pid owned_start owned_parent; do
      [[ -n "$owned_pid" ]] || continue
      if gate_test_pid_is_protected "$owned_pid"; then
        race_drain_owned_record_error="${label} contains protected PID ${owned_pid}"
        return 124
      fi
      [[ -n "$owned_start" ]] || {
        race_drain_owned_record_error="${label} contains an empty start identity for PID ${owned_pid}"
        return 124
      }
      [[ -z "$owned_parent" || "$owned_parent" =~ ^[1-9][0-9]*$ ]] || {
        race_drain_owned_record_error="${label} contains an invalid parent identity for PID ${owned_pid}"
        return 124
      }
    done < "$snapshot_path"
  }

  race_drain_validate_identity_pair() {
    local label="$1"
    local record_path="$2"
    local ack_path="$3"
    local record_snapshot="${record_path}.snapshot"
    local ack_snapshot="${ack_path}.snapshot"
    if ! race_drain_snapshot_identity_file "${label} record" "$record_path" "$record_snapshot"; then
      return 124
    fi
    if ! race_drain_snapshot_identity_file "${label} acknowledgement" "$ack_path" "$ack_snapshot"; then
      return 124
    fi
    if ! cmp -s "$record_snapshot" "$ack_snapshot"; then
      race_drain_owned_record_error="${label} record and acknowledgement snapshots differ"
      return 124
    fi
  }

  # Call this only after every registered producer wrapper is absent. Require
  # three identical nonempty record/ack observations so a child released just
  # after one cmp cannot append an identity outside the cleanup snapshot.
  race_drain_wait_for_stable_identity_pair() {
    local label="$1"
    local record_path="$2"
    local ack_path="$3"
    local record_snapshot="${record_path}.snapshot"
    local ack_snapshot="${ack_path}.snapshot"
    local stable_dir previous_record previous_ack
    local observation_file="${race_drain_pair_observation_file:-}"
    local require_change="${race_drain_pair_require_change:-0}"
    local deadline change_observed=0 stable_observations=0
    local stable_pair_wait_seconds=30
    race_drain_pair_observation_file=""
    race_drain_pair_require_change=0
    [[ -n "$record_path" && -n "$ack_path" ]] || {
      race_drain_owned_record_error="${label} record and acknowledgement paths must both be set"
      return 124
    }
    [[ "$require_change" == "0" || "$require_change" == "1" ]] || {
      race_drain_owned_record_error="${label} has an invalid stability change requirement"
      return 124
    }
    if [[ -n "$observation_file" ]]; then
      case "$observation_file" in
        "$gate_race_out"/*) ;;
        *)
          race_drain_owned_record_error="${label} observation path is outside the private fixture output directory"
          return 124
          ;;
      esac
      if [[ -e "$observation_file" || -L "$observation_file" ]]; then
        race_drain_owned_record_error="${label} observation path must be absent before the first snapshot"
        return 124
      fi
    fi
    stable_dir="$(mktemp -d "$gate_race_out/identity-pair.XXXXXX")" || {
      race_drain_owned_record_error="${label} could not create its private stability directory"
      return 124
    }
    previous_record="$stable_dir/record"
    previous_ack="$stable_dir/ack"
    deadline=$(( $(date +%s) + stable_pair_wait_seconds ))
    while :; do
      if race_drain_validate_identity_pair "$label" "$record_path" "$ack_path" &&
        [[ -s "$record_snapshot" && -s "$ack_snapshot" ]]; then
        if [[ -f "$previous_record" && -f "$previous_ack" ]]; then
          if cmp -s "$record_snapshot" "$previous_record" &&
            cmp -s "$ack_snapshot" "$previous_ack"; then
            if [[ "$require_change" -eq 0 || "$change_observed" -eq 1 ]]; then
              stable_observations=$((stable_observations + 1))
              if [[ "$stable_observations" -ge 2 ]]; then
                rm -rf "$stable_dir"
                return 0
              fi
            fi
          else
            [[ "$require_change" -eq 0 ]] || change_observed=1
            stable_observations=0
          fi
        else
          stable_observations=0
          if [[ -n "$observation_file" ]]; then
            if ! (set -C && : > "$observation_file") 2>/dev/null; then
              race_drain_owned_record_error="${label} could not publish its first-observation marker"
              rm -rf "$stable_dir"
              return 124
            fi
          fi
        fi
        if ! cp "$record_snapshot" "$previous_record" ||
          ! cp "$ack_snapshot" "$previous_ack"; then
          race_drain_owned_record_error="${label} could not retain its stability snapshots"
          rm -rf "$stable_dir"
          return 124
        fi
      else
        stable_observations=0
      fi
      if [[ "$(date +%s)" -ge "$deadline" ]]; then
        race_drain_owned_record_error="${label} record and acknowledgement did not become repeatedly stable before the bounded deadline"
        rm -rf "$stable_dir"
        return 124
      fi
      sleep 1
    done
  }

  # Return 0 when every recorded identity was already absent, 1 when at least
  # one exact fixture-owned survivor was found and removed, and 124 when the
  # record or bounded cleanup could not be proved safe. Validate the complete
  # snapshot before the first signal so one malformed line cannot authorize a
  # partial cleanup.
  race_drain_inspect_owned_record() {
    local label="$1"
    local record_path="$2"
    local snapshot_path="${record_path}.cleanup.snapshot"
    local owned_pid owned_start owned_parent current_start current_parent current_state signal_status
    local deadline found_survivor=0 cleanup_status=0
    race_drain_owned_survivors=""
    if [[ -z "$record_path" ]]; then
      return 0
    fi
    if ! race_drain_snapshot_identity_file "${label} record" "$record_path" "$snapshot_path"; then
      return 124
    fi
    while IFS='|' read -r owned_pid owned_start owned_parent; do
      [[ -n "$owned_pid" ]] || continue
      current_start="$(gate_test_process_start "$owned_pid")"
      current_parent="$(gate_test_process_parent "$owned_pid")"
      gate_test_trace_signal identity "$label" NONE "$owned_pid" \
        "$owned_start" "$current_start" "$owned_parent" "$current_parent"
      if [[ -z "$current_start" ]]; then
        continue
      fi
      if [[ "$current_start" != "$owned_start" ]]; then
        gate_test_trace_signal refused-reused "$label" KILL "$owned_pid" \
          "$owned_start" "$current_start" "$owned_parent" "$current_parent"
        continue
      fi
      current_state="$(gate_test_process_state "$owned_pid")"
      if [[ "$current_state" == Z* ]]; then
        gate_test_trace_signal absent-zombie "$label" NONE "$owned_pid" \
          "$owned_start" "$current_start" "$owned_parent" "$current_parent"
        continue
      fi
      found_survivor=1
      race_drain_owned_survivors="${race_drain_owned_survivors}${race_drain_owned_survivors:+ }${owned_pid}"
      deadline=$(( $(date +%s) + 10 ))
      while gate_test_process_has_live_start "$owned_pid" "$owned_start"; do
        if gate_test_signal_with_current_parent \
          "${label} fixture-owned survivor" KILL "$owned_pid" "$owned_start"; then
          break
        else
          signal_status=$?
        fi
        [[ "$signal_status" -eq 1 ]] && break
        if [[ "$(date +%s)" -ge "$deadline" ]]; then
          cleanup_status=124
          break
        fi
        sleep 1
      done
      deadline=$(( $(date +%s) + 10 ))
      while gate_test_process_has_live_start "$owned_pid" "$owned_start" &&
        [[ "$(date +%s)" -lt "$deadline" ]]; do
        sleep 1
      done
      if gate_test_process_has_live_start "$owned_pid" "$owned_start"; then
        race_drain_owned_record_error="${label} exact survivor ${owned_pid} exceeded its bounded cleanup"
        cleanup_status=124
      fi
    done < "$snapshot_path"
    [[ "$cleanup_status" -eq 0 ]] || return 124
    [[ "$found_survivor" -eq 0 ]] || return 1
    return 0
  }

  # shellcheck disable=SC2329 # invoked through the EXIT cleanup tracker below
  race_drain_inspect_owned_pair() {
    local label="$1"
    local record_path="$2"
    local ack_path="$3"
    if [[ -z "$record_path" && -z "$ack_path" ]]; then
      return 0
    fi
    race_drain_wait_for_stable_identity_pair \
      "$label" "$record_path" "$ack_path" || return 124
    race_drain_inspect_owned_record "$label" "$record_path"
  }

  race_drain_cleanup_suspended_watchdogs() {
    local watchdog_pid watchdog_start watchdog_parent current_parent deadline cleanup_status=0 signal_status
    while IFS='|' read -r watchdog_pid watchdog_start watchdog_parent; do
      [[ -n "$watchdog_pid" && -n "$watchdog_start" ]] || continue
      if [[ ! "$watchdog_parent" =~ ^[0-9]+$ ]]; then
        cleanup_status=124
        continue
      fi
      if gate_test_process_has_live_start "$watchdog_pid" "$watchdog_start"; then
        # Leave a pending TERM unhandled. Resuming this stopped watchdog could
        # make it run its own stale drain path. KILL removes only this exact
        # identity without executing that deferred work.
        current_parent="$(gate_test_process_parent "$watchdog_pid")"
        if gate_test_signal_expected "stopped watchdog" KILL \
          "$watchdog_pid" "$watchdog_start" "$current_parent"; then
          :
        else
          signal_status=$?
          [[ "$signal_status" -eq 1 ]] || cleanup_status=124
        fi
        deadline=$(( $(date +%s) + 10 ))
        while gate_test_process_has_live_start "$watchdog_pid" "$watchdog_start" && [[ "$(date +%s)" -lt "$deadline" ]]; do sleep 1; done
      fi
      if gate_test_process_has_live_start "$watchdog_pid" "$watchdog_start"; then
        echo "interrupted-drain cleanup: watchdog ${watchdog_pid} survived the bounded cleanup wait" >&2
        cleanup_status=124
      fi
    done <<EOF
$race_drain_watchdog_identities
EOF
    return "$cleanup_status"
  }

  # Launch a fixture command through a directly-owned /bin/sh child. The
  # child publishes one exact identity record, then waits for the parent to
  # create a private release file with noclobber. Registration happens before
  # that release, so an EXIT trap can always find the original process.
  race_bound_registered=""
  race_bound_pid=""
  race_bound_start=""
  race_bound_parent=""
  race_bound_dir=""
  race_bound_record=""
  race_bound_release=""
  race_bound_started=""
  race_bound_nonce=""
  race_bound_failure_wait_seconds=35
  race_bound_unregistered=""
  race_bound_sequence=0
  race_bound_job_is_active() {
    local job_pid jobs_output
    jobs_output="$( { jobs -pr; jobs -ps; } 2>/dev/null || true)"
    for job_pid in $jobs_output; do
      [[ "$job_pid" == "$1" ]] && return 0
    done
    return 1
  }
  race_bound_wait_unreleased() {
    local child_pid="$1"
    local wait_seconds="${2:-35}"
    local deadline
    [[ "$wait_seconds" =~ ^[0-9]+$ && "$wait_seconds" -ge 1 ]] || return 124
    deadline=$(( $(date +%s) + wait_seconds ))
    while race_bound_job_is_active "$child_pid" &&
      [[ "$(date +%s)" -lt "$deadline" ]]; do
      sleep 1
    done
    race_bound_job_is_active "$child_pid" && return 124
    wait "$child_pid" 2>/dev/null || true
  }
  race_bound_launch_failure() {
    local message="$1"
    local child_pid="${2:-}"
    local registered=0 wait_status=0
    if [[ -n "$race_bound_dir" && "$race_bound_registered" == *"|${race_bound_dir}|"* ]]; then
      registered=1
    fi
    if [[ -n "$child_pid" && "$registered" -eq 0 ]]; then
      race_bound_wait_unreleased \
        "$child_pid" "$race_bound_failure_wait_seconds" || wait_status=$?
    fi
    if [[ "$registered" -eq 0 ]]; then
      if [[ -z "$child_pid" || "$wait_status" -eq 0 ]]; then
        [[ -z "$race_bound_dir" ]] || rm -rf "$race_bound_dir"
        race_bound_pid=""
        race_bound_start=""
        race_bound_parent=""
        race_bound_dir=""
        race_bound_record=""
        race_bound_release=""
        race_bound_started=""
        race_bound_nonce=""
      else
        race_bound_unregistered="${race_bound_unregistered}${race_bound_unregistered:+$'\n'}${child_pid}|${race_bound_dir}|${race_bound_failure_wait_seconds}"
        echo "launch-bound fixture failed: unregistered child ${child_pid} remained active after its derived wait bound" >&2
      fi
    fi
    echo "launch-bound fixture failed: $message" >&2
    return 1
  }
  race_bound_launch_command() {
    local label="$1"
    local seconds="$2"
    shift 2
    local command_name="${1:-}"
    local child_pid child_record_line child_record_last_byte child_start child_parent
    local deadline
    race_bound_pid=""
    race_bound_start=""
    race_bound_parent=""
    race_bound_dir=""
    race_bound_record=""
    race_bound_release=""
    race_bound_started=""
    race_bound_nonce=""
    if ! [[ "$seconds" =~ ^[0-9]+$ && "$seconds" -ge 1 ]]; then
      race_bound_launch_failure "$label has an invalid hard bound"
      return 1
    fi
    race_bound_failure_wait_seconds=$((seconds + 5))
    if [[ -z "$command_name" ]]; then
      race_bound_launch_failure "$label has no command"
      return 1
    fi
    if ! race_bound_dir="$(mktemp -d "$gate_race_out/launch-bound.XXXXXX")"; then
      race_bound_launch_failure "$label could not create a private launch directory"
      return 1
    fi
    race_bound_record="$race_bound_dir/identity"
    race_bound_release="$race_bound_dir/release"
    race_bound_started="$race_bound_dir/started"
    race_bound_sequence=$((race_bound_sequence + 1))
    race_bound_nonce="launch-bound-${gate_test_outer_pid}-${race_bound_sequence}"
    if ! [[ ! -e "$race_bound_record" && ! -L "$race_bound_record" &&
      ! -e "$race_bound_release" && ! -L "$race_bound_release" &&
      ! -e "$race_bound_started" && ! -L "$race_bound_started" ]]; then
      race_bound_launch_failure "$label release or record path existed before fork"
      return 1
    fi
    /bin/sh -c '
      race_bound_seconds=$1
      race_bound_record=$2
      race_bound_release=$3
      race_bound_started=$4
      shift 4
      race_bound_pid=$$
      race_bound_start=$(TZ=UTC LC_ALL=C LANG=C ps -p "$race_bound_pid" -o lstart= 2>/dev/null) || exit 64
      race_bound_parent=$PPID
      [ -n "$race_bound_start" ] || exit 64
      [ "$race_bound_parent" -eq "$PPID" ] 2>/dev/null || exit 64
      (set -C && printf "%s|%s|%s\n" "$race_bound_pid" "$race_bound_start" "$race_bound_parent" > "$race_bound_record") || exit 64
      exec 7>&-
      exec 8>&-
      race_bound_deadline=$(( $(date +%s) + race_bound_seconds ))
      while [ ! -s "$race_bound_release" ] &&
        [ "$(date +%s)" -lt "$race_bound_deadline" ]; do
        sleep 1
      done
      race_bound_release_value=""
      race_bound_release_line_count=0
      while IFS= read -r race_bound_release_line || [ -n "$race_bound_release_line" ]; do
        race_bound_release_line_count=$((race_bound_release_line_count + 1))
        if [ "$race_bound_release_line_count" -ne 1 ] || [ -z "$race_bound_release_line" ]; then
          exit 64
        fi
        race_bound_release_value=$race_bound_release_line
      done < "$race_bound_release"
      [ "$race_bound_release_line_count" -eq 1 ] || exit 64
      [ -n "$race_bound_release_value" ] || exit 64
      (set -C && printf "%s\n" "$race_bound_release_value" > "$race_bound_started") || exit 64
      exec "$@"
    ' launch-bound-child "$seconds" "$race_bound_record" "$race_bound_release" \
      "$race_bound_started" "$@" &
    child_pid=$!
    race_bound_pid="$child_pid"
    deadline=$(( $(date +%s) + 15 ))
    child_record_line=""
    while [[ -z "$child_record_line" && "$(date +%s)" -lt "$deadline" ]]; do
      if [[ -f "$race_bound_record" ]]; then
        child_record_last_byte="$(tail -c 1 "$race_bound_record" 2>/dev/null || true)"
        if [[ -z "$child_record_last_byte" ]]; then
          child_record_line="$(awk 'NF { print; count++ } END { if (NR != 1 || count != 1) exit 1 }' \
            "$race_bound_record" 2>/dev/null || true)"
        fi
      fi
      [[ -n "$child_record_line" ]] || sleep 1
    done
    if [[ -z "$child_record_line" ]]; then
      race_bound_launch_failure "$label child did not publish one identity record" "$child_pid"
      return 1
    fi
    IFS='|' read -r child_record_pid child_start child_parent <<EOF
$child_record_line
EOF
    [[ "$child_record_pid" == "$child_pid" &&
      "$child_start" != *'|'* && -n "$child_start" &&
      "$child_parent" =~ ^[0-9]+$ &&
      "$child_parent" == "$gate_test_signal_shell_pid" ]] || {
      race_bound_launch_failure "$label child identity record was malformed" "$child_pid"
      return 1
    }
    gate_test_pid_is_protected "$child_record_pid" && {
      race_bound_launch_failure "$label child identity is protected" "$child_pid"
      return 1
    }
    gate_test_process_is_expected "$child_pid" "$child_start" "$child_parent" || {
      race_bound_launch_failure "$label child identity was not exact" "$child_pid"
      return 1
    }
    [[ ! -e "$race_bound_started" && ! -L "$race_bound_started" ]] || {
      race_bound_launch_failure "$label started marker existed before registration" "$child_pid"
      return 1
    }
    race_bound_start="$child_start"
    race_bound_parent="$child_parent"
    race_bound_registered="${race_bound_registered}${race_bound_registered:+$'\n'}${child_pid}|${child_start}|${child_parent}|${race_bound_dir}|${label}|${race_bound_nonce}|${race_bound_started}"
    [[ ! -e "$race_bound_started" && ! -L "$race_bound_started" ]] || {
      race_bound_launch_failure "$label started marker appeared before release" "$child_pid"
      return 1
    }
    (set -C && printf "%s\n" "$race_bound_nonce" > "$race_bound_release") || {
      race_bound_launch_failure "$label release could not be atomically published" "$child_pid"
      return 1
    }
    deadline=$(( $(date +%s) + 15 ))
    while [[ ! -s "$race_bound_started" && "$(date +%s)" -lt "$deadline" ]]; do sleep 1; done
    if [[ ! -s "$race_bound_started" ]] || ! awk -v expected="$race_bound_nonce" '
        NR == 1 { if (NF != 1 || $0 != expected) bad = 1; found = 1 }
        NR > 1 { bad = 1 }
        END { exit(bad || !found ? 1 : 0) }
    ' "$race_bound_started"; then
      race_bound_launch_failure "$label started marker did not match the release" "$child_pid"
      return 1
    fi
    gate_test_process_is_expected "$child_pid" "$child_start" "$child_parent" || {
      race_bound_launch_failure "$label child identity changed after release" "$child_pid"
      return 1
    }
  }
  # shellcheck disable=SC2329 # invoked only through cleanup_interrupted_drain_fixture
  race_bound_cleanup_unregistered() {
    local status=0
    local pending=""
    local child_pid child_dir wait_seconds
    while IFS='|' read -r child_pid child_dir wait_seconds; do
      [[ -n "$child_pid" ]] || continue
      if ! race_bound_wait_unreleased "$child_pid" "$wait_seconds"; then
        pending="${pending}${pending:+$'\n'}${child_pid}|${child_dir}|${wait_seconds}"
        status=124
        continue
      fi
      if [[ -n "$child_dir" ]] && ! rm -rf "$child_dir"; then
        pending="${pending}${pending:+$'\n'}${child_pid}|${child_dir}|${wait_seconds}"
        status=124
      fi
    done <<EOF
$race_bound_unregistered
EOF
    race_bound_unregistered="$pending"
    return "$status"
  }
  # shellcheck disable=SC2329 # invoked only through cleanup_interrupted_drain_fixture
  race_bound_cleanup_registered() {
    local status=0
    local pending=""
    local child_pid child_start child_parent child_dir child_label child_nonce child_started
    while IFS='|' read -r child_pid child_start child_parent child_dir child_label child_nonce child_started; do
      [[ -n "$child_pid" ]] || continue
      if gate_test_process_has_start "$child_pid" "$child_start"; then
        race_drain_kill_and_reap_direct_wrapper \
          "launch-bound ${child_label}" "$child_pid" "$child_start" "$child_parent" ||
          status=124
      fi
      if gate_test_process_has_start "$child_pid" "$child_start"; then
        pending="${pending}${pending:+$'\n'}${child_pid}|${child_start}|${child_parent}|${child_dir}|${child_label}|${child_nonce}|${child_started}"
        status=124
      else
        rm -rf "$child_dir"
      fi
    done <<EOF
$race_bound_registered
EOF
    race_bound_registered="$pending"
    return "$status"
  }

  # Remove completed launch records without signalling any fixture that still
  # has its registered process identity. The EXIT trap retains every live one.
  race_bound_prune_completed() {
    local pending=""
    local child_pid child_start child_parent child_dir child_label child_nonce child_started
    while IFS='|' read -r child_pid child_start child_parent child_dir child_label child_nonce child_started; do
      [[ -n "$child_pid" ]] || continue
      if gate_test_process_has_start "$child_pid" "$child_start"; then
        pending="${pending}${pending:+$'\n'}${child_pid}|${child_start}|${child_parent}|${child_dir}|${child_label}|${child_nonce}|${child_started}"
      else
        rm -rf "$child_dir"
      fi
    done <<EOF
$race_bound_registered
EOF
    race_bound_registered="$pending"
  }

  race_zombie_release_and_reap_supervisor() {
    local release_status=0
    [[ -n "$race_zombie_supervisor" ]] || return 0
    case "$race_zombie_supervisor_release" in
      "$gate_race_out"/*) ;;
      *) return 124 ;;
    esac
    if [[ -L "$race_zombie_supervisor_release" ]]; then
      return 124
    elif [[ ! -e "$race_zombie_supervisor_release" ]]; then
      (set -C && : > "$race_zombie_supervisor_release") 2>/dev/null ||
        release_status=124
    elif [[ ! -f "$race_zombie_supervisor_release" ||
      ! -O "$race_zombie_supervisor_release" ||
      ! -r "$race_zombie_supervisor_release" ||
      ! -w "$race_zombie_supervisor_release" ]]; then
      release_status=124
    fi
    if [[ -n "$race_zombie_supervisor_start" &&
      -n "$race_zombie_supervisor_parent" ]]; then
      race_drain_wait_for_direct_wrapper \
        "production zombie supervisor" "$race_zombie_supervisor" \
        "$race_zombie_supervisor_start" "$race_zombie_supervisor_parent" 35 ||
        release_status=124
    else
      race_bound_wait_unreleased "$race_zombie_supervisor" 35 ||
        release_status=124
    fi
    if [[ -n "$race_zombie_child" && -n "$race_zombie_child_start" ]] &&
      gate_test_process_has_start "$race_zombie_child" "$race_zombie_child_start"; then
      release_status=124
    fi
    [[ "$release_status" -eq 0 ]] || return "$release_status"
    race_zombie_supervisor=""
    race_zombie_supervisor_start=""
    race_zombie_supervisor_parent=""
    race_zombie_child=""
    race_zombie_child_start=""
    return 0
  }

  # shellcheck disable=SC2329 # invoked by the EXIT trap below
  cleanup_interrupted_drain_fixture() {
    local status=$?
    local deadline cleanup_status=0 final_status
    trap - EXIT
    race_cleanup_track() {
      "$@" || cleanup_status=124
    }
    race_cleanup_track_absent_ok() {
      local result
      if "$@"; then
        return 0
      else
        result=$?
      fi
      [[ "$result" -eq 1 ]] || cleanup_status=124
      return 0
    }
    if [[ -n "$race_drain_hold_file" ]]; then
      if [[ -L "$race_drain_hold_file" ]]; then
        echo "interrupted-drain cleanup: refusing to release symlink $race_drain_hold_file" >&2
        cleanup_status=124
      elif [[ ! -e "$race_drain_hold_file" ]]; then
        if ! (set -C && : > "$race_drain_hold_file") 2>/dev/null; then
          echo "interrupted-drain cleanup: could not release $race_drain_hold_file" >&2
          cleanup_status=124
        fi
      elif [[ ! -f "$race_drain_hold_file" ]]; then
        echo "interrupted-drain cleanup: refusing to release non-regular path $race_drain_hold_file" >&2
        cleanup_status=124
      fi
    fi
    if race_drain_victim_is_expected; then
      race_cleanup_track_absent_ok gate_test_signal_with_current_parent "held command" TERM \
        "$race_drain_orphan" "$race_drain_orphan_start"
      deadline=$(( $(date +%s) + 10 ))
      while race_drain_victim_is_expected && [[ "$(date +%s)" -lt "$deadline" ]]; do sleep 1; done
      if race_drain_victim_is_expected; then
        race_cleanup_track_absent_ok gate_test_signal_with_current_parent "held command" KILL \
          "$race_drain_orphan" "$race_drain_orphan_start"
        deadline=$(( $(date +%s) + 10 ))
        while race_drain_victim_is_expected && [[ "$(date +%s)" -lt "$deadline" ]]; do sleep 1; done
      fi
      if race_drain_victim_is_expected; then
        echo "interrupted-drain cleanup: victim $race_drain_orphan survived the bounded cleanup wait" >&2
        cleanup_status=124
      fi
    fi
    race_cleanup_track race_drain_cleanup_direct_wrapper \
      "A gate" "$race_drain_a_wrapper" "$race_drain_a_wrapper_start" \
      "$race_drain_a_wrapper_parent"
    race_cleanup_track race_drain_cleanup_direct_wrapper \
      "B gate" "$race_drain_b_wrapper" "$race_drain_b_wrapper_start" \
      "$race_drain_b_wrapper_parent"
    race_cleanup_track race_drain_cleanup_direct_wrapper \
      "C gate" "$race_drain_c_wrapper" "$race_drain_c_wrapper_start" \
      "$race_drain_c_wrapper_parent"
    race_cleanup_track race_drain_cleanup_direct_wrapper \
      "fork-on-TERM A gate" "$race_fork_wrapper" "$race_fork_wrapper_start" \
      "$race_fork_wrapper_parent"
    race_cleanup_track race_drain_cleanup_direct_wrapper \
      "fork-and-exit A gate" "$race_forkexit_wrapper" \
      "$race_forkexit_wrapper_start" "$race_forkexit_wrapper_parent"
    # Stop every registered publisher before freezing record/ack pairs. A
    # still-live publisher can append immediately after an otherwise clean cmp.
    race_cleanup_track race_bound_cleanup_unregistered
    race_cleanup_track race_bound_cleanup_registered
    race_cleanup_track_absent_ok race_drain_inspect_owned_pair \
      "fork-on-TERM" "$race_fork_record" "$race_fork_ack"
    race_cleanup_track_absent_ok race_drain_inspect_owned_pair \
      "fork-and-exit" "$race_forkexit_record" "$race_forkexit_ack"
    race_cleanup_track_absent_ok race_drain_inspect_owned_record \
      "publisher probe" "$race_fork_probe_record"
    race_cleanup_track race_drain_cleanup_direct_wrapper \
      "fork-on-TERM bystander" "$race_fork_bystander" \
      "$race_fork_bystander_start" "$race_fork_bystander_parent"
    race_cleanup_track race_drain_cleanup_direct_wrapper \
      "fork-and-exit bystander" "$race_forkexit_bystander" \
      "$race_forkexit_bystander_start" "$race_forkexit_bystander_parent"
    race_cleanup_track race_drain_cleanup_direct_wrapper \
      "fork-record unit bystander" "$race_fork_unit_bystander" \
      "$race_fork_unit_bystander_start" "$race_fork_unit_bystander_parent"
    race_cleanup_track race_zombie_release_and_reap_supervisor
    race_cleanup_track race_drain_cleanup_suspended_watchdogs
    final_status="$status"
    if [[ "$final_status" -eq 0 && "$cleanup_status" -ne 0 ]]; then
      final_status=124
    fi
    exit "$final_status"
  }
  trap cleanup_interrupted_drain_fixture EXIT

  cd "$gate_race_repo"
  git init -q
  git config user.email test@example.invalid
  git config user.name "Quality Gate Test"
  printf 'fixture\n' > fixture.txt
  mkdir -p tools
  # These fixed sleeps only need to outlast the bounded production drain and
  # fixture inspection. The child-published identity records own them; argv does not.
  gate_race_fork_seconds=600
  gate_race_forkexit_seconds=601
  # The two contention cases need this to outlast the stagger between their
  # waiters, or two unexcluded runs would simply miss each other and the
  # assertion would pass on broken code. Every other case only needs the gate
  # to execute something, so they run it at its cheap default.
cat > tools/trunk <<STUB
#!/usr/bin/env bash
if [ -n "\${RACE_STUB_VICTIM_PID:-}" ] || [ -n "\${RACE_STUB_VICTIM_LSTART:-}" ] || [ -n "\${RACE_STUB_VIOLATION_FILE:-}" ]; then
  [ -n "\${RACE_STUB_VICTIM_PID:-}" ] && [ -n "\${RACE_STUB_VICTIM_LSTART:-}" ] && [ -n "\${RACE_STUB_VIOLATION_FILE:-}" ] || {
    echo "race stub victim identity and violation file must be set together" >&2
    exit 64
  }
  race_stub_victim_state="\$(TZ=UTC LC_ALL=C LANG=C ps -p "\$RACE_STUB_VICTIM_PID" -o stat= 2>/dev/null | awk 'NF { print \$1; exit }' || true)"
  race_stub_victim_start="\$(TZ=UTC LC_ALL=C LANG=C ps -p "\$RACE_STUB_VICTIM_PID" -o lstart= 2>/dev/null || true)"
  case "\$race_stub_victim_state" in
    Z*) race_stub_victim_can_execute=0 ;;
    *) race_stub_victim_can_execute=1 ;;
  esac
  if [ -n "\$race_stub_victim_start" ] &&
    [ "\$race_stub_victim_start" = "\$RACE_STUB_VICTIM_LSTART" ] &&
    [ "\$race_stub_victim_can_execute" -eq 1 ]; then
    if ! (set -C && printf 'victim=%s|%s\\n' "\$RACE_STUB_VICTIM_PID" "\$RACE_STUB_VICTIM_LSTART" > "\$RACE_STUB_VIOLATION_FILE") 2>/dev/null; then
      echo "race stub could not atomically publish the C-before-victim-death violation" >&2
      exit 64
    fi
  fi
fi
race_stub_private_file_is_safe() {
  local race_stub_private_path="\$1"
  [[ -n "\$race_stub_private_path" && ! -L "\$race_stub_private_path" &&
    -f "\$race_stub_private_path" && -O "\$race_stub_private_path" &&
    -r "\$race_stub_private_path" && -w "\$race_stub_private_path" ]]
}
race_stub_fork_job_is_active() {
  local race_stub_jobs_output race_stub_job_pid
  race_stub_jobs_output="\$( { jobs -pr; jobs -ps; } 2>/dev/null || true)"
  for race_stub_job_pid in \$race_stub_jobs_output; do
    [ "\$race_stub_job_pid" = "\$1" ] && return 0
  done
  return 1
}
race_stub_fork_failure() {
  local race_stub_failure_message="\$1"
  local race_stub_failure_child="\${2:-}"
  if [[ "\${race_stub_fork_record_fd_open:-0}" -eq 1 ]]; then
    exec 7>&-
    race_stub_fork_record_fd_open=0
  fi
  if [[ "\${race_stub_fork_ack_fd_open:-0}" -eq 1 ]]; then
    exec 8>&-
    race_stub_fork_ack_fd_open=0
  fi
  if [[ -n "\$race_stub_failure_child" ]]; then
    race_stub_fork_deadline=\$(( \$(date +%s) + 50 ))
    while race_stub_fork_job_is_active "\$race_stub_failure_child" &&
      [ "\$(date +%s)" -lt "\$race_stub_fork_deadline" ]; do
      sleep 1
    done
    if ! race_stub_fork_job_is_active "\$race_stub_failure_child"; then
      wait "\$race_stub_failure_child" 2>/dev/null || true
      [[ -z "\${race_stub_fork_release_dir:-}" ]] ||
        rm -rf "\$race_stub_fork_release_dir"
    fi
  elif [[ -n "\${race_stub_fork_release_dir:-}" ]]; then
    rm -rf "\$race_stub_fork_release_dir"
  fi
  echo "race stub fork publisher failed: \$race_stub_failure_message" >&2
  exit 64
}
race_stub_publish_forked_sleep() {
  local race_stub_fork_seconds="\$1"
  local race_stub_fork_record="\${RACE_STUB_FORK_RECORD:-}"
  local race_stub_fork_ack="\${RACE_STUB_FORK_ACK:-}"
  local race_stub_fork_release_dir=""
  local race_stub_fork_release=""
  local race_stub_fork_started=""
  local race_stub_fork_nonce=""
  local race_stub_fork_ack_seconds="\${RACE_STUB_FORK_ACK_SECONDS:-5}"
  local race_stub_fork_test_close_record_fd="\${RACE_STUB_FORK_TEST_CLOSE_RECORD_FD:-}"
  local race_stub_fork_test_skip_ack="\${RACE_STUB_FORK_TEST_SKIP_ACK:-}"
  local race_stub_fork_record_fd_open=0
  local race_stub_fork_ack_fd_open=0
  local race_stub_fork_child=""
  local race_stub_fork_deadline
  local race_stub_fork_ack_line=""
  local race_stub_fork_ack_pid race_stub_fork_ack_start race_stub_fork_ack_parent
  local race_stub_fork_current_start race_stub_fork_current_parent
  local race_stub_fork_parent_pid="\$\$"
  case "\$race_stub_fork_seconds" in
    ''|*[!0-9]*) race_stub_fork_failure "sleep duration must be numeric" ;;
  esac
  case "\$race_stub_fork_ack_seconds" in
    ''|*[!0-9]*) race_stub_fork_failure "acknowledgement budget must be numeric" ;;
  esac
  [ "\$race_stub_fork_ack_seconds" -ge 1 ] && [ "\$race_stub_fork_ack_seconds" -le 30 ] ||
    race_stub_fork_failure "acknowledgement budget must be between 1 and 30 seconds"
  [ -n "\$race_stub_fork_record" ] && [ -n "\$race_stub_fork_ack" ] &&
    [ "\$race_stub_fork_record" != "\$race_stub_fork_ack" ] ||
    race_stub_fork_failure "record and acknowledgement paths must be set and distinct"
  race_stub_private_file_is_safe "\$race_stub_fork_record" ||
    race_stub_fork_failure "record path must be an owned readable writable regular file, not a symlink"
  race_stub_private_file_is_safe "\$race_stub_fork_ack" ||
    race_stub_fork_failure "acknowledgement path must be an owned readable writable regular file, not a symlink"
  if ! race_stub_fork_release_dir="\$(mktemp -d "\${race_stub_fork_record}.release.XXXXXX")"; then
    race_stub_fork_failure "private release directory could not be created"
  fi
  race_stub_fork_release="\$race_stub_fork_release_dir/release"
  race_stub_fork_started="\$race_stub_fork_release_dir/started"
  race_stub_fork_nonce="stub-\${race_stub_fork_parent_pid}-\$(basename "\$race_stub_fork_release_dir")"
  [ ! -e "\$race_stub_fork_release" ] && [ ! -L "\$race_stub_fork_release" ] ||
    race_stub_fork_failure "release path must be absent before fork"
  [ ! -e "\$race_stub_fork_started" ] && [ ! -L "\$race_stub_fork_started" ] ||
    race_stub_fork_failure "started path must be absent before fork"
  if ! exec 7>> "\$race_stub_fork_record"; then
    race_stub_fork_failure "record append descriptor could not be opened"
  fi
  race_stub_fork_record_fd_open=1
  if ! exec 8>> "\$race_stub_fork_ack"; then
    race_stub_fork_failure "acknowledgement append descriptor could not be opened"
  fi
  race_stub_fork_ack_fd_open=1
  race_stub_private_file_is_safe "\$race_stub_fork_record" &&
    race_stub_private_file_is_safe "\$race_stub_fork_ack" ||
    race_stub_fork_failure "record or acknowledgement path changed after descriptor open"
  /bin/sh -c '
    race_child_seconds=\$1
    race_child_close_record_fd=\$2
    race_child_skip_ack=\$3
    race_child_release=\$4
    race_child_release_dir=\$5
    race_child_started=\$6
    race_child_ack_seconds=\$7
    race_child_pid=\$\$
    race_child_start=\$(TZ=UTC LC_ALL=C LANG=C ps -p "\$race_child_pid" -o lstart= 2>/dev/null) || exit 64
    [ -n "\$race_child_start" ] || exit 64
    [ -z "\$race_child_close_record_fd" ] || exec 7>&-
    race_child_parent=\$PPID
    if ! printf "%s|%s|%s\\n" "\$race_child_pid" "\$race_child_start" "\$race_child_parent" >&7; then
      exec 7>&-
      exec 8>&-
      exit 64
    fi
    if [ -z "\$race_child_skip_ack" ] &&
      ! printf "%s|%s|%s\\n" "\$race_child_pid" "\$race_child_start" "\$race_child_parent" >&8; then
      exec 7>&-
      exec 8>&-
      exit 64
    fi
    exec 7>&-
    exec 8>&-
    race_child_deadline=\$(( \$(date +%s) + race_child_ack_seconds + 15 ))
    while [ ! -s "\$race_child_release" ] &&
      [ "\$(date +%s)" -lt "\$race_child_deadline" ]; do
      sleep 1
    done
    [ -s "\$race_child_release" ] || exit 64
    [ -d "\$race_child_release_dir" ] || exit 64
    race_child_release_value="\$(awk \
      "NR == 1 { if (NF != 1 || \\\$0 == \"\") bad = 1; value = \\\$0; found = 1 } NR > 1 { bad = 1 } END { if (bad || !found) exit 1; print value }" \
      "\$race_child_release" 2>/dev/null)" || exit 64
    (set -C && printf "%s\\n" "\$race_child_release_value" > "\$race_child_started") || exit 64
    exec sleep "\$race_child_seconds"
  ' race-stub-fork "\$race_stub_fork_seconds" \
    "\$race_stub_fork_test_close_record_fd" "\$race_stub_fork_test_skip_ack" \
    "\$race_stub_fork_release" "\$race_stub_fork_release_dir" \
    "\$race_stub_fork_started" "\$race_stub_fork_ack_seconds" &
  race_stub_fork_child=\$!
  exec 7>&-
  race_stub_fork_record_fd_open=0
  exec 8>&-
  race_stub_fork_ack_fd_open=0
  race_stub_fork_deadline=\$(( \$(date +%s) + race_stub_fork_ack_seconds ))
  while [ "\$(date +%s)" -lt "\$race_stub_fork_deadline" ]; do
    race_stub_private_file_is_safe "\$race_stub_fork_record" &&
      race_stub_private_file_is_safe "\$race_stub_fork_ack" ||
      race_stub_fork_failure "record or acknowledgement path changed ownership, access, or type" "\$race_stub_fork_child"
    if race_stub_fork_ack_line="\$(awk -F '|' -v expected_pid="\$race_stub_fork_child" \
      -v expected_parent="\$race_stub_fork_parent_pid" '
      \$1 == expected_pid {
        if (NF != 3 || \$2 == "" || \$3 != expected_parent || found) { bad = 1 }
        else { found = 1; line = \$0 }
      }
      END { if (bad) exit 2; if (found) print line }
    ' "\$race_stub_fork_ack" 2>/dev/null)"; then
      [ -z "\$race_stub_fork_ack_line" ] || break
    else
      race_stub_fork_failure "acknowledgement is malformed or duplicated" "\$race_stub_fork_child"
    fi
    sleep 1
  done
  [ -n "\$race_stub_fork_ack_line" ] ||
    race_stub_fork_failure "child did not acknowledge its identity before the deadline" "\$race_stub_fork_child"
  race_stub_fork_ack_pid="\${race_stub_fork_ack_line%%|*}"
  race_stub_fork_ack_start="\${race_stub_fork_ack_line#*|}"
  race_stub_fork_ack_parent="\${race_stub_fork_ack_start#*|}"
  race_stub_fork_ack_start="\${race_stub_fork_ack_start%%|*}"
  [ "\$race_stub_fork_ack_pid" != "\$race_stub_fork_parent_pid" ] &&
    [ "\$race_stub_fork_ack_pid" != 1 ] ||
    race_stub_fork_failure "acknowledged child identity is protected" "\$race_stub_fork_child"
  race_stub_private_file_is_safe "\$race_stub_fork_record" &&
    race_stub_private_file_is_safe "\$race_stub_fork_ack" ||
    race_stub_fork_failure "record or acknowledgement path changed before identity read" "\$race_stub_fork_child"
  [ "\$race_stub_fork_ack_pid" = "\$race_stub_fork_child" ] &&
    grep -Fqx "\$race_stub_fork_ack_line" "\$race_stub_fork_record" &&
    awk -F '|' -v expected_pid="\$race_stub_fork_child" \
      -v expected_parent="\$race_stub_fork_parent_pid" \
      '\$1 == expected_pid {
         if (NF != 3 || \$2 == "" || \$3 != expected_parent || found) { bad = 1 }
         else { found = 1; line = \$0 }
       }
       END { exit(bad || !found ? 1 : 0) }' "\$race_stub_fork_record" ||
    race_stub_fork_failure "record does not contain the acknowledged child identity" "\$race_stub_fork_child"
  race_stub_fork_current_start="\$(TZ=UTC LC_ALL=C LANG=C ps -p "\$race_stub_fork_child" -o lstart= 2>/dev/null || true)"
  race_stub_fork_current_parent="\$(TZ=UTC LC_ALL=C LANG=C ps -p "\$race_stub_fork_child" -o ppid= 2>/dev/null | awk 'NF { print \$1; exit }')"
  [ -n "\$race_stub_fork_current_start" ] &&
    [ "\$race_stub_fork_current_start" = "\$race_stub_fork_ack_start" ] &&
    [ "\$race_stub_fork_current_parent" = "\$race_stub_fork_ack_parent" ] ||
    race_stub_fork_failure "acknowledged child identity is no longer exact" "\$race_stub_fork_child"
  (set -C && printf "%s\\n" "\$race_stub_fork_nonce" > "\$race_stub_fork_release") ||
    race_stub_fork_failure "release could not be atomically published" "\$race_stub_fork_child"
  race_stub_fork_deadline=\$(( \$(date +%s) + race_stub_fork_ack_seconds ))
  while [ ! -s "\$race_stub_fork_started" ] &&
    [ "\$(date +%s)" -lt "\$race_stub_fork_deadline" ]; do
    sleep 1
  done
  awk -v expected="\$race_stub_fork_nonce" '
    NR == 1 { if (NF != 1 || \$0 != expected) bad = 1; found = 1 }
    NR > 1 { bad = 1 }
    END { exit(bad || !found ? 1 : 0) }
  ' "\$race_stub_fork_started" ||
    race_stub_fork_failure "started marker did not match the release" "\$race_stub_fork_child"
  race_stub_fork_current_start="\$(TZ=UTC LC_ALL=C LANG=C ps -p "\$race_stub_fork_child" -o lstart= 2>/dev/null || true)"
  race_stub_fork_current_parent="\$(TZ=UTC LC_ALL=C LANG=C ps -p "\$race_stub_fork_child" -o ppid= 2>/dev/null | awk 'NF { print \$1; exit }')"
  [ -n "\$race_stub_fork_current_start" ] &&
    [ "\$race_stub_fork_current_start" = "\$race_stub_fork_ack_start" ] &&
    [ "\$race_stub_fork_current_parent" = "\$race_stub_fork_ack_parent" ] ||
    race_stub_fork_failure "child identity changed after release" "\$race_stub_fork_child"
  rm -rf "\$race_stub_fork_release_dir" ||
    race_stub_fork_failure "private release directory could not be removed after handoff" "\$race_stub_fork_child"
}
# RACE_STUB_IGNORE_TERM makes this outlive a TERM the way a real build tool
# with its own signal handling can. The loop is what survives: its sleeps are
# killable, it is not.
[ -n "\${RACE_STUB_FORK_ON_TERM:-}" ] &&
  trap 'race_stub_publish_forked_sleep ${gate_race_fork_seconds}' TERM
# RACE_STUB_FORK_AND_EXIT leaves a replacement behind and then goes away, so
# the replacement is reparented with no tagged ancestor left to walk down from.
[ -n "\${RACE_STUB_FORK_AND_EXIT:-}" ] &&
  trap 'race_stub_publish_forked_sleep ${gate_race_forkexit_seconds}; exit 0' TERM
[ -n "\${RACE_STUB_IGNORE_TERM:-}" ] && [ -z "\${RACE_STUB_FORK_ON_TERM:-}" ] && [ -z "\${RACE_STUB_FORK_AND_EXIT:-}" ] && trap '' TERM
[ -z "\${RACE_STUB_FORK_PUBLISH_ONLY:-}" ] || {
  race_stub_publish_forked_sleep "\${RACE_STUB_FORK_SECONDS:-}"
  exit 0
}
printf 'enter %s %s\n' "\$\$" "\$(date +%s)" >> "$gate_race_log"
if [ -n "\${RACE_STUB_HOLD_FILE:-}" ]; then
  while :; do
    if [ -L "\$RACE_STUB_HOLD_FILE" ]; then
      echo "race stub hold path must be a regular file, not a symlink: \$RACE_STUB_HOLD_FILE" >&2
      exit 64
    fi
    if [ -e "\$RACE_STUB_HOLD_FILE" ]; then
      [ -f "\$RACE_STUB_HOLD_FILE" ] || {
        echo "race stub hold path is not a regular file: \$RACE_STUB_HOLD_FILE" >&2
        exit 64
      }
      break
    fi
    sleep 1 || true
  done
else
  race_stub_deadline=\$(( \$(date +%s) + \${RACE_STUB_SECONDS:-1} ))
  while [ "\$(date +%s)" -lt "\$race_stub_deadline" ]; do sleep 1 || true; done
fi
printf 'exit %s %s\n' "\$\$" "\$(date +%s)" >> "$gate_race_log"
exit 0
STUB
  chmod +x tools/trunk
  git add .
  git commit -qm init
  printf 'changed\n' >> fixture.txt

  race_waiter() {
    # AGENT_QUALITY_GATE_LOCK_HELD is cleared for the same reason as above: an
    # inherited marker would make every assertion here pass vacuously. The
    # grace and poll are shrunk to keep this suite inside its CI job budget:
    # every case below asserts that waiting and grace-respecting happen, never
    # that they take the production number of seconds.
    RACE_STUB_SECONDS="${4:-1}" \
      AGENT_QUALITY_GATE_LOCK=1 \
      AGENT_QUALITY_GATE_LOCK_HELD='' \
      AGENT_QUALITY_GATE_LOCK_DIR="$gate_race_root" \
      AGENT_QUALITY_GATE_LOCK_OWNER_GRACE_SECONDS=1 \
      AGENT_QUALITY_GATE_LOCK_POLL_SECONDS=1 \
      AGENT_QUALITY_GATE_LOCK_RECLAIM_DELAY_SECONDS="$2" \
      AGENT_QUALITY_GATE_LOCK_CLAIM_DELAY_SECONDS="$3" \
      AGENT_QUALITY_GATE_LOCK_TAKEN_DELAY_SECONDS="${5:-0}" \
      "$repo_root/scripts/agent-quality-gate.sh" \
      --base HEAD --run --lock-wait 45 \
      > "$gate_race_out/$1.out" 2>&1
    # Kept, not swallowed: when a run ends without saying anything useful, its
    # status is the difference between "exited" and "was killed", and that is
    # the first thing worth knowing on a runner nobody can attach to.
    printf '%s\n' "$?" > "$gate_race_out/$1.status"
  }

  race_stub_probe_status=0
  race_stub_publish_probe() {
    local label="$1"
    local record_path="$2"
    local ack_path="$3"
    local close_record_fd="${4:-}"
    local skip_ack="${5:-}"
    local ack_seconds="${6:-5}"
    if RACE_STUB_FORK_PUBLISH_ONLY=1 \
      RACE_STUB_FORK_RECORD="$record_path" \
      RACE_STUB_FORK_ACK="$ack_path" \
      RACE_STUB_FORK_ACK_SECONDS="$ack_seconds" \
      RACE_STUB_FORK_TEST_CLOSE_RECORD_FD="$close_record_fd" \
      RACE_STUB_FORK_TEST_SKIP_ACK="$skip_ack" \
      RACE_STUB_FORK_SECONDS=60 \
      "$gate_race_repo/tools/trunk" \
      > "$gate_race_out/${label}.out" 2>&1; then
      race_stub_probe_status=0
    else
      race_stub_probe_status=$?
    fi
  }

  race_case_errors=""
  race_case_add_error() {
    race_case_errors="${race_case_errors}${race_case_errors:+$'\n'}- $*"
  }

  assert_runs_did_not_overlap() {
    local label="$1"
    local overlapping starts
    # Nesting in the shared append-only log, not elapsed time: an `enter` while
    # another run is still between its own enter and exit is an overlap, at any
    # clock resolution. That keeps the fixture command short without weakening
    # the assertion.
    overlapping="$(awk '
      /^enter/ {
        if (depth > 0) { print "nested at " $2 }
        depth++
      }
      /^exit/ { depth-- }
    ' "$gate_race_log")"
    [[ -z "$overlapping" ]] ||
      fail "${label}: two gate runs executed mapped commands at once (${overlapping})"
    # An expected count of 0 means "do not check": where the backstop can fire,
    # stopping a displaced run is as correct as running it, so the number that
    # reach a mapped command is not the invariant — not overlapping is.
    starts="$(awk '/^enter/ { c++ } END { print c + 0 }' "$gate_race_log")"
    [[ "${2:-2}" -eq 0 || "$starts" -eq "${2:-2}" ]] ||
      fail "${label}: expected ${2:-2} run(s) to execute the mapped command, saw ${starts}"
  }

  # The compact probes below cover publisher append/ack failure and inspector
  # refusal. The two full cases later cover the successful handoff.
  race_probe_zombie_pid=424242
  race_probe_zombie_start="Mon Jan  1 00:00:00 2024"
  race_probe_zombie_record="$gate_race_out/publisher-zombie.records"
  printf '%s|%s|1\n' \
    "$race_probe_zombie_pid" "$race_probe_zombie_start" \
    > "$race_probe_zombie_record"
  (
    gate_test_process_start() {
      [[ "$1" == "$race_probe_zombie_pid" ]] || return 1
      printf '%s\n' "$race_probe_zombie_start"
    }
    gate_test_process_parent() {
      [[ "$1" == "$race_probe_zombie_pid" ]] || return 1
      printf '1\n'
    }
    gate_test_process_state() {
      [[ "$1" == "$race_probe_zombie_pid" ]] || return 1
      printf 'Z\n'
    }
    gate_test_signal_with_current_parent() {
      fail "the owned-record inspector tried to signal a zombie fixture"
    }
    if race_drain_inspect_owned_record \
      "zombie publisher" "$race_probe_zombie_record"; then
      race_probe_inspect_status=0
    else
      race_probe_inspect_status=$?
    fi
    [[ "$race_probe_inspect_status" -eq 0 &&
      -z "$race_drain_owned_survivors" ]] ||
      fail "the owned-record inspector treated a zombie fixture as live"
  )

  # Exercise the production orphan-drain census with an actual unreaped child.
  # The bounded Perl supervisor keeps its exited child in Z state until this
  # fixture releases it. The persisted capture is the same PID/start handle a
  # killed gate leaves behind. Old production code waits for the drain bound;
  # the zombie-aware census removes the obligation and executes the next run.
  race_zombie_record="$gate_race_out/production-zombie.identity"
  race_zombie_supervisor_release="$gate_race_out/production-zombie.release"
  [[ ! -e "$race_zombie_record" && ! -L "$race_zombie_record" &&
    ! -e "$race_zombie_supervisor_release" &&
    ! -L "$race_zombie_supervisor_release" ]] ||
    fail "the production zombie probe paths existed before launch"
  /usr/bin/perl -MFcntl=:DEFAULT -e '
    use strict;
    use warnings;
    use POSIX qw(_exit);
    my ($record, $release, $bound) = @ARGV;
    my $child = fork();
    defined $child or exit 64;
    if ($child == 0) {
      _exit(0);
    }
    my $opened = sysopen(my $record_handle, $record,
      O_WRONLY | O_CREAT | O_EXCL, 0600);
    if (!$opened) {
      waitpid($child, 0);
      exit 64;
    }
    my $written = print {$record_handle} "$child\n";
    my $closed = close $record_handle;
    if (!$written || !$closed) {
      waitpid($child, 0);
      exit 64;
    }
    my $deadline = time() + $bound;
    while (!-f $release && time() < $deadline) {
      select undef, undef, undef, 0.1;
    }
    my $released = -f $release;
    waitpid($child, 0);
    exit($released ? 0 : 64);
  ' "$race_zombie_record" "$race_zombie_supervisor_release" 30 &
  race_zombie_supervisor=$!
  gate_test_capture_identity \
    "$race_zombie_supervisor" "$gate_test_signal_shell_pid" ||
    fail "the production zombie supervisor did not keep an exact direct-child identity"
  race_zombie_supervisor_start="$gate_test_captured_start"
  race_zombie_supervisor_parent="$gate_test_captured_parent"
  race_zombie_deadline=$(( $(date +%s) + 15 ))
  while :; do
    race_zombie_child=""
    if [[ ! -L "$race_zombie_record" && -f "$race_zombie_record" &&
      -O "$race_zombie_record" && -r "$race_zombie_record" &&
      -w "$race_zombie_record" ]]; then
      race_zombie_child="$(awk '
        NR == 1 && $0 ~ /^[1-9][0-9]*$/ { value = $0; next }
        { bad = 1 }
        END { if (bad || value == "") exit 1; print value }
      ' "$race_zombie_record" 2>/dev/null || true)"
    fi
    if [[ -n "$race_zombie_child" ]] &&
      gate_test_capture_identity \
        "$race_zombie_child" "$race_zombie_supervisor" &&
      [[ "$(gate_test_process_state "$race_zombie_child")" == Z* ]]; then
      race_zombie_child_start="$gate_test_captured_start"
      break
    fi
    gate_test_process_is_expected \
      "$race_zombie_supervisor" "$race_zombie_supervisor_start" \
      "$race_zombie_supervisor_parent" ||
      fail "the production zombie supervisor exited before publishing a zombie"
    [[ "$(date +%s)" -lt "$race_zombie_deadline" ]] ||
      fail "the production zombie supervisor did not publish a confirmed zombie"
    sleep 0.1
  done
  race_zombie_overlap_violation="$gate_race_out/production-zombie-overlap.violation"
  RACE_STUB_VICTIM_PID="$race_zombie_child" \
    RACE_STUB_VICTIM_LSTART="$race_zombie_child_start" \
    RACE_STUB_VIOLATION_FILE="$race_zombie_overlap_violation" \
    RACE_STUB_SECONDS=0 \
    "$gate_race_repo/tools/trunk" check fixture.txt \
    > "$gate_race_out/production-zombie-overlap.out" 2>&1 ||
    fail "the production zombie overlap probe command failed"
  [[ ! -e "$race_zombie_overlap_violation" ]] ||
    fail "the overlap probe treated a confirmed zombie as executable"
  : > "$gate_race_log"
  rm -rf "$gate_race_root/run.lock" "$gate_race_root/condemned.d"
  rm -f "$gate_race_root"/captured.* "$gate_race_root"/holder.*
  mkdir -p "$gate_race_root/condemned.d"
  printf '%s\n' "$race_zombie_token" \
    > "$gate_race_root/condemned.d/$race_zombie_token"
  printf '%s|%s\n' "$race_zombie_child" "$race_zombie_child_start" \
    > "$gate_race_root/captured.$race_zombie_token"
  set +e
  AGENT_QUALITY_GATE_LOCK=1 \
    AGENT_QUALITY_GATE_LOCK_HELD='' \
    AGENT_QUALITY_GATE_LOCK_DIR="$gate_race_root" \
    AGENT_QUALITY_GATE_LOCK_POLL_SECONDS=1 \
    AGENT_QUALITY_GATE_LOCK_ORPHAN_DRAIN_SECONDS=3 \
    "$repo_root/scripts/agent-quality-gate.sh" \
    --base HEAD --run --lock-wait 20 \
    > "$gate_race_out/production-zombie.out" 2>&1
  race_zombie_gate_status=$?
  set -e
  [[ "$race_zombie_gate_status" -eq 0 ]] ||
    fail "the production drain treated a confirmed zombie as live (exit ${race_zombie_gate_status})"
  gate_test_process_is_expected \
    "$race_zombie_child" "$race_zombie_child_start" \
    "$race_zombie_supervisor" &&
    [[ "$(gate_test_process_state "$race_zombie_child")" == Z* ]] ||
    fail "the production zombie probe was not retained until supervisor cleanup"
  [[ ! -e "$gate_race_root/condemned.d/$race_zombie_token" ]] ||
    fail "the production drain retained an obligation for a confirmed zombie"
  [[ ! -e "$gate_race_root/captured.$race_zombie_token" ]] ||
    fail "the production drain retained a capture for a confirmed zombie"
  [[ -n "$(awk '/^enter/ { print $2; exit }' "$gate_race_log")" ]] ||
    fail "the production drain did not execute after classifying a confirmed zombie"
  race_zombie_release_and_reap_supervisor ||
    fail "the production zombie supervisor could not reap its child"
  rm -rf "$gate_race_root/run.lock" "$gate_race_root/condemned.d"
  rm -f "$gate_race_root"/captured.*

  race_probe_publisher_target="$gate_race_out/publisher-path.target"
  race_probe_publisher_symlink="$gate_race_out/publisher-path.records"
  race_probe_publisher_nonregular="$gate_race_out/publisher-path.directory"
  race_probe_publisher_ack="$gate_race_out/publisher-path.acks"
  printf 'sentinel\n' > "$race_probe_publisher_target"
  ln -s "$race_probe_publisher_target" "$race_probe_publisher_symlink"
  : > "$race_probe_publisher_ack"
  race_stub_publish_probe publisher-path-symlink \
    "$race_probe_publisher_symlink" "$race_probe_publisher_ack"
  [[ "$race_stub_probe_status" -eq 64 &&
    "$(cat "$race_probe_publisher_target")" == "sentinel" &&
    "$(grep -Fc "record path must be an owned readable writable regular file" \
      "$gate_race_out/publisher-path-symlink.out")" -eq 1 &&
    ! -s "$race_probe_publisher_ack" ]] ||
    fail "the fork publisher wrote through a symlink record path"
  mkdir "$race_probe_publisher_nonregular"
  race_stub_publish_probe publisher-path-nonregular \
    "$race_probe_publisher_nonregular" "$race_probe_publisher_ack"
  [[ "$race_stub_probe_status" -eq 64 &&
    "$(grep -Fc "record path must be an owned readable writable regular file" \
      "$gate_race_out/publisher-path-nonregular.out")" -eq 1 &&
    ! -s "$race_probe_publisher_ack" ]] ||
    fail "the fork publisher accepted a non-regular record path"

  for race_probe_kind in append ack; do
    race_probe_record="$gate_race_out/publisher-${race_probe_kind}.records"
    race_probe_ack="$gate_race_out/publisher-${race_probe_kind}.acks"
    : > "$race_probe_record"
    : > "$race_probe_ack"
    race_fork_probe_record="$race_probe_record"
    if [[ "$race_probe_kind" == "append" ]]; then
      race_stub_publish_probe publisher-append \
        "$race_probe_record" "$race_probe_ack" 1 ''
    else
      race_stub_publish_probe publisher-ack \
        "$race_probe_record" "$race_probe_ack" '' 1 1
    fi
    if race_drain_inspect_owned_record \
      "publisher ${race_probe_kind} failure" "$race_probe_record"; then
      race_probe_inspect_status=0
    else
      race_probe_inspect_status=$?
    fi
    race_fork_probe_record=""
    [[ "$race_stub_probe_status" -eq 64 &&
      "$race_probe_inspect_status" -eq 0 && ! -s "$race_probe_ack" ]] ||
      fail "the fork publisher did not contain its ${race_probe_kind} failure"
  done

  race_probe_live_record="$gate_race_out/publisher-live.records"
  race_probe_live_ack="$gate_race_out/publisher-live.acks"
  race_probe_live_observed="$gate_race_out/publisher-live.first-observation"
  : > "$race_probe_live_record"
  : > "$race_probe_live_ack"
  rm -f "$race_probe_live_observed"
  race_fork_probe_record="$race_probe_live_record"
  race_stub_publish_probe publisher-live \
    "$race_probe_live_record" "$race_probe_live_ack"
  [[ "$race_stub_probe_status" -eq 0 ]] ||
    fail "the live three-field publisher fixture did not start"
  if race_bound_launch_command "delayed three-field publisher" 15 \
    /bin/sh -c \
      'marker=$1; output_file=$2; shift 2; deadline=$(( $(date +%s) + 10 )); while [ ! -e "$marker" ] && [ "$(date +%s)" -lt "$deadline" ]; do sleep 1; done; [ -f "$marker" ] || exit 64; exec "$@" > "$output_file" 2>&1' \
      delayed-three-field "$race_probe_live_observed" \
      "$gate_race_out/publisher-live-delayed.out" env \
      RACE_STUB_FORK_PUBLISH_ONLY=1 \
      RACE_STUB_FORK_RECORD="$race_probe_live_record" \
      RACE_STUB_FORK_ACK="$race_probe_live_ack" \
      RACE_STUB_FORK_ACK_SECONDS=5 \
      RACE_STUB_FORK_SECONDS=60 \
      "$gate_race_repo/tools/trunk"; then
    race_probe_delayed_wrapper="$race_bound_pid"
    race_probe_delayed_wrapper_start="$race_bound_start"
    race_probe_delayed_wrapper_parent="$race_bound_parent"
  else
    fail "the delayed three-field publisher wrapper could not be registered"
  fi
  race_drain_pair_observation_file="$race_probe_live_observed"
  race_drain_pair_require_change=1
  race_drain_wait_for_stable_identity_pair \
    "live three-field publisher" "$race_probe_live_record" "$race_probe_live_ack" ||
    fail "$race_drain_owned_record_error"
  if race_drain_wait_for_direct_wrapper \
    "delayed three-field publisher" "$race_probe_delayed_wrapper" \
    "$race_probe_delayed_wrapper_start" "$race_probe_delayed_wrapper_parent" 15; then
    race_probe_delayed_status=0
  else
    race_probe_delayed_status=$?
  fi
  [[ "$race_probe_delayed_status" -eq 0 ]] ||
    fail "the delayed three-field publisher exited ${race_probe_delayed_status}"
  race_bound_prune_completed
  [[ "$(awk 'END { print NR + 0 }' "${race_probe_live_record}.snapshot")" -eq 2 ]] ||
    fail "the stable identity pair omitted the delayed publisher record"
  if race_drain_inspect_owned_record \
    "live three-field publisher" "$race_probe_live_record"; then
    race_probe_inspect_status=0
  else
    race_probe_inspect_status=$?
  fi
  [[ "$race_probe_inspect_status" -eq 1 ]] ||
    fail "the owned-record inspector did not find and remove a live three-field identity"
  if race_drain_inspect_owned_record \
    "live three-field publisher" "$race_probe_live_record"; then
    race_probe_inspect_status=0
  else
    race_probe_inspect_status=$?
  fi
  [[ "$race_probe_inspect_status" -eq 0 ]] ||
    fail "the owned-record inspector did not prove the three-field identity absent after cleanup"
  race_fork_probe_record=""

  if race_bound_launch_command "fork-record unit bystander" 30 /bin/sleep 60; then
    race_fork_unit_bystander="$race_bound_pid"
    race_fork_unit_bystander_start="$race_bound_start"
    race_fork_unit_bystander_parent="$race_bound_parent"
  else
    race_fork_unit_bystander=""
    fail "the fork-record unit fixtures could not bind their direct bystander"
  fi
  race_probe_malformed_record="$gate_race_out/publisher-malformed.records"
  {
    printf '%s|%s\n' \
      "$race_fork_unit_bystander" "$race_fork_unit_bystander_start"
    printf 'malformed|identity|record\n'
    printf '0|Mon Jan  1 00:00:00 1970\n'
    printf '12345678901|Mon Jan  1 00:00:00 1970\n'
  } > "$race_probe_malformed_record"
  if race_drain_inspect_owned_record \
    "malformed publisher record" "$race_probe_malformed_record"; then
    race_probe_inspect_status=0
  else
    race_probe_inspect_status=$?
  fi
  [[ "$race_probe_inspect_status" -eq 124 ]] ||
    fail "the owned-record inspector accepted a malformed full snapshot"
  gate_test_process_is_expected \
    "$race_fork_unit_bystander" "$race_fork_unit_bystander_start" \
    "$race_fork_unit_bystander_parent" ||
    fail "a malformed later record authorized signalling an earlier valid identity"

  race_probe_reuse_record="$gate_race_out/publisher-reused.records"
  printf '%s|Mon Jan  1 00:00:00 1970\n' \
    "$race_fork_unit_bystander" > "$race_probe_reuse_record"
  if race_drain_inspect_owned_record \
    "reused publisher identity" "$race_probe_reuse_record"; then
    race_probe_inspect_status=0
  else
    race_probe_inspect_status=$?
  fi
  [[ "$race_probe_inspect_status" -eq 0 ]] ||
    fail "the owned-record inspector treated a reused PID as the recorded identity"
  gate_test_process_is_expected \
    "$race_fork_unit_bystander" "$race_fork_unit_bystander_start" \
    "$race_fork_unit_bystander_parent" ||
    fail "the owned-record inspector signalled a reused PID identity"

  race_probe_reader_target="$gate_race_out/publisher-reader.target"
  race_probe_reader_symlink="$gate_race_out/publisher-reader.records"
  race_probe_reader_nonregular="$gate_race_out/publisher-reader.directory"
  printf '%s|%s\n' \
    "$race_fork_unit_bystander" "$race_fork_unit_bystander_start" \
    > "$race_probe_reader_target"
  ln -s "$race_probe_reader_target" "$race_probe_reader_symlink"
  mkdir "$race_probe_reader_nonregular"
  for race_probe_reader_path in \
    "$race_probe_reader_symlink" "$race_probe_reader_nonregular"; do
    if race_drain_inspect_owned_record \
      "unsafe publisher record" "$race_probe_reader_path"; then
      race_probe_inspect_status=0
    else
      race_probe_inspect_status=$?
    fi
    [[ "$race_probe_inspect_status" -eq 124 ]] ||
      fail "the owned-record inspector accepted a symlink or non-regular record"
    gate_test_process_is_expected \
      "$race_fork_unit_bystander" "$race_fork_unit_bystander_start" \
      "$race_fork_unit_bystander_parent" ||
      fail "the owned-record inspector signalled through an unsafe record"
  done

  race_drain_kill_and_reap_direct_wrapper \
    "fork-record unit bystander" "$race_fork_unit_bystander" \
    "$race_fork_unit_bystander_start" "$race_fork_unit_bystander_parent" ||
    fail "the fork-record unit fixtures could not clean their direct bystander"
  race_fork_unit_bystander=""
  race_fork_unit_bystander_start=""
  race_fork_unit_bystander_parent=""

  # One stale lock, two waiters. The late waiter forms its verdict first, then
  # stalls past the point where the early one has already taken the lock over,
  # so its reclaim decision is obsolete when it finally acts on it.
  race_dead_pid="$(fresh_dead_pid)" ||
    fail "could not obtain a reaped PID that reads as dead for the two-waiter case"
  mkdir -p "$gate_race_root/run.lock"
  {
    printf 'pid=%s\n' "$race_dead_pid"
    printf 'host=%s\n' "$(uname -n)"
    printf 'started_at=%s\n' "$(date +%s)"
    printf 'worktree=%s\n' "$gate_race_repo"
    printf 'token=fixture-holder-1-1\n'
  } > "$gate_race_root/run.lock/owner"
  : > "$gate_race_log"
  race_waiter late 4 0 4 &
  race_late=$!
  sleep 2
  race_waiter early 0 0 4 &
  race_early=$!
  wait "$race_late" 2>/dev/null || true
  wait "$race_early" 2>/dev/null || true
  assert_runs_did_not_overlap "stale lock, two waiters"
  race_reclaims="$(
    cat "$gate_race_out/early.out" "$gate_race_out/late.out" |
      awk '/reclaiming it/ { c++ } END { print c + 0 }'
  )"
  [[ "$race_reclaims" -eq 1 ]] ||
    fail "expected exactly one run to reclaim the stale lock, got ${race_reclaims}"

  # A creator descheduled between `mkdir` and recording ownership. The waiter
  # reclaims the ownerless lock legitimately; the creator must discover on
  # resume that the lock is no longer its own instead of running beside it.
  rm -rf "$gate_race_root/run.lock"
  : > "$gate_race_log"
  race_waiter stalled 0 5 4 &
  race_stalled=$!
  sleep 1
  race_waiter reclaimer 0 0 4 &
  race_reclaimer=$!
  wait "$race_stalled" 2>/dev/null || true
  wait "$race_reclaimer" 2>/dev/null || true
  assert_runs_did_not_overlap "stalled creator"
  grep -q "recorded ownership of .* first; queueing behind it" \
    "$gate_race_out/stalled.out" ||
    fail "a creator whose lock was reclaimed mid-claim must queue, not run"
  [[ ! -d "$gate_race_root/run.lock" ]] ||
    fail "both race runs finished; the lock must not be left behind"

  # `kill -0` cannot tell a holder from whatever inherited its PID after it
  # died. A recycled PID reads as alive, so without a start-time identity every
  # later run waits on an unrelated process until --lock-wait expires — the
  # opposite of unattended recovery. Both directions matter: reclaim a record
  # whose PID has been reused, and never evict a holder that is genuinely it.
  # Recorded exactly as the gate records it. `ps` renders lstart in the
  # caller's TZ and locale, so the pin is part of the identity, not decoration.
  race_lock_start="$(TZ=UTC LC_ALL=C ps -o lstart= -p $$ 2>/dev/null | head -n1)"
  if [[ -n "$race_lock_start" ]]; then
    rm -rf "$gate_race_root/run.lock"
    : > "$gate_race_log"
    mkdir -p "$gate_race_root/run.lock"
    {
      # This shell is alive, so `kill -0` succeeds — but it is not the process
      # the record describes, and the recorded start time says so.
      printf 'pid=%s\n' "$$"
      printf 'host=%s\n' "$(uname -n)"
      printf 'started_at=%s\n' "$(date +%s)"
      printf 'start_utc=%s\n' "Thu Jan  1 00:00:00 1970"
      printf 'worktree=%s\n' "$gate_race_repo"
      printf 'token=recycled-pid-1-1\n'
    } > "$gate_race_root/run.lock/owner"
    race_waiter recycled 0 0
    grep -q "pid $$ now belongs to a different process" \
      "$gate_race_out/recycled.out" ||
      fail "a reused PID must read as stale, not as the original holder"
    [[ ! -d "$gate_race_root/run.lock" ]] ||
      fail "the run that reclaimed a reused-PID lock must release it"

    # The control: same live PID, the start time this process really has — and
    # a waiter running in a different timezone and locale from the one that
    # recorded it. `ps` renders lstart in the caller's environment, so an
    # unpinned comparison reads one live process as two identities and evicts
    # a holder mid-run. Each waiter here must sit and wait instead.
    for race_tz in "UTC:C" "America/New_York:C" "Asia/Tokyo:de_DE.UTF-8"; do
      mkdir -p "$gate_race_root/run.lock"
      {
        printf 'pid=%s\n' "$$"
        printf 'host=%s\n' "$(uname -n)"
        printf 'started_at=%s\n' "$(date +%s)"
        printf 'start_utc=%s\n' "$race_lock_start"
        printf 'worktree=%s\n' "$gate_race_repo"
        printf 'token=real-holder-1-1\n'
      } > "$gate_race_root/run.lock/owner"
      TZ="${race_tz%%:*}" \
        LC_ALL="${race_tz##*:}" \
        AGENT_QUALITY_GATE_LOCK=1 \
        AGENT_QUALITY_GATE_LOCK_HELD='' \
        AGENT_QUALITY_GATE_LOCK_DIR="$gate_race_root" \
        AGENT_QUALITY_GATE_LOCK_POLL_SECONDS=1 \
        "$repo_root/scripts/agent-quality-gate.sh" \
        --base HEAD --run --lock-wait 2 \
        > "$gate_race_out/genuine.out" 2>&1 || true
      grep -q "timed out after" "$gate_race_out/genuine.out" ||
        fail "a holder whose recorded start time still matches must be waited for (${race_tz})"
      grep -q "reclaiming it" "$gate_race_out/genuine.out" &&
        fail "a live holder must never be reclaimed over a timezone or locale difference (${race_tz})"
      [[ -d "$gate_race_root/run.lock" ]] ||
        fail "a waiter must leave a genuine holder's lock in place (${race_tz})"
      rm -rf "$gate_race_root/run.lock"
    done

    # A record from a gate that predates the pinned field carries no readable
    # start time. Liveness must fall back to PID existence and WAIT, never
    # decide a live holder is stale because it cannot read its identity.
    mkdir -p "$gate_race_root/run.lock"
    {
      printf 'pid=%s\n' "$$"
      printf 'host=%s\n' "$(uname -n)"
      printf 'started_at=%s\n' "$(date +%s)"
      printf 'start=%s\n' "$race_lock_start"
      printf 'worktree=%s\n' "$gate_race_repo"
      printf 'token=legacy-record-1-1\n'
    } > "$gate_race_root/run.lock/owner"
    AGENT_QUALITY_GATE_LOCK=1 \
      AGENT_QUALITY_GATE_LOCK_HELD='' \
      AGENT_QUALITY_GATE_LOCK_DIR="$gate_race_root" \
      AGENT_QUALITY_GATE_LOCK_POLL_SECONDS=1 \
      "$repo_root/scripts/agent-quality-gate.sh" \
      --base HEAD --run --lock-wait 2 \
      > "$gate_race_out/legacy.out" 2>&1 || true
    grep -q "reclaiming it" "$gate_race_out/legacy.out" &&
      fail "an unreadable start time must fail safe to waiting, not to reclaiming"
    [[ -d "$gate_race_root/run.lock" ]] ||
      fail "a waiter must leave a pre-pinning holder's lock in place"
    rm -rf "$gate_race_root/run.lock"

    # The budget is a promise: a wait shorter than the poll interval must not
    # sleep past it and then report the overshoot as the elapsed time. Capping
    # the nap is only half of keeping that promise — the elapsed time has to be
    # measured finer than the budget too, or a wait that begins late in a
    # second reads a second longer than it was and reports a 1s budget as 2s.
    # That is the arithmetic behind both CI sightings in GitHub issue #1919.
    mkdir -p "$gate_race_root/run.lock"
    {
      printf 'pid=%s\n' "$$"
      printf 'host=%s\n' "$(uname -n)"
      printf 'started_at=%s\n' "$(date +%s)"
      printf 'start_utc=%s\n' "$race_lock_start"
      printf 'worktree=%s\n' "$gate_race_repo"
      printf 'token=real-holder-1-1\n'
    } > "$gate_race_root/run.lock/owner"
    race_wait_started="$(date +%s)"
    AGENT_QUALITY_GATE_LOCK=1 \
      AGENT_QUALITY_GATE_LOCK_HELD='' \
      AGENT_QUALITY_GATE_LOCK_DIR="$gate_race_root" \
      AGENT_QUALITY_GATE_LOCK_POLL_SECONDS=5 \
      "$repo_root/scripts/agent-quality-gate.sh" \
      --base HEAD --run --lock-wait 1 \
      > "$gate_race_out/shortwait.out" 2>&1 || true
    grep -q "timed out after 1s" "$gate_race_out/shortwait.out" ||
      fail "a 1s budget under a 5s poll must report the budget it actually kept"
    [[ $(($(date +%s) - race_wait_started)) -lt 5 ]] ||
      fail "a 1s budget under a 5s poll must not sleep a full interval"
    rm -rf "$gate_race_root/run.lock"
  fi

  # A run killed part-way through publishing its record leaves a file that
  # parses as no holder at all. It must be reclaimable: the claim links a
  # finished record into place and cannot overwrite whatever is sitting there,
  # so a leftover the reclaim path skips would wedge every later run until
  # --lock-wait expired. The token is written last, which is what makes an
  # unfinished record recognisable — including one whose PID field is itself a
  # truncated value that happens to name a live process.
  for race_leftover in "" "pid=99" "pid=$$"; do
    rm -rf "$gate_race_root/run.lock"
    : > "$gate_race_log"
    mkdir -p "$gate_race_root/run.lock"
    printf '%s' "$race_leftover" > "$gate_race_root/run.lock/owner"
    race_waiter leftover 0 0
    grep -q "never recorded a complete identity" "$gate_race_out/leftover.out" ||
      fail "an unfinished owner record ([${race_leftover}]) must read as no holder"
    [[ ! -d "$gate_race_root/run.lock" ]] ||
      fail "the run that reclaimed an unfinished record ([${race_leftover}]) must release it"
  done

  # A reclaim takes the dead record away by rename before writing its own. The
  # temp path is registered with the exit trap before that rename creates it,
  # so a signal landing anywhere in the window cannot orphan it — and cleanup
  # puts the record back rather than deleting it, because a record taken but
  # not yet judged may still name a live holder.
  taken_record_present() {
    [[ -n "$(find "$gate_race_root/run.lock" -name 'owner.reclaiming.*' 2>/dev/null)" ]]
  }

  await_taken_record() {
    local i=0
    while [[ $i -lt 60 ]]; do
      taken_record_present && return 0
      sleep 0.5
      i=$((i + 1))
    done
    return 1
  }

  interrupt_reclaim() {
    local tag="$1"
    local reclaim_delay="$2"
    local taken_delay="$3"
    local pid pid_start pid_parent signal_status reclaim_exit dead_pid
    dead_pid="$(fresh_dead_pid)" ||
      fail "${tag}: could not obtain a reaped PID that reads as dead"
    rm -rf "$gate_race_root/run.lock"
    mkdir -p "$gate_race_root/run.lock"
    {
      printf 'pid=%s\n' "$dead_pid"
      printf 'host=%s\n' "$(uname -n)"
      printf 'started_at=%s\n' "$(date +%s)"
      printf 'worktree=%s\n' "$gate_race_repo"
      printf 'token=fixture-holder-1-1\n'
    } > "$gate_race_root/run.lock/owner"
    AGENT_QUALITY_GATE_LOCK=1 \
      AGENT_QUALITY_GATE_LOCK_HELD='' \
      AGENT_QUALITY_GATE_LOCK_DIR="$gate_race_root" \
      AGENT_QUALITY_GATE_LOCK_POLL_SECONDS=1 \
      AGENT_QUALITY_GATE_LOCK_RECLAIM_DELAY_SECONDS="$reclaim_delay" \
      AGENT_QUALITY_GATE_LOCK_TAKEN_DELAY_SECONDS="$taken_delay" \
      "$repo_root/scripts/agent-quality-gate.sh" \
      --base HEAD --run --lock-wait 60 \
      > "$gate_race_out/$tag.out" 2>&1 &
    pid=$!
    gate_test_capture_identity "$pid" "$gate_test_signal_shell_pid" ||
      fail "${tag}: could not bind the reclaim wrapper to its direct-child identity"
    pid_start="$gate_test_captured_start"
    pid_parent="$gate_test_captured_parent"
    if [[ "$taken_delay" != "0" ]]; then
      # Kill it precisely while it holds the record, or the assertions below
      # would pass without the window ever being entered.
      await_taken_record ||
        fail "${tag}: the reclaim never reached the window this test interrupts"
    else
      sleep 2
      ! taken_record_present ||
        fail "${tag}: expected the record to be untouched at this point"
    fi
    if gate_test_signal_expected \
      "${tag} reclaim wrapper" TERM "$pid" "$pid_start" "$pid_parent"; then
      :
    else
      signal_status=$?
      fail "${tag}: refused or lost its recorded reclaim wrapper before TERM (status ${signal_status})"
    fi
    if race_drain_wait_for_direct_wrapper \
      "${tag} reclaim" "$pid" "$pid_start" "$pid_parent"; then
      reclaim_exit=0
    else
      reclaim_exit=$?
    fi
    [[ "$reclaim_exit" != "124" ]] ||
      fail "${tag}: reclaim wrapper exceeded its bounded reap"
    [[ "$reclaim_exit" != "0" ]] ||
      fail "${tag}: reclaim wrapper ignored the requested TERM"
    ! taken_record_present ||
      fail "${tag}: an interrupted reclaim must not orphan its temp record"
    [[ -r "$gate_race_root/run.lock/owner" ]] ||
      fail "${tag}: an interrupted reclaim must leave the owner record in place"
    [[ "$(sed -n 's/^token=//p' "$gate_race_root/run.lock/owner" | head -n1)" == "fixture-holder-1-1" ]] ||
      fail "${tag}: the restored record must be the one the reclaim took"
  }

  # Interrupted before the rename: nothing was created, and the path already
  # registered with the trap must not confuse cleanup.
  interrupt_reclaim interrupted-before 5 0
  # Interrupted while holding the record it took: cleanup restores it.
  interrupt_reclaim interrupted-holding 0 5

  # The lock those interrupted reclaims left behind is still reclaimable.
  race_waiter recovered 0 0
  grep -q "reclaiming it" "$gate_race_out/recovered.out" ||
    fail "a lock left by an interrupted reclaim must still be reclaimable"
  [[ ! -d "$gate_race_root/run.lock" ]] ||
    fail "the recovering run must release the lock it acquired"

  # A reclaim killed between taking a record and judging it parks that record
  # under owner.reclaiming.*, where nothing looks for it. When the record it
  # took belongs to a LIVE holder — its verdict was formed before another run
  # took the lock over — the lock reads as ownerless and the next waiter starts
  # beside a running holder. A remnant naming a live process is the owner
  # record, misfiled, and has to be read as one.
  if [[ -n "$race_lock_start" ]]; then
    rm -rf "$gate_race_root/run.lock"
    : > "$gate_race_log"
    mkdir -p "$gate_race_root/run.lock"
    {
      printf 'pid=%s\n' "$$"
      printf 'host=%s\n' "$(uname -n)"
      printf 'started_at=%s\n' "$(date +%s)"
      printf 'start_utc=%s\n' "$race_lock_start"
      printf 'worktree=%s\n' "$gate_race_repo"
      printf 'token=live-holder-record-1-1\n'
    } > "$gate_race_root/run.lock/owner.reclaiming.99999"
    # A short budget on purpose: recovering the remnant means finding a LIVE
    # holder, so this run is supposed to wait and give up, not acquire.
    AGENT_QUALITY_GATE_LOCK=1 \
      AGENT_QUALITY_GATE_LOCK_HELD='' \
      AGENT_QUALITY_GATE_LOCK_DIR="$gate_race_root" \
      AGENT_QUALITY_GATE_LOCK_OWNER_GRACE_SECONDS=1 \
      AGENT_QUALITY_GATE_LOCK_POLL_SECONDS=1 \
      "$repo_root/scripts/agent-quality-gate.sh" \
      --base HEAD --run --lock-wait 2 \
      > "$gate_race_out/hidden.out" 2>&1 || true
    grep -q "Recovered the record of live holder pid $$" \
      "$gate_race_out/hidden.out" ||
      fail "a remnant naming a live holder must be recovered, not ignored"
    grep -q "reclaiming it" "$gate_race_out/hidden.out" &&
      fail "a lock whose holder is only visible in a remnant must not be reclaimed"
    [[ "$(sed -n 's/^token=//p' "$gate_race_root/run.lock/owner" | head -n1)" == "live-holder-record-1-1" ]] ||
      fail "the recovered remnant must become the owner record"
    [[ -z "$(find "$gate_race_root/run.lock" -name 'owner.reclaiming.*' 2>/dev/null)" ]] ||
      fail "a recovered remnant must not be left behind to be read twice"
    rm -rf "$gate_race_root/run.lock"

    # The converse: a remnant naming a process that is gone is spent, and must
    # not keep a free lock looking occupied.
    race_dead_pid="$(fresh_dead_pid)" ||
      fail "could not obtain a reaped PID that reads as dead for the spent-remnant case"
    mkdir -p "$gate_race_root/run.lock"
    {
      printf 'pid=%s\n' "$race_dead_pid"
      printf 'host=%s\n' "$(uname -n)"
      printf 'started_at=%s\n' "$(date +%s)"
      printf 'worktree=%s\n' "$gate_race_repo"
      printf 'token=dead-holder-record-1-1\n'
    } > "$gate_race_root/run.lock/owner.reclaiming.99998"
    race_waiter spent 0 0
    grep -q "Recovered the record of live holder" "$gate_race_out/spent.out" &&
      fail "a remnant naming a dead process must not be resurrected"
    [[ ! -d "$gate_race_root/run.lock" ]] ||
      fail "a lock left holding only a spent remnant must be reclaimed and released"
  fi

  # A verdict is only ever evidence, never authority. A creator stalls past the
  # grace, two waiters both conclude the lock is ownerless, and by the time they
  # act the creator has published: one of them takes that live record away to
  # inspect it, and the other finds the canonical path empty. Without settling
  # the remnants immediately before publishing, the second waiter claims a lock
  # whose holder is merely in flight, and three runs execute at once.
  rm -rf "$gate_race_root/run.lock"
  : > "$gate_race_log"
  race_waiter creator 0 5 8 0 &
  race_creator=$!
  sleep 1
  race_waiter takerA 6 0 3 4 &
  race_taker_a=$!
  race_waiter takerB 7 0 3 0 &
  race_taker_b=$!
  wait "$race_creator" 2>/dev/null || true
  wait "$race_taker_a" 2>/dev/null || true
  wait "$race_taker_b" 2>/dev/null || true
  assert_runs_did_not_overlap "cached ownerless verdict" 0
  # Every one of the three must have either executed or said why it did not.
  # The invariant is that none disappears silently — not that a particular
  # number of them run, because a displaced run stopping and a queued run
  # timing out are both correct outcomes, and which ones occur depends on how
  # the machine schedules three gates. Checked per run, and reporting the tail
  # of whichever went quiet, so a failure on a runner nobody can attach to is
  # still diagnosable.
  race_unaccounted=""
  for race_tag in creator takerA takerB; do
    grep -q "All mapped commands passed" "$gate_race_out/$race_tag.out" && continue
    grep -q "no longer holds the gate run lock" "$gate_race_out/$race_tag.out" && continue
    grep -q "timed out after .* waiting for the gate run lock" "$gate_race_out/$race_tag.out" && continue
    # Status first — a shell killed by a signal loses whatever stdout was still
    # buffered, so its file can end mid-story and the number is what says so.
    race_unaccounted="${race_unaccounted}
--- ${race_tag} exited $(cat "$gate_race_out/$race_tag.status" 2>/dev/null || echo unknown), full output:
$(sed 's/^/      /' "$gate_race_out/$race_tag.out")"
  done
  [[ -z "$race_unaccounted" ]] ||
    fail "cached ownerless verdict: run(s) ended without executing or saying why:${race_unaccounted}"
  rm -rf "$gate_race_root/run.lock"

  # The backstop. Everything above narrows the interleavings; this one makes a
  # displacement that slips through detectable rather than fatal. A run whose
  # record is replaced between taking the lock and reaching its first mapped
  # command must stop, and must not delete the record that replaced it.
  : > "$gate_race_log"
  race_test_mode_ready="$gate_race_sync/non-test.ready"
  race_test_mode_release="$gate_race_sync/non-test.release"
  rm -f "$race_test_mode_ready" "$race_test_mode_release"
  if NODE_ENV='' \
    RACE_STUB_SECONDS=1 \
    AGENT_QUALITY_GATE_LOCK=1 \
    AGENT_QUALITY_GATE_LOCK_HELD='' \
    AGENT_QUALITY_GATE_LOCK_DIR="$gate_race_root" \
    AGENT_QUALITY_GATE_LOCK_POLL_SECONDS=1 \
    AGENT_QUALITY_GATE_LOCK_TEST_READY_FILE="$race_test_mode_ready" \
    AGENT_QUALITY_GATE_LOCK_TEST_RELEASE_FILE="$race_test_mode_release" \
    "$repo_root/scripts/agent-quality-gate.sh" \
    --base HEAD --run --lock-wait 30 \
    > "$gate_race_out/non-test-sync.out" 2>&1; then
    race_test_mode_exit=0
  else
    race_test_mode_exit=$?
  fi
  [[ "$race_test_mode_exit" == "2" ]] ||
    fail "test synchronization outside NODE_ENV=test must exit 2, got ${race_test_mode_exit}"
  grep -Fx "error: gate lock test synchronization is allowed only with NODE_ENV=test." \
    "$gate_race_out/non-test-sync.out" ||
    fail "test synchronization outside NODE_ENV=test must fail closed"
  [[ ! -e "$race_test_mode_ready" && ! -L "$race_test_mode_ready" && ! -e "$race_test_mode_release" && ! -L "$race_test_mode_release" ]] ||
    fail "test synchronization outside NODE_ENV=test must not publish a barrier file"
  [[ ! -s "$gate_race_log" ]] ||
    fail "test synchronization outside NODE_ENV=test must not enter a mapped command"

  race_displaced_ready="$gate_race_sync/displaced.ready"
  race_displaced_release="$gate_race_sync/displaced.release"
  race_bound_launch_command "displaced-holder gate" 45 /bin/sh -c \
    'output_file="$1"; shift; exec "$@" > "$output_file" 2>&1' \
    launch-bound-command "$gate_race_out/displaced.out" env \
    RACE_STUB_SECONDS=1 \
    NODE_ENV=test \
    AGENT_QUALITY_GATE_LOCK=1 \
    AGENT_QUALITY_GATE_LOCK_HELD='' \
    AGENT_QUALITY_GATE_LOCK_DIR="$gate_race_root" \
    AGENT_QUALITY_GATE_LOCK_POLL_SECONDS=1 \
    AGENT_QUALITY_GATE_LOCK_TEST_READY_FILE="$race_displaced_ready" \
    AGENT_QUALITY_GATE_LOCK_TEST_RELEASE_FILE="$race_displaced_release" \
    "$repo_root/scripts/agent-quality-gate.sh" \
    --base HEAD --run --lock-wait 30 ||
    fail "the displaced-holder case could not bind its gate wrapper"
  race_displaced="$race_bound_pid"
  race_displaced_start="$race_bound_start"
  race_displaced_parent="$race_bound_parent"
  race_displaced_deadline=$(( $(date +%s) + 30 ))
  while [[ ! -e "$race_displaced_ready" && ! -L "$race_displaced_ready" && "$(date +%s)" -lt "$race_displaced_deadline" ]]; do
    sleep 1
  done
  [[ -f "$race_displaced_ready" && ! -L "$race_displaced_ready" && -r "$race_displaced_ready" ]] ||
    fail "the displaced-holder case timed out waiting for its regular ready file"
  race_displaced_owner_id="$(sed -n 's/^token=//p' "$gate_race_root/run.lock/owner" | head -n1)"
  [[ -n "$race_displaced_owner_id" ]] ||
    fail "the displaced-holder case published ready without an owner token"
  race_displaced_marker="$gate_race_root/holder.$race_displaced_owner_id"
  [[ -f "$race_displaced_marker" && ! -L "$race_displaced_marker" && -r "$race_displaced_marker" ]] ||
    fail "the displaced-holder case did not create a readable regular marker"
  [[ "$(cat "$race_displaced_marker")" == "$race_displaced_owner_id" ]] ||
    fail "the displaced-holder marker body does not equal the owner token"
  race_displaced_replacement="$gate_race_root/run.lock/owner.replacement.$$"
  {
    printf 'pid=%s\n' "$$"
    printf 'host=%s\n' "$(uname -n)"
    printf 'started_at=%s\n' "$(date +%s)"
    printf 'worktree=%s\n' "$gate_race_repo"
    printf 'token=placeholder-token\n'
  } > "$race_displaced_replacement"
  mv "$race_displaced_replacement" "$gate_race_root/run.lock/owner"
  : > "$race_displaced_release"
  if race_drain_wait_for_direct_wrapper \
    "displaced-holder gate" "$race_displaced" "$race_displaced_start" \
    "$race_displaced_parent" 45; then
    race_displaced_exit=0
  else
    race_displaced_exit=$?
  fi
  race_bound_prune_completed
  race_displaced=""
  race_displaced_start=""
  race_displaced_parent=""
  [[ "$race_displaced_exit" == "2" ]] ||
    fail "a displaced holder must stop with exit 2, got ${race_displaced_exit}"
  grep -Fx "error: this run no longer holds the gate run lock at ${gate_race_root}/run.lock." "$gate_race_out/displaced.out" ||
    fail "a displaced holder must print the exact lock-displacement error"
  [[ ! -s "$gate_race_log" ]] ||
    fail "a displaced holder must stop before executing any mapped command"
  [[ "$(sed -n 's/^token=//p' "$gate_race_root/run.lock/owner" | head -n1)" == "placeholder-token" ]] ||
    fail "a displaced holder must not delete the record that replaced its own"
  rm -rf "$gate_race_root/run.lock"

  # A gate killed mid-command does not take that command with it: mapped
  # commands are backgrounded, so they outlive their shell while the lock they
  # held becomes reclaimable. The next run must not start until those commands
  # are confirmed gone — confirmed by looking for them, because the watchdog
  # that would clean them up can be descheduled by the same pressure that
  # killed the gate, or suspended with the machine. Run twice: once with the
  # watchdog able to help, and once with it SIGSTOPped so it cannot. Measured
  # against the clock, because a killed command never writes its exit line.
  # Third state: the command ignores TERM. Only the wrapper carries the tag, so
  # a drain that signalled the tag and then re-scanned for it would see the
  # wrapper gone, find no token, and call the run drained while the command it
  # was hosting kept going.
  for race_watchdog_state in running suspended term-ignoring; do
  rm -rf "$gate_race_root/run.lock"
  : > "$gate_race_log"
  race_stub_ignore_term=""
  [[ "$race_watchdog_state" != "term-ignoring" ]] || race_stub_ignore_term=1
  RACE_STUB_IGNORE_TERM="$race_stub_ignore_term" \
    RACE_STUB_SECONDS=30 \
    AGENT_QUALITY_GATE_LOCK=1 \
    AGENT_QUALITY_GATE_LOCK_HELD='' \
    AGENT_QUALITY_GATE_LOCK_DIR="$gate_race_root" \
    AGENT_QUALITY_GATE_LOCK_POLL_SECONDS=1 \
    "$repo_root/scripts/agent-quality-gate.sh" \
    --base HEAD --run --lock-wait 60 \
    > "$gate_race_out/orphan-victim.out" 2>&1 &
  race_victim_wrapper=$!
  gate_test_capture_identity "$race_victim_wrapper" "$gate_test_signal_shell_pid" ||
    fail "the orphan case could not bind its gate wrapper to the direct child"
  race_victim_wrapper_start="$gate_test_captured_start"
  race_victim_wrapper_parent="$gate_test_captured_parent"
  race_waited=0
  while [[ -z "$(awk '/^enter/ { print $2; exit }' "$gate_race_log")" && "$race_waited" -lt 120 ]]; do
    sleep 0.5
    race_waited=$((race_waited + 1))
  done
  race_orphan_pid="$(awk '/^enter/ { print $2; exit }' "$gate_race_log")"
  [[ -n "$race_orphan_pid" ]] ||
    fail "the orphan case never saw a mapped command start"
  gate_test_capture_identity "$race_orphan_pid" ||
    fail "the orphan case could not record its command identity"
  race_orphan_start="$gate_test_captured_start"
  # Suspending the watchdog is what "descheduled" means here: nothing is left
  # that would clean up after the gate, so the next run has to do it itself.
  # Kill the gate SHELL — the PID it recorded — not the wrapper around it.
  race_victim_pid="$(sed -n 's/^pid=//p' "$gate_race_root/run.lock/owner" | head -n1)"
  [[ "$race_victim_pid" == "$race_victim_wrapper" ]] ||
    fail "the orphan case owner PID was not its direct wrapper"
  gate_test_process_is_expected \
    "$race_victim_pid" "$race_victim_wrapper_start" "$race_victim_wrapper_parent" ||
    fail "the orphan case lost its exact gate-wrapper identity"
  race_drain_watchdog_identities=""
  if [[ "$race_watchdog_state" == "suspended" ]]; then
    # Anchored to THIS gate by parentage: the watchdog is a child of the gate
    # shell, which is still alive here. A bare "collect_tree" match is every
    # watchdog on the machine — suspending those would disable unrelated
    # runs' timeouts mid-flight.
    race_drain_suspend_direct_watchdogs "orphan watchdog" "$race_victim_pid" ||
      fail "the suspended-watchdog case could not bind and stop A's watchdog"
    [[ "$race_drain_watchdog_count" -gt 0 ]] ||
      fail "the suspended-watchdog case found no watchdog to suspend"
  fi
  race_drain_kill_and_reap_direct_wrapper \
    "orphan gate" "$race_victim_wrapper" \
    "$race_victim_wrapper_start" "$race_victim_wrapper_parent" ||
    fail "the orphan case could not safely kill and reap its gate wrapper"
  gate_test_process_has_live_start "$race_orphan_pid" "$race_orphan_start" ||
    fail "the orphan case needs the command to outlive its gate to mean anything"
  (
    race_watch_deadline=$(($(date +%s) + 300))
    while gate_test_process_has_live_start \
      "$race_orphan_pid" "$race_orphan_start" &&
      [ "$(date +%s)" -lt "$race_watch_deadline" ]; do sleep 0.5; done
    # Recorded only if it really died: writing a time when the bound expired
    # would let the assertion below read a stalled watcher as a confirmed death.
    gate_test_process_has_live_start \
      "$race_orphan_pid" "$race_orphan_start" ||
      date +%s > "$gate_race_out/orphan_died"
  ) &
  race_orphan_watcher=$!
  RACE_STUB_SECONDS=2 \
    AGENT_QUALITY_GATE_LOCK=1 \
    AGENT_QUALITY_GATE_LOCK_HELD='' \
    AGENT_QUALITY_GATE_LOCK_DIR="$gate_race_root" \
    AGENT_QUALITY_GATE_LOCK_OWNER_GRACE_SECONDS=1 \
    AGENT_QUALITY_GATE_LOCK_POLL_SECONDS=1 \
    "$repo_root/scripts/agent-quality-gate.sh" \
    --base HEAD --run --lock-wait 120 \
    > "$gate_race_out/orphan-next.out" 2>&1 || true
  wait "$race_orphan_watcher" 2>/dev/null || true
  race_orphan_died="$(cat "$gate_race_out/orphan_died" 2>/dev/null || echo 0)"
  race_next_started="$(awk '/^enter/ { if (NR > 1) { print $3; exit } }' "$gate_race_log")"
  [[ -n "$race_next_started" ]] ||
    fail "the run after an orphaned command must still execute"
  [[ "$race_orphan_died" -ne 0 ]] ||
    fail "a command whose gate was killed must not keep running"
  [[ "$race_next_started" -ge "$race_orphan_died" ]] ||
    fail "watchdog ${race_watchdog_state}: the next run started $((race_orphan_died - race_next_started))s before the orphaned command died"
  # Nothing stays suspended on the machine afterwards. SIGKILL acts on a
  # stopped process directly, so no unpinned CONT transition is needed.
  race_drain_cleanup_suspended_watchdogs ||
    fail "the orphan case could not safely remove its stopped watchdog"
  race_drain_watchdog_identities=""
  rm -rf "$gate_race_root/run.lock"
  done

  # A chain of crashes. A is killed mid-command with its watchdog suspended, so
  # nothing self-cleans; B reclaims A and publishes, then is killed before it
  # can drain A; C reclaims B. If the obligation to drain A lived only in B's
  # shell variable it died with B, and C runs beside A's survivor. Every run
  # drains the whole outstanding set, so C inherits A's along with B's.
  rm -rf "$gate_race_root/run.lock" "$gate_race_root/condemned.d"
  : > "$gate_race_log"
  RACE_STUB_SECONDS=45 \
    AGENT_QUALITY_GATE_LOCK=1 \
    AGENT_QUALITY_GATE_LOCK_HELD='' \
    AGENT_QUALITY_GATE_LOCK_DIR="$gate_race_root" \
    AGENT_QUALITY_GATE_LOCK_POLL_SECONDS=1 \
    "$repo_root/scripts/agent-quality-gate.sh" \
    --base HEAD --run --lock-wait 60 \
    > "$gate_race_out/chain-a.out" 2>&1 &
  race_chain_a_wrapper=$!
  gate_test_capture_identity "$race_chain_a_wrapper" "$gate_test_signal_shell_pid" ||
    fail "the crash-chain case could not bind A to its direct-child identity"
  race_chain_a_wrapper_start="$gate_test_captured_start"
  race_chain_a_wrapper_parent="$gate_test_captured_parent"
  gate_test_trace_signal identity crash-chain-A NONE "$race_chain_a_wrapper" \
    "$race_chain_a_wrapper_start" "$race_chain_a_wrapper_start" \
    "$race_chain_a_wrapper_parent" "$race_chain_a_wrapper_parent"
  race_waited=0
  while [[ -z "$(awk '/^enter/ { print $2; exit }' "$gate_race_log")" && "$race_waited" -lt 120 ]]; do
    sleep 0.5
    race_waited=$((race_waited + 1))
  done
  race_chain_orphan="$(awk '/^enter/ { print $2; exit }' "$gate_race_log")"
  [[ -n "$race_chain_orphan" ]] ||
    fail "the crash-chain case never saw A start a command"
  gate_test_capture_identity "$race_chain_orphan" ||
    fail "the crash-chain case could not record A's command identity"
  race_chain_orphan_start="$gate_test_captured_start"
  race_chain_a_pid="$(sed -n 's/^pid=//p' "$gate_race_root/run.lock/owner" | head -n1)"
  [[ "$race_chain_a_pid" == "$race_chain_a_wrapper" ]] ||
    fail "the crash-chain case found an A owner PID outside its direct wrapper"
  gate_test_process_is_expected \
    "$race_chain_a_pid" "$race_chain_a_wrapper_start" "$race_chain_a_wrapper_parent" ||
    fail "the crash-chain case lost A's exact gate-wrapper identity"
  # Anchored to A's gate by parentage (A is still alive here) — a bare
  # "collect_tree" match is every watchdog on the machine, including
  # unrelated runs'.
  race_drain_suspend_direct_watchdogs \
    "crash-chain A watchdog" "$race_chain_a_pid" ||
    fail "the crash-chain case could not bind and stop A's watchdog"
  race_drain_kill_and_reap_direct_wrapper \
    "crash-chain A gate" "$race_chain_a_wrapper" \
    "$race_chain_a_wrapper_start" "$race_chain_a_wrapper_parent" ||
    fail "the crash-chain case could not safely kill and reap A"
  ! gate_test_process_has_start "$race_chain_a_pid" "$race_chain_a_wrapper_start" ||
    fail "the crash-chain case found A's exact gate-wrapper identity after its bounded reap"

  # B: reclaims A, publishes, and dies inside the window before draining.
  RACE_STUB_SECONDS=3 \
    AGENT_QUALITY_GATE_LOCK=1 \
    AGENT_QUALITY_GATE_LOCK_HELD='' \
    AGENT_QUALITY_GATE_LOCK_DIR="$gate_race_root" \
    AGENT_QUALITY_GATE_LOCK_OWNER_GRACE_SECONDS=1 \
    AGENT_QUALITY_GATE_LOCK_POLL_SECONDS=1 \
    AGENT_QUALITY_GATE_LOCK_HELD_DELAY_SECONDS=25 \
    "$repo_root/scripts/agent-quality-gate.sh" \
    --base HEAD --run --lock-wait 60 \
    > "$gate_race_out/chain-b.out" 2>&1 &
  race_chain_b_wrapper=$!
  gate_test_capture_identity "$race_chain_b_wrapper" "$gate_test_signal_shell_pid" ||
    fail "the crash-chain case could not bind B to its direct-child identity"
  race_chain_b_wrapper_start="$gate_test_captured_start"
  race_chain_b_wrapper_parent="$gate_test_captured_parent"
  gate_test_trace_signal identity crash-chain-B NONE "$race_chain_b_wrapper" \
    "$race_chain_b_wrapper_start" "$race_chain_b_wrapper_start" \
    "$race_chain_b_wrapper_parent" "$race_chain_b_wrapper_parent"
  race_waited=0
  race_chain_b_pid=""
  while [[ "$race_waited" -lt 180 ]]; do
    race_chain_b_pid="$(sed -n 's/^pid=//p' "$gate_race_root/run.lock/owner" 2>/dev/null | head -n1 || true)"
    [[ "$race_chain_b_pid" == "$race_chain_b_wrapper" ]] && break
    sleep 0.5
    race_waited=$((race_waited + 1))
  done
  [[ "$race_chain_b_pid" == "$race_chain_b_wrapper" ]] ||
    fail "the crash-chain case never saw B publish its record"
  gate_test_process_is_expected \
    "$race_chain_b_pid" "$race_chain_b_wrapper_start" "$race_chain_b_wrapper_parent" ||
    fail "the crash-chain case lost B's exact gate-wrapper identity"
  [[ -n "$(ls -A "$gate_race_root/condemned.d" 2>/dev/null || true)" ]] ||
    fail "B must record what it condemned before taking over, not after"
  race_drain_kill_and_reap_direct_wrapper \
    "crash-chain B gate" "$race_chain_b_wrapper" \
    "$race_chain_b_wrapper_start" "$race_chain_b_wrapper_parent" ||
    fail "the crash-chain case could not safely kill and reap B"
  gate_test_process_has_live_start "$race_chain_orphan" "$race_chain_orphan_start" ||
    fail "the crash-chain case needs A's command alive to mean anything"
  (
    race_watch_deadline=$(($(date +%s) + 300))
    while gate_test_process_has_live_start \
      "$race_chain_orphan" "$race_chain_orphan_start" &&
      [ "$(date +%s)" -lt "$race_watch_deadline" ]; do sleep 0.5; done
    # Recorded only if it really died: writing a time when the bound expired
    # would let the assertion below read a stalled watcher as a confirmed death.
    gate_test_process_has_live_start \
      "$race_chain_orphan" "$race_chain_orphan_start" ||
      date +%s > "$gate_race_out/chain_died"
  ) &
  race_chain_watcher=$!
  RACE_STUB_SECONDS=2 \
    AGENT_QUALITY_GATE_LOCK=1 \
    AGENT_QUALITY_GATE_LOCK_HELD='' \
    AGENT_QUALITY_GATE_LOCK_DIR="$gate_race_root" \
    AGENT_QUALITY_GATE_LOCK_OWNER_GRACE_SECONDS=1 \
    AGENT_QUALITY_GATE_LOCK_POLL_SECONDS=1 \
    "$repo_root/scripts/agent-quality-gate.sh" \
    --base HEAD --run --lock-wait 120 \
    > "$gate_race_out/chain-c.out" 2>&1 || true
  wait "$race_chain_watcher" 2>/dev/null || true
  race_chain_died="$(cat "$gate_race_out/chain_died" 2>/dev/null || echo 0)"
  race_chain_c_started="$(awk '/^enter/ { if (NR > 1) { print $3; exit } }' "$gate_race_log")"
  [[ -n "$race_chain_c_started" ]] ||
    fail "the run inheriting a crash chain must still execute"
  [[ "$race_chain_died" -ne 0 ]] ||
    fail "a command inherited through a crash chain must not keep running"
  [[ "$race_chain_c_started" -ge "$race_chain_died" ]] ||
    fail "the inheriting run started $((race_chain_died - race_chain_c_started))s before the first run's command died"
  [[ -z "$(ls -A "$gate_race_root/condemned.d" 2>/dev/null || true)" ]] ||
    fail "a drained obligation must be cleared once its processes are confirmed gone"
  race_drain_cleanup_suspended_watchdogs ||
    fail "the crash-chain case could not safely remove A's stopped watchdog"
  race_drain_watchdog_identities=""
  rm -rf "$gate_race_root/run.lock"

  # A drain interrupted between its TERM pass and its KILL pass. That first
  # pass kills the tag carrier, so a successor searching only for the tag would
  # find nothing and call the obligation discharged while a TERM-ignoring
  # descendant kept running. The captured tree has to be written down before
  # the first signal for the successor to have anything to inherit.
  rm -rf "$gate_race_root/run.lock" "$gate_race_root/condemned.d"
  rm -f "$gate_race_root"/captured.*
  : > "$gate_race_log"
  race_drain_hold_file="$gate_race_out/interrupted-drain.release"
  race_drain_violation_file="$gate_race_out/interrupted-drain.violation"
  rm -f "$race_drain_hold_file"
  rm -f "$race_drain_violation_file"
  [[ ! -e "$race_drain_hold_file" && ! -L "$race_drain_hold_file" ]] ||
    fail "the interrupted-drain hold path must be absent before A starts"
  [[ ! -e "$race_drain_violation_file" && ! -L "$race_drain_violation_file" ]] ||
    fail "the interrupted-drain violation path must be absent before A starts"
  RACE_STUB_IGNORE_TERM=1 \
    RACE_STUB_HOLD_FILE="$race_drain_hold_file" \
    AGENT_QUALITY_GATE_LOCK=1 \
    AGENT_QUALITY_GATE_LOCK_HELD='' \
    AGENT_QUALITY_GATE_LOCK_DIR="$gate_race_root" \
    AGENT_QUALITY_GATE_LOCK_POLL_SECONDS=1 \
    "$repo_root/scripts/agent-quality-gate.sh" \
    --base HEAD --run --lock-wait 45 \
    > "$gate_race_out/drain-a.out" 2>&1 &
  race_drain_a_wrapper=$!
  gate_test_capture_identity "$race_drain_a_wrapper" "$gate_test_signal_shell_pid" ||
    fail "the interrupted-drain case could not record A's direct wrapper identity"
  race_drain_a_wrapper_start="$gate_test_captured_start"
  race_drain_a_wrapper_parent="$gate_test_captured_parent"
  gate_test_trace_signal identity interrupted-drain-A NONE "$race_drain_a_wrapper" \
    "$race_drain_a_wrapper_start" "$race_drain_a_wrapper_start" \
    "$race_drain_a_wrapper_parent" "$race_drain_a_wrapper_parent"
  race_drain_a_deadline=$(( $(date +%s) + 60 ))
  while [[ -z "$(awk '/^enter/ { print $2; exit }' "$gate_race_log")" && "$(date +%s)" -lt "$race_drain_a_deadline" ]]; do
    sleep 1
  done
  race_drain_orphan="$(awk '/^enter/ { print $2; exit }' "$gate_race_log")"
  [[ -n "$race_drain_orphan" ]] ||
    fail "the interrupted-drain case timed out waiting for A to start its held command"
  gate_test_capture_identity "$race_drain_orphan" ||
    fail "the interrupted-drain case could not record A's held-command identity"
  race_drain_orphan_start="$gate_test_captured_start"
  race_drain_cleanup_active=1
  race_drain_a_pid="$(sed -n 's/^pid=//p' "$gate_race_root/run.lock/owner" | head -n1)"
  [[ "$race_drain_a_pid" =~ ^[0-9]+$ ]] ||
    fail "the interrupted-drain case could not read A's gate PID"
  [[ "$race_drain_a_pid" == "$race_drain_a_wrapper" ]] ||
    fail "the interrupted-drain case found an owner PID that was not A's direct wrapper"
  race_drain_process_is_expected \
    "$race_drain_a_pid" "$race_drain_a_wrapper_start" "$race_drain_a_wrapper_parent" ||
    fail "the interrupted-drain case could not bind A's owner record to its exact wrapper identity"
  # A must crash without its EXIT trap so B inherits a live command to drain.
  # Its own watchdog normally notices that crash and correctly cleans A's
  # command. Suspend only the watchdog anchored to A's still-live gate, with
  # its PID pinned before cleanup can signal it.
  race_drain_suspend_direct_watchdogs \
    "interrupted-drain A watchdog" "$race_drain_a_pid" ||
    fail "the interrupted-drain case could not bind and stop A's watchdog"
  [[ "$race_drain_watchdog_count" -eq 1 ]] ||
    fail "the interrupted-drain case expected exactly one direct-child A watchdog, found ${race_drain_watchdog_count}"
  race_drain_watchdog_deadline=$(( $(date +%s) + 10 ))
  while ! race_drain_process_is_stopped \
    "$race_drain_watchdog_pid" "$race_drain_watchdog_start" "$race_drain_watchdog_parent" && \
    [[ "$(date +%s)" -lt "$race_drain_watchdog_deadline" ]]; do
    sleep 1
  done
  race_drain_process_is_stopped \
    "$race_drain_watchdog_pid" "$race_drain_watchdog_start" "$race_drain_watchdog_parent" ||
    fail "the interrupted-drain case could not confirm A's exact watchdog was stopped"
  race_drain_process_is_expected \
    "$race_drain_a_pid" "$race_drain_a_wrapper_start" "$race_drain_a_wrapper_parent" ||
    fail "the interrupted-drain case lost A's exact owner identity before its crash"
  race_drain_kill_and_reap_direct_wrapper \
    "A gate" "$race_drain_a_wrapper" "$race_drain_a_wrapper_start" \
    "$race_drain_a_wrapper_parent"
  ! gate_test_process_has_start "$race_drain_a_pid" "$race_drain_a_wrapper_start" ||
    fail "the interrupted-drain case found A's exact owner identity after its bounded reap"
  race_drain_a_wrapper=""
  race_drain_a_wrapper_start=""
  race_drain_a_wrapper_parent=""
  race_drain_victim_is_expected ||
    fail "the interrupted-drain case needs its held command alive after A crashes"

  # B reclaims, sends its first TERM pass, and dies before it can escalate.
  [[ ! -e "$race_drain_hold_file" && ! -L "$race_drain_hold_file" ]] ||
    fail "the interrupted-drain hold path appeared before B"
  RACE_STUB_HOLD_FILE="$race_drain_hold_file" \
    AGENT_QUALITY_GATE_LOCK=1 \
    AGENT_QUALITY_GATE_LOCK_HELD='' \
    AGENT_QUALITY_GATE_LOCK_DIR="$gate_race_root" \
    AGENT_QUALITY_GATE_LOCK_OWNER_GRACE_SECONDS=1 \
    AGENT_QUALITY_GATE_LOCK_POLL_SECONDS=1 \
    AGENT_QUALITY_GATE_LOCK_CRASH_AT=after-drain-term \
    "$repo_root/scripts/agent-quality-gate.sh" \
    --base HEAD --run --lock-wait 45 \
    > "$gate_race_out/drain-b.out" 2>&1 &
  race_drain_b_wrapper=$!
  gate_test_capture_identity "$race_drain_b_wrapper" "$gate_test_signal_shell_pid" ||
    fail "the interrupted-drain case could not record B's direct wrapper identity"
  race_drain_b_wrapper_start="$gate_test_captured_start"
  race_drain_b_wrapper_parent="$gate_test_captured_parent"
  gate_test_trace_signal identity interrupted-drain-B NONE "$race_drain_b_wrapper" \
    "$race_drain_b_wrapper_start" "$race_drain_b_wrapper_start" \
    "$race_drain_b_wrapper_parent" "$race_drain_b_wrapper_parent"
  if race_drain_wait_for_direct_wrapper \
    "B gate" "$race_drain_b_wrapper" "$race_drain_b_wrapper_start" \
    "$race_drain_b_wrapper_parent" 60; then
    race_drain_b_exit=0
  else
    race_drain_b_exit=$?
  fi
  case "$race_drain_b_exit" in
    124)
      fail "the interrupted-drain B run exceeded its 60-second bounded wait"
      ;;
    137)
      ;;
    *)
      fail "the interrupted-drain B run did not exit with status 137 at the requested SIGKILL boundary; got ${race_drain_b_exit}"
      ;;
  esac
  race_drain_b_wrapper=""
  race_drain_b_wrapper_start=""
  race_drain_b_wrapper_parent=""
  [[ ! -e "$race_drain_hold_file" && ! -L "$race_drain_hold_file" ]] ||
    fail "the interrupted-drain hold path appeared during B"
  race_captured_file="$(find "$gate_race_root" -name 'captured.*' 2>/dev/null | head -n1)"
  [[ -n "$race_captured_file" ]] ||
    fail "a drain must write down what it captured before it signals anything"
  # Non-empty is the point: the snapshot is only ever appended to, so an
  # interrupted drain cannot leave the successor an empty list. A rewrite
  # would, because a `>` redirection truncates the moment it opens.
  [[ -s "$race_captured_file" ]] ||
    fail "an interrupted drain must not leave an empty captured set behind"
  grep -qE '^[0-9]+\|' "$race_captured_file" ||
    fail "the captured set must name processes, not fragments"
  race_drain_victim_is_expected ||
    fail "the interrupted-drain case needs its TERM-ignoring command alive to mean anything"
  # Keep C's mapped command held too. Its entry is now the proof point: the
  # release file stays absent until C has drained A's command and reached it.
  [[ ! -e "$race_drain_violation_file" && ! -L "$race_drain_violation_file" ]] ||
    fail "the interrupted-drain violation path appeared before C started"
  TZ=America/New_York \
    LC_ALL=C \
    LANG=C \
    RACE_STUB_HOLD_FILE="$race_drain_hold_file" \
    RACE_STUB_VICTIM_PID="$race_drain_orphan" \
    RACE_STUB_VICTIM_LSTART="$race_drain_orphan_start" \
    RACE_STUB_VIOLATION_FILE="$race_drain_violation_file" \
    AGENT_QUALITY_GATE_LOCK=1 \
    AGENT_QUALITY_GATE_LOCK_HELD='' \
    AGENT_QUALITY_GATE_LOCK_DIR="$gate_race_root" \
    AGENT_QUALITY_GATE_LOCK_OWNER_GRACE_SECONDS=1 \
    AGENT_QUALITY_GATE_LOCK_POLL_SECONDS=1 \
    "$repo_root/scripts/agent-quality-gate.sh" \
    --base HEAD --run --lock-wait 90 \
    > "$gate_race_out/drain-c.out" 2>&1 &
  race_drain_c_wrapper=$!
  gate_test_capture_identity "$race_drain_c_wrapper" "$gate_test_signal_shell_pid" ||
    fail "the interrupted-drain case could not record C's direct wrapper identity"
  race_drain_c_wrapper_start="$gate_test_captured_start"
  race_drain_c_wrapper_parent="$gate_test_captured_parent"
  [[ ! -e "$race_drain_hold_file" && ! -L "$race_drain_hold_file" ]] ||
    fail "the interrupted-drain hold path appeared before C reached its drain"
  race_drain_c_deadline=$(( $(date +%s) + 90 ))
  while [[ -z "$(awk '/^enter/ { if (NR > 1) { print $2; exit } }' "$gate_race_log")" && "$(date +%s)" -lt "$race_drain_c_deadline" ]]; do
    sleep 1
  done
  race_drain_c_started="$(awk '/^enter/ { if (NR > 1) { print $2; exit } }' "$gate_race_log")"
  [[ -n "$race_drain_c_started" ]] ||
    fail "the run inheriting an interrupted drain timed out before starting its held command"
  [[ ! -e "$race_drain_violation_file" && ! -L "$race_drain_violation_file" ]] ||
    fail "C entered while A's exact held-command identity was still alive"
  if race_drain_victim_is_expected; then
    fail "C started a mapped command before it killed A's held command"
  fi
  [[ ! -e "$race_drain_hold_file" && ! -L "$race_drain_hold_file" ]] ||
    fail "the interrupted-drain hold path was released before the death proof"
  if ! (set -C && : > "$race_drain_hold_file") 2>/dev/null; then
    fail "the interrupted-drain case could not create its regular release file"
  fi
  if race_drain_wait_for_direct_wrapper \
    "C gate" "$race_drain_c_wrapper" "$race_drain_c_wrapper_start" \
    "$race_drain_c_wrapper_parent" 60; then
    race_drain_c_exit=0
  else
    race_drain_c_exit=$?
  fi
  case "$race_drain_c_exit" in
    0)
      ;;
    124)
      fail "the run inheriting an interrupted drain exceeded its 60-second bounded wait after release"
      ;;
    *)
      fail "the run inheriting an interrupted drain exited ${race_drain_c_exit} after its release"
      ;;
  esac
  race_drain_c_wrapper=""
  race_drain_c_wrapper_start=""
  race_drain_c_wrapper_parent=""
  if ! race_drain_cleanup_suspended_watchdogs; then
    fail "the interrupted-drain case left A's exact stopped watchdog alive"
  fi
  race_drain_watchdog_identities=""
  race_drain_cleanup_active=0
  [[ -z "$(find "$gate_race_root" -name 'captured.*' 2>/dev/null)" ]] ||
    fail "a captured set must be cleared once its processes are confirmed gone"
  rm -rf "$gate_race_root/run.lock"

  # A dead run's record parked in a remnant is not garbage: it names a run
  # whose commands can still be running, and its token is the only handle to
  # them. A is killed mid-command with its watchdog suspended; B takes A's
  # record and dies at the take boundary; C evaluates the remnant. Discarding
  # it before writing the token down loses A's commands entirely.
  rm -rf "$gate_race_root/run.lock" "$gate_race_root/condemned.d"
  rm -f "$gate_race_root"/captured.*
  : > "$gate_race_log"
  RACE_STUB_IGNORE_TERM=1 \
    RACE_STUB_SECONDS=60 \
    AGENT_QUALITY_GATE_LOCK=1 \
    AGENT_QUALITY_GATE_LOCK_HELD='' \
    AGENT_QUALITY_GATE_LOCK_DIR="$gate_race_root" \
    AGENT_QUALITY_GATE_LOCK_POLL_SECONDS=1 \
    "$repo_root/scripts/agent-quality-gate.sh" \
    --base HEAD --run --lock-wait 45 \
    > "$gate_race_out/remnant-a.out" 2>&1 &
  race_remnant_a_wrapper=$!
  gate_test_capture_identity "$race_remnant_a_wrapper" "$gate_test_signal_shell_pid" ||
    fail "the remnant-token case could not bind A to its direct-child identity"
  race_remnant_a_wrapper_start="$gate_test_captured_start"
  race_remnant_a_wrapper_parent="$gate_test_captured_parent"
  race_waited=0
  while [[ -z "$(awk '/^enter/ { print $2; exit }' "$gate_race_log")" && "$race_waited" -lt 120 ]]; do
    sleep 0.5
    race_waited=$((race_waited + 1))
  done
  race_remnant_orphan="$(awk '/^enter/ { print $2; exit }' "$gate_race_log")"
  [[ -n "$race_remnant_orphan" ]] ||
    fail "the remnant-token case never saw a command start"
  gate_test_capture_identity "$race_remnant_orphan" ||
    fail "the remnant-token case could not record A's command identity"
  race_remnant_orphan_start="$gate_test_captured_start"
  race_remnant_a_pid="$(sed -n 's/^pid=//p' "$gate_race_root/run.lock/owner" | head -n1)"
  [[ "$race_remnant_a_pid" == "$race_remnant_a_wrapper" ]] ||
    fail "the remnant-token case found an A owner PID outside its direct wrapper"
  gate_test_process_is_expected \
    "$race_remnant_a_pid" "$race_remnant_a_wrapper_start" "$race_remnant_a_wrapper_parent" ||
    fail "the remnant-token case lost A's exact gate-wrapper identity"
  # Anchored to A's gate by parentage (A is still alive here) — a bare
  # "collect_tree" match is every watchdog on the machine, including
  # unrelated runs'.
  race_drain_suspend_direct_watchdogs \
    "remnant-token A watchdog" "$race_remnant_a_pid" ||
    fail "the remnant-token case could not bind and stop A's watchdog"
  race_drain_kill_and_reap_direct_wrapper \
    "remnant-token A gate" "$race_remnant_a_wrapper" \
    "$race_remnant_a_wrapper_start" "$race_remnant_a_wrapper_parent" ||
    fail "the remnant-token case could not safely kill and reap A"

  # B takes the record and dies holding it.
  RACE_STUB_SECONDS=2 \
    AGENT_QUALITY_GATE_LOCK=1 \
    AGENT_QUALITY_GATE_LOCK_HELD='' \
    AGENT_QUALITY_GATE_LOCK_DIR="$gate_race_root" \
    AGENT_QUALITY_GATE_LOCK_OWNER_GRACE_SECONDS=1 \
    AGENT_QUALITY_GATE_LOCK_POLL_SECONDS=1 \
    AGENT_QUALITY_GATE_LOCK_CRASH_AT=after-take \
    "$repo_root/scripts/agent-quality-gate.sh" \
    --base HEAD --run --lock-wait 45 \
    > "$gate_race_out/remnant-b.out" 2>&1 || true
  [[ -n "$(find "$gate_race_root/run.lock" -name 'owner.reclaiming.*' 2>/dev/null)" ]] ||
    fail "the remnant-token case needs a parked record to mean anything"
  gate_test_process_has_live_start "$race_remnant_orphan" "$race_remnant_orphan_start" ||
    fail "the remnant-token case needs the first run's command alive"
  (
    race_watch_deadline=$(($(date +%s) + 300))
    while gate_test_process_has_live_start \
      "$race_remnant_orphan" "$race_remnant_orphan_start" &&
      [ "$(date +%s)" -lt "$race_watch_deadline" ]; do sleep 0.5; done
    # Recorded only if it really died: writing a time when the bound expired
    # would let the assertion below read a stalled watcher as a confirmed death.
    gate_test_process_has_live_start \
      "$race_remnant_orphan" "$race_remnant_orphan_start" ||
      date +%s > "$gate_race_out/remnant_died"
  ) &
  race_remnant_watcher=$!
  RACE_STUB_SECONDS=2 \
    AGENT_QUALITY_GATE_LOCK=1 \
    AGENT_QUALITY_GATE_LOCK_HELD='' \
    AGENT_QUALITY_GATE_LOCK_DIR="$gate_race_root" \
    AGENT_QUALITY_GATE_LOCK_OWNER_GRACE_SECONDS=1 \
    AGENT_QUALITY_GATE_LOCK_POLL_SECONDS=1 \
    "$repo_root/scripts/agent-quality-gate.sh" \
    --base HEAD --run --lock-wait 90 \
    > "$gate_race_out/remnant-c.out" 2>&1 || true
  wait "$race_remnant_watcher" 2>/dev/null || true
  race_remnant_died="$(cat "$gate_race_out/remnant_died" 2>/dev/null || echo 0)"
  race_remnant_c_started="$(awk '/^enter/ { if (NR > 1) { print $3; exit } }' "$gate_race_log")"
  [[ -n "$race_remnant_c_started" ]] ||
    fail "the run inheriting a discarded remnant must still execute"
  [[ "$race_remnant_died" -ne 0 ]] ||
    fail "a command named only by a discarded remnant must not keep running"
  [[ "$race_remnant_c_started" -ge "$race_remnant_died" ]] ||
    fail "the inheriting run started $((race_remnant_died - race_remnant_c_started))s before that command died"
  race_drain_cleanup_suspended_watchdogs ||
    fail "the remnant-token case could not safely remove A's stopped watchdog"
  race_drain_watchdog_identities=""
  rm -rf "$gate_race_root/run.lock"

  # An identity that cannot be read is not an identity that matches. A capture
  # records an empty start time when the process exits between the tree walk
  # and the identity read, and treating that as "matches anything" would
  # authorise signalling whatever holds the PID now. The bystander below
  # survives TERM and writes down that it was signalled, so the evidence
  # survives either outcome.
  rm -rf "$gate_race_root/run.lock" "$gate_race_root/condemned.d"
  rm -f "$gate_race_root"/captured.*
  race_receipt="$gate_race_out/bystander-receipt"
  : > "$race_receipt"
  bash -c 'trap "printf TERMED >> \"$1\"" TERM; for _ in $(seq 1 60); do sleep 1; done' _ "$race_receipt" &
  race_bystander=$!
  gate_test_capture_identity "$race_bystander" "$gate_test_signal_shell_pid" ||
    fail "the empty-identity case could not bind its bystander to the direct child"
  race_bystander_start="$gate_test_captured_start"
  race_bystander_parent="$gate_test_captured_parent"
  sleep 1
  kill -0 "$race_bystander" 2>/dev/null ||
    fail "the empty-identity case needs its bystander alive"
  race_fake_token_value="fixture-empty-identity-$$-1"
  mkdir -p "$gate_race_root/run.lock"
  mkdir -p "$gate_race_root/condemned.d"
  printf '%s\n' "$race_fake_token_value" \
    > "$gate_race_root/condemned.d/$race_fake_token_value"
  printf '%s|\n' "$race_bystander" > "$gate_race_root/captured.${race_fake_token_value}"
  AGENT_QUALITY_GATE_LOCK=1 \
    AGENT_QUALITY_GATE_LOCK_HELD='' \
    AGENT_QUALITY_GATE_LOCK_DIR="$gate_race_root" \
    AGENT_QUALITY_GATE_LOCK_OWNER_GRACE_SECONDS=1 \
    AGENT_QUALITY_GATE_LOCK_POLL_SECONDS=1 \
    AGENT_QUALITY_GATE_LOCK_ORPHAN_DRAIN_SECONDS=4 \
    "$repo_root/scripts/agent-quality-gate.sh" \
    --base HEAD --run --lock-wait 30 \
    > "$gate_race_out/empty-identity.out" 2>&1 && race_empty_exit=0 || race_empty_exit=$?
  [[ ! -s "$race_receipt" ]] ||
    fail "a process whose recorded identity is empty must never be signalled"
  kill -0 "$race_bystander" 2>/dev/null ||
    fail "a process whose recorded identity is empty must never be killed"
  [[ "$race_empty_exit" == "2" ]] ||
    fail "an unverifiable process must hold the drain and fail closed, got exit ${race_empty_exit}"
  grep -q "could not be identified" "$gate_race_out/empty-identity.out" ||
    fail "failing closed on an unverifiable process must say so"
  race_drain_kill_and_reap_direct_wrapper \
    "empty-identity bystander" "$race_bystander" \
    "$race_bystander_start" "$race_bystander_parent" ||
    fail "the empty-identity case could not safely kill and reap its bystander"
  rm -rf "$gate_race_root/run.lock" "$gate_race_root/condemned.d"
  rm -f "$gate_race_root"/captured.*

  # A command that ignores TERM and forks a fresh child each time it is
  # signalled. Discovery has to keep looking while anything is alive to fork:
  # a single recapture cannot see a child spawned after it ran, and the KILL
  # pass then takes the captured parent while the newest child walks away.
  rm -rf "$gate_race_root/run.lock" "$gate_race_root/condemned.d"
  rm -f "$gate_race_root"/captured.*
  : > "$gate_race_log"
  race_case_errors=""
  race_fork_record="$gate_race_out/fork-on-term.records"
  race_fork_ack="$gate_race_out/fork-on-term.acks"
  : > "$race_fork_record"
  : > "$race_fork_ack"
  chmod 600 "$race_fork_record" "$race_fork_ack"
  if race_bound_launch_command "fork-on-TERM gate" 30 /bin/sh -c \
    'output_file="$1"; shift; exec "$@" > "$output_file" 2>&1' \
    launch-bound-command "$gate_race_out/fork-a.out" env \
    RACE_STUB_FORK_ON_TERM=1 \
    RACE_STUB_FORK_RECORD="$race_fork_record" \
    RACE_STUB_FORK_ACK="$race_fork_ack" \
    RACE_STUB_IGNORE_TERM=1 \
    RACE_STUB_SECONDS=90 \
    AGENT_QUALITY_GATE_LOCK=1 \
    AGENT_QUALITY_GATE_LOCK_HELD='' \
    AGENT_QUALITY_GATE_LOCK_DIR="$gate_race_root" \
    AGENT_QUALITY_GATE_LOCK_POLL_SECONDS=1 \
    "$repo_root/scripts/agent-quality-gate.sh" \
    --base HEAD --run --lock-wait 45; then
    race_fork_wrapper="$race_bound_pid"
    race_fork_wrapper_start="$race_bound_start"
    race_fork_wrapper_parent="$race_bound_parent"
  else
    race_case_add_error "could not bind A to its direct-child identity"
    race_fork_wrapper=""
    race_fork_wrapper_start=""
    race_fork_wrapper_parent=""
  fi
  race_waited=0
  while [[ -z "$(awk '/^enter/ { print $2; exit }' "$gate_race_log")" && "$race_waited" -lt 120 ]]; do
    sleep 0.5
    race_waited=$((race_waited + 1))
  done
  [[ -n "$(awk '/^enter/ { print $2; exit }' "$gate_race_log")" ]] ||
    race_case_add_error "A never started its mapped command"
  race_fork_pid="$(sed -n 's/^pid=//p' \
    "$gate_race_root/run.lock/owner" 2>/dev/null | head -n1 || true)"
  [[ "$race_fork_pid" == "$race_fork_wrapper" ]] ||
    race_case_add_error "the owner PID was outside A's direct wrapper"
  if [[ -n "$race_fork_wrapper_start" && -n "$race_fork_wrapper_parent" ]]; then
    gate_test_process_is_expected \
      "$race_fork_pid" "$race_fork_wrapper_start" "$race_fork_wrapper_parent" ||
      race_case_add_error "A lost its exact gate-wrapper identity"
    if race_drain_kill_and_reap_direct_wrapper \
      "fork-on-TERM gate" "$race_fork_wrapper" \
      "$race_fork_wrapper_start" "$race_fork_wrapper_parent"; then
      if gate_test_process_has_start \
        "$race_fork_wrapper" "$race_fork_wrapper_start"; then
        race_case_add_error "A still had its exact identity after bounded reap"
      else
        race_fork_wrapper=""
        race_fork_wrapper_start=""
        race_fork_wrapper_parent=""
      fi
    else
      race_case_add_error "could not safely kill and reap A"
    fi
  fi
  race_fork_b_exit=125
  if [[ -z "$race_fork_wrapper" ]]; then
    if RACE_STUB_SECONDS=2 \
      AGENT_QUALITY_GATE_LOCK=1 \
      AGENT_QUALITY_GATE_LOCK_HELD='' \
      AGENT_QUALITY_GATE_LOCK_DIR="$gate_race_root" \
      AGENT_QUALITY_GATE_LOCK_OWNER_GRACE_SECONDS=1 \
      AGENT_QUALITY_GATE_LOCK_POLL_SECONDS=1 \
      AGENT_QUALITY_GATE_LOCK_ORPHAN_DRAIN_SECONDS=40 \
      "$repo_root/scripts/agent-quality-gate.sh" \
      --base HEAD --run --lock-wait 90 \
      > "$gate_race_out/fork-b.out" 2>&1; then
      race_fork_b_exit=0
    else
      race_fork_b_exit=$?
    fi
  else
    : > "$gate_race_out/fork-b.out"
    race_case_add_error "B was not launched because A's exact absence was not proved"
  fi
  [[ "$race_fork_b_exit" -eq 0 ]] ||
    race_case_add_error "B exited ${race_fork_b_exit}, expected 0"
  grep -Fq "All mapped commands passed." "$gate_race_out/fork-b.out" ||
    race_case_add_error "B did not prove that its mapped command completed"

  if race_bound_launch_command "fork-on-TERM bystander" 30 \
    /bin/sleep "$gate_race_fork_seconds"; then
    race_fork_bystander="$race_bound_pid"
    race_fork_bystander_start="$race_bound_start"
    race_fork_bystander_parent="$race_bound_parent"
  else
    race_case_add_error "could not bind the same-duration direct bystander"
    race_fork_bystander=""
    race_fork_bystander_start=""
    race_fork_bystander_parent=""
  fi
  [[ -s "$race_fork_record" && -s "$race_fork_ack" ]] ||
    race_case_add_error "A did not publish a complete replacement identity and acknowledgement"
  race_drain_wait_for_stable_identity_pair \
    "fork-on-TERM" "$race_fork_record" "$race_fork_ack" ||
    race_case_add_error "$race_drain_owned_record_error"
  if race_drain_inspect_owned_record \
    "fork-on-TERM" "$race_fork_record"; then
    race_fork_inspect_status=0
  else
    race_fork_inspect_status=$?
  fi
  race_fork_survivors="$race_drain_owned_survivors"
  case "$race_fork_inspect_status" in
    0) ;;
    1) race_case_add_error "fixture-owned replacements outlived the drain: ${race_fork_survivors}" ;;
    *) race_case_add_error "owned-record inspection failed safely: ${race_drain_owned_record_error}" ;;
  esac
  if [[ -n "$race_fork_bystander_start" && -n "$race_fork_bystander_parent" ]]; then
    gate_test_process_is_expected \
      "$race_fork_bystander" "$race_fork_bystander_start" \
      "$race_fork_bystander_parent" ||
      race_case_add_error "inspection signalled the unrelated same-duration bystander"
    if race_drain_kill_and_reap_direct_wrapper \
      "fork-on-TERM bystander" "$race_fork_bystander" \
      "$race_fork_bystander_start" "$race_fork_bystander_parent"; then
      race_fork_bystander=""
      race_fork_bystander_start=""
      race_fork_bystander_parent=""
    else
      race_case_add_error "could not safely clean the same-duration bystander"
    fi
  fi
  race_drain_cleanup_direct_wrapper \
    "fork-on-TERM A gate" "$race_fork_wrapper" "$race_fork_wrapper_start" \
    "$race_fork_wrapper_parent" || true
  race_drain_inspect_owned_record "fork-on-TERM" "$race_fork_record" || true
  rm -rf "$gate_race_root/run.lock"
  [[ -z "$race_case_errors" ]] ||
    fail "fork-on-TERM fixture failures:\n${race_case_errors}"

  # The same shape, except the command exits after forking. Its replacement is
  # reparented, carries no argv tag, and has no tagged ancestor to be walked
  # down from — so only a handle the replacement inherited can still find it.
  rm -rf "$gate_race_root/run.lock" "$gate_race_root/condemned.d"
  rm -f "$gate_race_root"/captured.* "$gate_race_root"/holder.*
  : > "$gate_race_log"
  race_case_errors=""
  race_forkexit_record="$gate_race_out/fork-and-exit.records"
  race_forkexit_ack="$gate_race_out/fork-and-exit.acks"
  : > "$race_forkexit_record"
  : > "$race_forkexit_ack"
  chmod 600 "$race_forkexit_record" "$race_forkexit_ack"
  if race_bound_launch_command "fork-and-exit gate" 30 /bin/sh -c \
    'output_file="$1"; shift; exec "$@" > "$output_file" 2>&1' \
    launch-bound-command "$gate_race_out/forkexit-a.out" env \
    RACE_STUB_FORK_AND_EXIT=1 \
    RACE_STUB_FORK_RECORD="$race_forkexit_record" \
    RACE_STUB_FORK_ACK="$race_forkexit_ack" \
    RACE_STUB_SECONDS=90 \
    AGENT_QUALITY_GATE_LOCK=1 \
    AGENT_QUALITY_GATE_LOCK_HELD='' \
    AGENT_QUALITY_GATE_LOCK_DIR="$gate_race_root" \
    AGENT_QUALITY_GATE_LOCK_POLL_SECONDS=1 \
    "$repo_root/scripts/agent-quality-gate.sh" \
    --base HEAD --run --lock-wait 45; then
    race_forkexit_wrapper="$race_bound_pid"
    race_forkexit_wrapper_start="$race_bound_start"
    race_forkexit_wrapper_parent="$race_bound_parent"
  else
    race_case_add_error "could not bind A to its direct-child identity"
    race_forkexit_wrapper=""
    race_forkexit_wrapper_start=""
    race_forkexit_wrapper_parent=""
  fi
  race_waited=0
  while [[ -z "$(awk '/^enter/ { print $2; exit }' "$gate_race_log")" && "$race_waited" -lt 240 ]]; do
    sleep 0.5
    race_waited=$((race_waited + 1))
  done
  [[ -n "$(awk '/^enter/ { print $2; exit }' "$gate_race_log")" ]] ||
    race_case_add_error "A never started its mapped command"
  race_forkexit_pid="$(sed -n 's/^pid=//p' \
    "$gate_race_root/run.lock/owner" 2>/dev/null | head -n1 || true)"
  [[ "$race_forkexit_pid" == "$race_forkexit_wrapper" ]] ||
    race_case_add_error "the owner PID was outside A's direct wrapper"
  if [[ -n "$race_forkexit_wrapper_start" && -n "$race_forkexit_wrapper_parent" ]]; then
    gate_test_process_is_expected \
      "$race_forkexit_pid" "$race_forkexit_wrapper_start" \
      "$race_forkexit_wrapper_parent" ||
      race_case_add_error "A lost its exact gate-wrapper identity"
    if race_drain_kill_and_reap_direct_wrapper \
      "fork-and-exit gate" "$race_forkexit_wrapper" \
      "$race_forkexit_wrapper_start" "$race_forkexit_wrapper_parent"; then
      if gate_test_process_has_start \
        "$race_forkexit_wrapper" "$race_forkexit_wrapper_start"; then
        race_case_add_error "A still had its exact identity after bounded reap"
      else
        race_forkexit_wrapper=""
        race_forkexit_wrapper_start=""
        race_forkexit_wrapper_parent=""
      fi
    else
      race_case_add_error "could not safely kill and reap A"
    fi
  fi
  race_forkexit_b_exit=125
  if [[ -z "$race_forkexit_wrapper" ]]; then
    if RACE_STUB_SECONDS=2 \
      AGENT_QUALITY_GATE_LOCK=1 \
      AGENT_QUALITY_GATE_LOCK_HELD='' \
      AGENT_QUALITY_GATE_LOCK_DIR="$gate_race_root" \
      AGENT_QUALITY_GATE_LOCK_OWNER_GRACE_SECONDS=1 \
      AGENT_QUALITY_GATE_LOCK_POLL_SECONDS=1 \
      AGENT_QUALITY_GATE_LOCK_ORPHAN_DRAIN_SECONDS=40 \
      "$repo_root/scripts/agent-quality-gate.sh" \
      --base HEAD --run --lock-wait 90 \
      > "$gate_race_out/forkexit-b.out" 2>&1; then
      race_forkexit_b_exit=0
    else
      race_forkexit_b_exit=$?
    fi
  else
    : > "$gate_race_out/forkexit-b.out"
    race_case_add_error "B was not launched because A's exact absence was not proved"
  fi
  [[ "$race_forkexit_b_exit" -eq 0 ]] ||
    race_case_add_error "B exited ${race_forkexit_b_exit}, expected 0"
  grep -Fq "All mapped commands passed." "$gate_race_out/forkexit-b.out" ||
    race_case_add_error "B did not prove that its mapped command completed"

  if race_bound_launch_command "fork-and-exit bystander" 30 \
    /bin/sleep "$gate_race_forkexit_seconds"; then
    race_forkexit_bystander="$race_bound_pid"
    race_forkexit_bystander_start="$race_bound_start"
    race_forkexit_bystander_parent="$race_bound_parent"
  else
    race_case_add_error "could not bind the same-duration direct bystander"
    race_forkexit_bystander=""
    race_forkexit_bystander_start=""
    race_forkexit_bystander_parent=""
  fi
  [[ -s "$race_forkexit_record" && -s "$race_forkexit_ack" ]] ||
    race_case_add_error "A did not publish a complete replacement identity and acknowledgement"
  race_drain_wait_for_stable_identity_pair \
    "fork-and-exit" "$race_forkexit_record" "$race_forkexit_ack" ||
    race_case_add_error "$race_drain_owned_record_error"
  if race_drain_inspect_owned_record \
    "fork-and-exit" "$race_forkexit_record"; then
    race_forkexit_inspect_status=0
  else
    race_forkexit_inspect_status=$?
  fi
  race_forkexit_survivors="$race_drain_owned_survivors"
  case "$race_forkexit_inspect_status" in
    0) ;;
    1) race_case_add_error "fixture-owned replacement outlived the drain: ${race_forkexit_survivors}" ;;
    *) race_case_add_error "owned-record inspection failed safely: ${race_drain_owned_record_error}" ;;
  esac
  if [[ -n "$race_forkexit_bystander_start" && -n "$race_forkexit_bystander_parent" ]]; then
    gate_test_process_is_expected \
      "$race_forkexit_bystander" "$race_forkexit_bystander_start" \
      "$race_forkexit_bystander_parent" ||
      race_case_add_error "inspection signalled the unrelated same-duration bystander"
    if race_drain_kill_and_reap_direct_wrapper \
      "fork-and-exit bystander" "$race_forkexit_bystander" \
      "$race_forkexit_bystander_start" "$race_forkexit_bystander_parent"; then
      race_forkexit_bystander=""
      race_forkexit_bystander_start=""
      race_forkexit_bystander_parent=""
    else
      race_case_add_error "could not safely clean the same-duration bystander"
    fi
  fi
  race_drain_cleanup_direct_wrapper \
    "fork-and-exit A gate" "$race_forkexit_wrapper" \
    "$race_forkexit_wrapper_start" "$race_forkexit_wrapper_parent" || true
  race_drain_inspect_owned_record \
    "fork-and-exit" "$race_forkexit_record" || true
  rm -rf "$gate_race_root/run.lock"
  rm -f "$gate_race_root"/holder.*
  [[ -z "$race_case_errors" ]] ||
    fail "fork-and-exit fixture failures:\n${race_case_errors}"

  # A waiter that is suspended past its own budget must notice the time that
  # actually passed, not the time it asked to sleep for.
  rm -rf "$gate_race_root/run.lock"
  sleep 300 &
  race_stopped_holder=$!
  gate_test_capture_identity "$race_stopped_holder" "$gate_test_signal_shell_pid" ||
    fail "the suspended-waiter case could not bind its holder to the direct child"
  race_stopped_holder_start="$gate_test_captured_start"
  race_stopped_holder_parent="$gate_test_captured_parent"
  mkdir -p "$gate_race_root/run.lock"
  {
    printf 'pid=%s\n' "$race_stopped_holder"
    printf 'host=%s\n' "$(uname -n)"
    printf 'started_at=%s\n' "$(date +%s)"
    printf 'start_utc=%s\n' "$(TZ=UTC LC_ALL=C ps -o lstart= -p "$race_stopped_holder" 2>/dev/null | head -n1)"
    printf 'worktree=%s\n' "$gate_race_repo"
    printf 'token=live-holder-1-1\n'
  } > "$gate_race_root/run.lock/owner"
  AGENT_QUALITY_GATE_LOCK=1 \
    AGENT_QUALITY_GATE_LOCK_HELD='' \
    AGENT_QUALITY_GATE_LOCK_DIR="$gate_race_root" \
    AGENT_QUALITY_GATE_LOCK_POLL_SECONDS=1 \
    "$repo_root/scripts/agent-quality-gate.sh" \
    --base HEAD --run --lock-wait 14 \
    > "$gate_race_out/stopped-waiter.out" 2>&1 &
  race_stopped_wrapper=$!
  gate_test_capture_identity "$race_stopped_wrapper" "$gate_test_signal_shell_pid" ||
    fail "the suspended-waiter case could not bind its waiter to the direct child"
  race_stopped_wrapper_start="$gate_test_captured_start"
  race_stopped_wrapper_parent="$gate_test_captured_parent"
  # The budget is far longer than the suspension so the waiter is certainly
  # still waiting when it is stopped. A budget the fixture races would let this
  # case pass by skipping its own assertion — the failure it exists to catch
  # looks exactly like the gate having already exited.
  race_waited=0
  race_stopped_waiter="$race_stopped_wrapper"
  race_stopped_ready=0
  while [[ "$race_stopped_ready" -eq 0 && "$race_waited" -lt 60 ]]; do
    race_stopped_owner="$(sed -n 's/^pid=//p' "$gate_race_root/run.lock/owner" 2>/dev/null | head -n1 || true)"
    if [[ "$race_stopped_owner" == "$race_stopped_holder" ]] &&
      gate_test_process_is_expected \
        "$race_stopped_waiter" "$race_stopped_wrapper_start" "$race_stopped_wrapper_parent" &&
      grep -q "Waiting for the agent quality gate run lock" \
        "$gate_race_out/stopped-waiter.out"; then
      race_stopped_ready=1
      break
    fi
    sleep 0.5
    race_waited=$((race_waited + 1))
  done
  [[ "$race_stopped_ready" -eq 1 ]] ||
    fail "the suspended-waiter case never observed its exact waiter blocked on this lock root"
  gate_test_signal_expected "suspended waiter" STOP \
    "$race_stopped_waiter" "$race_stopped_wrapper_start" "$race_stopped_wrapper_parent" ||
    fail "the suspended-waiter case could not suspend its waiter"
  sleep 8
  gate_test_signal_expected "suspended waiter" CONT \
    "$race_stopped_waiter" "$race_stopped_wrapper_start" "$race_stopped_wrapper_parent" ||
    fail "the suspended-waiter case could not resume its exact waiter"
  if race_drain_wait_for_direct_wrapper \
    "suspended waiter" "$race_stopped_wrapper" \
    "$race_stopped_wrapper_start" "$race_stopped_wrapper_parent"; then
    race_stopped_exit=0
  else
    race_stopped_exit=$?
  fi
  [[ "$race_stopped_exit" != "124" ]] ||
    fail "the suspended-waiter case exceeded its bounded reap"
  race_drain_kill_and_reap_direct_wrapper \
    "suspended-waiter holder" "$race_stopped_holder" \
    "$race_stopped_holder_start" "$race_stopped_holder_parent" ||
    fail "the suspended-waiter case could not safely kill and reap its holder"
  race_stopped_reported="$(sed -n 's/.*timed out after \([0-9]*\)s.*/\1/p' "$gate_race_out/stopped-waiter.out" | head -n1 || true)"
  [[ -n "$race_stopped_reported" ]] ||
    fail "a waiter suspended past its budget must still report a timeout"
  if [[ -n "$race_stopped_waiter" && -n "$race_stopped_reported" ]]; then
    [[ "$race_stopped_reported" -ge 7 ]] ||
      fail "a waiter suspended past its budget reported ${race_stopped_reported}s, not the time that passed"
  fi
  rm -rf "$gate_race_root/run.lock"

  # Pattern construction is part of the scan. A sed failure must publish the
  # scan-error sentinel and stop before pgrep; an empty pattern would otherwise
  # turn an unanswered scan into "no survivors" and discharge the obligation.
  race_pattern_pgrep_called="$gate_race_out/pattern-pgrep-called"
  rm -f "$race_pattern_pgrep_called"
  race_pattern_output="$(
    gate_drain_scan_error="agentqg-scan-failed"
    gate_lock_root_dir="$gate_race_root"
    source "$repo_root/scripts/gate/run-handles.sh"
    sed() { return 2; }
    pgrep() {
      : > "$race_pattern_pgrep_called"
      return 1
    }
    gate_run_tagged_pids "fixture.host-1-1"
  )" 2> "$gate_race_out/pattern-failure.err"
  [[ "$race_pattern_output" == "agentqg-scan-failed" ]] ||
    fail "a failed run-token pattern build did not emit only the scan-error sentinel"
  [[ ! -e "$race_pattern_pgrep_called" ]] ||
    fail "a failed run-token pattern build still called pgrep"

  # A scan that fails is not a scan that finds nothing. With `pgrep` exiting 2
  # — a real failure, not "no match" — a run inheriting an obligation cannot
  # tell whether anything is left, and must refuse to execute rather than
  # discharge it. This also pins that the failure survives the command
  # substitution the scan runs in, which is where the first version of it died.
  rm -rf "$gate_race_root/run.lock" "$gate_race_root/condemned.d"
  rm -f "$gate_race_root"/captured.* "$gate_race_root"/holder.*
  : > "$gate_race_log"
  race_stub_bin="$gate_race_out/failing-scan-bin"
  mkdir -p "$race_stub_bin"
  printf '#!/bin/bash\nexit 2\n' > "$race_stub_bin/pgrep"
  chmod +x "$race_stub_bin/pgrep"
  mkdir -p "$gate_race_root/condemned.d"
  printf 'fixture-unscannable-1-1\n' > "$gate_race_root/condemned.d/fixture-unscannable-1-1"
  PATH="$race_stub_bin:$PATH" \
    AGENT_QUALITY_GATE_LOCK=1 \
    AGENT_QUALITY_GATE_LOCK_HELD='' \
    AGENT_QUALITY_GATE_LOCK_DIR="$gate_race_root" \
    AGENT_QUALITY_GATE_LOCK_POLL_SECONDS=1 \
    AGENT_QUALITY_GATE_LOCK_ORPHAN_DRAIN_SECONDS=6 \
    "$repo_root/scripts/agent-quality-gate.sh" \
    --base HEAD --run --lock-wait 20 \
    > "$gate_race_out/failing-scan.out" 2>&1 &&
    race_scan_exit=0 || race_scan_exit=$?
  [[ "$race_scan_exit" == "2" ]] ||
    fail "a drain whose scans keep failing must fail closed, got exit ${race_scan_exit}"
  grep -q "kept failing" "$gate_race_out/failing-scan.out" ||
    fail "failing closed on an unanswerable scan must say so"
  [[ -z "$(awk '/^enter/ { print $2; exit }' "$gate_race_log")" ]] ||
    fail "a run whose scans kept failing executed a mapped command anyway"
  rm -rf "$gate_race_root/run.lock" "$gate_race_root/condemned.d"

  # A holder owned by another user is live even though this run may not signal
  # it: `kill -0` fails with EPERM exactly as it does for a process that is
  # gone, and reading that as gone reclaims a lock whose holder is running.
  # PID 1 is the portable stand-in — always alive, never ours to signal.
  rm -rf "$gate_race_root/run.lock" "$gate_race_root/condemned.d"
  : > "$gate_race_log"
  if ! kill -0 1 2>/dev/null; then
    mkdir -p "$gate_race_root/run.lock"
    {
      printf 'pid=1\n'
      printf 'host=%s\n' "$(uname -n)"
      printf 'started_at=%s\n' "$(date +%s)"
      printf 'start_utc=%s\n' "$(TZ=UTC LC_ALL=C ps -o lstart= -p 1 2>/dev/null | head -n1)"
      printf 'worktree=%s\n' "$gate_race_repo"
      printf 'token=other-user-holder-1-1\n'
    } > "$gate_race_root/run.lock/owner"
    AGENT_QUALITY_GATE_LOCK=1 \
      AGENT_QUALITY_GATE_LOCK_HELD='' \
      AGENT_QUALITY_GATE_LOCK_DIR="$gate_race_root" \
      AGENT_QUALITY_GATE_LOCK_OWNER_GRACE_SECONDS=1 \
      AGENT_QUALITY_GATE_LOCK_POLL_SECONDS=1 \
      "$repo_root/scripts/agent-quality-gate.sh" \
      --base HEAD --run --lock-wait 6 \
      > "$gate_race_out/foreign-holder.out" 2>&1 || true
    grep -q "reclaiming it" "$gate_race_out/foreign-holder.out" &&
      fail "a holder this user cannot signal was treated as dead and reclaimed"
    [[ -z "$(awk '/^enter/ { print $2; exit }' "$gate_race_log")" ]] ||
      fail "a run executed while a live holder it could not signal held the lock"
  fi
  rm -rf "$gate_race_root/run.lock"

  # The obligation directory is the only thing that tells the next holder a
  # dead run's commands are outstanding, and on a shared lock root it can
  # belong to another user. A run that cannot write into it must not discard
  # the record and take over: that is how it comes to execute beside those
  # commands.
  rm -rf "$gate_race_root/run.lock" "$gate_race_root/condemned.d"
  rm -f "$gate_race_root"/captured.*
  : > "$gate_race_log"
  race_dead_pid="$(fresh_dead_pid)" ||
    fail "could not obtain a reaped PID that reads as dead for the unwritable-obligation case"
  mkdir -p "$gate_race_root/run.lock"
  {
    printf 'pid=%s\n' "$race_dead_pid"
    printf 'host=%s\n' "$(uname -n)"
    printf 'started_at=%s\n' "$(date +%s)"
    printf 'worktree=%s\n' "$gate_race_repo"
    printf 'token=unwritable-obligation-1-1\n'
  } > "$gate_race_root/run.lock/owner"
  mkdir -p "$gate_race_root/condemned.d"
  chmod 555 "$gate_race_root/condemned.d"
  AGENT_QUALITY_GATE_LOCK=1 \
    AGENT_QUALITY_GATE_LOCK_HELD='' \
    AGENT_QUALITY_GATE_LOCK_DIR="$gate_race_root" \
    AGENT_QUALITY_GATE_LOCK_OWNER_GRACE_SECONDS=1 \
    AGENT_QUALITY_GATE_LOCK_POLL_SECONDS=1 \
    "$repo_root/scripts/agent-quality-gate.sh" \
    --base HEAD --run --lock-wait 20 \
    > "$gate_race_out/unwritable-condemned.out" 2>&1 &&
    race_unwritable_exit=0 || race_unwritable_exit=$?
  chmod 755 "$gate_race_root/condemned.d" 2>/dev/null || true
  [[ "$race_unwritable_exit" == "2" ]] ||
    fail "a run that cannot record the obligation must fail closed, got exit ${race_unwritable_exit}"
  grep -q "could not record the previous run's commands as outstanding" \
    "$gate_race_out/unwritable-condemned.out" ||
    fail "failing closed on an unrecordable obligation must say so"
  [[ -z "$(awk '/^enter/ { print $2; exit }' "$gate_race_log")" ]] ||
    fail "a run that could not record the obligation executed a mapped command anyway"
  [[ -e "$gate_race_root/run.lock/owner" ]] ||
    fail "the record naming those commands must survive a failed obligation write"
  rm -rf "$gate_race_root/run.lock" "$gate_race_root/condemned.d"

  # The run marker is the inherited-descriptor handle a fork-and-exit
  # replacement is found by on hosts without /proc. A run that cannot write it
  # must stop before its first command rather than quietly forfeit that
  # discovery. The claim delay opens a deterministic window: run.lock exists,
  # the claim writes inside it, and only the marker needs the root itself.
  rm -rf "$gate_race_root/run.lock" "$gate_race_root/condemned.d"
  rm -f "$gate_race_root"/captured.* "$gate_race_root"/holder.*
  : > "$gate_race_log"
  AGENT_QUALITY_GATE_LOCK=1 \
    AGENT_QUALITY_GATE_LOCK_HELD='' \
    AGENT_QUALITY_GATE_LOCK_DIR="$gate_race_root" \
    AGENT_QUALITY_GATE_LOCK_POLL_SECONDS=1 \
    AGENT_QUALITY_GATE_LOCK_CLAIM_DELAY_SECONDS=3 \
    "$repo_root/scripts/agent-quality-gate.sh" \
    --base HEAD --run --lock-wait 20 \
    > "$gate_race_out/unwritable-marker.out" 2>&1 &
  race_marker_wrapper=$!
  race_waited=0
  while [[ ! -d "$gate_race_root/run.lock" && "$race_waited" -lt 60 ]]; do
    sleep 0.2
    race_waited=$((race_waited + 1))
  done
  [[ -d "$gate_race_root/run.lock" ]] ||
    fail "the unwritable-marker case never saw the lock claimed"
  chmod 555 "$gate_race_root"
  wait "$race_marker_wrapper" 2>/dev/null && race_marker_exit=0 || race_marker_exit=$?
  chmod 755 "$gate_race_root" 2>/dev/null || true
  [[ "$race_marker_exit" -ne 0 ]] ||
    fail "a run that cannot write its marker must fail closed, got exit 0"
  grep -q "could not create the run marker" "$gate_race_out/unwritable-marker.out" ||
    fail "failing closed on an unwritable marker must say so"
  [[ -z "$(awk '/^enter/ { print $2; exit }' "$gate_race_log")" ]] ||
    fail "a run that could not write its marker executed a mapped command anyway"
  rm -rf "$gate_race_root/run.lock"
  rm -f "$gate_race_root"/holder.*

  # Unreadable is not empty. Both obligation files can be created by another
  # user on a shared lock root, and reading one as "nothing outstanding" is how
  # a run comes to execute beside commands it never drained.
  for race_unreadable_case in condemned captured; do
    rm -rf "$gate_race_root/run.lock" "$gate_race_root/condemned.d"
    rm -f "$gate_race_root"/captured.*
    : > "$gate_race_log"
    mkdir -p "$gate_race_root/condemned.d"
    printf 'fixture-unreadable-1-1\n' > "$gate_race_root/condemned.d/fixture-unreadable-1-1"
    if [[ "$race_unreadable_case" == condemned ]]; then
      race_unreadable_file="$gate_race_root/condemned.d/fixture-unreadable-1-1"
    else
      race_unreadable_file="$gate_race_root/captured.fixture-unreadable-1-1"
      printf '99999|\n' > "$race_unreadable_file"
    fi
    chmod 000 "$race_unreadable_file"
    AGENT_QUALITY_GATE_LOCK=1 \
      AGENT_QUALITY_GATE_LOCK_HELD='' \
      AGENT_QUALITY_GATE_LOCK_DIR="$gate_race_root" \
      AGENT_QUALITY_GATE_LOCK_POLL_SECONDS=1 \
      "$repo_root/scripts/agent-quality-gate.sh" \
      --base HEAD --run --lock-wait 20 \
      > "$gate_race_out/unreadable-${race_unreadable_case}.out" 2>&1 &&
      race_unreadable_exit=0 || race_unreadable_exit=$?
    chmod 644 "$race_unreadable_file" 2>/dev/null || true
    [[ "$race_unreadable_exit" == "2" ]] ||
      fail "an unreadable ${race_unreadable_case} record must fail closed, got exit ${race_unreadable_exit}"
    grep -q "exists but cannot be read" \
      "$gate_race_out/unreadable-${race_unreadable_case}.out" ||
      fail "failing closed on an unreadable ${race_unreadable_case} record must say so"
    [[ -z "$(awk '/^enter/ { print $2; exit }' "$gate_race_log")" ]] ||
      fail "a run that could not read the ${race_unreadable_case} record executed a mapped command anyway"
  done
  rm -rf "$gate_race_root/run.lock" "$gate_race_root/condemned.d"
  rm -f "$gate_race_root"/captured.*

  # An obligation left by a drainer that died before discharging it is still
  # outstanding: each file is removed only after its own processes are gone, so
  # whatever remains is what the next run inherits.
  : > "$gate_race_log"
  race_bound_launch_command "inherited-obligation fixture" 30 /bin/bash -c \
    'eval "$1"; exit $?' "agentqg:${race_inherited_token}" 'sleep 60' ||
    fail "the inherited-obligation case could not bind its live fixture to the direct child"
  race_taken_proc="$race_bound_pid"
  race_taken_start="$race_bound_start"
  race_taken_parent="$race_bound_parent"
  sleep 1
  race_inherited_matches=""
  if race_inherited_matches="$(pgrep -f "agentqg:${race_inherited_token}" 2>/dev/null)"; then
    race_inherited_pgrep_status=0
  else
    race_inherited_pgrep_status=$?
  fi
  case "$race_inherited_pgrep_status" in
    0) [[ "$race_inherited_matches" == "$race_taken_proc" ]] ||
      fail "the inherited-obligation fixture did not report exactly its registered direct PID" ;;
    1) fail "the inherited-obligation fixture pgrep found no registered direct PID" ;;
    *) fail "the inherited-obligation fixture pgrep failed with status ${race_inherited_pgrep_status}" ;;
  esac
  mkdir -p "$gate_race_root/condemned.d"
  printf '%s\n' "$race_inherited_token" \
    > "$gate_race_root/condemned.d/$race_inherited_token"
  AGENT_QUALITY_GATE_LOCK=1 \
    AGENT_QUALITY_GATE_LOCK_HELD='' \
    AGENT_QUALITY_GATE_LOCK_DIR="$gate_race_root" \
    AGENT_QUALITY_GATE_LOCK_POLL_SECONDS=1 \
    AGENT_QUALITY_GATE_LOCK_ORPHAN_DRAIN_SECONDS=30 \
    "$repo_root/scripts/agent-quality-gate.sh" \
    --base HEAD --run --lock-wait 30 \
    > "$gate_race_out/inherited-obligation.out" 2>&1 || true
  gate_test_process_has_live_start "$race_taken_proc" "$race_taken_start" &&
    fail "an obligation left behind by a dead drainer was never discharged"
  [[ ! -e "$gate_race_root/condemned.d/$race_inherited_token" ]] ||
    fail "a discharged obligation must not be left behind to be drained forever"
  race_drain_kill_and_reap_direct_wrapper \
    "inherited-obligation fixture" "$race_taken_proc" \
    "$race_taken_start" "$race_taken_parent" ||
    fail "the inherited-obligation case could not safely reap its live fixture"
  rm -rf "$gate_race_root/run.lock" "$gate_race_root/condemned.d"
  rm -f "$gate_race_root"/captured.*

  # Any run can publish an obligation while the holder is draining. The drainer
  # removes only files it has read to the end, so one arriving mid-drain is
  # either picked up by this run or inherited by the next — never deleted
  # unread. The window between reading a file and removing it is microseconds
  # in production, so it is widened here the way the rest of these
  # interleavings are.
  : > "$gate_race_log"
  race_bound_launch_command "unlink-window first fixture" 30 /bin/bash -c \
    'eval "$1"; exit $?' "agentqg:${race_drained_first_token}" 'sleep 60' ||
    fail "the unlink-window case could not bind its first fixture to the direct child"
  race_unlink_first="$race_bound_pid"
  race_unlink_first_start="$race_bound_start"
  race_unlink_first_parent="$race_bound_parent"
  # The late obligation names a live process of its own, so the assertion does
  # not depend on when it is published: either its file is still there for the
  # next run, or this run drained it. Only "file gone, process alive" is the
  # loss this case exists to catch.
  race_bound_launch_command "unlink-window late fixture" 30 /bin/bash -c \
    'eval "$1"; exit $?' "agentqg:${race_arrived_late_token}" 'sleep 90' ||
    fail "the unlink-window case could not bind its late fixture to the direct child"
  race_unlink_late="$race_bound_pid"
  race_unlink_late_start="$race_bound_start"
  race_unlink_late_parent="$race_bound_parent"
  sleep 1
  race_unlink_late_matches=""
  if race_unlink_late_matches="$(pgrep -f "agentqg:${race_arrived_late_token}" 2>/dev/null)"; then
    race_unlink_late_pgrep_status=0
  else
    race_unlink_late_pgrep_status=$?
  fi
  case "$race_unlink_late_pgrep_status" in
    0) [[ "$race_unlink_late_matches" == "$race_unlink_late" ]] ||
      fail "the unlink-window fixture did not report exactly its registered late direct PID" ;;
    1) fail "the unlink-window fixture pgrep found no registered late direct PID" ;;
    *) fail "the unlink-window fixture pgrep failed with status ${race_unlink_late_pgrep_status}" ;;
  esac
  race_unlink_first_matches=""
  if race_unlink_first_matches="$(pgrep -f "agentqg:${race_drained_first_token}" 2>/dev/null)"; then
    race_unlink_first_pgrep_status=0
  else
    race_unlink_first_pgrep_status=$?
  fi
  case "$race_unlink_first_pgrep_status" in
    0) [[ "$race_unlink_first_matches" == "$race_unlink_first" ]] ||
      fail "the unlink-window fixture did not report exactly its registered first direct PID" ;;
    1) fail "the unlink-window fixture pgrep found no registered first direct PID" ;;
    *) fail "the unlink-window fixture pgrep failed with status ${race_unlink_first_pgrep_status}" ;;
  esac
  mkdir -p "$gate_race_root/condemned.d"
  printf '%s\n' "$race_drained_first_token" \
    > "$gate_race_root/condemned.d/$race_drained_first_token"
  if race_bound_launch_command "unlink-window gate" 30 /bin/sh -c \
    'output_file="$1"; shift; exec "$@" > "$output_file" 2>&1' \
    launch-bound-command "$gate_race_out/unlink-window.out" env \
    AGENT_QUALITY_GATE_LOCK=1 \
    AGENT_QUALITY_GATE_LOCK_HELD='' \
    AGENT_QUALITY_GATE_LOCK_DIR="$gate_race_root" \
    AGENT_QUALITY_GATE_LOCK_POLL_SECONDS=1 \
    AGENT_QUALITY_GATE_LOCK_ORPHAN_DRAIN_SECONDS=30 \
    AGENT_QUALITY_GATE_LOCK_DRAIN_UNLINK_DELAY_SECONDS=4 \
    "$repo_root/scripts/agent-quality-gate.sh" \
    --base HEAD --run --lock-wait 30; then
    race_unlink_wrapper="$race_bound_pid"
    race_unlink_wrapper_start="$race_bound_start"
    race_unlink_wrapper_parent="$race_bound_parent"
  else
    fail "the unlink-window gate could not bind its direct child"
  fi
  # The capture file appears when that token's drain starts and is removed
  # when it is discharged, which is where its own file is about to go.
  race_waited=0
  while [[ ! -e "$gate_race_root/captured.$race_drained_first_token" && "$race_waited" -lt 400 ]]; do
    sleep 0.5
    race_waited=$((race_waited + 1))
  done
  [[ -e "$gate_race_root/captured.$race_drained_first_token" ]] ||
    fail "the unlink-window first capture did not appear within its bound"
  race_waited=0
  while [[ -e "$gate_race_root/captured.$race_drained_first_token" && "$race_waited" -lt 120 ]]; do
    sleep 0.5
    race_waited=$((race_waited + 1))
  done
  [[ ! -e "$gate_race_root/captured.$race_drained_first_token" ]] ||
    fail "the unlink-window first capture did not disappear within its second bound"
  gate_test_process_is_expected \
    "$race_unlink_wrapper" "$race_unlink_wrapper_start" \
    "$race_unlink_wrapper_parent" ||
    fail "the unlink-window gate lost its registered exact direct-child identity"
  printf '%s\n' "$race_arrived_late_token" \
    > "$gate_race_root/condemned.d/$race_arrived_late_token"
  wait "$race_unlink_wrapper" 2>/dev/null || true
  if [[ ! -e "$gate_race_root/condemned.d/$race_arrived_late_token" ]] &&
    gate_test_process_has_live_start \
      "$race_unlink_late" "$race_unlink_late_start"; then
    fail "an obligation published during a drain was removed unread, and its command is still running"
  fi
  race_drain_kill_and_reap_direct_wrapper \
    "unlink-window first fixture" "$race_unlink_first" \
    "$race_unlink_first_start" "$race_unlink_first_parent" ||
    fail "the unlink-window case could not safely reap its first fixture"
  race_drain_kill_and_reap_direct_wrapper \
    "unlink-window late fixture" "$race_unlink_late" \
    "$race_unlink_late_start" "$race_unlink_late_parent" ||
    fail "the unlink-window case could not safely reap its late fixture"
  rm -rf "$gate_race_root/run.lock" "$gate_race_root/condemned.d"
  rm -f "$gate_race_root"/captured.*

  # Crash-point sweep. Every boundary where this path creates, links, renames
  # or removes something is a place a SIGKILL can land, and each of the rounds
  # of review on this PR found one of them. The gate names those boundaries so
  # the suite can kill a run at each and assert the next one still recovers —
  # so a future change to this path is checked against the enumeration rather
  # than rediscovered. The mechanics note lists what each state looks like.
  for race_crash_point in after-mkdir after-staged after-link after-take; do
    rm -rf "$gate_race_root/run.lock"
    : > "$gate_race_log"
    if [[ "$race_crash_point" == "after-take" ]]; then
      # Reached only with a record to take: plant a spent one.
      race_dead_pid="$(fresh_dead_pid)" ||
        fail "${race_crash_point}: could not obtain a reaped PID that reads as dead"
      mkdir -p "$gate_race_root/run.lock"
      {
        printf 'pid=%s\n' "$race_dead_pid"
        printf 'host=%s\n' "$(uname -n)"
        printf 'started_at=%s\n' "$(date +%s)"
        printf 'worktree=%s\n' "$gate_race_repo"
        printf 'token=fixture-holder-1-1\n'
      } > "$gate_race_root/run.lock/owner"
    fi
    AGENT_QUALITY_GATE_LOCK=1 \
      AGENT_QUALITY_GATE_LOCK_HELD='' \
      AGENT_QUALITY_GATE_LOCK_DIR="$gate_race_root" \
      AGENT_QUALITY_GATE_LOCK_OWNER_GRACE_SECONDS=1 \
      AGENT_QUALITY_GATE_LOCK_POLL_SECONDS=1 \
      AGENT_QUALITY_GATE_LOCK_CRASH_AT="$race_crash_point" \
      "$repo_root/scripts/agent-quality-gate.sh" \
      --base HEAD --run --lock-wait 30 \
      > "$gate_race_out/crash-$race_crash_point.out" 2>&1 || true
    # The next run has to reach mapped commands and clean up after itself,
    # whatever the crash left behind.
    race_waiter "after-$race_crash_point" 0 0
    grep -q "All mapped commands passed" \
      "$gate_race_out/after-$race_crash_point.out" ||
      fail "a run crashed at ${race_crash_point} must not wedge the next one"
    [[ ! -d "$gate_race_root/run.lock" ]] ||
      fail "the run recovering from a crash at ${race_crash_point} must release the lock"
  done
)
rm -rf "$gate_race_repo" "$gate_race_root" "$gate_race_out" "$gate_race_sync"
if [[ -n "$gate_test_signal_trace_file" ]]; then
  trap - TERM
fi
} # end family: lock-drain

# <<< gate family body end

dispatch_gate_test_families
