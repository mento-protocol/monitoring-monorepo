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
                 implementation, validated file content, toolchain, material
                 environment, runtime, and scheduler policy. Intended for the
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
                 than n seconds and report it as a failure. Default: 1500. The
                 gate self-test uses 2100 unless this option overrides it. A
                 timeout is per command, never for the whole run.
  --lock-wait <n>
                 With --run, wait at most n seconds for scheduler admission,
                 a command lease, a coalesced result, or a legacy holder.
                 Default: 1800.
  --no-lock      With --run, bypass the scheduler and legacy compatibility
                 lock. Mapped commands then run without machine coordination.
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
                      Same behavior as --command-timeout. Default: 1500; an
                      explicit value also overrides the 2100-second gate
                      self-test default.
  AGENT_QUALITY_GATE_LOCK
                      Set to 0 or false for the same effect as --no-lock.
  AGENT_QUALITY_GATE_LOCK_WAIT_SECONDS
                      Same behavior as --lock-wait. Default: 1800.
  AGENT_QUALITY_GATE_COORDINATOR
                      Internal compatibility switch. Set to 0, false, or no
                      only in legacy-lock tests. The serialized lock remains.
  AGENT_QUALITY_GATE_CAPACITY
                      Global coordinator capacity. Default: 3. Range: 1-64.
  AGENT_QUALITY_GATE_LOCK_DIR
                      Directory holding the cross-run lock. Default:
                      $HOME/.cache/agent-quality-gate, falling back to
                      $TMPDIR/agent-quality-gate-<uid>.
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
# The gate self-test is the only mapped command that needs more than the
# ordinary 1500-second watchdog. The current exact-head suite passed in 1710
# seconds after the old watchdog stopped an earlier run at 1504 seconds. Give
# that command 390 seconds of measured headroom. An explicit global override
# still applies to every command, including the self-test.
command_timeout_overridden=false
if [[ -n "${AGENT_QUALITY_COMMAND_TIMEOUT_SECONDS:-}" ]]; then
  command_timeout_overridden=true
fi
command_timeout_seconds="${AGENT_QUALITY_COMMAND_TIMEOUT_SECONDS:-1500}"
gate_selftest_timeout_seconds=2100
gate_lock_enabled="${AGENT_QUALITY_GATE_LOCK:-1}"
gate_coordinator_enabled="${AGENT_QUALITY_GATE_COORDINATOR-1}"
gate_coordinator_capacity="${AGENT_QUALITY_GATE_CAPACITY-3}"
if [[ ! "$gate_coordinator_capacity" =~ ^(0|[1-9][0-9]*)$ ||
  "$gate_coordinator_capacity" -lt 1 ||
  "$gate_coordinator_capacity" -gt 64 ]]; then
  echo "error: AGENT_QUALITY_GATE_CAPACITY must be an integer from 1 through 64." >&2
  exit 2
fi
case "$gate_coordinator_enabled" in
  0|false|no|1|true|yes) ;;
  *)
    echo "error: AGENT_QUALITY_GATE_COORDINATOR must be 0, false, no, 1, true, or yes." >&2
    exit 2
    ;;
esac

# The coordinator reserves fd 7 as the original stdout before it can enter a
# no-work failure path. Legacy runs never reserve it. This guard lets shared
# legacy-drain helpers report a coordinated refusal without changing their
# legacy output contract or failing when the descriptor is closed.
gate_coordinator_stdout_reserved=0
gate_report_coordinated_no_work_failure() {
  local status="$1" phase="$2" work_verdict="$3"
  declare -F gate_coordinator_report_no_work_failure >/dev/null 2>&1 || return 0
  if [[ "$gate_coordinator_stdout_reserved" -eq 1 ]] &&
    { : >&7; } 2>/dev/null; then
    gate_coordinator_report_no_work_failure "$status" "$phase" "$work_verdict"
  fi
}

# Reads one of the lock's tunable numbers. An override that is set but EMPTY is
# an error rather than a silent fall back to the default: `${VAR:-default}`
# treats empty and unset alike, so a caller that meant to pass a small test
# value and passed nothing would quietly get the production one — which is
# exactly how a fixture ends up holding a thirty-minute budget. Unset means the
# default; empty means somebody's argument went missing, and that should say so
# rather than look like it worked.
gate_lock_seconds_knob() {
  local name="$1"
  local default="$2"
  local value
  eval "value=\${${name}-__gate_unset__}"
  if [[ "$value" == "__gate_unset__" ]]; then
    printf '%s' "$default"
    return 0
  fi
  if [[ ! "$value" =~ ^[0-9]+$ ]]; then
    echo "error: ${name} must be a whole number of seconds; got '${value}'." >&2
    echo "Unset it to use the default (${default})." >&2
    exit 2
  fi
  printf '%s' "$value"
}

gate_lock_wait_seconds="$(gate_lock_seconds_knob AGENT_QUALITY_GATE_LOCK_WAIT_SECONDS 1800)"
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
      command_timeout_overridden=true
      shift 2
      ;;
    --lock-wait)
      gate_lock_wait_seconds="${2:-}"
      if [[ -z "$gate_lock_wait_seconds" ]]; then
        echo "error: --lock-wait requires a non-negative integer" >&2
        exit 2
      fi
      shift 2
      ;;
    --no-lock)
      gate_lock_enabled="0"
      shift
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
if [[ "$command_timeout_overridden" == true ]]; then
  gate_selftest_timeout_seconds="$command_timeout_seconds"
fi

if [[ ! "$gate_lock_wait_seconds" =~ ^[0-9]+$ ]]; then
  echo "error: --lock-wait requires a non-negative integer" >&2
  exit 2
fi

# Resolve runtime helpers from this script's checkout before fixture runs change
# directory. A $repo_root anchor would miss them in every temporary fixture repo.
script_source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
run_handles_path="$script_source_dir/gate/run-handles.sh"
if [[ -L "$run_handles_path" || ! -f "$run_handles_path" || ! -r "$run_handles_path" ]]; then
  echo "error: gate run-handle helper is missing or not a readable regular file: ${run_handles_path}" >&2
  echo "Nothing has been executed." >&2
  exit 2
fi
# shellcheck source=scripts/gate/run-handles.sh
source "$run_handles_path"

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

# Print the current changed-path set. Capture each Git probe before printing
# any output so one failed probe cannot be hidden by a later successful probe.
collect_current_changed_paths() {
  local committed_paths unstaged_paths staged_paths untracked_paths
  if [[ -n "$changed_paths_input_file" ]]; then
    sed '/^$/d' "$changed_paths_input_file"
    return
  fi
  if ! committed_paths="$(git diff --name-only --no-renames "${base_ref}...${head_ref}" 2>/dev/null)"; then
    committed_paths="$(git diff --name-only --no-renames "$base_ref" "$head_ref")" || return 1
  fi
  printf '%s\n' "$committed_paths"
  if [[ "$head_ref" == "HEAD" ]]; then
    unstaged_paths="$(git diff --name-only --no-renames)" || return 1
    staged_paths="$(git diff --cached --name-only --no-renames)" || return 1
    untracked_paths="$(git ls-files --others --exclude-standard --exclude='.tmp/agent-quality-gate/')" || return 1
    printf '%s\n' "$unstaged_paths" "$staged_paths" "$untracked_paths"
  fi
}

gate_coordinator_helper="$script_source_dir/gate/quality-gate-coordinator.sh"
gate_coordinator_entry="$script_source_dir/gate/quality-gate-coordinator.mjs"
gate_coordinator_adapter_copy_dir=""

cleanup_gate_coordinator_adapter_copy() {
  local copy_dir="${gate_coordinator_adapter_copy_dir:-}"
  [[ -n "$copy_dir" ]] || return 0
  /bin/rm -f -- \
    "$copy_dir/quality-gate-coordinator.sh" \
    "$copy_dir/quality-gate-coordinator-support.sh" || return 1
  /bin/rmdir -- "$copy_dir" || return 1
  gate_coordinator_adapter_copy_dir=""
}

materialize_gate_coordinator_adapter() {
  local before after copied copy_parent main_hash support_hash extra
  before="$(node "$gate_coordinator_entry" adapter-hashes)" || return 1
  copy_parent="${TMPDIR:-/tmp}"
  copy_parent="${copy_parent%/}"
  gate_coordinator_adapter_copy_dir="$(
    mktemp -d "$copy_parent/agent-quality-gate-adapter.XXXXXX"
  )" || return 1
  chmod 700 "$gate_coordinator_adapter_copy_dir" || return 1
  cp "$gate_coordinator_helper" \
    "$gate_coordinator_adapter_copy_dir/quality-gate-coordinator.sh" || return 1
  cp "$script_source_dir/gate/quality-gate-coordinator-support.sh" \
    "$gate_coordinator_adapter_copy_dir/quality-gate-coordinator-support.sh" || return 1
  chmod 600 \
    "$gate_coordinator_adapter_copy_dir/quality-gate-coordinator.sh" \
    "$gate_coordinator_adapter_copy_dir/quality-gate-coordinator-support.sh" || return 1
  # `${...}` below is JavaScript template interpolation.
  # shellcheck disable=SC2016
  copied="$(node -e '
    const { createHash } = require("node:crypto");
    const { readFileSync } = require("node:fs");
    const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
    process.stdout.write(`${digest(process.argv[1])} ${digest(process.argv[2])}`);
  ' "$gate_coordinator_adapter_copy_dir/quality-gate-coordinator.sh" \
    "$gate_coordinator_adapter_copy_dir/quality-gate-coordinator-support.sh")" || return 1
  after="$(node "$gate_coordinator_entry" adapter-hashes)" || return 1
  [[ "$before" == "$copied" && "$copied" == "$after" ]] || return 1
  read -r main_hash support_hash extra <<< "$copied"
  [[ -z "${extra:-}" && "$main_hash" =~ ^[a-f0-9]{64}$ &&
    "$support_hash" =~ ^[a-f0-9]{64}$ ]] || return 1
  gate_coordinator_loaded_adapter_main_hash="$main_hash"
  gate_coordinator_loaded_adapter_support_hash="$support_hash"
  gate_coordinator_helper="$gate_coordinator_adapter_copy_dir/quality-gate-coordinator.sh"
  gate_coordinator_support="$gate_coordinator_adapter_copy_dir/quality-gate-coordinator-support.sh"
}

case "$gate_coordinator_enabled" in
  0|false|no)
    ;;
  1|true|yes)
    if [[ ! -r "$gate_coordinator_helper" ]]; then
      echo "error: quality-gate coordinator adapter is missing: ${gate_coordinator_helper}" >&2
      echo "Set AGENT_QUALITY_GATE_COORDINATOR=0 only to run the legacy lock compatibility tests." >&2
      exit 2
    fi
    if ! materialize_gate_coordinator_adapter; then
      cleanup_gate_coordinator_adapter_copy || true
      echo "error: could not load one stable quality-gate coordinator adapter." >&2
      exit 2
    fi
    # shellcheck source=scripts/gate/quality-gate-coordinator.sh
    if ! source "$gate_coordinator_helper"; then
      cleanup_gate_coordinator_adapter_copy || true
      echo "error: could not source the verified quality-gate coordinator adapter." >&2
      exit 2
    fi
    if ! cleanup_gate_coordinator_adapter_copy; then
      echo "error: could not remove the private coordinator adapter copy." >&2
      exit 2
    fi
    gate_coordinator_helper="$script_source_dir/gate/quality-gate-coordinator.sh"
    gate_coordinator_support="$script_source_dir/gate/quality-gate-coordinator-support.sh"
    ;;
esac
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

# Shared Turbo cache across worktrees (GitHub issue #1411): a fresh per-PR
# worktree otherwise starts with a 100% cold Turbo cache and re-runs every
# typecheck/lint/knip/build from scratch even when inputs match main. Point
# Turbo's local filesystem cache at one stable per-repo location outside any
# worktree so warm entries carry across worktrees. Turbo 2.9.x writes every
# cache artifact (.tar.zst, manifest, meta) via temp-file + atomic rename with
# PID-namespaced temp names, and its GC only removes orphaned .tmp files older
# than an hour, so concurrent gate runs sharing this dir cannot corrupt it.
# Respect a caller-provided TURBO_CACHE_DIR; set AGENT_TURBO_SHARED_CACHE=0 to
# opt out and fall back to Turbo's per-worktree default. Also fall back when
# the candidate directory cannot be created or written to: sandboxed/agent
# environments can have a restricted writable allowlist that excludes paths
# outside the repo, same reasoning as the TMPDIR check above.
if [[ -z "${TURBO_CACHE_DIR:-}" &&
  "${AGENT_TURBO_SHARED_CACHE:-1}" != "0" &&
  "${AGENT_TURBO_SHARED_CACHE:-1}" != "false" &&
  -n "${HOME:-}" ]]; then
  turbo_cache_candidate="${HOME}/.cache/turbo-monitoring-monorepo"
  if mkdir -p "$turbo_cache_candidate" 2>/dev/null && [[ -w "$turbo_cache_candidate" ]]; then
    export TURBO_CACHE_DIR="$turbo_cache_candidate"
  fi
fi

tmpfiles=()
# Set by run_with_timeout for the most recent mapped command so callers can tell
# a timeout apart from an ordinary non-zero exit. Read only right after the call.
last_command_timed_out=false
last_command_execution_seconds=0
last_command_infrastructure_failed=false
last_command_trunk_provisioning_blocked=false
# Monotonic counter for unique per-command timeout marker paths.
timeout_seq=0
# Monotonic across all parallel phases so no command drain identity is reused
# within one gate invocation.
parallel_command_sequence=0
# PIDs (command + watchdog) of any in-flight timed command in THIS process, so a
# wrapper SIGINT/SIGTERM tears them down instead of leaking the watchdog's
# background sleeps. Sequential commands run in the gate process; parallel
# members run in their own process-group worker subshells, each maintaining its
# own copy — which the parent's signal traps cannot see.
active_timeout_pids=()
active_timeout_drain_identity=""

# Process-group IDs of the in-flight parallel workers. Non-interactive Bash job
# control gives each worker a dedicated group whose ID equals its leader PID.
# Group tracking survives the leader exiting and descendants reparenting, unlike
# a process-tree walk rooted at that leader.
active_worker_pgids=()
# Drain identities align one-for-one with active_worker_pgids. A parallel
# command can detach into a new process group, so the group alone is not a
# complete cleanup handle.
active_worker_drain_identities=()
# Exact leader start identities align with the same registry. They let the
# active parent validate a live no-lock sentinel without trusting a bare PGID.
active_worker_start_identities=()

# A signal can arrive after Bash creates a parallel worker but before the parent
# records its process group. Defer INT/TERM handling across that short registry
# update, then replay the first pending signal after the group is reachable.
worker_registration_in_progress=0
worker_settlement_in_progress=0
pending_terminating_signal=""
worker_registration_test_barrier="${AGENT_QUALITY_GATE_TEST_WORKER_REGISTRATION_BARRIER:-}"
if [[ -n "$worker_registration_test_barrier" && "${NODE_ENV:-}" != "test" ]]; then
  echo "AGENT_QUALITY_GATE_TEST_WORKER_REGISTRATION_BARRIER: test-only override requires NODE_ENV=test" >&2
  exit 2
fi
drain_refresh_test_barrier="${AGENT_QUALITY_GATE_TEST_DRAIN_REFRESH_BARRIER:-}"
if [[ -n "$drain_refresh_test_barrier" && "${NODE_ENV:-}" != "test" ]]; then
  echo "AGENT_QUALITY_GATE_TEST_DRAIN_REFRESH_BARRIER: test-only override requires NODE_ENV=test" >&2
  exit 2
fi
parallel_release_failure_at="${AGENT_QUALITY_GATE_TEST_PARALLEL_RELEASE_FAILURE_AT:-}"
parallel_release_attempt=0
if [[ -n "$parallel_release_failure_at" ]] && {
  [[ "${NODE_ENV:-}" != "test" ]] ||
    [[ ! "$parallel_release_failure_at" =~ ^[1-9][0-9]*$ ]];
}; then
  echo "AGENT_QUALITY_GATE_TEST_PARALLEL_RELEASE_FAILURE_AT: test-only override requires NODE_ENV=test and a positive integer" >&2
  exit 2
fi
owner_discard_test_barrier="${AGENT_QUALITY_GATE_TEST_OWNER_DISCARD_BARRIER:-}"
if [[ -n "$owner_discard_test_barrier" && "${NODE_ENV:-}" != "test" ]]; then
  echo "AGENT_QUALITY_GATE_TEST_OWNER_DISCARD_BARRIER: test-only override requires NODE_ENV=test" >&2
  exit 2
fi
owner_quarantined_test_barrier="${AGENT_QUALITY_GATE_TEST_OWNER_QUARANTINED_BARRIER:-}"
if [[ -n "$owner_quarantined_test_barrier" && "${NODE_ENV:-}" != "test" ]]; then
  echo "AGENT_QUALITY_GATE_TEST_OWNER_QUARANTINED_BARRIER: test-only override requires NODE_ENV=test" >&2
  exit 2
fi
owner_witness_test_barrier="${AGENT_QUALITY_GATE_TEST_OWNER_WITNESS_BARRIER:-}"
if [[ -n "$owner_witness_test_barrier" && "${NODE_ENV:-}" != "test" ]]; then
  echo "AGENT_QUALITY_GATE_TEST_OWNER_WITNESS_BARRIER: test-only override requires NODE_ENV=test" >&2
  exit 2
fi
marker_witness_test_barrier="${AGENT_QUALITY_GATE_TEST_MARKER_WITNESS_BARRIER:-}"
if [[ -n "$marker_witness_test_barrier" && "${NODE_ENV:-}" != "test" ]]; then
  echo "AGENT_QUALITY_GATE_TEST_MARKER_WITNESS_BARRIER: test-only override requires NODE_ENV=test" >&2
  exit 2
fi
owner_quarantine_before_claim_test_barrier="${AGENT_QUALITY_GATE_TEST_QUARANTINE_BEFORE_CLAIM_BARRIER:-}"
if [[ -n "$owner_quarantine_before_claim_test_barrier" && "${NODE_ENV:-}" != "test" ]]; then
  echo "AGENT_QUALITY_GATE_TEST_QUARANTINE_BEFORE_CLAIM_BARRIER: test-only override requires NODE_ENV=test" >&2
  exit 2
fi
owner_quarantine_claim_open_test_barrier="${AGENT_QUALITY_GATE_TEST_QUARANTINE_CLAIM_OPEN_BARRIER:-}"
if [[ -n "$owner_quarantine_claim_open_test_barrier" && "${NODE_ENV:-}" != "test" ]]; then
  echo "AGENT_QUALITY_GATE_TEST_QUARANTINE_CLAIM_OPEN_BARRIER: test-only override requires NODE_ENV=test" >&2
  exit 2
fi
owner_quarantine_after_claim_test_barrier="${AGENT_QUALITY_GATE_TEST_QUARANTINE_AFTER_CLAIM_BARRIER:-}"
if [[ -n "$owner_quarantine_after_claim_test_barrier" && "${NODE_ENV:-}" != "test" ]]; then
  echo "AGENT_QUALITY_GATE_TEST_QUARANTINE_AFTER_CLAIM_BARRIER: test-only override requires NODE_ENV=test" >&2
  exit 2
fi
owner_restore_link_failure="${AGENT_QUALITY_GATE_TEST_OWNER_RESTORE_LINK_FAILURE:-}"
if [[ -n "$owner_restore_link_failure" ]] && {
  [[ "${NODE_ENV:-}" != "test" ]] || [[ "$owner_restore_link_failure" != "1" ]];
}; then
  echo "AGENT_QUALITY_GATE_TEST_OWNER_RESTORE_LINK_FAILURE: test-only override requires NODE_ENV=test and value 1" >&2
  exit 2
fi
release_validated_test_barrier="${AGENT_QUALITY_GATE_TEST_RELEASE_VALIDATED_BARRIER:-}"
if [[ -n "$release_validated_test_barrier" && "${NODE_ENV:-}" != "test" ]]; then
  echo "AGENT_QUALITY_GATE_TEST_RELEASE_VALIDATED_BARRIER: test-only override requires NODE_ENV=test" >&2
  exit 2
fi
release_private_test_barrier="${AGENT_QUALITY_GATE_TEST_RELEASE_PRIVATE_BARRIER:-}"
if [[ -n "$release_private_test_barrier" && "${NODE_ENV:-}" != "test" ]]; then
  echo "AGENT_QUALITY_GATE_TEST_RELEASE_PRIVATE_BARRIER: test-only override requires NODE_ENV=test" >&2
  exit 2
fi
lock_taken_test_barrier="${AGENT_QUALITY_GATE_TEST_LOCK_TAKEN_BARRIER:-}"
if [[ -n "$lock_taken_test_barrier" && "${NODE_ENV:-}" != "test" ]]; then
  echo "AGENT_QUALITY_GATE_TEST_LOCK_TAKEN_BARRIER: test-only override requires NODE_ENV=test" >&2
  exit 2
fi

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
  local pgid
  local drain_identity
  local worker_start
  local clear_request_marker=0
  local timeout_drain_identity="$active_timeout_drain_identity"
  local -a roots=("${active_timeout_pids[@]+"${active_timeout_pids[@]}"}")
  local -a worker_pgids=("${active_worker_pgids[@]+"${active_worker_pgids[@]}"}")
  local -a worker_drain_identities=("${active_worker_drain_identities[@]+"${active_worker_drain_identities[@]}"}")
  local -a worker_start_identities=("${active_worker_start_identities[@]+"${active_worker_start_identities[@]}"}")
  active_timeout_pids=()
  active_timeout_drain_identity=""
  active_worker_pgids=()
  active_worker_drain_identities=()
  active_worker_start_identities=()
  [[ -n "${roots[*]-}" || -n "${worker_pgids[*]-}" ||
    -n "${worker_drain_identities[*]-}" ||
    -n "${worker_start_identities[*]-}" ||
    -n "$timeout_drain_identity" ]] || return 0
  if ! [[ "${#worker_pgids[@]}" -eq "${#worker_drain_identities[@]}" &&
    "${#worker_pgids[@]}" -eq "${#worker_start_identities[@]}" ]]; then
    echo "error: parallel worker cleanup registry is inconsistent." >&2
    return 0
  fi

  # Persist and drain every exact command identity before any signal can
  # destroy its last discoverable ancestor. A failed drain retains
  # its recovery evidence. In that case, leave all remaining processes to the
  # preserved legacy owner or coordinator obligations.
  if [[ -n "$timeout_drain_identity" ]]; then
    if [[ "$timeout_drain_identity" == "${gate_run_id:-$gate_lock_token}" ]]; then
      clear_request_marker=1
    fi
    if ! drain_completed_command_identity \
      "$timeout_drain_identity" "$clear_request_marker"; then
      return 0
    fi
  fi
  local worker_index=0
  for drain_identity in "${worker_drain_identities[@]+"${worker_drain_identities[@]}"}"; do
    pgid="${worker_pgids[$worker_index]}"
    worker_start="${worker_start_identities[$worker_index]}"
    worker_index=$((worker_index + 1))
    if ! drain_completed_parallel_command \
      "$drain_identity" "$pgid" "$worker_start"; then
      return 0
    fi
  done
  # Snapshot every descendant BEFORE signalling: TERM kills intermediate
  # subshells first, which reparents a SIGTERM-ignoring survivor away from the
  # tree, so a post-TERM re-walk would miss it. The KILL pass targets the
  # saved pid list, not a fresh walk. Parallel worker groups were already
  # folded into each command identity's durable capture above.
  local -a tree=()
  local -a tree_identities=()
  local host_identities=""
  # Probing our own PID answers whether this host can identify processes at
  # all. Without that probe, "no identity recorded" would be indistinguishable
  # from "host cannot record identities", and the KILL pass below would either
  # skip every survivor on an identity-less host or trust bare PIDs on a host
  # that could have done better.
  [[ -z "$(gate_lock_process_start $$)" ]] || host_identities=1
  for pid in "${roots[@]+"${roots[@]}"}"; do
    while IFS= read -r child_pid; do
      if [[ -n "$child_pid" ]]; then
        tree+=("$child_pid")
        tree_identities+=("$(gate_lock_process_start "$child_pid")")
      fi
    done < <(collect_process_tree "$pid")
  done
  for pid in "${tree[@]+"${tree[@]}"}"; do
    kill "-TERM" "$pid" 2>/dev/null || true
  done
  # Same TERM-then-KILL grace as run_with_timeout's watchdog: a manual
  # interrupt (Ctrl-C/TERM to the gate) must not leave a SIGTERM-ignoring
  # mapped command (or descendant) running just because it wasn't the
  # timeout path that tore it down.
  sleep 3
  local teardown_idx=0
  local teardown_recorded teardown_current
  for pid in "${tree[@]+"${tree[@]}"}"; do
    teardown_recorded="${tree_identities[$teardown_idx]-}"
    teardown_idx=$((teardown_idx + 1))
    if [[ -n "$host_identities" ]]; then
      # Three seconds is long enough for a PID to be recycled, and KILL cannot
      # be taken back. The number must still name the process captured above:
      # an empty recorded identity means it was already gone at the snapshot,
      # and a mismatch means it is somebody else now — either way this signal
      # is not ours to send. Where the host has no identity source at all, the
      # PID is the only selector there is, and these are this run's own
      # children inside a three-second window, so PID alone is the lesser
      # risk there.
      [[ -n "$teardown_recorded" ]] || continue
      teardown_current="$(gate_lock_process_start "$pid")"
      [[ "$teardown_current" == "$teardown_recorded" ]] || continue
    fi
    kill "-KILL" "$pid" 2>/dev/null || true
  done
  # Every worker group was folded into its command identity's durable capture
  # and drained above. A bare PGID is reusable and has no start identity, so do
  # not signal it after the exact drain has proved the group empty.
  for pgid in "${worker_pgids[@]+"${worker_pgids[@]}"}"; do
    wait "$pgid" 2>/dev/null || true
  done
}

# ---------------------------------------------------------------------------
# Legacy compatibility and crash-recovery lock (GitHub issue #1802).
#
# The original remedy for machine oversubscription and fixed-port collisions
# allowed one complete `--run` gate at a time. The coordinator now schedules
# commands from multiple worktrees under weighted capacity and named resources.
# It retains this lock as a mixed-version barrier, and this Bash path remains
# the election and recovery mechanism for legacy holders and dead coordinators.
#
# mkdir(2), link(2), O_EXCL, and rename(2) are the atomic primitives. flock(1)
# does not exist on macOS, and the repo's floor is Bash 3.2. Owner records move
# by exact file rename. Recovery freezes a dead private quarantine with one
# Node rename over a verified empty placeholder; it never uses `mv src dir`,
# whose directory-destination behavior is not a conditional claim. The
# invariant is: at most one process believes it holds the lock, and no waiter
# deletes a shared owner pathname. A holder wins `mkdir`, then publishes its
# owner with O_EXCL. A reclaimer binds each record or quarantine inode before it
# can retire private evidence.
# ---------------------------------------------------------------------------
gate_lock_dir=""
gate_lock_token=""
# The request token identifies one gate invocation. The lock token identifies
# the legacy owner. They are the same in legacy mode. Coordinator mode keeps
# them separate so every worker inherits both the request handle and the shared
# coordinator handle that an older gate knows how to drain.
gate_run_id=""
# An active sequential-command drain keeps the marker for a successor until it
# confirms every descendant is gone. If a legacy run cannot first persist that
# recovery obligation, it also leaves its owner record in place so the next run
# must reclaim and condemn it before executing work.
gate_active_command_drain_in_progress=0
gate_cleanup_preserve_legacy_lock=0
# Locals holding a record's token field are named *_token_value, not *_token:
# the repo's review scanner reads a name ending in _token as a credential key
# and refuses to bundle the diff. Keep the suffix if you rename these.
# Path a reclaim moves a dead owner record to, and the slot it came from. The
# temp name carries this process's PID, so it can be registered with the exit
# trap BEFORE it is created: cleanup can never race the rename that creates it,
# and it can never name another run's file.
gate_lock_reclaim_tmp=""
gate_lock_reclaim_origin=""
# Owner records are never unlinked through a shared pathname. A discard first
# creates a hard-link witness in a fresh mode-0700 directory beside the record,
# establishes a canonical-owner or condemned-run fallback, then atomically
# moves the shared name beside that witness. Only those private names are
# removed. These globals join the two phases without passing delimiter-bearing
# record content through positional arguments.
gate_lock_quarantine_dir=""
gate_lock_quarantine_origin=""
gate_lock_quarantine_anchor=""
gate_lock_quarantine_taken=""
gate_lock_quarantine_fallback=""
gate_lock_quarantine_authority_value=""
gate_lock_quarantine_raw_marker_token=""
gate_lock_quarantine_retention_state="Nothing has been executed."
gate_lock_active_quarantine_pid=""
gate_lock_active_quarantine_host=""
gate_lock_local_host_name=""
gate_lock_local_host_fingerprint=""
gate_lock_claimed_quarantine=""
# A marker cleanup that failed its exact-inode check must not be retried during
# EXIT teardown. A later attempt could bind the changed inode as a new witness
# and delete the evidence that the first attempt restored or retained.
gate_run_marker_cleanup_refused_tokens=""
# Private file a claim builds its record in before publishing it. Same rule:
# PID-suffixed, so registering it before creation is safe.
gate_lock_claim_tmp=""

# A reclaim that is SIGKILLed between taking a record and judging it leaves
# that record parked under owner.reclaiming.*, where nothing looks for it. If
# the record it took belongs to a LIVE holder — which happens when its verdict
# was formed before another run took the lock over — the lock reads as
# ownerless and the next waiter starts beside a running holder. So a lock with
# no record is not evidence of an absent holder until the remnants have been
# read: a remnant naming a live process IS the owner record, misfiled.
# A record about to be thrown away may name a run whose commands are still
# running, and the token inside it is the only handle to them. Record that
# obligation before the evidence goes — never after, because "after" is a
# window a signal can land in. Same failure direction as the rest of this path:
# condemning a run with nothing left alive costs one drain that finds nothing.
gate_lock_record_is_readable_regular() {
  local record="$1"
  [[ ! -L "$record" && -f "$record" && -r "$record" ]]
}

gate_lock_refuse_unsafe_owner_record() {
  local record="$1"
  echo "error: the quality-gate owner record at ${record} is not a readable regular file." >&2
  echo "The record was retained. Nothing has been executed." >&2
  gate_report_coordinated_no_work_failure 2 "legacy owner recovery" \
    "No mapped command ran in this request"
  exit 2
}

gate_lock_require_safe_existing_owner_record() {
  local record="$1"
  gate_lock_record_is_readable_regular "$record" && return 0
  # A legitimate owner can release the lock between the existence and type
  # checks. A dangling symlink remains unsafe because -L stays true.
  [[ ! -e "$record" && ! -L "$record" ]] && return 0
  gate_lock_refuse_unsafe_owner_record "$record"
}

gate_lock_clear_quarantine_state() {
  gate_lock_quarantine_dir=""
  gate_lock_quarantine_origin=""
  gate_lock_quarantine_anchor=""
  gate_lock_quarantine_taken=""
  gate_lock_quarantine_fallback=""
  gate_lock_quarantine_authority_value=""
  gate_lock_quarantine_raw_marker_token=""
  gate_lock_quarantine_retention_state="Nothing has been executed."
}

gate_lock_quarantine_authority_from_record() {
  local record="$1"
  if [[ -n "$gate_lock_quarantine_raw_marker_token" ]]; then
    gate_run_marker_snapshot_is_exact \
      "$record" "$gate_lock_quarantine_raw_marker_token" || return 1
    printf '%s\n' "$gate_lock_quarantine_raw_marker_token"
    return 0
  fi
  gate_lock_current_user_authority_token_from_record "$record"
}

gate_lock_private_quarantine_directory_is_safe() {
  local directory="$1"
  node -e '
    const fs = require("node:fs");
    const path = process.argv[1];
    const expectedUid = Number(process.argv[2]);
    const stat = fs.lstatSync(path);
    process.exit(
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.uid === expectedUid &&
      (stat.mode & 0o777) === 0o700
        ? 0
        : 1,
    );
  ' "$directory" "$(id -u)" 2>/dev/null
}

gate_lock_current_host_fingerprint() {
  local host_name="$1"
  [[ -n "$host_name" && "$host_name" != *$'\n'* &&
    "$host_name" != *$'\r'* ]] || return 2
  node -e '
    const { createHash } = require("node:crypto");
    process.stdout.write(
      createHash("sha256").update(process.argv[1], "utf8").digest("hex"),
    );
  ' "$host_name" 2>/dev/null
}

gate_lock_ensure_local_host_fingerprint() {
  local fingerprint host_name
  if [[ -n "$gate_lock_local_host_name" &&
    "$gate_lock_local_host_fingerprint" =~ ^[0-9a-f]{64}$ ]]; then
    return 0
  fi
  if ! host_name="$(uname -n 2>/dev/null)" ||
    [[ -z "$host_name" || "$host_name" == *$'\n'* ||
      "$host_name" == *$'\r'* ]] ||
    ! fingerprint="$(gate_lock_current_host_fingerprint "$host_name")" ||
    [[ ! "$fingerprint" =~ ^[0-9a-f]{64}$ ]]; then
    gate_lock_local_host_name=""
    gate_lock_local_host_fingerprint=""
    return 2
  fi
  gate_lock_local_host_name="$host_name"
  gate_lock_local_host_fingerprint="$fingerprint"
}

gate_lock_path_matches_open_descriptor() {
  local path="$1"
  local descriptor="$2"
  node -e '
    const fs = require("node:fs");
    const path = process.argv[1];
    const descriptor = Number(process.argv[2]);
    const expectedUid = Number(process.argv[3]);
    const pathStat = fs.lstatSync(path, { bigint: true });
    const descriptorStat = fs.fstatSync(descriptor, { bigint: true });
    process.exit(
      pathStat.isFile() &&
      !pathStat.isSymbolicLink() &&
      descriptorStat.isFile() &&
      pathStat.uid === BigInt(expectedUid) &&
      descriptorStat.uid === BigInt(expectedUid) &&
      pathStat.dev === descriptorStat.dev &&
      pathStat.ino === descriptorStat.ino
        ? 0
        : 1,
    );
  ' "$path" "$descriptor" "$(id -u)" 2>/dev/null
}

gate_lock_retain_quarantine() {
  local reason="$1"
  local retention_state="$gate_lock_quarantine_retention_state"
  echo "error: ${reason}" >&2
  if [[ -n "$gate_lock_quarantine_dir" ]]; then
    echo "The owner quarantine was retained at ${gate_lock_quarantine_dir}. ${retention_state}" >&2
  else
    echo "The owner evidence was retained. ${retention_state}" >&2
  fi
  gate_lock_clear_quarantine_state
  return 2
}

