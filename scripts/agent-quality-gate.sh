#!/usr/bin/env bash
set -euo pipefail

gate_start_ts="$(date +%s)"

usage() {
  cat <<'USAGE'
Usage: scripts/agent-quality-gate.sh [--dry-run|--run] [--base <ref>] [--head <ref>] [--changed-paths-file <file>] [--allow-package-script-changes] [--fail-fast|--keep-going] [--skip-if-fresh] [--parallel <n>] [--full-local-tests]

Maps changed paths to the local commands and PR checklists an agent should run
before opening or updating a PR. Defaults to dry-run.

Options:
  --dry-run      Print the mapped commands/checklists without running them.
  --run          Execute the mapped safe local commands.
  --base <ref>   Base ref for changed-path detection. Default: origin/main.
  --head <ref>   Head ref for changed-path detection. Default: HEAD.
  --changed-paths-file <file>
                 Read changed paths from a newline-delimited file instead of git.
  --allow-package-script-changes
                 With --run, acknowledge that changed package manifests may
                 alter lifecycle/package scripts before they execute.
  --fail-fast    With --run, stop after the first failed mapped command.
  --keep-going   With --run, continue after failures and report the total.
  --skip-if-fresh
                 With --run, skip execution when the previous successful run
                 used the same base, changed paths, command plan, gate
                 implementation, and validated file content. Intended for the
                 pre-push hook only.
  --parallel <n> With --run, execute independent quality commands with up to
                 n concurrent jobs. Default: auto, capped at 4. Fail-fast mode
                 stays sequential so it still stops before starting the next
                 mapped command.
  --full-local-tests
                 Force full per-package `test:coverage` locally instead of the
                 scoped `vitest related` optimization. CI always runs the full
                 coverage floors regardless of this flag.
  --command-timeout <n>
                 With --run, kill any single mapped command that runs longer
                 than n seconds and report it as a failure. Default: 900. The
                 timeout is per command, never for the whole run.
  -h, --help     Show this help.

Environment:
  AGENT_QUALITY_BASE  Override the default base ref.
  AGENT_QUALITY_HEAD  Override the default head ref.
  AGENT_QUALITY_ALLOW_PACKAGE_SCRIPT_CHANGES
                      Same acknowledgement as --allow-package-script-changes
                      when set to 1 or true.
  AGENT_QUALITY_FAIL_FAST
                      Same behavior as --fail-fast when set to 1 or true.
  AGENT_QUALITY_PARALLELISM
                      Same behavior as --parallel. Use auto for the default.
  AGENT_GATE_FULL_TESTS
                      Same behavior as --full-local-tests when set to 1 or true.
  AGENT_QUALITY_COMMAND_TIMEOUT_SECONDS
                      Same behavior as --command-timeout. Default: 900.
USAGE
}

mode="dry-run"
base_ref="${AGENT_QUALITY_BASE:-origin/main}"
head_ref="${AGENT_QUALITY_HEAD:-HEAD}"
changed_paths_input_file=""
allow_package_script_changes="${AGENT_QUALITY_ALLOW_PACKAGE_SCRIPT_CHANGES:-}"
fail_fast="${AGENT_QUALITY_FAIL_FAST:-false}"
skip_if_fresh="${AGENT_QUALITY_SKIP_IF_FRESH:-false}"
quality_parallelism="${AGENT_QUALITY_PARALLELISM:-auto}"
full_local_tests="${AGENT_GATE_FULL_TESTS:-false}"
command_timeout_seconds="${AGENT_QUALITY_COMMAND_TIMEOUT_SECONDS:-900}"
if [[ -z "$allow_package_script_changes" ]]; then
  allow_package_script_changes="$(git config --bool --get agent.qualityGate.allowPackageScriptChanges 2>/dev/null || true)"
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      mode="dry-run"
      shift
      ;;
    --run)
      mode="run"
      shift
      ;;
    --base)
      base_ref="${2:-}"
      if [[ -z "$base_ref" ]]; then
        echo "error: --base requires a ref" >&2
        exit 2
      fi
      shift 2
      ;;
    --head)
      head_ref="${2:-}"
      if [[ -z "$head_ref" ]]; then
        echo "error: --head requires a ref" >&2
        exit 2
      fi
      shift 2
      ;;
    --changed-paths-file)
      changed_paths_input_file="${2:-}"
      if [[ -z "$changed_paths_input_file" ]]; then
        echo "error: --changed-paths-file requires a file path" >&2
        exit 2
      fi
      shift 2
      ;;
    --allow-package-script-changes)
      allow_package_script_changes="true"
      shift
      ;;
    --fail-fast)
      fail_fast="true"
      shift
      ;;
    --keep-going)
      fail_fast="false"
      shift
      ;;
    --skip-if-fresh)
      skip_if_fresh="true"
      shift
      ;;
    --full-local-tests)
      full_local_tests="true"
      shift
      ;;
    --command-timeout)
      command_timeout_seconds="${2:-}"
      if [[ -z "$command_timeout_seconds" ]]; then
        echo "error: --command-timeout requires a positive integer" >&2
        exit 2
      fi
      shift 2
      ;;
    --parallel|--jobs)
      quality_parallelism="${2:-}"
      if [[ -z "$quality_parallelism" ]]; then
        echo "error: $1 requires a positive integer" >&2
        exit 2
      fi
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

auto_quality_parallelism() {
  local cpu_count
  cpu_count="$(getconf _NPROCESSORS_ONLN 2>/dev/null || true)"
  if [[ ! "$cpu_count" =~ ^[0-9]+$ || "$cpu_count" -lt 1 ]]; then
    cpu_count="$(sysctl -n hw.ncpu 2>/dev/null || true)"
  fi
  if [[ ! "$cpu_count" =~ ^[0-9]+$ || "$cpu_count" -lt 1 ]]; then
    cpu_count=2
  fi
  if [[ "$cpu_count" -gt 4 ]]; then
    echo 4
  else
    echo "$cpu_count"
  fi
}

if [[ "$quality_parallelism" == "auto" ]]; then
  quality_parallelism="$(auto_quality_parallelism)"
fi

if [[ ! "$quality_parallelism" =~ ^[0-9]+$ || "$quality_parallelism" -lt 1 ]]; then
  echo "error: --parallel requires a positive integer" >&2
  exit 2
fi

if [[ ! "$command_timeout_seconds" =~ ^[0-9]+$ || "$command_timeout_seconds" -lt 1 ]]; then
  echo "error: --command-timeout requires a positive integer" >&2
  exit 2
fi

# Resolve this script's own directory before the cd below so node helpers it
# invokes (e.g. lockfile-scope.mjs) resolve from the real checkout even when the
# gate runs against a temp fixture repo whose working directory is elsewhere.
script_source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

# Use a repo-local scratch dir for tmpfiles so we don't depend on TMPDIR
# being writable — pre-push hooks fork off trunk's daemon, which may carry
# a TMPDIR that's outside a host sandbox's writable allowlist. Also export
# TMPDIR so mapped subprocesses (e.g. agent-quality-gate.test.sh's bare
# `mktemp -d`) inherit a writable scratch path instead of falling back to
# the system default (which sandboxed shells often cannot write to).
scratch_dir="$repo_root/.tmp/agent-quality-gate"
mkdir -p "$scratch_dir"
durations_file="$scratch_dir/durations.jsonl"
success_stamp_file="$scratch_dir/last-success.stamp"
# Per-command success stamps (GitHub issue #1410): lets a killed run or a run
# that lost one flaky check resume the commands that already passed instead of
# re-executing everything. Bounded by prune_command_stamps below.
command_stamps_file="$scratch_dir/command-stamps.tsv"
# An exact-signature success may cover the manual-run-to-pre-push interval even
# for the slowest mapped suites. Keep this fixed rather than environment-
# configurable so callers cannot extend validation reuse beyond two hours.
success_stamp_ttl_seconds=$((2 * 60 * 60))
# Avoid overriding a usable TMPDIR: Terraform providers use go-plugin grpc on
# a socket in TMPDIR, and repo-local paths can be blocked by agent seatbelts.
# Trunk hooks can strip TMPDIR entirely, so prefer the system temp directory
# before falling back to the repo scratch dir.
tmpdir_candidate="${TMPDIR:-${TMP:-${TEMP:-/tmp}}}"
if [[ -d "$tmpdir_candidate" && -w "$tmpdir_candidate" ]]; then
  export TMPDIR="$tmpdir_candidate"
else
  export TMPDIR="$scratch_dir"
fi

# Trunk's pre-push hook callback runs the gate without a TTY and strips most
# env vars from the calling shell. Re-assert non-interactive markers so the
# mapped commands (e.g. pnpm install) take the CI codepath instead of asking
# for TTY confirmation.
export CI="${CI:-true}"

tmpfiles=()
# Set by run_with_timeout for the most recent mapped command so callers can tell
# a timeout apart from an ordinary non-zero exit. Read only right after the call.
last_command_timed_out=false
# Monotonic counter for unique per-command timeout marker paths.
timeout_seq=0
# PIDs (command + watchdog) of any in-flight timed command in THIS process, so a
# wrapper SIGINT/SIGTERM tears them down instead of leaking the watchdog's
# background sleeps. Sequential commands run in the gate process; parallel
# members run in their own `&` subshells, each maintaining its own copy — which
# the parent's signal traps cannot see, so the parallel pool ALSO registers its
# worker subshell PIDs in active_worker_pids below.
active_timeout_pids=()

# Worker subshell PIDs of the in-flight parallel pool, maintained by the pool's
# parent loop. A SIGTERM-ignoring mapped command inside a worker would survive
# a gate interrupt if teardown only signalled active_timeout_pids (which are
# empty in the parent during --parallel runs).
active_worker_pids=()

kill_process_tree() {
  local pid="$1"
  local sig="$2"
  local child
  [[ -n "$pid" ]] || return 0
  while IFS= read -r child; do
    [[ -n "$child" ]] && kill_process_tree "$child" "$sig"
  done < <(pgrep -P "$pid" 2>/dev/null || true)
  kill "-${sig}" "$pid" 2>/dev/null || true
}

# Print pid plus every live descendant, one per line, deepest first.
collect_process_tree() {
  local pid="$1"
  local child
  [[ -n "$pid" ]] || return 0
  while IFS= read -r child; do
    [[ -n "$child" ]] && collect_process_tree "$child"
  done < <(pgrep -P "$pid" 2>/dev/null || true)
  echo "$pid"
}

