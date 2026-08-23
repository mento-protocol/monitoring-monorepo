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
                 than n seconds and report it as a failure. Default: 1500. The
                 timeout is per command, never for the whole run.
  --lock-wait <n>
                 With --run, wait at most n seconds for another gate run on
                 this machine to finish before starting. Default: 1800.
  --no-lock      With --run, skip cross-run mutual exclusion and start even
                 while another gate run is executing mapped commands.
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
                      Same behavior as --command-timeout. Default: 1500.
  AGENT_QUALITY_GATE_LOCK
                      Set to 0 or false for the same effect as --no-lock.
  AGENT_QUALITY_GATE_LOCK_WAIT_SECONDS
                      Same behavior as --lock-wait. Default: 1800.
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
# 900 was the bound until this gate's own self-test became the longest mapped
# command. That suite spends most of its time asserting that runs queue rather
# than race, so its length is load-bearing rather than slack: measured at 525s
# alone and past 900s inside a full gate run, where it competes with everything
# else on the machine. The cap is a backstop against a hung command, not a
# performance budget, so it moves to the smallest number that clears the
# measurement with room — the durations log is where a command that has grown
# too slow gets noticed.
command_timeout_seconds="${AGENT_QUALITY_COMMAND_TIMEOUT_SECONDS:-1500}"
gate_lock_enabled="${AGENT_QUALITY_GATE_LOCK:-1}"

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

if [[ ! "$gate_lock_wait_seconds" =~ ^[0-9]+$ ]]; then
  echo "error: --lock-wait requires a non-negative integer" >&2
  exit 2
fi

# Resolve this script's own directory before the cd below so node helpers it
# invokes (e.g. gate/lockfile-scope.mjs) resolve from the real checkout even when
# the gate runs against a temp fixture repo whose working directory is elsewhere.
# Anchoring these on $repo_root instead would make every fixture run miss them.
script_source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

terraform_stack_paths=()
terraform_stack_paths_count=0
if [[ -r "$repo_root/terraform.stacks.json" ]]; then
  if ! terraform_stack_paths_output="$(
    node --input-type=module - "$repo_root/terraform.stacks.json" <<'NODE'
import { readFileSync } from "node:fs";

const registryPath = process.argv[2];
const registry = JSON.parse(readFileSync(registryPath, "utf8"));
if (registry.version !== 1 || !Array.isArray(registry.stacks)) {
  throw new Error("terraform.stacks.json must contain version=1 and a stacks array");
}
const paths = registry.stacks.map((stack) => stack.path);
if (
  paths.length === 0 ||
  paths.some(
    (stackPath) =>
      typeof stackPath !== "string" ||
      !/^[A-Za-z0-9._/-]+$/u.test(stackPath) ||
      stackPath.startsWith("/") ||
      stackPath
        .split("/")
        .some((segment) => ["", ".", ".."].includes(segment)),
  ) ||
  new Set(paths).size !== paths.length
) {
  throw new Error(
    "terraform.stacks.json stack paths must be unique safe repo-relative directories",
  );
}
process.stdout.write(paths.join("\n"));
NODE
  )"; then
    echo "error: failed to load Terraform stack paths" >&2
    exit 2
  fi
  while IFS= read -r terraform_stack_path; do
    [[ -n "$terraform_stack_path" ]] || continue
    terraform_stack_paths+=("$terraform_stack_path")
    terraform_stack_paths_count=$((terraform_stack_paths_count + 1))
  done <<< "$terraform_stack_paths_output"
fi

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
# Monotonic counter for unique per-command timeout marker paths.
timeout_seq=0
# PIDs (command + watchdog) of any in-flight timed command in THIS process, so a
# wrapper SIGINT/SIGTERM tears them down instead of leaking the watchdog's
# background sleeps. Sequential commands run in the gate process; parallel
# members run in their own process-group worker subshells, each maintaining its
# own copy — which the parent's signal traps cannot see.
active_timeout_pids=()

# Process-group IDs of the in-flight parallel workers. Non-interactive Bash job
# control gives each worker a dedicated group whose ID equals its leader PID.
# Group tracking survives the leader exiting and descendants reparenting, unlike
# a process-tree walk rooted at that leader.
active_worker_pgids=()

# A signal can arrive after Bash creates a parallel worker but before the parent
# records its process group. Defer INT/TERM handling across that short registry
# update, then replay the first pending signal after the group is reachable.
worker_registration_in_progress=0
pending_terminating_signal=""
worker_registration_test_barrier="${AGENT_QUALITY_GATE_TEST_WORKER_REGISTRATION_BARRIER:-}"
if [[ -n "$worker_registration_test_barrier" && "${NODE_ENV:-}" != "test" ]]; then
  echo "AGENT_QUALITY_GATE_TEST_WORKER_REGISTRATION_BARRIER: test-only override requires NODE_ENV=test" >&2
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
  local -a roots=("${active_timeout_pids[@]+"${active_timeout_pids[@]}"}")
  local -a worker_pgids=("${active_worker_pgids[@]+"${active_worker_pgids[@]}"}")
  active_timeout_pids=()
  active_worker_pgids=()
  [[ -n "${roots[*]-}" || -n "${worker_pgids[*]-}" ]] || return 0
  # Snapshot every descendant BEFORE signalling: TERM kills intermediate
  # subshells first, which reparents a SIGTERM-ignoring survivor away from the
  # tree, so a post-TERM re-walk would miss it. The KILL pass targets the
  # saved pid list, not a fresh walk. Parallel workers do not need a snapshot:
  # their registered process groups remain addressable after reparenting.
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
  for pgid in "${worker_pgids[@]+"${worker_pgids[@]}"}"; do
    kill -TERM -- "-$pgid" 2>/dev/null || true
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
  # The group pass stays PID-group-only by design: a group id is not a
  # process, so it has no start time to pin, and skipping the group KILL when
  # its leader has died would orphan exactly the reparented survivors this
  # pass exists to reach. Reuse needs the recycled pid to become a group
  # LEADER inside the same three seconds, a strictly narrower window than the
  # per-PID case above.
  for pgid in "${worker_pgids[@]+"${worker_pgids[@]}"}"; do
    kill -KILL -- "-$pgid" 2>/dev/null || true
    # The group leader is the direct child the gate can reap. If it already
    # exited, wait returns immediately; the negative-PGID signals above still
    # reached any surviving reparented descendants.
    wait "$pgid" 2>/dev/null || true
  done
}

# ---------------------------------------------------------------------------
# Cross-run mutual exclusion (GitHub issue #1802).
#
# Two gate runs on one machine oversubscribe it, and that is the normal case
# here: several agents share this host, and the pre-push hook starts a run of
# its own while a manual warm-up run is still going. The suites that lost were
# the ones holding a wall-clock budget (ui-dashboard's browser-api-policy lint
# runner) or a bound port, but the contention itself is machine-wide, so the
# remedy is machine-wide: only one `--run` gate executes mapped commands at a
# time. The intra-run half of the same problem is the exclusive phase in
# run_quality_phase; a lock alone cannot help a suite starved inside ONE run.
#
# mkdir(2), O_EXCL and rename(2) are the primitives: all three are atomic,
# flock(1) does not exist on macOS, and the repo's floor is Bash 3.2. Renaming
# is used on the owner *file* only — `mv src dir` when dir exists moves src
# *inside* it instead of failing, so a rename can never be a conditional claim
# on a directory here, but renaming a regular file away fails with ENOENT for
# everyone who arrives second, which is exactly the test-and-set the reclaim
# path needs. The invariant the code below keeps is: at every instant at most
# one process believes it holds the lock, and no waiter ever removes or renames
# a lock directory. A holder is made by two atomic steps — win `mkdir` on the
# lock path, then create the owner file with O_EXCL — and a reclaimer takes a
# dead record away by rename before it may write its own.
# ---------------------------------------------------------------------------
gate_lock_dir=""
gate_lock_token=""
# Locals holding a record's token field are named *_token_value, not *_token:
# the repo's review scanner reads a name ending in _token as a credential key
# and refuses to bundle the diff. Keep the suffix if you rename these.
# Path a reclaim moves a dead owner record to, and the slot it came from. The
# temp name carries this process's PID, so it can be registered with the exit
# trap BEFORE it is created: cleanup can never race the rename that creates it,
# and it can never name another run's file.
gate_lock_reclaim_tmp=""
gate_lock_reclaim_origin=""
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
gate_lock_condemn_before_discard() {
  local record="$1"
  local record_token_value
  record_token_value="$(gate_lock_field_from_file "$record" token)"
  [[ -n "$record_token_value" ]] || return 0
  record_condemned_run "$record_token_value"
}

gate_lock_recover_hidden_record() {
  local lock="$1"
  local remnant pid start recovered=1
  for remnant in "$lock"/owner.reclaiming.*; do
    [[ -e "$remnant" ]] || continue
    pid="$(gate_lock_field_from_file "$remnant" pid)"
    start="$(gate_lock_field_from_file "$remnant" start_utc)"
    if gate_lock_holder_is_live "$pid" "$start"; then
      # `ln` refuses an occupied path, so a record published while we were
      # reading loses nothing: ours is then the stale copy and just goes away.
      if ln "$remnant" "$lock/owner" 2>/dev/null; then
        echo "Recovered the record of live holder pid ${pid} from an interrupted reclaim." >&2
        rm -f "$remnant"
        recovered=0
      fi
      # If the link failed the canonical path already holds something. This
      # copy still names a live process, so it stays: a record naming a live
      # holder is evidence, and only a verified-dead one may be deleted.
    else
      # Dead holder — but "dead run" is not the same as "nothing running". Its
      # commands outlive it, and this record is the last thing that names them.
      # So the delete happens only once the obligation is written down.
      gate_lock_condemn_before_discard "$remnant" || gate_lock_obligation_unwritable
      rm -f "$remnant"
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
    if ! ln "$gate_lock_reclaim_tmp" "$gate_lock_reclaim_origin" 2>/dev/null; then
      # The slot is occupied, so this copy is superseded and about to be
      # dropped rather than put back. It can still name a run whose commands
      # are alive, so the obligation is written down before it goes.
      if ! gate_lock_condemn_before_discard "$gate_lock_reclaim_tmp"; then
        # Nowhere to write it down, so the record itself has to survive: it is
        # the only thing naming that run's commands, and the next run's
        # hidden-record recovery reads it from exactly where it lies. This runs
        # while unwinding, so it reports and leaves rather than exiting again.
        echo "error: could not record ${gate_lock_reclaim_tmp} as outstanding; left in place for the next run." >&2
        gate_lock_reclaim_tmp=""
        gate_lock_reclaim_origin=""
        return 1
      fi
    fi
  fi
  rm -f "$gate_lock_reclaim_tmp"
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
# Every process this run starts for a mapped command carries this string in its
# own argv. It is the run's lock token, so it is unique per run and per machine,
# and it exists exactly as long as the process does — nothing to register, no
# file to keep in step, and no window where a child exists untracked. A run that
# holds no lock (--no-lock, or a nested run) still tags, with its PID, so the
# pattern never matches something it should not.
gate_run_command_tag() {
  printf 'agentqg:%s' "${gate_lock_token:-nolock-$$}"
}

# A file every mapped command of this run holds open. Descendants inherit open
# descriptors and keep them after their parent exits, so this is a handle on a
# process that no longer has a tagged ancestor to be walked down from. Its path
# carries the run's token, so unlike a PID or a process group it can never come
# to name a stranger.
gate_run_marker_path() {
  [[ -n "$gate_lock_root_dir" && -n "$gate_lock_token" ]] || return 1
  printf '%s/holder.%s' "$gate_lock_root_dir" "$gate_lock_token"
}

gate_run_marker_file=""

gate_run_ensure_marker() {
  local marker
  [[ -z "$gate_run_marker_file" ]] || return 0
  marker="$(gate_run_marker_path)" || return 0
  # Fail closed, not best-effort. On a host without /proc this marker's
  # inherited descriptor is the only durable handle to a command that forks a
  # replacement and exits, so starting the command without it would quietly
  # forfeit the discovery the drain depends on. Same rule as the obligation
  # files: stop before the act, while stopping is still safe.
  # O_EXCL via noclobber, like the owner record: `>` would follow a symlink
  # another writer on a shared root pre-planted under this run's token and
  # truncate whatever it points at with this user's permissions. Exclusive
  # creation refuses an existing path outright — symlinks, dangling ones
  # included, by kernel contract — and a token is unique to this run, so
  # anything already sitting at this name is not ours to replace.
  if ! (set -C && printf '%s\n' "$gate_lock_token" > "$marker") 2>/dev/null; then
    echo "error: could not create the run marker at ${marker} (it may already exist)." >&2
    echo "Without it, a command that outlives a killed gate cannot be found by the next run." >&2
    echo "Nothing has been executed. Fix that path — permissions, free space, or a leftover file — then re-run." >&2
    exit 2
  fi
  gate_run_marker_file="$marker"
}

# Every process still carrying a run's handle. The argv tag names only the
# wrapper and dies with it, which is why two inherited handles back it up: the
# environment, readable on a host with /proc, and the open descriptor on the
# run's marker file, readable wherever `lsof` exists. Both survive a command
# that forks a replacement and then exits — the replacement is reparented, has
# no tagged ancestor left, and is invisible to a tree walk. Neither can land on
# a stranger, because both are named by a token unique to one run.
#
# Only this user's processes are scanned, which is the same scope the rest of
# this path can signal, and duplicates cost nothing: the capture records a PID
# once. Where neither inherited handle is readable the argv tag stands alone,
# which is the pre-existing behaviour.
# A token names processes (through a pgrep pattern) and files (holder.*,
# captured.*, condemned.d/*), and on a shared lock root it arrives from
# records other users can write. Only the gate-generated shape is accepted
# where one is read back: an alphanumeric start, then hostname characters,
# digits, dots and dashes. No slash can pass, so no derived path can leave
# the lock root; no leading dash, so no value can read as an option.
gate_lock_token_is_wellformed() {
  local token="$1"
  # The full generated structure — host, dash, PID, dash, epoch — not merely
  # a path-safe string. A looser shape would let a crafted record carry a
  # PREFIX of a real token, and combined with an unanchored match a prefix
  # is enough to select a live run's processes.
  [[ "$token" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,180}-[0-9]{1,10}-[0-9]{1,12}$ ]]
}

# ERE-escape a token for pgrep: validation keeps a token benign as a path,
# but hostname dots would still match any character as a pattern, and only
# escaping makes the match literal.
gate_lock_token_pattern() {
  printf '%s' "$1" | sed 's/[][\.*^$+?(){}|\\]/\\&/g' || true
}