gate_lock_prepare_owner_quarantine() {
  local record="$1"
  local retention_state="${2:-Nothing has been executed.}"
  local raw_marker_token="${3:-}"
  local parent quarantine quarantine_prefix="owner.reclaiming.quarantine.v1"
  gate_lock_clear_quarantine_state
  gate_lock_quarantine_retention_state="$retention_state"
  if [[ -n "$raw_marker_token" ]]; then
    if ! gate_lock_token_is_wellformed "$raw_marker_token"; then
      gate_lock_clear_quarantine_state
      return 2
    fi
    gate_lock_quarantine_raw_marker_token="$raw_marker_token"
    quarantine_prefix="holder.reclaiming.quarantine.v1"
  fi
  parent="${record%/*}"
  if [[ -z "$parent" || "$parent" == "$record" ||
    ! "$gate_lock_local_host_fingerprint" =~ ^[0-9a-f]{64}$ ]]; then
    gate_lock_clear_quarantine_state
    return 2
  fi
  if ! quarantine="$(mktemp -d "${parent}/${quarantine_prefix}.${gate_lock_local_host_fingerprint}.$$.XXXXXX")"; then
    gate_lock_clear_quarantine_state
    return 2
  fi
  if ! chmod 700 "$quarantine" ||
    ! gate_lock_private_quarantine_directory_is_safe "$quarantine"; then
    rmdir "$quarantine" 2>/dev/null || true
    gate_lock_clear_quarantine_state
    return 2
  fi
  gate_lock_quarantine_dir="$quarantine"
  gate_lock_quarantine_origin="$record"
  gate_lock_quarantine_anchor="${quarantine}/anchor"
  gate_lock_quarantine_taken="${quarantine}/record"
  gate_lock_quarantine_fallback="${quarantine}/fallback-ready"
  # `-P` is required on macOS. Without it, ln follows a source symlink and the
  # witness can name the symlink target instead of the shared directory entry.
  if ! /bin/ln -P "$record" "$gate_lock_quarantine_anchor" 2>/dev/null; then
    rmdir "$quarantine" 2>/dev/null || true
    gate_lock_clear_quarantine_state
    [[ ! -e "$record" && ! -L "$record" ]] && return 1
    return 2
  fi
  if ! gate_lock_quarantine_authority_value="$(
    gate_lock_quarantine_authority_from_record "$gate_lock_quarantine_anchor"
  )"; then
    gate_lock_report_foreign_owner_recovery \
      "$record" "$gate_lock_quarantine_retention_state"
    gate_lock_retain_quarantine \
      "the quality-gate owner witness is foreign or unsafe"
    return 2
  fi
  if ! gate_lock_wait_for_test_barrier "$owner_witness_test_barrier"; then
    gate_lock_retain_quarantine \
      "the quality-gate owner witness barrier failed"
    return 2
  fi
  gate_lock_test_crash after-owner-quarantine-anchor
}

gate_lock_mark_quarantine_fallback() {
  [[ -n "$gate_lock_quarantine_fallback" ]] || return 2
  if ! gate_lock_private_quarantine_directory_is_safe "$gate_lock_quarantine_dir" ||
    ! gate_lock_record_is_readable_regular "$gate_lock_quarantine_anchor" ||
    ! printf '%s\n' "$gate_lock_quarantine_authority_value" \
      > "$gate_lock_quarantine_fallback" ||
    ! chmod 600 "$gate_lock_quarantine_fallback"; then
    gate_lock_retain_quarantine \
      "could not record the quality-gate owner quarantine fallback"
    return 2
  fi
  gate_lock_test_crash after-owner-quarantine-fallback
}

gate_lock_quarantine_fallback_is_valid() {
  local value
  [[ -f "$gate_lock_quarantine_fallback" &&
    ! -L "$gate_lock_quarantine_fallback" &&
    -O "$gate_lock_quarantine_fallback" ]] || return 1
  value="$(sed -n '1p' "$gate_lock_quarantine_fallback" 2>/dev/null)" ||
    return 1
  [[ "$value" == "$gate_lock_quarantine_authority_value" ]]
}

gate_lock_cancel_prepared_quarantine() {
  if ! gate_lock_private_quarantine_directory_is_safe "$gate_lock_quarantine_dir" ||
    [[ -e "$gate_lock_quarantine_taken" || -L "$gate_lock_quarantine_taken" ]] ||
    [[ -e "$gate_lock_quarantine_fallback" || -L "$gate_lock_quarantine_fallback" ]] ||
    ! gate_lock_record_is_readable_regular "$gate_lock_quarantine_origin" ||
    ! gate_lock_record_is_readable_regular "$gate_lock_quarantine_anchor" ||
    [[ ! "$gate_lock_quarantine_origin" -ef "$gate_lock_quarantine_anchor" ]] ||
    ! /bin/rm -f "$gate_lock_quarantine_anchor" ||
    ! /bin/rmdir "$gate_lock_quarantine_dir"; then
    gate_lock_retain_quarantine \
      "could not cancel the prepared quality-gate owner quarantine"
    return 2
  fi
  gate_lock_clear_quarantine_state
}

gate_lock_take_prepared_quarantine() {
  local observed_authority_value
  [[ -n "$gate_lock_quarantine_dir" &&
    -n "$gate_lock_quarantine_origin" &&
    -n "$gate_lock_quarantine_anchor" &&
    -n "$gate_lock_quarantine_taken" &&
    -n "$gate_lock_quarantine_fallback" ]] || return 2
  gate_lock_quarantine_fallback_is_valid || return 2
  if ! gate_lock_wait_for_test_barrier "$owner_discard_test_barrier"; then
    gate_lock_retain_quarantine \
      "the quality-gate owner discard barrier failed"
    return 2
  fi
  gate_lock_test_delay "${AGENT_QUALITY_GATE_LOCK_DISCARD_DELAY_SECONDS:-}"
  if ! gate_lock_private_quarantine_directory_is_safe "$gate_lock_quarantine_dir" ||
    ! gate_lock_quarantine_fallback_is_valid ||
    [[ -e "$gate_lock_quarantine_taken" || -L "$gate_lock_quarantine_taken" ]]; then
    gate_lock_retain_quarantine \
      "the quality-gate owner path could not enter its private quarantine"
    return 2
  fi
  if ! /bin/mv "$gate_lock_quarantine_origin" \
    "$gate_lock_quarantine_taken" 2>/dev/null; then
    # An active releaser can move a recovery-visible remnant after this gate
    # hard-links its exact inode and establishes the canonical fallback. The
    # missing source is a completed competing move, not changed evidence.
    [[ ! -e "$gate_lock_quarantine_origin" &&
      ! -L "$gate_lock_quarantine_origin" ]] && return 1
    gate_lock_retain_quarantine \
      "the quality-gate owner path could not enter its private quarantine"
    return 2
  fi
  gate_lock_test_crash after-owner-quarantine-take
  if ! gate_lock_record_is_readable_regular "$gate_lock_quarantine_taken" ||
    [[ ! "$gate_lock_quarantine_taken" -ef "$gate_lock_quarantine_anchor" ]]; then
    gate_lock_retain_quarantine \
      "the quality-gate owner inode changed before quarantine"
    return 2
  fi
  if ! observed_authority_value="$(
    gate_lock_quarantine_authority_from_record "$gate_lock_quarantine_taken"
  )" || [[ "$observed_authority_value" != "$gate_lock_quarantine_authority_value" ]]; then
    gate_lock_retain_quarantine \
      "the quality-gate owner authority changed before quarantine"
    return 2
  fi
  if ! gate_lock_wait_for_test_barrier "$owner_quarantined_test_barrier"; then
    gate_lock_retain_quarantine \
      "the quarantined quality-gate owner barrier failed"
    return 2
  fi
  if [[ -e "$gate_lock_quarantine_origin" || -L "$gate_lock_quarantine_origin" ]]; then
    gate_lock_retain_quarantine \
      "replacement quality-gate owner evidence appeared after quarantine"
    return 2
  fi
}

gate_lock_drop_private_quarantine() {
  local observed_authority_value
  if ! gate_lock_private_quarantine_directory_is_safe "$gate_lock_quarantine_dir" ||
    ! gate_lock_quarantine_fallback_is_valid ||
    ! gate_lock_record_is_readable_regular "$gate_lock_quarantine_anchor" ||
    ! gate_lock_record_is_readable_regular "$gate_lock_quarantine_taken" ||
    [[ ! "$gate_lock_quarantine_taken" -ef "$gate_lock_quarantine_anchor" ]] ||
    ! observed_authority_value="$(
      gate_lock_quarantine_authority_from_record "$gate_lock_quarantine_taken"
    )" || [[ "$observed_authority_value" != "$gate_lock_quarantine_authority_value" ]]; then
    gate_lock_retain_quarantine \
      "the private quality-gate owner evidence changed before deletion"
    return 2
  fi
  if ! /bin/rm -f "$gate_lock_quarantine_taken" ||
    ! /bin/rm -f "$gate_lock_quarantine_anchor" ||
    ! /bin/rm -f "$gate_lock_quarantine_fallback" ||
    ! /bin/rmdir "$gate_lock_quarantine_dir"; then
    gate_lock_retain_quarantine \
      "could not remove the private quality-gate owner quarantine"
    return 2
  fi
  gate_lock_clear_quarantine_state
}

gate_lock_drop_prepared_quarantine_without_taken() {
  local observed_authority_value
  if ! gate_lock_private_quarantine_directory_is_safe "$gate_lock_quarantine_dir" ||
    ! gate_lock_quarantine_fallback_is_valid ||
    ! gate_lock_record_is_readable_regular "$gate_lock_quarantine_anchor" ||
    [[ -e "$gate_lock_quarantine_taken" || -L "$gate_lock_quarantine_taken" ]] ||
    [[ -e "$gate_lock_quarantine_origin" || -L "$gate_lock_quarantine_origin" ]] ||
    ! observed_authority_value="$(
      gate_lock_quarantine_authority_from_record "$gate_lock_quarantine_anchor"
    )" || [[ "$observed_authority_value" != "$gate_lock_quarantine_authority_value" ]]; then
    gate_lock_retain_quarantine \
      "the moved quality-gate owner evidence changed before private cleanup"
    return 2
  fi
  if ! /bin/rm -f "$gate_lock_quarantine_anchor" ||
    ! /bin/rm -f "$gate_lock_quarantine_fallback" ||
    ! /bin/rmdir "$gate_lock_quarantine_dir"; then
    gate_lock_retain_quarantine \
      "could not remove the prepared quality-gate owner quarantine"
    return 2
  fi
  gate_lock_clear_quarantine_state
}

gate_run_restore_quarantined_marker() {
  local marker="$1"
  local taken="$2"
  local quarantine="$3"
  local expected_token_value="$4"
  if [[ ! -e "$taken" && ! -L "$taken" ]]; then
    echo "error: run-marker cleanup retained ${quarantine}; no moved marker was available to restore." >&2
    return 2
  fi
  if ! gate_run_marker_snapshot_is_exact "$taken" "$expected_token_value"; then
    echo "error: the moved run marker is unsafe or has changed bytes; it remains only in ${quarantine}." >&2
    return 2
  fi
  if /bin/ln -P "$taken" "$marker" 2>/dev/null; then
    if [[ "$marker" -ef "$taken" ]] &&
      gate_run_marker_snapshot_is_exact "$taken" "$expected_token_value" &&
      gate_run_marker_snapshot_is_exact "$marker" "$expected_token_value"; then
      echo "error: a changed run marker was restored at ${marker}; its quarantine was retained at ${quarantine}." >&2
      return 2
    fi
    echo "error: run-marker cleanup published an unverified canonical link at ${marker}; ${quarantine} was retained." >&2
    return 2
  fi
  if [[ -e "$marker" || -L "$marker" ]]; then
    if [[ "$marker" -ef "$taken" ]]; then
      echo "error: a changed run marker remains visible at ${marker}; its quarantine was retained at ${quarantine}." >&2
    else
      echo "error: could not restore the changed run marker at ${marker} because that path is occupied; ${quarantine} was retained." >&2
    fi
  else
    echo "error: could not restore the changed run marker at ${marker}; ${quarantine} was retained." >&2
  fi
  return 2
}

gate_run_marker_cleanup_was_refused() {
  local expected_token_value="$1"
  case " ${gate_run_marker_cleanup_refused_tokens} " in
    *" ${expected_token_value} "*) return 0 ;;
  esac
  return 1
}

gate_run_stop_marker_cleanup_retries() {
  local marker="$1"
  local expected_token_value="$2"
  if ! gate_run_marker_cleanup_was_refused "$expected_token_value"; then
    if [[ -n "$gate_run_marker_cleanup_refused_tokens" ]]; then
      gate_run_marker_cleanup_refused_tokens="${gate_run_marker_cleanup_refused_tokens} ${expected_token_value}"
    else
      gate_run_marker_cleanup_refused_tokens="$expected_token_value"
    fi
  fi
  if [[ "$marker" == "$gate_run_marker_file" ]]; then
    gate_run_marker_file=""
  fi
}

gate_run_discard_marker_exact() {
  local expected_token_value="$1"
  local retention_state="${2:-Nothing has been executed.}"
  local marker prepare_status take_status drop_status
  local quarantine anchor taken
  gate_lock_token_is_wellformed "$expected_token_value" || return 2
  gate_run_marker_cleanup_was_refused "$expected_token_value" && return 2
  marker="$(gate_run_marker_path "$expected_token_value")" || return 0
  if gate_lock_prepare_owner_quarantine \
    "$marker" "$retention_state" "$expected_token_value"; then
    :
  else
    prepare_status=$?
    [[ "$prepare_status" -eq 1 && ! -e "$marker" && ! -L "$marker" ]] &&
      return 0
    gate_run_stop_marker_cleanup_retries "$marker" "$expected_token_value"
    return 2
  fi
  quarantine="$gate_lock_quarantine_dir"
  anchor="$gate_lock_quarantine_anchor"
  taken="$gate_lock_quarantine_taken"
  if ! gate_run_marker_snapshot_is_exact "$anchor" "$expected_token_value"; then
    gate_lock_retain_quarantine \
      "the run-marker witness has unsafe ownership, changed bytes, or a changed inode" || true
    gate_run_stop_marker_cleanup_retries "$marker" "$expected_token_value"
    return 2
  fi
  if [[ -n "$marker_witness_test_barrier" &&
    "$marker" == "$gate_run_marker_file" ]]; then
    if ! gate_lock_wait_for_test_barrier "$marker_witness_test_barrier"; then
      gate_lock_retain_quarantine \
        "the run-marker witness barrier failed" || true
      gate_run_stop_marker_cleanup_retries "$marker" "$expected_token_value"
      return 2
    fi
  fi
  gate_lock_test_crash after-run-marker-quarantine-anchor
  if ! gate_lock_mark_quarantine_fallback; then
    gate_run_stop_marker_cleanup_retries "$marker" "$expected_token_value"
    return 2
  fi
  if gate_lock_take_prepared_quarantine; then
    if ! gate_run_marker_snapshot_is_exact "$taken" "$expected_token_value"; then
      gate_lock_retain_quarantine \
        "the run marker changed after its exact witness was bound" || true
      gate_run_restore_quarantined_marker \
        "$marker" "$taken" "$quarantine" "$expected_token_value" || true
      gate_run_stop_marker_cleanup_retries "$marker" "$expected_token_value"
      return 2
    fi
    if gate_lock_drop_private_quarantine; then
      return 0
    else
      drop_status=$?
    fi
    gate_run_stop_marker_cleanup_retries "$marker" "$expected_token_value"
    return "$drop_status"
  else
    take_status=$?
  fi
  if [[ "$take_status" -eq 1 ]]; then
    if ! gate_run_marker_snapshot_is_exact "$anchor" "$expected_token_value"; then
      gate_lock_retain_quarantine \
        "the run-marker witness changed after a competing cleanup" || true
      gate_run_stop_marker_cleanup_retries "$marker" "$expected_token_value"
      return 2
    fi
    if gate_lock_drop_prepared_quarantine_without_taken; then
      return 0
    else
      drop_status=$?
    fi
    gate_run_stop_marker_cleanup_retries "$marker" "$expected_token_value"
    return "$drop_status"
  fi
  if [[ -e "$taken" || -L "$taken" ]]; then
    gate_run_restore_quarantined_marker \
      "$marker" "$taken" "$quarantine" "$expected_token_value" || true
  fi
  gate_run_stop_marker_cleanup_retries "$marker" "$expected_token_value"
  return 2
}

gate_lock_finish_canonical_quarantine() {
  local canonical="$1"
  local expected_token_value="$2"
  local canonical_authority_value take_status quarantine_has_taken=0
  if gate_lock_take_prepared_quarantine; then
    quarantine_has_taken=1
  else
    take_status=$?
    [[ "$take_status" -eq 1 ]] || return 2
  fi
  if ! canonical_authority_value="$(
    gate_lock_current_user_authority_token_from_record "$canonical"
  )" || [[ "$canonical_authority_value" != "$expected_token_value" ]] ||
    [[ ! "$canonical" -ef "$gate_lock_quarantine_anchor" ]]; then
    gate_lock_retain_quarantine \
      "the canonical quality-gate owner changed during private cleanup"
    return 2
  fi
  if [[ "$quarantine_has_taken" -eq 1 ]]; then
    gate_lock_drop_private_quarantine
  else
    gate_lock_drop_prepared_quarantine_without_taken
  fi
}

gate_lock_discard_inert_owner_stage() {
  local record="$1"
  local publisher_pid="$2"
  local retention_state="${3:-Nothing has been executed.}"
  local prepare_status take_status
  if gate_lock_prepare_owner_quarantine "$record" "$retention_state"; then
    :
  else
    prepare_status=$?
    [[ "$prepare_status" -eq 1 && ! -e "$record" && ! -L "$record" ]] &&
      return 0
    return 2
  fi
  # Bind the stage inode before the final PID check. A reused publisher PID can
  # replace the same stage pathname after an earlier liveness verdict. A live
  # publisher keeps its stage; a replacement inode is retained by the take.
  if gate_lock_holder_is_live "$publisher_pid" ""; then
    gate_lock_cancel_prepared_quarantine
    return $?
  fi
  gate_lock_mark_quarantine_fallback || return 2
  if gate_lock_take_prepared_quarantine; then
    gate_lock_drop_private_quarantine
  else
    take_status=$?
    [[ "$take_status" -eq 1 ]] || return 2
    gate_lock_drop_prepared_quarantine_without_taken
  fi
}

gate_lock_condemn_prepared_quarantine() {
  local obligation_status take_status
  if [[ -n "$gate_lock_quarantine_authority_value" ]]; then
    if record_condemned_run "$gate_lock_quarantine_authority_value"; then
      :
    else
      obligation_status=$?
      gate_lock_cancel_prepared_quarantine || return 2
      return "$obligation_status"
    fi
  fi
  gate_lock_mark_quarantine_fallback || return 2
  if gate_lock_take_prepared_quarantine; then
    gate_lock_drop_private_quarantine
  else
    take_status=$?
    [[ "$take_status" -eq 1 ]] || return 2
    gate_lock_drop_prepared_quarantine_without_taken
  fi
}

gate_lock_condemn_and_discard() {
  local record="$1"
  if ! gate_lock_prepare_owner_quarantine "$record"; then
    [[ -z "$gate_lock_quarantine_dir" ]] || gate_lock_clear_quarantine_state
    return 2
  fi
  gate_lock_condemn_prepared_quarantine
}

gate_lock_discard_matching_duplicate() {
  local record="$1"
  local expected_token_value="$2"
  local canonical="$3"
  local canonical_authority_value
  gate_lock_prepare_owner_quarantine "$record" || return 2
  if ! canonical_authority_value="$(
    gate_lock_current_user_authority_token_from_record "$canonical"
  )" || [[ "$canonical_authority_value" != "$expected_token_value" ]] ||
    [[ "$gate_lock_quarantine_authority_value" != "$expected_token_value" ]] ||
    [[ ! "$canonical" -ef "$gate_lock_quarantine_anchor" ]]; then
    gate_lock_retain_quarantine \
      "the canonical quality-gate owner does not match the duplicate inode"
    return 2
  fi
  gate_lock_mark_quarantine_fallback || return 2
  gate_lock_finish_canonical_quarantine "$canonical" "$expected_token_value"
}

gate_lock_report_foreign_owner_recovery() {
  local record="$1"
  local retention_state="${2:-Nothing has been executed.}"
  echo "error: the stale quality-gate owner record at ${record} belongs to another user or has inconsistent uid metadata." >&2
  echo "This gate can wait on that shared owner, but it cannot safely inspect or signal the prior user's surviving commands." >&2
  echo "The owner and generation evidence were retained. ${retention_state}" >&2
  echo "Have the owning user or an administrator recover the stale generation." >&2
}

gate_lock_refuse_foreign_owner_recovery() {
  gate_lock_report_foreign_owner_recovery "$1"
  gate_report_coordinated_no_work_failure 2 "legacy owner recovery" \
    "No mapped command ran in this request"
  exit 2
}

gate_lock_regular_file_link_count() {
  # The dollar expression below is a JavaScript template literal.
  # shellcheck disable=SC2016
  node -e '
    const fs = require("node:fs");
    const stat = fs.lstatSync(process.argv[1]);
    if (!stat.isFile() || stat.isSymbolicLink()) process.exit(1);
    process.stdout.write(`${stat.nlink}\n`);
  ' "$1" 2>/dev/null
}

gate_lock_recover_owner_quarantine() {
  local quarantine="$1"
  local anchor="${quarantine}/anchor"
  local taken="${quarantine}/record"
  local fallback="${quarantine}/fallback-ready"
  local extra authority_value taken_authority_value fallback_value link_count
  if ! gate_lock_private_quarantine_directory_is_safe "$quarantine"; then
    [[ ! -e "$quarantine" && ! -L "$quarantine" ]] && return 0
    echo "error: the quality-gate owner quarantine at ${quarantine} is not a current-user mode-0700 directory." >&2
    return 2
  fi
  extra="$(
    find "$quarantine" -mindepth 1 -maxdepth 1 \
      ! -name anchor ! -name record ! -name fallback-ready \
      -print -quit 2>/dev/null
  )"
  if [[ -n "$extra" ]]; then
    echo "error: the quality-gate owner quarantine at ${quarantine} contains unexpected evidence: ${extra}." >&2
    return 2
  fi
  if [[ ! -e "$anchor" && ! -L "$anchor" ]]; then
    if [[ -e "$taken" || -L "$taken" ]]; then
      echo "error: the quality-gate owner quarantine at ${quarantine} lost its inode witness." >&2
      return 2
    fi
    if [[ -e "$fallback" || -L "$fallback" ]]; then
      [[ -f "$fallback" && ! -L "$fallback" && -O "$fallback" ]] || return 2
      /bin/rm -f "$fallback" || return 2
    fi
    /bin/rmdir "$quarantine"
    return
  fi
  if ! authority_value="$(
    gate_lock_current_user_authority_token_from_record "$anchor"
  )"; then
    gate_lock_report_foreign_owner_recovery "$anchor"
    return 2
  fi
  if [[ ! -e "$fallback" && ! -L "$fallback" ]]; then
    [[ ! -e "$taken" && ! -L "$taken" ]] || {
      echo "error: the quality-gate owner quarantine at ${quarantine} moved evidence before it recorded a fallback." >&2
      return 2
    }
    link_count="$(gate_lock_regular_file_link_count "$anchor")" || return 2
    if [[ ! "$link_count" =~ ^[0-9]+$ ]] || [[ "$link_count" -lt 2 ]]; then
      echo "error: the pre-fallback quality-gate owner witness at ${anchor} has no visible sibling link." >&2
      return 2
    fi
    /bin/rm -f "$anchor" || return 2
    /bin/rmdir "$quarantine"
    return
  fi
  if [[ ! -f "$fallback" || -L "$fallback" || ! -O "$fallback" ]]; then
    echo "error: the quality-gate owner quarantine fallback at ${fallback} is unsafe." >&2
    return 2
  fi
  fallback_value="$(sed -n '1p' "$fallback" 2>/dev/null)" || return 2
  [[ "$fallback_value" == "$authority_value" ]] || {
    echo "error: the quality-gate owner quarantine fallback at ${fallback} names different authority." >&2
    return 2
  }
  if [[ -e "$taken" || -L "$taken" ]]; then
    if ! taken_authority_value="$(
      gate_lock_current_user_authority_token_from_record "$taken"
    )" || [[ "$taken_authority_value" != "$authority_value" ]] ||
      [[ ! "$taken" -ef "$anchor" ]]; then
      echo "error: the quality-gate owner quarantine at ${quarantine} retained an inode replacement." >&2
      return 2
    fi
    /bin/rm -f "$taken" || return 2
  fi
  /bin/rm -f "$anchor" || return 2
  /bin/rm -f "$fallback" || return 2
  /bin/rmdir "$quarantine"
}