teardown_active_timeouts() {
  local pid
  local -a roots=(
    "${active_timeout_pids[@]+"${active_timeout_pids[@]}"}"
    "${active_worker_pids[@]+"${active_worker_pids[@]}"}"
  )
  active_timeout_pids=()
  active_worker_pids=()
  [[ ${#roots[@]} -gt 0 ]] || return 0
  # Snapshot every descendant BEFORE signalling: TERM kills intermediate
  # subshells first, which reparents a SIGTERM-ignoring survivor away from the
  # tree, so a post-TERM re-walk would miss it. The KILL pass targets the
  # saved pid list, not a fresh walk.
  local -a tree=()
  for pid in "${roots[@]}"; do
    while IFS= read -r child_pid; do
      [[ -n "$child_pid" ]] && tree+=("$child_pid")
    done < <(collect_process_tree "$pid")
  done
  [[ ${#tree[@]} -gt 0 ]] || return 0
  for pid in "${tree[@]}"; do
    kill "-TERM" "$pid" 2>/dev/null || true
  done
  # Same TERM-then-KILL grace as run_with_timeout's watchdog: a manual
  # interrupt (Ctrl-C/TERM to the gate) must not leave a SIGTERM-ignoring
  # mapped command (or descendant) running just because it wasn't the
  # timeout path that tore it down.
  sleep 3
  for pid in "${tree[@]}"; do
    kill "-KILL" "$pid" 2>/dev/null || true
  done
}

cleanup_tmpfiles() {
  teardown_active_timeouts
  if [[ ${#tmpfiles[@]} -gt 0 ]]; then
    rm -f "${tmpfiles[@]+"${tmpfiles[@]}"}"
  fi
}
trap cleanup_tmpfiles EXIT

on_terminating_signal() {
  local signal="$1"
  teardown_active_timeouts
  trap - "$signal"
  kill "-${signal}" "$$" 2>/dev/null || exit 143
}
trap 'on_terminating_signal INT' INT
trap 'on_terminating_signal TERM' TERM

make_tmpfile() {
  local tmpfile
  tmpfile="$(mktemp "$scratch_dir/agentqg.XXXXXX")"
  tmpfiles+=("$tmpfile")
  echo "$tmpfile"
}

changed_paths_file="$(make_tmpfile)"

if [[ -n "$changed_paths_input_file" ]]; then
  if [[ ! -r "$changed_paths_input_file" ]]; then
    echo "error: changed paths file not found: ${changed_paths_input_file}" >&2
    exit 2
  fi
  sed '/^$/d' "$changed_paths_input_file" | sort -u > "$changed_paths_file"
else
  {
    if ! git diff --name-only --no-renames "${base_ref}...${head_ref}" 2>/dev/null; then
      git diff --name-only --no-renames "$base_ref" "$head_ref"
    fi

    if [[ "$head_ref" == "HEAD" ]]; then
      git diff --name-only --no-renames
      git diff --cached --name-only --no-renames
      # The scratch dir is created at line 110 *before* this collection runs.
      # In a repo where .tmp/ isn't gitignored (e.g. the fresh fixture repos
      # built by scripts/agent-quality-gate.test.sh), the gate's own tmpfiles
      # would otherwise be reported as untracked user changes and bleed into
      # downstream args (e.g. the docs-only `./tools/trunk check` builder).
      git ls-files --others --exclude-standard --exclude='.tmp/agent-quality-gate/'
    fi
  } | sed '/^$/d' | sort -u > "$changed_paths_file"
fi

if [[ ! -s "$changed_paths_file" ]]; then
  echo "No changed paths detected against ${base_ref}...${head_ref}."
  exit 0
fi

preflight_commands=()
codegen_commands=()
post_codegen_commands=()
quality_commands=()
checklists=()
surfaces=()
package_script_risk_changed=false
# Set true whenever a full-workspace suite is routed. Scoped-test rewriting
# (GitHub issue #1413) is suppressed in that case so escalations keep the full
# per-package `test:coverage` floors everywhere.
saw_workspace_escalation=false
# Space-padded set of package names whose test:coverage must not be narrowed
# by apply_scoped_test_commands, because pnpm-lock.yaml also bumped their
# importer section this run (issue #1414). The lockfile-triggered coverage
# floor exists specifically to catch a dependency bump's effect on the whole
# package, so an unrelated small source edit in the same package must not
# narrow it down to just that edit's related tests.
lockfile_scoped_packages=""

mark_lockfile_scoped_package() {
  lockfile_scoped_packages+=" $1 "
}

is_lockfile_scoped_package() {
  [[ "$lockfile_scoped_packages" == *" $1 "* ]]
}

has_command() {
  local command="$1"
  shift
  local entry
  local command_key
  local entry_key
  command_key="$(command_dedupe_key "$command")"
  for entry in "$@"; do
    entry_key="$(command_dedupe_key "${entry%%|*}")"
    [[ "$entry_key" == "$command_key" ]] && return 0
  done
  return 1
}

# The package.json script and direct shell entrypoint are the same regression
# suite; keep them as one mapped command when both are touched.
command_dedupe_key() {
  local command="$1"
  case "$command" in
    "pnpm agent:quality-gate:test"|"bash scripts/agent-quality-gate.test.sh")
      echo "agent-quality-gate.test"
      ;;
    "pnpm agent:autoreview:test"|"bash scripts/agent-autoreview.test.sh")
      echo "agent-autoreview.test"
      ;;
    *)
      echo "$command"
      ;;
  esac
}

has_preflight_command() {
  local command="$1"
  has_command "$command" "${preflight_commands[@]+"${preflight_commands[@]}"}"
}

has_codegen_command() {
  local command="$1"
  has_command "$command" "${codegen_commands[@]+"${codegen_commands[@]}"}"
}

has_post_codegen_command() {
  local command="$1"
  has_command "$command" "${post_codegen_commands[@]+"${post_codegen_commands[@]}"}"
}

has_quality_command() {
  local command="$1"
  has_command "$command" "${quality_commands[@]+"${quality_commands[@]}"}"
}

add_preflight_command() {
  local command="$1"
  local reason="$2"
  if ! has_preflight_command "$command"; then
    preflight_commands+=("${command}|${reason}")
  fi
}

add_codegen_command() {
  local command="$1"
  local reason="$2"
  if ! has_codegen_command "$command"; then
    codegen_commands+=("${command}|${reason}")
  fi
}

add_post_codegen_command() {
  local command="$1"
  local reason="$2"
  if ! has_post_codegen_command "$command"; then
    post_codegen_commands+=("${command}|${reason}")
  fi
}

add_command() {
  local command="$1"
  local reason="$2"
  if ! has_quality_command "$command"; then
    quality_commands+=("${command}|${reason}")
  fi
}

turbo_local_cache_command() {
  local package_name="$1"
  local task_name="$2"
  printf 'pnpm exec turbo run %s --filter=%s --cache=local:rw' "$task_name" "$package_name"
}

add_turbo_package_task() {
  local package_name="$1"
  local task_name="$2"
  local reason="$3"
  add_command "$(turbo_local_cache_command "$package_name" "$task_name")" "$reason"
}

add_turbo_dashboard_task() {
  local task_name="$1"
  local reason="$2"
  add_turbo_package_task "@mento-protocol/ui-dashboard" "$task_name" "$reason"
}

prepend_command() {
  local command="$1"
  local reason="$2"
  if ! has_quality_command "$command"; then
    quality_commands=("${command}|${reason}" "${quality_commands[@]+"${quality_commands[@]}"}")
  fi
}

has_checklist() {
  local checklist="$1"
  local entry
  for entry in "${checklists[@]+"${checklists[@]}"}"; do
    if [[ "${entry%%|*}" == "$checklist" ]]; then
      return 0
    fi
  done
  return 1
}

add_checklist() {
  local checklist="$1"
  local reason="$2"
  if ! has_checklist "$checklist"; then
    checklists+=("${checklist}|${reason}")
  fi
}

has_surface() {
  local surface="$1"
  local entry
  for entry in "${surfaces[@]+"${surfaces[@]}"}"; do
    if [[ "$entry" == "$surface" ]]; then
      return 0
    fi
  done
  return 1
}

add_surface() {
  local surface="$1"
  if ! has_surface "$surface"; then
    surfaces+=("$surface")
  fi
}

quote_path() {
  printf "%q" "$1"
}

ref_oid() {
  local ref="$1"
  git rev-parse --verify "${ref}^{commit}" 2>/dev/null || echo "__unresolved__:${ref}"
}

json_change_paths() {
  local path="$1"
  local base_file
  local head_file
  base_file="$(make_tmpfile)"
  head_file="$(make_tmpfile)"

  if ! git show "${base_ref}:${path}" > "$base_file" 2>/dev/null; then
    rm -f "$base_file" "$head_file"
    echo "__unknown__"
    return
  fi

  if [[ "$head_ref" == "HEAD" && -f "$path" ]]; then
    cp "$path" "$head_file"
  elif ! git show "${head_ref}:${path}" > "$head_file" 2>/dev/null; then
    rm -f "$base_file" "$head_file"
    echo "__unknown__"
    return
  fi

  node - "$base_file" "$head_file" <<'NODE'
const fs = require("fs");

const [, , basePath, headPath] = process.argv;

const escapePointer = (part) =>
  part.replace(/~/g, "~0").replace(/\//g, "~1");

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const sameScalar = (a, b) => Object.is(a, b);

const changes = [];

function walk(a, b, path) {
  if (sameScalar(a, b)) return;

  if (isRecord(a) && isRecord(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of [...keys].sort()) {
      walk(a[key], b[key], `${path}/${escapePointer(key)}`);
    }
    return;
  }

  if (JSON.stringify(a) !== JSON.stringify(b)) {
    changes.push(path || "/");
  }
}

try {
  const baseJson = JSON.parse(fs.readFileSync(basePath, "utf8"));
  const headJson = JSON.parse(fs.readFileSync(headPath, "utf8"));
  walk(baseJson, headJson, "");
  for (const change of changes) console.log(change);
} catch {
  console.log("__unknown__");
}
NODE
  rm -f "$base_file" "$head_file"
}

classify_root_package_json_changes() {
  local change
  local saw_change=false
  local saw_tooling_script=false
  local saw_non_tooling_script=false
  local saw_non_script=false
  local saw_dev_metadata=false
  local saw_non_dev_metadata=false

  while IFS= read -r change; do
    [[ -n "$change" ]] || continue
    saw_change=true
    case "$change" in
      "__unknown__")
        echo "workspace"
        return
        ;;
      /scripts/agent:quality-gate|/scripts/agent:quality-gate:test|/scripts/agent:prewarm|/scripts/agent:prewarm:test|/scripts/agent:review-materiality|/scripts/agent:review-materiality:test|/scripts/agent:context-check|/scripts/agent:context-budget|/scripts/agent:context-budget:test|/scripts/docs:index|/scripts/docs:index:test|/scripts/docs:audit|/scripts/docs:audit:test|/scripts/docs:garden|/scripts/docs:garden:test|/scripts/docs:navigation-eval|/scripts/docs:navigation-eval:test|/scripts/agent:autoreview|/scripts/issue:board|/scripts/issue:board:test|/scripts/issue:claim|/scripts/issue:review|/scripts/issue:release|/scripts/sentry:ingest|/scripts/sentry:ingest:test|/scripts/sentry:digest|/scripts/sentry:digest:test|/scripts/sentry:autofix:select|/scripts/sentry:autofix:select:test|/scripts/sentry:autofix:finalize:test|/scripts/sentry:archive|/scripts/sentry:archive:test|/scripts/pr:feedback-state|/scripts/pr:feedback-state:test|/scripts/pr:ready-state|/scripts/pr:ready-state:test|/scripts/tf|/scripts/tf:test|/scripts/alerts:rules:lint|/scripts/alerts:rules:lint:test|/scripts/lockfile:lint|/scripts/lockfile:lint:test|/scripts/skew:check|/scripts/skew:check:test|/scripts/override:prune-report|/scripts/override:prune-report:test|/scripts/adr:check|/scripts/adr:check:test|/scripts/sanitize:test)
        saw_tooling_script=true
        ;;
      /scripts)
        saw_non_tooling_script=true
        ;;
      /scripts/*)
        saw_non_tooling_script=true
        ;;
      # Dev-metadata pointers (GitHub issue #1414): devDependencies plus the
      # descriptive top-level keys. A manifest whose only non-script changes are
      # these is safe to scope to the config canary rather than the full suite.
      /devDependencies | /devDependencies/* | /name | /description | /license | /keywords | /keywords/* | /author | /author/* | /repository | /repository/* | /bugs | /bugs/* | /homepage)
        saw_non_script=true
        saw_dev_metadata=true
        ;;
      *)
        saw_non_script=true
        saw_non_dev_metadata=true
        ;;
    esac
  done < <(json_change_paths "package.json")

  if [[ "$saw_change" != true ]]; then
    echo "workspace"
  elif [[ "$saw_tooling_script" == true && "$saw_non_tooling_script" != true && "$saw_non_script" != true ]]; then
    echo "root-tooling-scripts"
  elif [[ "$saw_tooling_script" == true || "$saw_non_tooling_script" == true ]]; then
    echo "package-scripts"
  elif [[ "$saw_dev_metadata" == true && "$saw_non_dev_metadata" != true ]]; then
    echo "workspace-dev-metadata"
  else
    echo "workspace"
  fi
}

root_package_json_class=""
get_root_package_json_class() {
  if [[ -z "$root_package_json_class" ]]; then
    root_package_json_class="$(classify_root_package_json_changes)"
  fi
  echo "$root_package_json_class"
}

add_package_quality_commands() {
  local package_name="$1"
  local reason="$2"
  if [[ "$package_name" == "@mento-protocol/indexer-envio" ]]; then
    # Both `tsc --noEmit` and `eslint .` (with the type-aware
    # @typescript-eslint/no-unsafe-* rules active) require .envio/types.d.ts.
    # On a fresh worktree, or a PR that only touches src/, codegen wouldn't
    # otherwise run before quality commands and Envio entity imports would
    # resolve to error-`any`, tripping the unsafe-* rules. Force codegen as
    # a preflight; add_codegen_command dedups so concurrent triggers are
    # cheap.
    add_indexer_mainnet_codegen "$reason (codegen needed before indexer typecheck/lint)"
  elif [[ "$package_name" == "@mento-protocol/ui-dashboard" ]]; then
    add_dashboard_codegen "$reason (codegen needed before dashboard typecheck/lint)"
  fi
  add_turbo_package_task "$package_name" "lint" "$reason"
  add_turbo_package_task "$package_name" "typecheck" "$reason"
  add_command "pnpm --filter $package_name test:coverage" "$reason (coverage floor)"
  add_turbo_package_task "$package_name" "knip" "$reason (knip: unused files/deps/exports)"
  add_command "pnpm code-health:deps" "$reason (dep-cruiser: cross-package boundaries + cycles)"
  add_checklist "docs/pr-checklists/code-health.md" "$reason (code-health gates fire on this change)"
}

add_package_vitest_typecheck_commands() {
  local package_name="$1"
  local reason="$2"
  if [[ "$package_name" == "@mento-protocol/indexer-envio" ]]; then
    add_indexer_mainnet_codegen "$reason (codegen needed before indexer typecheck)"
  fi
  add_turbo_package_task "$package_name" "typecheck" "$reason"
  add_command "pnpm --filter $package_name test:coverage" "$reason (coverage floor)"
}

add_dashboard_quality_commands() {
  local reason="$1"
  add_package_quality_commands "@mento-protocol/ui-dashboard" "$reason"
  add_command "pnpm --filter @mento-protocol/ui-dashboard exec playwright install chromium" "$reason"
  add_turbo_dashboard_task "test:browser" "$reason"
}

add_ui_react_doctor_full_score() {
  local reason="$1"
  add_turbo_dashboard_task "react-doctor:score" "$reason"
}

add_ui_react_doctor_diff() {
  local reason="$1"
  add_command "REACT_DOCTOR_BASE_REF=$(quote_path "$base_ref") REACT_DOCTOR_BASE_CACHE_KEY=$(quote_path "$(ref_oid "$base_ref")") $(turbo_local_cache_command "@mento-protocol/ui-dashboard" "react-doctor:diff")" "$reason"
}

add_ui_mutation_baseline() {
  local reason="$1"
  add_command "pnpm dashboard:mutation" "$reason"
}

add_ui_size_limit() {
  local reason="$1"
  # `size-limit` depends on `build` in turbo.json, so one Turbo invocation
  # preserves the build guarantee without paying for a separate scheduler run.
  # Trunk's hook callback strips caller-provided environment variables, while
  # operator-local .env files may contain empty Vercel placeholders. Pin a
  # non-empty local deployment identity on the mapped command itself so both
  # direct gate runs and agent:prewarm remain hermetic without loose Turbo env.
  add_command "VERCEL_DEPLOYMENT_ID=local-quality-gate $(turbo_local_cache_command "@mento-protocol/ui-dashboard" "size-limit")" "$reason"
}

add_bridge_mutation_baseline() {
  local reason="$1"
  add_command "pnpm bridge:mutation" "$reason"
}

add_aegis_quality_commands() {
  local reason="$1"
  add_turbo_package_task "@mento-protocol/aegis" "typecheck" "$reason"
  add_command "pnpm --filter @mento-protocol/aegis build" "$reason"
  add_turbo_package_task "@mento-protocol/aegis" "lint" "$reason"
  add_turbo_package_task "@mento-protocol/aegis" "knip" "$reason (knip: unused files/deps/exports)"
  add_command "pnpm --filter @mento-protocol/aegis test:cov" "$reason"
  add_command "cd aegis && forge test" "$reason"
  add_command "pnpm code-health:deps" "$reason (dep-cruiser: cross-package boundaries + cycles)"
  add_checklist "docs/pr-checklists/code-health.md" "$reason (code-health gates fire on this change)"
}

add_alerts_oncall_quality_commands() {
  local reason="$1"
  add_turbo_package_task "@mento-protocol/alerts-oncall-announcer" "lint" "$reason"
  add_turbo_package_task "@mento-protocol/alerts-oncall-announcer" "typecheck" "$reason"
  add_command "pnpm --filter @mento-protocol/alerts-oncall-announcer test:coverage" "$reason (coverage floor)"
  add_turbo_package_task "@mento-protocol/alerts-oncall-announcer" "knip" "$reason (knip: unused files/deps/exports)"
}

add_indexer_mutation_baseline() {
  local reason="$1"
  add_command "pnpm indexer:mutation" "$reason"
}

add_workspace_quality_commands() {
  local reason="$1"
  saw_workspace_escalation=true
  add_command "pnpm skew:check" "$reason"
  add_all_indexer_codegen "$reason"
  # Use the lightweight dashboard quality (typecheck/lint/test/knip) for
  # workspace-wide triggers (root package.json, CI yaml, npmrc, etc.).
  # Playwright `test:browser` is high-cost and chromium's --single-process
  # mode (required in macOS sandbox per playwright.config.ts) is flaky for
  # tests using keyboard events + page.route. CI runs the full browser
  # suite in its own job — local workspace-wide triggers don't need to
  # replicate it. Direct `ui-dashboard/*` path changes still hit the full
  # `add_dashboard_quality_commands` from the per-package dispatch below.
  add_package_quality_commands "@mento-protocol/ui-dashboard" "$reason"
  add_ui_react_doctor_full_score "$reason"
  # Bundle size budget mirrors the workspace-wide CI gate in
  # `.github/workflows/size-limit.yml` — root package-manager files
  # (`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`, patches,
  # `.node-version`) appear in that workflow's filter because dep/runtime
  # changes can alter the emitted JS/CSS. Codex P2 review on PR #446
  # caught the local gate diverging from CI here.
  add_ui_size_limit "$reason"
  add_package_quality_commands "@mento-protocol/indexer-envio" "$reason"
  add_package_quality_commands "@mento-protocol/metrics-bridge" "$reason"
  add_package_quality_commands "@mento-protocol/integration-probes" "$reason"
  add_package_quality_commands "@mento-protocol/config" "$reason"
  add_package_quality_commands "@mento-protocol/governance-watchdog" "$reason"
  add_aegis_quality_commands "$reason"
}

# ── Scoped local test runs (GitHub issue #1413) ─────────────────────────────
# A per-package quality bundle normally runs `pnpm --filter <pkg> test:coverage`
# (the full suite + coverage floor). Locally, when a package's changed paths are
# a small set of production source files, narrow that one command to
# `pnpm --filter <pkg> exec vitest related --run <files>` so agents only pay for
# the tests touching their edit. CI is untouched — it always runs the full
# coverage floors — so this is a local-signal optimization, not a floor change.
# Every ambiguity fails toward the full suite.

# Package name → repo-relative importer directory. Unmapped packages have no
# directory, so scoping never fires for them (→ full suite).
scoped_package_dir_for() {
  case "$1" in
    @mento-protocol/ui-dashboard) echo "ui-dashboard" ;;
    @mento-protocol/indexer-envio) echo "indexer-envio" ;;
    @mento-protocol/metrics-bridge) echo "metrics-bridge" ;;
    @mento-protocol/integration-probes) echo "integration-probes" ;;
    @mento-protocol/governance-watchdog) echo "governance-watchdog" ;;
    @mento-protocol/alerts-onchain-event-handler) echo "alerts/infra/onchain-event-handler" ;;
    @mento-protocol/alerts-oncall-announcer) echo "alerts/infra/oncall-announcer" ;;
    *) return 1 ;;
  esac
}

# True iff a package-relative path is NOT production source. Tests, specs, test
# directories, vitest/tsconfig config, package manifests, GraphQL schemas,
# generated types, and fixtures all disqualify a package from scoping so its
# full suite still runs. Ambiguous paths are treated as non-source (fail toward
# full).
scoped_is_non_source_path() {
  local path="$1"
  case "$path" in
    *.test.* | *.spec.*) return 0 ;;
    __tests__/* | */__tests__/*) return 0 ;;
    test/* | tests/* | */test/* | */tests/*) return 0 ;;
    vitest.config.* | */vitest.config.* | vitest.*.config.* | */vitest.*.config.*) return 0 ;;
    vitest.hermetic-setup.ts | */vitest.hermetic-setup.ts) return 0 ;;
    tsconfig* | */tsconfig*) return 0 ;;
    package.json | */package.json) return 0 ;;
    *.graphql) return 0 ;;
    __generated__/* | */__generated__/* | generated/* | */generated/* | *.gen.ts) return 0 ;;
    fixtures/* | */fixtures/* | __fixtures__/* | */__fixtures__/*) return 0 ;;
    # Only recognized TS/JS module extensions count as production source.
    # Anything else (YAML/JSON/CSS/assets) may be read by tests via fs rather
    # than the import graph `vitest related` follows, so it disqualifies
    # scoping (fail toward full).
    *.ts | *.tsx | *.mts | *.cts | *.js | *.jsx | *.mjs | *.cjs) return 1 ;;
    *) return 0 ;;
  esac
}

# True iff any changed path anywhere is a test-infra file whose edit can change
# which tests run for unrelated source, or a shared-config path whose edit can
# regress any consumer through the dependency graph (`vitest related` only
# follows imports from the changed files themselves, so a consumer's scoped
# run would miss shared-config-induced regressions). Either disables scoping
# globally.
scoped_test_infra_changed() {
  local path
  while IFS= read -r path; do
    case "$path" in
      scripts/envio-schema-stubs.graphql) return 0 ;;
      shared-config/*) return 0 ;;
      vitest.hermetic-setup.ts | */vitest.hermetic-setup.ts) return 0 ;;
      vitest.config.* | */vitest.config.* | vitest.*.config.* | */vitest.*.config.*) return 0 ;;
      */test/setup/* | */tests/setup/*) return 0 ;;
    esac
  done < "$changed_paths_file"
  return 1
}

# True iff the repo-relative path exists in the head state: the working tree
# when head_ref is HEAD (the common case, so local uncommitted edits count),
# otherwise the given ref via git. A deleted file, or the old side of a
# --no-renames rename, reports false.
scoped_path_exists_at_head() {
  local path="$1"
  if [[ "$head_ref" == "HEAD" ]]; then
    [[ -e "$path" ]]
  else
    git cat-file -e "${head_ref}:${path}" 2>/dev/null
  fi
}

# Print the package-relative production-source paths changed inside a package
# directory, one per line. Returns non-zero (no output) when the package is
# unscopable: no changed paths inside it, any non-source path inside it, or a
# changed path that no longer exists at head (a deletion, or the old side of a
# rename — `vitest related --run` silently finds zero tests for a missing
# path instead of erroring, which would otherwise skip the coverage floor
# entirely instead of failing toward the full suite).
scoped_source_files_for_package() {
  local package_name="$1"
  local package_dir
  package_dir="$(scoped_package_dir_for "$package_name")" || return 1

  local path rel
  local saw_source=false
  local files=()
  while IFS= read -r path; do
    case "$path" in
      "$package_dir"/*)
        rel="${path#"$package_dir"/}"
        if scoped_is_non_source_path "$rel"; then
          return 1
        fi
        if ! scoped_path_exists_at_head "$path"; then
          return 1
        fi
        files+=("$rel")
        saw_source=true
        ;;
    esac
  done < "$changed_paths_file"

  [[ "$saw_source" == true ]] || return 1
  printf '%s\n' "${files[@]}"
}

# True iff scoping is globally permitted for this run.
scoped_tests_enabled() {
  [[ "$full_local_tests" == "1" || "$full_local_tests" == "true" ]] && return 1
  [[ "$saw_workspace_escalation" == true ]] && return 1
  local changed_count
  changed_count="$(wc -l < "$changed_paths_file" | tr -d '[:space:]')"
  [[ "$changed_count" =~ ^[0-9]+$ && "$changed_count" -le 15 ]] || return 1
  scoped_test_infra_changed && return 1
  return 0
}

# Rewrite eligible `pnpm --filter <pkg> test:coverage` quality commands to the
# scoped `vitest related --run` form. Runs once, after the full dispatch, so the
# escalation flag and the complete changed-path set are final.
apply_scoped_test_commands() {
  scoped_tests_enabled || return 0

  local i entry command reason package_name package_dir files scoped_files rel
  for i in "${!quality_commands[@]}"; do
    entry="${quality_commands[$i]}"
    command="${entry%%|*}"
    reason="${entry#*|}"

    [[ "$command" =~ ^pnpm\ --filter\ (@mento-protocol/[a-z-]+)\ test:coverage$ ]] || continue
    package_name="${BASH_REMATCH[1]}"

    # shared-config's blast radius is the point — keep its full suite (issue #1413).
    [[ "$package_name" == "@mento-protocol/config" ]] && continue

    # A lockfile importer bump for this package (issue #1414) means the
    # coverage floor is standing in for the dependency-bump regression check;
    # an unrelated small source edit in the same package must not narrow it
    # down to just that edit's related tests.
    is_lockfile_scoped_package "$package_name" && continue

    files="$(scoped_source_files_for_package "$package_name")" || continue

    scoped_files=""
    while IFS= read -r rel; do
      [[ -n "$rel" ]] || continue
      scoped_files+=" $(quote_path "$rel")"
    done <<< "$files"
    [[ -n "$scoped_files" ]] || continue

    quality_commands[i]="pnpm --filter ${package_name} exec vitest related --run${scoped_files}|${reason} (scoped-tests)"
  done
}

# ── Lockfile-importer scoping (GitHub issue #1414) ──────────────────────────
# A pnpm-lock.yaml change normally escalates to the full workspace suite. When
# the lockfile is the ONLY workspace-manifest-class change and it structurally
# touches only importer sections, narrow the suite to the affected packages.
# Every ambiguity (co-changed manifests, non-importer sections, an unmapped or
# root importer, parse/git failure) fails toward the full suite.

# True iff pnpm-lock.yaml changed and no other workspace-manifest-class path did.
lockfile_only_manifest_change() {
  local path
  local saw_lock=false
  while IFS= read -r path; do
    case "$path" in
      pnpm-lock.yaml)
        saw_lock=true
        ;;
      package.json | */package.json | pnpm-workspace.yaml | patches/* | .npmrc | */.npmrc | pnpmfile.cjs | .pnpmfile.cjs | .node-version)
        return 1
        ;;
    esac
  done < "$changed_paths_file"
  [[ "$saw_lock" == true ]]
}