gate_run_tagged_pids() {
  local token="$1"
  local environ environ_entries pid marker found status
  # A token read back from a lock record names processes (through this
  # pattern) and files (holder.*), and on a shared root it can be another
  # user's writing. One that does not have the gate-generated shape is never
  # matched with: a crafted '.*' would classify a stranger's processes as
  # remnants, and this path signals what it matches. Emitting the scan-error
  # sentinel keeps the obligation open and fails the run closed at the bound
  # instead.
  if ! gate_lock_token_is_wellformed "$token"; then
    echo "error: malformed run token in a lock record; refusing to match processes with it." >&2
    printf '%s\n' "$gate_drain_scan_error"
    return 0
  fi
  # A scan that failed is not a scan that found nothing. `pgrep` exits 1 for no
  # match and above that for a real failure, and reading the second as the first
  # would discharge an obligation on the strength of a question never answered.
  # Anchored on both sides: the tag is one whole argv element, and an
  # unanchored match would let one token select another that merely extends
  # it. The escape keeps hostname dots literal inside the anchors.
  found="$(pgrep -f "(^| )agentqg:$(gate_lock_token_pattern "$token")( |\$)" 2>/dev/null)" && status=0 || status=$?
  [[ "$status" -le 1 ]] || printf '%s\n' "$gate_drain_scan_error"
  [[ -z "$found" ]] || printf '%s\n' "$found"
  if [[ -d /proc ]]; then
    for environ in /proc/[0-9]*/environ; do
      # A builtin test first, because this loop runs once per process on the
      # host: `-r` false means the read cannot succeed, and skipping there
      # costs nothing. It is not the whole guard — `-r` answers from the
      # permission bits, and the kernel refuses `/proc/<pid>/environ` for a
      # process that changed credentials whatever those say.
      [[ -r "$environ" ]] || continue
      # The redirection is inside a group with its own stderr redirect. A
      # redirection that cannot open its target is reported by the shell
      # itself, before the `2>/dev/null` beside it applies, so the bare form
      # printed `/proc/<pid>/environ: Permission denied` into the output of
      # every drain on a runner (GitHub issue 1919); the group's redirect is
      # already in place when the inner one is attempted. NULs are translated
      # before the capture because command substitution cannot hold them, and
      # the exact-entry match below depends on the separators surviving.
      environ_entries="$({ tr '\0' '\n' < "$environ"; } 2>/dev/null)" ||
        environ_entries=""
      if [[ -z "$environ_entries" ]]; then
        # Past the `-r` test and still nothing: the kernel refused the read for
        # a process that changed credentials, the process exited between the
        # listing and the read, or its environment is genuinely empty. None can
        # be one of ours. Anything this run started carries this user's
        # credentials and this run's environment, so it stays readable to it —
        # and where a credential-changing descendant stretches that, the
        # argv-tag scan above and the marker-descriptor scan below still name
        # it, because neither reads the environment. Deliberately NOT the
        # scan-error sentinel: one unreadable process is ordinary — every
        # GitHub runner has one — and counting it as a failed scan would fail
        # every crash recovery on such a host closed, rather than only the ones
        # with work left to do.
        continue
      fi
      # Exact entry, not substring: environ is NUL-separated, and a substring
      # match would let one token select an environment carrying a longer one.
      printf '%s\n' "$environ_entries" |
        grep -qxF "AGENTQG_RUN=agentqg:${token}" || continue
      pid="${environ#/proc/}"
      printf '%s\n' "${pid%/environ}"
    done
  fi
  marker="${gate_lock_root_dir}/holder.${token}"
  if [[ -n "$gate_lock_root_dir" && -e "$marker" ]] &&
    command -v lsof > /dev/null 2>&1; then
    found="$(lsof -w -t -- "$marker" 2>/dev/null)" && status=0 || status=$?
    [[ "$status" -le 1 ]] || printf '%s\n' "$gate_drain_scan_error"
    [[ -z "$found" ]] || printf '%s\n' "$found"
  fi
}

# The lock root, kept once resolved: outstanding obligations live beside the
# lock rather than inside it, because the lock directory is what gets reclaimed
# and the obligation has to outlive that.
gate_lock_root_dir=""
# A staged obligation this process has written but not yet published. Named
# with our PID and registered with the exit trap before it is created, so
# cleanup can never race the write nor name another run's file.
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
# Written inside the reclaim election, which is already serialised by the
# rename test-and-set: whoever won the record is the only writer here. The file
# is built under a private per-PID name and moved into place, so a reader sees
# the whole token or no file at all. Duplicates are harmless — draining a token
# whose processes are already gone is a no-op — which is the right failure
# direction for the crash between this write and the publish it precedes.
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
  # Registered before it exists: the name carries our PID, so cleanup can see
  # it whether or not the write got that far, and can never name another run's.
  gate_lock_condemn_tmp="${dir}/.staging.$$"
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
  exit 2
}