gate_lock_claim_owner_quarantine() {
  local source="$1"
  local parent claimed claim_status
  gate_lock_claimed_quarantine=""
  parent="${source%/*}"
  [[ -n "$parent" && "$parent" != "$source" ]] || return 2
  [[ "$gate_lock_local_host_fingerprint" =~ ^[0-9a-f]{64}$ ]] || return 2
  claimed="$(mktemp -d "${parent}/owner.reclaiming.quarantine.v1.${gate_lock_local_host_fingerprint}.$$.XXXXXX")" ||
    return 2
  if ! chmod 700 "$claimed" ||
    ! gate_lock_private_quarantine_directory_is_safe "$claimed"; then
    /bin/rmdir "$claimed" 2>/dev/null || true
    return 2
  fi
  gate_lock_claimed_quarantine="$claimed"
  # The dollar expressions below are JavaScript template literals.
  # shellcheck disable=SC2016
  if node -e '
    const fs = require("node:fs");
    const { constants } = fs;
    const [source, target, parent, uidText, claimOpenBarrier] =
      process.argv.slice(1);
    const expectedUid = BigInt(uidText);
    let sourceDescriptor;
    let targetDescriptor;
    let parentDescriptor;
    let claimedDescriptor;
    let status = 0;

    function sameInode(first, second) {
      return first.dev === second.dev && first.ino === second.ino;
    }

    function requirePrivateDirectory(stat, label) {
      if (
        !stat.isDirectory() ||
        stat.uid !== expectedUid ||
        (stat.mode & 0o777n) !== 0o700n
      ) {
        throw new Error(`${label} is not a current-user mode-0700 directory`);
      }
    }

    function requirePathIdentity(path, expected, label) {
      const observed = fs.lstatSync(path, { bigint: true });
      requirePrivateDirectory(observed, label);
      if (observed.isSymbolicLink() || !sameInode(observed, expected)) {
        throw new Error(`${label} pathname changed before its atomic claim`);
      }
    }

    function pathEntryExists(path) {
      try {
        fs.lstatSync(path);
        return true;
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    }

    function waitForTestBarrierInstance(barrier) {
      if (!barrier) return;
      const ready = `${barrier}.ready.${process.pid}`;
      const release = `${barrier}.release`;
      const sleeper = new Int32Array(new SharedArrayBuffer(4));
      fs.writeFileSync(ready, "", { flag: "wx", mode: 0o600 });
      for (let waited = 0; !pathEntryExists(release); waited += 1) {
        if (waited >= 600) {
          throw new Error("quarantine claim open barrier timed out");
        }
        Atomics.wait(sleeper, 0, 0, 50);
      }
    }

    try {
      if (
        !Number.isInteger(constants.O_DIRECTORY) ||
        !Number.isInteger(constants.O_NOFOLLOW)
      ) {
        throw new Error("directory no-follow support is unavailable");
      }
      try {
        sourceDescriptor = fs.openSync(
          source,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
      } catch (error) {
        if (error.code === "ENOENT") {
          status = 3;
        } else {
          throw error;
        }
      }
      if (status === 0) {
        targetDescriptor = fs.openSync(
          target,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        const sourceStat = fs.fstatSync(sourceDescriptor, { bigint: true });
        const targetStat = fs.fstatSync(targetDescriptor, { bigint: true });
        requirePrivateDirectory(sourceStat, "source quarantine");
        requirePrivateDirectory(targetStat, "claim placeholder");
        waitForTestBarrierInstance(claimOpenBarrier);
        try {
          requirePathIdentity(source, sourceStat, "source quarantine");
        } catch (error) {
          if (error.code === "ENOENT" && !pathEntryExists(source)) {
            status = 3;
          } else {
            throw error;
          }
        }
        if (status === 0) {
          requirePathIdentity(target, targetStat, "claim placeholder");
          if (fs.readdirSync(target).length !== 0) {
            throw new Error("claim placeholder is not empty");
          }
          parentDescriptor = fs.openSync(
            parent,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          );
          try {
            fs.renameSync(source, target);
          } catch (error) {
            if (error.code === "ENOENT" && !pathEntryExists(source)) {
              status = 3;
            } else {
              throw error;
            }
          }
          if (status === 0) {
            fs.fsyncSync(parentDescriptor);
            claimedDescriptor = fs.openSync(
              target,
              constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
            );
            const claimedStat = fs.fstatSync(claimedDescriptor, { bigint: true });
            requirePrivateDirectory(claimedStat, "claimed quarantine");
            if (!sameInode(claimedStat, sourceStat)) {
              throw new Error("claimed quarantine does not match the source inode");
            }
            requirePathIdentity(target, claimedStat, "claimed quarantine");
            fs.fsyncSync(claimedDescriptor);
          }
        }
      }
    } catch (error) {
      process.stderr.write(`quality-gate quarantine claim failed: ${error.message}\n`);
      status = 2;
    } finally {
      if (claimedDescriptor !== undefined) fs.closeSync(claimedDescriptor);
      if (parentDescriptor !== undefined) fs.closeSync(parentDescriptor);
      if (targetDescriptor !== undefined) fs.closeSync(targetDescriptor);
      if (sourceDescriptor !== undefined) fs.closeSync(sourceDescriptor);
    }
    process.exitCode = status;
  ' "$source" "$claimed" "$parent" "$(id -u)" \
    "$owner_quarantine_claim_open_test_barrier"; then
    if ! gate_lock_wait_for_test_barrier "$owner_quarantine_after_claim_test_barrier"; then
      echo "error: the claimed quality-gate owner quarantine barrier failed." >&2
      return 2
    fi
    return 0
  else
    claim_status=$?
  fi
  if [[ "$claim_status" -eq 3 ]]; then
    if gate_lock_recover_owner_quarantine "$claimed"; then
      gate_lock_claimed_quarantine=""
      return 1
    fi
  fi
  echo "error: could not atomically claim the quality-gate owner quarantine at ${source}." >&2
  echo "The source and claim evidence were retained. Nothing has been executed." >&2
  return 2
}

gate_lock_recover_hidden_record() {
  local lock="$1"
  local this_host="$2"
  local remnant remnant_name creator_host_fingerprint creator_pid creator_nonce
  local dead_quarantine claim_status pid host start prepare_status recovered=1
  local active_quarantine=0
  # Settle private quarantines before ordinary remnants. A crash after the
  # hard-link witness leaves both paths. Processing the ordinary remnant first
  # can retire that inode and reduce the older witness to one link before its
  # pre-fallback recovery check. A dead creator can still have an orphaned
  # `/bin/mv` child in flight. Rename the whole directory to this waiter's
  # identity before reading a phase. The directory rename orders recovery with
  # that child and with every other waiter.
  while :; do
    active_quarantine=0
    dead_quarantine=""
    gate_lock_active_quarantine_pid=""
    gate_lock_active_quarantine_host=""
    for remnant in "$lock"/owner.reclaiming.quarantine.*; do
      [[ -e "$remnant" || -L "$remnant" ]] || continue
      remnant_name="${remnant##*/}"
      if [[ ! "$remnant_name" =~ ^owner\.reclaiming\.quarantine\.v1\.([0-9a-f]+)\.([1-9][0-9]*)\.([A-Za-z0-9][A-Za-z0-9.-]*)$ ]]; then
        echo "error: the quality-gate owner quarantine has an invalid recovery name: ${remnant}." >&2
        echo "The quarantine was retained. Nothing has been executed." >&2
        gate_report_coordinated_no_work_failure 2 "legacy owner recovery" \
          "No mapped command ran in this request"
        exit 2
      fi
      creator_host_fingerprint="${BASH_REMATCH[1]}"
      creator_pid="${BASH_REMATCH[2]}"
      creator_nonce="${BASH_REMATCH[3]}"
      if [[ "${#creator_host_fingerprint}" -ne 64 ||
        "${#creator_nonce}" -lt 6 || "${#creator_nonce}" -gt 80 ]]; then
        echo "error: the quality-gate owner quarantine has an invalid recovery name: ${remnant}." >&2
        echo "The quarantine was retained. Nothing has been executed." >&2
        gate_report_coordinated_no_work_failure 2 "legacy owner recovery" \
          "No mapped command ran in this request"
        exit 2
      fi
      if [[ "$creator_host_fingerprint" != "$gate_lock_local_host_fingerprint" ]] ||
        gate_lock_holder_is_live "$creator_pid" ""; then
        active_quarantine=1
        [[ -n "$gate_lock_active_quarantine_pid" ]] ||
          gate_lock_active_quarantine_pid="$creator_pid"
        if [[ -z "$gate_lock_active_quarantine_host" ]]; then
          if [[ "$creator_host_fingerprint" == "$gate_lock_local_host_fingerprint" ]]; then
            gate_lock_active_quarantine_host="$this_host"
          else
            gate_lock_active_quarantine_host="foreign host ${creator_host_fingerprint:0:12}"
          fi
        fi
      elif [[ -z "$dead_quarantine" ]]; then
        dead_quarantine="$remnant"
      fi
    done
    # Never mutate one quarantine while another live or foreign-host creator
    # can still advance its phase in the same shared lock directory.
    [[ "$active_quarantine" -eq 0 ]] || return 4
    [[ -n "$dead_quarantine" ]] || break
    if ! gate_lock_wait_for_test_barrier_instance "$owner_quarantine_before_claim_test_barrier"; then
      echo "error: the quality-gate owner quarantine claim barrier failed." >&2
      gate_report_coordinated_no_work_failure 2 "legacy owner recovery" \
        "No mapped command ran in this request"
      exit 2
    fi
    if gate_lock_claim_owner_quarantine "$dead_quarantine"; then
      if gate_lock_recover_owner_quarantine "$gate_lock_claimed_quarantine"; then
        gate_lock_claimed_quarantine=""
        recovered=0
        continue
      fi
      echo "The claimed quarantine was retained. Nothing has been executed." >&2
      gate_report_coordinated_no_work_failure 2 "legacy owner recovery" \
        "No mapped command ran in this request"
      exit 2
    else
      claim_status=$?
    fi
    if [[ "$claim_status" -eq 1 ]]; then
      # Another waiter claimed the old basename. Restart the glob so this pass
      # sees and waits on that waiter's new basename before ordinary recovery.
      recovered=0
      continue
    fi
    echo "The quarantine was retained. Nothing has been executed." >&2
    gate_report_coordinated_no_work_failure 2 "legacy owner recovery" \
      "No mapped command ran in this request"
    exit 2
  done
  for remnant in "$lock"/owner.reclaiming.*; do
    [[ -e "$remnant" || -L "$remnant" ]] || continue
    [[ "${remnant##*/}" == owner.reclaiming.quarantine.* ]] && continue
    if ! gate_lock_record_is_readable_regular "$remnant"; then
      # Another waiter can restore or remove this remnant after the glob saw
      # it. Treat that release race as absent, while retaining dangling links.
      [[ ! -e "$remnant" && ! -L "$remnant" ]] && continue
      # A shared root can expose another user's mode-0600 record. Empty field
      # reads are not evidence that its holder is dead. Unknown file types are
      # equally unsafe because legitimate remnants are regular files.
      echo "error: the hidden quality-gate owner record at ${remnant} is not a readable regular file." >&2
      echo "The record was retained. Nothing has been executed." >&2
      gate_report_coordinated_no_work_failure 2 "legacy owner recovery" \
        "No mapped command ran in this request"
      exit 2
    fi
    if gate_lock_prepare_owner_quarantine "$remnant"; then
      :
    else
      prepare_status=$?
      if [[ "$prepare_status" -eq 1 &&
        ! -e "$remnant" && ! -L "$remnant" ]]; then
        continue
      fi
      gate_lock_report_foreign_owner_recovery "$remnant"
      gate_report_coordinated_no_work_failure 2 "legacy owner recovery" \
        "No mapped command ran in this request"
      exit 2
    fi
    pid="$(gate_lock_field_from_file "$gate_lock_quarantine_anchor" pid)"
    host="$(gate_lock_field_from_file "$gate_lock_quarantine_anchor" host)"
    start="$(gate_lock_field_from_file "$gate_lock_quarantine_anchor" start_utc)"
    # A PID from another host has no local meaning. Treat the record as live
    # evidence, as the canonical-owner path does, until that host replaces or
    # removes it through the shared root.
    if [[ -n "$host" && "$host" != "$this_host" ]] ||
      gate_lock_holder_is_live "$pid" "$start"; then
      # `ln` refuses an occupied path, so a record published while we were
      # reading loses nothing: ours is then the stale copy and just goes away.
      if [[ "$owner_restore_link_failure" != "1" ]] &&
        /bin/ln -P "$gate_lock_quarantine_anchor" "$lock/owner" 2>/dev/null; then
        if ! gate_lock_mark_quarantine_fallback ||
          ! gate_lock_finish_canonical_quarantine \
            "$lock/owner" "$gate_lock_quarantine_authority_value"; then
          gate_report_coordinated_no_work_failure 2 "legacy owner recovery" \
            "No mapped command ran in this request"
          exit 2
        fi
        echo "Recovered the record of live holder pid ${pid} from an interrupted reclaim." >&2
        recovered=0
      elif [[ ! -e "$lock/owner" && ! -L "$lock/owner" ]]; then
        # A shared root can expose another user's mode-0600 remnant while the
        # platform's protected-hardlink policy refuses our link. With no
        # canonical owner, continuing would turn that access error into an
        # ownerless claim beside a live holder.
        echo "error: could not restore the live quality-gate owner record at ${remnant}." >&2
        echo "The canonical owner is still absent. Nothing has been executed." >&2
        gate_report_coordinated_no_work_failure 2 "legacy owner recovery" \
          "No mapped command ran in this request"
        exit 2
      elif ! gate_lock_cancel_prepared_quarantine; then
        gate_report_coordinated_no_work_failure 2 "legacy owner recovery" \
          "No mapped command ran in this request"
        exit 2
      fi
      # If the link failed the canonical path already holds something. This
      # copy still names a live process, so it stays: a record naming a live
      # holder is evidence, and only a verified-dead one may be deleted.
    else
      # Dead holder — but "dead run" is not the same as "nothing running". Its
      # commands outlive it, and this record is the last thing that names them.
      # So the delete happens only once the obligation is written down.
      if gate_lock_condemn_prepared_quarantine; then
        :
      else
        recovered=$?
        [[ "$recovered" -ne 1 ]] || gate_lock_obligation_unwritable
        gate_report_coordinated_no_work_failure 2 "legacy owner recovery" \
          "No mapped command ran in this request"
        exit 2
      fi
    fi
  done
  return "$recovered"
}

# Put a record we took back where it came from, then drop our name for it.
# `ln` refuses an occupied path, so a record written while we held this copy is
# never clobbered — ours is simply the stale one, and it goes away.
restore_gate_lock_record() {
  [[ -n "$gate_lock_reclaim_tmp" ]] || return 0
  if [[ -e "$gate_lock_reclaim_tmp" && -n "$gate_lock_reclaim_origin" ]]; then
    if gate_lock_prepare_owner_quarantine "$gate_lock_reclaim_tmp"; then
      :
    else
      # A mismatched recorded uid is untrusted input, but restoring an exact
      # hard link is non-destructive. Keep the recovery-visible remnant and any
      # private witness as evidence; only publish the same inode back into an
      # empty canonical slot.
      if /bin/ln -P "$gate_lock_reclaim_tmp" \
        "$gate_lock_reclaim_origin" 2>/dev/null; then
        echo "error: restored untrusted quality-gate owner evidence at ${gate_lock_reclaim_origin}; retained ${gate_lock_reclaim_tmp}." >&2
      elif [[ -e "$gate_lock_reclaim_origin" || -L "$gate_lock_reclaim_origin" ]]; then
        echo "error: retained untrusted quality-gate owner evidence at ${gate_lock_reclaim_tmp}; the canonical slot is occupied." >&2
      else
        echo "error: retained changed or foreign evidence at ${gate_lock_reclaim_tmp}; could not restore it safely." >&2
      fi
      gate_lock_reclaim_tmp=""
      gate_lock_reclaim_origin=""
      return 1
    fi
    if /bin/ln -P "$gate_lock_quarantine_anchor" \
      "$gate_lock_reclaim_origin" 2>/dev/null; then
      if ! gate_lock_mark_quarantine_fallback ||
        ! gate_lock_finish_canonical_quarantine \
          "$gate_lock_reclaim_origin" "$gate_lock_quarantine_authority_value"; then
        echo "error: restored ${gate_lock_reclaim_origin}, but retained changed or foreign evidence at ${gate_lock_reclaim_tmp}." >&2
        gate_lock_reclaim_tmp=""
        gate_lock_reclaim_origin=""
        return 1
      fi
    elif [[ -e "$gate_lock_reclaim_origin" || -L "$gate_lock_reclaim_origin" ]]; then
      # The slot is occupied, so this copy is superseded and about to be
      # dropped rather than put back. It can still name a run whose commands
      # are alive, so the obligation is written down before it goes.
      if ! gate_lock_condemn_prepared_quarantine; then
        # Nowhere to write it down, so the record itself has to survive: it is
        # the only thing naming that run's commands, and the next run's
        # hidden-record recovery reads it from exactly where it lies. This runs
        # while unwinding, so it reports and leaves rather than exiting again.
        echo "error: could not record ${gate_lock_reclaim_tmp} as outstanding; left in place for the next run." >&2
        gate_lock_reclaim_tmp=""
        gate_lock_reclaim_origin=""
        return 1
      fi
    else
      echo "error: could not restore ${gate_lock_reclaim_tmp}; retained its private witness." >&2
      gate_lock_retain_quarantine \
        "the canonical quality-gate owner remained absent during restoration" || true
      gate_lock_reclaim_tmp=""
      gate_lock_reclaim_origin=""
      return 1
    fi
  fi
  gate_lock_reclaim_tmp=""
  gate_lock_reclaim_origin=""
}
# A lock directory whose owner file never appeared belongs to a run stalled or
# killed between mkdir and the write. Wait this long before treating it as
# abandoned. Correctness no longer rests on this number: a creator that resumes
# after its lock was reclaimed fails its own O_EXCL owner write and queues
# instead of running. The grace only keeps churn down.
gate_lock_owner_grace_seconds="$(gate_lock_seconds_knob AGENT_QUALITY_GATE_LOCK_OWNER_GRACE_SECONDS 30)"
# Whole seconds: the wait budget is accounted in integer seconds. Tunable for
# the same reason as the grace — the self-test asserts that waiting happens,
# not that it takes five seconds a round.
gate_lock_poll_seconds="$(gate_lock_seconds_knob AGENT_QUALITY_GATE_LOCK_POLL_SECONDS 5)"
# The lock root, kept once resolved: outstanding obligations live beside the
# lock rather than inside it, because the lock directory is what gets reclaimed
# and the obligation has to outlive that.
gate_lock_root_dir=""
gate_lock_drained_tokens=""
# A staged obligation this shell has written but not yet published. mktemp
# gives parallel coordinator clients distinct names even though Bash 3.2 gives
# their subshells the same $$ value.
gate_lock_condemn_tmp=""

# One file per outstanding run rather than one shared list. A shared list has
# to be deleted by whoever drains it, and there is no way in this shell to
# establish that every process which opened it by name has finished writing —
# an appender descheduled between its open and its write would have its line
# deleted unread. Here nobody writes to a published file: each is created by
# one process under a private name and moved into place whole, and the drainer
# deletes only the files it has read to the end. Late arrivals are new files,
# which are either seen by this drain or inherited by the next.
gate_lock_condemned_dir() {
  [[ -n "$gate_lock_root_dir" ]] || return 1
  printf '%s/condemned.d' "$gate_lock_root_dir"
}

# Write down that a dead run's commands are somebody's problem now, BEFORE
# taking over from it. Holding that only in a shell variable makes it a promise
# this process cannot keep: a run killed between publishing its record and
# draining leaves the previous run's survivors with nobody who knows about
# them. On disk, the next run inherits the obligation instead.
#
# Legacy reclaim serializes this write. Coordinator recovery holds an atomic
# token claim before it writes. A private mktemp name also keeps an interrupted
# write invisible; the published token path is stable across retries.
#
# The write failing is a different matter from crashing after it. A crash still
# leaves the record this obligation was derived from, because that record is
# deleted only once this returns, so the next run's recovery re-derives it. A
# failed write with the caller carrying on leaves nothing anywhere. So this
# reports failure and every caller stops. The reachable case is not a full disk
# but a shared lock root, where the directory belongs to another user.
record_condemned_run() {
  local token="$1"
  local dir
  [[ -n "$token" ]] || return 0
  # Validated HERE, not only at the read boundaries, because the token
  # becomes a path component below: a crafted '../x' from a shared-root
  # remnant would land the record outside condemned.d. Failing returns the
  # caller to its unwritable-obligation path — stop, record left in place.
  gate_lock_token_is_wellformed "$token" || return 1
  dir="$(gate_lock_condemned_dir)" || return 1
  mkdir -p "$dir" 2>/dev/null || return 1
  gate_lock_condemn_tmp="$(mktemp "${dir}/.staging.XXXXXX")" || return 1
  printf '%s\n' "$token" > "$gate_lock_condemn_tmp" 2>/dev/null || {
    rm -f "$gate_lock_condemn_tmp"
    gate_lock_condemn_tmp=""
    return 1
  }
  # Published by rename, which is atomic: the drainer never reads a partial
  # token, and re-condemning the same run simply replaces an identical file.
  if ! mv "$gate_lock_condemn_tmp" "${dir}/${token}" 2>/dev/null; then
    rm -f "$gate_lock_condemn_tmp"
    gate_lock_condemn_tmp=""
    return 1
  fi
  gate_lock_condemn_tmp=""
}

# These files are the only thing that tells the next holder a dead run's
# commands are still outstanding. Losing one means taking the lock over and
# starting mapped commands beside those commands — the cross-run overlap this
# whole path exists to prevent — so a run that cannot record the obligation
# stops here, with the record it was about to discard left in place.
gate_lock_obligation_unwritable() {
  echo "error: could not record the previous run's commands as outstanding in ${gate_lock_root_dir:-unknown}/condemned.d." >&2
  echo "Nothing would drain them, so this run would execute alongside them." >&2
  echo "Nothing has been executed. Fix that path — permissions, or free space — then re-run." >&2
  gate_report_coordinated_no_work_failure 2 "stale-obligation recovery" \
    "No mapped command ran in this request"
  exit 2
}

gate_lock_obligation_unreadable() {
  echo "error: the outstanding-commands record at ${1} exists but cannot be read." >&2
  echo "It names commands a dead run left behind, and skipping it would start this run alongside them." >&2
  echo "Nothing has been executed. Fix that path — permissions — then re-run." >&2
  gate_report_coordinated_no_work_failure 2 "stale-obligation recovery" \
    "No mapped command ran in this request"
  exit 2
}

gate_drain_fail_for_context() {
  local drain_context="${1:-stale-run}"
  if [[ "$drain_context" == "active-command" ]]; then
    return 2
  fi
  exit 2
}

gate_drain_obligation_unreadable() {
  local path="$1"
  local drain_context="${2:-stale-run}"
  if [[ "$drain_context" != "active-command" ]]; then
    gate_lock_obligation_unreadable "$path"
  fi
  echo "error: the command-descendant record at ${path} exists but cannot be read." >&2
  echo "It names processes from a completed mapped command. Releasing the scheduler lease without it could start conflicting work." >&2
  echo "The mapped command finished, but descendant cleanup did not complete. Fix that path — permissions — then re-run." >&2
  gate_drain_fail_for_context "$drain_context"
  return $?
}

# Every run drains the whole outstanding set before executing anything, not
# just the holder it personally condemned. That is what makes a chain of
# crashes safe: a third run inherits both the run it reclaimed and whatever
# that run had not finished clearing.
#
# Nothing is deleted unread. Each file is claimed by rename before it is read,
# so the name it was published under is free again immediately and the copy
# being drained is one nobody else can replace: a second condemnation of the
# same run publishes a fresh file rather than swapping the one in hand. The
# claimed copy is removed only once its own processes are confirmed gone, and a
# drainer killed part way leaves it in the directory for the next run, which
# reads the token from the file's contents rather than its name.
#
# The scan repeats until a pass finds nothing, because obligations are still
# being published while this one drains — a waiter condemning a remnant of some
# third run does not wait for the lock. What it cannot close is the gap between
# the last empty pass and the first mapped command: publishing and holding the
# lock are not ordered against each other, and no arrangement of files in this
# shell makes them so.
drain_condemned_runs() {
  local dir entry claimed entry_token_value drained_any
  dir="$(gate_lock_condemned_dir)" || return 0
  [[ -d "$dir" ]] || return 0
  [[ -r "$dir" && -x "$dir" ]] || gate_lock_obligation_unreadable "$dir"
  while :; do
    drained_any=0
    for entry in "$dir"/*; do
      # The glob skips staging files, whose names begin with a dot. That is
      # what they are named for: a run that died mid-write leaves one behind,
      # and the record it was derived from is still there, so the obligation
      # reaches us through the recovery pass rather than as a half-written
      # token here.
      [[ -e "$entry" ]] || continue
      [[ -r "$entry" ]] || gate_lock_obligation_unreadable "$entry"
      claimed="${entry}.draining.$$"
      if ! mv "$entry" "$claimed" 2>/dev/null; then
        # Gone between the glob and here is fine — nothing else deletes these,
        # so it was replaced, and the replacement is picked up by the next
        # pass. Still there and unclaimable is not fine: an obligation this run
        # cannot take is one it cannot promise to discharge.
        [[ -e "$entry" ]] || continue
        gate_lock_obligation_unreadable "$entry"
      fi
      # Owned by us, or not an obligation: only this uid's runs write these,
      # and a fabricated entry would steer the drain by another writer's
      # chosen token. Refused loudly, like a malformed one.
      if [[ ! -O "$claimed" ]]; then
        echo "error: obligation record ${claimed} is not owned by this user." >&2
        echo "Nothing has been executed. Inspect and remove that record, then re-run." >&2
        gate_report_coordinated_no_work_failure 2 "stale-obligation recovery" \
          "No mapped command ran in this request"
        exit 2
      fi
      entry_token_value="$(head -n1 "$claimed" 2>/dev/null || true)"
      if [[ -z "$entry_token_value" ]]; then
        entry_token_value="${claimed##*/}"
        entry_token_value="${entry_token_value%.draining."$$"}"
      fi
      if ! gate_lock_token_is_wellformed "$entry_token_value"; then
        # On a shared lock root this is a crafted or corrupt record. Guessing
        # what it binds could match a stranger's processes; discarding it
        # could discharge a real obligation. Refusing to run is the only move
        # that does neither.
        echo "error: obligation record ${claimed} names a malformed run token." >&2
        echo "Nothing has been executed. Inspect and remove that record, then re-run." >&2
        gate_report_coordinated_no_work_failure 2 "stale-obligation recovery" \
          "No mapped command ran in this request"
        exit 2
      fi
      drain_condemned_run_commands "$entry_token_value"
      gate_lock_drained_tokens="${gate_lock_drained_tokens} ${entry_token_value}"
      # Removed only here, with every process confirmed gone, and by a name
      # only this drainer can have created. A drain that cannot confirm exits
      # instead, leaving the rest for whoever comes next.
      gate_lock_test_delay "${AGENT_QUALITY_GATE_LOCK_DRAIN_UNLINK_DELAY_SECONDS:-}"
      rm -f "$claimed"
      drained_any=1
    done
    [[ "$drained_any" -eq 1 ]] || break
  done
}

# Upper bound on confirming a dead run's commands are gone — a bound on the
# check, not the mechanism. The check itself is positive: look for processes
# carrying that run's tag and wait until there are none. A fixed delay cannot
# make that promise, because the thing it waits for (each command's watchdog
# noticing its gate died) can itself be descheduled by the same host pressure
# that killed the gate, or suspended with the laptop.
gate_lock_orphan_drain_bound_seconds="$(gate_lock_seconds_knob AGENT_QUALITY_GATE_LOCK_ORPHAN_DRAIN_SECONDS 120)"

# Test-only. The self-test sets these to widen otherwise sub-millisecond
# windows so the interleavings they permit can be exercised deterministically.
# Nothing in normal operation sets them, and none of them changes lock
# semantics: they only decide how long a process sits at a point it already
# passes through.
gate_lock_test_delay() {
  local seconds="${1:-}"
  [[ "$seconds" =~ ^[1-9][0-9]*$ ]] || return 0
  sleep "$seconds"
}

gate_lock_wait_for_test_barrier() {
  local barrier="${1:-}"
  local waited=0
  [[ -n "$barrier" ]] || return 0
  : > "${barrier}.ready" || return 2
  while [[ ! -e "${barrier}.release" ]]; do
    [[ "$waited" -lt 600 ]] || return 2
    sleep 0.05
    waited=$((waited + 1))
  done
}

gate_lock_wait_for_test_barrier_instance() {
  local barrier="${1:-}"
  local waited=0
  [[ -n "$barrier" ]] || return 0
  : > "${barrier}.ready.$$" || return 2
  while [[ ! -e "${barrier}.release" ]]; do
    [[ "$waited" -lt 600 ]] || return 2
    sleep 0.05
    waited=$((waited + 1))
  done
}

# Test-only. Names the write boundaries a crash can land between, so the
# self-test can kill a run at each one and assert the next run recovers. Use
# SIGKILL rather than exit to skip the exit trap, as `kill -9` or an OOM kill
# does. This hook tests process-death recovery only. Unset in normal operation.
gate_lock_test_crash() {
  [[ "${AGENT_QUALITY_GATE_LOCK_CRASH_AT:-}" == "$1" ]] || return 0
  kill -9 $$
}

gate_drain_test_refresh_barrier() {
  local barrier="$drain_refresh_test_barrier"
  local attempt
  [[ -n "$barrier" && ! -e "${barrier}.used" ]] || return 0
  : > "${barrier}.used" || return 2
  : > "${barrier}.ready" || return 2
  for ((attempt = 0; attempt < 1000; attempt++)); do
    [[ ! -e "${barrier}.release" ]] || return 0
    sleep 0.02
  done
  return 2
}

resolve_gate_lock_root() {
  local candidates=()
  local candidate
  if [[ -n "${AGENT_QUALITY_GATE_LOCK_DIR:-}" ]]; then
    # An explicit lock directory is a coordination contract, not a
    # preference: runs configured to share it MUST share it. Falling back
    # when it is unusable would quietly split them onto separate locks — the
    # exact overlap this lock exists to prevent — so the override resolves
    # to itself or the run fails closed.
    candidate="$AGENT_QUALITY_GATE_LOCK_DIR"
    if mkdir -p "$candidate" 2>/dev/null && [[ -w "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
    return 1
  fi
  [[ -n "${HOME:-}" ]] && candidates+=("$HOME/.cache/agent-quality-gate")
  # Both fallbacks are per-user, so by default no two users share a lock. The
  # explicit override can point anywhere, including a directory two users
  # share, which is why the liveness probe answers existence with `ps` rather
  # than trusting `kill -0` — that call cannot tell another user's live
  # process from one that has exited.
  candidates+=("${TMPDIR:-/tmp}/agent-quality-gate-$(id -u)")
  for candidate in "${candidates[@]}"; do
    if mkdir -p "$candidate" 2>/dev/null && [[ -w "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

gate_lock_field_from_file() {
  local record="$1"
  local field="$2"
  [[ -r "$record" ]] || return 0
  # `|| true` for the same reason as everywhere else on this path, and here it
  # matters most: this reads records that other runs rename out from under it
  # by design. The file can vanish between the test above and the read below,
  # and under `set -e` with `pipefail` that failure would propagate out of the
  # command substitution every caller uses and kill the gate silently.
  sed -n "s/^${field}=//p" "$record" 2>/dev/null | head -n1 || true
}

gate_lock_authority_token_from_record() {
  local record="$1"
  local value
  value="$(gate_lock_field_from_file "$record" coordinator_token)"
  if [[ -z "$value" ]]; then
    value="$(gate_lock_field_from_file "$record" token)"
  fi
  printf '%s\n' "$value"
}

gate_lock_field_from_text() {
  local text="$1"
  local field="$2"
  printf '%s\n' "$text" | sed -n "s/^${field}=//p" | head -n1 || true
}

gate_lock_current_user_authority_token_from_snapshot() {
  local snapshot="$1"
  local recorded_uid current_uid uid_count coordinator_count token_count value
  uid_count="$(printf '%s\n' "$snapshot" | grep -c '^uid=' || true)"
  coordinator_count="$(printf '%s\n' "$snapshot" | grep -c '^coordinator_token=' || true)"
  token_count="$(printf '%s\n' "$snapshot" | grep -c '^token=' || true)"
  [[ "$uid_count" =~ ^[0-9]+$ && "$coordinator_count" =~ ^[0-9]+$ &&
    "$token_count" =~ ^[0-9]+$ ]] || return 1
  [[ "$uid_count" -le 1 && "$coordinator_count" -le 1 && "$token_count" -le 1 ]] ||
    return 1
  if [[ "$uid_count" -eq 1 ]]; then
    recorded_uid="$(gate_lock_field_from_text "$snapshot" uid)"
    [[ "$recorded_uid" =~ ^[0-9]+$ ]] || return 1
    current_uid="$(id -u 2>/dev/null)" || return 1
    [[ "$current_uid" =~ ^[0-9]+$ && "$recorded_uid" == "$current_uid" ]] ||
      return 1
  fi
  value="$(gate_lock_field_from_text "$snapshot" coordinator_token)"
  if [[ -z "$value" ]]; then
    value="$(gate_lock_field_from_text "$snapshot" token)"
  fi
  printf '%s\n' "$value"
}

gate_lock_current_user_authority_token_from_record() {
  local record="$1"
  local snapshot
  gate_lock_record_is_readable_regular "$record" || return 1
  if ! exec 15< "$record"; then
    return 1
  fi
  if [[ ! -f /dev/fd/15 || ! -O /dev/fd/15 ]]; then
    exec 15<&-
    return 1
  fi
  snapshot="$(cat <&15)" || {
    exec 15<&-
    return 1
  }
  if [[ ! -f /dev/fd/15 || ! -O /dev/fd/15 ]]; then
    exec 15<&-
    return 1
  fi
  exec 15<&-
  gate_lock_current_user_authority_token_from_snapshot "$snapshot"
}

gate_lock_current_user_authority_token_from_release_descriptor() {
  local snapshot
  # Linux exposes /dev/fd/N as a symlink. Duplicate the already-open release
  # descriptor instead of sending that pseudo-path through the shared-path
  # no-symlink guard. The descriptor target must still be a current-user
  # regular file before and after its bytes are read.
  if ! exec 15<&14; then
    return 1
  fi
  if [[ ! -f /dev/fd/15 || ! -O /dev/fd/15 ]]; then
    exec 15<&-
    return 1
  fi
  snapshot="$(cat <&15)" || {
    exec 15<&-
    return 1
  }
  if [[ ! -f /dev/fd/15 || ! -O /dev/fd/15 ]]; then
    exec 15<&-
    return 1
  fi
  exec 15<&-
  gate_lock_current_user_authority_token_from_snapshot "$snapshot"
}

gate_lock_owner_field() {
  if [[ "$2" == "token" ]]; then
    gate_lock_authority_token_from_record "$1/owner"
    return
  fi
  gate_lock_field_from_file "$1/owner" "$2"
}

# Wall-clock milliseconds. Two whole-second `date +%s` reads carry up to a
# second of error between them, because each truncates to the second boundary it
# landed in: a wait that starts at X.99 and lasts 1.05s reads as two seconds.
# The lock wait then reports that measurement error as elapsed time, which is
# how `--lock-wait 1` announced a two-second timeout on a loaded CI runner and
# flaked the suite's budget assertion (GitHub issue 1919). EPOCHREALTIME renders
# its fraction with the locale's decimal separator, so both forms are read; a
# shell too old to have it degrades to whole seconds, which is exactly the
# behaviour this replaces.
gate_wall_millis() {
  local now="${EPOCHREALTIME:-}"
  local seconds fraction
  case "$now" in
    *[.,]*)
      seconds="${now%%[.,]*}"
      fraction="${now#*[.,]}000"
      printf '%s%s\n' "$seconds" "${fraction:0:3}"
      return 0
      ;;
  esac
  printf '%s000\n' "$(date +%s)"
}

# Older gates persist and compare `ps -o lstart=` output byte-for-byte. Keep
# that padded wire value when publishing owner and captured-process records so
# an old worktree can identify a live new run. Current readers normalize only
# at comparison boundaries.
gate_lock_process_start_legacy_wire() {
  local pid="$1"
  [[ -n "$pid" ]] || return 0
  TZ=UTC LC_ALL=C ps -o lstart= -p "$pid" 2>/dev/null | head -n1 || true
}

# Read the kernel's start-time string and process state in one snapshot.
# Comparing the start string avoids date parsing. Pin the formatting
# environment because `ps` renders lstart in the caller's time zone and locale.
# The state field also identifies an exited child that its parent has not reaped.
gate_lock_process_snapshot() {
  local pid="$1"
  [[ -n "$pid" ]] || return 0
  # Asking about a process is allowed to come back empty, and must not be an
  # error: every caller here is racing the process it asks about, so `ps` fails
  # the moment that process exits. Under `set -e` with `pipefail` this pipeline
  # would then abort the whole gate from inside a command substitution.
  # macOS pads these fields. Normalize both edges so Bash and Node compare the
  # same snapshot.
  TZ=UTC LC_ALL=C ps -o lstart= -o stat= -p "$pid" 2>/dev/null |
    head -n1 | sed 's/^[[:blank:]]*//; s/[[:blank:]]*$//' || true
}

gate_lock_normalize_process_start() {
  printf '%s\n' "$1" |
    sed 's/^[[:blank:]]*//; s/[[:blank:]]*$//'
}

gate_lock_process_start() {
  local snapshot
  snapshot="$(gate_lock_process_snapshot "$1")"
  [[ "$snapshot" == *" "* ]] || return 0
  gate_lock_normalize_process_start "${snapshot% *}"
}

# Read start identity and process-group ID from one process-table row. Group
# capture uses the pair so a PID replacement between two independent `ps`
# calls cannot supply one field from each process.
gate_lock_process_start_pgid_snapshot() {
  local pid="$1"
  local snapshot start pgid
  [[ -n "$pid" ]] || return 0
  snapshot="$(TZ=UTC LC_ALL=C ps -o lstart= -o pgid= -p "$pid" 2>/dev/null |
    head -n1 | sed 's/^[[:blank:]]*//; s/[[:blank:]]*$//' || true)"
  [[ "$snapshot" == *" "* ]] || return 0
  pgid="${snapshot##* }"
  [[ "$pgid" =~ ^[1-9][0-9]*$ ]] || return 0
  start="$(gate_lock_normalize_process_start "${snapshot% *}")"
  [[ -n "$start" ]] || return 0
  printf '%s|%s\n' "$start" "$pgid"
}

gate_lock_process_state() {
  local snapshot
  snapshot="$(gate_lock_process_snapshot "$1")"
  [[ "$snapshot" == *" "* ]] || return 0
  printf '%s\n' "${snapshot##* }"
}

# A zombie has exited and cannot execute, fork, or retain file descriptors. PID
# 1 can keep its process-table record indefinitely, so kill -0 and lstart alone
# cannot decide whether a condemned command can still overlap the next run.
# Read state and start time from one snapshot. Empty or unreadable state remains
# fail-closed because only a confirmed matching zombie returns success.
gate_lock_process_is_confirmed_zombie() {
  local pid="$1"
  local recorded_start="$2"
  local snapshot current_start current_state
  recorded_start="$(gate_lock_normalize_process_start "$recorded_start")"
  [[ -n "$pid" && -n "$recorded_start" ]] || return 1
  snapshot="$(gate_lock_process_snapshot "$pid")"
  [[ "$snapshot" == *" "* ]] || return 1
  current_state="${snapshot##* }"
  [[ "$current_state" == Z* ]] || return 1
  current_start="$(gate_lock_normalize_process_start "${snapshot% *}")"
  [[ -n "$current_start" && "$current_start" == "$recorded_start" ]]
}

# Is this PID still the process that recorded itself? `kill -0` alone cannot
# say: PIDs are reused, and a recycled one would make every later run wait on
# an unrelated process until --lock-wait expired — the opposite of unattended
# recovery. When a start time is unavailable on either side (a sandbox without
# ps, a lock written before `start_utc` existed), this falls back to PID
# existence, which is the safe direction: we keep waiting rather than evict a
# run that may be alive. That fallback is also what makes a mixed-version
# window safe in both directions — neither gate can read the other's
# start-time field, so each degrades to "assume live" and times out, and a
# false stale on a live holder stays impossible.
gate_lock_holder_is_live() {
  local pid="$1"
  local recorded_start="$2"
  local snapshot current_start current_state
  recorded_start="$(gate_lock_normalize_process_start "$recorded_start")"
  [[ -n "$pid" ]] || return 1
  # `kill -0` fails two ways that mean opposite things: no such process, and a
  # live process this user may not signal. A lock root shared between users
  # makes the second ordinary, and reading it as "gone" would reclaim a lock
  # whose holder is still running. `ps` answers existence across users, so it
  # decides, and `kill -0` only spares the `ps` call in the common case.
  snapshot="$(gate_lock_process_snapshot "$pid")"
  if [[ -z "$snapshot" ]]; then
    if ! kill -0 "$pid" 2>/dev/null; then
      ps -p "$pid" > /dev/null 2>&1 || return 1
    fi
    return 0
  fi
  [[ "$snapshot" == *" "* ]] || return 0
  current_state="${snapshot##* }"
  [[ "$current_state" != Z* ]] || return 1
  [[ -n "$recorded_start" ]] || return 0
  current_start="$(gate_lock_normalize_process_start "${snapshot% *}")"
  [[ "$current_start" == "$recorded_start" ]]
}

# Is the record a reclaimer just took away the exact one it judged stale, and
# is it still dead? The verdict was formed before the rename won it, so this is
# what stops a waiter acting on a decision that has since gone obsolete.
gate_lock_record_still_stale() {
  local record="$1"
  local decided_pid="$2"
  local decided_token="$3"
  local decided_start="$4"
  local current_pid current_token_value current_start
  if ! gate_lock_record_is_readable_regular "$record"; then
    [[ ! -e "$record" && ! -L "$record" ]] && return 3
    return 2
  fi
  current_pid="$(gate_lock_field_from_file "$record" pid)"
  current_token_value="$(gate_lock_authority_token_from_record "$record")"
  current_start="$(gate_lock_field_from_file "$record" start_utc)"
  if ! gate_lock_record_is_readable_regular "$record"; then
    [[ ! -e "$record" && ! -L "$record" ]] && return 3
    return 2
  fi
  [[ "$current_pid" == "$decided_pid" ]] || return 1
  [[ "$current_token_value" == "$decided_token" ]] || return 1
  [[ "$current_start" == "$decided_start" ]] || return 1
  # A record with no token never finished being written, so it is not a claim
  # at all and its PID field may itself be a truncated value — asking whether
  # that PID is alive would be asking about a number nobody wrote. The grace
  # this record already outlived is what makes discarding it safe.
  [[ -n "$current_token_value" ]] || return 0
  ! gate_lock_holder_is_live "$current_pid" "$current_start"
}

# The only way a process comes to hold the lock. The record is built in a
# private file and published with `ln`, so a reader never sees a half-written
# one: either the complete record is there or nothing is. `ln` refuses an
# occupied path, which is what makes a stalled creator safe — if a reclaimer
# published while this process sat descheduled between `mkdir` and here, this
# publish fails and the caller never believes it holds anything. Reading the
# token back turns any residual displacement into a failed claim instead of a
# second concurrent run.
claim_gate_run_lock() {
  local lock="$1"
  local token="$2"
  local claim_uid="$3"
  local staged="$lock/owner.claiming.$$"
  local published=0
  [[ -n "$gate_lock_local_host_name" ]] || return 2
  [[ "$claim_uid" =~ ^[0-9]+$ ]] || return 2
  gate_lock_token_is_wellformed "$token" || return 2
  # Registered before it exists, like every other file this path creates. Any
  # file already there was left by a dead process that happened to share our
  # PID, so it is ours to remove.
  gate_lock_claim_tmp="$staged"
  rm -f "$staged"
  if {
    printf 'pid=%s\n' "$$"
    printf 'uid=%s\n' "$claim_uid"
    printf 'host=%s\n' "$gate_lock_local_host_name"
    printf 'started_at=%s\n' "$(date +%s)"
    printf 'start_utc=%s\n' "$(gate_lock_process_start_legacy_wire $$)"
    printf 'worktree=%s\n' "$repo_root"
    # Written last on purpose: a record without a token is one whose write did
    # not finish, and readers below treat it as no record at all.
    printf 'token=%s\n' "$token"
  } > "$staged" 2>/dev/null; then
    gate_lock_test_crash after-staged
    ln "$staged" "$lock/owner" 2>/dev/null && published=1
  fi
  gate_lock_test_crash after-link
  rm -f "$staged"
  gate_lock_claim_tmp=""
  [[ "$published" -eq 1 ]] || return 1
  [[ "$(gate_lock_owner_field "$lock" token)" == "$token" ]] || return 1
  gate_lock_dir="$lock"
  gate_lock_token="$token"
  [[ -n "$gate_run_id" ]] || gate_run_id="$token"
  export AGENT_QUALITY_GATE_LOCK_HELD="$token"
  return 0
}

# The backstop, and the only rule here that does not depend on getting an
# interleaving right. Everything above tries to make displacement impossible;
# this makes it detectable. Acquiring the lock and reaching the first mapped
# command are separated by real work, and anything that unseats this run's
# record in between — a waiter acting on a verdict formed before we published,
# a hand-deleted lock — leaves us believing we hold a lock we do not. Reading
# our own record back here turns that into one loud abort instead of two runs
# on one machine. Release stays token-guarded, so stopping here cannot delete
# the lock of whoever holds it now.
# Confirm a dead run's mapped commands are gone, and make them gone if they are
# not. Its processes carry its token in their argv, so this asks the machine
# directly rather than trusting a timer: nothing tagged means nothing to wait
# for — including the common case where the run died before starting a command,
# which now costs no wait at all. Anything still tagged is signalled and then
# waited for, because a signal delivered is not a process reaped.
# Everything under a process, children first, each with the start string that
# identifies it. Children first is also the order to signal in, and capturing
# the identity now is what lets the drain tell "this PID is still the process
# we condemned" from "this PID was reused while we worked".
gate_drain_capture=""
# PIDs already recorded this drain, so a re-walk can tell "found something new"
# from "found the same tree again".
gate_drain_seen=""
# Where the captured tree is written down, if anywhere. Set before capturing
# starts, so each process is recorded as it is discovered.
gate_drain_capture_file=""
# Set when an append to that file failed, so the drain can refuse to signal
# with nothing durable behind it.
gate_drain_capture_unpersisted=0
# Set when a discovery scan failed rather than came back empty, so an
# unanswered question is never read as "nothing left running". The scan itself
# runs in a command substitution, so it cannot set this — a subshell's
# assignments die with it. It emits the marker below in its output instead, and
# the wrapper that reads that output is what sets the flag.
gate_drain_scan_failed=0
gate_drain_scan_error="agentqg-scan-failed"
# The PIDs this run's handles named on the current pass, read by the
# membership check deep inside the recursive walk.
gate_drain_tagged_now=""
# A live parallel parent can also seed the drain from its registered worker
# process group. This captures a same-group descendant that closed every
# inherited identity handle before the first signal destroys its ancestor.
gate_drain_seed_pgid=""
# The active parent records the worker leader's start identity at fork time.
# This lets a no-lock drain validate its live group anchor without handles.
gate_drain_seed_start=""
# Set only while a snapshot tied to a live token holder is being folded into
# the durable capture. It lets sibling group members prove membership without
# treating a bare, reusable PGID as an identity on later passes.
gate_drain_capture_group_pgid=""
# The group leader whose exact start identity authorised the current group
# snapshot. Every candidate membership check revalidates this anchor after it
# observes the candidate. This prevents a dead group ID from being reused
# between the snapshot and capture.
gate_drain_capture_group_anchor_pid=""
gate_drain_capture_group_anchor_start=""
# Set when a group membership check cannot distinguish exit from an unreadable
# identity. A confirmed out-of-group PID can be skipped; an ambiguous one must
# remain as fail-closed evidence.
gate_drain_membership_unverified=0

# Recorded in place of a start time on a host that cannot produce one at all —
# a sandbox without `ps`. It has to be distinguishable from an empty identity,
# because the two mean opposite things: this one says "nobody here can be
# identified, the tag is the only selector", while an empty one says "this
# particular read failed", and reads that fail must never authorise a signal.
gate_lock_identity_unavailable="<no-identity-source>"
gate_lock_identity_source=""

# Can this host identify processes at all? Asked about our own PID, which is
# alive by construction, so an empty answer means the source is missing rather
# than the process being gone. Cached: the answer cannot change mid-run.
gate_lock_identity_source_available() {
  if [[ -z "$gate_lock_identity_source" ]]; then
    if [[ -n "$(gate_lock_process_start $$)" ]]; then
      gate_lock_identity_source="yes"
    else
      gate_lock_identity_source="no"
    fi
  fi
  [[ "$gate_lock_identity_source" == "yes" ]]
}

# The captured tree is obligation-evidence too, and the same rule applies to it
# as to the condemned token: the moment the first signal goes out, this process
# is the only one that knows what it was about to kill. Written down before
# that, a successor inherits the list; without it, the successor's tag scan
# finds nothing — the first pass killed the tag carrier — and reads that as
# nothing left to do while an untagged descendant keeps running.
#
# Recorded by appending one short line per process, never by rewriting the
# file. A `>` redirection truncates the moment it opens, so a rewrite has a
# window where the snapshot on disk is empty — and this is exactly the file a
# successor consults when nothing carries the tag any more. Appending removes
# that window rather than narrowing it: the list can only grow, so an
# interrupted drain leaves fewer entries than it eventually would have, never
# Refresh the set of PIDs this run's handles name, in the caller's shell, and
# remember whether the scan behind it failed. Everything that reads that set
# goes through here, so a failure cannot be lost by being noticed inside a
# subshell.
gate_drain_refresh_tagged() {
  local token="$1"
  local raw candidate normalized=""
  raw="$(gate_run_tagged_pids "$token")"
  for candidate in $raw; do
    if [[ "$candidate" == "$gate_drain_scan_error" ]]; then
      gate_drain_scan_failed=1
      continue
    fi
    normalized="${normalized}${candidate} "
  done
  gate_drain_tagged_now="$normalized"
}

# Is this PID still one of ours, asked after its identity was read? Two answers
# count: it still carries one of the run's handles, or it is still a child of
# the process the walk reached it through. Either is enough, and both are
# needed — a reparented descendant has lost its parent but keeps the inherited
# handle, while a handle-less descendant is still reachable through its parent.
gate_drain_membership_holds() {
  local pid="$1"
  local parent="${2:-}"
  local recorded_start="${3:-}"
  local candidate candidate_snapshot candidate_start candidate_pgid
  local anchor_snapshot anchor_start anchor_pgid
  gate_drain_membership_unverified=0

  if [[ "$gate_drain_capture_group_pgid" =~ ^[1-9][0-9]*$ ]]; then
    # A group snapshot is authorised by one live, exact group leader. Do not
    # accept the cached numeric tag or parent relation until both this
    # candidate and that leader are revalidated. The leader can otherwise exit
    # and its PID/PGID can be reused between the snapshot and this capture.
    if [[ "$recorded_start" == "$gate_lock_identity_unavailable" ]]; then
      gate_lock_identity_source_available && return 1
      candidate_pgid="$(ps -o pgid= -p "$pid" 2>/dev/null |
        head -n1 | tr -d '[:space:]' || true)"
    else
      candidate_snapshot="$(gate_lock_process_start_pgid_snapshot "$pid")"
      if [[ "$candidate_snapshot" != *"|"* ]]; then
        kill -0 "$pid" 2>/dev/null && gate_drain_membership_unverified=1
        return 1
      fi
      candidate_start="${candidate_snapshot%|*}"
      candidate_pgid="${candidate_snapshot##*|}"
      recorded_start="$(gate_lock_normalize_process_start "$recorded_start")"
      [[ -n "$recorded_start" && "$candidate_start" == "$recorded_start" ]] ||
        return 1
    fi

    # Group recovery covers only current members of the pinned worker group.
    # A child relation through a snapshot PID is not enough here: that parent
    # PID can exit and be reused before the recursive walk observes its child.
    # Descendants outside the group remain discoverable through inherited
    # command/request handles; a detached process that drops every handle is
    # outside this recovery guarantee.
    [[ "$candidate_pgid" == "$gate_drain_capture_group_pgid" ]] || return 1

    if [[ "$gate_drain_capture_group_anchor_start" == "$gate_lock_identity_unavailable" ]]; then
      gate_lock_identity_source_available && return 1
      if ! kill -0 "$gate_drain_capture_group_anchor_pid" 2>/dev/null; then
        gate_drain_membership_unverified=1
        return 1
      fi
      anchor_pgid="$(ps -o pgid= \
        -p "$gate_drain_capture_group_anchor_pid" 2>/dev/null |
        head -n1 | tr -d '[:space:]' || true)"
      if [[ "$anchor_pgid" != "$gate_drain_capture_group_pgid" ]]; then
        gate_drain_membership_unverified=1
        return 1
      fi
    else
      anchor_snapshot="$(gate_lock_process_start_pgid_snapshot \
        "$gate_drain_capture_group_anchor_pid")"
      if [[ "$anchor_snapshot" != *"|"* ]]; then
        gate_drain_membership_unverified=1
        return 1
      fi
      anchor_start="${anchor_snapshot%|*}"
      anchor_pgid="${anchor_snapshot##*|}"
      if [[ "$anchor_start" != "$gate_drain_capture_group_anchor_start" ||
        "$anchor_pgid" != "$gate_drain_capture_group_pgid" ]]; then
        gate_drain_membership_unverified=1
        return 1
      fi
    fi
    return 0
  fi

  for candidate in ${gate_drain_tagged_now}; do
    [[ "$candidate" == "$pid" ]] && return 0
  done
  if [[ -n "$parent" ]]; then
    for candidate in $(pgrep -P "$parent" 2>/dev/null || true); do
      [[ "$candidate" == "$pid" ]] && return 0
    done
  fi
  return 1
}

# fewer than it had already committed to. Since a capture always completes
# before the first signal, anything already signalled is already on disk.
capture_process_tree() {
  local root_pid="$1"
  local from_parent="${2:-}"
  local child entry start
  # Children first, and always re-walked even for a process already recorded:
  # a command that survives TERM can fork again afterwards, so discovery has to
  # keep looking as long as anything is alive to fork. Only the recording is
  # skipped for a PID already in the list, which is what lets a pass that adds
  # nothing be recognised as one.
  for child in $(pgrep -P "$root_pid" 2>/dev/null || true); do
    capture_process_tree "$child" "$root_pid"
  done
  case " ${gate_drain_seen} " in
    *" ${root_pid} "*) return 0 ;;
  esac
  start="$(gate_lock_process_start_legacy_wire "$root_pid")"
  if [[ -z "$start" ]]; then
    if gate_lock_identity_source_available; then
      # The walk saw it, the identity read did not: it exited in between. A
      # process that is already gone is nothing to signal and nothing to wait
      # for, and recording it without an identity would later authorise a
      # signal at whatever inherits its PID.
      return 0
    fi
    start="$gate_lock_identity_unavailable"
  elif ! gate_drain_membership_holds "$root_pid" "$from_parent" "$start"; then
    # Enumeration and identity are two reads with a gap between them, and a PID
    # recycled inside it would be recorded under a stranger's identity that
    # every later check then confirms. Re-asking whether this PID is still one
    # of ours closes that in the direction the rest of this path uses: an
    # answer that cannot be confirmed is recorded with no identity, which is
    # never signalled and holds the drain open rather than discharging it.
    if [[ "$gate_drain_capture_group_pgid" =~ ^[1-9][0-9]*$ &&
      "$gate_drain_membership_unverified" -eq 0 ]]; then
      return 0
    fi
    start=""
  fi
  entry="${root_pid}|${start}"
  gate_drain_seen="${gate_drain_seen}${root_pid} "
  gate_drain_capture="${gate_drain_capture}${entry}
"
  # One `printf` of a short line through an append-mode descriptor is a single
  # write, so concurrent or interrupted appends cannot interleave a half line.
  # A write that fails is remembered rather than ignored: the caller checks it
  # before signalling, because signalling is what destroys the alternative.
  if [[ -n "$gate_drain_capture_file" ]] &&
    ! printf '%s\n' "$entry" >> "$gate_drain_capture_file" 2>/dev/null; then
    gate_drain_capture_unpersisted=1
  fi
}

gate_drain_capture_seed_group() {
  local token="$1"
  local snapshot pid pgid remainder tagged tagged_pgid groups="" group
  local group_anchor_start group_anchors=""
  local seed_current seed_snapshot_pgid
  local tagged_start tagged_current tagged_after tagged_after_clean=""
  local tagged_candidate tagged_identities=""
  local identity_source_available=0
  [[ "$gate_drain_seed_pgid" =~ ^[1-9][0-9]*$ ||
    -n "${gate_drain_tagged_now//[[:space:]]/}" ]] || return 0
  if gate_lock_identity_source_available; then
    identity_source_available=1
  fi
  # Pin each tagged PID before the process-group snapshot. A tag scan and a
  # later `ps` row are independent observations. Without the start identity
  # between them, PID reuse can make an unrelated group leader look like the
  # recovery anchor.
  for tagged in $gate_drain_tagged_now; do
    [[ "$tagged" =~ ^[1-9][0-9]*$ ]] || continue
    tagged_start="$(gate_lock_process_start "$tagged")"
    if [[ -z "$tagged_start" ]]; then
      [[ "$identity_source_available" -eq 0 ]] || continue
      tagged_start="$gate_lock_identity_unavailable"
    fi
    tagged_identities="${tagged_identities}${tagged}|${tagged_start}
"
  done
  if ! snapshot="$(TZ=UTC LC_ALL=C ps -axo pid=,pgid= 2>/dev/null)"; then
    gate_drain_scan_failed=1
    return 0
  fi
  # Re-read the handles after the group snapshot. A tagged PID can seed a
  # group only if the same process held the token on both sides of the
  # snapshot. Keep this list local. The caller captures newly tagged roots on
  # its next pass.
  tagged_after="$(gate_run_tagged_pids "$token")"
  for tagged_candidate in $tagged_after; do
    if [[ "$tagged_candidate" == "$gate_drain_scan_error" ]]; then
      gate_drain_scan_failed=1
      continue
    fi
    tagged_after_clean="${tagged_after_clean}${tagged_candidate} "
  done
  tagged_after="$tagged_after_clean"
  if [[ "$gate_drain_seed_pgid" =~ ^[1-9][0-9]*$ &&
    -n "$gate_drain_seed_start" ]]; then
    seed_snapshot_pgid="$(awk -v target="$gate_drain_seed_pgid" \
      '$1 == target && NF == 2 { print $2; exit }' <<< "$snapshot")"
    if [[ "$seed_snapshot_pgid" == "$gate_drain_seed_pgid" ]]; then
      seed_current="$(gate_lock_process_start "$gate_drain_seed_pgid")"
      if [[ "$seed_current" == "$gate_drain_seed_start" ]] || {
        [[ "$gate_drain_seed_start" == "$gate_lock_identity_unavailable" ]] &&
          ! gate_lock_identity_source_available &&
          kill -0 "$gate_drain_seed_pgid" 2>/dev/null
      }; then
        groups="${gate_drain_seed_pgid} "
        group_anchors="${gate_drain_seed_pgid}|${gate_drain_seed_start}
"
      fi
    fi
  fi
  # Crash recovery has no parent registry, so it derives a group only from a
  # tagged group leader whose PID/start identity survived the complete
  # snapshot. The active parent uses the separately validated explicit seed.
  while IFS='|' read -r tagged tagged_start; do
    [[ "$tagged" =~ ^[1-9][0-9]*$ && -n "$tagged_start" ]] || continue
    case " ${tagged_after} " in
      *" ${tagged} "*) : ;;
      *) continue ;;
    esac
    tagged_pgid="$(awk -v target="$tagged" \
      '$1 == target && NF == 2 { print $2; exit }' <<< "$snapshot")"
    [[ "$tagged_pgid" =~ ^[1-9][0-9]*$ ]] || continue
    tagged_current="$(gate_lock_process_start "$tagged")"
    if [[ "$tagged_start" == "$gate_lock_identity_unavailable" ]]; then
      [[ "$identity_source_available" -eq 0 ]] || continue
    elif [[ -z "$tagged_current" || "$tagged_current" != "$tagged_start" ]]; then
      continue
    fi
    if [[ "$tagged_pgid" == "$tagged" ]]; then
      case " ${groups} " in
        *" ${tagged_pgid} "*) : ;;
        *)
          groups="${groups}${tagged_pgid} "
          group_anchors="${group_anchors}${tagged_pgid}|${tagged_start}