# Print the changed importer keys (one per line) on stdout when the lockfile
# change is scopable; return non-zero to signal fail-toward-full.
lockfile_scoped_importers() {
  local base_file
  local head_file
  base_file="$(make_tmpfile)"
  head_file="$(make_tmpfile)"

  if ! git show "${base_ref}:pnpm-lock.yaml" > "$base_file" 2>/dev/null; then
    rm -f "$base_file" "$head_file"
    return 1
  fi

  if [[ "$head_ref" == "HEAD" && -f "pnpm-lock.yaml" ]]; then
    cp "pnpm-lock.yaml" "$head_file"
  elif ! git show "${head_ref}:pnpm-lock.yaml" > "$head_file" 2>/dev/null; then
    rm -f "$base_file" "$head_file"
    return 1
  fi

  local rc=0
  node "$script_source_dir/lockfile-scope.mjs" "$base_file" "$head_file" < /dev/null || rc=$?
  rm -f "$base_file" "$head_file"
  return "$rc"
}

# Known importer dir → package quality bundle. `.` (root) and any unknown
# importer are absent, so is_mappable/map both reject them (→ full suite).
lockfile_importer_is_mappable() {
  case "$1" in
    aegis | ui-dashboard | indexer-envio | metrics-bridge | integration-probes | shared-config | governance-watchdog | alerts/infra/onchain-event-handler | alerts/infra/oncall-announcer)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

map_lockfile_importer_to_bundle() {
  local importer="$1"
  local reason="$2"
  case "$importer" in
    aegis)
      mark_lockfile_scoped_package "@mento-protocol/aegis"
      add_aegis_quality_commands "$reason"
      ;;
    ui-dashboard)
      mark_lockfile_scoped_package "@mento-protocol/ui-dashboard"
      add_dashboard_quality_commands "$reason"
      # Dependency resolution changes can regress bundle size; the workspace
      # route ran size-limit for lockfile edits, so the scoped route must too.
      add_ui_size_limit "$reason"
      ;;
    indexer-envio)
      mark_lockfile_scoped_package "@mento-protocol/indexer-envio"
      # A changed Envio resolution can break the testnet/bridge-only codegen
      # even when mainnet codegen passes; keep the workspace route's coverage.
      add_all_indexer_codegen "$reason"
      add_package_quality_commands "@mento-protocol/indexer-envio" "$reason"
      ;;
    metrics-bridge)
      mark_lockfile_scoped_package "@mento-protocol/metrics-bridge"
      add_package_quality_commands "@mento-protocol/metrics-bridge" "$reason"
      ;;
    integration-probes)
      mark_lockfile_scoped_package "@mento-protocol/integration-probes"
      add_package_quality_commands "@mento-protocol/integration-probes" "$reason"
      ;;
    shared-config)
      mark_lockfile_scoped_package "@mento-protocol/config"
      add_package_quality_commands "@mento-protocol/config" "$reason"
      ;;
    governance-watchdog)
      mark_lockfile_scoped_package "@mento-protocol/governance-watchdog"
      add_package_quality_commands "@mento-protocol/governance-watchdog" "$reason"
      ;;
    alerts/infra/onchain-event-handler)
      mark_lockfile_scoped_package "@mento-protocol/alerts-onchain-event-handler"
      add_package_quality_commands "@mento-protocol/alerts-onchain-event-handler" "$reason"
      ;;
    alerts/infra/oncall-announcer)
      mark_lockfile_scoped_package "@mento-protocol/alerts-oncall-announcer"
      add_alerts_oncall_quality_commands "$reason"
      ;;
  esac
}

# Route a pnpm-lock.yaml change: scoped when eligible and every changed importer
# maps to a package bundle, otherwise the full workspace suite.
route_lockfile_change() {
  add_surface "workspace"
  add_preflight_command "pnpm install --frozen-lockfile" "workspace dependency/config changed"

  local importers
  if lockfile_only_manifest_change && importers="$(lockfile_scoped_importers)"; then
    local importer
    local mappable=true
    while IFS= read -r importer; do
      [[ -n "$importer" ]] || continue
      lockfile_importer_is_mappable "$importer" || {
        mappable=false
        break
      }
    done <<< "$importers"

    if [[ "$mappable" == true ]]; then
      add_command "pnpm skew:check" "lockfile change scoped to importers"
      add_command "pnpm lockfile:lint" "lockfile change scoped to importers"
      while IFS= read -r importer; do
        [[ -n "$importer" ]] || continue
        map_lockfile_importer_to_bundle "$importer" "lockfile importer ${importer} changed"
      done <<< "$importers"
      return
    fi
  fi

  # Fail toward the full workspace suite.
  add_workspace_quality_commands "workspace dependency/config changed"
  add_adr_reminder "workspace membership/policy changed — ADR reminder (a new package likely needs an ADR)"
}

add_root_tooling_package_script_checks() {
  local reason="$1"
  add_command "bash scripts/check-agent-quality-gate-package-scripts.sh" "$reason"
  add_command "bash scripts/agent-quality-gate.test.sh" "$reason"
  add_command "node scripts/agent-prewarm.test.mjs" "$reason"
  add_command "node scripts/review-materiality.test.mjs" "$reason"
  add_command "node scripts/agent-issue-board.test.mjs" "$reason"
  add_command "pnpm sentry:ingest:test" "$reason"
  add_command "pnpm sentry:digest:test" "$reason"
  add_command "pnpm sentry:project:test" "$reason"
  add_command "pnpm sentry:autofix:select:test" "$reason"
  add_command "pnpm sentry:autofix:finalize:test" "$reason"
  add_command "pnpm sentry:archive:test" "$reason"
  add_command "node scripts/pr-feedback-state.test.mjs" "$reason"
  add_command "node scripts/pr-ready-state.test.mjs" "$reason"
  add_command "node scripts/terraform-fmt-check.test.mjs" "$reason"
  add_command "node scripts/tf-stacks.test.mjs" "$reason"
  add_command "node scripts/lockfile-lint.test.mjs" "$reason"
  add_command "node scripts/version-skew-check.test.mjs" "$reason"
  add_command "node scripts/override-prune-report.test.mjs" "$reason"
  add_command "node scripts/check-adr-reminder.test.mjs" "$reason"
  add_command "node scripts/docs-index.test.mjs" "$reason"
  add_command "node scripts/docs-audit.test.mjs" "$reason"
  add_command "node scripts/docs-garden-issue.test.mjs" "$reason"
  add_command "node scripts/docs-navigation-eval.test.mjs" "$reason"
  add_command "node scripts/agent-context-budget.test.mjs" "$reason"
}

# Advisory ADR reminder, fed the gate's own base/head + changed-path set so the
# checker evaluates exactly what the gate routed (including a precomputed
# --changed-paths-file set). Self-suppressing, so safe to route broadly.
add_adr_reminder() {
  local reason="$1"
  local cmd="node scripts/check-adr-reminder.mjs"
  cmd="$cmd --base $(quote_path "$base_ref") --head $(quote_path "$head_ref")"
  cmd="$cmd --include-untracked --changed-paths-file $(quote_path "$changed_paths_file")"
  add_command "$cmd" "$reason"
}

add_indexer_post_codegen_install() {
  add_post_codegen_command "pnpm install --frozen-lockfile" "link generated package after indexer codegen"
}

add_dashboard_codegen_commit_check() {
  local command
  command="if [[ -n \"\$(git status --porcelain -- ui-dashboard/src/lib/__generated__/graphql.ts)\" ]]; then"
  command+=" git status --short -- ui-dashboard/src/lib/__generated__/graphql.ts;"
  command+=" echo \"Generated dashboard GraphQL types are not committed. Run pnpm dashboard:codegen and commit the result.\" >&2;"
  command+=" exit 1; fi"
  add_post_codegen_command "$command" "verify dashboard GraphQL generated output is committed"
}

add_dashboard_codegen() {
  local reason="$1"
  add_codegen_command "pnpm dashboard:codegen" "$reason"
  add_dashboard_codegen_commit_check
}

add_indexer_mainnet_codegen() {
  local reason="$1"
  add_codegen_command "pnpm indexer:codegen" "$reason"
  add_indexer_post_codegen_install
}

add_indexer_testnet_codegen() {
  local reason="$1"
  add_codegen_command "pnpm indexer:testnet:codegen" "$reason"
  add_indexer_post_codegen_install
}

add_indexer_bridge_codegen() {
  local reason="$1"
  add_codegen_command "pnpm --filter @mento-protocol/indexer-envio indexer:bridge-only:codegen" "$reason"
  add_indexer_post_codegen_install
}

add_all_indexer_codegen() {
  local reason="$1"
  add_indexer_bridge_codegen "$reason"
  add_indexer_testnet_codegen "$reason"
  add_indexer_mainnet_codegen "$reason"
}

add_bridge_codegen_then_restore_mainnet() {
  local bridge_reason="$1"
  add_indexer_bridge_codegen "$bridge_reason"
  add_indexer_mainnet_codegen "restore full multichain generated package after non-mainnet codegen"
}

add_reserve_yield_codegen_then_restore_mainnet() {
  local reserve_reason="$1"
  add_codegen_command "pnpm --filter @mento-protocol/indexer-envio indexer:reserve-yield:test" "$reserve_reason"
  add_indexer_post_codegen_install
}

add_terraform_validate_commands() {
  local module="$1"
  local reason="$2"
  local tf_data_dir="${module}/.terraform-agent-gate"
  add_command "TF_DATA_DIR=${tf_data_dir} node scripts/terraform-fmt-check.mjs $(quote_path "$module")" "$reason"
  add_command "TF_DATA_DIR=${tf_data_dir} terraform -chdir=${module} init -backend=false -input=false" "$reason"
  add_command "TF_DATA_DIR=${tf_data_dir} terraform -chdir=${module} validate -no-color" "$reason"
}

trunk_requires_full_scan() {
  local path
  while IFS= read -r path; do
    [[ -e "$path" ]] || return 0
    case "$path" in
      # .trunk/trunk.yaml (enabled linters, ignores) already lands here via
      # .trunk/*, so it gets the unfiltered full scan below; no separate
      # .shellcheckrc-style case is needed for it.
      .trunk/*|tools/trunk|package.json|pnpm-lock.yaml|pnpm-workspace.yaml|patches/*|.npmrc|*/.npmrc|pnpmfile.cjs|.pnpmfile.cjs|.node-version|*/package.json)
        return 0
        ;;
    esac
  done < "$changed_paths_file"

  return 1
}

trunk_requires_shellcheck_full_scan() {
  local path
  while IFS= read -r path; do
    case "$path" in
      # .shellcheckrc disables/options apply repo-wide, but a targeted Trunk
      # check only lints the config file itself (a no-op) rather than the
      # *.sh targets it governs. Force a repo-wide, ShellCheck-only scan so
      # an edit here (e.g. loosening a disable) is validated against every
      # script instead of passing trivially.
      .shellcheckrc)
        return 0
        ;;
    esac
  done < "$changed_paths_file"

  return 1
}