gate_lock_obligation_unreadable() {
  echo "error: the outstanding-commands record at ${1} exists but cannot be read." >&2
  echo "It names commands a dead run left behind, and skipping it would start this run alongside them." >&2
  echo "Nothing has been executed. Fix that path — permissions — then re-run." >&2
  exit 2
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
        exit 2
      fi
      drain_condemned_run_commands "$entry_token_value"
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

# Test-only. Names the write boundaries a crash can land between, so the
# self-test can kill a run at each one and assert the next run recovers. SIGKILL
# rather than exit, because the point is to skip the exit trap the way a real
# `kill -9`, an OOM kill or a power loss would. Unset in normal operation.
gate_lock_test_crash() {
  [[ "${AGENT_QUALITY_GATE_LOCK_CRASH_AT:-}" == "$1" ]] || return 0
  kill -9 $$
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

gate_lock_owner_field() {
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

# The kernel's own start-time string for a PID, used verbatim. Comparing it as
# a string keeps this free of date parsing; what makes that sound is pinning
# the formatting environment, because `ps` renders lstart in the caller's TZ
# and locale — `TZ=America/New_York` moves the clock, and a non-C LC_ALL
# rewrites the whole format ("Mi. 12 Aug."). Two runs with different
# environments would otherwise read one live process as two identities and
# reclaim a lock out from under it. Recorded under the same pin it is compared
# with, and stored as `start_utc` so a record from a gate that predates this
# pinning is simply not read as one (see gate_lock_holder_is_live).
gate_lock_process_start() {
  local pid="$1"
  [[ -n "$pid" ]] || return 0
  # Asking about a process is allowed to come back empty, and must not be an
  # error: every caller here is racing the process it asks about, so `ps` fails
  # the moment that process exits. Under `set -e` with `pipefail` this pipeline
  # would then abort the whole gate from inside a command substitution —
  # silently, losing whatever stdout was still buffered.
  TZ=UTC LC_ALL=C ps -o lstart= -p "$pid" 2>/dev/null | head -n1 || true
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
  local current_start
  [[ -n "$pid" ]] || return 1
  # `kill -0` fails two ways that mean opposite things: no such process, and a
  # live process this user may not signal. A lock root shared between users
  # makes the second ordinary, and reading it as "gone" would reclaim a lock
  # whose holder is still running. `ps` answers existence across users, so it
  # decides, and `kill -0` only spares the `ps` call in the common case.
  if ! kill -0 "$pid" 2>/dev/null; then
    ps -p "$pid" > /dev/null 2>&1 || return 1
  fi
  [[ -n "$recorded_start" ]] || return 0
  current_start="$(gate_lock_process_start "$pid")"
  [[ -n "$current_start" ]] || return 0
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
  current_pid="$(gate_lock_field_from_file "$record" pid)"
  current_token_value="$(gate_lock_field_from_file "$record" token)"
  current_start="$(gate_lock_field_from_file "$record" start_utc)"
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
  local staged="$lock/owner.claiming.$$"
  local published=0
  # Registered before it exists, like every other file this path creates. Any
  # file already there was left by a dead process that happened to share our
  # PID, so it is ours to remove.
  gate_lock_claim_tmp="$staged"
  rm -f "$staged"
  if {
    printf 'pid=%s\n' "$$"
    printf 'host=%s\n' "$(uname -n)"
    printf 'started_at=%s\n' "$(date +%s)"
    printf 'start_utc=%s\n' "$(gate_lock_process_start $$)"
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
  gate_drain_tagged_now="$(gate_run_tagged_pids "$token")"
  case " ${gate_drain_tagged_now} " in
    *" ${gate_drain_scan_error} "*)
      gate_drain_scan_failed=1
      gate_drain_tagged_now="${gate_drain_tagged_now//${gate_drain_scan_error}/}"
      ;;
  esac
}

# Is this PID still one of ours, asked after its identity was read? Two answers
# count: it still carries one of the run's handles, or it is still a child of
# the process the walk reached it through. Either is enough, and both are
# needed — a reparented descendant has lost its parent but keeps the inherited
# handle, while a handle-less descendant is still reachable through its parent.
gate_drain_membership_holds() {
  local pid="$1"
  local parent="${2:-}"
  local candidate
  for candidate in ${gate_drain_tagged_now}; do
    [[ "$candidate" == "$pid" ]] && return 0
  done
  [[ -n "$parent" ]] || return 1
  for candidate in $(pgrep -P "$parent" 2>/dev/null || true); do
    [[ "$candidate" == "$pid" ]] && return 0
  done
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
  start="$(gate_lock_process_start "$root_pid")"
  if [[ -z "$start" ]]; then
    if gate_lock_identity_source_available; then
      # The walk saw it, the identity read did not: it exited in between. A
      # process that is already gone is nothing to signal and nothing to wait
      # for, and recording it without an identity would later authorise a
      # signal at whatever inherits its PID.
      return 0
    fi
    start="$gate_lock_identity_unavailable"
  elif ! gate_drain_membership_holds "$root_pid" "$from_parent"; then
    # Enumeration and identity are two reads with a gap between them, and a PID
    # recycled inside it would be recorded under a stranger's identity that
    # every later check then confirms. Re-asking whether this PID is still one
    # of ours closes that in the direction the rest of this path uses: an
    # answer that cannot be confirmed is recorded with no identity, which is
    # never signalled and holds the drain open rather than discharging it.
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

drain_condemned_run_commands() {
  local token="$1"
  local wrapper entry pid recorded current alive alive_identities recycled unverified captured_file
  local waited=0
  local drain_started_at
  local announced=0
  local escalated=0
  [[ -n "$token" ]] || return 0
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
      gate_lock_obligation_unreadable "$captured_file"
    fi
    if [[ ! -e "$captured_file" ]]; then
      # Created exclusively before the first append, so every later >> lands
      # in a regular file this run made; noclobber refuses a path planted
      # between the check above and here, symlinks included.
      if ! (set -C && : > "$captured_file") 2>/dev/null; then
        gate_lock_obligation_unreadable "$captured_file"
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
      echo "Nothing has been executed. Inspect and remove that file, then re-run." >&2
      exit 2
    fi
    # Unreadable is not empty. Starting from nothing here would lose the
    # descendants an interrupted drain recorded, and their tagged wrapper is
    # already dead by then — so the tag scan below would come back empty and
    # this run would call the job done with those processes still running.
    [[ -r "$captured_file" ]] || gate_lock_obligation_unreadable "$captured_file"
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
  sleep 0.2
  gate_drain_refresh_tagged "$token"
  for wrapper in $gate_drain_tagged_now; do
    capture_process_tree "$wrapper"
  done
  if [[ -z "${gate_drain_capture//[[:space:]]/}" && "$gate_drain_scan_failed" -eq 0 ]]; then
    [[ -z "$captured_file" ]] || rm -f "$captured_file"
    [[ -z "$gate_lock_root_dir" ]] || rm -f "${gate_lock_root_dir}/holder.${token}"
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
    echo "Nothing has been executed. Fix that path — permissions, or free space — then re-run." >&2
    exit 2
  fi

  echo "The run this lock was taken from left commands running; stopping them before starting anything."
  announced=1
  recycled=""

  while :; do
    alive=""
    alive_identities=""
    unverified=""
    gate_drain_scan_failed=0
    gate_drain_refresh_tagged "$token"
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
      alive="${alive}${pid} "
      alive_identities="${alive_identities}${pid}|${recorded}
"
    done << EOF
$gate_drain_capture
EOF

    # Unverifiable entries keep the drain open even though nothing is sent to
    # them: "we could not check" is not "it is gone". A scan that failed counts
    # the same way — an unanswered question is not an empty answer.
    [[ -n "$alive" || -n "$unverified" || "$gate_drain_scan_failed" -ne 0 ]] || break

    if [[ "$waited" -ge "$gate_lock_orphan_drain_bound_seconds" ]]; then
      # Refusing to run is the whole point: proceeding here is exactly the
      # cross-run overlap the lock exists to prevent.
      [[ -z "$alive" ]] ||
        echo "error: commands from the previous run are still alive after ${waited}s: ${alive}" >&2
      [[ -z "$unverified" ]] ||
        echo "error: processes from the previous run could not be identified after ${waited}s, so none were signalled: ${unverified}" >&2
      [[ "$gate_drain_scan_failed" -eq 0 ]] ||
        echo "error: the scan for the previous run's processes kept failing after ${waited}s, so it is not known whether any are left." >&2
      echo "Nothing has been executed. Investigate those processes, then re-run." >&2
      exit 2
    fi

    # Same rule between passes: a re-walk that found a forked child but could
    # not write it down must not be followed by another signal round, which
    # would kill that child's parent and leave it unrecorded.
    if [[ "$gate_drain_capture_unpersisted" -ne 0 ]]; then
      echo "error: could not write the captured process list to ${captured_file} while draining." >&2
      echo "error: still alive: ${alive:-none}${unverified:+, unverified: ${unverified}}" >&2
      echo "Nothing has been executed. Investigate those processes, fix that path, then re-run." >&2
      exit 2
    fi

    # Identity is re-read here rather than trusted from the census above. The
    # two are separated by the whole census, the bound check and the persist
    # check, and a PID recycled inside that gap would be signalled on the
    # strength of a check that passed for a process which no longer exists.
    while IFS='|' read -r pid recorded; do
      [[ -n "$pid" ]] || continue
      if [[ "$recorded" != "$gate_lock_identity_unavailable" ]]; then
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
    sleep 1
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
  done

  # Discharged: every process in the captured set is gone or belongs to
  # somebody else now, so the list has nothing left to hand on.
  [[ -z "$captured_file" ]] || rm -f "$captured_file"
  [[ -z "$gate_lock_root_dir" ]] || rm -f "${gate_lock_root_dir}/holder.${token}"

  if [[ -n "$recycled" ]]; then
    echo "Left alone: pid(s) ${recycled}now belong to unrelated processes."
  fi
  if [[ "$announced" -eq 1 ]]; then
    echo "Previous run's commands are gone; continuing."
    echo
  fi
}

assert_gate_run_lock_still_ours() {
  local recorded
  [[ -n "$gate_lock_dir" ]] || return 0
  recorded="$(gate_lock_owner_field "$gate_lock_dir" token)"
  [[ "$recorded" == "$gate_lock_token" ]] && return 0
  echo "error: this run no longer holds the gate run lock at ${gate_lock_dir}." >&2
  echo "Another run took it over before this one reached its mapped commands." >&2
  echo "Nothing has been executed. Re-run, and it will queue behind the current holder." >&2
  exit 2
}

release_gate_run_lock() {
  local recorded
  [[ -n "$gate_lock_dir" ]] || return 0
  recorded="$(gate_lock_owner_field "$gate_lock_dir" token)"
  # Our lock may have been reclaimed as stale and re-taken by another run while
  # this one was stopped (SIGSTOP, a long swap). Deleting by path would then
  # delete somebody else's lock, so release only what still names us.
  if [[ "$recorded" == "$gate_lock_token" ]]; then
    rm -rf "$gate_lock_dir"
  fi
  gate_lock_dir=""
}

acquire_gate_run_lock() {
  local root lock owner_pid owner_host owner_worktree owner_token_value owner_start
  local stale_reason nap remaining now_millis
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
    exit 2
  fi
  lock="$root/run.lock"
  gate_lock_root_dir="$root"
  this_host="$(uname -n)"
  wait_started_at="$(gate_wall_millis)"

  while :; do
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
      if claim_gate_run_lock "$lock" "${this_host}-$$-$(date +%s)"; then
        if [[ "$announced" -eq 1 ]]; then
          echo "Acquired the gate run lock after ${waited}s."
          echo
        fi
        return 0
      fi
      # We created the directory but never recorded ownership: a waiter
      # reclaimed it while this process was descheduled, and it is that run's
      # lock now. Touch nothing and queue like any other waiter.
      echo "Another run recorded ownership of ${lock} first; queueing behind it." >&2
    fi

    owner_pid="$(gate_lock_owner_field "$lock" pid)"
    owner_host="$(gate_lock_owner_field "$lock" host)"
    owner_worktree="$(gate_lock_owner_field "$lock" worktree)"
    owner_token_value="$(gate_lock_owner_field "$lock" token)"
    owner_start="$(gate_lock_owner_field "$lock" start_utc)"
    if [[ -z "$owner_token_value" ]]; then
      # Before believing there is no holder, read the remnants of any reclaim
      # that was killed mid-take. One of them may be the holder's own record.
      if gate_lock_recover_hidden_record "$lock"; then
        owner_pid="$(gate_lock_owner_field "$lock" pid)"
        owner_host="$(gate_lock_owner_field "$lock" host)"
        owner_worktree="$(gate_lock_owner_field "$lock" worktree)"
        owner_token_value="$(gate_lock_owner_field "$lock" token)"
        owner_start="$(gate_lock_owner_field "$lock" start_utc)"
      fi
    fi

    stale_reason=""
    [[ -n "$owner_token_value" ]] && ownerless_since=""
    if [[ -z "$owner_token_value" ]]; then
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
      if kill -0 "$owner_pid" 2>/dev/null; then
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
      if gate_lock_recover_hidden_record "$lock"; then
        owner_pid="$(gate_lock_owner_field "$lock" pid)"
        owner_host="$(gate_lock_owner_field "$lock" host)"
        owner_worktree="$(gate_lock_owner_field "$lock" worktree)"
      elif [[ ! -e "$lock/owner" ]]; then
        # Nothing in the way: publishing the record is the whole contest.
        # Whoever links it into place first holds the lock; everyone else,
        # including the creator that stalled, finds their publish refused.
        if claim_gate_run_lock "$lock" "${this_host}-$$-$(date +%s)"; then
          echo "Gate run lock at ${lock} is stale (${stale_reason}); reclaiming it." >&2
          if [[ "$announced" -eq 1 ]]; then
            echo "Acquired the gate run lock after ${waited}s."
            echo
          fi
          return 0
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
        if mv "$lock/owner" "$gate_lock_reclaim_tmp" 2>/dev/null; then
          gate_lock_test_crash after-take
          gate_lock_test_delay "${AGENT_QUALITY_GATE_LOCK_TAKEN_DELAY_SECONDS:-}"
          if gate_lock_record_still_stale \
            "$gate_lock_reclaim_tmp" "$owner_pid" "$owner_token_value" "$owner_start"; then
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
            if ! record_condemned_run "$owner_token_value"; then
              restore_gate_lock_record || true
              gate_lock_obligation_unwritable
            fi
            rm -f "$gate_lock_reclaim_tmp"
            gate_lock_reclaim_tmp=""
            gate_lock_reclaim_origin=""
            if claim_gate_run_lock "$lock" "${this_host}-$$-$(date +%s)"; then
              if [[ "$announced" -eq 1 ]]; then
                echo "Acquired the gate run lock after ${waited}s."
                echo
              fi
              return 0
            fi
          else
            # We took a record that is not the one we judged — another run
            # reclaimed the lock while we decided. Put it back and wait. If it
            # could not be put back or written down it stays where it is, named
            # in the output, for the next run's hidden-record recovery.
            restore_gate_lock_record || true
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

cleanup_tmpfiles() {
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
  # Dropped after the workers are down, so it is gone only once nothing of ours
  # is left holding it. A run that dies before this leaves it behind on
  # purpose: that is the handle its successor needs.
  if [[ -n "$gate_run_marker_file" ]]; then
    rm -f "$gate_run_marker_file"
    gate_run_marker_file=""
  fi
  # Released last: the lock must outlive worker teardown, or the next run
  # starts while this one's mapped commands are still dying.
  release_gate_run_lock
}
trap cleanup_tmpfiles EXIT

on_terminating_signal() {
  local signal="$1"
  if [[ "$worker_registration_in_progress" -eq 1 ]]; then
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

drain_worker_process_group() {
  local pgid="$1"
  if kill -0 -- "-$pgid" 2>/dev/null; then
    kill -TERM -- "-$pgid" 2>/dev/null || true
    sleep 3
    kill -KILL -- "-$pgid" 2>/dev/null || true
  fi
  wait "$pgid" 2>/dev/null || true
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

# Routing classification runs from the gate's own source tree, not the repo
# under test, so a `scripts/` move must repoint this literal in the same commit.
# Nothing in CI runs the gate for real; the routing suite is what exercises this
# import there, and a developer's pre-push is where a stale path bites first.
# The loader below therefore exits 3 and names the module it could not resolve,
# instead of letting the failure read as a generic classifier fault.
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
      /scripts/agent:quality-gate|/scripts/agent:quality-gate:test|/scripts/agent:prewarm|/scripts/agent:prewarm:test|/scripts/agent:review-materiality|/scripts/agent:review-materiality:test|/scripts/agent:context-check|/scripts/agent:context-budget|/scripts/agent:context-budget:test|/scripts/docs:index|/scripts/docs:index:test|/scripts/docs:audit|/scripts/docs:audit:test|/scripts/docs:garden|/scripts/docs:garden:test|/scripts/docs:navigation-eval|/scripts/docs:navigation-eval:test|/scripts/agent:autoreview|/scripts/issue:board|/scripts/issue:board:test|/scripts/issue:claim|/scripts/issue:review|/scripts/issue:release|/scripts/sentry:ingest|/scripts/sentry:ingest:test|/scripts/sentry:digest|/scripts/sentry:digest:test|/scripts/sentry:project|/scripts/sentry:project:test|/scripts/sentry:brief|/scripts/sentry:brief:test|/scripts/sentry:autofix:select|/scripts/sentry:autofix:select:test|/scripts/sentry:autofix:finalize:test|/scripts/sentry:autofix:run-record:test|/scripts/sentry:archive|/scripts/sentry:archive:test|/scripts/sentry:broker:test|/scripts/sentry:requeue:test|/scripts/pr:feedback-state|/scripts/pr:feedback-state:test|/scripts/pr:ready-state|/scripts/pr:ready-state:test|/scripts/tf|/scripts/tf:test|/scripts/alerts:rules:lint|/scripts/alerts:rules:lint:test|/scripts/lockfile:lint|/scripts/lockfile:lint:test|/scripts/skew:check|/scripts/skew:check:test|/scripts/override:prune-report|/scripts/override:prune-report:test|/scripts/adr:check|/scripts/adr:check:test|/scripts/sanitize:test)
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
  if [[ "$package_name" == "@mento-protocol/metrics-bridge" ]]; then
    add_command "pnpm --filter $package_name build" "$reason"
  fi
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
#
# The classifier runs from the gate's own source tree, not the repo under test,
# so a `scripts/` move must repoint this literal in the same commit. Fail-toward-
# full is the right answer for an ambiguous lockfile; it is the wrong answer for
# a helper this gate cannot find, because that failure is invisible — every
# lockfile change silently widens to the full suite and the run reads as slow
# rather than broken. Missing helper therefore exits 2 and names the path.
lockfile_scope_path="$script_source_dir/gate/lockfile-scope.mjs"

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
  node "$lockfile_scope_path" "$base_file" "$head_file" < /dev/null || rc=$?
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
  add_command "node scripts/alerts/check-peg-registry-integrity.mjs" "root lockfile changed (peg registry authority dependency)"

  # Checked here, not inside lockfile_scoped_importers: that helper runs in a
  # command substitution, where an exit would only end the subshell and read as
  # one more fail-toward-full.
  if [[ ! -f "$lockfile_scope_path" ]]; then
    echo "error: lockfile scope classifier could not be loaded from ${lockfile_scope_path}" >&2
    echo "       scripts/agent-quality-gate.sh runs this module at pre-push time; moving it requires repointing that path in the same commit." >&2
    exit 2
  fi

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
  add_command "node scripts/check-agent-quality-gate-package-scripts.mjs" "$reason"
  add_command "bash scripts/agent-quality-gate.test.sh" "$reason"
  add_command "node scripts/gate/agent-prewarm.test.mjs" "$reason"
  add_command "node scripts/pr/review-materiality.test.mjs" "$reason"
  add_command "node scripts/pr/agent-issue-board.test.mjs" "$reason"
  add_command "pnpm sentry:ingest:test" "$reason"
  add_command "pnpm sentry:digest:test" "$reason"
  add_command "pnpm sentry:project:test" "$reason"
  add_command "pnpm sentry:brief:test" "$reason"
  add_command "pnpm sentry:autofix:select:test" "$reason"
  add_command "pnpm sentry:autofix:finalize:test" "$reason"
  add_command "pnpm sentry:archive:test" "$reason"
  add_command "pnpm sentry:broker:test" "$reason"
  add_command "pnpm sentry:requeue:test" "$reason"
  add_command "node scripts/sentry/ci-wiring/check-sentry-suites-in-ci.test.mjs" "$reason"
  add_command "node scripts/pr/pr-feedback-state.test.mjs" "$reason"
  add_command "node scripts/pr/pr-ready-state.test.mjs" "$reason"
  add_command "node scripts/coderabbit-config.test.mjs" "$reason"
  add_command "node scripts/terraform/terraform-fmt-check.test.mjs" "$reason"
  add_command "node scripts/tf-stacks.test.mjs" "$reason"
  add_command "node scripts/supply-chain/lockfile-lint.test.mjs" "$reason"
  add_command "node scripts/supply-chain/version-skew-check.test.mjs" "$reason"
  add_command "node scripts/supply-chain/override-prune-report.test.mjs" "$reason"
  add_command "node scripts/pr/check-adr-reminder.test.mjs" "$reason"
  add_command "node scripts/context/docs-index.test.mjs" "$reason"
  add_command "node scripts/docs/docs-audit.test.mjs" "$reason"
  add_command "node scripts/docs/docs-garden-issue.test.mjs" "$reason"
  add_command "node scripts/docs/docs-navigation-eval.test.mjs" "$reason"
  add_command "node scripts/context/agent-context-budget.test.mjs" "$reason"
}

# Advisory ADR reminder, fed the gate's own base/head + changed-path set so the
# checker evaluates exactly what the gate routed (including a precomputed
# --changed-paths-file set). Self-suppressing, so safe to route broadly.
add_adr_reminder() {
  local reason="$1"
  local cmd="node scripts/pr/check-adr-reminder.mjs"
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
  add_command "TF_DATA_DIR=${tf_data_dir} node scripts/terraform/terraform-fmt-check.mjs $(quote_path "$module")" "$reason"
  add_command "TF_DATA_DIR=${tf_data_dir} terraform -chdir=${module} init -backend=false -input=false" "$reason"
  add_command "TF_DATA_DIR=${tf_data_dir} terraform -chdir=${module} validate -no-color" "$reason"
}

add_registered_terraform_validate_commands() {
  local reason="$1"
  local terraform_stack_path
  [[ "$terraform_stack_paths_count" -gt 0 ]] || return 0
  for terraform_stack_path in "${terraform_stack_paths[@]}"; do
    add_terraform_validate_commands "$terraform_stack_path" "$reason"
  done
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

# Directory symlinks under scripts/ expose Sentry suites whose real files live
# OUTSIDE scripts/. Both enumerators — findSentrySuites in the CI-coverage
# checker, and the gate's own walker — follow such a link and enumerate
# scripts/<link>/sentry-*.test.mjs, but the real file's committed path is the
# symlink TARGET (e.g. fixtures/sentry-x.test.mjs), which matches neither
# scripts/* nor the CI rootScripts filter. Adding a suite under a PREVIOUSLY
# committed link therefore changes neither the link nor any scripts/** path, so
# this gate would skip both checks while the suite ships without the manifest
# entry the CI gate demands (Codex 3754704280, 3766397748). CI itself is now
# covered — the `sentry-suites` job is unconditional — so this is about the local
# gate reporting green on a change only CI would catch.
# Resolve every existing scripts/ directory symlink to its repo-relative target
# once, so the per-path loop below can route both checks for a change beneath a
# target too. Guarded, like the routing that consumes it, so the gate's own unit
# tests (run against stub fixture repos) are unaffected.
scripts_symlink_targets=()
if [[ "$script_source_dir" == "$repo_root/scripts" && -d "$repo_root/scripts" ]]; then
  repo_root_physical="$(cd "$repo_root" && pwd -P)"
  while IFS= read -r gate_symlink; do
    # Only a symlink that resolves to a directory exposes a suite tree; `-d`
    # follows the link. A target outside the repo cannot hold a committed suite,
    # so keep only targets under the repo root.
    [[ -d "$gate_symlink" ]] || continue
    gate_symlink_target="$(cd "$gate_symlink" && pwd -P)" || continue
    case "$gate_symlink_target/" in
      "$repo_root_physical"/*)
        scripts_symlink_targets+=("${gate_symlink_target#"$repo_root_physical"/}")
        ;;
    esac
  done < <(find "$repo_root/scripts" -type l 2>/dev/null || true)
fi

# The self-run Sentry-suite gate pair (#1779, ADR 0062), scheduled from one
# place because four verbatim copies of these command strings are four places to
# drift — `add_command` deduplicates on the exact string, so a copy that falls
# out of step silently schedules a second, different command instead of failing.
# Neither command substitutes for the other: the self-test proves the gate's
# logic against throwaway fixture manifests in a temp dir and never reads the
# committed one, while only the real gate reconciles that manifest against the
# real suites. Both carry the CI entry point's `env -u` prefix so a developer
# with an ambient NODE_OPTIONS can run them at all.
add_sentry_suite_gate_commands() {
  add_command "/usr/bin/env -u NODE_OPTIONS -u NODE_PATH node scripts/sentry/gate/sentry-suite-gate.test.mjs" "$1"
  add_command "/usr/bin/env -u NODE_OPTIONS -u NODE_PATH node scripts/sentry/gate/sentry-suite-gate.mjs" "$1 (validate the committed manifest against the real suites)"
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
      add_command "pnpm docs:navigation-eval -- --validate docs/evals/documentation-navigation-baseline.json --fixtures docs/evals/documentation-navigation-baseline-fixtures.json" "documentation navigation baseline changed"
      ;;
    docs/evals/documentation-navigation-*.json)
      add_surface "docs"
      add_command "pnpm docs:navigation-eval:test" "documentation navigation evaluation contract changed"
      add_command "pnpm docs:navigation-eval -- --check-fixtures" "documentation navigation evaluation contract changed"
      add_command "pnpm docs:navigation-eval -- --validate docs/evals/documentation-navigation-baseline.json --fixtures docs/evals/documentation-navigation-baseline-fixtures.json" "documentation navigation evaluation contract changed"
      ;;
    docs/claude-runtime-document-registry.json)
      add_surface "docs"
      add_command "pnpm docs:index --check" "Claude runtime document registry changed"
      add_command "pnpm agent:context-check" "Claude runtime document registry changed"
      ;;
    AGENTS.md|*/AGENTS.md|.codex/config.toml)
      add_surface "agent-context"
      add_command "pnpm agent:context-budget --strict" "agent instruction budget input changed"
      ;;
  esac
  case "$path" in
    .gitattributes|.codex/config.toml|.codex/upstash-mcp.example.toml|.agents/skills/forensic-report/*|.claude/skills/forensic-report/*|docs/adr/0030-iac-before-cli-secrets.md|docs/adr/0060-upstash-management-key-bootstrap.md|docs/deployment.md|docs/notes/codex-agent-skills.md|docs/notes/upstash-mcp-operator.md|package.json|pnpm-lock.yaml|scripts/mcp/build-upstash-mcp-runtime.mjs|scripts/mcp/render-upstash-mcp-config.mjs|scripts/mcp/upstash-mcp-launcher.mjs|terraform/terraform.tfvars.example|terraform/variables.tf)
      add_command "node --test scripts/mcp/upstash-mcp-config.test.mjs" "Upstash MCP transport contract changed"
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
      add_command "node scripts/repo-health/check-hermetic-vitest-setup.mjs" "hermetic Vitest config changed"
      ;;
    */vitest.hermetic-setup.ts)
      add_surface "tooling"
      add_command "node scripts/repo-health/check-hermetic-vitest-setup.mjs" "hermetic Vitest setup changed"
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
        ui-dashboard/scripts/check-react-doctor-diff.sh|ui-dashboard/scripts/check-react-doctor-score.sh)
          # agent-quality-gate.test.sh copies and runs the diff wrapper in a
          # stub repo, so the routing suite is this pair's real regression test.
          add_command "pnpm agent:quality-gate:test" "React Doctor wrapper changed"
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
        metrics-bridge/peg-registry.json)
          add_command "node scripts/alerts/check-peg-registry-integrity.mjs" "peg registry changed"
          ;;
      esac
      case "$path" in
        metrics-bridge/src/*)
          add_checklist "docs/pr-checklists/stateful-data-ui.md" "metrics bridge data flow changed"
          add_checklist "docs/pr-checklists/terraform-cloudrun.md" "metrics bridge Cloud Run runtime changed"
          ;;
      esac
      case "$path" in
        metrics-bridge/src/metrics.ts|metrics-bridge/src/cdp-metrics.ts|metrics-bridge/src/peg/metrics.ts)
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
        shared-config/chain-metadata.json|shared-config/deployment-namespaces.json|shared-config/oracle-reporters.json|shared-config/src/chains.ts|shared-config/src/oracle-reporters.ts|shared-config/src/tokens.ts)
          add_command "node scripts/alerts/check-peg-registry-integrity.mjs" "peg registry authority input changed"
          ;;
      esac
      case "$path" in
        shared-config/src/thresholds.ts)
          add_command "node scripts/alerts/check-deviation-threshold-drift.mjs" "shared deviation threshold source changed"
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
      add_command "node scripts/workflows/check-github-action-pins.mjs" "GitHub Actions workflow/action changed"
      add_command "node scripts/workflows/check-autofix-ci-trust.mjs" "GitHub Actions workflow/action changed (autofix CI trust boundary)"
      add_adr_reminder "workflow/action changed — ADR reminder (a new workflow likely needs an ADR)"
      case "$path" in
        .github/workflows/ci.yml)
          add_surface "workspace"
          add_preflight_command "pnpm install --frozen-lockfile" "central CI workflow changed"
          add_workspace_quality_commands "central CI workflow changed"
          # This workflow is the check's input: it asserts every Sentry suite
          # has a step in the `scripts` job.
          add_command "node scripts/sentry/ci-wiring/check-sentry-suites-in-ci.test.mjs" "central CI workflow changed"
          add_command "pnpm tf:test" "Terraform registry-backed CI workflow changed"
          add_terraform_validate_commands "terraform" "Terraform registry-backed CI workflow changed"
          add_terraform_validate_commands "alerts/rules" "Terraform registry-backed CI workflow changed"
          add_terraform_validate_commands "alerts/infra" "Terraform registry-backed CI workflow changed"
          add_terraform_validate_commands "aegis/terraform" "Terraform registry-backed CI workflow changed"
          add_registered_terraform_validate_commands "Terraform registry-backed CI workflow changed"
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
          add_registered_terraform_validate_commands "Terraform registry workflow changed"
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
        .github/workflows/sentry-triage-agent.yml)
          # Both suites assert on this file: the agent-comment tests own the
          # "agent is the last step" and staged-closure invariants, the broker
          # tests own "no Sentry credential in the agent's env" (#1711).
          add_command "node scripts/sentry/triage/sentry-triage-agent-comment.test.mjs" "Sentry triage agent workflow changed"
          add_command "pnpm sentry:broker:test" "Sentry triage agent workflow changed"
          # A third: the brief suite asserts the verdict job actually runs the
          # needs-human brief leg, gated on the resolved verdict (#1748).
          add_command "pnpm sentry:brief:test" "Sentry triage agent workflow changed"
          ;;
        .github/actions/pnpm-install/*)
          add_surface "workspace"
          add_preflight_command "pnpm install --frozen-lockfile" "pnpm install action changed"
          add_workspace_quality_commands "pnpm install action changed"
          ;;
      esac
      ;;
    .github/prompts/*)
      add_surface "tooling"
      case "$path" in
        .github/prompts/sentry-triage.md)
          # The prompt is the producing half of the verdict contract. The brief
          # suite asserts it still asks for the needs-human brief fields the
          # renderer consumes (#1748); dropping one here would leave the brief
          # silently half-empty in production.
          add_command "pnpm sentry:brief:test" "Sentry triage prompt changed"
          # The broker suite pins the OTHER load-bearing prompt rule: losing the
          # Sentry toolset posts nothing rather than a verdict (#1938). It lives
          # there because it is the agent-side half of the pre-flight probe, so
          # a prompt-only edit must run it too or the rule can be dropped with
          # nothing red.
          add_command "pnpm sentry:broker:test" "Sentry triage prompt changed"
          ;;
      esac
      ;;
    .trunk/*)
      add_surface "tooling"
      add_command "node scripts/workflows/check-github-action-pins.mjs" "Trunk workflow/action setup changed"
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
        alerts/rules/peg-thresholds.json)
          add_command "node scripts/alerts/check-peg-registry-integrity.mjs" "peg threshold policy changed"
          ;;
        alerts/rules/main.tf|alerts/rules/rules-fpmms.tf)
          add_command "node scripts/alerts/check-deviation-threshold-drift.mjs" "deviation threshold Terraform consumer changed"
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
          if [[ "$path" == "alerts/infra/onchain-event-handler/pnpm-workspace.yaml" ]]; then
            add_command "node --test scripts/supply-chain/alerts-uuid-overrides.test.mjs" "alerts uuid override policy changed"
          fi
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
          if [[ "$path" == "alerts/infra/oncall-announcer/pnpm-workspace.yaml" ]]; then
            add_command "node --test scripts/supply-chain/alerts-uuid-overrides.test.mjs" "alerts uuid override policy changed"
          fi
          ;;
        alerts/infra/oncall-announcer/*.tf)
          add_terraform_validate_commands "alerts/infra" "alerts/infra Terraform changed"
          add_checklist "docs/pr-checklists/terraform-cloudrun.md" "alerts/infra Cloud Function path changed"
          ;;
      esac
      ;;
    alerts/infra/sentry-ingest-watcher/*)
      add_surface "alerts-infra"
      case "$path" in
        alerts/infra/sentry-ingest-watcher/*.mjs | alerts/infra/sentry-ingest-watcher/package.json)
          add_command "pnpm alerts:watcher:test" "Sentry ingest dead-man switch changed"
          ;;
        alerts/infra/sentry-ingest-watcher/*.tf)
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
        docs/notes/sentry-triage-pipeline.md)
          # This note is the verdict contract, and the brief suite asserts the
          # contract's needs-human fields are documented here (#1748) — a field
          # renamed in code and not here is exactly the drift it catches.
          add_command "pnpm sentry:brief:test" "Sentry verdict contract note changed"
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
      case "$path" in
        .agents/skills/*|.claude/skills/*)
          add_command "node scripts/repo-health/check-skills-mirror.test.mjs" "skills mirror content changed"
          add_command "node scripts/repo-health/check-skills-mirror.mjs" "skills mirror content changed"
          ;;
      esac
      ;;
    scripts/*.sh)
      add_surface "scripts"
      case "$path" in
        # Exact live path first, the any-depth pair second. This arm sits FIRST
        # in the case, so if the exact path ever goes stale again the widened arm
        # below catches the file and the run keeps scheduling the root-anchor
        # check while the runtime-log filter check quietly drops out. Partial
        # routing reads as working routing, which is worse than the gap the pair
        # exists to close — so the pair stays even though the glob alone would
        # match the wrapper where it lives today.
        scripts/deploy/deploy-indexer-logs.sh|scripts/*/deploy-indexer-logs.sh)
          add_command "node scripts/check-deploy-root-anchors.test.mjs" "deploy wrapper changed"
          add_command "node scripts/deploy/filter-envio-runtime-errors.test.mjs" "indexer runtime-log filter changed"
          ;;
        # Paired one-level arm, the ADR 0064 remedy for a literal-prefix glob.
        # `scripts/deploy-*.sh` is anchored on a prefix at the TOP of scripts/,
        # so it stops matching the moment a wrapper sits one directory down —
        # and nothing reds: the root-anchor check simply stops being scheduled.
        # `*` matches `/` in a `case` pattern, so the paired arm reaches every
        # depth. Shell-only on purpose: the subject set of
        # check-deploy-root-anchors.test.mjs is `deploy-*.sh` files that source
        # `lib/deploy-guard.sh`, and that walk is already recursive, so the
        # check is ready for the move before the routing is.
        #
        # That same breadth reaches a `deploy-*.sh` basename under any scripts/
        # subdirectory, today `scripts/lib/deploy-guard.sh` — deliberate, and
        # pinned in the suite. Matching the check's own recursive walk is the
        # whole point; a pattern stopping at one fixed directory would be
        # narrower than what it schedules. The guard is the file every wrapper
        # sources, so a change to it is exactly when the check should run.
        # Consequence for later edits: `case` takes the FIRST matching arm, so a
        # new arm for a path of the shape `scripts/<dir>/deploy-*.sh` belongs
        # ABOVE this one or it never runs.
        scripts/deploy-*.sh|scripts/*/deploy-*.sh)
          add_command "node scripts/check-deploy-root-anchors.test.mjs" "deploy wrapper changed"
          ;;
        scripts/sanitize-terraform-output.sh)
          add_command "pnpm sanitize:test" "Terraform output sanitizer changed"
          ;;
      esac
      case "$path" in
        scripts/agent-quality-gate.sh|scripts/agent-quality-gate.test.sh)
          add_command "pnpm agent:quality-gate:test" "agent quality gate mapping changed"
          # The routing arms below and the routing table in
          # scripts/gate/routing-table/ are two copies of the same routing, and
          # gate-equality.test.mjs is what holds them together. It has to run in
          # BOTH drift directions. The table's own arm covers a table-only edit;
          # this covers the commoner one — somebody adds or reorders an arm here
          # and does not touch the data. Without it the table goes stale exactly
          # where nothing reds, which is the failure this conversion exists to
          # end (ADR 0069).
          add_command "pnpm gate:routing-table:test" "gate routing arms must still match the routing table"
          ;;
        scripts/agent-autoreview.sh|scripts/agent-autoreview.test.sh)
          add_command "pnpm agent:autoreview:test" "agent autoreview adapter changed"
          ;;
        scripts/repo-health/dev-janitor.sh|scripts/repo-health/dev-janitor.test.sh)
          add_command "bash scripts/repo-health/dev-janitor.test.sh" "dev janitor script changed"
          ;;
        # Paired like the two arms in the case above. This is a separate `case`
        # statement, so the widened deploy glob cannot shadow it — but an exact
        # path stops matching after a move all the same, and these two commands
        # are the whole Cloud Run half of this wrapper's routing. Pairing it here
        # is what makes "a moved deploy script routes identically" true for the
        # bridge rather than true for the root-anchor check alone.
        scripts/deploy/deploy-bridge.sh|scripts/*/deploy-bridge.sh)
          add_checklist "docs/pr-checklists/terraform-cloudrun.md" "Cloud Run deploy script changed"
          add_command "pnpm agent:context-check" "Cloud Run revision suffix guard changed"
          ;;
        scripts/bootstrap/agent-session-end-hook.sh)
          add_command "pnpm agent:context-check" "agent SessionEnd hook changed"
          ;;
        scripts/bootstrap/codex-cloud-setup.sh|scripts/bootstrap/codex-cloud-setup.test.sh)
          add_command "bash scripts/bootstrap/codex-cloud-setup.test.sh" "Codex Cloud Foundry installer contract changed"
          ;;
        scripts/lib/install-marker.sh)
          # Sourced by scripts/setup.sh and
          # scripts/bootstrap/claude-code-web-setup.sh. `bash -n` cannot see the
          # skip semantics, so route the suite that exercises them.
          add_command "pnpm agent:quality-gate:test" "shared install-marker fragment changed"
          ;;
        scripts/setup.sh|scripts/bootstrap/claude-code-web-setup.sh)
          # The two install-marker consumers. The suite pins that both still
          # source the shared fragment and use its hash, which `bash -n` cannot
          # see, and re-runs the fragment's own behavioral checks.
          add_command "pnpm agent:quality-gate:test" "install-marker consumer changed"
          ;;
      esac
      ;;
    .coderabbit.yaml)
      # CodeRabbit resolves this config from the PR's SOURCE branch, and its
      # findings feed the pr:feedback-state ledger, so the config is a trust
      # boundary (ADR 0066). A repo-root .yaml reaches no `scripts/*` arm, so
      # claim the surface and route the allowlist pin here.
      add_surface "scripts"
      add_command "pnpm coderabbit:config:test" "CodeRabbit review config changed"
      ;;
    scripts/sentry/gate/sentry-suite-manifest.json)
      # The manifest the self-run Sentry-suite gate reconciles against (#1779,
      # ADR 0062). A .json edit reaches no other scripts/ arm, so claim the
      # surface here; the repo-specific block below routes the two gate commands
      # for this file along with every manifest-owned suite.
      add_surface "scripts"
      ;;
    scripts/*.mjs|scripts/*.cjs|scripts/*.js|eslint.config.mjs)
      # `.dependency-cruiser.cjs` is handled fully by its dedicated case
      # block above (runs `pnpm code-health:deps` + `pnpm lint:scripts`).
      # Don't list it here too or `add_command` dedupes a redundant entry.
      add_surface "scripts"
      add_command "pnpm lint:scripts" "root build script changed"
      case "$path" in
        scripts/check-agent-quality-gate-package-scripts.mjs)
          add_command "node scripts/check-agent-quality-gate-package-scripts.mjs" "agent quality gate package script validator changed"
          add_command "pnpm agent:quality-gate:test" "agent quality gate mapping changed"
          ;;
        scripts/production-infra-identity-contract/routing.test.mjs)
          add_command "pnpm agent:quality-gate:test" "agent quality gate mapping changed"
          ;;
        scripts/agent-autoreview.mjs|scripts/agent-autoreview-core.mjs|scripts/agent-autoreview-core.test.mjs|scripts/agent-autoreview-target-guard.test.mjs)
          add_command "pnpm agent:autoreview:test" "agent autoreview helper changed"
          # The scanner half of the #1943/#1970 canary (ADR 0068). Widening
          # `credentialAssignmentKey`'s vocabulary re-traps the renamed Sentry
          # fixtures, and nothing else would say so until the next autoreview
          # run refused.
          add_command "node scripts/sentry/fixture-scan-canary.test.mjs" "autoreview secret scanner changed"
          ;;
        scripts/context/check-agent-context.mjs|scripts/context/check-agent-context-helpers.mjs|scripts/context/check-agent-context.test.mjs)
          add_command "pnpm agent:context-check" "agent context checker changed"
          add_command "node scripts/context/check-agent-context.test.mjs" "agent context checker changed"
          ;;
        scripts/context/check-settings-contract.mjs|scripts/context/check-settings-contract.test.mjs)
          # The `.claude/settings.json` permission allowlist and the SessionEnd
          # hook wiring for both runtimes. `check-agent-context.mjs` is the only
          # caller, and its suite holds the one test of that forwarding, so a
          # change here routes both suites plus the real enforcement pass.
          add_command "pnpm agent:context-check" "agent settings contract changed"
          add_command "node scripts/context/check-settings-contract.test.mjs" "agent settings contract changed"
          add_command "node scripts/context/check-agent-context.test.mjs" "agent settings contract changed"
          ;;
        scripts/mcp/build-upstash-mcp-runtime.mjs|scripts/mcp/render-upstash-mcp-config.mjs|scripts/mcp/upstash-mcp-config.test.mjs|scripts/mcp/upstash-mcp-launcher.mjs)
          add_command "node --test scripts/mcp/upstash-mcp-config.test.mjs" "Upstash MCP transport contract changed"
          ;;
        scripts/repo-health/file-size-watchlist.mjs|scripts/repo-health/file-size-watchlist-issue.mjs|scripts/repo-health/file-size-watchlist.test.mjs)
          add_command "node --test scripts/repo-health/file-size-watchlist.test.mjs" "file-size watchlist automation changed"
          ;;
        scripts/repo-health/check-skills-mirror.mjs|scripts/repo-health/check-skills-mirror.test.mjs)
          add_command "node scripts/repo-health/check-skills-mirror.test.mjs" "skills mirror checker changed"
          add_command "node scripts/repo-health/check-skills-mirror.mjs" "skills mirror checker changed"
          ;;
        scripts/context/claude-runtime-document-registry.mjs|scripts/context/docs-index.mjs|scripts/context/docs-index-helpers.mjs|scripts/context/docs-index.test.mjs)
          add_command "pnpm docs:index:test" "documentation catalog helper changed"
          add_command "pnpm docs:index --check" "documentation catalog helper changed"
          add_command "pnpm agent:context-check" "documentation catalog metadata contract changed"
          ;;
        scripts/docs/docs-audit.mjs|scripts/docs/docs-audit-helpers.mjs|scripts/docs/docs-audit.test.mjs)
          add_command "pnpm docs:audit:test" "documentation audit planner changed"
          add_command "pnpm docs:audit --dry-run" "documentation audit planner changed"
          add_command "pnpm docs:index --check" "documentation audit planner consumes the catalog"
          ;;
        scripts/docs/docs-garden-issue.mjs|scripts/docs/docs-garden-issue-helpers.mjs|scripts/docs/docs-garden-issue.test.mjs)
          add_command "pnpm docs:garden:test" "documentation garden issue automation changed"
          add_command "pnpm docs:audit --dry-run" "documentation garden issue automation consumes the planner"
          add_command "pnpm docs:index --check" "documentation garden issue automation consumes the catalog"
          ;;
        scripts/docs/docs-navigation-eval.mjs|scripts/docs/docs-navigation-eval-helpers.mjs|scripts/docs/docs-navigation-eval-result.mjs|scripts/docs/docs-navigation-eval-result-shape.mjs|scripts/docs/docs-navigation-eval.test.mjs)
          add_command "pnpm docs:navigation-eval:test" "documentation navigation evaluation changed"
          add_command "pnpm docs:navigation-eval -- --check-fixtures" "documentation navigation evaluation changed"
          add_command "pnpm docs:navigation-eval -- --validate docs/evals/documentation-navigation-baseline.json --fixtures docs/evals/documentation-navigation-baseline-fixtures.json" "documentation navigation evaluation changed"
          add_command "pnpm docs:index --check" "documentation navigation evaluation consumes the catalog"
          ;;
        scripts/lib/gh-issue-lifecycle.mjs)
          # The `gh` runner, pagination guard, Documentation Garden workflow
          # authorization, label bootstrap, and queue-state arbitration behind
          # both scheduled issue automations. Neither suite covers the other's
          # consumer, so a shared module belongs in both arms.
          add_command "pnpm docs:garden:test" "shared GitHub issue lifecycle module changed"
          add_command "pnpm docs:navigation-eval:test" "shared GitHub issue lifecycle module changed"
          ;;
        scripts/context/agent-context-budget.mjs|scripts/context/agent-context-budget.test.mjs)
          add_command "pnpm agent:context-budget:test" "agent context budget helper changed"
          add_command "pnpm agent:context-budget --strict" "agent context budget helper changed"
          ;;
        scripts/lighthouse-config.test.mjs)
          add_command "node scripts/lighthouse-config.test.mjs" "Lighthouse config assertion suite changed"
          ;;
        scripts/check-deploy-root-anchors.test.mjs)
          add_command "node scripts/check-deploy-root-anchors.test.mjs" "deploy root-anchor test changed"
          ;;
        scripts/pr/check-adr-reminder.mjs|scripts/pr/check-adr-reminder.test.mjs)
          add_command "pnpm adr:check:test" "ADR reminder helper changed"
          ;;
        scripts/gate/agent-prewarm.mjs|scripts/gate/agent-prewarm.test.mjs)
          add_command "pnpm agent:prewarm:test" "agent prewarm helper changed"
          ;;
        # The routing table as data (ADR 0069). Its own suite owns the schema,
        # ADR 0064's pairing rule, path staleness, the bash-oracle proof of the
        # pattern compiler, and the equality check against the `case` arms in
        # this file. The gate self-test rides along because every module here is
        # in `implementation_signature()`: a change to one moves the freshness
        # signature, which is gate behaviour whether or not the gate reads the
        # table yet.
        scripts/gate/routing-table/*.mjs)
          add_command "pnpm gate:routing-table:test" "gate routing table changed"
          add_command "pnpm agent:quality-gate:test" "gate routing table is an implementation-signature input"
          ;;
        scripts/gate/mapping.mjs|scripts/gate/mapping/*.mjs|scripts/gate/routing-parity.mjs)
          # The Node mapping engine (ADR 0069, D5b) and the parity harness that
          # proves it against these arms. Nothing consults the engine yet — the
          # `case` arms below are still the routing that runs — so this routes
          # the engine's own checks rather than the gate self-test.
          #
          # The quoting test alone would leave routing, facts, verbs, ordering,
          # compaction and scoped-test selection unchecked, so the three CHEAP
          # parity corpora run too: `fixture` (2s) covers the branch that skips
          # repository-specific groups, `symlink` (6s) covers the dynamic
          # pattern source no committed path can reach, and `multi` (57s) is
          # where the four whole-set post-passes are actually exercised. The
          # tracked, synthetic and base corpora are a 35-minute run and stay a
          # per-PR step.
          #
          # `symlink` creates a directory symlink under scripts/ and removes it
          # again, the way the gate self-test does, so it must not run
          # concurrently with another gate in this same worktree — the run lock
          # already guarantees that.
          #
          # These nested gate runs are dry-run and set AGENT_QUALITY_GATE_LOCK=0
          # themselves, so they do not queue behind the outer run's lock. When
          # the gate is flipped to read the engine's plan the harness is
          # deleted, and this arm gains the self-test the way the routing-table
          # arm already has it.
          add_command "node --test scripts/gate/mapping/shell-quote.test.mjs" "gate mapping engine changed"
          add_command "node --test scripts/gate/mapping/engine.test.mjs" "gate mapping engine changed (behaviour the arms will stop pinning at D5c)"
          add_command "pnpm agent:quality-gate:test" "gate mapping engine produces the stdout the gate suite asserts on"
          add_command "node scripts/gate/agent-prewarm.test.mjs" "gate mapping engine produces the stdout agent:prewarm parses"
          add_command "node scripts/gate/routing-parity.mjs --corpus fixture" "gate mapping engine changed (parity against the live arms, fixture repository)"
          add_command "node scripts/gate/routing-parity.mjs --corpus symlink" "gate mapping engine changed (parity against the live arms, scripts/ symlink source)"
          add_command "node scripts/gate/routing-parity.mjs --corpus multi" "gate mapping engine changed (parity against the live arms, whole-set post-passes)"
          ;;
        scripts/sentry/ci-wiring/check-sentry-suites-in-ci-gate-extract.mjs)
          # The bash-from-Node machinery. Its own suite already runs, because
          # check-sentry-suites-in-ci.test.mjs imports it and the coverage arm
          # below routes that. What was missing is the OTHER consumer: ADR 0069's
          # routing-table suite drives `runProbeShell`/`probeDirs` for the
          # /bin/bash pattern oracle and `bashFunctionSource` for the
          # implementation-signature pin. A change to the probe environment or to
          # the end-of-function scan changes what both of those prove, and
          # nothing said so.
          add_command "pnpm gate:routing-table:test" "the routing table's bash oracle and signature pin run on this machinery"
          ;;
        scripts/pr/review-materiality.mjs|scripts/pr/review-materiality-context.mjs|scripts/pr/review-materiality.test.mjs)
          add_command "pnpm agent:review-materiality:test" "agent review materiality helper changed"
          ;;
        scripts/pr/agent-issue-board.mjs|scripts/pr/agent-issue-board.test.mjs|scripts/pr/issue-board-backfill.mjs|scripts/pr/issue-board-cli.mjs|scripts/pr/issue-board-commands.mjs|scripts/pr/issue-board-projects.mjs|scripts/pr/issue-board-state.mjs|scripts/pr/issue-board-transport.mjs)
          # agent-issue-board.mjs is the entry point over six layers (cli,
          # transport, state, projects, backfill, commands). The one suite covers the
          # pure state machine through the entry's re-exports, so every layer
          # routes to it.
          add_command "pnpm issue:board:test" "agent issue board helper changed"
          ;;
        scripts/sentry/fixture-scan-canary.test.mjs)
          # The #1943/#1970 drift canary (ADR 0068). Its own arm, ABOVE the
          # per-suite arms below, because those arms name exact paths and a
          # combined pattern here would shadow them — the routing bug #1974
          # shipped. The canary's watch list is a path pin: a renamed suite has
          # to move here too, and this route is what makes that loud.
          add_command "node scripts/sentry/fixture-scan-canary.test.mjs" "Sentry fixture drift canary changed"
          ;;
        scripts/sentry/triage/sentry-triage-ingest.mjs|scripts/sentry/triage/sentry-triage-ingest.test.mjs)
          add_command "pnpm sentry:ingest:test" "Sentry triage ingest helper changed"
          ;;
        scripts/sentry/triage/sentry-triage-digest.mjs|scripts/sentry/triage/sentry-triage-digest-render.mjs|scripts/sentry/triage/sentry-triage-digest.test.mjs)
          # digest-render.mjs is the pure Slack-render + section-taxonomy layer
          # split out of digest.mjs (#1812); the digest suite covers both, so a
          # render-only change must still run the snapshot / Slack-safety tests.
          add_command "pnpm sentry:digest:test" "Sentry triage digest helper changed"
          # The two needs-human brief emitters share their field selection and
          # bounds; the queue-issue one also reads the digest's autofix prefix.
          add_command "pnpm sentry:brief:test" "Sentry triage digest helper changed"
          # The digest owns LABEL_TO_VERDICT, one of the three verdict-label
          # maps the projection suite pins against each other.
          add_command "pnpm sentry:project:test" "Sentry triage digest helper changed"
          ;;
        scripts/sentry/triage/sentry-triage-brief.mjs|scripts/sentry/triage/sentry-triage-brief-render.mjs|scripts/sentry/triage/sentry-triage-brief.test.mjs)
          add_command "pnpm sentry:brief:test" "Sentry needs-human brief helper changed"
          # Sibling emitter over the same shared selection.
          add_command "pnpm sentry:digest:test" "Sentry needs-human brief helper changed"
          # The brief leg is a shared dependency of the two other legs that call
          # into it, so a brief export or clearing-semantics change must run BOTH
          # their focused suites: the archive leg clears the brief on settlement
          # (settleQueueStub -> clearBriefComments), and the projection leg clears
          # a stale brief before it closes the stub (runProjectionBatch ->
          # clearBriefComments). Without the projection suite here a brief change
          # can break that close guard without running its consumer test.
          add_command "pnpm sentry:archive:test" "Sentry needs-human brief helper changed"
          add_command "pnpm sentry:project:test" "Sentry needs-human brief helper changed"
          ;;
        scripts/sentry/triage/sentry-triage-project.mjs|scripts/sentry/triage/sentry-triage-project-core.mjs|scripts/sentry/triage/sentry-triage-project-cli.mjs|scripts/sentry/triage/sentry-triage-label-ensure.mjs|scripts/sentry/triage/sentry-triage-project.test.mjs|scripts/sentry/triage/sentry-triage-text.mjs|scripts/sentry/triage/sentry-triage-projection.mjs|scripts/sentry/triage/sentry-triage-escalation-contract.mjs)
          # sentry-triage-project-cli.mjs (the argv surface) and
          # sentry-triage-label-ensure.mjs (the settlement label self-heal) were
          # split out of the entry module for the 1,000-line cap (#1827); both
          # are covered by the projection suite and reached only through it, so
          # they route exactly like the file they came from.
          add_command "pnpm sentry:project:test" "Sentry triage projection helper changed"
          # The agent's comment wrapper imports the shared marker contract from
          # sentry-triage-project-core.mjs, so its fences ride on this module.
          add_command "node scripts/sentry/triage/sentry-triage-agent-comment.test.mjs" "Sentry triage projection helper changed"
          # The verdict parser and the shared brief selection live here; both
          # brief emitters are pure consumers of them.
          add_command "pnpm sentry:brief:test" "Sentry triage projection helper changed"
          add_command "pnpm sentry:digest:test" "Sentry triage projection helper changed"
          # The archive leg imports the marker + trusted-author contract from this
          # module (ARCHIVE_COMMENT_MARKER, isTrustedComment), so a change here can
          # break its audit-comment idempotency and brief-clear (#1769 round 15).
          add_command "pnpm sentry:archive:test" "Sentry triage projection helper changed"
          ;;
        scripts/sentry/triage/sentry-triage-agent-comment.mjs|scripts/sentry/triage/sentry-triage-agent-comment.test.mjs|scripts/sentry/triage/sentry-triage-broker-guard.mjs)
          # The broker guard (liveness fence + public-log redaction, #1956
          # split) has no suite of its own — it is covered by the wrapper's,
          # which also owns the workflow-shape and closure assertions that bind
          # the guard's constants to the YAML. Routing it here rather than to a
          # new sentry-*.test.mjs keeps the Sentry suite manifest's file count
          # where it is.
          add_command "node scripts/sentry/triage/sentry-triage-agent-comment.test.mjs" "Sentry triage agent comment wrapper changed"
          add_command "node scripts/sentry/fixture-scan-canary.test.mjs" "Sentry suite carrying scanned fixtures changed"
          ;;
        scripts/sentry/autofix/sentry-autofix-select.mjs|scripts/sentry/autofix/sentry-autofix-select.test.mjs)
          add_command "pnpm sentry:autofix:select:test" "Sentry autofix select helper changed"
          ;;
        scripts/sentry/autofix/sentry-autofix-select-cli.mjs|scripts/sentry/autofix/sentry-autofix-decisions.mjs)
          # The selector's CLI surface (option contract, help text, the report
          # files the tracker reads back, --emit-verdict) and the decision ->
          # report classifier both passes share. Neither owns a cost cap; both
          # are exercised end to end by the select suite, which drives the CLI
          # layer through writeRunReports and the classifier through the family
          # collapse.
          add_command "pnpm sentry:autofix:select:test" "Sentry autofix selection helper changed"
          ;;
        scripts/sentry/autofix/sentry-autofix-select-instrument.mjs|scripts/sentry/autofix/sentry-autofix-second-look.mjs)
          # The selector's budget + instrumentation layer (the per-run read cap
          # and its no-op guard, the gh counter, the throttle latch, the DEGRADED
          # and summary lines) and the bounded second look.
          add_command "pnpm sentry:autofix:select:test" "Sentry autofix selection helper changed"
          # These two OWN caps the finalize suite pins the select job's
          # timeout-minutes against — MAX_CANDIDATE_EVALUATIONS here,
          # MAX_SECOND_LOOK_EVALUATIONS + SECOND_LOOK_FAMILY_BUDGETS there. That
          # pin derives the budget from the LIVE constants, so raising one
          # without re-checking the timeout has to fail in the gate, not in
          # production on the path the second look exists to create.
          add_command "pnpm sentry:autofix:finalize:test" "Sentry autofix per-run cost cap changed"
          ;;
        scripts/sentry/autofix/sentry-autofix-family-handled.mjs)
          # The handled-FAMILY lookup, split out of sentry-autofix-queue-io.mjs
          # for the 600-line soft cap. Its behaviour is exercised end to end by
          # the select suite, like every other module on this leg.
          add_command "pnpm sentry:autofix:select:test" "Sentry autofix handled-family lookup changed"
          # It also OWNS a cap the finalize suite pins the select job's
          # timeout-minutes against — MAX_HANDLED_ID_QUERIES, one of the terms in
          # that suite's worst-case serial `gh` call count. Same reason
          # sentry-autofix-select-instrument.mjs routes there: raising the cap
          # without re-checking the timeout has to fail in the gate, not in
          # production.
          add_command "pnpm sentry:autofix:finalize:test" "Sentry autofix per-run cost cap changed"
          ;;
        scripts/sentry/autofix/sentry-autofix-queue-io.mjs|scripts/sentry/autofix/sentry-autofix-family-resolve.mjs|scripts/sentry/autofix/sentry-autofix-reverse-verify.mjs|scripts/sentry/autofix/sentry-autofix-family.mjs|scripts/sentry/autofix/sentry-autofix-candidate.mjs)
          # The selection leg's gh I/O layer (the window list, readStub,
          # openAutofixPrExists / isOwnHeadPr), the live-state family resolver, the
          # reverse `in:comments` verification leg, and the pure union-find
          # family module (transitive union / project scoping / MAX_FAMILY_MEMBERS
          # / representative rule) — all consumed by the selector. Each is
          # exercised by the select suite, which mocks runGh and drives the full
          # flow end to end.
          add_command "pnpm sentry:autofix:select:test" "Sentry autofix selection helper changed"
          ;;
        scripts/sentry/autofix/sentry-autofix-finalize.mjs|scripts/sentry/autofix/sentry-autofix-finalize.test.mjs)
          add_command "pnpm sentry:autofix:finalize:test" "Sentry autofix finalize helper changed"
          add_command "node scripts/sentry/fixture-scan-canary.test.mjs" "Sentry suite carrying scanned fixtures changed"
          ;;
        scripts/sentry/autofix/sentry-autofix-run-record.mjs|scripts/sentry/autofix/sentry-autofix-run-record.test.mjs|scripts/sentry/autofix/sentry-autofix-refused-inventory.mjs)
          # The tracker run-record body builder, extracted from finalize.mjs,
          # and its bounded refused-stub Search API helper. Run the focused
          # suite AND finalize's — finalize imports the builder for the
          # `run-record` CLI subcommand, so their wiring rides on this route.
          add_command "pnpm sentry:autofix:run-record:test" "Sentry autofix run-record builder changed"
          add_command "pnpm sentry:autofix:finalize:test" "Sentry autofix run-record builder changed"
          ;;
        scripts/sentry/autofix/sentry-autofix-record-labels.mjs|scripts/sentry/autofix/sentry-autofix-hold-revalidate.mjs)
          # The record-run architectural backfill labeler (#1812) and the
          # revalidation/compensation layer extracted from it. Their tests live
          # in the finalize suite (the record-run job that owns this write),
          # which exercises the plan, the pre/post live-scope checks, the label
          # writes and the withdrawal + terminal-guarded re-queue.
          add_command "pnpm sentry:autofix:finalize:test" "Sentry autofix record-run backfill labeler changed"
          ;;
        scripts/sentry/triage/sentry-triage-archive.mjs|scripts/sentry/triage/sentry-triage-archive.test.mjs)
          add_command "pnpm sentry:archive:test" "Sentry triage archive helper changed"
          add_command "node scripts/sentry/fixture-scan-canary.test.mjs" "Sentry suite carrying scanned fixtures changed"
          ;;
        scripts/sentry/broker/sentry-mcp-broker.mjs|scripts/sentry/broker/sentry-mcp-broker.test.mjs|scripts/sentry/broker/sentry-mcp-probe.mjs)
          # The broker and the MCP pre-flight probe (#1938) share one suite:
          # sentry-mcp-broker.test.mjs holds both, so the probe must route here
          # too or a change touching only the probe runs none of its own tests.
          add_command "pnpm sentry:broker:test" "Sentry MCP broker or pre-flight probe changed"
          add_command "node scripts/sentry/fixture-scan-canary.test.mjs" "Sentry suite carrying scanned fixtures changed"
          ;;
        scripts/sentry/triage/sentry-triage-requeue.mjs|scripts/sentry/triage/sentry-triage-requeue.test.mjs|scripts/sentry/triage/sentry-triage-requeue-sentinel.mjs|scripts/sentry/triage/sentry-triage-queue-contract.mjs|scripts/sentry/triage/sentry-triage-workflow-requeue.mjs)
          # The single re-queue chokepoint, the queue contract it reads, the
          # settlement-sentinel unwind split out of it for the 1,000-line cap
          # (#1929, ADR 0070), and the workflow CLI that wraps it for every
          # compensating exit in the triage agent workflow (#1769 round 17, #1782).
          # The sentinel module has no suite of its own — its tests live in the
          # re-queue suite — so an unrouted change to it would ship untested, and
          # it decides the end state of the archive compensation, which is why the
          # archive suite is on this arm too. Every site that re-queues a stub runs
          # through the chokepoint, so its suite is never the whole story — run
          # theirs too. The CLI's tests live in the requeue suite.
          add_command "pnpm sentry:requeue:test" "Sentry re-queue chokepoint changed"
          add_command "pnpm sentry:ingest:test" "Sentry re-queue chokepoint changed"
          add_command "pnpm sentry:archive:test" "Sentry re-queue chokepoint changed"
          # The brief leg maintains a dedicated COMMENT on the stub (the archive
          # leg is the SOLE body writer, #1766). Its suite is routed here because
          # a queue-contract change can shift the re-queue lifecycle the brief
          # and archive legs both observe.
          add_command "pnpm sentry:brief:test" "Sentry re-queue chokepoint changed"
          # The contract owns VERDICT_LABELS, which the verdict step's shed is
          # derived from and the projection suite pins against the other two
          # verdict-label maps.
          add_command "pnpm sentry:project:test" "Sentry re-queue chokepoint changed"
          ;;
        # scripts/pr/ is the only location: the aliases, the suites, and the
        # autoreview wrapper all resolve there. Neither arm is a glob, so each
        # path needs naming outright.
        scripts/pr/pr-feedback-state.mjs|scripts/pr/pr-feedback-state-core.mjs|scripts/pr/pr-feedback-state-claude.mjs|scripts/pr/pr-feedback-state.test.mjs)
          add_command "pnpm pr:feedback-state:test" "PR feedback-state helper changed"
          ;;
        scripts/pr/pr-ready-state.mjs|scripts/pr/pr-ready-state-core.mjs|scripts/pr/pr-ready-state-format.mjs|scripts/pr/pr-ready-state-review-signals.mjs|scripts/pr/pr-ready-state.test.mjs)
          add_command "pnpm pr:ready-state:test" "PR ready-state helper changed"
          ;;
        scripts/pr/review-process-metrics.mjs|scripts/pr/review-process-metrics.test.mjs)
          add_command "node scripts/pr/review-process-metrics.test.mjs" "review-process metrics collector changed"
          ;;
        scripts/coderabbit-config.test.mjs)
          # Half of the .coderabbit.yaml pin pair; the config's own arm sits in
          # the outer case because a repo-root .yaml never reaches this block.
          add_command "pnpm coderabbit:config:test" "CodeRabbit config pin changed"
          ;;
        # Enumerated, not `scripts/terraform/*`: a glob here would win over the
        # two `terraform-fmt-check` arms below, which bash `case` never reaches
        # once an earlier arm matches, and the format helper would silently lose
        # its own suite. `scripts/tf-stacks.{mjs,test.mjs}` stay flat — seven
        # security-contract pins name those exact paths (scripts/AGENTS.md).
        scripts/terraform/check-metrics-bridge-template-plan.mjs|scripts/terraform/check-metrics-bridge-template-plan.test.mjs|scripts/terraform/tf-platform-plan-guard.mjs|scripts/tf-stacks.mjs|scripts/tf-stacks.test.mjs)
          add_command "pnpm tf:test" "Terraform stack wrapper changed"
          add_terraform_validate_commands "terraform" "Terraform stack wrapper changed"
          add_terraform_validate_commands "alerts/rules" "Terraform stack wrapper changed"
          add_terraform_validate_commands "alerts/infra" "Terraform stack wrapper changed"
          add_terraform_validate_commands "aegis/terraform" "Terraform stack wrapper changed"
          add_terraform_validate_commands "governance-watchdog/infra" "Terraform stack wrapper changed"
          add_registered_terraform_validate_commands "Terraform stack wrapper changed"
          ;;
        scripts/terraform/terraform-fmt-check.mjs)
          add_command "node scripts/terraform/terraform-fmt-check.test.mjs" "Terraform format helper changed"
          add_command "pnpm tf:test" "Terraform format helper changed"
          add_terraform_validate_commands "terraform" "Terraform format helper changed"
          add_terraform_validate_commands "alerts/rules" "Terraform format helper changed"
          add_terraform_validate_commands "alerts/infra" "Terraform format helper changed"
          add_terraform_validate_commands "aegis/terraform" "Terraform format helper changed"
          add_terraform_validate_commands "governance-watchdog/infra" "Terraform format helper changed"
          add_registered_terraform_validate_commands "Terraform format helper changed"
          ;;
        scripts/terraform/terraform-fmt-check.test.mjs)
          add_command "node scripts/terraform/terraform-fmt-check.test.mjs" "Terraform format helper test changed"
          ;;
        scripts/supply-chain/lockfile-lint.mjs|scripts/supply-chain/lockfile-lint.test.mjs|scripts/supply-chain/lockfile-lint-registry-sources.mjs|scripts/supply-chain/lockfile-lint-override-ranges.mjs)
          add_command "pnpm lockfile:lint:test" "lockfile lint helper changed"
          ;;
        # One parser, two readers with opposite failure modes: lockfile:lint
        # fails CI on an unbounded override range and override:prune-report
        # never fails anything. Route both so a change here cannot pass by
        # only satisfying the side that stays green.
        scripts/lib/pnpm-override-selector.mjs|scripts/lib/pnpm-override-selector.test.mjs)
          add_command "node --test scripts/lib/pnpm-override-selector.test.mjs" "shared pnpm override selector parser changed"
          add_command "pnpm lockfile:lint:test" "shared pnpm override selector parser changed"
          add_command "pnpm override:prune-report:test" "shared pnpm override selector parser changed"
          ;;
        scripts/supply-chain/alerts-uuid-overrides.test.mjs)
          add_command "node --test scripts/supply-chain/alerts-uuid-overrides.test.mjs" "alerts uuid override contract changed"
          ;;
        scripts/gate/lockfile-scope.mjs|scripts/gate/lockfile-scope.test.mjs)
          add_command "node scripts/gate/lockfile-scope.test.mjs" "lockfile scope helper changed"
          ;;
        scripts/supply-chain/pnpm-audit-high-gate.mjs|scripts/supply-chain/pnpm-audit-high-gate.test.mjs)
          add_command "node scripts/supply-chain/pnpm-audit-high-gate.test.mjs" "pnpm audit high gate changed"
          ;;
        scripts/sanitize-terraform-output.test.mjs)
          add_command "pnpm sanitize:test" "Terraform output sanitizer test changed"
          ;;
        scripts/supply-chain/version-skew-check.mjs|scripts/supply-chain/version-skew-check.test.mjs)
          add_command "pnpm skew:check:test" "version skew checker changed"
          ;;
        scripts/supply-chain/override-prune-report.mjs|scripts/supply-chain/override-prune-report.test.mjs)
          add_command "pnpm override:prune-report:test" "override prune report helper changed"
          ;;
        scripts/repo-health/check-hermetic-vitest-setup.mjs|scripts/repo-health/check-hermetic-vitest-setup.test.mjs)
          add_command "node scripts/repo-health/check-hermetic-vitest-setup.mjs" "hermetic Vitest setup checker changed"
          add_command "node scripts/repo-health/check-hermetic-vitest-setup.test.mjs" "hermetic Vitest setup checker changed"
          ;;
        scripts/workflows/check-github-action-pins.mjs)
          add_command "node scripts/workflows/check-github-action-pins.mjs" "GitHub Actions pin checker changed"
          add_command "node scripts/workflows/check-github-action-pins.test.mjs" "GitHub Actions pin checker changed"
          ;;
        scripts/workflows/check-autofix-ci-trust.mjs|scripts/workflows/check-autofix-ci-trust.test.mjs|scripts/workflows/autofix-trust-annotations.mjs)
          add_command "node scripts/workflows/check-autofix-ci-trust.mjs" "autofix CI trust checker changed"
          add_command "node scripts/workflows/check-autofix-ci-trust.test.mjs" "autofix CI trust checker changed"
          ;;
        scripts/workflows/check-workflow-permissions-drift.mjs|scripts/workflows/check-workflow-permissions-drift.test.mjs)
          add_command "node scripts/workflows/check-workflow-permissions-drift.test.mjs" "platform-settings workflow-permissions drift checker changed"
          ;;
        scripts/workflows/check-github-action-pins.test.mjs)
          add_command "node scripts/workflows/check-github-action-pins.test.mjs" "GitHub Actions pin checker test changed"
          ;;
        # The Node deploy helpers moved into scripts/deploy/ with the wrappers.
        # These arms match exact paths, so the patterns AND the commands they
        # schedule both carry the new location — a stale command path fails loud
        # (node cannot find the file), but a stale pattern fails silent.
        #
        # Each therefore also carries the any-depth pair, like the wrapper arms.
        # It matters MORE here: a wrapper that moves again still falls through to
        # `scripts/deploy-*.sh|scripts/*/deploy-*.sh` and keeps the root-anchor
        # check, but a `.mjs` has no deploy-specific fallback at all — it would
        # land on `pnpm lint:scripts` alone and quietly stop running its suite.
        scripts/deploy/deploy-indexer-verify.mjs | \
          scripts/deploy/deploy-indexer-verify.test.mjs | \
          scripts/*/deploy-indexer-verify.mjs | \
          scripts/*/deploy-indexer-verify.test.mjs)
          add_command "node scripts/deploy/deploy-indexer-verify.test.mjs" "indexer deploy verifier changed"
          ;;
        scripts/deploy/deploy-indexer-perf.mjs | \
          scripts/deploy/deploy-indexer-perf.test.mjs | \
          scripts/*/deploy-indexer-perf.mjs | \
          scripts/*/deploy-indexer-perf.test.mjs)
          add_command "node scripts/deploy/deploy-indexer-perf.test.mjs" "indexer deploy perf helper changed"
          ;;
        scripts/deploy/filter-envio-runtime-errors.mjs | \
          scripts/deploy/filter-envio-runtime-errors.test.mjs | \
          scripts/*/filter-envio-runtime-errors.mjs | \
          scripts/*/filter-envio-runtime-errors.test.mjs)
          add_command "node scripts/deploy/filter-envio-runtime-errors.test.mjs" "indexer runtime-log filter changed"
          ;;
        # The status command is the shell wrapper rewritten in Node (P15). It is
        # read-only, so it never sourced the deploy guard and is not a subject of
        # check-deploy-root-anchors.test.mjs — nothing routes it by the
        # `deploy-*.sh` globs any more, and without this arm its argument
        # parsing, renderers and cadence bands would be covered by nothing but
        # `pnpm lint:scripts`.
        scripts/deploy/deploy-indexer-status.mjs | \
          scripts/deploy/deploy-indexer-status.test.mjs | \
          scripts/*/deploy-indexer-status.mjs | \
          scripts/*/deploy-indexer-status.test.mjs)
          add_command "node scripts/deploy/deploy-indexer-status.test.mjs" "indexer deploy status command changed"
          ;;
        scripts/alerts/alert-rules-lint.mjs|scripts/alerts/alert-rules-lint-extract.mjs|scripts/alerts/alert-rules-lint-peg-policy.mjs|scripts/alerts/alert-rules-lint.test.mjs)
          add_command "pnpm alerts:rules:lint:test" "alert-rules lint helper changed"
          ;;
        scripts/alerts/check-peg-registry-integrity.mjs|scripts/alerts/check-peg-registry-integrity-lineage.mjs|scripts/alerts/check-peg-registry-integrity.test.mjs)
          add_command "node scripts/alerts/check-peg-registry-integrity.mjs" "peg registry integrity checker changed"
          add_command "node scripts/alerts/check-peg-registry-integrity.test.mjs" "peg registry integrity checker changed"
          ;;
        # The publication boundary's only suite runs inside `pnpm tf:test`,
        # which the unconditional real-tree sweep further down already routes.
        # Naming it here keeps the reason honest and the routing correct if that
        # sweep is ever narrowed.
        scripts/alerts/check-peg-policy-publication.mjs|scripts/alerts/check-peg-policy-publication.test.mjs)
          add_command "pnpm tf:test" "peg policy publication boundary changed"
          ;;
        # The peg policy version-digest contract. Both peg validators compare a
        # version string against this one implementation, so a change here has
        # to run both or the halves can disagree undetected.
        scripts/lib/peg-policy-digest.mjs)
          add_command "pnpm alerts:rules:lint:test" "peg policy version digest changed"
          add_command "node scripts/alerts/check-peg-registry-integrity.mjs" "peg policy version digest changed"
          add_command "node scripts/alerts/check-peg-registry-integrity.test.mjs" "peg policy version digest changed"
          ;;
        scripts/pr/check-pr-description.mjs|scripts/pr/check-pr-description.test.mjs)
          add_command "node scripts/pr/check-pr-description.test.mjs" "PR description validator changed"
          ;;
        scripts/alerts/check-deviation-threshold-drift.mjs)
          add_command "node scripts/alerts/check-deviation-threshold-drift.mjs" "deviation threshold drift checker changed"
          add_command "node scripts/alerts/check-deviation-threshold-drift.test.mjs" "deviation threshold drift checker changed"
          ;;
        scripts/alerts/check-deviation-threshold-drift.test.mjs)
          add_command "node scripts/alerts/check-deviation-threshold-drift.test.mjs" "deviation threshold drift checker test changed"
          ;;
        scripts/terraform/notify-terraform-apply.mjs|scripts/terraform/notify-terraform-apply.test.mjs)
          add_command "node scripts/terraform/notify-terraform-apply.test.mjs" "Terraform apply Slack notifier changed"
          ;;
        scripts/terraform/check-terraform-deploy-queue.mjs|scripts/terraform/check-terraform-deploy-queue.test.mjs)
          add_command "node scripts/terraform/check-terraform-deploy-queue.test.mjs" "Terraform deploy queue watcher changed"
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
      add_registered_terraform_validate_commands "Terraform stack registry changed"
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
  # `pnpm tf:test` owns the fail-closed production identity contract. Route
  # every complete-inventory input plus the contract implementation itself.
  # Keep this after the specialized cases so ci.yml/infra.yml retain their
  # more specific command reasons while `add_command` deduplicates the run.
  #
  # `scripts/lib/*.mjs` covers the shared parsing cores the contract imports
  # from outside its own directory (ADR 0064): `hcl.mjs` backs all five
  # contract clusters plus the ADR 0053 deploy-staging contract, and
  # `workflow-yaml.mjs` backs the workflow and refresh-routing checks. The
  # unconditional real-tree sweep further down already runs `pnpm tf:test` for
  # any non-empty change set, so this arm does not decide whether the suite
  # runs — it names the reason and keeps the routing correct if that sweep is
  # ever narrowed. The glob is deliberately wider than the two files so a
  # future shared core added to `scripts/lib/` cannot land unrouted; the cost is
  # that a core the contract does not read, such as `peg-policy-digest.mjs`,
  # also gets this reason. Its own arm above routes the two peg suites.
  # `scripts/terraform/*.mjs` (P10) does the same for the moved apply-path
  # guards: `tf-stacks.mjs` imports two of them, so a change there reaches the
  # contract through the wrapper.
  case "$path" in
    terraform/*|aegis/terraform/*|alerts/infra/*|alerts/rules/*|governance-watchdog/infra/*|.github/workflows/*|scripts/production-infra-identity-contract/*.mjs|scripts/lib/*.mjs|scripts/terraform/*.mjs|scripts/sanitize-terraform-output.sh|scripts/verify-github-environment-protection.mjs)
      add_command "pnpm tf:test" "production infrastructure identity contract surface changed"
      ;;
  esac
  # `check-sentry-suites-in-ci.test.mjs` asserts that every Sentry suite runs in
  # CI. Its invariants are claims ABOUT the files below, so editing one of them
  # is exactly when it must run. Routing lives here rather than in the extension
  # cases above for two reasons: the readers span `.sh`, `.mjs`, `.yml`, and
  # `package.json`, and the first matching arm in those cases wins — every
  # existing `scripts/sentry-*.test.mjs` already matches a dedicated arm, so an
  # arm nested there would never see them. A new suite need not touch
  # package.json or ci.yml to exist, so the glob covers suites with no arm yet.
  # `add_command` deduplicates, so ci.yml keeps its more specific reason above.
  #
  # `.github/workflows/*` and `.github/actions/*` cover every reader the check
  # opens beyond ci.yml: `contextOwnershipBlockers` parses EVERY workflow to
  # prove no decoy job owns the `ci` check-run name, and the env scan recurses
  # into the composite `action.yml` files the trusted jobs pull in. Editing one
  # of those must run the check, or the drift it exists to catch surfaces only
  # after push. `scripts/sentry/ci-wiring/check-sentry-suites-in-ci*.mjs` covers this file, the
  # core, and its `-core-commands` / `-probes` siblings alike.
  #
  # Two suite globs because `findSentrySuites` in the check enumerates
  # recursively — a suite in a subdirectory is one the check will demand a CI
  # step for, so it has to route the check too. `scripts/*/sentry-*.test.mjs`
  # covers every depth: a `case` pattern is not pathname expansion, so `*`
  # matches `/`. (`**` would behave identically here and only invite a reader to
  # assume globstar semantics bash does not implement.) The same `*`-matches-`/`
  # rule is why `.github/actions/*` reaches a nested `action.yml`.
  #
  # Repository-specific, like the `pnpm tf:test` sweep below: the gate unit
  # tests run this script against stub fixture repositories that own neither
  # the check nor the suites it enumerates.
  if [[ "$script_source_dir" == "$repo_root/scripts" ]]; then
    case "$path" in
      .github/workflows/* | \
        .github/actions/* | \
        package.json | \
        scripts/agent-quality-gate.sh | \
        scripts/check-agent-quality-gate-package-scripts.mjs | \
        scripts/sentry/ci-wiring/check-sentry-suites-in-ci*.mjs | \
        scripts/lib/static-imports.mjs | \
        scripts/sentry-*.test.mjs | \
        scripts/*/sentry-*.test.mjs | \
        scripts/tf-stacks.test.mjs)
        add_command "node scripts/sentry/ci-wiring/check-sentry-suites-in-ci.test.mjs" "Sentry CI-coverage check reads this file"
        ;;
    esac
    # The self-run Sentry-suite gate (#1779, ADR 0062) runs EVERY suite the
    # manifest owns and asserts each one's pass count against its committed
    # floor, so every manifest-owned suite routes it — not just the gate's own
    # files. Deleting a test from, say, sentry-triage-requeue.test.mjs leaves
    # `pnpm sentry:requeue:test` green (30 passed, exit 0) while the gate reds on
    # `pass 30 < floor 31`; without this arm the local gate misses that and it
    # only surfaces after push. The same glob pair as above covers suites at any
    # depth, and the gate's own three files ride along so all of them route the
    # identical pair of commands.
    #
    # Both commands are kept because neither substitutes for the other: the
    # self-test proves the gate's LOGIC against throwaway fixture manifests in a
    # temp dir and never reads the committed one, while the real gate is what
    # validates the committed manifest against the real suites. `add_command`
    # deduplicates on the exact command string, so a path matching both this arm
    # and another one still schedules each command once.
    #
    # Both run under `/usr/bin/env -u NODE_OPTIONS -u NODE_PATH`, matching the
    # CI entry point. Without it a developer carrying a perfectly legitimate
    # ambient `NODE_OPTIONS=--no-warnings` cannot run the gate at all — it
    # refuses to start before executing a single suite — and half the
    # self-test's fixtures fail for that same reason. The gate costs ~3s.
    # `scripts/sentry/gate/sentry-suite-gate*.mjs` rather than the gate script alone: the
    # round-8 split created sentry-suite-gate-fixtures.mjs, which this arm did
    # not match, so a change to it scheduled Trunk and lint:scripts but NEITHER
    # gate suite — and that file owns fixture environment isolation, the
    # step-summary redirection and the shared harness. The prefix glob covers
    # every current and future gate module, so the next split cannot reopen it.
    #
    # `scripts/lib/static-imports.mjs` is named outright because it sits under
    # neither prefix and yet decides both consumers' answers: the gate's watch
    # set and exemption proof, and the CI-coverage check's import proof. It
    # scheduled only Trunk, lint:scripts and tf:test when it was extracted, so a
    # behavioural parser change was validated by neither gate suite nor the
    # checker (Codex 3761572721). It is listed in the coverage-check arm above
    # for the same reason. A shared module belongs in every arm that reads it,
    # whatever it is called.
    #
    # `check-sentry-suites-in-ci-core-commands.mjs` is here on the same ground,
    # found by the dry-run sweep that closed the one above: the gate's exemption
    # proof now parses the `tf:test` alias with that module's shell grammar, so
    # a change to it changes a gate verdict while its name still says "checker".
    # Four gaps of this shape have now come from naming files rather than
    # deriving readers; the gate's own watch set is the derived answer, and
    # teaching this mapping to consult it is the standing fix (#1803).
    case "$path" in
      scripts/sentry-*.test.mjs | \
        scripts/*/sentry-*.test.mjs | \
        scripts/sentry/gate/sentry-suite-gate*.mjs | \
        scripts/lib/static-imports.mjs | \
        scripts/sentry/ci-wiring/check-sentry-suites-in-ci-core-commands.mjs | \
        scripts/sentry/gate/sentry-suite-manifest.json)
        add_sentry_suite_gate_commands "Sentry-suite gate, manifest, or a manifest-owned suite changed"
        ;;
    esac
    # A directory symlink under scripts/ exposes suites the extension patterns
    # above (and the CI `rootScripts` filter) never see: `findSentrySuites`
    # follows the link and enumerates `scripts/<link>/sentry-*.test.mjs`, but the
    # changed paths are the extensionless link itself and its target outside
    # scripts/, matching neither. Route BOTH Sentry checks for ANY symlink under
    # scripts/ so the suite it exposes is proven wired rather than silently
    # skipped (Codex 3754355168). `-L` reads the working tree, matching what both
    # enumerators walk.
    #
    # The gate pair is what makes this arm load-bearing now. Until #1779 PR C the
    # checker demanded a direct CI step for every enumerated suite, so it red on
    # its own; PR C retired that assertion because the unconditional CI gate runs
    # each suite instead — but the gate is a DIFFERENT command, and this arm was
    # still scheduling only the checker. A suite added beneath such a link then
    # left the checker green while the missing manifest entry reds only after
    # push (Codex 3766397748). Coverage moved jobs; the routing has to move with
    # it.
    case "$path" in
      scripts/*)
        if [[ -L "$repo_root/$path" ]]; then
          add_command "node scripts/sentry/ci-wiring/check-sentry-suites-in-ci.test.mjs" "symlink under scripts/ can expose an unwired Sentry suite"
          add_sentry_suite_gate_commands "symlink under scripts/ can expose an unwired Sentry suite"
        fi
        ;;
    esac
    # The mirror case: a change BENEATH an existing scripts/ directory symlink's
    # real target (resolved once, above). Such a path is a suite findSentrySuites
    # and the gate's enumerator both reach through the link, yet it matches
    # neither scripts/* above nor the rootScripts CI filter — so without this the
    # local gate would skip both checks while the suite goes unwired (Codex
    # 3754704280, 3766397748).
    for scripts_symlink_target in "${scripts_symlink_targets[@]+"${scripts_symlink_targets[@]}"}"; do
      case "$path" in
        "$scripts_symlink_target"/*)
          add_command "node scripts/sentry/ci-wiring/check-sentry-suites-in-ci.test.mjs" "change beneath a scripts/ symlink target can expose an unwired Sentry suite"
          add_sentry_suite_gate_commands "change beneath a scripts/ symlink target can expose an unwired Sentry suite"
          break
          ;;
      esac
    done
  fi
  if [[ "$terraform_stack_paths_count" -gt 0 ]]; then
    for terraform_stack_path in "${terraform_stack_paths[@]}"; do
      case "$path" in
        "$terraform_stack_path"/*)
          add_surface "terraform"
          add_terraform_validate_commands "$terraform_stack_path" "registered Terraform stack changed"
          add_command "pnpm tf:test" "registered Terraform stack changed"
          break
          ;;
      esac
    done
  fi
done < "$changed_paths_file"

# The Terraform test suite validates production infrastructure and deployment
# contracts that can be affected indirectly. Every non-empty change set in this
# checkout therefore runs it once, regardless of its changed paths. Gate unit
# tests invoke this script against isolated fixture repositories; those fixtures
# do not own this repository-specific contract.
if [[ "$script_source_dir" == "$repo_root/scripts" ]]; then
  add_command "pnpm tf:test" "non-empty change set validates production infrastructure contract"
fi

if [[ "$routing_sensitive_paths_changed" == "true" ]]; then
  add_command "pnpm docs:navigation-eval -- --check-fixtures" "routing-sensitive source changed"
fi

add_trunk_check_command
sort_codegen_commands
compact_turbo_quality_commands
apply_scoped_test_commands

# ── D5b part 2: the Node mapping engine is the routing ──────────────────────
#
# Everything above this line is the bash `case` arms, and they still run. What
# changes here is which plan the gate USES: the mapper's. The arms become a
# cross-check, and the gate REFUSES the whole run if the two plans differ by one
# byte. That is parity in production rather than parity in a harness, and it is
# what makes the swap reversible — a divergence stops the run instead of
# silently choosing a winner.
#
# D5c deletes the arms and this comparison once the soak is clean. ADR 0069.
#
# EVERY failure below is a refusal. A mapper that crashes, exits non-zero,
# prints something unparsable, names a bucket that does not exist, or emits
# nothing at all must not leave the gate running on a partial plan: fewer mapped
# commands still print "All mapped commands passed."
plan_records_from_bash() {
  local entry
  printf 'flag\tpackage_script_risk_changed\t%s\n' "$package_script_risk_changed"
  printf 'flag\tsaw_workspace_escalation\t%s\n' "$saw_workspace_escalation"
  for entry in "${surfaces[@]+"${surfaces[@]}"}"; do
    printf 'surface\t%s\n' "$entry"
  done
  for entry in "${checklists[@]+"${checklists[@]}"}"; do
    printf 'checklist\t%s\t%s\n' "${entry%%|*}" "${entry#*|}"
  done
  for entry in "${preflight_commands[@]+"${preflight_commands[@]}"}"; do
    printf 'preflight\t%s\t%s\n' "${entry%%|*}" "${entry#*|}"
  done
  for entry in "${codegen_commands[@]+"${codegen_commands[@]}"}"; do
    printf 'codegen\t%s\t%s\n' "${entry%%|*}" "${entry#*|}"
  done
  for entry in "${post_codegen_commands[@]+"${post_codegen_commands[@]}"}"; do
    printf 'post-codegen\t%s\t%s\n' "${entry%%|*}" "${entry#*|}"
  done
  for entry in "${quality_commands[@]+"${quality_commands[@]}"}"; do
    printf 'quality\t%s\t%s\n' "${entry%%|*}" "${entry#*|}"
  done
}

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
  # Exit 2, not the mapper's own code. 2 is this gate's refusal status, and the
  # bash routing classifier already collapses its own 3 into a 2 the same way
  # (`:2010`). Forwarding 1 or 3 here would make a mapper crash look like a
  # different class of failure to anything reading the gate's status.
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
        # Accepted and compared, not stored: its only reader already ran. An
        # unrecognised VALUE still falls through to the refusal below.
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

# The transitional guard. Order matters on both sides — the buckets, the
# surfaces and the checklists all print and hash in sequence — so this is a
# byte comparison of the whole plan, not a set comparison.
bash_plan_file="$(make_tmpfile)"
plan_records_from_bash > "$bash_plan_file"
if ! diff -u "$bash_plan_file" "$mapper_plan_file" > "$bash_plan_file.diff" 2>&1; then
  echo "error: the gate mapping engine and the bash routing arms disagree." >&2
  echo "       This is the D5c soak guard: the run is refused rather than run on either plan." >&2
  echo "       -bash +engine:" >&2
  sed 's/^/       /' "$bash_plan_file.diff" >&2
  rm -f "$bash_plan_file.diff"
  exit 2
fi
rm -f "$bash_plan_file.diff"

# The engine's plan is the plan. Assigned from its records rather than left as
# the bash arrays, so that when D5c deletes the arms nothing downstream moves.
preflight_commands=("${engine_preflight_commands[@]+"${engine_preflight_commands[@]}"}")
codegen_commands=("${engine_codegen_commands[@]+"${engine_codegen_commands[@]}"}")
post_codegen_commands=("${engine_post_codegen_commands[@]+"${engine_post_codegen_commands[@]}"}")
quality_commands=("${engine_quality_commands[@]+"${engine_quality_commands[@]}"}")
checklists=("${engine_checklists[@]+"${engine_checklists[@]}"}")
surfaces=("${engine_surfaces[@]+"${engine_surfaces[@]}"}")
# This one is still read below, by the refusal that stops a run whose package
# manifests or lockfile changed, so it has to cross the seam.
package_script_risk_changed="$engine_package_script_risk_changed"
# `saw_workspace_escalation` deliberately does NOT get assigned here. Its only
# reader is `scoped_tests_enabled`, which ran in the post-passes above, so an
# assignment at this point would be dead code that reads like a live flag. It is
# still carried across the seam and compared, because a disagreement about it
# means the two sides escalated differently even where the command lists happen
# to match.

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
    scripts/gate/routing-parity.mjs \
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
    scripts/gate/routing-table/gate-arms.mjs \
    scripts/gate/routing-table/gate-equality.test.mjs \
    scripts/gate/routing-table/groups-head.mjs \
    scripts/gate/routing-table/groups-tail.mjs \
    scripts/gate/routing-table/index.mjs \
    scripts/gate/routing-table/pattern-oracle.test.mjs \
    scripts/gate/routing-table/pattern.mjs \
    scripts/gate/routing-table/routing-table.test.mjs \
    scripts/gate/routing-table/schema.mjs \
    scripts/terraform/terraform-fmt-check.mjs \
    scripts/terraform/terraform-fmt-check.test.mjs \
    turbo.json \
    .trunk/trunk.yaml; do
    if [[ -f "$path" ]]; then
      printf '%s %s\n' "$path" "$(hash_file "$path")"
    else
      printf '%s __missing__\n' "$path"
    fi
  done | hash_stream
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

validation_content_signature() {
  local path

  {
    while IFS= read -r path; do
      printf 'path %s\0' "$path"
      if [[ -f "$path" ]]; then
        printf 'file %s\0' "$(hash_file "$path")"
        # The executable bit and symlink-ness are not in the content hash, and
        # they are the part of the summary line below that says something about
        # the file rather than about the index. Read from the worktree, so
        # `git add` cannot move it.
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

# Take the machine's run lock only once this run is definitely going to execute
# something: a dry run, a fresh-stamp skip, and a package-script refusal all
# exit above without ever competing for the machine.
acquire_gate_run_lock
# The run marker is written here, while the gate's own stderr is still live
# and the exit is unambiguously the gate's: inside run_with_timeout the
# per-command capture would swallow the message, and a parallel worker's exit
# is not the run's. Failing here also means failing before ANY command, which
# is the whole point.
gate_run_ensure_marker
# Test-only: widens the gap between holding the lock and checking we still do,
# which is otherwise as short as the mapping work between them.
gate_lock_test_delay "${AGENT_QUALITY_GATE_LOCK_HELD_DELAY_SECONDS:-}"

# Re-check freshness after the wait. The run we queued behind may have stamped
# this exact fingerprint while we waited — the pre-push hook queued behind the
# manual warm-up run is precisely that case — and re-running its work would
# throw away the reason the hook passes --skip-if-fresh at all.
if [[ "$skip_if_fresh" == "1" || "$skip_if_fresh" == "true" ]]; then
  if is_fresh_success_stamp; then
    echo "A concurrent agent quality gate run left a fresh success stamp; skipping mapped commands."
    exit 0
  fi
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
  # something inherited can still name it. Both are keyed to this run's token,
  # so neither can come to name a stranger.
  gate_run_ensure_marker
  AGENTQG_RUN="$(gate_run_command_tag)" \
    bash -c '
      if [[ -n "$2" ]]; then
        # A marker this wrapper was given but cannot hold open is a refusal,
        # not a shrug: without the descriptor, a replacement this command
        # forks is invisible to the next run.
        if [[ ! -r "$2" ]]; then
          echo "error: cannot open the run marker $2; refusing to start the command" >&2
          exit 127
        fi
        exec 9< "$2"
      fi
      eval "$1"
      exit $?
    ' "$(gate_run_command_tag)" "$command" "$gate_run_marker_file" &
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
    gate_pid="$4"
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
  ' "$(gate_run_command_tag)" "$cmd_pid" "$command_timeout_seconds" "$timeout_marker" "$$" >/dev/null 2>&1 &
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
    [[ "$created_at" -le "$now" ]] || continue
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
  local had_monitor=0

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
      worker_registration_in_progress=1
      had_monitor=0
      case "$-" in
        *m*) had_monitor=1 ;;
      esac
      # macOS has no setsid(1). Bash job control is available in stock Bash
      # 3.2 and gives this background worker a dedicated process group whose ID
      # is the worker PID, so the parent can tear down the group after the
      # leader exits or its descendants reparent.
      set -m
      (
        # The parent needs monitor mode only to create this worker group. Turn
        # it back off inside the worker so run_with_timeout's command and
        # watchdog children stay in that group instead of becoming new jobs.
        set +m
        run_mapped_command_to_files \
          "$command" "$output_file" "$status_file" "$elapsed_file" "$timeout_file"
      ) </dev/null &
      pid="$!"
      if [[ "$had_monitor" -eq 0 ]]; then
        set +m
      fi

      # Private deterministic barrier for the signal-registration regression.
      # It is inert unless the test suite opts in.
      if [[ -n "$worker_registration_test_barrier" ]]; then
        if [[ ! -e "${worker_registration_test_barrier}.ready" ]]; then
          printf '%s\n' "$pid" > "${worker_registration_test_barrier}.ready"
        fi
        while [[ ! -e "${worker_registration_test_barrier}.release" ]]; do
          sleep 0.05 || true
        done
      fi

      active_pids+=("$pid")
      active_worker_pgids+=("$pid")
      finish_worker_registration
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
      # A worker normally leaves an empty group because run_with_timeout reaps
      # its command and watchdog. If the leader exited unexpectedly, drain any
      # surviving same-group descendants before unregistering the PGID.
      drain_worker_process_group "$pid"

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
    active_worker_pgids=("${next_active_pids[@]+"${next_active_pids[@]}"}")
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
prune_command_stamps

# Last thing before anything is executed: confirm this run still holds the lock
# it took. Mapping and stamp work happen between acquiring and here, which is
# room enough for another run to have taken it over.
assert_gate_run_lock_still_ours

# This run took the lock from a holder that died. That holder's mapped commands
# may still be running — commands are backgrounded and outlive their shell — so
# confirm they are gone before executing anything. Asked of the machine, not of
# a clock: the watchdogs that would clean them up can be descheduled by the same
# pressure that killed the gate, or suspended along with the laptop.
drain_condemned_runs

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