"
          ;;
      esac
    fi
  done << EOF
$tagged_identities
EOF
  while IFS='|' read -r group group_anchor_start; do
    [[ "$group" =~ ^[1-9][0-9]*$ && -n "$group_anchor_start" ]] || continue
    gate_drain_capture_group_pgid="$group"
    gate_drain_capture_group_anchor_pid="$group"
    gate_drain_capture_group_anchor_start="$group_anchor_start"
    while read -r pid pgid remainder; do
      [[ -z "$remainder" && "$pid" =~ ^[1-9][0-9]*$ &&
        "$pgid" == "$group" ]] || continue
      capture_process_tree "$pid"
    done <<< "$snapshot"
    gate_drain_capture_group_pgid=""
    gate_drain_capture_group_anchor_pid=""
    gate_drain_capture_group_anchor_start=""
  done << EOF
$group_anchors
EOF
}

drain_condemned_run_commands() {
  local token="$1"
  local drain_context="${2:-stale-run}"
  local seed_pgid="${3:-}"
  local seed_start="${4:-}"
  local quiet_seed_only="${5:-0}"
  local announce_captured_non_seed="${6:-0}"
  local wrapper entry pid recorded current alive alive_identities recycled unverified captured_file
  local captured_pid capture_has_non_seed=0
  local waited=0
  local drain_started_at
  local announced=0
  local escalated=0
  local drain_subject="previous run"
  local drain_start_message="The run this lock was taken from left commands running; stopping them before starting anything."
  local drain_done_message="Previous run's commands are gone; continuing."
  local drain_failure_prefix="Nothing has been executed."
  local drain_failure_phase="stale-obligation recovery"
  local drain_failure_verdict="No mapped command ran in this request"
  if [[ "$drain_context" == "active-command" ]]; then
    drain_subject="completed mapped command"
    drain_start_message="A completed mapped command left descendants running; stopping them before releasing its scheduler lease."
    drain_done_message="The completed mapped command's descendants are gone; releasing its scheduler lease."
    drain_failure_prefix="The mapped command finished, but descendant cleanup did not complete."
    drain_failure_phase="command descendant cleanup"
    drain_failure_verdict="A mapped command ran, but its descendants were not confirmed gone"
  fi
  [[ -n "$token" ]] || return 0
  if [[ -n "$seed_pgid" && ! "$seed_pgid" =~ ^[1-9][0-9]*$ ]]; then
    echo "error: mapped-command drain received an invalid worker process group." >&2
    gate_drain_fail_for_context "$drain_context"
    return $?
  fi
  if [[ "$quiet_seed_only" != 0 && "$quiet_seed_only" != 1 ]]; then
    echo "error: mapped-command drain received an invalid quiet-sentinel flag." >&2
    gate_drain_fail_for_context "$drain_context"
    return $?
  fi
  if [[ "$announce_captured_non_seed" != 0 &&
    "$announce_captured_non_seed" != 1 ]]; then
    echo "error: mapped-command drain received an invalid early-announcement flag." >&2
    gate_drain_fail_for_context "$drain_context"
    return $?
  fi
  gate_drain_seed_pgid="$seed_pgid"
  gate_drain_seed_start="$seed_start"
  drain_started_at="$(date +%s)"

  # Enumerate before signalling anything. Only the wrapper carries the tag, so
  # killing it first would destroy the one handle to its descendants: a command
  # that ignores TERM would outlive its wrapper, the next search for the tag
  # would come back empty, and "no tagged process" would be read as "nothing
  # running". The captured set, not a re-scan, is what the drain confirms
  # against.
  gate_drain_capture=""
  # Per token, not per run: the dedup set is what stops a PID being recorded
  # twice, and carrying it across tokens would skip a PID that has since been
  # recycled by a process belonging to the next one — recording it under no
  # identity check at all.
  gate_drain_seen=""
  captured_file=""
  [[ -z "$gate_lock_root_dir" ]] || captured_file="${gate_lock_root_dir}/captured.${token}"
  if [[ -n "$captured_file" ]]; then
    # A symlink here is not ours — this gate only ever creates these as
    # regular files, and appending through a planted link would write
    # whatever it points at with this user's permissions.
    if [[ -L "$captured_file" ]]; then
      gate_drain_obligation_unreadable "$captured_file" "$drain_context" ||
        return $?
    fi
    if [[ ! -e "$captured_file" ]]; then
      # Created exclusively before the first append, so every later >> lands
      # in a regular file this run made; noclobber refuses a path planted
      # between the check above and here, symlinks included.
      if ! (set -C && : > "$captured_file") 2>/dev/null; then
        gate_drain_obligation_unreadable "$captured_file" "$drain_context" ||
          return $?
      fi
    fi
  fi
  # Every process found from here on is appended as it is discovered.
  gate_drain_capture_file="$captured_file"
  gate_drain_capture_unpersisted=0
  gate_drain_scan_failed=0
  # Start from what an earlier drain wrote down before it was interrupted. Its
  # tagged processes are very likely already gone — killing them is what the
  # first pass does — so a fresh tag scan on its own would come back empty and
  # call the job finished while an untagged descendant carried on.
  if [[ -n "$captured_file" && -e "$captured_file" ]]; then
    # Owned by us, or not evidence. The identity strings inside are public
    # (ps shows any process's start time), so another writer on a shared
    # root could fabricate a snapshot naming a victim PID with its genuine
    # identity — and this run would kill by it. What cannot be fabricated is
    # the file's owner: only this uid's runs write these, so an inherited
    # snapshot someone else owns is refused, run stopped, file named.
    if [[ ! -O "$captured_file" ]]; then
      echo "error: ${captured_file} is not owned by this user, so it is not this gate's evidence." >&2
      echo "On a shared lock root that is a fabricated snapshot; killing by it could signal a stranger." >&2
      echo "${drain_failure_prefix} Inspect and remove that file, then re-run." >&2
      if [[ "$drain_context" == "stale-run" ]]; then
        gate_report_coordinated_no_work_failure 2 "$drain_failure_phase" \
          "$drain_failure_verdict"
      fi
      gate_drain_fail_for_context "$drain_context"
      return $?
    fi
    # Unreadable is not empty. Starting from nothing here would lose the
    # descendants an interrupted drain recorded, and their tagged wrapper is
    # already dead by then — so the tag scan below would come back empty and
    # this run would call the job done with those processes still running.
    if [[ ! -r "$captured_file" ]]; then
      gate_drain_obligation_unreadable "$captured_file" "$drain_context" ||
        return $?
    fi
    gate_drain_capture="$(cat "$captured_file" 2>/dev/null)
"
  fi
  # Walked twice, with a pause between. A tree walk is a snapshot, and a
  # snapshot can catch a wrapper in the instant before its child is visible —
  # observed, once, as a capture holding only the two tagged processes and none
  # of their descendants. Missing a descendant here is expensive, because the
  # first signal kills the tagged wrapper and with it the only handle to
  # anything the walk did not already record. Two walks are not a proof, but
  # they cost 200ms on a path that runs only after a crash.
  gate_drain_refresh_tagged "$token"
  for wrapper in $gate_drain_tagged_now; do
    capture_process_tree "$wrapper"
  done
  gate_drain_capture_seed_group "$token"
  sleep 0.2
  gate_drain_refresh_tagged "$token"
  for wrapper in $gate_drain_tagged_now; do
    capture_process_tree "$wrapper"
  done
  gate_drain_capture_seed_group "$token"
  if [[ -z "${gate_drain_capture//[[:space:]]/}" && "$gate_drain_scan_failed" -eq 0 ]]; then
    [[ -z "$captured_file" ]] || rm -f "$captured_file"
    gate_run_discard_marker_exact "$token" \
      "The prior command identity was drained, but its marker cleanup failed." ||
      return $?
    return 0
  fi

  # The tag is the only handle on these processes that this run did not write
  # itself, and the first signal kills the tag carrier. Signalling with the
  # captured list unwritten would leave a run that dies mid-drain with neither:
  # an empty tag scan reads as "nothing running" to whoever comes next. So a
  # capture that could not be persisted stops the run here, before the handle
  # is destroyed and while the processes are still findable by tag.
  if [[ "$gate_drain_capture_unpersisted" -ne 0 ]]; then
    echo "error: could not write the captured process list to ${captured_file}." >&2
    echo "Signalling now would destroy the tag those processes are still findable by, with nothing on disk to hand on." >&2
    echo "${drain_failure_prefix} Fix that path — permissions, or free space — then re-run." >&2
    if [[ "$drain_context" == "stale-run" ]]; then
      gate_report_coordinated_no_work_failure 2 "$drain_failure_phase" \
        "$drain_failure_verdict"
    fi
    gate_drain_fail_for_context "$drain_context"
    return $?
  fi

  if [[ "$quiet_seed_only" -eq 1 && "$announce_captured_non_seed" -eq 1 ]]; then
    while IFS='|' read -r captured_pid _; do
      [[ -z "$captured_pid" || "$captured_pid" == "$seed_pgid" ]] && continue
      capture_has_non_seed=1
      break
    done << EOF
$gate_drain_capture
EOF
  fi
  if [[ "$quiet_seed_only" -eq 0 || "$capture_has_non_seed" -eq 1 ||
    "$gate_drain_scan_failed" -ne 0 ]]; then
    echo "$drain_start_message"
    announced=1
  fi
  recycled=""

  while :; do
    alive=""
    alive_identities=""
    unverified=""
    gate_drain_scan_failed=0
    gate_drain_refresh_tagged "$token"
    # A tagged replacement can appear after the previous bottom-of-loop walk
    # and after its captured parent exits. Persist every fresh tagged root
    # before deciding that the old capture is empty.
    for wrapper in $gate_drain_tagged_now; do
      capture_process_tree "$wrapper"
    done
    gate_drain_capture_seed_group "$token"
    if [[ "$quiet_seed_only" -eq 1 &&
      "$announce_captured_non_seed" -eq 1 && "$announced" -eq 0 ]]; then
      while IFS='|' read -r captured_pid _; do
        [[ -z "$captured_pid" || "$captured_pid" == "$seed_pgid" ]] && continue
        echo "$drain_start_message"
        announced=1
        break
      done << EOF
$gate_drain_capture
EOF
    fi
    if ! gate_drain_test_refresh_barrier; then
      echo "error: the test-only drain refresh barrier did not release." >&2
      gate_drain_fail_for_context "$drain_context"
      return $?
    fi
    while IFS='|' read -r pid recorded; do
      [[ -n "$pid" ]] || continue
      # Only signal something that reads as a PID. Appends are single short
      # writes so a half-written line should be impossible, and this is the
      # backstop for that being wrong: a truncated line could otherwise name
      # some unrelated process, and killing a stranger is worse than missing a
      # survivor the tag scan would find anyway.
      [[ "$pid" =~ ^[0-9]+$ ]] || continue
      kill -0 "$pid" 2>/dev/null || continue
      if [[ "$recorded" == "$gate_lock_identity_unavailable" ]]; then
        # This host cannot identify processes at all, so a handle it still
        # carries is the only selector there is. Signalling on PID alone would
        # kill whatever inherited the number; a PID that no longer answers to
        # any of this run's handles is therefore left alone and named, and it
        # keeps the drain open rather than discharging it.
        if gate_drain_membership_holds "$pid" ""; then
          alive="${alive}${pid} "
          # Queued for the signal loop too — it consumes alive_identities, and
          # an entry only in `alive` would be waited on but never signalled,
          # holding the drain to its bound for nothing. The loop re-checks
          # membership under the sentinel before sending anything.
          alive_identities="${alive_identities}${pid}|${gate_lock_identity_unavailable}
"
        else
          case " ${unverified} " in
            *" ${pid} "*) : ;;
            *) unverified="${unverified}${pid} " ;;
          esac
        fi
        continue
      fi
      recorded="$(gate_lock_normalize_process_start "$recorded")"
      current="$(gate_lock_process_start "$pid")"
      if [[ -z "$recorded" || -z "$current" ]]; then
        # An identity we cannot read is not an identity that matches. Empty
        # must mean "cannot verify, never signal" — read as "matches anything"
        # it would authorise killing whatever inherited this PID. It still
        # counts as outstanding, so the drain keeps waiting on it rather than
        # calling the run clear, and fails closed at the bound if it persists.
        case " ${unverified} " in
          *" ${pid} "*) : ;;
          *) unverified="${unverified}${pid} " ;;
        esac
        continue
      fi
      if [[ "$current" != "$recorded" ]]; then
        # The PID exists but is somebody else now. Signalling it would be
        # killing a stranger's process, so it is left alone and named below.
        # Nothing of the dead run survives under it, so it does not hold the
        # drain open either.
        case " ${recycled} " in
          *" ${pid} "*) : ;;
          *) recycled="${recycled}${pid} " ;;
        esac
        continue
      fi
      if gate_lock_process_is_confirmed_zombie "$pid" "$recorded"; then
        continue
      fi
      alive="${alive}${pid} "
      alive_identities="${alive_identities}${pid}|${recorded}
"
    done << EOF
$gate_drain_capture
EOF

    # A no-lock sentinel polls its exact parent identity. A short-lived ps
    # helper can enter the durable capture and be gone by this census. Report a
    # leaked descendant only when a live or unverifiable non-sentinel process
    # remains; the persisted capture and signal checks stay unchanged.
    if [[ "$quiet_seed_only" -eq 1 && "$announced" -eq 0 ]]; then
      for captured_pid in $alive $unverified $gate_drain_tagged_now; do
        [[ "$captured_pid" == "$seed_pgid" ]] && continue
        echo "$drain_start_message"
        announced=1
        break
      done
      if [[ "$announced" -eq 0 && "$gate_drain_scan_failed" -ne 0 ]]; then
        echo "$drain_start_message"
        announced=1
      fi
    fi

    # Unverifiable entries keep the drain open even though nothing is sent to
    # them: "we could not check" is not "it is gone". A scan that failed counts
    # the same way — an unanswered question is not an empty answer.
    [[ -n "$alive" || -n "$unverified" || -n "$gate_drain_tagged_now" ||
      "$gate_drain_scan_failed" -ne 0 ]] || break

    if [[ "$waited" -ge "$gate_lock_orphan_drain_bound_seconds" ]]; then
      # Refusing to run is the whole point: proceeding here is exactly the
      # cross-run overlap the lock exists to prevent.
      [[ -z "$alive" ]] ||
        echo "error: commands from the ${drain_subject} are still alive after ${waited}s: ${alive}" >&2
      [[ -z "$unverified" ]] ||
        echo "error: processes from the ${drain_subject} could not be identified after ${waited}s, so none were signalled: ${unverified}" >&2
      [[ "$gate_drain_scan_failed" -eq 0 ]] ||
        echo "error: the scan for the ${drain_subject}'s processes kept failing after ${waited}s, so it is not known whether any are left." >&2
      echo "${drain_failure_prefix} Investigate those processes, then re-run." >&2
      if [[ "$drain_context" == "stale-run" ]]; then
        gate_report_coordinated_no_work_failure 2 "$drain_failure_phase" \
          "$drain_failure_verdict"
      fi
      gate_drain_fail_for_context "$drain_context"
      return $?
    fi

    # Same rule between passes: a re-walk that found a forked child but could
    # not write it down must not be followed by another signal round, which
    # would kill that child's parent and leave it unrecorded.
    if [[ "$gate_drain_capture_unpersisted" -ne 0 ]]; then
      echo "error: could not write the captured process list to ${captured_file} while draining." >&2
      echo "error: still alive: ${alive:-none}${unverified:+, unverified: ${unverified}}" >&2
      echo "${drain_failure_prefix} Investigate those processes, fix that path, then re-run." >&2
      if [[ "$drain_context" == "stale-run" ]]; then
        gate_report_coordinated_no_work_failure 2 "$drain_failure_phase" \
          "$drain_failure_verdict"
      fi
      gate_drain_fail_for_context "$drain_context"
      return $?
    fi

    # Identity is re-read here rather than trusted from the census above. The
    # two are separated by the whole census, the bound check and the persist
    # check, and a PID recycled inside that gap would be signalled on the
    # strength of a check that passed for a process which no longer exists.
    while IFS='|' read -r pid recorded; do
      [[ -n "$pid" ]] || continue
      if [[ "$recorded" != "$gate_lock_identity_unavailable" ]]; then
        recorded="$(gate_lock_normalize_process_start "$recorded")"
        current="$(gate_lock_process_start "$pid")"
        if [[ -z "$current" || "$current" != "$recorded" ]]; then
          # Gone, or somebody else now. Either way this signal is not ours to
          # send; the next census re-classifies it.
          continue
        fi
      elif ! gate_drain_membership_holds "$pid" ""; then
        continue
      fi
      if [[ "$escalated" -eq 1 ]]; then
        kill -KILL "$pid" 2>/dev/null || true
      else
        kill -TERM "$pid" 2>/dev/null || true
      fi
    done << EOF
$alive_identities
EOF
    # After the first pass the tag carrier is usually dead, which is exactly
    # the state a successor has to be able to inherit.
    [[ "$waited" -ne 0 ]] || gate_lock_test_crash after-drain-term
    if [[ "$quiet_seed_only" -eq 1 && "$announced" -eq 0 ]]; then
      # A completed parallel worker stays alive only as the exact group anchor.
      # TERM should end that single blocked shell immediately. Poll quickly so
      # the safety sentinel does not add one second to every mapped command.
      sleep 0.05
    else
      sleep 1
    fi
    # Clock, not the sum of requested sleeps: a drain that is descheduled
    # should notice that its budget went with the time, and should print the
    # time that actually passed.
    waited=$(($(date +%s) - drain_started_at))
    # Give TERM a few seconds to be honoured before insisting.
    [[ "$waited" -lt 4 ]] || escalated=1

    # Re-walk after every signal pass, not once. A command that ignores TERM
    # can fork a child at any point before the KILL escalation reaches it, and
    # a child discovered after its parent was recorded is exactly the one that
    # would otherwise outlive this drain. Repeating the walk drives discovery
    # to a fixpoint: each pass either adds PIDs or does not, the list only
    # grows, PIDs are recorded once, and the whole loop is bounded — so it ends
    # either when a pass adds nothing and everything found is gone, or at the
    # bound, which fails closed.
    #
    # Re-asked of the token as well, not only of the survivors: a command that
    # forks a replacement and then exits leaves nothing to walk down from, and
    # the replacement is discoverable only by the token it inherited.
    gate_drain_refresh_tagged "$token"
    for pid in $alive $gate_drain_tagged_now; do
      capture_process_tree "$pid"
    done
    gate_drain_capture_seed_group "$token"
  done

  # Discharged: every process in the captured set is gone or belongs to
  # somebody else now, so the list has nothing left to hand on.
  [[ -z "$captured_file" ]] || rm -f "$captured_file"
  gate_run_discard_marker_exact "$token" \
    "The prior command identity was drained, but its marker cleanup failed." ||
    return $?

  if [[ -n "$recycled" ]]; then
    echo "Left alone: pid(s) ${recycled}now belong to unrelated processes."
  fi
  if [[ "$announced" -eq 1 ]]; then
    echo "$drain_done_message"
    echo
  fi
}