targeted_trunk_command() {
  local path
  local args=()
  while IFS= read -r path; do
    args+=("$(quote_path "$path")")
  done < "$changed_paths_file"

  [[ ${#args[@]} -gt 0 ]] || return 1
  printf './tools/trunk check %s' "${args[*]}"
}

add_trunk_check_command() {
  local trunk_command
  if trunk_requires_full_scan; then
    prepend_command "./tools/trunk check --all" "changed paths require full-repo Trunk checks"
  elif trunk_command="$(targeted_trunk_command)"; then
    prepend_command "$trunk_command" "changed existing paths should pass targeted Trunk checks"
  else
    prepend_command "./tools/trunk check --all" "changed paths could not be mapped to targeted Trunk checks"
  fi

  if trunk_requires_shellcheck_full_scan; then
    prepend_command "./tools/trunk check --all --filter=shellcheck" "ShellCheck config changed; re-validate every script it governs"
  fi
}

sort_codegen_commands() {
  local sorted=()
  local known_command
  local entry
  local is_known
  # Envio codegen variants all overwrite indexer-envio/generated. When multiple
  # variants are needed, keep mainnet last so package checks validate the normal
  # linked generated package; single-config changes still run only that config.
  local known_codegen_commands=(
    "pnpm dashboard:codegen"
    "pnpm --filter @mento-protocol/indexer-envio indexer:bridge-only:codegen"
    "pnpm --filter @mento-protocol/indexer-envio indexer:reserve-yield:test"
    "pnpm indexer:testnet:codegen"
    "pnpm indexer:codegen"
  )

  for known_command in "${known_codegen_commands[@]}"; do
    for entry in "${codegen_commands[@]+"${codegen_commands[@]}"}"; do
      if [[ "${entry%%|*}" == "$known_command" ]]; then
        sorted+=("$entry")
        break
      fi
    done
  done

  for entry in "${codegen_commands[@]+"${codegen_commands[@]}"}"; do
    is_known=false
    for known_command in "${known_codegen_commands[@]}"; do
      if [[ "${entry%%|*}" == "$known_command" ]]; then
        is_known=true
        break
      fi
    done
    if [[ "$is_known" == false ]]; then
      sorted+=("$entry")
    fi
  done

  codegen_commands=()
  for entry in "${sorted[@]+"${sorted[@]}"}"; do
    codegen_commands+=("$entry")
  done
}

find_turbo_task_index() {
  local task="$1"
  local index
  for index in "${!turbo_group_tasks[@]}"; do
    if [[ "${turbo_group_tasks[$index]}" == "$task" ]]; then
      echo "$index"
      return 0
    fi
  done
  return 1
}

list_contains_word() {
  local needle="$1"
  local word
  shift
  for word in "$@"; do
    [[ "$word" == "$needle" ]] && return 0
  done
  return 1
}

reason_list_contains() {
  local reasons="$1"
  local reason="$2"
  [[ "; ${reasons}; " == *"; ${reason}; "* ]]
}

compact_turbo_quality_commands() {
  local compacted_kinds=()
  local compacted_values=()
  local turbo_group_tasks=()
  local turbo_group_packages=()
  local turbo_group_reasons=()
  local entry
  local command
  local reason
  local task
  local package_name
  local group_index
  local existing_packages
  local existing_reasons
  local existing_package_array
  local kind
  local value
  local package_filters
  local package

  for entry in "${quality_commands[@]+"${quality_commands[@]}"}"; do
    command="${entry%%|*}"
    reason="${entry#*|}"

    if [[ "$command" =~ ^pnpm\ exec\ turbo\ run\ ([^[:space:]]+)\ --filter=(@mento-protocol/[^[:space:]]+)\ --cache=local:rw$ ]]; then
      task="${BASH_REMATCH[1]}"
      package_name="${BASH_REMATCH[2]}"

      if group_index="$(find_turbo_task_index "$task")"; then
        existing_packages="${turbo_group_packages[$group_index]}"
        read -r -a existing_package_array <<< "$existing_packages"
        if ! list_contains_word "$package_name" "${existing_package_array[@]}"; then
          turbo_group_packages[group_index]="${existing_packages} ${package_name}"
        fi

        existing_reasons="${turbo_group_reasons[$group_index]}"
        if ! reason_list_contains "$existing_reasons" "$reason"; then
          turbo_group_reasons[group_index]="${existing_reasons}; ${reason}"
        fi
      else
        turbo_group_tasks+=("$task")
        turbo_group_packages+=("$package_name")
        turbo_group_reasons+=("$reason")
        compacted_kinds+=("turbo")
        compacted_values+=("$task")
      fi
    else
      compacted_kinds+=("plain")
      compacted_values+=("$entry")
    fi
  done

  quality_commands=()
  for index in "${!compacted_kinds[@]}"; do
    kind="${compacted_kinds[$index]}"
    value="${compacted_values[$index]}"
    if [[ "$kind" == "plain" ]]; then
      quality_commands+=("$value")
      continue
    fi

    group_index="$(find_turbo_task_index "$value")"
    package_filters=""
    read -r -a existing_package_array <<< "${turbo_group_packages[$group_index]}"
    for package in "${existing_package_array[@]}"; do
      package_filters+=" --filter=${package}"
    done
    quality_commands+=("pnpm exec turbo run ${value}${package_filters} --cache=local:rw|${turbo_group_reasons[$group_index]}")
  done
}

while IFS= read -r path; do
  case "$path" in
    *.md)
      add_surface "docs"
      add_command "pnpm docs:index --check" "tracked documentation changed"
      ;;
  esac
  case "$path" in
    README.md|*/README.md)
      add_command "pnpm agent:context-check" "README metadata may enroll canonical context"
      ;;
    docs/evals/documentation-navigation-baseline.json)
      add_surface "docs"
      add_command "pnpm docs:navigation-eval:test" "documentation navigation baseline changed"
      add_command "pnpm docs:navigation-eval -- --check-fixtures" "documentation navigation baseline changed"
      add_command "pnpm docs:navigation-eval -- --validate docs/evals/documentation-navigation-baseline.json" "documentation navigation baseline changed"
      ;;
    docs/evals/documentation-navigation-*.json)
      add_surface "docs"
      add_command "pnpm docs:navigation-eval:test" "documentation navigation evaluation contract changed"
      add_command "pnpm docs:navigation-eval -- --check-fixtures" "documentation navigation evaluation contract changed"
      add_command "pnpm docs:navigation-eval -- --validate docs/evals/documentation-navigation-baseline.json" "documentation navigation evaluation contract changed"
      ;;
    AGENTS.md|*/AGENTS.md|.codex/config.toml)
      add_surface "agent-context"
      add_command "pnpm agent:context-budget --strict" "agent instruction budget input changed"
      ;;
  esac
  case "$path" in
    package.json)
      root_package_json_class="$(get_root_package_json_class)"
      case "$root_package_json_class" in
        root-tooling-scripts)
          add_surface "tooling"
          add_root_tooling_package_script_checks "root package tooling script changed"
          ;;
        package-scripts)
          package_script_risk_changed=true
          add_surface "workspace"
          add_preflight_command "pnpm install --frozen-lockfile" "root package script changed"
          add_root_tooling_package_script_checks "root package script changed"
          add_workspace_quality_commands "root package script changed"
          ;;
        *)
          package_script_risk_changed=true
          add_preflight_command "pnpm install --frozen-lockfile" "workspace package manifest changed"
          ;;
      esac
      ;;
    */package.json)
      package_script_risk_changed=true
      add_preflight_command "pnpm install --frozen-lockfile" "workspace package manifest changed"
      add_command "pnpm skew:check" "workspace package manifest changed"
      ;;
    pnpm-lock.yaml|pnpm-workspace.yaml)
      package_script_risk_changed=true
      ;;
    patches/*)
      package_script_risk_changed=true
      add_preflight_command "pnpm install --frozen-lockfile" "pnpm patch changed"
      add_surface "workspace"
      add_workspace_quality_commands "pnpm patch changed"
      ;;
    .dependency-cruiser.cjs)
      add_surface "tooling"
      add_command "pnpm code-health:deps" "dep-cruiser config changed (cross-package boundaries + cycles)"
      # `.dependency-cruiser.cjs` is also linted by `pnpm lint:scripts` (see
      # eslint.config.mjs root coverage). A CJS-only edit must run both.
      add_command "pnpm lint:scripts" "dep-cruiser config changed (root ESLint coverage)"
      add_checklist "docs/pr-checklists/code-health.md" "dep-cruiser config changed"
      ;;
    */knip.json)
      # Match knip.json regardless of which package owns it. The pnpm
      # filter scope below normalizes path to package.
      add_surface "tooling"
      add_checklist "docs/pr-checklists/code-health.md" "knip config changed"
      case "$path" in
        shared-config/knip.json)
          add_turbo_package_task "@mento-protocol/config" "knip" "knip config changed"
          ;;
        ui-dashboard/knip.json)
          add_turbo_package_task "@mento-protocol/ui-dashboard" "knip" "knip config changed"
          ;;
        indexer-envio/knip.json)
          add_turbo_package_task "@mento-protocol/indexer-envio" "knip" "knip config changed"
          ;;
        metrics-bridge/knip.json)
          add_turbo_package_task "@mento-protocol/metrics-bridge" "knip" "knip config changed"
          ;;
        integration-probes/knip.json)
          add_turbo_package_task "@mento-protocol/integration-probes" "knip" "knip config changed"
          ;;
        aegis/knip.json)
          add_turbo_package_task "@mento-protocol/aegis" "knip" "knip config changed"
          ;;
      esac
      ;;
    .npmrc|*/.npmrc|pnpmfile.cjs|.pnpmfile.cjs)
      package_script_risk_changed=true
      add_preflight_command "pnpm install --frozen-lockfile" "package manager config changed"
      add_surface "workspace"
      add_workspace_quality_commands "package manager config changed"
      ;;
  esac
  case "$path" in
    *.sh)
      add_surface "scripts"
      if [[ -f "$path" ]]; then
        add_command "bash -n $(quote_path "$path")" "shell script changed"
      fi
      ;;
  esac
  case "$path" in
    */vitest.config.ts|*/vitest.mutation.config.ts)
      add_surface "tooling"
      add_command "node scripts/check-hermetic-vitest-setup.mjs" "hermetic Vitest config changed"
      ;;
    */vitest.hermetic-setup.ts)
      add_surface "tooling"
      add_command "node scripts/check-hermetic-vitest-setup.mjs" "hermetic Vitest setup changed"
      case "$path" in
        alerts/infra/oncall-announcer/vitest.hermetic-setup.ts)
          add_package_vitest_typecheck_commands "@mento-protocol/alerts-oncall-announcer" "alerts oncall-announcer hermetic Vitest setup changed"
          ;;
        alerts/infra/onchain-event-handler/vitest.hermetic-setup.ts)
          add_package_vitest_typecheck_commands "@mento-protocol/alerts-onchain-event-handler" "alerts onchain-event-handler hermetic Vitest setup changed"
          ;;
        governance-watchdog/vitest.hermetic-setup.ts)
          add_package_vitest_typecheck_commands "@mento-protocol/governance-watchdog" "governance-watchdog hermetic Vitest setup changed"
          ;;
        indexer-envio/vitest.hermetic-setup.ts)
          add_package_vitest_typecheck_commands "@mento-protocol/indexer-envio" "indexer-envio hermetic Vitest setup changed"
          ;;
        integration-probes/vitest.hermetic-setup.ts)
          add_package_vitest_typecheck_commands "@mento-protocol/integration-probes" "integration-probes hermetic Vitest setup changed"
          ;;
        metrics-bridge/vitest.hermetic-setup.ts)
          add_package_vitest_typecheck_commands "@mento-protocol/metrics-bridge" "metrics-bridge hermetic Vitest setup changed"
          ;;
        shared-config/vitest.hermetic-setup.ts)
          add_package_vitest_typecheck_commands "@mento-protocol/config" "shared-config hermetic Vitest setup changed"
          ;;
        ui-dashboard/vitest.hermetic-setup.ts)
          add_package_vitest_typecheck_commands "@mento-protocol/ui-dashboard" "ui-dashboard hermetic Vitest setup changed"
          ;;
      esac
      ;;
  esac
  case "$path" in
    ui-dashboard/scripts/*.sh)
      add_surface "ui-dashboard"
      case "$path" in
        ui-dashboard/scripts/vercel-ignore-build.sh|ui-dashboard/scripts/vercel-ignore-build.test.sh)
          add_command "bash ui-dashboard/scripts/vercel-ignore-build.test.sh" "Vercel ignore build script changed"
          ;;
      esac
      ;;
    ui-dashboard/*)
      add_surface "ui-dashboard"
      add_dashboard_quality_commands "ui-dashboard changed"
      add_ui_react_doctor_diff "ui-dashboard client code should keep React Doctor clean"
      add_ui_react_doctor_full_score "ui-dashboard React Doctor score should stay 100"
      # Bundle size budget gate — mirrors `.github/workflows/size-limit.yml`.
      # Any change under ui-dashboard/ that can affect the client build
      # (src files, root config files like postcss/sentry-shared/next/tsconfig)
      # re-runs the build + size-limit check locally before opening a PR.
      # Browser fixtures and other nested .mjs files are deliberately excluded:
      # they can invalidate browser-test cache entries without forcing an
      # unrelated dashboard build cache miss.
      case "$path" in
        ui-dashboard/src/*|ui-dashboard/package.json|ui-dashboard/next.config.*|ui-dashboard/postcss.config.*|ui-dashboard/sentry.*.config.*|ui-dashboard/sentry.shared.ts|ui-dashboard/tsconfig*.json|ui-dashboard/.size-limit.cjs|ui-dashboard/vercel.json|ui-dashboard/.env.production.local.example)
          add_ui_size_limit "ui-dashboard bundle inputs changed"
          ;;
      esac
      case "$path" in
        ui-dashboard/src/app/*|ui-dashboard/src/components/*|ui-dashboard/src/lib/graphql.ts|ui-dashboard/src/hooks/*|ui-dashboard/src/lib/queries.ts|ui-dashboard/src/lib/queries/*|ui-dashboard/src/lib/bridge-queries.ts|ui-dashboard/src/lib/bridge-flows/use-bridge-gql.ts|ui-dashboard/src/lib/gql-retry.ts|ui-dashboard/src/lib/fetch-all-networks.ts|ui-dashboard/src/lib/fetch-json.ts|ui-dashboard/src/lib/network-fetcher/*|ui-dashboard/src/lib/og-graphql-client.ts|ui-dashboard/src/lib/homepage-og.ts|ui-dashboard/src/lib/pool-og.ts|ui-dashboard/src/lib/bridge-flows-og.ts|ui-dashboard/src/lib/hasura-timeout.ts|ui-dashboard/src/lib/mento-address-discovery.ts)
          add_checklist "docs/pr-checklists/swr-polling-hasura.md" "Hasura/SWR/query path changed"
          ;;
      esac
      case "$path" in
        ui-dashboard/src/app/*|ui-dashboard/src/components/*|ui-dashboard/src/hooks/*|ui-dashboard/src/lib/*)
          add_checklist "docs/pr-checklists/stateful-data-ui.md" "dashboard data or UI flow changed"
          ;;
      esac
      case "$path" in
        ui-dashboard/src/app/*/layout.tsx|ui-dashboard/src/app/*/page.tsx|ui-dashboard/src/app/*/_lib/*metadata*)
          add_checklist "docs/pr-checklists/dynamic-route-metadata.md" "dynamic route or metadata-adjacent file changed"
          ;;
      esac
      case "$path" in
        ui-dashboard/src/components/*|ui-dashboard/src/app/*/_components/*|ui-dashboard/src/lib/use-roving-*)
          add_checklist "docs/pr-checklists/keyboard-a11y-controlled-widgets.md" "controlled dashboard component changed"
          ;;
      esac
      case "$path" in
        ui-dashboard/stryker.config.mjs|ui-dashboard/vitest.mutation.config.ts|ui-dashboard/src/lib/weekend.ts|ui-dashboard/src/lib/pool-id.ts|ui-dashboard/src/lib/__tests__/weekend.test.ts|ui-dashboard/src/lib/__tests__/pool-id.test.ts)
          add_checklist "docs/pr-checklists/mutation-testing.md" "dashboard mutation baseline changed"
          add_ui_mutation_baseline "dashboard mutation baseline changed"
          ;;
      esac
      ;;
    indexer-envio/*)
      add_surface "indexer-envio"
      case "$path" in
        indexer-envio/schema.graphql|indexer-envio/abis/*|indexer-envio/scripts/run-envio-with-env.mjs|indexer-envio/package.json)
          add_all_indexer_codegen "indexer schema/source/ABI/package path changed"
          add_dashboard_codegen "indexer schema/source path changed (dashboard GraphQL types read schema.graphql)"
          add_checklist "docs/pr-checklists/stateful-data-ui.md" "indexer data flow changed"
          ;;
        indexer-envio/src/EventHandlersBridgeOnly.ts)
          add_bridge_codegen_then_restore_mainnet "bridge handler registration path changed"
          add_checklist "docs/pr-checklists/stateful-data-ui.md" "indexer data flow changed"
          ;;
        indexer-envio/src/handlers/susds*.ts|indexer-envio/src/handlers/susds/*|indexer-envio/src/handlers/steth*.ts|indexer-envio/src/handlers/steth/*)
          add_reserve_yield_codegen_then_restore_mainnet "reserve-yield handler path changed"
          add_checklist "docs/pr-checklists/stateful-data-ui.md" "indexer data flow changed"
          ;;
        indexer-envio/src/rpc/susds.ts|indexer-envio/src/rpc/effects.ts)
          add_reserve_yield_codegen_then_restore_mainnet "reserve-yield RPC path changed"
          add_checklist "docs/pr-checklists/stateful-data-ui.md" "indexer data flow changed"
          ;;
        indexer-envio/src/handlers/wormhole/*)
          add_bridge_codegen_then_restore_mainnet "bridge handler registration path changed"
          add_indexer_testnet_codegen "indexer handler registration path changed"
          add_checklist "docs/pr-checklists/stateful-data-ui.md" "indexer data flow changed"
          ;;
        indexer-envio/src/EventHandlers.ts|indexer-envio/src/handlers/*)
          add_indexer_testnet_codegen "indexer handler registration path changed"
          add_indexer_mainnet_codegen "indexer handler registration path changed"
          add_reserve_yield_codegen_then_restore_mainnet "reserve-yield handler registration path changed"
          add_checklist "docs/pr-checklists/stateful-data-ui.md" "indexer data flow changed"
          ;;
        indexer-envio/src/*)
          add_checklist "docs/pr-checklists/stateful-data-ui.md" "indexer data flow changed"
          ;;
      esac
      case "$path" in
        indexer-envio/config/*.json)
          add_checklist "docs/pr-checklists/stateful-data-ui.md" "indexer config data flow changed"
          ;;
      esac
      case "$path" in
        indexer-envio/config.multichain.mainnet.yaml)
          add_indexer_mainnet_codegen "mainnet indexer config changed"
          add_reserve_yield_codegen_then_restore_mainnet "reserve-yield indexer config changed"
          add_checklist "docs/pr-checklists/stateful-data-ui.md" "indexer data flow changed"
          ;;
        indexer-envio/config.multichain.testnet.yaml)
          add_indexer_testnet_codegen "testnet indexer config changed"
          add_checklist "docs/pr-checklists/stateful-data-ui.md" "indexer data flow changed"
          ;;
        indexer-envio/config.multichain.bridge-only.yaml)
          add_bridge_codegen_then_restore_mainnet "bridge-only indexer config changed"
          add_checklist "docs/pr-checklists/stateful-data-ui.md" "indexer data flow changed"
          ;;
      esac
      case "$path" in
        indexer-envio/stryker.config.mjs|indexer-envio/vitest.mutation.config.ts|indexer-envio/src/helpers.ts|indexer-envio/src/tradingLimits.ts|indexer-envio/src/handlers/stables/classifyKind.ts|indexer-envio/src/handlers/stables/dailyFlush.ts|indexer-envio/test/code-quality-invariants.test.ts|indexer-envio/test/pool-helpers.test.ts|indexer-envio/test/tradingLimits.test.ts|indexer-envio/test/stables.test.ts|indexer-envio/config/*.json)
          add_checklist "docs/pr-checklists/mutation-testing.md" "indexer mutation baseline changed"
          add_indexer_mutation_baseline "indexer mutation baseline changed"
          ;;
      esac
      add_package_quality_commands "@mento-protocol/indexer-envio" "indexer-envio changed"
      ;;
    metrics-bridge/*)
      add_surface "metrics-bridge"
      case "$path" in
        metrics-bridge/src/*)
          add_checklist "docs/pr-checklists/stateful-data-ui.md" "metrics bridge data flow changed"
          add_checklist "docs/pr-checklists/terraform-cloudrun.md" "metrics bridge Cloud Run runtime changed"
          ;;
      esac
      case "$path" in
        metrics-bridge/src/metrics.ts|metrics-bridge/src/cdp-metrics.ts)
          add_command "pnpm alerts:rules:lint" "metrics-bridge gauge registry changed (alerts cross-check)"
          ;;
      esac
      case "$path" in
        metrics-bridge/Dockerfile|metrics-bridge/.dockerignore)
          add_checklist "docs/pr-checklists/terraform-cloudrun.md" "metrics bridge Cloud Run runtime changed"
          ;;
      esac
      case "$path" in
        metrics-bridge/stryker.config.mjs|metrics-bridge/vitest.mutation.config.ts|metrics-bridge/src/rebalance-probe.ts|metrics-bridge/test/rebalance-probe.test.ts)
          add_checklist "docs/pr-checklists/mutation-testing.md" "metrics bridge mutation baseline changed"
          add_bridge_mutation_baseline "metrics bridge mutation baseline changed"
          ;;
      esac
      add_package_quality_commands "@mento-protocol/metrics-bridge" "metrics-bridge changed"
      ;;
    integration-probes/*)
      add_surface "integration-probes"
      case "$path" in
        integration-probes/src/*)
          add_checklist "docs/pr-checklists/stateful-data-ui.md" "integration probe data flow changed"
          ;;
      esac
      add_package_quality_commands "@mento-protocol/integration-probes" "integration-probes changed"
      ;;
    aegis/*)
      add_surface "aegis"
      case "$path" in
        aegis/src/*|aegis/config.yaml|aegis/app.yaml|aegis/contracts/*|aegis/foundry.toml|aegis/foundry.lock|aegis/package.json|aegis/tsconfig*.json|aegis/nest-cli.json|aegis/eslint.config.js|aegis/eslint-baseline.json)
          add_aegis_quality_commands "aegis changed"
          ;;
        aegis/terraform/*)
          add_terraform_validate_commands "aegis/terraform" "Aegis Terraform changed"
          add_checklist "docs/pr-checklists/ci-workflow-gates.md" "Aegis Terraform/deploy-adjacent path changed"
          ;;
        aegis/grafana-agent/*|aegis/bin/*)
          add_aegis_quality_commands "aegis runtime/deploy path changed"
          add_checklist "docs/pr-checklists/ci-workflow-gates.md" "Aegis deploy path changed"
          ;;
        aegis/lib/*)
          add_command "cd aegis && forge test" "Aegis Foundry dependency changed"
          ;;
      esac
      ;;
    shared-config/*)
      add_surface "shared-config"
      add_package_quality_commands "@mento-protocol/config" "shared-config changed"
      add_command "pnpm --filter @mento-protocol/config build" "shared-config exports changed"
      add_command "pnpm --filter @mento-protocol/ui-dashboard typecheck" "shared-config consumers should typecheck"
      add_command "pnpm --filter @mento-protocol/metrics-bridge typecheck" "shared-config consumers should typecheck"
      add_command "pnpm --filter @mento-protocol/integration-probes typecheck" "shared-config consumers should typecheck"
      # shared-config is imported into the dashboard client bundle via
      # `@mento-protocol/config` — changes to chain/token
      # metadata or helpers can shift the emitted JS. Mirrors the
      # `shared-config/**` entry in `.github/workflows/size-limit.yml`.
      add_ui_size_limit "shared-config exports feed the dashboard bundle"
      case "$path" in
        shared-config/src/thresholds.ts)
          add_command "node scripts/check-deviation-threshold-drift.mjs" "shared deviation threshold source changed"
          add_command "pnpm --filter @mento-protocol/indexer-envio exec vitest run deviationThresholdSharedConfigSync" "shared deviation threshold source changed"
          ;;
        shared-config/deployment-namespaces.json|shared-config/fx-calendar.json)
          add_all_indexer_codegen "shared-config vendored indexer fixture changed"
          add_package_quality_commands "@mento-protocol/indexer-envio" "shared-config vendored indexer fixture changed"
          ;;
      esac
      ;;
    .github/workflows/*|.github/actions/*)
      add_surface "github-workflows"
      add_checklist "docs/pr-checklists/ci-workflow-gates.md" "GitHub Actions workflow/action changed"
      add_command "node scripts/check-github-action-pins.mjs" "GitHub Actions workflow/action changed"
      add_command "node scripts/check-autofix-ci-trust.mjs" "GitHub Actions workflow/action changed (autofix CI trust boundary)"
      add_adr_reminder "workflow/action changed — ADR reminder (a new workflow likely needs an ADR)"
      case "$path" in
        .github/workflows/ci.yml)
          add_surface "workspace"
          add_preflight_command "pnpm install --frozen-lockfile" "central CI workflow changed"
          add_workspace_quality_commands "central CI workflow changed"
          add_command "pnpm tf:test" "Terraform registry-backed CI workflow changed"
          add_terraform_validate_commands "terraform" "Terraform registry-backed CI workflow changed"
          add_terraform_validate_commands "alerts/rules" "Terraform registry-backed CI workflow changed"
          add_terraform_validate_commands "alerts/infra" "Terraform registry-backed CI workflow changed"
          add_terraform_validate_commands "aegis/terraform" "Terraform registry-backed CI workflow changed"
          ;;
        .github/workflows/documentation-garden.yml)
          add_command "pnpm docs:garden:test" "documentation garden workflow changed"
          add_command "pnpm docs:navigation-eval:test" "documentation navigation scheduler workflow changed"
          ;;
        .github/workflows/infra.yml)
          add_command "pnpm tf:test" "Terraform registry workflow changed"
          add_terraform_validate_commands "terraform" "Terraform registry workflow changed"
          add_terraform_validate_commands "alerts/rules" "Terraform registry workflow changed"
          add_terraform_validate_commands "alerts/infra" "Terraform registry workflow changed"
          add_terraform_validate_commands "aegis/terraform" "Terraform registry workflow changed"
          ;;
        .github/workflows/metrics-bridge.yml)
          add_checklist "docs/pr-checklists/terraform-cloudrun.md" "metrics bridge Cloud Run workflow changed"
          add_command "pnpm agent:context-check" "Cloud Run revision suffix guard changed"
          ;;
        .github/workflows/aegis-app-engine.yml)
          add_aegis_quality_commands "Aegis App Engine workflow changed"
          ;;
        .github/workflows/lighthouse.yml)
          add_checklist "docs/pr-checklists/code-health.md" "Lighthouse CI workflow changed"
          ;;
        .github/actions/pnpm-install/*)
          add_surface "workspace"
          add_preflight_command "pnpm install --frozen-lockfile" "pnpm install action changed"
          add_workspace_quality_commands "pnpm install action changed"
          ;;
      esac
      ;;
    .trunk/*)
      add_surface "tooling"
      add_command "node scripts/check-github-action-pins.mjs" "Trunk workflow/action setup changed"
      add_command "pnpm agent:quality-gate:test" "agent quality gate trunk hook changed"
      ;;
    turbo.json)
      add_surface "tooling"
      add_command "pnpm agent:quality-gate:test" "turbo task config changed"
      ;;
    alerts/rules/*)
      add_surface "alerts-rules"
      add_terraform_validate_commands "alerts/rules" "alerts/rules Terraform changed"
      add_command "pnpm alerts:rules:lint" "alerts/rules PromQL lint + metric cross-check"
      case "$path" in
        alerts/rules/main.tf|alerts/rules/rules-fpmms.tf)
          add_command "node scripts/check-deviation-threshold-drift.mjs" "deviation threshold Terraform consumer changed"
          ;;
      esac
      ;;
    alerts/infra/onchain-event-handler/*)
      add_surface "alerts-infra"
      case "$path" in
        alerts/infra/onchain-event-handler/src/safe-abi.json)
          add_package_quality_commands "@mento-protocol/alerts-onchain-event-handler" "Safe ABI changed (handler imports it)"
          add_terraform_validate_commands "alerts/infra" "Safe ABI changed (listener filter uses it at plan time)"
          ;;
        alerts/infra/onchain-event-handler/src/*|alerts/infra/onchain-event-handler/package.json|alerts/infra/onchain-event-handler/pnpm-lock.yaml|alerts/infra/onchain-event-handler/pnpm-workspace.yaml|alerts/infra/onchain-event-handler/tsconfig.json|alerts/infra/onchain-event-handler/vitest.config.ts|alerts/infra/onchain-event-handler/knip.json|alerts/infra/onchain-event-handler/eslint.config.mjs)
          add_package_quality_commands "@mento-protocol/alerts-onchain-event-handler" "alerts onchain-event-handler changed"
          ;;
        alerts/infra/onchain-event-handler/*.tf)
          add_terraform_validate_commands "alerts/infra" "alerts/infra Terraform changed"
          add_checklist "docs/pr-checklists/terraform-cloudrun.md" "alerts/infra Cloud Function path changed"
          ;;
        # Other handler files (scripts/*.sh, README.md, .gcloudignore,
        # .prettierrc.json, .prettierignore) need no extra routing: shell
        # scripts hit the generic `*.sh → bash -n $(quote_path "$path")`
        # branch above; the others are doc/config-only and don't gate
        # anything.
      esac
      ;;
    alerts/infra/oncall-announcer/*)
      add_surface "alerts-infra"
      case "$path" in
        alerts/infra/oncall-announcer/src/*|alerts/infra/oncall-announcer/package.json|alerts/infra/oncall-announcer/pnpm-lock.yaml|alerts/infra/oncall-announcer/pnpm-workspace.yaml|alerts/infra/oncall-announcer/tsconfig.json|alerts/infra/oncall-announcer/vitest.config.ts|alerts/infra/oncall-announcer/knip.json|alerts/infra/oncall-announcer/eslint.config.mjs)
          add_alerts_oncall_quality_commands "alerts oncall-announcer changed"
          ;;
        alerts/infra/oncall-announcer/*.tf)
          add_terraform_validate_commands "alerts/infra" "alerts/infra Terraform changed"
          add_checklist "docs/pr-checklists/terraform-cloudrun.md" "alerts/infra Cloud Function path changed"
          ;;
      esac
      ;;
    alerts/infra/scripts/*)
      add_surface "alerts-infra"
      case "$path" in
        alerts/infra/scripts/*.sh)
          add_command "bash -n $(quote_path "$path")" "alerts infra shell script changed"
          ;;
      esac
      case "$path" in
        alerts/infra/scripts/common.sh|alerts/infra/scripts/fix-webhook-state.sh|alerts/infra/scripts/fix-webhook-state.test.sh)
          add_command "bash alerts/infra/scripts/fix-webhook-state.test.sh" "QuickNode state parser changed"
          ;;
      esac
      ;;
    alerts/infra/onchain-event-listeners/*|alerts/infra/channels/*)
      # Listener filter (filter-function.js.tpl) feeds into the handler —
      # a regression like dropping blockHash from it silently breaks the
      # handler's cross-chain detection, and the 38 vitest cases cover
      # that behavior. Route to handler tests in addition to TF validate.
      # Matches the CI alerts paths-filter in .github/workflows/ci.yml.
      add_surface "alerts-infra"
      add_package_quality_commands "@mento-protocol/alerts-onchain-event-handler" "alerts/infra listener or channels changed (handler tests cover cross-chain behavior)"
      add_terraform_validate_commands "alerts/infra" "alerts/infra Terraform changed"
      add_checklist "docs/pr-checklists/terraform-cloudrun.md" "alerts/infra Cloud Function path changed"
      case "$path" in
        alerts/infra/onchain-event-listeners/main.tf)
          add_command "bash alerts/infra/scripts/fix-webhook-state.test.sh" "QuickNode replacement state parser changed"
          ;;
      esac
      ;;
    alerts/infra/*)
      add_surface "alerts-infra"
      add_terraform_validate_commands "alerts/infra" "alerts/infra Terraform changed"
      add_checklist "docs/pr-checklists/terraform-cloudrun.md" "alerts/infra Cloud Function path changed"
      ;;
    governance-watchdog/*)
      add_surface "governance-watchdog"
      case "$path" in
        governance-watchdog/src/*|governance-watchdog/bin/*.ts|governance-watchdog/package.json|governance-watchdog/pnpm-lock.yaml|governance-watchdog/pnpm-workspace.yaml|governance-watchdog/tsconfig.json|governance-watchdog/tsconfig.build.json|governance-watchdog/vitest.config.ts|governance-watchdog/knip.json|governance-watchdog/eslint.config.mjs)
          add_package_quality_commands "@mento-protocol/governance-watchdog" "governance-watchdog changed"
          ;;
        governance-watchdog/infra/*.tf)
          add_terraform_validate_commands "governance-watchdog/infra" "governance-watchdog Terraform changed"
          add_checklist "docs/pr-checklists/terraform-cloudrun.md" "governance-watchdog Cloud Function path changed"
          ;;
        governance-watchdog/infra/quicknode-filter-functions/*.js)
          # Canonical source that bin/deploy-quicknode-filter.sh pushes to the
          # live QuickNode webhook — a syntax regression would otherwise only
          # surface during a live filter update.
          add_command "node --check $(quote_path "$path")" "QuickNode filter function changed"
          ;;
        # Other files (bin/*.sh, *.md, .gcloudignore, .prettierrc, .env.example,
        # osv-scanner.toml) need no extra routing: shell scripts hit the generic
        # `*.sh → bash -n` branch above; the rest are doc/config-only.
        # bin/*.ts is routed to package quality above — the package tsconfig
        # includes `bin/**/*`, so typecheck/build cover those entrypoints.
      esac
      ;;
    terraform/*)
      add_surface "terraform"
      add_terraform_validate_commands "terraform" "Terraform changed"
      add_checklist "docs/pr-checklists/terraform-cloudrun.md" "Terraform/Cloud Run path changed"
      ;;
    cloudbuild.yaml)
      add_surface "cloudbuild"
      add_checklist "docs/pr-checklists/terraform-cloudrun.md" "Cloud Build config changed"
      add_package_quality_commands "@mento-protocol/metrics-bridge" "metrics bridge build context changed"
      ;;
    .gcloudignore)
      add_surface "cloudbuild"
      add_checklist "docs/pr-checklists/terraform-cloudrun.md" "Cloud Build ignore file changed"
      add_package_quality_commands "@mento-protocol/metrics-bridge" "metrics bridge build context changed"
      ;;
    .lighthouserc.cjs)
      add_surface "ui-dashboard"
      add_checklist "docs/pr-checklists/code-health.md" "Lighthouse CI budget config changed"
      add_command "node scripts/lighthouse-config.test.mjs" "Lighthouse CI budget config changed"
      ;;
    .shellcheckrc)
      # The repo-wide `./tools/trunk check --all --filter=shellcheck` command
      # itself is added by add_trunk_check_command (see
      # trunk_requires_shellcheck_full_scan) since it depends on the full
      # changed-paths set, not just this one path.
      add_surface "tooling"
      ;;
    docs/*|README.md|AGENTS.md|*/AGENTS.md|BACKLOG.md|SPEC.md)
      add_surface "docs"
      case "$path" in
        AGENTS.md|*/AGENTS.md)
          add_command "pnpm agent:context-check" "agent context standards changed"
          # A scoped AGENTS.md reaching this route (not an earlier package route)
          # is a brand-new standalone service (governance-watchdog-style) added
          # without a pnpm-workspace.yaml change. The reminder self-suppresses on
          # an edit to an existing AGENTS.md, so this only nags on a new one.
          add_adr_reminder "scoped AGENTS.md changed — ADR reminder (a new package/service likely needs an ADR)"
          ;;
        docs/context-standards.md|docs/pr-checklists/recurring-review-patterns.md)
          add_command "pnpm agent:context-check" "agent context standards changed"
          ;;
        SPEC.md)
          add_command "pnpm agent:context-check" "technical specification changed"
          ;;
        docs/*.md)
          # check-agent-context.mjs discovers canonical files across all of
          # docs/**/*.md, so any docs markdown change may affect the
          # frontmatter/staleness policy — route it through the check.
          add_command "pnpm agent:context-check" "docs markdown may be canonical (frontmatter discovery)"
          ;;
      esac
      ;;
    .agents/*|.claude/skills/*|.claude/settings.json|.codex/hooks.json)
      add_surface "agent-context"
      add_command "pnpm agent:context-check" "agent context files changed"
      ;;
    scripts/*.sh)
      add_surface "scripts"
      case "$path" in
        scripts/deploy-*.sh)
          add_command "node scripts/check-deploy-root-anchors.test.mjs" "deploy wrapper changed"
          ;;
        scripts/sanitize-terraform-output.sh)
          add_command "pnpm sanitize:test" "Terraform output sanitizer changed"
          ;;
      esac
      case "$path" in
        scripts/check-agent-quality-gate-package-scripts.sh)
          add_command "bash scripts/check-agent-quality-gate-package-scripts.sh" "agent quality gate package script validator changed"
          add_command "pnpm agent:quality-gate:test" "agent quality gate mapping changed"
          ;;
        scripts/agent-quality-gate.sh|scripts/agent-quality-gate.test.sh|scripts/check-react-doctor-diff.sh|scripts/check-react-doctor-score.sh)
          add_command "pnpm agent:quality-gate:test" "agent quality gate mapping changed"
          ;;
        scripts/agent-autoreview.sh|scripts/agent-autoreview.test.sh)
          add_command "pnpm agent:autoreview:test" "agent autoreview adapter changed"
          ;;
        scripts/dev-janitor.sh|scripts/dev-janitor.test.sh)
          add_command "bash scripts/dev-janitor.test.sh" "dev janitor script changed"
          ;;
        scripts/deploy-bridge.sh)
          add_checklist "docs/pr-checklists/terraform-cloudrun.md" "Cloud Run deploy script changed"
          add_command "pnpm agent:context-check" "Cloud Run revision suffix guard changed"
          ;;
        scripts/agent-session-end-hook.sh)
          add_command "pnpm agent:context-check" "agent SessionEnd hook changed"
          ;;
      esac
      ;;
    scripts/*.mjs|scripts/*.cjs|scripts/*.js|eslint.config.mjs)
      # `.dependency-cruiser.cjs` is handled fully by its dedicated case
      # block above (runs `pnpm code-health:deps` + `pnpm lint:scripts`).
      # Don't list it here too or `add_command` dedupes a redundant entry.
      add_surface "scripts"
      add_command "pnpm lint:scripts" "root build script changed"
      case "$path" in
        scripts/agent-autoreview.mjs|scripts/agent-autoreview-core.mjs|scripts/agent-autoreview-core.test.mjs|scripts/agent-autoreview-target-guard.test.mjs)
          add_command "pnpm agent:autoreview:test" "agent autoreview helper changed"
          ;;
        scripts/check-agent-context.mjs|scripts/check-agent-context-helpers.mjs|scripts/check-agent-context.test.mjs)
          add_command "pnpm agent:context-check" "agent context checker changed"
          add_command "node scripts/check-agent-context.test.mjs" "agent context checker changed"
          ;;
        scripts/docs-index.mjs|scripts/docs-index-helpers.mjs|scripts/docs-index.test.mjs)
          add_command "pnpm docs:index:test" "documentation catalog helper changed"
          add_command "pnpm docs:index --check" "documentation catalog helper changed"
          add_command "pnpm agent:context-check" "documentation catalog metadata contract changed"
          ;;
        scripts/docs-audit.mjs|scripts/docs-audit-helpers.mjs|scripts/docs-audit.test.mjs)
          add_command "pnpm docs:audit:test" "documentation audit planner changed"
          add_command "pnpm docs:audit --dry-run" "documentation audit planner changed"
          add_command "pnpm docs:index --check" "documentation audit planner consumes the catalog"
          ;;
        scripts/docs-garden-issue.mjs|scripts/docs-garden-issue-helpers.mjs|scripts/docs-garden-issue.test.mjs)
          add_command "pnpm docs:garden:test" "documentation garden issue automation changed"
          add_command "pnpm docs:audit --dry-run" "documentation garden issue automation consumes the planner"
          add_command "pnpm docs:index --check" "documentation garden issue automation consumes the catalog"
          ;;
        scripts/docs-navigation-eval.mjs|scripts/docs-navigation-eval-helpers.mjs|scripts/docs-navigation-eval-result.mjs|scripts/docs-navigation-eval.test.mjs)
          add_command "pnpm docs:navigation-eval:test" "documentation navigation evaluation changed"
          add_command "pnpm docs:navigation-eval -- --check-fixtures" "documentation navigation evaluation changed"
          add_command "pnpm docs:navigation-eval -- --validate docs/evals/documentation-navigation-baseline.json" "documentation navigation evaluation changed"
          add_command "pnpm docs:index --check" "documentation navigation evaluation consumes the catalog"
          ;;
        scripts/agent-context-budget.mjs|scripts/agent-context-budget.test.mjs)
          add_command "pnpm agent:context-budget:test" "agent context budget helper changed"
          add_command "pnpm agent:context-budget --strict" "agent context budget helper changed"
          ;;
        scripts/lighthouse-config.test.mjs)
          add_command "node scripts/lighthouse-config.test.mjs" "Lighthouse config assertion suite changed"
          ;;
        scripts/check-deploy-root-anchors.test.mjs)
          add_command "node scripts/check-deploy-root-anchors.test.mjs" "deploy root-anchor test changed"
          ;;
        scripts/check-adr-reminder.mjs|scripts/check-adr-reminder.test.mjs)
          add_command "pnpm adr:check:test" "ADR reminder helper changed"
          ;;
        scripts/agent-prewarm.mjs|scripts/agent-prewarm.test.mjs)
          add_command "pnpm agent:prewarm:test" "agent prewarm helper changed"
          ;;
        scripts/review-materiality.mjs|scripts/review-materiality-context.mjs|scripts/review-materiality.test.mjs)
          add_command "pnpm agent:review-materiality:test" "agent review materiality helper changed"
          ;;
        scripts/agent-issue-board.mjs|scripts/agent-issue-board.test.mjs)
          add_command "pnpm issue:board:test" "agent issue board helper changed"
          ;;
        scripts/sentry-triage-ingest.mjs|scripts/sentry-triage-ingest.test.mjs)
          add_command "pnpm sentry:ingest:test" "Sentry triage ingest helper changed"
          ;;
        scripts/sentry-triage-digest.mjs|scripts/sentry-triage-digest.test.mjs)
          add_command "pnpm sentry:digest:test" "Sentry triage digest helper changed"
          ;;
        scripts/sentry-triage-project.mjs|scripts/sentry-triage-project-core.mjs|scripts/sentry-triage-project.test.mjs)
          add_command "pnpm sentry:project:test" "Sentry triage projection helper changed"
          ;;
        scripts/sentry-autofix-select.mjs|scripts/sentry-autofix-select.test.mjs)
          add_command "pnpm sentry:autofix:select:test" "Sentry autofix select helper changed"
          ;;
        scripts/sentry-autofix-finalize.mjs|scripts/sentry-autofix-finalize.test.mjs)
          add_command "pnpm sentry:autofix:finalize:test" "Sentry autofix finalize helper changed"
          ;;
        scripts/sentry-triage-archive.mjs|scripts/sentry-triage-archive.test.mjs)
          add_command "pnpm sentry:archive:test" "Sentry triage archive helper changed"
          ;;
        scripts/pr-feedback-state.mjs|scripts/pr-feedback-state-core.mjs|scripts/pr-feedback-state.test.mjs)
          add_command "pnpm pr:feedback-state:test" "PR feedback-state helper changed"
          ;;
        scripts/pr-ready-state.mjs|scripts/pr-ready-state-core.mjs|scripts/pr-ready-state-format.mjs|scripts/pr-ready-state.test.mjs)
          add_command "pnpm pr:ready-state:test" "PR ready-state helper changed"
          ;;
        scripts/review-process-metrics.mjs|scripts/review-process-metrics.test.mjs)
          add_command "node scripts/review-process-metrics.test.mjs" "review-process metrics collector changed"
          ;;
        scripts/tf-stacks.mjs|scripts/tf-stacks.test.mjs)
          add_command "pnpm tf:test" "Terraform stack wrapper changed"
          add_terraform_validate_commands "terraform" "Terraform stack wrapper changed"
          add_terraform_validate_commands "alerts/rules" "Terraform stack wrapper changed"
          add_terraform_validate_commands "alerts/infra" "Terraform stack wrapper changed"
          add_terraform_validate_commands "aegis/terraform" "Terraform stack wrapper changed"
          add_terraform_validate_commands "governance-watchdog/infra" "Terraform stack wrapper changed"
          ;;
        scripts/terraform-fmt-check.mjs)
          add_command "node scripts/terraform-fmt-check.test.mjs" "Terraform format helper changed"
          add_command "pnpm tf:test" "Terraform format helper changed"
          add_terraform_validate_commands "terraform" "Terraform format helper changed"
          add_terraform_validate_commands "alerts/rules" "Terraform format helper changed"
          add_terraform_validate_commands "alerts/infra" "Terraform format helper changed"
          add_terraform_validate_commands "aegis/terraform" "Terraform format helper changed"
          add_terraform_validate_commands "governance-watchdog/infra" "Terraform format helper changed"
          ;;
        scripts/terraform-fmt-check.test.mjs)
          add_command "node scripts/terraform-fmt-check.test.mjs" "Terraform format helper test changed"
          ;;
        scripts/lockfile-lint.mjs|scripts/lockfile-lint.test.mjs)
          add_command "pnpm lockfile:lint:test" "lockfile lint helper changed"
          ;;
        scripts/lockfile-scope.mjs|scripts/lockfile-scope.test.mjs)
          add_command "node scripts/lockfile-scope.test.mjs" "lockfile scope helper changed"
          ;;
        scripts/pnpm-audit-high-gate.mjs|scripts/pnpm-audit-high-gate.test.mjs)
          add_command "node scripts/pnpm-audit-high-gate.test.mjs" "pnpm audit high gate changed"
          ;;
        scripts/sanitize-terraform-output.test.mjs)
          add_command "pnpm sanitize:test" "Terraform output sanitizer test changed"
          ;;
        scripts/version-skew-check.mjs|scripts/version-skew-check.test.mjs)
          add_command "pnpm skew:check:test" "version skew checker changed"
          ;;
        scripts/override-prune-report.mjs|scripts/override-prune-report.test.mjs)
          add_command "pnpm override:prune-report:test" "override prune report helper changed"
          ;;
        scripts/check-hermetic-vitest-setup.mjs|scripts/check-hermetic-vitest-setup.test.mjs)
          add_command "node scripts/check-hermetic-vitest-setup.mjs" "hermetic Vitest setup checker changed"
          add_command "node scripts/check-hermetic-vitest-setup.test.mjs" "hermetic Vitest setup checker changed"
          ;;
        scripts/check-github-action-pins.mjs)
          add_command "node scripts/check-github-action-pins.mjs" "GitHub Actions pin checker changed"
          add_command "node scripts/check-github-action-pins.test.mjs" "GitHub Actions pin checker changed"
          ;;
        scripts/check-autofix-ci-trust.mjs|scripts/check-autofix-ci-trust.test.mjs)
          add_command "node scripts/check-autofix-ci-trust.mjs" "autofix CI trust checker changed"
          add_command "node scripts/check-autofix-ci-trust.test.mjs" "autofix CI trust checker changed"
          ;;
        scripts/check-github-action-pins.test.mjs)
          add_command "node scripts/check-github-action-pins.test.mjs" "GitHub Actions pin checker test changed"
          ;;
        scripts/deploy-indexer-verify.mjs|scripts/deploy-indexer-verify.test.mjs)
          add_command "node scripts/deploy-indexer-verify.test.mjs" "indexer deploy verifier changed"
          ;;
        scripts/deploy-indexer-perf.mjs|scripts/deploy-indexer-perf.test.mjs)
          add_command "node scripts/deploy-indexer-perf.test.mjs" "indexer deploy perf helper changed"
          ;;
        scripts/alert-rules-lint.mjs|scripts/alert-rules-lint.test.mjs)
          add_command "pnpm alerts:rules:lint:test" "alert-rules lint helper changed"
          ;;
        scripts/check-pr-description.mjs|scripts/check-pr-description.test.mjs)
          add_command "node scripts/check-pr-description.test.mjs" "PR description validator changed"
          ;;
        scripts/check-deviation-threshold-drift.mjs)
          add_command "node scripts/check-deviation-threshold-drift.mjs" "deviation threshold drift checker changed"
          add_command "node scripts/check-deviation-threshold-drift.test.mjs" "deviation threshold drift checker changed"
          ;;
        scripts/check-deviation-threshold-drift.test.mjs)
          add_command "node scripts/check-deviation-threshold-drift.test.mjs" "deviation threshold drift checker test changed"
          ;;
        scripts/notify-terraform-apply.mjs|scripts/notify-terraform-apply.test.mjs)
          add_command "node scripts/notify-terraform-apply.test.mjs" "Terraform apply Slack notifier changed"
          ;;
        scripts/check-terraform-deploy-queue.mjs|scripts/check-terraform-deploy-queue.test.mjs)
          add_command "node scripts/check-terraform-deploy-queue.test.mjs" "Terraform deploy queue watcher changed"
          ;;
        scripts/redrive-onchain-deadletter.mjs|scripts/redrive-onchain-deadletter.test.mjs)
          add_command "node scripts/redrive-onchain-deadletter.test.mjs" "onchain dead-letter redrive tool changed"
          ;;
        scripts/verify-github-environment-protection.mjs|scripts/verify-github-environment-protection.test.mjs)
          add_command "node scripts/verify-github-environment-protection.test.mjs" "GitHub environment protection checker changed"
          ;;
        scripts/eslint-baseline-diff.mjs)
          # The lint wrapper. A regression here would mask all per-package
          # baseline drift. Re-run every package's lint to exercise the
          # wrapper end-to-end, plus the semantic tests covering its
          # matching/growth/absorption logic directly.
          add_command "node scripts/eslint-baseline-diff.test.mjs" "ESLint baseline wrapper changed"
          add_package_quality_commands "@mento-protocol/config" "ESLint baseline wrapper changed"
          add_package_quality_commands "@mento-protocol/ui-dashboard" "ESLint baseline wrapper changed"
          add_package_quality_commands "@mento-protocol/indexer-envio" "ESLint baseline wrapper changed"
          add_package_quality_commands "@mento-protocol/metrics-bridge" "ESLint baseline wrapper changed"
          add_package_quality_commands "@mento-protocol/integration-probes" "ESLint baseline wrapper changed"
          ;;
        scripts/eslint-baseline-diff.test.mjs)
          add_command "node scripts/eslint-baseline-diff.test.mjs" "ESLint baseline wrapper test changed"
          ;;
      esac
      ;;
    scripts/envio-schema-stubs.graphql)
      # Shared Envio SDL stub fragment, read at test time by BOTH the dashboard
      # and metrics-bridge GraphQL contract suites (and scripts/schema-diff.mjs)
      # to make buildSchema() parse. A stub-only edit can break those contract
      # tests, so route it to both packages' quality commands (test:coverage
      # runs the contract suites) — the local mirror of the ui/bridge CI
      # paths-filters. add_package_quality_commands omits test:browser, so this
      # stays light.
      add_surface "scripts"
      add_dashboard_codegen "shared Envio schema stub changed (dashboard GraphQL types read it)"
      add_package_quality_commands "@mento-protocol/ui-dashboard" "shared Envio schema stub changed (dashboard GraphQL contract test reads it)"
      add_package_quality_commands "@mento-protocol/metrics-bridge" "shared Envio schema stub changed (bridge GraphQL contract test reads it)"
      ;;
    scripts/*|tools/*)
      add_surface "scripts"
      ;;
    terraform.stacks.json)
      add_surface "terraform"
      add_command "pnpm tf:test" "Terraform stack registry changed"
      add_terraform_validate_commands "terraform" "Terraform stack registry changed"
      add_terraform_validate_commands "alerts/rules" "Terraform stack registry changed"
      add_terraform_validate_commands "alerts/infra" "Terraform stack registry changed"
      add_terraform_validate_commands "aegis/terraform" "Terraform stack registry changed"
      add_terraform_validate_commands "governance-watchdog/infra" "Terraform stack registry changed"
      add_checklist "docs/pr-checklists/ci-workflow-gates.md" "Terraform stack registry changed"
      add_checklist "docs/pr-checklists/architecture-decisions.md" "Terraform stack registry changed — a new stack likely needs an ADR"
      add_adr_reminder "Terraform stack registry changed — ADR reminder"
      ;;
    package.json)
      root_package_json_class="$(get_root_package_json_class)"
      case "$root_package_json_class" in
        root-tooling-scripts)
          ;;
        package-scripts)
          ;;
        workspace-dev-metadata)
          # devDependencies / descriptive metadata only (GitHub issue #1414):
          # reinstall + skew/lockfile lint, plus the @mento-protocol/config
          # bundle as canary (it typechecks three downstream consumers). Trunk
          # still full-scans package.json via trunk_requires_full_scan.
          add_surface "workspace"
          add_preflight_command "pnpm install --frozen-lockfile" "workspace dev metadata changed"
          add_command "pnpm skew:check" "workspace dev metadata changed"
          add_command "pnpm lockfile:lint" "workspace dev metadata changed"
          add_package_quality_commands "@mento-protocol/config" "workspace dev metadata changed (config typechecks downstream consumers as canary)"
          ;;
        *)
          add_surface "workspace"
          add_preflight_command "pnpm install --frozen-lockfile" "workspace dependency/config changed"
          add_command "bash scripts/agent-quality-gate.test.sh" "agent quality gate package script changed"
          add_workspace_quality_commands "workspace dependency/config changed"
          ;;
      esac
      ;;
    pnpm-lock.yaml)
      route_lockfile_change
      ;;
    pnpm-workspace.yaml)
      add_surface "workspace"
      add_preflight_command "pnpm install --frozen-lockfile" "workspace dependency/config changed"
      add_workspace_quality_commands "workspace dependency/config changed"
      add_adr_reminder "workspace membership/policy changed — ADR reminder (a new package likely needs an ADR)"
      ;;
    patches/*)
      add_surface "workspace"
      add_preflight_command "pnpm install --frozen-lockfile" "pnpm patch changed"
      add_workspace_quality_commands "pnpm patch changed"
      ;;
    .node-version)
      add_surface "workspace"
      add_preflight_command "pnpm install --frozen-lockfile" "Node version changed"
      add_workspace_quality_commands "Node version changed"
      ;;
    */package.json)
      # A TOP-LEVEL package.json not handled by an earlier package route is a
      # new standalone service root (governance-watchdog-style: package.json but
      # possibly no AGENTS.md). Restrict to a single path segment — a nested
      # `pkg/sub/package.json` is a workspace member covered by the
      # pnpm-workspace.yaml route, not a new top-level service. The reminder
      # self-suppresses on an edit to an existing package.json anyway.
      case "$path" in
        */*/*) ;;
        *)
          add_adr_reminder "top-level package.json changed — ADR reminder (a new package/service likely needs an ADR)"
          ;;
      esac
      ;;
  esac
done < "$changed_paths_file"

add_trunk_check_command
sort_codegen_commands
compact_turbo_quality_commands
apply_scoped_test_commands

hash_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$@"
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$@"
  else
    echo "Cannot compute sha256; please install sha256sum or shasum." >&2
    return 127
  fi
}

hash_stream() {
  hash_sha256 | awk '{ print $1 }'
}

hash_file() {
  hash_sha256 "$1" | awk '{ print $1 }'
}

write_command_plan() {
  local output_file="$1"
  local entry
  local command
  local reason
  : > "$output_file"
  for entry in "${preflight_commands[@]+"${preflight_commands[@]}"}"; do
    command="${entry%%|*}"
    reason="${entry#*|}"
    command="${command//"$changed_paths_file"/__CHANGED_PATHS_FILE__}"
    printf 'preflight\t%s\t%s\n' "$command" "$reason" >> "$output_file"
  done
  for entry in "${codegen_commands[@]+"${codegen_commands[@]}"}"; do
    command="${entry%%|*}"
    reason="${entry#*|}"
    command="${command//"$changed_paths_file"/__CHANGED_PATHS_FILE__}"
    printf 'codegen\t%s\t%s\n' "$command" "$reason" >> "$output_file"
  done
  for entry in "${post_codegen_commands[@]+"${post_codegen_commands[@]}"}"; do
    command="${entry%%|*}"
    reason="${entry#*|}"
    command="${command//"$changed_paths_file"/__CHANGED_PATHS_FILE__}"
    printf 'post-codegen\t%s\t%s\n' "$command" "$reason" >> "$output_file"
  done
  for entry in "${quality_commands[@]+"${quality_commands[@]}"}"; do
    command="${entry%%|*}"
    reason="${entry#*|}"
    # Some mapped commands consume the gate's randomized scratch path. The
    # execution path may vary between identical runs, but it is not part of
    # the validation plan and must not invalidate a fresh success stamp.
    command="${command//"$changed_paths_file"/__CHANGED_PATHS_FILE__}"
    printf 'quality\t%s\t%s\n' "$command" "$reason" >> "$output_file"
  done
}

implementation_signature() {
  local path
  for path in \
    scripts/agent-quality-gate.sh \
    scripts/agent-quality-gate.test.sh \
    scripts/check-agent-quality-gate-package-scripts.sh \
    scripts/terraform-fmt-check.mjs \
    scripts/terraform-fmt-check.test.mjs \
    turbo.json \
    .trunk/trunk.yaml; do
    if [[ -f "$path" ]]; then
      printf '%s %s\n' "$path" "$(hash_file "$path")"
    else
      printf '%s __missing__\n' "$path"
    fi
  done | hash_stream
}

validation_content_signature() {
  local path

  {
    while IFS= read -r path; do
      printf 'path %s\0' "$path"
      if [[ -f "$path" ]]; then
        printf 'file %s\0' "$(hash_file "$path")"
      elif [[ -d "$path" ]]; then
        printf 'directory\0'
      elif [[ -e "$path" ]]; then
        printf 'other\0'
      else
        printf 'deleted\0'
      fi
      git diff --no-ext-diff --summary "$base_ref" -- "$path" 2>/dev/null || true
    done < "$changed_paths_file"
  } | hash_stream
}

command_plan_file="$(make_tmpfile)"
write_command_plan "$command_plan_file"

base_oid="$(ref_oid "$base_ref")"
changed_paths_hash="$(hash_file "$changed_paths_file")"
command_plan_hash="$(hash_file "$command_plan_file")"
implementation_hash="$(implementation_signature)"
validated_content_hash="$(validation_content_signature)"

# `allow_package_script_changes` only gates the pre-run package-script refusal,
# which is a no-op unless `package_script_risk_changed`. Fold it out of the
# freshness stamp in the common no-risk case so a warm manual run (which may pass
# --allow-package-script-changes defensively) produces the SAME stamp as the
# flag-less pre-push hook — otherwise warm-then-push never skips. When package
# risk IS present, keep the real value so an unacknowledged hook run cannot reuse
# an acknowledged manual run.
if [[ "$package_script_risk_changed" == "true" ]]; then
  stamp_allow_package_scripts="${allow_package_script_changes:-false}"
else
  stamp_allow_package_scripts="n/a"
fi

stamp_line() {
  printf 'v2\tbase=%s\tpaths=%s\tplan=%s\timplementation=%s\tcontent=%s\tpackageRisk=%s\tallowPackageScripts=%s\n' \
    "$base_oid" \
    "$changed_paths_hash" \
    "$command_plan_hash" \
    "$implementation_hash" \
    "$validated_content_hash" \
    "$package_script_risk_changed" \
    "$stamp_allow_package_scripts"
}

current_stamp="$(stamp_line)"

is_fresh_success_stamp() {
  local stamped_at
  local stamped_value
  local now
  [[ -f "$success_stamp_file" ]] || return 1
  stamped_at="$(sed -n '1s/^created_at=//p' "$success_stamp_file")"
  stamped_value="$(sed -n '2s/^stamp=//p' "$success_stamp_file")"
  [[ "$stamped_value" == "$current_stamp" ]] || return 1
  [[ "$stamped_at" =~ ^[0-9]+$ ]] || return 1
  now="$(date +%s)"
  [[ $((now - stamped_at)) -le "$success_stamp_ttl_seconds" ]]
}

echo "Agent quality gate"
echo
echo "Base: ${base_ref}"
echo "Head: ${head_ref}"
echo "Mode: ${mode}"
echo
echo "Changed paths:"
sed 's/^/- /' "$changed_paths_file"
echo

if [[ ${#surfaces[@]} -gt 0 ]]; then
  echo "Detected surfaces:"
  for surface in "${surfaces[@]+"${surfaces[@]}"}"; do
    echo "- ${surface}"
  done
  echo
fi

if [[ ${#checklists[@]} -gt 0 ]]; then
  echo "Required checklist review:"
  for entry in "${checklists[@]+"${checklists[@]}"}"; do
    echo "- ${entry%%|*} (${entry#*|})"
  done
  echo
fi

echo "Mapped safe local commands:"
for entry in "${preflight_commands[@]+"${preflight_commands[@]}"}"; do
  echo "- ${entry%%|*} (${entry#*|})"
done
for entry in "${codegen_commands[@]+"${codegen_commands[@]}"}"; do
  echo "- ${entry%%|*} (${entry#*|})"
done
for entry in "${post_codegen_commands[@]+"${post_codegen_commands[@]}"}"; do
  echo "- ${entry%%|*} (${entry#*|})"
done
for entry in "${quality_commands[@]+"${quality_commands[@]}"}"; do
  echo "- ${entry%%|*} (${entry#*|})"
done
echo

if [[ "$mode" == "dry-run" ]]; then
  echo "Dry run only. Re-run with --run to execute the mapped commands."
  exit 0
fi

if [[ "$skip_if_fresh" == "1" || "$skip_if_fresh" == "true" ]]; then
  if is_fresh_success_stamp; then
    echo "Previous successful agent quality gate run is still fresh; skipping mapped commands."
    exit 0
  fi
fi

if [[ "$package_script_risk_changed" == true && "$allow_package_script_changes" != "1" && "$allow_package_script_changes" != "true" ]]; then
  echo "Refusing to run because package manifests, patches, or lockfile changed." >&2
  echo "Review package scripts, lifecycle hooks, and dependency install scripts first, then re-run with --allow-package-script-changes if they are safe." >&2
  exit 2
fi

failures=0
command_summaries=()

format_duration() {
  local seconds="$1"
  local minutes
  local remainder

  if [[ "$seconds" -lt 60 ]]; then
    echo "${seconds}s"
    return
  fi

  minutes=$((seconds / 60))
  remainder=$((seconds % 60))
  echo "${minutes}m${remainder}s"
}

filter_expected_output() {
  local skip_expected_stack=false
  while IFS= read -r line; do
    if [[ "$line" =~ ^\[(RPC_FAILURE|RPC_FAILURE_BURST|CONTRACT_REVERT|CONTRACT_REVERT_BURST)\] ]]; then
      skip_expected_stack=false
      continue
    fi

    if [[ "$line" =~ ^\[(rebalance-check|address-labels|address-labels/[^]]+|address-reports|backup|minipay/tag|minipay/sync|arkham/enrich)\] ]]; then
      skip_expected_stack=true
      continue
    fi

    if [[ "$skip_expected_stack" == true ]]; then
      case "$line" in
        Error:*|TypeError:*|"    at "*)
          continue
          ;;
        "")
          skip_expected_stack=false
          continue
          ;;
      esac
      echo "$line"
      continue
    fi

    skip_expected_stack=false
    echo "$line"
  done
}

is_autoreview_test_command() {
  local command="$1"
  case "$command" in
    *"pnpm agent:autoreview:test"*|*"bash scripts/agent-autoreview.test.sh"*)
      return 0
      ;;
  esac

  return 1
}

latest_autoreview_test_progress() {
  local output_file="$1"
  awk '
    length($0) <= 512 &&
      $0 ~ /^AUTOREVIEW_TEST_PROGRESS family=[[:alnum:]_,-]+ elapsed=[0-9]+s$/ {
      latest = $0
    }
    END {
      if (latest != "") {
        print latest
      }
    }
  ' "$output_file"
}

print_autoreview_test_timings() {
  local output_file="$1"
  # A canonical run currently has only a handful of families. Cap accepted
  # protocol lines defensively so a noisy child cannot flood otherwise-quiet
  # successful gate output while preserving each accepted marker verbatim.
  awk '
    count < 32 && length($0) <= 512 &&
      $0 ~ /^AUTOREVIEW_TEST_TIMING family=[[:alnum:]_-]+ status=(ok|failed) elapsed=[0-9]+s$/ {
      print
      count++
    }
  ' "$output_file"
}

log_duration_line() {
  # Best-effort append; a logging failure must never fail the gate itself.
  local status="$1"
  local elapsed="$2"
  local command="$3"
  local line_mode="$4"
  local ts
  local escaped_command

  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)" || return 0
  escaped_command="$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' -- "$command" 2>/dev/null)" || return 0
  printf '{"ts":"%s","command":%s,"status":"%s","seconds":%s,"mode":"%s"}\n' \
    "$ts" "$escaped_command" "$status" "$elapsed" "$line_mode" >> "$durations_file" 2>/dev/null || true
}

record_command_summary() {
  local status="$1"
  local elapsed="$2"
  local command="$3"
  command_summaries+=("${status}|${elapsed}|${command}")
  log_duration_line "$status" "$elapsed" "$command" "$mode" || true
}

print_command_summary() {
  local entry
  local status
  local elapsed
  local elapsed_and_command
  local command

  if [[ ${#command_summaries[@]} -eq 0 ]]; then
    return
  fi

  echo
  echo "Command elapsed-time summary:"
  for entry in "${command_summaries[@]+"${command_summaries[@]}"}"; do
    status="${entry%%|*}"
    elapsed_and_command="${entry#*|}"
    elapsed="${elapsed_and_command%%|*}"
    command="${elapsed_and_command#*|}"
    echo "- ${status} $(format_duration "$elapsed") ${command}"
  done
}

monitor_sequential_autoreview_progress() {
  local command="$1"
  local output_file="$2"
  local start_ts="$3"
  local done_file="$4"
  local parent_pid="$5"
  local last_heartbeat_ts="$start_ts"
  local heartbeat_interval=20
  local now_ts

  while [[ ! -e "$done_file" ]] && kill -0 "$parent_pid" 2>/dev/null; do
    sleep 1
    if [[ -e "$done_file" ]] || ! kill -0 "$parent_pid" 2>/dev/null; then
      break
    fi
    now_ts="$(date +%s)"
    if [[ $((now_ts - last_heartbeat_ts)) -ge "$heartbeat_interval" ]]; then
      printf '⏳ still running after %s:\n' "$(format_duration $((now_ts - start_ts)))"
      printf '    · %s\n' "$command"
      latest_autoreview_test_progress "$output_file"
      last_heartbeat_ts="$now_ts"
    fi
  done
}

# Portable per-command watchdog. macOS ships no timeout(1), so run the command
# in the background, arm a background killer, and reap. On timeout the command's
# whole process tree is signalled (TERM, then KILL after a short grace) so child
# processes (pnpm -> node, etc.) do not survive. Sets last_command_timed_out and
# returns the command's exit status; a signal-death is remapped to a normal
# failure code (see below). Applies per command only, never to the whole run.
run_with_timeout() {
  local command="$1"
  local cmd_pid
  local watchdog_pid
  local rc
  local timeout_marker
  local had_errexit=0

  # A `wait` that reaps a SIGTERM/SIGKILL-killed child makes bash re-raise that
  # signal at the next `return`, which would kill the gate. Run the reaping with
  # errexit off and remap any >128 status to an ordinary failure so the caller
  # (and its `if ! run_mapped_command` / status-file plumbing) just sees a fail.
  case "$-" in
    *e*) had_errexit=1 ;;
  esac
  set +e

  last_command_timed_out=false
  timeout_seq=$((timeout_seq + 1))
  # mktemp guarantees a unique path even across concurrent parallel-pool
  # subshells (BASHPID would too, but stock macOS Bash 3.2 does not define it
  # and this script runs under set -u). The file exists from the start; the
  # timeout signal is CONTENT (non-empty), written by the watchdog.
  timeout_marker="$(mktemp "$scratch_dir/command-timeout.XXXXXX")"

  bash -c "$command" &
  cmd_pid=$!
  # Run the watchdog via `bash -c` (which execs) rather than a `( … ) &`
  # subshell. A forked subshell inherits bash's saved copy of the caller's
  # redirected stdout — the descriptor bash stashes (close-on-exec) while
  # `run_with_timeout … > file` is in effect — and would hold it open, so a
  # downstream fifo/pipe reader (e.g. the sequential progress monitor) never
  # sees EOF after the gate exits. exec drops that close-on-exec fd; the command
  # above already execs, which is why only the watchdog needed this. The tree
  # kill is inlined because bash -c cannot see this script's functions.
  bash -c '
    cmd_pid="$1"
    timeout_secs="$2"
    marker="$3"
    collect_tree() {
      local pid="$1"
      local child
      while IFS= read -r child; do
        [ -n "$child" ] && collect_tree "$child"
      done < <(pgrep -P "$pid" 2>/dev/null || true)
      echo "$pid"
    }
    sleep "$timeout_secs"
    echo timeout > "$marker"
    # Snapshot the whole tree BEFORE TERM: a root that exits on TERM reparents
    # a TERM-ignoring descendant away from the tree, so a post-TERM re-walk
    # would miss it. The KILL pass targets the saved list.
    tree="$(collect_tree "$cmd_pid")"
    while IFS= read -r pid; do
      [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null
    done <<EOF_TREE
$tree
EOF_TREE
    sleep 3
    while IFS= read -r pid; do
      [ -n "$pid" ] && kill -KILL "$pid" 2>/dev/null
    done <<EOF_TREE
$tree
EOF_TREE
    exit 0
  ' _ "$cmd_pid" "$command_timeout_seconds" "$timeout_marker" >/dev/null 2>&1 &
  watchdog_pid=$!
  active_timeout_pids=("$cmd_pid" "$watchdog_pid")

  wait "$cmd_pid"
  rc=$?

  if [[ -s "$timeout_marker" ]]; then
    # A timeout fired: the watchdog is mid-escalation. Let it finish its KILL
    # pass (bounded by the 3s grace) — killing it here would strand a
    # TERM-ignoring descendant whose root already exited on TERM.
    wait "$watchdog_pid" 2>/dev/null
  else
    # Command settled first: tear the watchdog and its pending sleep down so
    # nothing leaks on normal completion.
    kill_process_tree "$watchdog_pid" TERM
    wait "$watchdog_pid" 2>/dev/null
  fi
  active_timeout_pids=()

  if [[ -s "$timeout_marker" ]]; then
    last_command_timed_out=true
    rc=1
  elif [[ "$rc" -gt 128 ]]; then
    rc=1
  fi
  rm -f "$timeout_marker"

  [[ "$had_errexit" == 1 ]] && set -e
  return "$rc"
}

# The whole-run fingerprint (current_stamp) is hashed per-command; identical
# fingerprint + command hash + within-TTL means a previous run already passed
# this exact command against unchanged content, so it can be reused.
command_stamp_key() {
  printf '%s' "$1" | hash_stream
}

# Trunk validates working-tree/repo state cheaply on every invocation, and the
# gate self-test is self-referential (it exercises this very stamp machinery),
# so both must ALWAYS re-execute — never reused, never recorded (issue #1410).
is_stamp_exempt_command() {
  case "$1" in
    "./tools/trunk check"*)
      return 0
      ;;
    "pnpm agent:quality-gate:test"|"bash scripts/agent-quality-gate.test.sh")
      return 0
      ;;
  esac
  return 1
}

# Each record is `<created_at>\t<command-hash>\t<whole-run-fingerprint>`. The
# fingerprint keeps its literal tabs and is the trailing field so it round-trips
# exactly. Fail toward rerun: any parse/IO/format ambiguity returns not-fresh.
command_stamp_is_fresh() {
  local command="$1"
  local target_key
  local now
  local line
  local created_at
  local rest
  local cmd_key
  local fingerprint

  [[ -f "$command_stamps_file" ]] || return 1
  target_key="$(command_stamp_key "$command")"
  now="$(date +%s)"

  while IFS= read -r line || [[ -n "$line" ]]; do
    created_at="${line%%$'\t'*}"
    [[ "$created_at" =~ ^[0-9]+$ ]] || continue
    rest="${line#*$'\t'}"
    cmd_key="${rest%%$'\t'*}"
    fingerprint="${rest#*$'\t'}"
    [[ "$cmd_key" == "$target_key" ]] || continue
    [[ "$fingerprint" == "$current_stamp" ]] || continue
    [[ $((now - created_at)) -le "$success_stamp_ttl_seconds" ]] || continue
    return 0
  done < "$command_stamps_file"

  return 1
}

record_command_stamp() {
  local command="$1"
  # Prerequisite outputs (node_modules, generated code) are invisible to the
  # source fingerprint, so prerequisite commands are never stamped or reused.
  # Quality-setup commands (shared-config build, Terraform init/validate) get
  # the same treatment by classification, not phase bookkeeping: the
  # --parallel 1 / --fail-fast sequential branch never enters
  # run_prerequisite_phase, so the phase flag alone would miss them there.
  [[ "${in_prerequisite_phase:-false}" == true ]] && return 0
  is_quality_setup_command "$command" && return 0
  is_stamp_exempt_command "$command" && return 0
  # Best-effort: a stamp-write failure must never fail the gate.
  printf '%s\t%s\t%s\n' \
    "$(date +%s)" "$(command_stamp_key "$command")" "$current_stamp" \
    >> "$command_stamps_file" 2>/dev/null || true
}

# Keep the file bounded: retain only entries matching this run's fingerprint and
# within the TTL, dropping the rest. Runs once before execution so even a series
# of killed runs cannot grow it without bound. A changed fingerprint (any edited
# validated file) drops every prior entry, which is exactly the required
# content-change invalidation.
prune_command_stamps() {
  [[ -f "$command_stamps_file" ]] || return 0
  local now
  local tmp
  local line
  local created_at
  local rest
  local fingerprint

  now="$(date +%s)"
  tmp="$(make_tmpfile)"
  : > "$tmp"
  while IFS= read -r line || [[ -n "$line" ]]; do
    created_at="${line%%$'\t'*}"
    [[ "$created_at" =~ ^[0-9]+$ ]] || continue
    rest="${line#*$'\t'}"
    fingerprint="${rest#*$'\t'}"
    [[ "$fingerprint" == "$current_stamp" ]] || continue
    [[ $((now - created_at)) -le "$success_stamp_ttl_seconds" ]] || continue
    printf '%s\n' "$line" >> "$tmp"
  done < "$command_stamps_file"
  mv -f "$tmp" "$command_stamps_file" 2>/dev/null || true
}

# Prints the reuse marker and records a `reused` summary entry (NOT counted as
# executed, never logged to durations) when the command was already completed by
# a previous run with the identical fingerprint. Returns 0 when reused (caller
# skips execution), 1 when the command must run.
try_reuse_command() {
  local command="$1"
  [[ "${in_prerequisite_phase:-false}" == true ]] && return 1
  is_quality_setup_command "$command" && return 1
  is_stamp_exempt_command "$command" && return 1
  command_stamp_is_fresh "$command" || return 1
  echo
  echo "↻ ${command} (fresh from previous run)"
  command_summaries+=("reused|0|${command}")
  stamp_reuse_count=$((${stamp_reuse_count:-0} + 1))
  return 0
}

run_mapped_command() {
  local command="$1"
  local output_file
  local gate_pid="$$"
  local monitor_done_file=""
  local monitor_pid=""
  local start_ts
  local end_ts
  local elapsed
  local exit_code

  if try_reuse_command "$command"; then
    return 0
  fi

  output_file="$(make_tmpfile)"
  start_ts="$(date +%s)"
  echo
  echo "+ ${command}"
  if is_autoreview_test_command "$command"; then
    monitor_done_file="${output_file}.done"
    tmpfiles+=("$monitor_done_file")
    rm -f "$monitor_done_file"
    monitor_sequential_autoreview_progress \
      "$command" "$output_file" "$start_ts" "$monitor_done_file" "$gate_pid" &
    monitor_pid="$!"
  fi
  set +e
  run_with_timeout "$command" > "$output_file" 2>&1
  exit_code=$?
  set -e
  local timed_out="$last_command_timed_out"
  if [[ -n "$monitor_pid" ]]; then
    : > "$monitor_done_file"
    wait "$monitor_pid" 2>/dev/null || true
    rm -f "$monitor_done_file"
  fi
  end_ts="$(date +%s)"
  elapsed=$((end_ts - start_ts))

  if [[ "$exit_code" -eq 0 ]]; then
    record_command_summary "ok" "$elapsed" "$command"
    record_command_stamp "$command"
    if is_autoreview_test_command "$command"; then
      print_autoreview_test_timings "$output_file"
    fi
    echo "✓ ${command} ($(format_duration "$elapsed"))"
    rm -f "$output_file"
    return 0
  fi

  record_command_summary "fail" "$elapsed" "$command"
  if [[ "$timed_out" == true ]]; then
    echo "Command timed out after ${command_timeout_seconds}s: ${command}" >&2
  else
    echo "Command failed after $(format_duration "$elapsed"): ${command}" >&2
  fi
  filter_expected_output < "$output_file" >&2
  rm -f "$output_file"
  return "$exit_code"
}

run_mapped_command_to_files() {
  local command="$1"
  local output_file="$2"
  local status_file="$3"
  local elapsed_file="$4"
  local timeout_file="$5"
  local start_ts
  local end_ts
  local elapsed
  local exit_code

  start_ts="$(date +%s)"
  set +e
  run_with_timeout "$command" > "$output_file" 2>&1
  exit_code=$?
  set -e
  end_ts="$(date +%s)"
  elapsed=$((end_ts - start_ts))

  printf '%s\n' "$exit_code" > "$status_file"
  printf '%s\n' "$elapsed" > "$elapsed_file"
  printf '%s\n' "$last_command_timed_out" > "$timeout_file"
}

is_quality_setup_command() {
  local command="$1"
  # These commands have side effects that later quality checks depend on, so
  # they must finish before the independent quality pool starts. Keep this list
  # in sync with new setup-style commands added by the path mapper above.
  case "$command" in
    "pnpm --filter @mento-protocol/config build")
      return 0
      ;;
    TF_DATA_DIR=*terraform\ -chdir=*)
      return 0
      ;;
    TF_DATA_DIR=*node\ scripts/terraform-fmt-check.mjs\ *)
      return 0
      ;;
  esac

  return 1
}

is_quality_serial_command() {
  local command="$1"
  # Dashboard browser setup/tests and size-limit must stay ordered relative to
  # each other, but they are not prerequisites for lint/typecheck/unit/knip.
  # Browser tests need Chromium installed first; browser tests build a fixture
  # app (`.next-fixture`) served by `next start` while size-limit runs a
  # build-backed Turbo task (`.next`), and both `next build` steps transiently
  # rewrite the tracked `next-env.d.ts`, so keep those two mutually exclusive.
  # The quality-gate self-test temporarily mutates tracked fixture files in
  # the current checkout, so it must also finish before source-fingerprinting
  # tests enter the parallel pool.
  case "$command" in
    "pnpm agent:quality-gate:test"|"bash scripts/agent-quality-gate.test.sh")
      return 0
      ;;
    "pnpm --filter @mento-protocol/ui-dashboard exec playwright install chromium")
      return 0
      ;;
    "pnpm exec turbo run test:browser --filter=@mento-protocol/ui-dashboard --cache=local:rw")
      return 0
      ;;
    "VERCEL_DEPLOYMENT_ID=local-quality-gate pnpm exec turbo run size-limit --filter=@mento-protocol/ui-dashboard --cache=local:rw")
      return 0
      ;;
  esac

  return 1
}

run_mapped_entries_sequential() {
  local entry
  local command
  # $1 is the phase label, accepted for call-site symmetry with the parallel
  # runner. Sequential execution does not need to print the phase.
  shift

  for entry in "$@"; do
    command="${entry%%|*}"
    if ! run_mapped_command "$command"; then
      failures=$((failures + 1))
      if [[ "$fail_fast" == "1" || "$fail_fast" == "true" ]]; then
        echo
        echo "Stopping after first failed mapped command (--fail-fast)." >&2
        print_command_summary
        log_duration_line "fail" "$(($(date +%s) - gate_start_ts))" "__run_total__" "run" || true
        exit 1
      fi
    fi
  done
}

run_mapped_entries_parallel() {
  local phase="$1"
  local max_parallel="$2"
  shift 2
  local entries=("$@")
  local total="${#entries[@]}"
  local next_index=0
  local completed=0
  local active_pids=()
  local active_commands=()
  local active_output_files=()
  local active_status_files=()
  local active_elapsed_files=()
  local active_timeout_files=()
  local next_active_pids=()
  local next_active_commands=()
  local next_active_output_files=()
  local next_active_status_files=()
  local next_active_elapsed_files=()
  local next_active_timeout_files=()
  local running_pids=()
  local entry
  local command
  local output_file
  local status_file
  local elapsed_file
  local timeout_file
  local pid
  local i
  local status
  local elapsed
  local timed_out
  local phase_start_ts last_heartbeat_ts now_ts hb_cmd
  local heartbeat_interval=20

  if [[ "$total" -eq 0 ]]; then
    return
  fi

  if [[ "$max_parallel" -le 1 || "$total" -le 1 ]]; then
    run_mapped_entries_sequential "$phase" "${entries[@]}"
    return
  fi

  echo
  echo "Running ${phase} commands with parallelism ${max_parallel}."
  phase_start_ts="$(date +%s)"
  last_heartbeat_ts="$phase_start_ts"

  while [[ "$completed" -lt "$total" ]]; do
    while [[ "$next_index" -lt "$total" && "${#active_pids[@]}" -lt "$max_parallel" ]]; do
      entry="${entries[$next_index]}"
      command="${entry%%|*}"
      next_index=$((next_index + 1))

      # A command a previous run already completed against this exact fingerprint
      # is reused without dispatching a job, so pool accounting stays intact.
      if try_reuse_command "$command"; then
        completed=$((completed + 1))
        continue
      fi

      output_file="$(make_tmpfile)"
      status_file="$(make_tmpfile)"
      elapsed_file="$(make_tmpfile)"
      timeout_file="$(make_tmpfile)"

      echo
      echo "+ ${command}"
      run_mapped_command_to_files "$command" "$output_file" "$status_file" "$elapsed_file" "$timeout_file" &
      pid="$!"

      active_pids+=("$pid")
      # Mirror into the signal-trap teardown set so an interrupt reaches the
      # worker's whole tree (the worker-local active_timeout_pids are invisible
      # to the parent's traps).
      active_worker_pids+=("$pid")
      active_commands+=("$command")
      active_output_files+=("$output_file")
      active_status_files+=("$status_file")
      active_elapsed_files+=("$elapsed_file")
      active_timeout_files+=("$timeout_file")
    done

    running_pids=()
    while IFS= read -r pid; do
      [[ -n "$pid" ]] && running_pids+=("$pid")
    done < <(jobs -pr || true)
    next_active_pids=()
    next_active_commands=()
    next_active_output_files=()
    next_active_status_files=()
    next_active_elapsed_files=()
    next_active_timeout_files=()

    for i in "${!active_pids[@]}"; do
      pid="${active_pids[$i]}"
      if list_contains_word "$pid" "${running_pids[@]+"${running_pids[@]}"}"; then
        next_active_pids+=("$pid")
        next_active_commands+=("${active_commands[$i]}")
        next_active_output_files+=("${active_output_files[$i]}")
        next_active_status_files+=("${active_status_files[$i]}")
        next_active_elapsed_files+=("${active_elapsed_files[$i]}")
        next_active_timeout_files+=("${active_timeout_files[$i]}")
        continue
      fi

      if ! wait "$pid"; then
        :
      fi

      command="${active_commands[$i]}"
      output_file="${active_output_files[$i]}"
      status_file="${active_status_files[$i]}"
      elapsed_file="${active_elapsed_files[$i]}"
      timeout_file="${active_timeout_files[$i]}"
      status="$(cat "$status_file" 2>/dev/null || echo 127)"
      elapsed="$(cat "$elapsed_file" 2>/dev/null || echo 0)"
      timed_out="$(cat "$timeout_file" 2>/dev/null || echo false)"

      if [[ "$status" -eq 0 ]]; then
        record_command_summary "ok" "$elapsed" "$command"
        record_command_stamp "$command"
        if is_autoreview_test_command "$command"; then
          print_autoreview_test_timings "$output_file"
        fi
        echo "✓ ${command} ($(format_duration "$elapsed"))"
      else
        failures=$((failures + 1))
        record_command_summary "fail" "$elapsed" "$command"
        if [[ "$timed_out" == true ]]; then
          echo "Command timed out after ${command_timeout_seconds}s: ${command}" >&2
        else
          echo "Command failed after $(format_duration "$elapsed"): ${command}" >&2
        fi
        filter_expected_output < "$output_file" >&2
      fi

      rm -f "$output_file" "$status_file" "$elapsed_file" "$timeout_file"
      completed=$((completed + 1))
    done

    active_pids=("${next_active_pids[@]+"${next_active_pids[@]}"}")
    active_worker_pids=("${next_active_pids[@]+"${next_active_pids[@]}"}")
    active_commands=("${next_active_commands[@]+"${next_active_commands[@]}"}")
    active_output_files=("${next_active_output_files[@]+"${next_active_output_files[@]}"}")
    active_status_files=("${next_active_status_files[@]+"${next_active_status_files[@]}"}")
    active_elapsed_files=("${next_active_elapsed_files[@]+"${next_active_elapsed_files[@]}"}")
    active_timeout_files=("${next_active_timeout_files[@]+"${next_active_timeout_files[@]}"}")

    # Heartbeat: while commands are still in flight, emit a periodic liveness
    # line naming what is running so a slow member is visibly working, not hung.
    if [[ ${#active_pids[@]} -gt 0 ]]; then
      now_ts="$(date +%s)"
      if [[ $((now_ts - last_heartbeat_ts)) -ge "$heartbeat_interval" ]]; then
        printf '⏳ still running after %s (%d/%d done):\n' \
          "$(format_duration $((now_ts - phase_start_ts)))" "$completed" "$total"
        for i in "${!active_commands[@]}"; do
          hb_cmd="${active_commands[$i]}"
          printf '    · %s\n' "$hb_cmd"
          if is_autoreview_test_command "$hb_cmd"; then
            latest_autoreview_test_progress "${active_output_files[$i]}"
          fi
        done
        last_heartbeat_ts="$now_ts"
      fi
    fi

    # Poll on a short cadence instead of blocking on `wait -n`. A bare `wait -n`
    # only wakes on completions, so a set of concurrently-slow commands would
    # suppress the wall-clock heartbeat above; and capping `wait -n` with a timer
    # job races with fast commands that finish mid-cycle (the timer becomes the
    # next completion and delays recording them by a full interval). A 1s poll
    # detects completions within ~1s — negligible for a gate whose parallel
    # members run for seconds to minutes — and lets the heartbeat fire on time.
    if [[ ${#active_pids[@]} -gt 0 ]]; then
      sleep 1
    fi
  done
}

run_prerequisite_phase() {
  # Ordered prerequisite phases (install / codegen / quality-setup) fail-fast
  # WITHIN themselves: a failed step must stop before its dependents — and
  # before later steps in the SAME phase (e.g. `terraform validate` after a
  # failed `terraform init`) — run. This preserves the old --fail-fast
  # prerequisite behavior even though the hook now drops global --fail-fast so
  # the independent quality pool keeps going. Serialized dashboard checks and
  # the parallel pool are NOT prerequisites (serialized only for the .next
  # mutex), so they are run keep-going and still collect their own feedback.
  local previous_fail_fast="$fail_fast"
  fail_fast=true
  # Prerequisite commands (install/codegen/quality-setup) produce OUTPUTS
  # (node_modules, generated code, built packages) that the source fingerprint
  # cannot see. A stamp from a prior run must not skip them — deleting
  # node_modules between runs would otherwise start dependent commands against
  # missing inputs. They are cheap and idempotent; always re-run them.
  in_prerequisite_phase=true
  run_mapped_entries_sequential "$@"
  in_prerequisite_phase=false
  fail_fast="$previous_fail_fast"
}

run_quality_phase() {
  local setup_entries=()
  local serial_entries=()
  local parallel_entries=()
  local entry
  local command

  if [[ "$fail_fast" == "1" || "$fail_fast" == "true" || "$quality_parallelism" -le 1 ]]; then
    run_mapped_entries_sequential "quality" "${quality_commands[@]+"${quality_commands[@]}"}"
    return
  fi

  for entry in "${quality_commands[@]+"${quality_commands[@]}"}"; do
    command="${entry%%|*}"
    if is_quality_setup_command "$command"; then
      setup_entries+=("$entry")
    elif is_quality_serial_command "$command"; then
      serial_entries+=("$entry")
    else
      parallel_entries+=("$entry")
    fi
  done

  run_prerequisite_phase "quality setup" "${setup_entries[@]+"${setup_entries[@]}"}"
  run_mapped_entries_sequential "quality serialized" "${serial_entries[@]+"${serial_entries[@]}"}"
  run_mapped_entries_parallel "quality" "$quality_parallelism" "${parallel_entries[@]+"${parallel_entries[@]}"}"
}

# Drop per-command stamps that don't match this run's fingerprint (any changed
# validated file invalidates all of them) or that aged past the TTL, so the file
# stays bounded and only genuine resume candidates remain.
prune_command_stamps

run_prerequisite_phase "preflight" "${preflight_commands[@]+"${preflight_commands[@]}"}"
run_prerequisite_phase "codegen" "${codegen_commands[@]+"${codegen_commands[@]}"}"
run_prerequisite_phase "post-codegen" "${post_codegen_commands[@]+"${post_codegen_commands[@]}"}"
run_quality_phase

print_command_summary

gate_total_elapsed=$(( $(date +%s) - gate_start_ts ))

if [[ "$failures" -gt 0 ]]; then
  log_duration_line "fail" "$gate_total_elapsed" "__run_total__" "run" || true
  echo
  echo "${failures} mapped command(s) failed." >&2
  exit 1
fi

log_duration_line "ok" "$gate_total_elapsed" "__run_total__" "run" || true

echo
echo "All mapped commands passed."
if [[ "${stamp_reuse_count:-0}" -eq 0 ]]; then
  # Only a fully-executed green run earns the whole-run fast-path stamp. A
  # resumed run reused work whose real age lives in the per-command stamps;
  # re-dating it here would let --skip-if-fresh extend validation reuse past
  # the two-hour ceiling (command passes at t=0, retry succeeds at t=119m,
  # fresh whole-run stamp then covers t=238m).
  {
    printf 'created_at=%s\n' "$(date +%s)"
    printf 'stamp=%s\n' "$current_stamp"
  } > "$success_stamp_file"
fi