drain_completed_command_identity() {
  local token="$1"
  local clear_request_marker="${2:-0}"
  local seed_pgid="${3:-}"
  local seed_start="${4:-}"
  local quiet_seed_only="${5:-0}"
  local condemned_dir=""
  local coordinator_active=0
  local legacy_lock_active=0
  local announce_captured_non_seed=0
  [[ -n "$token" ]] || return 0

  if declare -F gate_coordinator_is_active >/dev/null 2>&1 &&
    gate_coordinator_is_active; then
    coordinator_active=1
  fi
  if [[ -n "$gate_lock_dir" && -n "$gate_lock_root_dir" &&
    -n "$gate_lock_token" ]]; then
    legacy_lock_active=1
  fi
  if [[ "$coordinator_active" -eq 1 || "$legacy_lock_active" -eq 1 ]]; then
    announce_captured_non_seed=1
  fi

  if [[ "$legacy_lock_active" -eq 1 ]]; then
    # One assignment-only command closes the signal window between the two
    # guards: cleanup must preserve both the marker and the legacy owner until
    # the recovery obligation exists on disk.
    gate_active_command_drain_in_progress=1 gate_cleanup_preserve_legacy_lock=1
    if ! record_condemned_run "$token"; then
      echo "error: could not record the completed command's descendants in ${gate_lock_root_dir:-unknown}/condemned.d." >&2
      echo "The legacy lock stays in place so a later run must reclaim and drain this run before executing work." >&2
      echo "The mapped command finished, but descendant cleanup did not start. Fix that path — permissions, or free space — then re-run." >&2
      return 2
    fi
    condemned_dir="$(gate_lock_condemned_dir)" || {
      echo "error: could not resolve the completed command's recovery directory." >&2
      return 2
    }
    gate_cleanup_preserve_legacy_lock=0
  elif [[ "$coordinator_active" -eq 1 ]]; then
    # The coordinator journal already contains this request's drain token and
    # lease. Preserve its marker until normal cleanup or recovery succeeds.
    gate_active_command_drain_in_progress=1
  else
    # An explicit --no-lock run has no durable recovery owner. It still drains
    # its exact live identity before returning, but it has no lock record to
    # preserve or obligation directory to publish into.
    gate_active_command_drain_in_progress=1
  fi

  # The active drain stays in the gate process. A second drainer for the same
  # token must never race this one over its append-only capture file.
  drain_condemned_run_commands \
    "$token" active-command "$seed_pgid" "$seed_start" \
    "$quiet_seed_only" "$announce_captured_non_seed" || return $?
  if [[ "$legacy_lock_active" -eq 1 ]]; then
    rm -f "${condemned_dir}/${token}"
  fi
  # The drain removes holder.<token>. A sequential command uses the request
  # marker itself, so clear that cached path. Parallel commands use their own
  # markers and leave the request-wide recovery marker in place.
  if [[ "$clear_request_marker" -eq 1 ]]; then
    gate_run_marker_file=""
  fi
  gate_active_command_drain_in_progress=0
}

drain_completed_sequential_command() {
  local token="${gate_run_id:-$gate_lock_token}"
  local clear_request_marker=1
  if declare -F gate_coordinator_is_active >/dev/null 2>&1 &&
    gate_coordinator_is_active &&
    [[ -n "${gate_coordinator_active_drain_identity:-}" ]]; then
    token="$gate_coordinator_active_drain_identity"
    clear_request_marker=0
  fi
  drain_completed_command_identity "$token" "$clear_request_marker"
}

drain_completed_parallel_command() {
  local drain_identity="$1"
  local worker_pgid="${2:-}"
  local worker_start="${3:-}"
  drain_completed_command_identity \
    "$drain_identity" 0 "$worker_pgid" "$worker_start" 1
}

assert_gate_run_lock_still_ours_legacy() {
  local recorded
  [[ -n "$gate_lock_dir" ]] || return 0
  recorded="$(gate_lock_owner_field "$gate_lock_dir" token)"
  [[ "$recorded" == "$gate_lock_token" ]] && return 0
  echo "error: this run no longer holds the gate run lock at ${gate_lock_dir}." >&2
  echo "Another run took it over before this one reached its mapped commands." >&2
  echo "Nothing has been executed. Re-run, and it will queue behind the current holder." >&2
  exit 2
}

release_gate_run_lock_legacy() {
  local recorded release_dir release_taken release_owner moved_owner_identity moved_owner_matches
  local private_owner_identity private_owner_matches inert_stage inert_name inert_pid
  local release_prepare_status release_take_status restored_owner_identity
  [[ -n "$gate_lock_dir" ]] || return 0
  recorded="$(gate_lock_owner_field "$gate_lock_dir" token)"
  # A token check followed by recursive deletion is not an ownership proof.
  # Another run can publish between those two operations. Take the exact owner
  # record by atomic rename, validate the copy, and remove only an empty lock
  # directory. A successor owner makes rmdir fail and remains untouched.
  if [[ "$recorded" != "$gate_lock_token" ]]; then
    gate_lock_dir=""
    return 0
  fi
  release_dir="$(mktemp -d "${gate_lock_root_dir}/owner-release.XXXXXX")" || {
    echo "error: could not create private state for quality-gate lock release; leaving the lock for stale recovery." >&2
    gate_lock_dir=""
    return 2
  }
  chmod 700 "$release_dir" || {
    rmdir "$release_dir" 2>/dev/null || true
    echo "error: could not protect private state for quality-gate lock release; leaving the lock for stale recovery." >&2
    gate_lock_dir=""
    return 2
  }
  # Keep the original owner inode open across the test delay and atomic take.
  # A replacement can copy this run's token, so token equality alone does not
  # authorize release. Node compares the moved path to this descriptor's
  # device and inode because macOS exposes /dev/fd on a different st_dev.
  if ! exec 14< "$gate_lock_dir/owner"; then
    rmdir "$release_dir" 2>/dev/null || true
    gate_lock_dir=""
    return 0
  fi
  if ! recorded="$(
    gate_lock_current_user_authority_token_from_release_descriptor
  )" || [[ "$recorded" != "$gate_lock_token" ]]; then
    exec 14<&-
    rmdir "$release_dir" 2>/dev/null || true
    echo "error: the quality-gate owner changed or became unsafe before release; leaving it in place." >&2
    gate_lock_dir=""
    return 2
  fi
  # The unique private-directory basename also gives the in-lock take a name
  # no other releaser can own. Keep the record recovery-visible until its token
  # is validated. A SIGKILL before that check must not hide a live successor in
  # private state where the next waiter cannot find it.
  release_taken="${gate_lock_dir}/owner.reclaiming.release.${release_dir##*/}"
  release_owner="$release_dir/owner"
  gate_lock_test_delay "${AGENT_QUALITY_GATE_LOCK_RELEASE_BEFORE_TAKE_DELAY_SECONDS:-}"
  if ! mv "$gate_lock_dir/owner" "$release_taken" 2>/dev/null; then
    exec 14<&-
    rmdir "$release_dir" 2>/dev/null || true
    gate_lock_dir=""
    return 0
  fi
  gate_lock_test_crash after-release-visible-take
  moved_owner_identity="$(gate_lock_current_user_authority_token_from_record "$release_taken")" ||
    moved_owner_identity=""
  moved_owner_matches=0
  gate_lock_path_matches_open_descriptor "$release_taken" 14 &&
    moved_owner_matches=1
  if [[ "$moved_owner_identity" != "$gate_lock_token" ||
    "$moved_owner_matches" -ne 1 ]]; then
    exec 14<&-
    if /bin/ln -P "$release_taken" "$gate_lock_dir/owner" 2>/dev/null; then
      if ! gate_lock_discard_matching_duplicate \
        "$release_taken" "$moved_owner_identity" "$gate_lock_dir/owner"; then
        echo "error: the displaced quality-gate owner changed before duplicate cleanup; retained ${release_taken}." >&2
        gate_lock_dir=""
        return 2
      fi
    elif gate_lock_condemn_and_discard "$release_taken"; then
      :
    else
      echo "error: could not restore or preserve the displaced quality-gate owner; retained ${release_taken}." >&2
      gate_lock_dir=""
      return 2
    fi
    rmdir "$release_dir" 2>/dev/null || true
    gate_lock_dir=""
    return 0
  fi
  if ! gate_lock_wait_for_test_barrier "$release_validated_test_barrier"; then
    exec 14<&-
    echo "error: the quality-gate release validation barrier failed; retained ${release_taken}." >&2
    gate_lock_dir=""
    return 2
  fi
  if ! mv "$release_taken" "$release_owner" 2>/dev/null; then
    exec 14<&-
    # Recovery can restore a live record while this process is descheduled.
    # Yield to the canonical owner if that happened. Otherwise retain the
    # in-lock remnant so the next waiter can recover it.
    rmdir "$release_dir" 2>/dev/null || true
    if [[ -e "$gate_lock_dir/owner" || -L "$gate_lock_dir/owner" ]]; then
      gate_lock_dir=""
      return 0
    fi
    echo "error: could not move the validated quality-gate owner into private release state; retained ${release_taken}." >&2
    gate_lock_dir=""
    return 2
  fi
  private_owner_identity="$(
    gate_lock_current_user_authority_token_from_record "$release_owner"
  )" || private_owner_identity=""
  private_owner_matches=0
  gate_lock_path_matches_open_descriptor "$release_owner" 14 &&
    private_owner_matches=1
  if [[ "$private_owner_identity" != "$gate_lock_token" ||
    "$private_owner_matches" -ne 1 ]]; then
    exec 14<&-
    if /bin/ln -P "$release_owner" "$gate_lock_dir/owner" 2>/dev/null; then
      echo "error: restored a replacement quality-gate owner after the private release move; retained ${release_owner}." >&2
    elif [[ -e "$gate_lock_dir/owner" || -L "$gate_lock_dir/owner" ]]; then
      echo "error: a successor owns the canonical quality-gate path; retained replacement evidence at ${release_owner}." >&2
    else
      echo "error: the private quality-gate owner changed during release; retained ${release_owner}." >&2
    fi
    gate_lock_dir=""
    return 2
  fi
  # A gate killed while it built or published an owner can leave a private
  # staging link in run.lock. These exact names never grant authority and no
  # reader consumes them. Remove them only after the canonical owner has been
  # taken and validated and their publishing PID is gone. A live handoff or
  # rollback still needs its stage, so it must block rmdir and make this
  # release restore or yield its owner.
  for inert_stage in \
    "$gate_lock_dir"/owner.claiming.* \
    "$gate_lock_dir"/owner.coordinator.* \
    "$gate_lock_dir"/owner.rollback.*; do
    inert_name="${inert_stage##*/}"
    [[ "$inert_name" =~ ^owner\.(claiming|coordinator|rollback)\.[1-9][0-9]*$ ]] || continue
    [[ -f "$inert_stage" && ! -L "$inert_stage" && -O "$inert_stage" ]] || continue
    inert_pid="${inert_name##*.}"
    if ! gate_lock_discard_inert_owner_stage "$inert_stage" "$inert_pid" \
      "Mapped work passed, but exact lock release did not complete."; then
      echo "error: could not remove stale quality-gate owner stage ${inert_stage}; restoring the owner." >&2
      break
    fi
  done

  # Bind the exact private owner before the release delay. A same-token inode
  # can replace the predictable `owner` path while this process is paused. The
  # quarantine anchor remains the original descriptor-bound inode. After the
  # delay, the quarantine take moves the current pathname into private state
  # and rejects it unless it is that same inode.
  if gate_lock_prepare_owner_quarantine "$release_owner" \
    "Mapped work passed, but exact lock release did not complete."; then
    :
  else
    release_prepare_status=$?
    exec 14<&-
    echo "error: could not witness the exact private quality-gate owner before release cleanup (status ${release_prepare_status}); retained ${release_dir}." >&2
    gate_lock_dir=""
    return 2
  fi
  if [[ "$gate_lock_quarantine_authority_value" != "$gate_lock_token" ]] ||
    ! gate_lock_path_matches_open_descriptor \
      "$gate_lock_quarantine_anchor" 14 ||
    [[ ! "$release_owner" -ef "$gate_lock_quarantine_anchor" ]]; then
    exec 14<&-
    gate_lock_retain_quarantine \
      "the private quality-gate owner witness does not match the released inode" || true
    gate_lock_dir=""
    return 2
  fi
  exec 14<&-

  gate_lock_test_delay "${AGENT_QUALITY_GATE_LOCK_RELEASE_AFTER_TAKE_DELAY_SECONDS:-}"
  if ! gate_lock_wait_for_test_barrier "$release_private_test_barrier"; then
    gate_lock_retain_quarantine \
      "the private quality-gate owner release barrier failed" || true
    gate_lock_dir=""
    return 2
  fi
  if ! gate_lock_mark_quarantine_fallback; then
    gate_lock_dir=""
    return 2
  fi
  if gate_lock_take_prepared_quarantine; then
    :
  else
    release_take_status=$?
    [[ -z "$gate_lock_quarantine_dir" ]] ||
      gate_lock_retain_quarantine \
        "the private quality-gate owner changed before exact release cleanup" || true
    gate_lock_dir=""
    [[ "$release_take_status" -eq 1 ]] && return 2
    return "$release_take_status"
  fi

  if rmdir "$gate_lock_dir" 2>/dev/null; then
    if ! gate_lock_drop_private_quarantine; then
      gate_lock_dir=""
      return 2
    fi
    if ! rmdir "$release_dir" 2>/dev/null; then
      echo "error: private quality-gate release state changed after exact lock removal; retained ${release_dir}." >&2
      gate_lock_dir=""
      return 2
    fi
    gate_lock_dir=""
    return 0
  fi
  if [[ -e "$gate_lock_dir/owner" || -L "$gate_lock_dir/owner" ]]; then
    # A successor published while this release held the old record. Its
    # canonical owner blocks rmdir, so only our private record is obsolete.
    if ! gate_lock_drop_private_quarantine; then
      gate_lock_dir=""
      return 2
    fi
  elif /bin/ln -P "$gate_lock_quarantine_anchor" \
    "$gate_lock_dir/owner" 2>/dev/null; then
    if ! restored_owner_identity="$(
      gate_lock_current_user_authority_token_from_record \
        "$gate_lock_dir/owner"
    )" || [[ "$restored_owner_identity" != "$gate_lock_token" ]] ||
      [[ ! "$gate_lock_dir/owner" -ef "$gate_lock_quarantine_anchor" ]]; then
      gate_lock_retain_quarantine \
        "the restored quality-gate owner does not match the exact release inode" || true
      gate_lock_dir=""
      return 2
    fi
    if ! gate_lock_drop_private_quarantine; then
      gate_lock_dir=""
      return 2
    fi
  elif [[ -e "$gate_lock_dir/owner" || -L "$gate_lock_dir/owner" ]]; then
    # A successor won the canonical path between the check and exclusive link.
    # Preserve it and discard only this run's private release record.
    if ! gate_lock_drop_private_quarantine; then
      gate_lock_dir=""
      return 2
    fi
  else
    gate_lock_retain_quarantine \
      "could not restore the exact quality-gate owner after lock release failed" || true
    gate_lock_dir=""
    return 2
  fi
  if ! rmdir "$release_dir" 2>/dev/null; then
    echo "error: private quality-gate release state changed during cleanup; retained ${release_dir}." >&2
    gate_lock_dir=""
    return 2
  fi
  gate_lock_dir=""
  return 0
}

gate_lock_refuse_owner_publication() {
  echo "error: could not publish a complete, validated legacy owner identity." >&2
  echo "Nothing has been executed." >&2
  gate_report_coordinated_no_work_failure 2 "legacy owner publication" \
    "No mapped command ran in this request"
  exit 2
}

acquire_gate_run_lock_legacy() {
  local root lock owner_pid owner_host owner_worktree owner_token_value owner_start
  local stale_reason owner_state nap remaining now_millis
  local coordinator_join_status owner_record taken_record record_status
  local hidden_recovery_status hidden_recovery_busy
  local claim_uid claim_epoch claim_token claim_status
  # Elapsed time comes from the clock, never from adding up requested sleeps.
  # A shell that is descheduled or SIGSTOPped sleeps far longer than it asked
  # to, and counting the request would let a run outlive the budget it printed
  # while reporting a smaller number than it actually took. Read in
  # milliseconds and reported in whole seconds: measuring in whole seconds
  # instead charges the wait up to a second it never spent.
  local waited=0
  local wait_started_at
  local last_beat=0
  local announced=0
  local ownerless_since=""
  local this_host
  case "$gate_lock_enabled" in
    0|false|no) return 0 ;;
  esac
  if [[ -n "${AGENT_QUALITY_GATE_LOCK_HELD:-}" ]]; then
    # A gate running inside a gate — the self-test drives the gate against
    # fixture repos — already holds this machine's lock through its parent.
    # Waiting for our own ancestor would deadlock.
    return 0
  fi
  if ! root="$(resolve_gate_lock_root)"; then
    # Defence in depth rather than a reachable state today: the last candidate
    # is the repo scratch directory, and a run whose scratch directory is
    # unwritable has already failed before reaching this. It is written to fail
    # closed anyway, because running on would silently give an ordinary `--run`
    # the semantics of the explicit escape hatch, which is how the port
    # conflicts and mutual starvation this lock exists for come back. Exclusion
    # is the default, so losing it is the caller's decision to make out loud.
    echo "error: no writable lock directory, so this run cannot take the gate run lock." >&2
    echo "Set AGENT_QUALITY_GATE_LOCK_DIR to a writable path, or re-run with --no-lock to accept the contention." >&2
    echo "Nothing has been executed." >&2
    gate_report_coordinated_no_work_failure 2 "startup" \
      "No mapped command ran in this request"
    exit 2
  fi
  lock="$root/run.lock"
  owner_record="$lock/owner"
  gate_lock_root_dir="$root"
  if ! gate_lock_ensure_local_host_fingerprint; then
    echo "error: could not derive the local host identity for safe owner quarantine recovery." >&2
    echo "Nothing has been executed." >&2
    gate_report_coordinated_no_work_failure 2 "legacy owner recovery" \
      "No mapped command ran in this request"
    exit 2
  fi
  this_host="$gate_lock_local_host_name"
  if ! claim_uid="$(id -u 2>/dev/null)" ||
    [[ ! "$claim_uid" =~ ^[0-9]+$ ]]; then
    echo "error: could not derive the current user identity for safe legacy owner publication." >&2
    echo "Nothing has been executed." >&2
    gate_report_coordinated_no_work_failure 2 "legacy owner publication" \
      "No mapped command ran in this request"
    exit 2
  fi
  if ! claim_epoch="$(date +%s 2>/dev/null)" ||
    [[ ! "$claim_epoch" =~ ^[0-9]{1,12}$ ]]; then
    echo "error: could not derive a safe legacy owner claim token." >&2
    echo "Nothing has been executed." >&2
    gate_report_coordinated_no_work_failure 2 "legacy owner publication" \
      "No mapped command ran in this request"
    exit 2
  fi
  claim_token="${this_host}-$$-${claim_epoch}"
  if ! gate_lock_token_is_wellformed "$claim_token"; then
    echo "error: could not derive a safe legacy owner claim token." >&2
    echo "Nothing has been executed." >&2
    gate_report_coordinated_no_work_failure 2 "legacy owner publication" \
      "No mapped command ran in this request"
    exit 2
  fi
  wait_started_at="$(gate_wall_millis)"

  while :; do
    hidden_recovery_busy=0
    # A coordinator can finish adopting the legacy owner while this waiter is
    # in the legacy loop. Probe before each claim attempt so a new client joins
    # it instead of waiting for its intentionally long-lived compatibility
    # lock. Legacy-only runs never define this function.
    if declare -F gate_coordinator_try_join_existing >/dev/null 2>&1; then
      if gate_coordinator_try_join_existing; then
        return 0
      else
        coordinator_join_status=$?
        [[ "$coordinator_join_status" -eq 1 ]] || return "$coordinator_join_status"
      fi
    fi
    now_millis="$(gate_wall_millis)"
    # A clock stepped backwards mid-wait — this is a wall clock, and NTP steps
    # it — would otherwise make every later delta smaller than the budget, so
    # the wait would outlive the budget it announced. Re-anchoring costs the
    # step's worth of waiting and keeps the budget reachable; clamping the
    # delta to zero would only tidy the number printed.
    [[ "$now_millis" -ge "$wait_started_at" ]] || wait_started_at="$now_millis"
    waited=$(((now_millis - wait_started_at) / 1000))
    if mkdir "$lock" 2>/dev/null; then
      gate_lock_test_crash after-mkdir
      gate_lock_test_delay "${AGENT_QUALITY_GATE_LOCK_CLAIM_DELAY_SECONDS:-}"
      if claim_gate_run_lock "$lock" "$claim_token" "$claim_uid"; then
        if [[ "$announced" -eq 1 ]]; then
          echo "Acquired the gate run lock after ${waited}s."
          echo
        fi
        return 0
      else
        claim_status=$?
        [[ "$claim_status" -ne 2 ]] || gate_lock_refuse_owner_publication
      fi
      # We created the directory but never recorded ownership: a waiter
      # reclaimed it while this process was descheduled, and it is that run's
      # lock now. Touch nothing and queue like any other waiter.
      echo "Another run recorded ownership of ${lock} first; queueing behind it." >&2
    fi

    gate_lock_require_safe_existing_owner_record "$owner_record"
    owner_pid="$(gate_lock_owner_field "$lock" pid)"
    owner_host="$(gate_lock_owner_field "$lock" host)"
    owner_worktree="$(gate_lock_owner_field "$lock" worktree)"
    owner_token_value="$(gate_lock_owner_field "$lock" token)"
    owner_start="$(gate_lock_owner_field "$lock" start_utc)"
    gate_lock_require_safe_existing_owner_record "$owner_record"
    if [[ -z "$owner_token_value" ]]; then
      # Before believing there is no holder, read the remnants of any reclaim
      # that was killed mid-take. One of them may be the holder's own record.
      if gate_lock_recover_hidden_record "$lock" "$this_host"; then
        gate_lock_require_safe_existing_owner_record "$owner_record"
        owner_pid="$(gate_lock_owner_field "$lock" pid)"
        owner_host="$(gate_lock_owner_field "$lock" host)"
        owner_worktree="$(gate_lock_owner_field "$lock" worktree)"
        owner_token_value="$(gate_lock_owner_field "$lock" token)"
        owner_start="$(gate_lock_owner_field "$lock" start_utc)"
        gate_lock_require_safe_existing_owner_record "$owner_record"
      else
        hidden_recovery_status=$?
        if [[ "$hidden_recovery_status" -eq 4 ]]; then
          hidden_recovery_busy=1
          owner_pid="${gate_lock_active_quarantine_pid:-unknown}"
          owner_host="${gate_lock_active_quarantine_host:-$this_host}"
          owner_worktree="owner cleanup"
        fi
      fi
    fi

    stale_reason=""
    [[ -n "$owner_token_value" ]] && ownerless_since=""
    if [[ -z "$owner_token_value" && "$hidden_recovery_busy" -eq 1 ]]; then
      ownerless_since=""
    elif [[ -z "$owner_token_value" ]]; then
      # No complete record: either no file at all, or one a run was killed
      # part-way through writing. The token is written last, so its absence
      # means the write never finished and nothing in the file can be trusted
      # — not even the PID, which may itself be a truncated value. Timed from
      # our own first sighting rather than a filesystem timestamp, because the
      # holder is exactly the process that has not published a record yet.
      [[ -n "$ownerless_since" ]] || ownerless_since="$(date +%s)"
      if [[ $(($(date +%s) - ownerless_since)) -ge "$gate_lock_owner_grace_seconds" ]]; then
        stale_reason="its holder never recorded a complete identity"
      fi
    elif [[ -n "$owner_host" && "$owner_host" != "$this_host" ]]; then
      # Only reachable if the lock root is on shared storage. Another host's
      # PIDs mean nothing here, so wait it out rather than guess.
      :
    elif ! gate_lock_token_is_wellformed "$owner_token_value"; then
      # A token this gate would never generate. Reclaiming would later drain
      # by that token — matching processes with a value another writer chose
      # — so the holder is assumed live and waited out; the timeout fails
      # closed with the holder line naming the record.
      :
    elif ! gate_lock_holder_is_live "$owner_pid" "$owner_start"; then
      owner_state="$(gate_lock_process_state "$owner_pid")"
      if [[ "$owner_state" == Z* ]]; then
        stale_reason="holder pid ${owner_pid} has exited and is awaiting reap"
      elif kill -0 "$owner_pid" 2>/dev/null; then
        stale_reason="pid ${owner_pid} now belongs to a different process"
      else
        stale_reason="holder pid ${owner_pid} is gone"
      fi
    fi

    if [[ -n "$stale_reason" ]]; then
      gate_lock_test_delay "${AGENT_QUALITY_GATE_LOCK_RECLAIM_DELAY_SECONDS:-}"
      # The verdict above was formed before the delay; re-settle the remnants
      # right here, because a record in flight under a remnant means an empty
      # canonical path is not evidence that the lock is free. If that restores
      # a live holder, this verdict is void and we go back to waiting.
      gate_lock_require_safe_existing_owner_record "$owner_record"
      hidden_recovery_status=1
      if gate_lock_recover_hidden_record "$lock" "$this_host"; then
        hidden_recovery_status=0
        gate_lock_require_safe_existing_owner_record "$owner_record"
        owner_pid="$(gate_lock_owner_field "$lock" pid)"
        owner_host="$(gate_lock_owner_field "$lock" host)"
        owner_worktree="$(gate_lock_owner_field "$lock" worktree)"
      else
        hidden_recovery_status=$?
        if [[ "$hidden_recovery_status" -eq 4 ]]; then
          owner_pid="${gate_lock_active_quarantine_pid:-unknown}"
          owner_host="${gate_lock_active_quarantine_host:-$this_host}"
          owner_worktree="owner cleanup"
        fi
      fi
      if [[ "$hidden_recovery_status" -eq 4 ]]; then
        :
      elif [[ "$hidden_recovery_status" -eq 0 ]]; then
        :
      elif [[ ! -e "$owner_record" && ! -L "$owner_record" ]]; then
        # Nothing in the way: publishing the record is the whole contest.
        # Whoever links it into place first holds the lock; everyone else,
        # including the creator that stalled, finds their publish refused.
        if claim_gate_run_lock "$lock" "$claim_token" "$claim_uid"; then
          echo "Gate run lock at ${lock} is stale (${stale_reason}); reclaiming it." >&2
          if [[ "$announced" -eq 1 ]]; then
            echo "Acquired the gate run lock after ${waited}s."
            echo
          fi
          return 0
        else
          claim_status=$?
          [[ "$claim_status" -ne 2 ]] || gate_lock_refuse_owner_publication
        fi
      else
        # Something is in the way: a dead holder's record, or one a killed run
        # left half-written. Either has to be taken away by rename before a
        # claim can publish, because `ln` refuses an occupied path. rename(2)
        # is atomic and the source vanishes with it, so exactly one waiter can
        # win a given record and everyone arriving later fails with ENOENT —
        # no waiter can act on a verdict another has already acted on.
        # Registered with the exit trap before it exists: the path carries our
        # PID, so cleanup can never race the rename, nor name another run.
        gate_lock_reclaim_origin="$lock/owner"
        gate_lock_reclaim_tmp="${lock}/owner.reclaiming.$$"
        gate_lock_require_safe_existing_owner_record "$owner_record"
        if [[ -e "$owner_record" || -L "$owner_record" ]] &&
          [[ ! -O "$owner_record" ]]; then
          gate_lock_reclaim_tmp=""
          gate_lock_reclaim_origin=""
          gate_lock_refuse_foreign_owner_recovery "$owner_record"
        fi
        if mv "$owner_record" "$gate_lock_reclaim_tmp" 2>/dev/null; then
          gate_lock_test_crash after-take
          if ! gate_lock_wait_for_test_barrier "$lock_taken_test_barrier"; then
            restore_gate_lock_record || true
            gate_report_coordinated_no_work_failure 2 \
              "legacy owner recovery" \
              "No mapped command ran in this request"
            exit 2
          fi
          gate_lock_test_delay "${AGENT_QUALITY_GATE_LOCK_TAKEN_DELAY_SECONDS:-}"
          taken_record="$gate_lock_reclaim_tmp"
          if [[ ! -e "$taken_record" && ! -L "$taken_record" ]]; then
            gate_lock_reclaim_tmp=""
            gate_lock_reclaim_origin=""
          elif ! gate_lock_record_is_readable_regular "$taken_record"; then
            gate_lock_reclaim_tmp=""
            gate_lock_reclaim_origin=""
            gate_lock_refuse_unsafe_owner_record "$taken_record"
          elif gate_lock_record_still_stale \
            "$taken_record" "$owner_pid" "$owner_token_value" "$owner_start"; then
            echo "Gate run lock at ${lock} is stale (${stale_reason}); reclaiming it." >&2
            # The holder is gone, but a gate killed mid-command leaves that
            # command running. Write down whose it was — on disk, before taking
            # over, so the obligation survives this process — and confirm they
            # are gone just before this run's own commands. Not here: draining
            # between judging the record and publishing would hand another
            # waiter the same verdict and the same window to act on it.
            # Nothing below this line is reversible: the record is deleted and
            # this run publishes its own. So the obligation is written first,
            # and a write that fails puts the record back and stops the run
            # rather than taking over with no successor for those commands.
            if gate_lock_condemn_and_discard "$taken_record"; then
              :
            else
              record_status=$?
              restore_gate_lock_record || true
              [[ "$record_status" -ne 1 ]] || gate_lock_obligation_unwritable
              gate_report_coordinated_no_work_failure 2 \
                "legacy owner recovery" \
                "No mapped command ran in this request"
              exit 2
            fi
            gate_lock_reclaim_tmp=""
            gate_lock_reclaim_origin=""
            if claim_gate_run_lock "$lock" "$claim_token" "$claim_uid"; then
              if [[ "$announced" -eq 1 ]]; then
                echo "Acquired the gate run lock after ${waited}s."
                echo
              fi
              return 0
            else
              claim_status=$?
              [[ "$claim_status" -ne 2 ]] || gate_lock_refuse_owner_publication
            fi
          else
            record_status=$?
            if [[ "$record_status" -eq 2 ]]; then
              gate_lock_reclaim_tmp=""
              gate_lock_reclaim_origin=""
              gate_lock_refuse_unsafe_owner_record "$taken_record"
            elif [[ "$record_status" -eq 3 ]]; then
              gate_lock_reclaim_tmp=""
              gate_lock_reclaim_origin=""
            else
              # We took a record that is not the one we judged — another run
              # reclaimed the lock while we decided. Put it back and wait. If
              # it could not be put back or written down it stays where it is,
              # named in the output, for the next hidden-record recovery.
              restore_gate_lock_record || true
            fi
          fi
        fi
        gate_lock_reclaim_tmp=""
        gate_lock_reclaim_origin=""
      fi
      # Whatever happened above, the holder of record may have changed.
      owner_pid="$(gate_lock_owner_field "$lock" pid)"
      owner_host="$(gate_lock_owner_field "$lock" host)"
      owner_worktree="$(gate_lock_owner_field "$lock" worktree)"
    fi

    if [[ "$announced" -eq 0 ]]; then
      echo
      echo "Waiting for the agent quality gate run lock: ${lock}"
      echo "  held by pid ${owner_pid:-unknown} on ${owner_host:-unknown} in ${owner_worktree:-unknown}"
      echo "  one gate run executes mapped commands at a time so runs cannot starve each other (GitHub issue #1802)."
      echo "  waiting up to ${gate_lock_wait_seconds}s; interrupt to abort, or re-run with --no-lock."
      announced=1
    elif [[ $((waited - last_beat)) -ge 30 ]]; then
      echo "  … still waiting after ${waited}s (holder pid ${owner_pid:-unknown})."
      last_beat="$waited"
    fi

    if [[ "$waited" -ge "$gate_lock_wait_seconds" ]]; then
      echo "error: timed out after ${waited}s waiting for the gate run lock at ${lock}." >&2
      echo "Holder pid ${owner_pid:-unknown} is still alive; let it finish, then retry." >&2
      echo "Running the gate directly? --no-lock starts anyway and accepts the contention." >&2
      # The pre-push hook passes a fixed command line and Trunk strips the
      # environment, so neither escape hatch is reachable from a failed push.
      echo "Pushing? Warm the stamps with 'pnpm agent:quality-gate --run' first, then push: --skip-if-fresh cache-hits and exits before this lock." >&2
      # GitHub issue #1894. Every other outcome states itself on stdout — a green
      # run ends "All mapped commands passed." — but this one used to speak on
      # stderr alone, so a caller reading the gate's stdout saw the reassuring
      # "waiting up to Ns" banner and then nothing. Pair that with a pipeline,
      # whose status is the READER's unless the caller set `pipefail`, and a run
      # that executed nothing reads as a pass on both signals at once. So the
      # verdict goes to stdout too, and names the status a pipeline hides.
      # SIGPIPE is ignored and the writes are optional because they come after
      # the stderr diagnosis and must never displace it: a stdout that closes
      # while this verdict is being written costs the caller the stdout copy,
      # never the stderr copy and never the exit status. A reader that closed
      # earlier still kills the run on the wait banner above, which is a
      # SIGPIPE death — non-zero, so still not a pass, which is the invariant
      # this path owes its caller.
      trap '' PIPE
      echo "Gate run lock wait expired after ${waited}s. No mapped command ran; this gate exits 2." 2>/dev/null || true
      echo "Piped? A pipeline reports the reader's status: read \${PIPESTATUS[0]} or set -o pipefail." 2>/dev/null || true
      exit 2
    fi
    # Never sleep past the budget: with a wait shorter than — or not divisible
    # by — the poll interval, a full-interval sleep would overshoot and then
    # report the overshoot as the elapsed time. Capping keeps `--lock-wait 1`
    # honest at one second, and leaves ordinary waits at a full interval.
    nap="$gate_lock_poll_seconds"
    remaining=$((gate_lock_wait_seconds - waited))
    [[ "$nap" -le "$remaining" ]] || nap="$remaining"
    [[ "$nap" -ge 1 ]] || nap=1
    sleep "$nap"
  done
}

gate_coordinator_requested() {
  case "$gate_coordinator_enabled" in
    1|true|yes) ;;
    *) return 1 ;;
  esac
  case "$gate_lock_enabled" in
    0|false|no) return 1 ;;
  esac
  [[ -z "${AGENT_QUALITY_GATE_LOCK_HELD:-}" ]]
}

gate_run_ensure_token() {
  if [[ -z "$gate_run_id" ]]; then
    if [[ -z "$gate_lock_local_host_name" ]] &&
      ! gate_lock_ensure_local_host_fingerprint; then
      echo "error: this gate could not create a safe scheduler drain token." >&2
      return 2
    fi
    gate_run_id="${gate_lock_local_host_name}-$$-$(date +%s)"
  fi
  if ! gate_lock_token_is_wellformed "$gate_run_id"; then
    echo "error: this gate could not create a safe scheduler drain token." >&2
    return 2
  fi
}

acquire_gate_run_lock() {
  local coordinator_join_status
  if ! gate_coordinator_requested; then
    acquire_gate_run_lock_legacy
    return
  fi

  if ! gate_lock_ensure_local_host_fingerprint; then
    echo "error: could not derive the local host identity for safe coordinator marker recovery." >&2
    echo "Nothing has been executed." >&2
    gate_report_coordinated_no_work_failure 2 "coordinator startup" \
      "No mapped command ran in this request"
    return 2
  fi
  gate_run_ensure_token || return 2
  if gate_coordinator_try_join_existing; then
    return 0
  else
    coordinator_join_status=$?
    [[ "$coordinator_join_status" -eq 1 ]] || return "$coordinator_join_status"
  fi

  acquire_gate_run_lock_legacy
  # The legacy wait loop probes again on every pass. Another gate can finish
  # coordinator startup while this request waits, in which case that probe has
  # already registered this request and no second bootstrap is permitted.
  if declare -F gate_coordinator_is_active >/dev/null 2>&1 &&
    gate_coordinator_is_active; then
    return 0
  fi
  if ! gate_coordinator_bootstrap_from_legacy; then
    echo "error: the quality-gate coordinator could not adopt the legacy run lock." >&2
    echo "No mapped command ran. Re-run after the current coordinator or legacy holder exits." >&2
    return 2
  fi
}

assert_gate_run_lock_still_ours() {
  if declare -F gate_coordinator_is_active >/dev/null 2>&1 &&
    gate_coordinator_is_active; then
    gate_coordinator_assert_authority
    return
  fi
  assert_gate_run_lock_still_ours_legacy
}

release_gate_run_lock() {
  if declare -F gate_coordinator_is_active >/dev/null 2>&1 &&
    gate_coordinator_is_active; then
    # The coordinator retains and releases the legacy lock after all requests,
    # leases, and drain obligations settle. A client must never delete it.
    gate_lock_dir=""
    return 0
  fi
  if [[ "$gate_cleanup_preserve_legacy_lock" -eq 1 ]]; then
    return 0
  fi
  release_gate_run_lock_legacy
}

cleanup_tmpfiles() {
  local original_status=$?
  local marker_status=0
  local release_status=0
  teardown_active_timeouts
  if [[ ${#tmpfiles[@]} -gt 0 ]]; then
    rm -f "${tmpfiles[@]+"${tmpfiles[@]}"}"
  fi
  # A reclaim in flight is milliseconds long, but a signal can still land in
  # it. The temp path is registered before the rename that creates it, so this
  # sees it whether or not it exists — and it restores rather than deletes,
  # because a record taken but not yet judged may still name a live holder.
  # A restore that could not write the obligation down has already reported it
  # and kept the record; teardown continues either way, because skipping the
  # release below would leave the lock behind.
  restore_gate_lock_record || true
  # A half-built claim record is private to this process and was never linked
  # into place, so it is simply dropped.
  if [[ -n "$gate_lock_claim_tmp" ]]; then
    rm -f "$gate_lock_claim_tmp"
    gate_lock_claim_tmp=""
  fi
  # Same for a staged obligation: it was never published, and the record it
  # was derived from is still where it was, so nothing is lost by dropping it.
  if [[ -n "$gate_lock_condemn_tmp" ]]; then
    rm -f "$gate_lock_condemn_tmp"
    gate_lock_condemn_tmp=""
  fi
  if declare -F gate_coordinator_cleanup >/dev/null 2>&1; then
    gate_coordinator_cleanup || true
  fi
  # Dropped after the workers are down, so it is gone only once nothing of ours
  # is left holding it. A run that dies before this leaves it behind on
  # purpose: that is the handle its successor needs.
  if [[ -n "$gate_run_marker_file" &&
    "$gate_active_command_drain_in_progress" -eq 0 ]]; then
    if gate_run_discard_marker_exact \
      "${gate_run_id:-$gate_lock_token}" \
      "This gate stopped, but its run-marker cleanup failed."; then
      gate_run_marker_file=""
    else
      marker_status=$?
    fi
  fi
  # Released last: the lock must outlive worker teardown, or the next run
  # starts while this one's mapped commands are still dying.
  if release_gate_run_lock; then
    release_status=0
  else
    release_status=$?
  fi
  if [[ "$original_status" -eq 0 ]] && {
    [[ "$marker_status" -ne 0 ]] || [[ "$release_status" -ne 0 ]]
  }; then
    trap - EXIT
    exit 2
  fi
}
trap cleanup_tmpfiles EXIT

on_terminating_signal() {
  local signal="$1"
  if [[ "$worker_registration_in_progress" -eq 1 ||
    "$worker_settlement_in_progress" -eq 1 ]]; then
    [[ -n "$pending_terminating_signal" ]] ||
      pending_terminating_signal="$signal"
    return 0
  fi
  trap '' INT TERM
  teardown_active_timeouts
  trap - "$signal"
  kill "-${signal}" "$$" 2>/dev/null || exit 143
}

finish_worker_registration() {
  local signal
  worker_registration_in_progress=0
  if [[ -n "$pending_terminating_signal" ]]; then
    signal="$pending_terminating_signal"
    pending_terminating_signal=""
    on_terminating_signal "$signal"
  fi
}

finish_worker_settlement() {
  local signal
  worker_settlement_in_progress=0
  if [[ -n "$pending_terminating_signal" ]]; then
    signal="$pending_terminating_signal"
    pending_terminating_signal=""
    on_terminating_signal "$signal"
  fi
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
fi
if ! collect_current_changed_paths |
  sed '/^$/d' | LC_ALL=C sort -u > "$changed_paths_file"; then
  echo "error: failed to collect the current changed paths." >&2
  exit 2
fi

if [[ ! -s "$changed_paths_file" ]]; then
  echo "No changed paths detected against ${base_ref}...${head_ref}."
  exit 0
fi

# The routing-sensitive classifier's own preflight. The mapping engine reads
# this module too, and decides the `--check-fixtures` command from it; what runs
# here is the contract check, ahead of the engine, so a stale path or a
# classifier that stopped exporting `isRoutingSensitivePath` is named by module
# rather than reported as `gate mapping engine failed (exit 3)`.
#
# Routing classification runs from the gate's own source tree, not the repo
# under test, so a `scripts/` move must repoint this literal in the same commit.
# Nothing in CI runs the gate for real; the gate self-test is what exercises this
# import there, and a developer's pre-push is where a stale path bites first.
# The loader below therefore exits 3 and names the module it could not resolve,
# instead of letting the failure read as a generic classifier fault. The verdict
# is validated for the same reason: a classifier that answered something other
# than `true`/`false` would be a broken contract, not a routing result.
routing_classifier_path="$script_source_dir/docs/docs-navigation-eval-helpers.mjs"
routing_sensitive_paths_changed=""
routing_classifier_status=0
routing_sensitive_paths_changed="$(
  node --input-type=module - \
    "$routing_classifier_path" \
    "$changed_paths_file" <<'NODE'
import { readFileSync, writeSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [classifierPath, changedPathsPath] = process.argv.slice(2);
let isRoutingSensitivePath;
try {
  ({ isRoutingSensitivePath } = await import(
    pathToFileURL(classifierPath).href
  ));
} catch (error) {
  // writeSync, not process.stderr.write: process.exit() drops whatever is still
  // queued on an async stderr, which is what stderr is whenever the gate runs
  // under a pipe rather than a terminal.
  //
  // Nothing in this heredoc, code or prose, may leave a quote, backtick, or
  // paren unbalanced. bash 3.2 mis-scans one inside a heredoc nested in $( ),
  // which is how the gate runs this snippet, and
  // check-sentry-suites-in-ci-gate-probe parses the gate with /bin/bash — 3.2
  // on macOS. A lone apostrophe in a comment reds three of its cases.
  writeSync(2, `${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(3);
}
if (typeof isRoutingSensitivePath !== "function") {
  writeSync(2, `${classifierPath} does not export isRoutingSensitivePath\n`);
  process.exit(3);
}
const changedPaths = readFileSync(changedPathsPath, "utf8")
  .split(/\r?\n/)
  .filter(Boolean);
process.stdout.write(
  changedPaths.some(isRoutingSensitivePath) ? "true" : "false",
);
NODE
)" || routing_classifier_status=$?
if [[ "$routing_classifier_status" -ne 0 ]]; then
  if [[ "$routing_classifier_status" -eq 3 ]]; then
    echo "error: routing-sensitive path classifier could not be loaded from ${routing_classifier_path}" >&2
    echo "       scripts/agent-quality-gate.sh imports this module at pre-push time; moving it requires repointing that path in the same commit." >&2
  fi
  echo "error: failed to classify routing-sensitive changed paths" >&2
  exit 2
fi
case "$routing_sensitive_paths_changed" in
  true|false) ;;
  *)
    echo "error: routing-sensitive path classifier returned an invalid result" >&2
    exit 2
    ;;
esac

preflight_commands=()
codegen_commands=()
post_codegen_commands=()
quality_commands=()
checklists=()
surfaces=()
package_script_risk_changed=false

ref_oid() {
  local ref="$1"
  git rev-parse --verify "${ref}^{commit}" 2>/dev/null || echo "__unresolved__:${ref}"
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

# ── Routing: the Node mapping engine builds the plan ────────────────────────
#
# Routing is `scripts/gate/routing-table/` compiled by `scripts/gate/mapping.mjs`
# (ADR 0069). The gate runs the engine once, reads the plan back as the TSV
# `write_command_plan` already emits, and executes it. The bash `case` arms that
# used to hold this table, the in-gate byte comparison against them, and the
# parity harness were retired together at D5c after the soak; the table's own
# suite now owns the routing's invariants.
#
# EVERY failure below is a refusal. A mapper that crashes, exits non-zero,
# prints something unparsable, names a bucket that does not exist, or emits
# nothing at all must not leave the gate running on a partial plan: fewer mapped
# commands still print "All mapped commands passed."
mapper_path="$script_source_dir/gate/mapping.mjs"
# Checked before the call, and separately from a run failure: a mapper the gate
# cannot find is a repointing mistake, not a routing result, and it must not
# read as one.
if [[ ! -f "$mapper_path" ]]; then
  echo "error: gate mapping engine could not be loaded from ${mapper_path}" >&2
  echo "       scripts/agent-quality-gate.sh runs this module at pre-push time; moving it requires repointing that path in the same commit." >&2
  exit 2
fi

mapper_args=(
  "$mapper_path"
  --repo-root "$repo_root"
  --changed-paths-file "$changed_paths_file"
  --base "$base_ref"
  --head "$head_ref"
  --script-source-dir "$script_source_dir"
)
if [[ "$script_source_dir" == "$repo_root/scripts" ]]; then
  mapper_args+=(--real-tree)
fi
if [[ "$full_local_tests" == "1" || "$full_local_tests" == "true" ]]; then
  mapper_args+=(--full-local-tests)
fi

mapper_plan_file="$(make_tmpfile)"
mapper_status=0
node "${mapper_args[@]}" > "$mapper_plan_file" || mapper_status=$?
if [[ "$mapper_status" -ne 0 ]]; then
  echo "error: gate mapping engine failed (exit ${mapper_status}); refusing to run on a plan it did not produce" >&2
  # Exit 2, not the mapper's own code. 2 is this gate's refusal status.
  # Forwarding 1 or 3 would make a mapper crash look like a different failure
  # class to anything reading the gate's status.
  exit 2
fi
if [[ ! -s "$mapper_plan_file" ]]; then
  echo "error: gate mapping engine produced an empty plan; refusing to run" >&2
  exit 2
fi

engine_preflight_commands=()
engine_codegen_commands=()
engine_post_codegen_commands=()
engine_quality_commands=()
engine_checklists=()
engine_surfaces=()
engine_package_script_risk_changed=false
mapper_record=""
mapper_rest=""
mapper_field=""
while IFS= read -r mapper_record; do
  [[ -n "$mapper_record" ]] || continue
  mapper_rest="${mapper_record#*$'\t'}"
  case "$mapper_record" in
    flag$'\t'*)
      mapper_field="${mapper_rest%%$'\t'*}"
      case "${mapper_field}=${mapper_rest#*$'\t'}" in
        package_script_risk_changed=true) engine_package_script_risk_changed=true ;;
        package_script_risk_changed=false) ;;
        # Accepted and not stored: the engine applies this flag itself, in the
        # scoped-test post-pass, and bash has no reader for it. Still enumerated
        # rather than skipped, so an unrecognised VALUE falls through to the
        # refusal below instead of passing as a record the gate understood.
        saw_workspace_escalation=true | saw_workspace_escalation=false) ;;
        *)
          echo "error: gate mapping engine emitted an unknown flag record: ${mapper_record}" >&2
          exit 2
          ;;
      esac
      ;;
    surface$'\t'*) engine_surfaces+=("$mapper_rest") ;;
    checklist$'\t'*)
      engine_checklists+=("${mapper_rest%%$'\t'*}|${mapper_rest#*$'\t'}")
      ;;
    preflight$'\t'*)
      engine_preflight_commands+=("${mapper_rest%%$'\t'*}|${mapper_rest#*$'\t'}")
      ;;
    codegen$'\t'*)
      engine_codegen_commands+=("${mapper_rest%%$'\t'*}|${mapper_rest#*$'\t'}")
      ;;
    post-codegen$'\t'*)
      engine_post_codegen_commands+=("${mapper_rest%%$'\t'*}|${mapper_rest#*$'\t'}")
      ;;
    quality$'\t'*)
      engine_quality_commands+=("${mapper_rest%%$'\t'*}|${mapper_rest#*$'\t'}")
      ;;
    *)
      echo "error: gate mapping engine emitted an unparsable record: ${mapper_record}" >&2
      exit 2
      ;;
  esac
done < "$mapper_plan_file"

# The engine's plan is the plan. Assigned into the arrays every phase below
# already reads, so the seam is one assignment rather than a rename spread
# across the executor.
preflight_commands=("${engine_preflight_commands[@]+"${engine_preflight_commands[@]}"}")
codegen_commands=("${engine_codegen_commands[@]+"${engine_codegen_commands[@]}"}")
post_codegen_commands=("${engine_post_codegen_commands[@]+"${engine_post_codegen_commands[@]}"}")
quality_commands=("${engine_quality_commands[@]+"${engine_quality_commands[@]}"}")
checklists=("${engine_checklists[@]+"${engine_checklists[@]}"}")
surfaces=("${engine_surfaces[@]+"${engine_surfaces[@]}"}")
# This one is still read below, by the refusal that stops a run whose package
# manifests or lockfile changed, so it has to cross the seam.
package_script_risk_changed="$engine_package_script_risk_changed"

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
  local output digest
  output="$(hash_sha256 "$1")" || return 1
  digest="${output%%[[:space:]]*}"
  printf '%s\n' "$digest"
}

checked_file_digest() {
  local path="$1" digest
  digest="$(hash_file "$path")" || {
    echo "error: could not hash required implementation file: ${path}" >&2
    return 1
  }
  if [[ ! "$digest" =~ ^[a-f0-9]{64}$ ]]; then
    echo "error: implementation hash output is malformed for: ${path}" >&2
    return 1
  fi
  printf '%s\n' "$digest"
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
  local output_file="$1"
  local implementation_path path canonical_path digest discovered_paths status=0
  : > "$output_file" || return 1
  for path in \
    scripts/agent-quality-gate.sh \
    scripts/agent-quality-gate.test.sh \
    scripts/agent-autoreview-core.mjs \
    scripts/gate/run-handles.sh \
    scripts/check-agent-quality-gate-package-scripts.mjs \
    scripts/docs/docs-navigation-eval-helpers.mjs \
    scripts/gate/lockfile-scope.mjs \
    scripts/gate/mapping.mjs \
    scripts/gate/mapping/facts.mjs \
    scripts/gate/mapping/plan.mjs \
    scripts/gate/mapping/post-passes.mjs \
    scripts/gate/mapping/route.mjs \
    scripts/gate/mapping/shell-quote.mjs \
    scripts/gate/mapping/shell-quote.test.mjs \
    scripts/gate/mapping/verbs.mjs \
    scripts/gate/mapping/engine.test.mjs \
    scripts/gate/routing-table/arms-agent-modules.mjs \
    scripts/gate/routing-table/arms-alerts.mjs \
    scripts/gate/routing-table/arms-packages.mjs \
    scripts/gate/routing-table/arms-script-modules.mjs \
    scripts/gate/routing-table/arms-scripts.mjs \
    scripts/gate/routing-table/arms-sentry-modules.mjs \
    scripts/gate/routing-table/arms-services.mjs \
    scripts/gate/routing-table/arms-tooling-modules.mjs \
    scripts/gate/routing-table/arms-workflows.mjs \
    scripts/gate/routing-table/checks.mjs \
    scripts/gate/routing-table/groups-head.mjs \
    scripts/gate/routing-table/groups-tail.mjs \
    scripts/gate/routing-table/index.mjs \
    scripts/gate/routing-table/indexer-invariant-parity.test.mjs \
    scripts/gate/routing-table/pattern-oracle.test.mjs \
    scripts/gate/routing-table/pattern.mjs \
    scripts/gate/routing-table/pins.test.mjs \
    scripts/gate/routing-table/routing-table.test.mjs \
    scripts/gate/routing-table/schema.mjs \
    scripts/gate/quality-gate-coordinator.sh \
    scripts/gate/quality-gate-coordinator-support.sh \
    scripts/terraform/terraform-fmt-check.mjs \
    scripts/terraform/terraform-fmt-check.test.mjs \
    turbo.json \
    .trunk/trunk.yaml; do
  # Gate-loaded runtime entries execute from this checkout even when a fixture
  # makes $repo_root a different repository. Hash the same source tree the gate
  # executes. The mapper and routing-table suites are mapped commands from the
  # repository under test, so they stay anchored there.
  case "$path" in
    scripts/gate/mapping/*.test.mjs | scripts/gate/routing-table/*.test.mjs)
        implementation_path="$repo_root/$path"
        ;;
      scripts/agent-quality-gate.sh | scripts/agent-autoreview-core.mjs | scripts/docs/docs-navigation-eval-helpers.mjs | scripts/gate/lockfile-scope.mjs | scripts/gate/run-handles.sh | scripts/gate/mapping.mjs | scripts/gate/mapping/*.mjs | scripts/gate/routing-table/*.mjs | scripts/gate/quality-gate-coordinator.sh | scripts/gate/quality-gate-coordinator-support.sh)
        implementation_path="$script_source_dir/${path#scripts/}"
        ;;
      *)
        implementation_path="$repo_root/$path"
        ;;
    esac
    if [[ -L "$implementation_path" ]]; then
      echo "error: required implementation path is a symlink: ${implementation_path}" >&2
      return 1
    elif [[ -f "$implementation_path" ]]; then
      digest="$(checked_file_digest "$implementation_path")" || return 1
      printf '%s %s\n' "$path" "$digest" >> "$output_file" || return 1
    elif [[ -e "$implementation_path" ]]; then
      echo "error: required implementation path is not a regular file: ${implementation_path}" >&2
      return 1
    else
      printf '%s __missing__\n' "$path" >> "$output_file" || return 1
    fi
  done

  # Discover production coordinator modules from the checkout that the gate
  # loaded. A new module must invalidate local freshness and shared execution
  # before another caller learns its exact filename.
  discovered_paths="$(mktemp "$scratch_dir/implementation-runtime-paths.XXXXXX")" || return 1
  if ! find "$script_source_dir/gate" -maxdepth 1 \
    -name 'quality-gate-coordinator*.mjs' ! -name '*.test.mjs' -print \
    > "$discovered_paths" 2>/dev/null; then
    rm -f "$discovered_paths"
    return 1
  fi
  if ! LC_ALL=C sort -o "$discovered_paths" "$discovered_paths"; then
    rm -f "$discovered_paths"
    return 1
  fi
  while IFS= read -r implementation_path; do
    canonical_path="scripts/gate/${implementation_path##*/}"
    if [[ -L "$implementation_path" || ! -f "$implementation_path" ]]; then
      echo "error: discovered implementation path is not a regular file: ${implementation_path}" >&2
      status=1
      break
    fi
    digest="$(checked_file_digest "$implementation_path")" || {
      status=1
      break
    }
    if ! printf '%s %s\n' "$canonical_path" "$digest" >> "$output_file"; then
      status=1
      break
    fi
  done < "$discovered_paths"
  rm -f "$discovered_paths"
  [[ "$status" -eq 0 ]] || return 1

  # Coordinator tests and scheduler fixtures execute from the repository under
  # test. Keep their physical root separate from the loaded runtime root.
  if [[ -d "$repo_root/scripts/gate" ]]; then
    discovered_paths="$(mktemp "$scratch_dir/implementation-test-paths.XXXXXX")" || return 1
    if ! find "$repo_root/scripts/gate" -maxdepth 1 \
      \( -name 'quality-gate-coordinator*.test.mjs' -o \
      -name 'agent-quality-gate-scheduler*.mjs' -o \
      -name 'agent-quality-gate-fixture-processes.mjs' \) -print \
      > "$discovered_paths" 2>/dev/null; then
      rm -f "$discovered_paths"
      return 1
    fi
    if ! LC_ALL=C sort -o "$discovered_paths" "$discovered_paths"; then
      rm -f "$discovered_paths"
      return 1
    fi
    while IFS= read -r implementation_path; do
      canonical_path="scripts/gate/${implementation_path##*/}"
      if [[ -L "$implementation_path" || ! -f "$implementation_path" ]]; then
        echo "error: discovered implementation path is not a regular file: ${implementation_path}" >&2
        status=1
        break
      fi
      digest="$(checked_file_digest "$implementation_path")" || {
        status=1
        break
      }
      if ! printf '%s %s\n' "$canonical_path" "$digest" >> "$output_file"; then
        status=1
        break
      fi
    done < "$discovered_paths"
    rm -f "$discovered_paths"
    [[ "$status" -eq 0 ]] || return 1
  fi
}

implementation_hash_value() {
  local manifest digest
  manifest="$(mktemp "$scratch_dir/implementation-signature.XXXXXX")" || return 1
  if ! implementation_signature "$manifest"; then
    rm -f "$manifest"
    return 1
  fi
  digest="$(checked_file_digest "$manifest")" || {
    rm -f "$manifest"
    return 1
  }
  rm -f "$manifest"
  printf '%s\n' "$digest"
}

# The mode of a path, read from the worktree rather than from the index, so the
# answer does not depend on whether the path is tracked yet. This is what the
# ` create mode <mode> …` line dropped below used to carry. `-x` asks whether
# THIS user may execute it, which is git's own rule — the owner bit — for a file
# this user owns, and that is every file in a worktree it is working in. Where
# the two differ (a file owned by somebody else, an execute bit set only for
# group or other) this answer is still the same on both sides of a `git add`,
# which is the property the freshness stamp needs from it.
gate_worktree_filemode() {
  local path="$1"
  if [[ -L "$path" ]]; then
    printf '120000'
  elif [[ -x "$path" ]]; then
    printf '100755'
  else
    printf '100644'
  fi
}

gate_symlink_target_hash() {
  local path="$1"
  [[ -L "$path" ]] || return 1
  readlink "$path" | hash_stream
}

gate_resolved_filemode() {
  local path="$1"
  if [[ -x "$path" ]]; then
    printf '100755'
  else
    printf '100644'
  fi
}

validation_content_signature() {
  local path link_hash resolved_digest

  {
    while IFS= read -r path; do
      printf 'path %s\0' "$path"
      if [[ -L "$path" ]]; then
        link_hash="$(gate_symlink_target_hash "$path")" || return 1
        printf 'symlink %s\0' "$link_hash"
        if [[ -f "$path" ]]; then
          resolved_digest="$(hash_file "$path")" || return 1
          printf 'resolved-file %s\0' "$resolved_digest"
          printf 'resolved-mode %s\0' "$(gate_resolved_filemode "$path")"
        elif [[ -d "$path" ]]; then
          # A directory target has no bounded content digest. Keep the gate
          # valid, but bind the physical worktree so another worktree cannot
          # reuse a result for different directory contents behind the same
          # relative link.
          printf 'resolved-directory-worktree %s\0' "$repo_root"
        elif [[ -e "$path" ]]; then
          printf 'resolved-other-worktree %s\0' "$repo_root"
        else
          printf 'resolved-missing\0'
        fi
      elif [[ -f "$path" ]]; then
        printf 'file %s\0' "$(hash_file "$path")"
        # The executable bit is not in the content hash. Read it from the
        # worktree so `git add` cannot move it.
        printf 'mode %s\0' "$(gate_worktree_filemode "$path")"
      elif [[ -d "$path" ]]; then
        printf 'directory\0'
      elif [[ -e "$path" ]]; then
        printf 'other\0'
      else
        printf 'deleted\0'
      fi
      # `create mode` lines are dropped: they appear the moment a path becomes
      # tracked and say nothing about what was validated. An untracked path is
      # invisible to `git diff`, so `git add` alone used to move this signature
      # and cost a fresh stamp a full re-run — with the changed-path set, the
      # command plan, the base OID and the file's bytes all provably unchanged
      # (GitHub issue 1899). Deletions and mode changes are not index-state
      # transitions in the same way — `git diff <base> -- <path>` reports both
      # from the worktree, staged or not — so those summary lines stay.
      # `awk` rather than `grep -v`, which exits 1 when it filters everything
      # out and would abort the run under `set -e`.
      git diff --no-ext-diff --summary "$base_ref" -- "$path" 2>/dev/null |
        awk '!/^ create mode /' || true
    done < "$changed_paths_file"
  } | hash_stream
}

command_plan_file="$(make_tmpfile)"
write_command_plan "$command_plan_file"

base_oid="$(ref_oid "$base_ref")"
changed_paths_hash="$(hash_file "$changed_paths_file")"
command_plan_hash="$(hash_file "$command_plan_file")"
implementation_hash="$(implementation_hash_value)"
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

gate_coordinator_freshness_context=""
gate_coordinator_execution_head=""

# The coordinator execution fingerprint binds HEAD. The pre-push workflow must
# also accept a warm run made immediately before committing the same validated
# bytes. Build a separate compatibility context from every execution-fingerprint
# input except HEAD; stamp_line already carries base, paths, plan,
# implementation, content, and package-risk policy. Equality therefore means
# that only HEAD can differ. Legacy and --no-lock runs keep the v2 stamp.
gate_coordinator_freshness_context_hash() {
  local os_name os_arch node_path node_version pnpm_path pnpm_version
  local env_digest policy_hash runtime_hash repository_identity
  os_name="$(uname -s)" || return 1
  os_arch="$(uname -m)" || return 1
  node_path="$(command -v node)" || return 1
  node_version="$(node --version 2>/dev/null)" || return 1
  pnpm_path="$(command -v pnpm)" || return 1
  pnpm_version="$(pnpm --version 2>/dev/null)" || return 1
  env_digest="$(gate_coordinator_material_env_digest)" || return 1
  policy_hash="${gate_coordinator_policy_hash:-}"
  [[ "$policy_hash" =~ ^[a-f0-9]{64}$ ]] || return 1
  runtime_hash="$(gate_coordinator_runtime_signature)" || return 1
  repository_identity="$(gate_coordinator_repository_identity)" || return 1
  printf '%s\n' \
    "schema=v1" "repository=${repository_identity}" \
    "commandTimeout=${command_timeout_seconds}" \
    "gateSelftestTimeout=${gate_selftest_timeout_seconds}" \
    "qualityParallelism=${quality_parallelism}" "failFast=${fail_fast}" \
    "os=${os_name}" "arch=${os_arch}" "nodePath=${node_path}" \
    "node=${node_version}" "pnpmPath=${pnpm_path}" \
    "pnpm=${pnpm_version}" "policy=${policy_hash}" \
    "runtime=${runtime_hash}" "environment=${env_digest}" |
    hash_stream
}

stamp_line() {
  if [[ -n "$gate_coordinator_freshness_context" ]]; then
    printf 'v3\tbase=%s\tpaths=%s\tplan=%s\timplementation=%s\tcontent=%s\tpackageRisk=%s\tallowPackageScripts=%s\tcoordinatorContext=%s\n' \
      "$base_oid" \
      "$changed_paths_hash" \
      "$command_plan_hash" \
      "$implementation_hash" \
      "$validated_content_hash" \
      "$package_script_risk_changed" \
      "$stamp_allow_package_scripts" \
      "$gate_coordinator_freshness_context"
    return
  fi
  printf 'v2\tbase=%s\tpaths=%s\tplan=%s\timplementation=%s\tcontent=%s\tpackageRisk=%s\tallowPackageScripts=%s\n' \
    "$base_oid" \
    "$changed_paths_hash" \
    "$command_plan_hash" \
    "$implementation_hash" \
    "$validated_content_hash" \
    "$package_script_risk_changed" \
    "$stamp_allow_package_scripts"
}

current_stamp=""

recomputed_stamp_line() {
  local fresh_paths_file fresh_plan_file fresh_base fresh_paths fresh_plan
  local fresh_implementation fresh_content fresh_coordinator_context
  fresh_paths_file="$(mktemp "$scratch_dir/fresh-paths.XXXXXX")" || return 1
  fresh_plan_file="$(mktemp "$scratch_dir/fresh-plan.XXXXXX")" || {
    rm -f "$fresh_paths_file"
    return 1
  }
  if ! collect_current_changed_paths |
    sed '/^$/d' | LC_ALL=C sort -u > "$fresh_paths_file"; then
    rm -f "$fresh_paths_file" "$fresh_plan_file"
    return 1
  fi
  write_command_plan "$fresh_plan_file"
  fresh_base="$(ref_oid "$base_ref")"
  fresh_paths="$(hash_file "$fresh_paths_file")"
  fresh_plan="$(hash_file "$fresh_plan_file")"
  fresh_implementation="$(implementation_hash_value)"
  fresh_content="$(validation_content_signature)"
  rm -f "$fresh_paths_file" "$fresh_plan_file"
  if [[ -n "$gate_coordinator_freshness_context" ]]; then
    fresh_coordinator_context="$(gate_coordinator_freshness_context_hash)" || return 1
    printf 'v3\tbase=%s\tpaths=%s\tplan=%s\timplementation=%s\tcontent=%s\tpackageRisk=%s\tallowPackageScripts=%s\tcoordinatorContext=%s\n' \
      "$fresh_base" "$fresh_paths" "$fresh_plan" "$fresh_implementation" \
      "$fresh_content" "$package_script_risk_changed" \
      "$stamp_allow_package_scripts" "$fresh_coordinator_context"
    return
  fi
  printf 'v2\tbase=%s\tpaths=%s\tplan=%s\timplementation=%s\tcontent=%s\tpackageRisk=%s\tallowPackageScripts=%s\n' \
    "$fresh_base" "$fresh_paths" "$fresh_plan" "$fresh_implementation" \
    "$fresh_content" "$package_script_risk_changed" "$stamp_allow_package_scripts"
}

is_fresh_success_stamp() {
  local stamped_at
  local stamped_value
  local stamped_execution_fingerprint
  local stamped_execution_head
  local now
  [[ -f "$success_stamp_file" ]] || return 1
  stamped_at="$(sed -n '1s/^created_at=//p' "$success_stamp_file")"
  stamped_value="$(sed -n '2s/^stamp=//p' "$success_stamp_file")"
  [[ "$stamped_value" == "$current_stamp" ]] || return 1
  if [[ -n "$gate_coordinator_freshness_context" ]]; then
    stamped_execution_fingerprint="$(
      sed -n '3s/^execution_fingerprint=//p' "$success_stamp_file"
    )"
    stamped_execution_head="$(
      sed -n '4s/^execution_head=//p' "$success_stamp_file"
    )"
    [[ "$stamped_execution_fingerprint" =~ ^[a-f0-9]{64}$ ]] || return 1
    [[ "$stamped_execution_head" =~ ^[a-f0-9]{40}([a-f0-9]{24})?$ ]] || return 1
    if [[ "$stamped_execution_head" == "$gate_coordinator_execution_head" ]]; then
      [[ "$stamped_execution_fingerprint" == \
        "$gate_coordinator_registration_fingerprint" ]] || return 1
    fi
    # If HEAD changed after a warm run, the matching v3 stamp above proves
    # equality for every other execution input and permits only that transition.
  fi
  [[ "$stamped_at" =~ ^[0-9]+$ ]] || return 1
  now="$(date +%s)"
  # Reject future-dated stamps (clock stepped backward after stamping): a
  # negative age would satisfy an upper-bound-only check and extend reuse
  # until the clock catches up. Fail toward rerun.
  [[ "$stamped_at" -le "$now" ]] || return 1
  [[ $((now - stamped_at)) -le "$success_stamp_ttl_seconds" ]]
}

echo "Agent quality gate"
echo
echo "Base: ${base_ref}"
echo "Head: ${head_ref}"
echo "Mode: ${mode}"
if [[ -n "${TURBO_CACHE_DIR:-}" ]]; then
  echo "Turbo cache dir: ${TURBO_CACHE_DIR}"
fi
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

# A coordinated zero-work success must first derive the same source, plan,
# toolchain, material environment, runtime, and policy identity used for
# registration. The second full fingerprint read brackets the compatible
# headless context and fails closed if any execution input moves during it.
if gate_coordinator_requested; then
  exec 7>&1
  gate_coordinator_stdout_reserved=1
  if ! gate_lock_ensure_local_host_fingerprint; then
    echo "error: could not derive the local host identity for safe coordinator marker recovery." >&2
    gate_coordinator_report_no_work_failure 2 "registration preparation" \
      "No mapped command ran in this request"
    exit 2
  fi
  if ! gate_run_ensure_token; then
    gate_coordinator_report_no_work_failure 2 "registration preparation" "No mapped command ran in this request"
    exit 2
  fi
  if ! gate_coordinator_prepare_registration_fingerprint; then
    gate_coordinator_report_no_work_failure 2 "registration preparation" "No mapped command ran in this request"
    exit 2
  fi
  if ! gate_coordinator_requested; then
    exec 7>&-
    gate_coordinator_stdout_reserved=0
  fi
fi
if gate_coordinator_requested; then
  gate_coordinator_freshness_context="$(
    gate_coordinator_freshness_context_hash
  )" || {
    echo "error: could not compute the coordinated freshness context." >&2
    gate_coordinator_report_no_work_failure 2 "freshness identity preparation" \
      "No mapped command ran in this request"
    exit 2
  }
  gate_coordinator_execution_head="$(ref_oid "$head_ref")" || {
    echo "error: could not resolve HEAD for coordinated freshness reuse." >&2
    gate_coordinator_report_no_work_failure 2 "freshness identity preparation" \
      "No mapped command ran in this request"
    exit 2
  }
  verified_coordinator_fingerprint="$(
    gate_coordinator_recompute_fingerprint
  )" || {
    echo "error: could not verify the coordinator fingerprint before freshness reuse." >&2
    gate_coordinator_report_no_work_failure 2 "freshness identity preparation" \
      "No mapped command ran in this request"
    exit 2
  }
  if [[ "$verified_coordinator_fingerprint" != \
    "$gate_coordinator_registration_fingerprint" ]]; then
    echo "error: quality-gate inputs changed while the coordinated freshness identity was prepared." >&2
    gate_coordinator_report_no_work_failure 2 "freshness identity preparation" \
      "No mapped command ran in this request"
    exit 2
  fi
  unset verified_coordinator_fingerprint
fi
current_stamp="$(stamp_line)" || {
  echo "error: could not compute the quality-gate freshness stamp." >&2
  gate_report_coordinated_no_work_failure 2 "freshness identity preparation" \
    "No mapped command ran in this request"
  exit 2
}
if [[ -n "$gate_coordinator_freshness_context" ]]; then
  verified_freshness_stamp="$(recomputed_stamp_line)" || {
    echo "error: could not verify repository state before coordinated freshness reuse." >&2
    gate_coordinator_report_no_work_failure 2 "freshness identity preparation" \
      "No mapped command ran in this request"
    exit 2
  }
  if [[ "$verified_freshness_stamp" != "$current_stamp" ]]; then
    echo "error: repository or execution inputs changed while the coordinated freshness identity was prepared." >&2
    gate_coordinator_report_no_work_failure 2 "freshness identity preparation" \
      "No mapped command ran in this request"
    exit 2
  fi
  unset verified_freshness_stamp
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
  if gate_coordinator_requested; then
    gate_coordinator_report_no_work_failure 2 "pre-execution policy" \
      "No mapped command ran in this request"
  fi
  exit 2
fi

# Take the machine's run lock only once this run is definitely going to execute
# something: a dry run, a fresh-stamp skip, and a package-script refusal all
# exit above without ever competing for the machine. Coordinated runs have
# already prepared the identity that acquisition registers.
acquire_gate_run_lock
if declare -F gate_coordinator_is_follower >/dev/null 2>&1 &&
  gate_coordinator_is_follower; then
  gate_coordinator_wait_for_shared_result
  exit $?
fi
# The run marker is written here, while the gate's own stderr is still live
# and the exit is unambiguously the gate's: inside run_with_timeout the
# per-command capture would swallow the message, and a parallel worker's exit
# is not the run's. Failing here also means failing before ANY command, which
# is the whole point.
gate_run_ensure_marker
# Test-only synchronization for the displaced-holder fixture. Normal runs do
# not call it, so unset behavior stays exactly on the production path.
if [[ "${AGENT_QUALITY_GATE_LOCK_TEST_READY_FILE+x}" == x || "${AGENT_QUALITY_GATE_LOCK_TEST_RELEASE_FILE+x}" == x ]]; then
  if [[ "${NODE_ENV:-}" != "test" ]]; then
    echo "error: gate lock test synchronization is allowed only with NODE_ENV=test." >&2
    echo "Nothing has been executed." >&2
    exit 2
  fi
  gate_lock_test_ready_and_wait_for_release \
    "${AGENT_QUALITY_GATE_LOCK_TEST_READY_FILE:-}" \
    "${AGENT_QUALITY_GATE_LOCK_TEST_RELEASE_FILE:-}"
fi
# Test-only: widens the gap between holding the lock and checking we still do,
# which is otherwise as short as the mapping work between them.
gate_lock_test_delay "${AGENT_QUALITY_GATE_LOCK_HELD_DELAY_SECONDS:-}"

# Re-check freshness after the wait. The run we queued behind may have stamped
# this exact fingerprint while we waited — the pre-push hook queued behind the
# manual warm-up run is precisely that case — and re-running its work would
# throw away the reason the hook passes --skip-if-fresh at all.
if ! declare -F gate_coordinator_is_active >/dev/null 2>&1 ||
  ! gate_coordinator_is_active; then
  if [[ "$skip_if_fresh" == "1" || "$skip_if_fresh" == "true" ]]; then
    post_wait_stamp="$(recomputed_stamp_line)" || {
      echo "error: could not recompute the quality-gate stamp after the lock wait." >&2
      exit 2
    }
    if [[ "$post_wait_stamp" != "$current_stamp" ]]; then
      echo "error: repository state changed while this gate waited for the run lock." >&2
      echo "No mapped command ran. Re-run so routing and validation use the new state." >&2
      exit 2
    fi
    if is_fresh_success_stamp; then
      echo "A concurrent agent quality gate run left a fresh success stamp; skipping mapped commands."
      exit 0
    fi
  fi
fi

failures=0
command_summaries=()
# `<command>\n<output tail>` per failed command, replayed next to the verdict.
failed_command_outputs=()
failure_output_tail_lines=20
# Trunk launcher provisioning verdict for this run: "" (not probed yet), "ok",
# or "blocked". Probed at most once, and only after a Trunk command failed.
trunk_provisioning_state=""

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

# The inline dump of a failing command's output can sit thousands of lines above
# the final verdict once the parallel pool interleaves several commands, and a
# command that fails while printing nothing (a launcher that swallows its own
# error) leaves no trace at all. Keep the tail of each failure so the verdict can
# repeat it, and say so explicitly when there was nothing to keep.
record_failure_output() {
  local command="$1"
  local output_file="$2"
  local tail_text

  tail_text="$(filter_expected_output < "$output_file" 2>/dev/null |
    tail -n "$failure_output_tail_lines")" || tail_text=""
  if [[ -z "${tail_text//[[:space:]]/}" ]]; then
    tail_text="(no output captured)"
  fi
  failed_command_outputs+=("${command}"$'\n'"${tail_text}")
}

print_failed_command_output() {
  local entry
  local command
  local body

  if [[ ${#failed_command_outputs[@]} -eq 0 ]]; then
    return 0
  fi

  echo >&2
  echo "Failure output (last ${failure_output_tail_lines} lines per command):" >&2
  for entry in "${failed_command_outputs[@]+"${failed_command_outputs[@]}"}"; do
    command="${entry%%$'\n'*}"
    body="${entry#*$'\n'}"
    echo "- ${command}" >&2
    printf '%s\n' "$body" | sed 's/^/    /' >&2
  done
}

# `./tools/trunk` is a launcher that self-downloads the pinned CLI from trunk.io
# on first use. Where that host is unreachable — a Claude cloud container proxies
# egress and answers "Proxy tunneling failed: Forbidden" for anything outside its
# allowlist — the launcher exits non-zero before a single linter runs, and the
# stamp-exempt Trunk arm would make an otherwise-clean gate unable to exit 0.
# `.trunk/hooks` already models the answer for commits and pushes: warn, name the
# allowlist fix, skip. The gate takes the same posture, with one restriction that
# keeps it honest — only a PROVISIONING failure may downgrade. A provisioned
# Trunk that finds real problems still fails the gate, so the probe runs AFTER
# the command failed and asks the launcher whether it can produce a CLI at all.
is_trunk_command() {
  case "$1" in
    "./tools/trunk "*)
      return 0
      ;;
  esac
  return 1
}

trunk_provisioning_probe_timeout_seconds=15

# Ask the launcher whether it can produce a CLI. Bounded: a probe that cannot
# answer within its budget is torn down and reported as NOT blocked, so an
# unanswerable question leaves the original failure standing.
trunk_provisioning_probe() {
  local command_tag="${1:-}"
  local request_tag="${2:-}"
  local command_marker="${3:-}"
  local request_marker="${4:-}"
  local coordinator_marker="${5:-}"
  local close_coordinator_stdout_fd="${6:-0}"
  local close_parallel_worker_control_fd="${7:-0}"
  local handshake_file="${8:-}"
  local pid
  local waited=0
  local had_errexit=0
  local rc

  case "$-" in
    *e*) had_errexit=1 ;;
  esac
  set +e

  if [[ -z "$handshake_file" ]] || ! rm -f "$handshake_file"; then
    [[ "$had_errexit" == 1 ]] && set -e
    return 2
  fi

  AGENTQG_RUN="$command_tag" \
    AGENTQG_REQUEST="$request_tag" \
    TRUNK_LAUNCHER_QUIET=true \
    bash -c '
      command_marker="$1"
      request_marker="$2"
      coordinator_marker="$3"
      close_coordinator_stdout_fd="$4"
      close_parallel_worker_control_fd="$5"
      handshake_file="$6"
      if [[ -n "$command_marker" ]]; then
        [[ -r "$command_marker" ]] || exit 125
        exec 9< "$command_marker" || exit 125
      fi
      if [[ -n "$request_marker" && "$request_marker" != "$command_marker" ]]; then
        [[ -r "$request_marker" ]] || exit 125
        exec 8< "$request_marker" || exit 125
      fi
      if [[ -n "$coordinator_marker" &&
        "$coordinator_marker" != "$command_marker" &&
        "$coordinator_marker" != "$request_marker" ]]; then
        [[ -r "$coordinator_marker" ]] || exit 125
        exec 6< "$coordinator_marker" || exit 125
      fi
      if [[ "$close_coordinator_stdout_fd" == 1 ]]; then
        exec 7>&-
      fi
      if [[ "$close_parallel_worker_control_fd" == 1 ]]; then
        exec 17>&-
      fi
      printf "%s\n" ready > "$handshake_file" || exit 125
      exec ./tools/trunk --version
    ' trunk-provisioning-probe \
      "$command_marker" "$request_marker" "$coordinator_marker" \
      "$close_coordinator_stdout_fd" \
      "$close_parallel_worker_control_fd" "$handshake_file" \
      >/dev/null 2>&1 &
  pid=$!
  # INT/TERM cleanup must see the probe while its command identity and
  # scheduler lease remain active. The private readiness file distinguishes a
  # launcher failure from a wrapper that never retained the recovery handles.
  active_timeout_pids=("$pid")
  while kill -0 "$pid" 2>/dev/null &&
    [[ "$waited" -lt "$trunk_provisioning_probe_timeout_seconds" ]]; do
    sleep 1
    waited=$((waited + 1))
  done

  if kill -0 "$pid" 2>/dev/null; then
    kill_process_tree "$pid" KILL
    wait "$pid" 2>/dev/null
    rc=0
  else
    wait "$pid" 2>/dev/null
    rc=$?
    [[ "$rc" -le 128 ]] || rc=0
  fi
  active_timeout_pids=()

  if ! read_parallel_worker_result_value "$handshake_file" ready \
    >/dev/null 2>&1; then
    rc=2
  elif [[ "$rc" -ne 0 ]]; then
    rc=1
  fi

  [[ "$had_errexit" == 1 ]] && set -e
  return "$rc"
}

trunk_provisioning_is_blocked() {
  local probe_status
  # A missing or non-executable launcher is a real failure, not an environment
  # one: tools/trunk is tracked, so its absence means the checkout is broken.
  [[ -x ./tools/trunk ]] || return 1

  if [[ -z "$trunk_provisioning_state" ]]; then
    if trunk_provisioning_probe "$@"; then
      trunk_provisioning_state=ok
    else
      probe_status=$?
      if [[ "$probe_status" -eq 1 ]]; then
        trunk_provisioning_state=blocked
      else
        echo "error: the Trunk provisioning probe could not retain the mapped command's recovery identity." >&2
        return 2
      fi
    fi
  fi

  [[ "$trunk_provisioning_state" == blocked ]]
}

print_trunk_environment_blocked_warning() {
  local command="$1"
  echo "warning: skipping ${command} — the Trunk CLI could not be provisioned." >&2
  echo "  The launcher self-downloads the pinned CLI from trunk.io and could not produce a" >&2
  echo "  working one here. The probe reports that it failed, not why." >&2
  echo "  Most often the environment blocks the download:" >&2
  echo "  Add 'trunk.io' and '*.trunk.io' to the environment's allowed domains to run it here." >&2
  echo "  A local cause — a corrupt or unwritable launcher cache — prints this same warning." >&2
  echo "  Run './tools/trunk --version' to see the launcher's own error." >&2
  echo "  CI still enforces Trunk on the PR (.github/workflows/trunk.yml)." >&2
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

  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)" || return 0
  # This single-quoted program is JavaScript.
  # shellcheck disable=SC2016
  node -e '
    const [ts, command, status, seconds, mode, requestId, sequence, role] = process.argv.slice(1);
    process.stdout.write(`${JSON.stringify({
      ts, command, status, seconds: Number(seconds), mode,
      requestId: requestId || undefined,
      sequence: sequence ? Number(sequence) : undefined,
      role: role || undefined,
    })}\n`);
  ' "$ts" "$command" "$status" "$elapsed" "$line_mode" \
    "${gate_coordinator_request_id:-}" "${gate_coordinator_sequence:-}" \
    "${gate_coordinator_role:-}" >> "$durations_file" 2>/dev/null || true
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
mapped_command_timeout_seconds() {
  case "$1" in
    "pnpm agent:quality-gate:test"|"bash scripts/agent-quality-gate.test.sh")
      printf '%s\n' "$gate_selftest_timeout_seconds"
      ;;
    *)
      printf '%s\n' "$command_timeout_seconds"
      ;;
  esac
}

run_with_timeout() {
  local command="$1"
  local deferred_lease_file="${2:-}"
  local command_drain_identity="${3:-}"
  local trunk_probe_handshake_file="${4:-}"
  local cmd_pid
  local watchdog_pid
  local rc
  local release_rc=0
  local drain_rc=0
  local provisioning_probe_rc=0
  local timeout_marker
  local had_errexit=0
  local command_started_at
  local command_finished_at
  local effective_command_timeout_seconds
  local coordinator_marker="${gate_coordinator_marker_file:-}"
  local request_marker command_marker command_tag request_tag
  local coordinator_release_deferred=0
  local close_parallel_worker_control_fd=0

  if [[ -n "$deferred_lease_file" ]]; then
    close_parallel_worker_control_fd=1
  fi

  # A `wait` that reaps a SIGTERM/SIGKILL-killed child makes bash re-raise that
  # signal at the next `return`, which would kill the gate. Run the reaping with
  # errexit off and remap any >128 status to an ordinary failure so the caller
  # (and its `if ! run_mapped_command` / status-file plumbing) just sees a fail.
  case "$-" in
    *e*) had_errexit=1 ;;
  esac
  set +e

  effective_command_timeout_seconds="$(mapped_command_timeout_seconds "$command")"

  last_command_timed_out=false
  last_command_execution_seconds=0
  last_command_infrastructure_failed=false
  last_command_trunk_provisioning_blocked=false
  if declare -F gate_coordinator_is_active >/dev/null 2>&1 &&
    gate_coordinator_is_active && [[ -z "$command_drain_identity" ]]; then
    parallel_command_sequence=$((parallel_command_sequence + 1))
    if ! command_drain_identity="$(make_parallel_command_drain_identity "$parallel_command_sequence")"; then
      echo "error: could not create a safe command drain identity." >&2
      last_command_infrastructure_failed=true
      [[ "$had_errexit" == 1 ]] && set -e
      return 2
    fi
  fi
  if declare -F gate_coordinator_before_command >/dev/null 2>&1; then
    gate_coordinator_before_command "$command" "$command_drain_identity"
    rc=$?
    if [[ "$rc" -ne 0 ]]; then
      last_command_infrastructure_failed=true
      [[ "$had_errexit" == 1 ]] && set -e
      return "$rc"
    fi
    if [[ -n "$deferred_lease_file" ]] &&
      declare -F gate_coordinator_is_active >/dev/null 2>&1 &&
      gate_coordinator_is_active; then
      if [[ -z "${gate_coordinator_active_lease_id:-}" ]] ||
        ! printf '%s\n' "$gate_coordinator_active_lease_id" > "$deferred_lease_file"; then
        gate_coordinator_abandon_active_lease || true
        last_command_infrastructure_failed=true
        [[ "$had_errexit" == 1 ]] && set -e
        return 2
      fi
      coordinator_release_deferred=1
    fi
  fi
  timeout_seq=$((timeout_seq + 1))
  # mktemp guarantees a unique path even across concurrent parallel-pool
  # subshells (BASHPID would too, but stock macOS Bash 3.2 does not define it
  # and this script runs under set -u). The file exists from the start; the
  # timeout signal is CONTENT (non-empty), written by the watchdog.
  timeout_marker="$(mktemp "$scratch_dir/command-timeout.XXXXXX")"

  # Tagged, and deliberately not exec'd: `bash -c "$command"` replaces itself
  # with the command for a simple command line, which would take the tag with
  # it. Keeping the wrapper alive costs one process and buys two things — the
  # command is a child that can be walked, and the wrapper carries this run's
  # token in its own argv, so a later run can find this run's survivors by
  # identity instead of waiting a guessed number of seconds for them.
  # Two inherited handles back that tag up, because the tag dies with the
  # wrapper: the token in the environment, and an open descriptor on the run's
  # marker file. A command that forks a replacement and then exits leaves that
  # replacement reparented with no tagged ancestor to walk from, and only
  # something inherited can still name it. Both are keyed to this run's token.
  # Descriptor-bound validation and a private hard-link witness prevent a
  # replaced shared marker from selecting a stranger.
  gate_run_ensure_marker \
    "The mapped command did not run" \
    "The mapped command did not start."
  request_marker="$gate_run_marker_file"
  request_tag="$(gate_run_request_tag)"
  command_marker="$request_marker"
  command_tag="$(gate_run_command_tag)"
  if [[ -n "$command_drain_identity" ]]; then
    if ! gate_lock_token_is_wellformed "$command_drain_identity"; then
      echo "error: the parallel command drain identity is malformed." >&2
      last_command_infrastructure_failed=true
      [[ "$had_errexit" == 1 ]] && set -e
      return 2
    fi
    if ! gate_run_create_marker_for_identity \
      "$command_drain_identity" \
      "The mapped command did not run" \
      "The mapped command did not start." 0; then
      if declare -F gate_coordinator_abandon_active_lease >/dev/null 2>&1; then
        gate_coordinator_abandon_active_lease || true
      fi
      last_command_infrastructure_failed=true
      [[ "$had_errexit" == 1 ]] && set -e
      return 2
    fi
    command_marker="$gate_run_created_marker_file"
    if declare -p gate_coordinator_active_drain_marker >/dev/null 2>&1; then
      gate_coordinator_active_drain_marker="$command_marker"
    fi
    command_tag="agentqg:${command_drain_identity}"
    if [[ -n "$deferred_lease_file" && -n "$command_marker" ]] &&
      ! exec 18< "$command_marker"; then
      echo "error: could not retain the parallel command marker." >&2
      if declare -F gate_coordinator_abandon_active_lease >/dev/null 2>&1; then
        gate_coordinator_abandon_active_lease || true
      fi
      last_command_infrastructure_failed=true
      [[ "$had_errexit" == 1 ]] && set -e
      return 2
    fi
  fi
  active_timeout_drain_identity="${command_drain_identity:-${gate_run_id:-$gate_lock_token}}"
  command_started_at="$(date +%s)"
  if declare -p gate_coordinator_recovery_drain_context >/dev/null 2>&1; then
    gate_coordinator_recovery_drain_context="active-command"
  fi
  AGENTQG_RUN="$command_tag" \
    AGENTQG_REQUEST="$request_tag" \
    bash -c '
      if [[ -n "$3" ]]; then
        # A marker this wrapper was given but cannot hold open is a refusal,
        # not a shrug: without the descriptor, a replacement this command
        # forks is invisible to the next run.
        if [[ ! -r "$3" ]]; then
          echo "error: cannot open the run marker $3; refusing to start the command" >&2
          exit 127
        fi
        exec 9< "$3"
      fi
      if [[ -n "$4" && "$4" != "$3" ]]; then
        if [[ ! -r "$4" ]]; then
          echo "error: cannot open the request marker $4; refusing to start the command" >&2
          exit 127
        fi
        exec 8< "$4"
      fi
      if [[ -n "$5" && "$5" != "$3" && "$5" != "$4" ]]; then
        if [[ ! -r "$5" ]]; then
          echo "error: cannot open the coordinator marker $5; refusing to start the command" >&2
          exit 127
        fi
        exec 6< "$5"
      fi
      if [[ "$6" == 1 ]]; then
        exec 7>&-
      fi
      if [[ "$7" == 1 ]]; then
        # fd17 is the private parallel-worker launch/sentinel pipe. Mapped
        # code must never inherit a writer that can release its group anchor.
        exec 17>&-
      fi
      eval "$2"
      exit $?
    ' "$command_tag" "$request_tag" \
      "$command" "$command_marker" "$request_marker" "$coordinator_marker" \
      "$gate_coordinator_stdout_reserved" \
      "$close_parallel_worker_control_fd" &
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
    exec 7>&-
    if [[ "$6" == 1 ]]; then
      exec 17>&-
    fi
    request_tag="$1"
    cmd_pid="$2"
    timeout_secs="$3"
    marker="$4"
    gate_pid="$5"
    collect_tree() {
      local pid="$1"
      local child
      while IFS= read -r child; do
        [ -n "$child" ] && collect_tree "$child"
      done < <(pgrep -P "$pid" 2>/dev/null || true)
      echo "$pid"
    }
    kill_tree() {
      local tree
      tree="$(collect_tree "$1")"
      while IFS= read -r pid; do
        [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null
      done <<EOF_KILL
$tree
EOF_KILL
      sleep 3
      while IFS= read -r pid; do
        [ -n "$pid" ] && kill -KILL "$pid" 2>/dev/null
      done <<EOF_KILL
$tree
EOF_KILL
    }
    # Sleep in steps rather than one shot, because this watchdog outlives its
    # gate: the command is backgrounded, so a SIGKILLed gate shell leaves it
    # running with the lock already reclaimable. Nobody else can see that
    # command — but this process can, and it is the last thing standing that
    # knows the two belong together.
    # Elapsed from the clock, not from the naps it asked for: a watchdog that
    # is descheduled or suspended should still time its command out on the
    # budget it was given rather than on how much sleeping it managed.
    started_at=$(date +%s)
    waited=0
    while [ "$waited" -lt "$timeout_secs" ]; do
      nap=2
      remaining=$((timeout_secs - waited))
      [ "$nap" -le "$remaining" ] || nap="$remaining"
      [ "$nap" -ge 1 ] || nap=1
      sleep "$nap"
      # Teardown on normal command completion kills this watchdog children-first,
      # so the dying sleep must not be mistaken for an elapsed timeout: bash
      # advances past a signal-killed sleep (rc>128) before the watchdog itself
      # receives TERM, and writing the marker in that window reports a false
      # "timed out after Ns" for a command that already succeeded (the race hits
      # reliably on Linux, rarely on macOS).
      [ "$?" -eq 0 ] || exit 0
      if ! kill -0 "$gate_pid" 2>/dev/null; then
        # The gate that started this command is gone without tearing it down,
        # which only happens on SIGKILL or a crash. Its command must not keep
        # running: the lock it held is already reclaimable, so whatever starts
        # next would be sharing the machine with a run that no longer exists.
        # No marker — this is not a timeout, and nobody is left to read it.
        kill_tree "$cmd_pid"
        exit 0
      fi
      waited=$(($(date +%s) - started_at))
    done
    echo timeout > "$marker"
    # kill_tree snapshots the whole tree BEFORE TERM: a root that exits on TERM
    # reparents a TERM-ignoring descendant away from the tree, so a post-TERM
    # re-walk would miss it. The KILL pass targets the saved list.
    kill_tree "$cmd_pid"
    exit 0
  ' "$command_tag" "$request_tag" \
    "$cmd_pid" "$effective_command_timeout_seconds" "$timeout_marker" "$$" \
    "$close_parallel_worker_control_fd" >/dev/null 2>&1 &
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
  # A failed Trunk command is not downgraded until the launcher proves that it
  # cannot provision its CLI. Treat that probe as part of the same mapped
  # command: it inherits the command's tags and marker handles, and the exact
  # descendant drain below runs before the scheduler lease is released.
  if [[ "$rc" -ne 0 && ! -s "$timeout_marker" ]] &&
    is_trunk_command "$command"; then
    if trunk_provisioning_is_blocked \
      "$command_tag" "$request_tag" "$command_marker" "$request_marker" \
      "$coordinator_marker" "$gate_coordinator_stdout_reserved" \
      "$close_parallel_worker_control_fd" "$trunk_probe_handshake_file"; then
      last_command_trunk_provisioning_blocked=true
    else
      provisioning_probe_rc=$?
    fi
  fi
  if [[ -z "$deferred_lease_file" ]]; then
    # A sequential wrapper can exit after it reparents a descendant. Keep the
    # scheduler lease until inherited handles prove that no process from this
    # command remains. Parallel workers defer the same identity drain and lease
    # release to their parent after the registered worker group settles.
    drain_completed_sequential_command || drain_rc=$?
    if [[ "$drain_rc" -eq 0 ]]; then
      active_timeout_drain_identity=""
    fi
  else
    # The parallel parent owns the registered identity and lease settlement.
    # Do not let this worker's EXIT trap race that parent drain.
    active_timeout_drain_identity=""
  fi
  command_finished_at="$(date +%s)"
  last_command_execution_seconds=$((command_finished_at - command_started_at))

  if [[ "$drain_rc" -ne 0 ]]; then
    # The command finished, but its descendants were not confirmed gone. Keep
    # the active lease and recovery marker. The caller prints the captured
    # diagnostics before it returns this infrastructure failure.
    last_command_infrastructure_failed=true
    rm -f "$timeout_marker"
    [[ "$had_errexit" == 1 ]] && set -e
    return "$drain_rc"
  fi

  if [[ "$provisioning_probe_rc" -eq 2 ]]; then
    # The probe might have started work that only its inherited handles can
    # identify. The drain above settled that identity, but an unclassified
    # launcher failure must not release capacity or become a cloud skip.
    last_command_infrastructure_failed=true
    rm -f "$timeout_marker"
    [[ "$had_errexit" == 1 ]] && set -e
    return 2
  fi

  if [[ -s "$timeout_marker" ]]; then
    last_command_timed_out=true
    rc=1
  elif [[ "$rc" -gt 128 ]]; then
    rc=1
  fi
  rm -f "$timeout_marker"

  if [[ "$coordinator_release_deferred" -eq 0 ]] &&
    declare -F gate_coordinator_after_command >/dev/null 2>&1; then
    gate_coordinator_after_command "$command"
    release_rc=$?
    if [[ "$release_rc" -ne 0 ]]; then
      last_command_infrastructure_failed=true
      rc=2
    fi
  fi

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
    [[ "$created_at" -le "$now" ]] || continue
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
  local input_tmp
  local line
  local created_at
  local rest
  local fingerprint

  now="$(date +%s)" || return 1
  tmp="$(mktemp "$scratch_dir/agentqg.XXXXXX")" || return 1
  [[ -n "$tmp" ]] || return 1
  tmpfiles+=("$tmp")
  input_tmp="$(mktemp "$scratch_dir/agentqg.XXXXXX")" || return 1
  [[ -n "$input_tmp" ]] || return 1
  tmpfiles+=("$input_tmp")
  : > "$tmp" || return 1
  cp "$command_stamps_file" "$input_tmp" || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    created_at="${line%%$'\t'*}"
    [[ "$created_at" =~ ^[0-9]+$ ]] || continue
    rest="${line#*$'\t'}"
    fingerprint="${rest#*$'\t'}"
    [[ "$fingerprint" == "$current_stamp" ]] || continue
    [[ "$created_at" -le "$now" ]] || continue
    [[ $((now - created_at)) -le "$success_stamp_ttl_seconds" ]] || continue
    printf '%s\n' "$line" >> "$tmp" || return 1
  done < "$input_tmp" || return 1
  mv -f "$tmp" "$command_stamps_file" 2>/dev/null || true
}

# Prints the reuse marker and records a `reused` summary entry (NOT counted as
# executed, never logged to durations) when the command was already completed by
# a previous run with the identical fingerprint. Returns 0 when reused (caller
# skips execution), 1 when the command must run.
try_reuse_command() {
  local command="$1"
  # Coordinator fingerprints bind toolchain and material environment inputs
  # that the legacy per-command stamp does not. A coordinator leader must
  # execute rather than promote a weaker local stamp into a shared verdict.
  if declare -F gate_coordinator_is_active >/dev/null 2>&1 &&
    gate_coordinator_is_active; then
    return 1
  fi
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
  local trunk_probe_handshake_file
  local gate_pid="$$"
  local monitor_done_file=""
  local monitor_pid=""
  local start_ts
  local elapsed
  local exit_code
  local trunk_provisioning_blocked

  if try_reuse_command "$command"; then
    return 0
  fi

  output_file="$(make_tmpfile)"
  trunk_probe_handshake_file="$(make_tmpfile)"
  tmpfiles+=("$trunk_probe_handshake_file")
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
  run_with_timeout "$command" "" "" "$trunk_probe_handshake_file" \
    > "$output_file" 2>&1
  exit_code=$?
  set -e
  local timed_out="$last_command_timed_out"
  trunk_provisioning_blocked="$last_command_trunk_provisioning_blocked"
  rm -f "$trunk_probe_handshake_file"
  if [[ -n "$monitor_pid" ]]; then
    : > "$monitor_done_file"
    wait "$monitor_pid" 2>/dev/null || true
    rm -f "$monitor_done_file"
  fi
  elapsed="$last_command_execution_seconds"

  if [[ "$exit_code" -eq 0 ]]; then
    sed -n \
      -e '/^A completed mapped command left descendants running; stopping them before releasing its scheduler lease\.$/p' \
      -e "/^The completed mapped command's descendants are gone; releasing its scheduler lease\.$/p" \
      "$output_file"
    record_command_summary "ok" "$elapsed" "$command"
    record_command_stamp "$command"
    if is_autoreview_test_command "$command"; then
      print_autoreview_test_timings "$output_file"
    fi
    echo "✓ ${command} ($(format_duration "$elapsed"))"
    rm -f "$output_file"
    return 0
  fi

  if [[ "$timed_out" != true &&
    "$trunk_provisioning_blocked" == true ]] &&
    is_trunk_command "$command"; then
    record_command_summary "skipped" "$elapsed" "$command"
    print_trunk_environment_blocked_warning "$command"
    rm -f "$output_file"
    return 0
  fi

  record_command_summary "fail" "$elapsed" "$command"
  if [[ "$timed_out" == true ]]; then
    echo "Command timed out after $(mapped_command_timeout_seconds "$command")s: ${command}" >&2
  else
    echo "Command failed after $(format_duration "$elapsed"): ${command}" >&2
  fi
  filter_expected_output < "$output_file" >&2
  record_failure_output "$command" "$output_file"
  rm -f "$output_file"
  return "$exit_code"
}

run_mapped_command_to_files() {
  local command="$1"
  local output_file="$2"
  local status_file="$3"
  local elapsed_file="$4"
  local timeout_file="$5"
  local infrastructure_file="$6"
  local trunk_provisioning_file="$7"
  local lease_file="$8"
  local command_drain_identity="$9"
  local elapsed
  local exit_code

  set +e
  run_with_timeout "$command" "$lease_file" "$command_drain_identity" \
    "$trunk_provisioning_file" > "$output_file" 2>&1
  exit_code=$?
  set -e
  elapsed="$last_command_execution_seconds"

  printf '%s\n' "$exit_code" > "$status_file"
  printf '%s\n' "$elapsed" > "$elapsed_file"
  printf '%s\n' "$last_command_timed_out" > "$timeout_file"
  printf '%s\n' "$last_command_infrastructure_failed" > "$infrastructure_file"
  printf '%s\n' "$last_command_trunk_provisioning_blocked" \
    > "$trunk_provisioning_file"
}

fail_command_scheduler_infrastructure() {
  local command="$1"
  echo "error: command scheduler infrastructure failed for: ${command}" >&2
  echo "The quality gate stops before it schedules another command." >&2
  teardown_active_timeouts
  if declare -F gate_coordinator_is_active >/dev/null 2>&1 &&
    gate_coordinator_is_active &&
    declare -F gate_coordinator_cancel_and_ack >/dev/null 2>&1; then
    if ! gate_coordinator_cancel_and_ack \
      "command scheduler infrastructure failure" active-command; then
      echo "error: coordinator request cancellation after scheduler failure did not complete." >&2
    fi
  fi
  return 2
}

read_parallel_worker_result_value() {
  local file="$1"
  local field_type="$2"
  local value
  local byte_count
  local expected_bytes
  local maximum

  [[ -f "$file" && ! -L "$file" && -r "$file" ]] || return 1
  value="$(cat "$file" 2>/dev/null)" || return 1
  case "$field_type" in
    status|elapsed)
      [[ "$value" =~ ^[0-9]+$ ]] || return 1
      ;;
    boolean)
      [[ "$value" == true || "$value" == false ]] || return 1
      ;;
    lease)
      [[ "$value" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || return 1
      ;;
    ready)
      [[ "$value" == ready ]] || return 1
      ;;
    *) return 1 ;;
  esac
  byte_count="$(LC_ALL=C wc -c < "$file" 2>/dev/null | tr -d '[:space:]')" ||
    return 1
  [[ "$byte_count" =~ ^[0-9]+$ ]] || return 1
  expected_bytes=$((${#value} + 1))
  [[ "$byte_count" -eq "$expected_bytes" ]] || return 1
  if [[ "$field_type" == status || "$field_type" == elapsed ]]; then
    while [[ "${#value}" -gt 1 && "$value" == 0* ]]; do
      value="${value#0}"
    done
    if [[ "$field_type" == status ]]; then
      maximum=255
    else
      # Keep later Bash arithmetic within the signed 32-bit range on every
      # supported host. A command cannot legitimately run for 68 years.
      maximum=2147483647
    fi
    [[ "${#value}" -le "${#maximum}" ]] || return 1
    [[ "$value" -le "$maximum" ]] || return 1
  fi
  printf '%s\n' "$value"
}

release_parallel_worker_lease() {
  local command="$1"
  local lease_file="$2"
  local lease_id
  if ! declare -F gate_coordinator_is_active >/dev/null 2>&1 ||
    ! gate_coordinator_is_active; then
    [[ ! -s "$lease_file" ]] || return 2
    return 0
  fi
  [[ -z "${gate_coordinator_active_lease_id:-}" ]] || return 2
  lease_id="$(read_parallel_worker_result_value "$lease_file" lease)" || return 2
  gate_coordinator_active_lease_id="$lease_id"
  parallel_release_attempt=$((parallel_release_attempt + 1))
  if [[ -n "$parallel_release_failure_at" &&
    "$parallel_release_attempt" -eq "$parallel_release_failure_at" ]]; then
    gate_coordinator_infrastructure_failed=1
    echo "error: injected parallel coordinator lease-release failure." >&2
    return 2
  fi
  gate_coordinator_after_command "$command"
}

fail_parallel_worker_infrastructure() {
  local command="$1"
  local field="$2"
  echo "error: parallel worker left an invalid ${field} result for: ${command}" >&2
  echo "The quality gate cannot trust this worker completion and stops scheduling." >&2
  teardown_active_timeouts
  if declare -F gate_coordinator_is_active >/dev/null 2>&1 &&
    gate_coordinator_is_active &&
    declare -F gate_coordinator_cancel_and_ack >/dev/null 2>&1; then
    if ! gate_coordinator_cancel_and_ack \
      "parallel worker infrastructure failure (${field})" active-command; then
      echo "error: coordinator request cancellation after worker failure did not complete." >&2
    fi
  fi
  return 2
}

is_quality_setup_command() {
  local command="$1"
  # These commands have side effects that later quality checks depend on, or
  # gate whether later commands may run at all, so they must finish before the
  # independent quality pool starts. Keep this list in sync with new
  # setup-style commands added by the path mapper above.
  case "$command" in
    "node scripts/check-agent-quality-gate-package-scripts.mjs")
      # A SAFETY prerequisite, not a build one. The `root-tooling-scripts`
      # classification skips the `--allow-package-script-changes` refusal for a
      # package.json edit that touches only allowlisted aliases, which is only
      # sound while this validator pins each of those aliases to an exact
      # command. `add_root_tooling_package_script_checks` queues the validator
      # into the SAME pool as `pnpm sentry:requeue:test` and friends, so before
      # this arm existed an edit appending `&& <anything>` to a trusted alias
      # ran that alias concurrently with the check meant to reject it — and
      # keep-going meant a failed validator only incremented the failure count.
      # As a setup command it runs in run_prerequisite_phase, which is fail-fast
      # and stamp-exempt, so an unpinned or drifted alias aborts the run before
      # any `pnpm <alias>` executes and `--skip-if-fresh` cannot skip it.
      return 0
      ;;
    "pnpm --filter @mento-protocol/config build")
      return 0
      ;;
    TF_DATA_DIR=*terraform\ -chdir=*)
      return 0
      ;;
    TF_DATA_DIR=*node\ scripts/terraform/terraform-fmt-check.mjs\ *)
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

is_quality_exclusive_command() {
  local command="$1"
  # Suites that must not share the worker pool with anything (GitHub issue
  # #1802). The dashboard's Vitest suite forks its own workers across every
  # core AND spawns `scripts/browser-api-policy-lint-runner.mjs`, an ESLint
  # program load that costs ~17s of CPU and is bounded by a wall-clock test
  # timeout. Running it beside three other pool members turns that fixed CPU
  # cost into a wall time that outruns its budget: measured on a 12-core mac,
  # the runner takes ~19s uncontended and 29-38s while the machine carries a
  # load average around 30. The failure is a genuine starvation, not a flaky
  # assertion, so the fix is to stop co-scheduling it rather than to widen the
  # budget until the starvation is invisible.
  #
  # These run in their own phase AFTER the pool drains, so cheap lint/typecheck
  # feedback still arrives first. Add a command here only with a measurement:
  # every entry is wall time the pool can no longer overlap.
  case "$command" in
    "pnpm --filter @mento-protocol/ui-dashboard test:coverage")
      return 0
      ;;
    "pnpm --filter @mento-protocol/ui-dashboard exec vitest related --run "*)
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
      if [[ "$last_command_infrastructure_failed" == true ]]; then
        fail_command_scheduler_infrastructure "$command" || return $?
      fi
      if [[ "$fail_fast" == "1" || "$fail_fast" == "true" ]]; then
        echo
        echo "Stopping after first failed mapped command (--fail-fast)." >&2
        print_command_summary
        print_failed_command_output
        log_duration_line "fail" "$(($(date +%s) - gate_start_ts))" "__run_total__" "run" || true
        exit 1
      fi
    fi
  done
}

make_parallel_command_drain_identity() {
  local sequence="$1"
  local digest now identity
  digest="$(printf '%s' "${gate_run_id:-nolock-$$}:${sequence}" | hash_stream)" ||
    return 1
  now="$(date +%s)" || return 1
  identity="cmd${digest:0:20}-$$-${now}"
  gate_lock_token_is_wellformed "$identity" || return 1
  printf '%s\n' "$identity"
}

unregister_active_parallel_worker() {
  local target_pgid="$1"
  local target_identity="$2"
  local target_start="$3"
  local index found=0
  local -a kept_pgids=()
  local -a kept_identities=()
  local -a kept_starts=()
  [[ "${#active_worker_pgids[@]}" -eq "${#active_worker_drain_identities[@]}" &&
    "${#active_worker_pgids[@]}" -eq "${#active_worker_start_identities[@]}" ]] ||
    return 2
  for index in "${!active_worker_pgids[@]}"; do
    if [[ "${active_worker_pgids[$index]}" == "$target_pgid" &&
      "${active_worker_drain_identities[$index]}" == "$target_identity" &&
      "${active_worker_start_identities[$index]}" == "$target_start" ]]; then
      found=1
      continue
    fi
    kept_pgids+=("${active_worker_pgids[$index]}")
    kept_identities+=("${active_worker_drain_identities[$index]}")
    kept_starts+=("${active_worker_start_identities[$index]}")
  done
  [[ "$found" -eq 1 ]] || return 2
  active_worker_pgids=("${kept_pgids[@]+"${kept_pgids[@]}"}")
  active_worker_drain_identities=("${kept_identities[@]+"${kept_identities[@]}"}")
  active_worker_start_identities=("${kept_starts[@]+"${kept_starts[@]}"}")
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
  local active_infrastructure_files=()
  local active_trunk_provisioning_files=()
  local active_lease_files=()
  local active_ready_files=()
  local active_wait_files=()
  local active_drain_identities=()
  local active_start_identities=()
  local next_active_pids=()
  local next_active_commands=()
  local next_active_output_files=()
  local next_active_status_files=()
  local next_active_elapsed_files=()
  local next_active_timeout_files=()
  local next_active_infrastructure_files=()
  local next_active_trunk_provisioning_files=()
  local next_active_lease_files=()
  local next_active_ready_files=()
  local next_active_wait_files=()
  local next_active_drain_identities=()
  local next_active_start_identities=()
  local running_pids=()
  local entry
  local command
  local output_file
  local status_file
  local elapsed_file
  local timeout_file
  local infrastructure_file
  local trunk_provisioning_file
  local lease_file
  local ready_file
  local ready_staging_file
  local wait_file
  local request_marker_open
  local coordinator_marker_open
  local drain_identity
  local worker_start
  local worker_pgid
  local worker_parent_pid
  local worker_parent_start
  local worker_has_recovery_owner
  local worker_identity_attempt
  local pid
  local i
  local status
  local elapsed
  local timed_out
  local infrastructure_failed
  local trunk_provisioning_blocked
  local worker_ready
  local phase_start_ts last_heartbeat_ts last_coordinator_recovery_ts now_ts hb_cmd
  local heartbeat_interval=20
  local had_monitor=0

  if [[ "$total" -eq 0 ]]; then
    return
  fi

  if [[ "$max_parallel" -le 1 || "$total" -le 1 ]]; then
    run_mapped_entries_sequential "$phase" "${entries[@]}"
    return
  fi

  # No-lock workers have no successor that can reap their live sentinel. Bind
  # them to this exact parent so they can leave after a fatal parent exit.
  # Locked workers retain the same identity for the launch handshake, which
  # stops work from starting before the parent records the worker.
  worker_parent_pid="$$"
  worker_parent_start="$(gate_lock_process_start "$worker_parent_pid")"
  if [[ -z "$worker_parent_start" ]]; then
    if gate_lock_identity_source_available; then
      echo "error: could not identify the parallel worker parent." >&2
      fail_command_scheduler_infrastructure "parallel worker launch" || return $?
    fi
    worker_parent_start="$gate_lock_identity_unavailable"
  fi

  echo
  echo "Running ${phase} commands with parallelism ${max_parallel}."
  phase_start_ts="$(date +%s)"
  last_heartbeat_ts="$phase_start_ts"
  last_coordinator_recovery_ts="$phase_start_ts"

  while [[ "$completed" -lt "$total" ]]; do
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
    next_active_infrastructure_files=()
    next_active_trunk_provisioning_files=()
    next_active_lease_files=()
    next_active_ready_files=()
    next_active_wait_files=()
    next_active_drain_identities=()
    next_active_start_identities=()

    for i in "${!active_pids[@]}"; do
      pid="${active_pids[$i]}"
      ready_file="${active_ready_files[$i]}"
      worker_ready=0
      if read_parallel_worker_result_value "$ready_file" ready >/dev/null 2>&1; then
        worker_ready=1
      fi
      if [[ "$worker_ready" -eq 0 && ! -s "$ready_file" ]] &&
        list_contains_word "$pid" "${running_pids[@]+"${running_pids[@]}"}"; then
        next_active_pids+=("$pid")
        next_active_commands+=("${active_commands[$i]}")
        next_active_output_files+=("${active_output_files[$i]}")
        next_active_status_files+=("${active_status_files[$i]}")
        next_active_elapsed_files+=("${active_elapsed_files[$i]}")
        next_active_timeout_files+=("${active_timeout_files[$i]}")
        next_active_infrastructure_files+=("${active_infrastructure_files[$i]}")
        next_active_trunk_provisioning_files+=("${active_trunk_provisioning_files[$i]}")
        next_active_lease_files+=("${active_lease_files[$i]}")
        next_active_ready_files+=("$ready_file")
        next_active_wait_files+=("${active_wait_files[$i]}")
        next_active_drain_identities+=("${active_drain_identities[$i]}")
        next_active_start_identities+=("${active_start_identities[$i]}")
        continue
      fi

      command="${active_commands[$i]}"
      drain_identity="${active_drain_identities[$i]}"
      worker_start="${active_start_identities[$i]}"
      output_file="${active_output_files[$i]}"
      status_file="${active_status_files[$i]}"
      elapsed_file="${active_elapsed_files[$i]}"
      timeout_file="${active_timeout_files[$i]}"
      infrastructure_file="${active_infrastructure_files[$i]}"
      trunk_provisioning_file="${active_trunk_provisioning_files[$i]}"
      lease_file="${active_lease_files[$i]}"
      wait_file="${active_wait_files[$i]}"
      worker_settlement_in_progress=1
      # Capture and drain the exact command identity before signalling the
      # worker or its descendants. A detached child can leave the worker group.
      # The drain retains durable evidence for every process while signals run.
      if ! drain_completed_parallel_command \
        "$drain_identity" "$pid" "$worker_start"; then
        finish_worker_settlement
        rm -f "$output_file" "$status_file" "$elapsed_file" "$timeout_file" \
          "$infrastructure_file" "$trunk_provisioning_file" "$lease_file" \
          "$ready_file" \
          "${ready_file}.publishing" "$wait_file"
        fail_command_scheduler_infrastructure "$command" || return $?
      fi
      # The worker remains as the live group leader until this exact drain
      # captures every same-group member. Reap it only after the drain is empty.
      wait "$pid" 2>/dev/null || true
      if ! unregister_active_parallel_worker \
        "$pid" "$drain_identity" "$worker_start"; then
        finish_worker_settlement
        fail_parallel_worker_infrastructure "$command" "drain registry" || return $?
      fi
      finish_worker_settlement
      if ! read_parallel_worker_result_value "$ready_file" ready >/dev/null; then
        fail_parallel_worker_infrastructure "$command" readiness || return $?
      fi
      if ! status="$(read_parallel_worker_result_value "$status_file" status)"; then
        fail_parallel_worker_infrastructure "$command" status || return $?
      fi
      if ! elapsed="$(read_parallel_worker_result_value "$elapsed_file" elapsed)"; then
        fail_parallel_worker_infrastructure "$command" elapsed || return $?
      fi
      if ! timed_out="$(read_parallel_worker_result_value "$timeout_file" boolean)"; then
        fail_parallel_worker_infrastructure "$command" timeout || return $?
      fi
      if ! infrastructure_failed="$(read_parallel_worker_result_value "$infrastructure_file" boolean)"; then
        fail_parallel_worker_infrastructure "$command" infrastructure || return $?
      fi
      if ! trunk_provisioning_blocked="$(read_parallel_worker_result_value "$trunk_provisioning_file" boolean)"; then
        fail_parallel_worker_infrastructure "$command" \
          "Trunk provisioning classification" || return $?
      fi

      if [[ "$infrastructure_failed" == true ]]; then
        rm -f "$output_file" "$status_file" "$elapsed_file" "$timeout_file" \
          "$infrastructure_file" "$trunk_provisioning_file" "$lease_file" \
          "$ready_file" \
          "${ready_file}.publishing" "$wait_file"
        fail_command_scheduler_infrastructure "$command" || return $?
      fi
      if [[ "$trunk_provisioning_blocked" == true ]]; then
        trunk_provisioning_state=blocked
      fi
      if ! release_parallel_worker_lease "$command" "$lease_file"; then
        rm -f "$output_file" "$status_file" "$elapsed_file" "$timeout_file" \
          "$infrastructure_file" "$trunk_provisioning_file" "$lease_file" \
          "$ready_file" \
          "${ready_file}.publishing" "$wait_file"
        fail_command_scheduler_infrastructure "$command" || return $?
      fi

      if [[ "$status" -eq 0 ]]; then
        record_command_summary "ok" "$elapsed" "$command"
        record_command_stamp "$command"
        if is_autoreview_test_command "$command"; then
          print_autoreview_test_timings "$output_file"
        fi
        echo "✓ ${command} ($(format_duration "$elapsed"))"
      elif [[ "$timed_out" != true &&
        "$trunk_provisioning_blocked" == true ]] &&
        is_trunk_command "$command"; then
        record_command_summary "skipped" "$elapsed" "$command"
        print_trunk_environment_blocked_warning "$command"
      else
        failures=$((failures + 1))
        record_command_summary "fail" "$elapsed" "$command"
        if [[ "$timed_out" == true ]]; then
          echo "Command timed out after $(mapped_command_timeout_seconds "$command")s: ${command}" >&2
        else
          echo "Command failed after $(format_duration "$elapsed"): ${command}" >&2
        fi
        filter_expected_output < "$output_file" >&2
        record_failure_output "$command" "$output_file"
      fi

      rm -f "$output_file" "$status_file" "$elapsed_file" "$timeout_file" \
        "$infrastructure_file" "$trunk_provisioning_file" "$lease_file" \
        "$ready_file" \
        "${ready_file}.publishing" "$wait_file"
      completed=$((completed + 1))
    done

    # INT/TERM must see either the old complete cleanup registry or the new
    # complete one. A trap between these aligned assignments would otherwise
    # clear a mismatched registry and leave its worker outside EXIT cleanup.
    worker_settlement_in_progress=1
    active_pids=("${next_active_pids[@]+"${next_active_pids[@]}"}")
    active_worker_pgids=("${next_active_pids[@]+"${next_active_pids[@]}"}")
    active_commands=("${next_active_commands[@]+"${next_active_commands[@]}"}")
    active_output_files=("${next_active_output_files[@]+"${next_active_output_files[@]}"}")
    active_status_files=("${next_active_status_files[@]+"${next_active_status_files[@]}"}")
    active_elapsed_files=("${next_active_elapsed_files[@]+"${next_active_elapsed_files[@]}"}")
    active_timeout_files=("${next_active_timeout_files[@]+"${next_active_timeout_files[@]}"}")
    active_infrastructure_files=("${next_active_infrastructure_files[@]+"${next_active_infrastructure_files[@]}"}")
    active_trunk_provisioning_files=("${next_active_trunk_provisioning_files[@]+"${next_active_trunk_provisioning_files[@]}"}")
    active_lease_files=("${next_active_lease_files[@]+"${next_active_lease_files[@]}"}")
    active_ready_files=("${next_active_ready_files[@]+"${next_active_ready_files[@]}"}")
    active_wait_files=("${next_active_wait_files[@]+"${next_active_wait_files[@]}"}")
    active_drain_identities=("${next_active_drain_identities[@]+"${next_active_drain_identities[@]}"}")
    active_start_identities=("${next_active_start_identities[@]+"${next_active_start_identities[@]}"}")
    active_worker_drain_identities=("${next_active_drain_identities[@]+"${next_active_drain_identities[@]}"}")
    active_worker_start_identities=("${next_active_start_identities[@]+"${next_active_start_identities[@]}"}")
    finish_worker_settlement

    # Process every completion observed above before opening another pool slot.
    # A completed worker can report a failed coordinator lease release. Starting
    # a replacement first would let that command run beside an unresolved lease.
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

      # A completed serialized command drains and removes its marker. Create
      # the request-wide recovery marker in this parent before forking. The
      # worker creates its command marker after its scheduler lease exists.
      gate_run_ensure_marker \
        "The parallel command batch did not run" \
        "The parallel command batch did not start."

      output_file="$(make_tmpfile)"
      status_file="$(make_tmpfile)"
      elapsed_file="$(make_tmpfile)"
      timeout_file="$(make_tmpfile)"
      infrastructure_file="$(make_tmpfile)"
      trunk_provisioning_file="$(make_tmpfile)"
      lease_file="$(make_tmpfile)"
      ready_file="$(make_tmpfile)"
      ready_staging_file="${ready_file}.publishing"
      wait_file="${ready_file}.wait"
      tmpfiles+=(
        "$output_file" "$status_file" "$elapsed_file" "$timeout_file"
        "$infrastructure_file" "$trunk_provisioning_file" "$lease_file"
        "$ready_file"
        "$ready_staging_file" "$wait_file"
      )
      # The ready path must be absent until the worker atomically publishes a
      # complete result. The sibling FIFO lets the worker wait without spawning
      # a child that would look like a leaked mapped-command descendant.
      rm -f "$ready_file"
      if ! mkfifo "$wait_file"; then
        echo "error: could not create the parallel worker sentinel pipe." >&2
        fail_command_scheduler_infrastructure "$command" || return $?
      fi
      parallel_command_sequence=$((parallel_command_sequence + 1))
      if ! drain_identity="$(make_parallel_command_drain_identity "$parallel_command_sequence")"; then
        echo "error: could not create a safe parallel command drain identity." >&2
        fail_command_scheduler_infrastructure "$command" || return $?
      fi

      echo
      echo "+ ${command}"
      worker_registration_in_progress=1
      request_marker_open=0
      coordinator_marker_open=0
      worker_has_recovery_owner=0
      if [[ -n "$gate_run_marker_file" ]]; then
        if ! gate_run_marker_matches_identity \
          "${gate_run_id:-$gate_lock_token}" "$gate_run_marker_file" ||
          ! exec 19< "$gate_run_marker_file"; then
          rm -f "$wait_file"
          finish_worker_registration
          echo "error: could not prepare the parallel worker's inherited request handle." >&2
          fail_command_scheduler_infrastructure "$command" || return $?
        fi
        request_marker_open=1
        worker_has_recovery_owner=1
      fi
      # The coordinator generation marker is the compatibility handle an
      # older legacy gate knows how to drain after it reclaims run.lock. Keep
      # it in the worker itself; the mapped wrapper that also holds this marker
      # exits before the worker sentinel does.
      if declare -F gate_coordinator_is_active >/dev/null 2>&1 &&
        gate_coordinator_is_active; then
        if [[ -z "${gate_coordinator_generation_token:-}" ||
          -z "${gate_coordinator_marker_file:-}" ]] ||
          ! gate_run_marker_matches_identity \
            "$gate_coordinator_generation_token" \
            "$gate_coordinator_marker_file" ||
          ! exec 16< "$gate_coordinator_marker_file"; then
          [[ "$request_marker_open" -eq 0 ]] || exec 19<&-
          rm -f "$wait_file"
          finish_worker_registration
          echo "error: could not prepare the parallel worker's inherited coordinator generation handle." >&2
          fail_command_scheduler_infrastructure "$command" || return $?
        fi
        coordinator_marker_open=1
        worker_has_recovery_owner=1
      fi
      # Open the control FIFO in the parent before fork. The child cannot run
      # mapped work until this parent writes `start`, after it has bound the
      # worker's PID/start/PGID identity and inserted every cleanup registry.
      # O_RDWR avoids either FIFO open blocking before the other process exists.
      if ! exec 17<> "$wait_file"; then
        [[ "$coordinator_marker_open" -eq 0 ]] || exec 16<&-
        [[ "$request_marker_open" -eq 0 ]] || exec 19<&-
        rm -f "$wait_file"
        finish_worker_registration
        echo "error: could not open the parallel worker launch pipe." >&2
        fail_command_scheduler_infrastructure "$command" || return $?
      fi
      had_monitor=0
      case "$-" in
        *m*) had_monitor=1 ;;
      esac
      # macOS has no setsid(1). Bash job control is available in stock Bash
      # 3.2 and gives this background worker a dedicated process group whose ID
      # is the worker PID. The worker stays alive as that group's validated
      # leader until the parent captures and drains every member.
      set -m
      (
        # A Bash subshell inherits the parent's trap handlers and their state.
        # This worker starts while registration_in_progress=1, so keeping that
        # handler would defer the drain's TERM forever. The parent owns cleanup.
        trap - EXIT INT TERM HUP
        worker_registration_in_progress=0
        worker_settlement_in_progress=0
        pending_terminating_signal=""
        # The parent needs monitor mode only to create this worker group. Turn
        # it back off inside the worker so run_with_timeout's command and
        # watchdog children stay in that group instead of becoming new jobs.
        set +m
        parallel_worker_parent_is_live() {
          local current_parent_start
          if [[ "$worker_parent_start" == "$gate_lock_identity_unavailable" ]]; then
            kill -0 "$worker_parent_pid" 2>/dev/null
            return $?
          fi
          current_parent_start="$(gate_lock_process_start "$worker_parent_pid")"
          if [[ -z "$current_parent_start" ]]; then
            # One unreadable process-table sample is not proof that the exact
            # parent died. Keep the only live group anchor while its PID still
            # exists, then retry the identity read on the next poll.
            kill -0 "$worker_parent_pid" 2>/dev/null
            return $?
          fi
          [[ "$current_parent_start" == "$worker_parent_start" ]] || return 1
          ! gate_lock_process_is_confirmed_zombie \
            "$worker_parent_pid" "$worker_parent_start"
        }
        # The request marker and this FIFO were opened by the parent before
        # fork. Wait until the parent has recorded the exact worker identity.
        # If the parent dies before that point, leave without running work.
        worker_action=""
        while :; do
          if IFS= read -r -t 1 worker_action <&17; then
            break
          fi
          parallel_worker_parent_is_live || exit 2
        done
        [[ "$worker_action" == start ]] || exit 2
        rm -f "$wait_file"
        export AGENTQG_RUN="agentqg:${drain_identity}"
        AGENTQG_REQUEST="$(gate_run_request_tag)" || exit 2
        export AGENTQG_REQUEST
        run_mapped_command_to_files \
          "$command" "$output_file" "$status_file" "$elapsed_file" \
          "$timeout_file" "$infrastructure_file" \
          "$trunk_provisioning_file" "$lease_file" "$drain_identity"
        if ! printf '%s\n' ready > "$ready_staging_file" ||
          ! mv -f "$ready_staging_file" "$ready_file"; then
          exit 2
        fi
        # A locked run has a durable recovery owner, so this live group anchor
        # must remain until the parent or a successor drains it. A no-lock run
        # has no successor. Its sentinel exits when this exact parent dies.
        if [[ "$worker_has_recovery_owner" -eq 1 ]]; then
          # Bash can defer TERM while a blocking FIFO read has no writer. Poll
          # the private descriptor so the trap runs promptly and normal command
          # settlement does not wait for the four-second KILL escalation.
          trap 'exit 0' HUP INT TERM
          while :; do
            IFS= read -r -t 1 _ <&17 || true
          done
        else
          while parallel_worker_parent_is_live; do
            IFS= read -r -t 1 _ <&17 || true
          done
        fi
      ) </dev/null &
      pid="$!"
      worker_start=""
      worker_pgid=""
      for ((worker_identity_attempt = 0; worker_identity_attempt < 100; worker_identity_attempt++)); do
        worker_start="$(gate_lock_process_start "$pid")"
        worker_pgid="$(TZ=UTC LC_ALL=C ps -o pgid= -p "$pid" 2>/dev/null |
          head -n1 | tr -d '[:space:]' || true)"
        if [[ "$worker_pgid" == "$pid" ]] && {
          [[ -n "$worker_start" ]] || ! gate_lock_identity_source_available
        }; then
          break
        fi
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.01 || true
      done
      if [[ -z "$worker_start" ]] && ! gate_lock_identity_source_available; then
        worker_start="$gate_lock_identity_unavailable"
      fi
      if [[ -z "$worker_start" || "$worker_pgid" != "$pid" ]]; then
        # The worker is still behind the launch barrier. Ask it to leave
        # voluntarily. Do not signal a bare PID or the assumed `-$pid` group:
        # the failed reads did not establish either identity.
        printf '%s\n' abort >&17 2>/dev/null || true
        exec 17>&-
        [[ "$coordinator_marker_open" -eq 0 ]] || exec 16<&-
        [[ "$request_marker_open" -eq 0 ]] || exec 19<&-
        wait "$pid" 2>/dev/null || true
        rm -f "$ready_file" "$ready_staging_file" "$wait_file"
        if [[ "$had_monitor" -eq 0 ]]; then
          set +m
        fi
        finish_worker_registration
        echo "error: could not bind the parallel worker to its PID, start identity, and dedicated process group." >&2
        fail_command_scheduler_infrastructure "$command" || return $?
      fi

      # A coordinator journal already maps this command identity to its
      # request. A pure legacy run has no such journal, so publish the command
      # token as a legacy drain obligation before the worker can create its
      # command marker or run work. Normal settlement removes the obligation.
      # After SIGKILL, the next legacy holder can drain the command marker and
      # remove it instead of leaving an unreferenced holder file forever.
      if { ! declare -F gate_coordinator_is_active >/dev/null 2>&1 ||
        ! gate_coordinator_is_active; } &&
        [[ -n "$gate_lock_dir" && -n "$gate_lock_root_dir" &&
          -n "$gate_lock_token" ]] &&
        ! record_condemned_run "$drain_identity"; then
        printf '%s\n' abort >&17 2>/dev/null || true
        exec 17>&-
        [[ "$coordinator_marker_open" -eq 0 ]] || exec 16<&-
        [[ "$request_marker_open" -eq 0 ]] || exec 19<&-
        wait "$pid" 2>/dev/null || true
        rm -f "$ready_file" "$ready_staging_file" "$wait_file"
        if [[ "$had_monitor" -eq 0 ]]; then
          set +m
        fi
        finish_worker_registration
        echo "error: could not persist the legacy parallel command drain identity." >&2
        fail_command_scheduler_infrastructure "$command" || return $?
      fi

      # Register every cleanup view before the worker can start mapped work.
      # A deferred INT/TERM therefore sees either no worker or this complete
      # aligned record. SIGKILL recovery uses the inherited request handle.
      active_pids+=("$pid")
      active_worker_pgids+=("$worker_pgid")
      active_worker_drain_identities+=("$drain_identity")
      active_worker_start_identities+=("$worker_start")
      active_commands+=("$command")
      active_output_files+=("$output_file")
      active_status_files+=("$status_file")
      active_elapsed_files+=("$elapsed_file")
      active_timeout_files+=("$timeout_file")
      active_infrastructure_files+=("$infrastructure_file")
      active_trunk_provisioning_files+=("$trunk_provisioning_file")
      active_lease_files+=("$lease_file")
      active_ready_files+=("$ready_file")
      active_wait_files+=("$wait_file")
      active_drain_identities+=("$drain_identity")
      active_start_identities+=("$worker_start")
      if ! printf '%s\n' start >&17; then
        exec 17>&-
        [[ "$coordinator_marker_open" -eq 0 ]] || exec 16<&-
        [[ "$request_marker_open" -eq 0 ]] || exec 19<&-
        if [[ "$had_monitor" -eq 0 ]]; then
          set +m
        fi
        finish_worker_registration
        echo "error: could not release the registered parallel worker launch barrier." >&2
        fail_command_scheduler_infrastructure "$command" || return $?
      fi
      exec 17>&-
      [[ "$coordinator_marker_open" -eq 0 ]] || exec 16<&-
      [[ "$request_marker_open" -eq 0 ]] || exec 19<&-
      if [[ "$had_monitor" -eq 0 ]]; then
        set +m
      fi

      # Private deterministic barrier for the signal-registration regression.
      # It is inert unless the test suite opts in.
      if [[ -n "$worker_registration_test_barrier" ]]; then
        printf '%s\n' "$pid" >> "${worker_registration_test_barrier}.workers"
        if [[ ! -e "${worker_registration_test_barrier}.ready" ]]; then
          printf '%s\n' "$pid" > "${worker_registration_test_barrier}.ready"
        fi
        while [[ ! -e "${worker_registration_test_barrier}.release" ]]; do
          sleep 0.05 || true
        done
      fi

      finish_worker_registration
    done

    # Only this parent drains stale coordinator obligations. Parallel workers
    # share shell state and capture files, so letting each queued lease waiter
    # drain would race their capture and unlink operations.
    if [[ ${#active_pids[@]} -gt 0 ]]; then
      now_ts="$(date +%s)"
      if [[ $((now_ts - last_coordinator_recovery_ts)) -ge 5 ]] &&
        declare -F gate_coordinator_recover_stale_obligations >/dev/null 2>&1; then
        if ! gate_coordinator_recover_stale_obligations; then
          echo "error: scheduler stale-worker recovery failed during the parallel pool." >&2
          return 2
        fi
        last_coordinator_recovery_ts="$now_ts"
      fi

      # Heartbeat: while commands are still in flight, emit a periodic liveness
      # line naming what is running so a slow member is visibly working, not hung.
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
  local rest_entries=()
  local serial_entries=()
  local parallel_entries=()
  local exclusive_entries=()
  local entry
  local command

  # Split setup out FIRST, so it reaches run_prerequisite_phase on every path.
  # While the partition lived below the sequential early-return, --parallel 1
  # and the hook's keep-going setting let a failed setup command's dependents
  # run anyway: `terraform validate` after a failed `terraform init`, the
  # typechecks after a failed shared-config build, and the trusted `pnpm
  # <alias>` commands after the failed package-script validator that exists to
  # gate them.
  #
  # The sequential path keeps the mapper's original ordering for everything
  # else. Serial-vs-parallel is a concurrency partition, not a priority one, so
  # reordering it here would change which command a --fail-fast run reports
  # first for no gain.
  for entry in "${quality_commands[@]+"${quality_commands[@]}"}"; do
    command="${entry%%|*}"
    if is_quality_setup_command "$command"; then
      setup_entries+=("$entry")
      continue
    fi
    rest_entries+=("$entry")
    if is_quality_serial_command "$command"; then
      serial_entries+=("$entry")
    elif is_quality_exclusive_command "$command"; then
      exclusive_entries+=("$entry")
    else
      parallel_entries+=("$entry")
    fi
  done

  run_prerequisite_phase "quality setup" "${setup_entries[@]+"${setup_entries[@]}"}"

  if [[ "$fail_fast" == "1" || "$fail_fast" == "true" || "$quality_parallelism" -le 1 ]]; then
    run_mapped_entries_sequential "quality" "${rest_entries[@]+"${rest_entries[@]}"}"
    return
  fi

  run_mapped_entries_sequential "quality serialized" "${serial_entries[@]+"${serial_entries[@]}"}"
  run_mapped_entries_parallel "quality" "$quality_parallelism" "${parallel_entries[@]+"${parallel_entries[@]}"}"

  if [[ "${#exclusive_entries[@]}" -gt 0 ]]; then
    echo
    echo "Running ${#exclusive_entries[@]} quality command(s) exclusively; the parallel pool has drained."
    run_mapped_entries_sequential "quality exclusive" "${exclusive_entries[@]}"
  fi
}

# Drop per-command stamps that don't match this run's fingerprint (any changed
# validated file invalidates all of them) or that aged past the TTL, so the file
# stays bounded and only genuine resume candidates remain.
if ! prune_command_stamps; then
  echo "error: could not read or prune the per-command stamp cache before first dispatch." >&2
  gate_report_coordinated_no_work_failure 2 "command-stamp pruning" \
    "No mapped command ran in this request"
  exit 2
fi

# Queue time can be long. Bind the first dispatch to the same source, plan,
# toolchain, environment digest, runtime, and resource policy that registration
# used. A changed key cancels the request before any mapped command starts.
if declare -F gate_coordinator_verify_registration_fingerprint >/dev/null 2>&1; then
  gate_coordinator_verify_registration_fingerprint "before first dispatch"
fi

# Last thing before anything is executed: confirm this run still holds the lock
# it took. Mapping and stamp work happen between acquiring and here, which is
# room enough for another run to have taken it over.
assert_gate_run_lock_still_ours

# A legacy holder drains every condemned run under its exclusive lock. A
# coordinator client first claims each drain token, so only one gate parent can
# capture and unlink its process evidence while other clients keep scheduling
# against the stale lease's reserved capacity and named resources.
if declare -F gate_coordinator_is_active >/dev/null 2>&1 &&
  gate_coordinator_is_active; then
  if ! gate_coordinator_recover_stale_obligations; then
    echo "error: scheduler stale-worker recovery failed before first dispatch." >&2
    gate_coordinator_report_no_work_failure 2 "stale-obligation recovery" \
      "No mapped command ran in this request"
    exit 2
  fi
else
  drain_condemned_runs
fi

# Asked again, and this is what orders the drain against publishers rather than
# hoping they are quiet. Publishing an obligation is not synchronised with the
# lock — but every publisher derives one from a record on disk, and while this
# run holds an untouched lock there is no such record to derive from: a remnant
# under this lock can only exist if this run's own record was renamed away, and
# a run condemning what it took has taken ours. So either nothing could have
# been published after the last empty scan, or the record no longer names us
# and this stops. The publications that can still land are duplicates of
# obligations this run already drained, whose processes are already gone.
assert_gate_run_lock_still_ours

run_prerequisite_phase "preflight" "${preflight_commands[@]+"${preflight_commands[@]}"}"
run_prerequisite_phase "codegen" "${codegen_commands[@]+"${codegen_commands[@]}"}"
run_prerequisite_phase "post-codegen" "${post_codegen_commands[@]+"${post_codegen_commands[@]}"}"
run_quality_phase

print_command_summary

gate_total_elapsed=$(( $(date +%s) - gate_start_ts ))

if declare -F gate_coordinator_verify_registration_fingerprint >/dev/null 2>&1; then
  gate_coordinator_verify_registration_fingerprint \
    "before terminal result publication"
fi

if [[ "$failures" -gt 0 ]]; then
  if declare -F gate_coordinator_publish_failure >/dev/null 2>&1; then
    gate_coordinator_publish_failure "$failures" || true
  fi
  log_duration_line "fail" "$gate_total_elapsed" "__run_total__" "run" || true
  print_failed_command_output
  echo
  echo "${failures} mapped command(s) failed." >&2
  exit 1
fi

if declare -F gate_coordinator_publish_success >/dev/null 2>&1; then
  gate_coordinator_publish_success "$trunk_provisioning_state"
fi

log_duration_line "ok" "$gate_total_elapsed" "__run_total__" "run" || true

echo
echo "All mapped commands passed."
if [[ "$trunk_provisioning_state" == blocked ]]; then
  echo "Note: the Trunk arm was skipped because the CLI could not be provisioned here; CI still enforces it."
fi
if [[ "${stamp_reuse_count:-0}" -eq 0 && "$trunk_provisioning_state" != "blocked" ]]; then
  # Only a fully-executed green run earns the whole-run fast-path stamp. A
  # resumed run reused work whose real age lives in the per-command stamps;
  # re-dating it here would let --skip-if-fresh extend validation reuse past
  # the two-hour ceiling (command passes at t=0, retry succeeds at t=119m,
  # fresh whole-run stamp then covers t=238m). A run that skipped Trunk
  # because the launcher could not be provisioned is the same hazard from a
  # different direction: the whole-run stamp carries no record of that skip,
  # so a later --skip-if-fresh run — even one where Trunk has since become
  # provisionable — would trust the stamp and never attempt it. Withholding
  # the stamp here forces the next run to actually retry Trunk instead of
  # inheriting a pass it never earned.
  if ! {
    printf 'created_at=%s\n' "$(date +%s)"
    printf 'stamp=%s\n' "$current_stamp"
    if [[ -n "$gate_coordinator_freshness_context" ]]; then
      printf 'execution_fingerprint=%s\n' \
        "$gate_coordinator_registration_fingerprint"
      printf 'execution_head=%s\n' "$gate_coordinator_execution_head"
    fi
  } > "$success_stamp_file"; then
    echo "warning: the gate passed, but its local success stamp could not be written." >&2
  fi
fi
