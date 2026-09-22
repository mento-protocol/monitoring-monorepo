#!/usr/bin/env bash
# Lifecycle, lock, deadline, failure, and publication support for run-eval.sh.
# This file is sourced in stages. Do not execute it directly.

case "${RUN_EVAL_LIFECYCLE_STAGE:-}" in
  setup)
# RUN-EVAL-ORIGINAL-BEGIN lifecycle-setup
# Where the checkout half of the run lock lives. The ledger and the detail
# directory belong to this checkout no matter what `--cache-dir` says, so the
# lock that protects them has to be anchored here too. The git directory is the
# anchor: it is one per checkout — a linked worktree gets its own — it is never
# a tracked path, so a lock in it cannot dirty the ledger commit, and it lives
# exactly as long as the checkout does.
LOCK_ROOT="$(git -C "$REPO" rev-parse --absolute-git-dir 2>/dev/null)" ||
  fail "$REPO has no git directory to anchor the run lock"

command -v claude >/dev/null 2>&1 || fail "claude CLI is not on PATH"
command -v codex >/dev/null 2>&1 || fail "codex CLI is not on PATH"
command -v node >/dev/null 2>&1 || fail "node is not on PATH"

TMPROOT="${TMPDIR:-/tmp}"

# shellcheck disable=SC2329  # invoked by the EXIT trap below
cleanup() {
  local code=$?
  # Take the matrix group workers down (when the scheduler was sourced) before
  # the spec worktree and skill snapshot they read are removed.
  if declare -F matrix_cleanup >/dev/null 2>&1; then
    matrix_cleanup
  fi
  if [[ $SPEC_TEMP -eq 1 && -n $SPEC ]]; then
    git -C "$REPO" worktree remove --force "$SPEC" >/dev/null 2>&1 || true
    # The spec lives under the git dir, where no OS sweep collects leftovers.
    rm -rf "$SPEC"
    git -C "$REPO" worktree prune >/dev/null 2>&1 || true
  fi
  [[ -z $SHIM ]] || rm -rf "$SHIM"
  if [[ -n $SKILL_SNAPSHOT ]]; then
    rm -rf "$SKILL_SNAPSHOT"
  fi
  if [[ -n ${CODEX_ISO:-} ]]; then
    # A refresh renamed over the link is copied back unless the operator's file moved on.
    [[ -f $CODEX_ISO/.codex/auth.json && ! -L $CODEX_ISO/.codex/auth.json && "$(shasum -a 256 "$CODEX_AUTH" 2>/dev/null | cut -c1-64)" == "${CODEX_AUTH_SUM:-}" ]] && cp "$CODEX_ISO/.codex/auth.json" "$CODEX_AUTH"
    rm -rf "$CODEX_ISO"
  fi
  if [[ -n $BASELINE_SNAPSHOT ]]; then
    rm -f "$BASELINE_SNAPSHOT"
  fi
  local lock_dir
  for lock_dir in ${LOCK_DIRS[@]+"${LOCK_DIRS[@]}"}; do
    rm -rf "$lock_dir"
  done
  return "$code"
}
# RUN-EVAL-SPLIT-ONLY-BEGIN source-snapshot-exit-trap
trap cleanup_with_source_snapshot EXIT
# RUN-EVAL-SPLIT-ONLY-END source-snapshot-exit-trap

# --- the run lock ------------------------------------------------------------

# One fixture cache, one ledger, one run at a time. Every cell resets and cleans
# the shared per-PR checkout, stages or purges `.skill` in it, and then runs a
# model inside it. Two runs that overlap — the launchd job starting while a
# manual run is mid-matrix, or two manual runs — take turns rewriting the same
# tree, so one scores a review of the other's skill state and neither result
# means anything. Both also append to the same ledger.
#
# Two things are shared, and they vary independently. The fixture cache moves
# with `--cache-dir`; the ledger and the detail directory move with `--repo`. A
# single lock under the cache let a manual run with its own `--cache-dir` start
# under the scheduled run and race the same ledger appends and detail
# directory, so both roots are locked, always checkout first and cache second.
# A fixed order means two runs contending on both cannot each hold one and wait
# — the loser fails immediately and the EXIT trap frees whatever it took.
#
# A hard link publishes a prepared owner record as the lock. The record already
# contains the holder's pid when the lock path becomes visible. This gives the
# acquisition atomicity of mkdir without a window where a suspended owner has
# created the lock but has not written its pid. The prepared record and lock
# live under the same root, so the hard link never crosses a filesystem. A lock
# left behind by SIGKILL can be told from a live run and reclaimed. `kill -0` on
# a recycled pid can keep a stale lock held; that fails closed, and the message
# names the file to remove.
acquire_one_lock() {
  local root="$1" what="$2" lock="$1/run.lock" holder="" legacy_lock=0
  local reclaim_root="$1/run.lock.reclaim" claim_file="" claim_holder=""
  local claim_ticket="" owner_ticket="" claim_generation=-1
  local candidate_generation=-1 entry=""
  mkdir -p "$root" || fail "the $what $root is not writable"
  owner_ticket="$(mktemp "$root/.run.lock.owner.XXXXXX")" ||
    fail "could not prepare the run lock owner record under $root"
  printf '%s\n' "$$" >"$owner_ticket"
  if ! node -e \
    'require("node:fs").linkSync(process.argv[1], process.argv[2])' \
    "$owner_ticket" "$lock" 2>/dev/null; then
    rm -f "$owner_ticket"
    owner_ticket=""
    if [[ -d $lock ]]; then
      legacy_lock=1
      holder="$(cat "$lock/pid" 2>/dev/null || true)"
    else
      holder="$(cat "$lock" 2>/dev/null || true)"
    fi
    [[ $holder =~ ^[0-9]+$ ]] ||
      fail "cannot identify the run lock owner at $lock; refusing to reclaim shared run state"
    if [[ $holder =~ ^[0-9]+$ ]] && kill -0 "$holder" 2>/dev/null; then
      fail "another review eval (pid $holder) holds $lock; a run rewrites the shared fixtures and appends to the shared ledger, so wait for it to finish"
    fi
    # Reclaimers elect one owner through immutable, monotonically numbered
    # tickets. `ln` publishes the prepared pid file atomically. A killed owner
    # leaves its generation behind; the next contender creates the next one.
    # Tickets stay immutable during the election. The winner removes the claim
    # root only after it publishes the replacement lock owner.
    mkdir "$reclaim_root" 2>/dev/null || true
    [[ -d $reclaim_root ]] ||
      fail "could not create the stale-lock claim root at $reclaim_root"
    for entry in "$reclaim_root"/*; do
      [[ -f $entry ]] || continue
      candidate_generation="${entry##*/}"
      [[ $candidate_generation =~ ^[0-9]+$ ]] || continue
      if ((candidate_generation > claim_generation)); then
        claim_generation=$candidate_generation
      fi
    done
    if ((claim_generation >= 0)); then
      claim_file="$reclaim_root/$claim_generation"
      claim_holder="$(cat "$claim_file" 2>/dev/null || true)"
      [[ $claim_holder =~ ^[0-9]+$ ]] ||
        fail "cannot identify the stale-lock reclaimer in $claim_file; refusing to reclaim shared run state"
      if [[ $claim_holder =~ ^[0-9]+$ ]] &&
        kill -0 "$claim_holder" 2>/dev/null; then
        fail "another review eval (pid $claim_holder) is reclaiming the stale lock at $lock; retry after it finishes"
      fi
    fi
    claim_generation=$((claim_generation + 1))
    claim_file="$reclaim_root/$claim_generation"
    claim_ticket="$(mktemp "$reclaim_root/.ticket.XXXXXX")" ||
      fail "could not prepare a stale-lock claim at $reclaim_root"
    printf '%s\n' "$$" >"$claim_ticket"
    if ! node -e \
      'require("node:fs").linkSync(process.argv[1], process.argv[2])' \
      "$claim_ticket" "$claim_file" 2>/dev/null; then
      rm -f "$claim_ticket"
      fail "another review eval claimed the stale lock at $lock; retry after it finishes"
    fi
    rm -f "$claim_ticket"
    local confirmed
    if [[ $legacy_lock -eq 1 && -d $lock ]]; then
      confirmed="$(cat "$lock/pid" 2>/dev/null || true)"
    else
      confirmed="$(cat "$lock" 2>/dev/null || true)"
    fi
    [[ $confirmed =~ ^[0-9]+$ ]] ||
      {
        rm -f "$claim_file"
        fail "cannot confirm the stale run lock owner at $lock; refusing to reclaim shared run state"
      }
    if [[ $confirmed =~ ^[0-9]+$ ]] && kill -0 "$confirmed" 2>/dev/null; then
      rm -f "$claim_file"
      fail "another review eval (pid $confirmed) holds $lock; a run rewrites the shared fixtures and appends to the shared ledger, so wait for it to finish"
    fi
    log "reclaiming a run lock left behind by pid ${holder:-unknown}"
    rm -rf "$lock"
    owner_ticket="$(mktemp "$root/.run.lock.owner.XXXXXX")" || {
      rm -f "$claim_file"
      fail "could not prepare the run lock owner record under $root"
    }
    printf '%s\n' "$$" >"$owner_ticket"
    if ! node -e \
      'require("node:fs").linkSync(process.argv[1], process.argv[2])' \
      "$owner_ticket" "$lock" 2>/dev/null; then
      rm -f "$owner_ticket"
      rm -f "$claim_file"
      fail "another review eval took the run lock at $lock; retry after it finishes"
    fi
    rm -rf "$reclaim_root"
  else
    # A prior reclaimer can die after it removes the stale lock and before it
    # publishes its replacement. Retire that abandoned claim after this owner
    # wins the now-empty lock so a recycled ticket pid cannot block recovery.
    rm -rf "$reclaim_root"
  fi
  rm -f "$owner_ticket"
  LOCK_DIRS+=("$lock")
}

acquire_run_lock() {
  acquire_one_lock "$LOCK_ROOT" "run state directory"
  acquire_one_lock "$CACHE_DIR" "fixture cache"
}

acquire_run_lock

# RUN-EVAL-ORIGINAL-END lifecycle-setup
    ;;
  verify)
    RUN_EVAL_SOURCE_NAMES=(
      run-eval.sh
      run-eval-source-snapshot.sh
      run-eval-lifecycle.sh
      run-eval-runtime.sh
      run-eval-matrix.sh
      run-eval-plan.sh
      run-eval-publish.sh
      run-eval-cell.sh
    )
    for RUN_EVAL_SOURCE_NAME in "${RUN_EVAL_SOURCE_NAMES[@]}"; do
      RUN_EVAL_RUNNING_SOURCE="$RUN_EVAL_SCRIPT_DIR/$RUN_EVAL_SOURCE_NAME"
      if [[ $RUN_EVAL_SOURCE_NAME == run-eval.sh ]]; then
        RUN_EVAL_SPEC_SOURCE="$ORCHESTRATOR"
      else
        RUN_EVAL_SPEC_SOURCE="$SPEC/scripts/review/$RUN_EVAL_SOURCE_NAME"
      fi
      [[ -f $RUN_EVAL_SPEC_SOURCE ]] ||
        fail "$RUN_EVAL_SPEC_SOURCE is missing; the spec worktree has an incomplete orchestrator"
      if ! cmp -s "$RUN_EVAL_RUNNING_SOURCE" "$RUN_EVAL_SPEC_SOURCE"; then
        fail "the running orchestrator source $RUN_EVAL_RUNNING_SOURCE differs from $RUN_EVAL_SPEC_SOURCE, whose bytes the row would record; commit or stash the change, or pass --skill-ref to evaluate this checkout"
      fi
    done
    unset RUN_EVAL_SOURCE_NAMES RUN_EVAL_SOURCE_NAME
    unset RUN_EVAL_RUNNING_SOURCE RUN_EVAL_SPEC_SOURCE
    ;;
  support)
# RUN-EVAL-ORIGINAL-BEGIN lifecycle-support
# --- the run deadline --------------------------------------------------------

# The deadline bounds the whole run, not the gaps between cells. A quarter of
# the budget is reserved for scoring: the matrix stops starting cells at
# MATRIX_DEADLINE, every subprocess is bounded by what is left of it, and the
# scoring pass gets the remainder. Without the reserve a matrix that ran to the
# end would leave scoring nothing, and the paid cells expire with the run
# directory's date.
MATRIX_DEADLINE=$((DEADLINE - DEADLINE / 4))
((MATRIX_DEADLINE > 0)) || MATRIX_DEADLINE=1

# Seconds left of one budget, never below one: a zero limit would kill the
# subprocess before it started and cost a cell for nothing.
remaining_seconds() {
  local budget="$1" left
  left=$((budget - ($(date +%s) - STARTED)))
  ((left < 1)) && left=1
  printf '%s' "$left"
}

# Run one command with a wall-clock bound, stdout to $1, stderr to "$1.err".
# macOS ships no `timeout`, so the bound is a watchdog subshell: TERM at the
# limit, KILL ten seconds later for a child that ignores it. Returns the
# command's own status, or 124 when the bound stopped it.
#
# The bounded command is started in a process group of its own and the watchdog
# signals the whole group, because every command run here spawns model calls as
# grandchildren: the scoring pass is `node review-eval.mjs`, which spawns up to
# four `claude` judges, and a cell is a shell function that spawns the finder or
# the contestant. Signalling the direct child alone left those grandchildren
# running against their own one-hour timeouts, spending quota long after the run
# reported failure and removed the worktrees they were reading. Monitor mode is
# what gives the job its own group; it is switched off again immediately, and
# Bash makes the direct child the process-group leader for this simple
# background job, so its pid is also the group id. This avoids a `ps` lookup
# that a restricted runner can deny after the child has already started.
#
# Standard input comes from /dev/null. In its own process group a child that
# reads the controlling terminal takes SIGTTIN and stops, which would turn a
# stalled read into a hung run; every prompt here is passed in argv, so nothing
# wants a terminal.
#
# stderr is captured rather than discarded: it is the only place a finder, a
# contestant or the scorer says why it exited, and every failure path below is a
# log line that would otherwise carry a bare exit status. The caller removes the
# file with the stdout file it named.
# A model process whose stdout is read through `head -c`: the pipe closes at
# the byte ceiling, the child's whole process group is then killed rather than
# left spending, and the caller reads a stream one byte past the ceiling as an
# overflow. For the codex verifier, whose `ulimit -f` cap would fire on its own
# sqlite state. The child is started under job control so its pid is its group.
run_stream_capped() {
  local ceiling="$1" fixture="$2"
  shift 2
  local fifo
  fifo="$(mktemp -u "$TMPROOT/review-eval-pipe.XXXXXX")"
  mkfifo "$fifo" || return 1
  # Job control puts the model in a group of its own, so the deadline TERM that
  # `run_bounded` sends to this shell's group no longer reaches it. Left
  # untrapped that TERM kills the `head` below and ends this shell, and the
  # model survives to spend against its own hour-long timeout. These handlers
  # carry the deadline across the group boundary and are armed before the
  # launch, so no window exists between the two. `$child` and `$fifo` expand
  # when the trap fires, only inside this call: every return path clears them.
  local child=""
  trap 'kill -KILL -- "-$child" 2>/dev/null; rm -f "$fifo"; exit 143' TERM INT
  set -m
  run_in_fixture "$fixture" "$@" >"$fifo" &
  child=$!
  set +m
  head -c "$((ceiling + 1))" <"$fifo"
  kill -TERM -- "-$child" 2>/dev/null || true
  local waited=0
  while ((waited < 10)) && kill -0 -- "-$child" 2>/dev/null; do
    sleep 1
    waited=$((waited + 1))
  done
  kill -KILL -- "-$child" 2>/dev/null || true
  local status=0
  wait "$child" || status=$?
  trap - TERM INT
  rm -f "$fifo"
  return "$status"
}

run_bounded() {
  local out_file="$1" limit="$2"
  shift 2
  local marker="${out_file}.deadline"
  rm -f "$marker"
  local monitor_off=0
  case "$-" in
    *m*) : ;;
    *) monitor_off=1 ;;
  esac
  set -m
  "$@" </dev/null >"$out_file" 2>"${out_file}.err" &
  local pid=$!
  ((monitor_off)) && set +m
  local target="-$pid"
  (
    local waited=0
    while ((waited < limit)); do
      sleep 1
      waited=$((waited + 1))
      kill -0 "$pid" 2>/dev/null || exit 0
    done
    : >"$marker"
    kill -TERM "$target" 2>/dev/null || exit 0
    sleep 10
    kill -KILL "$target" 2>/dev/null || true
  ) &
  local watcher=$!
  local status=0
  wait "$pid" || status=$?
  if [[ -f $marker ]]; then
    # The direct child can exit on TERM while a model grandchild ignores it.
    # Let the watchdog finish its group-wide KILL before this function returns.
    wait "$watcher" 2>/dev/null || true
  else
    kill -TERM "$watcher" 2>/dev/null || true
  fi
  wait "$watcher" 2>/dev/null || true
  if [[ -f $marker ]]; then
    rm -f "$marker"
    return 124
  fi
  return "$status"
}

# Log the tail of a captured stderr file, one log line per line, so a failure
# names its cause instead of only its exit status. Silent when nothing was
# written, and bounded so a megabyte of model chatter cannot flood the log.
log_stderr_tail() {
  local err_file="$1" line
  [[ -s $err_file ]] || return 0
  log "  stderr tail of ${err_file##*/}:"
  while IFS= read -r line; do
    log "    $line"
  done < <(tail -c 4000 "$err_file" | tail -n 20)
}

# RUN-EVAL-ORIGINAL-END lifecycle-support
    ;;
  *)
    fail "unknown run-eval lifecycle stage: ${RUN_EVAL_LIFECYCLE_STAGE:-unset}"
    ;;
esac

# Keep the exact pre-split check as inert reconstruction data. The quoted
# here-document sends these bytes to `:`. Bash cannot execute them.
: <<'RUN_EVAL_ORIGINAL_LIFECYCLE_VERIFY'
# RUN-EVAL-ORIGINAL-BEGIN lifecycle-verify
# This script decides the contestant's tools, turn limit, skill staging, finder
# truncation and environment, so its bytes are hashed into `comparability_key`
# and into every cell fingerprint — from the spec worktree, which is where the
# harness reads all of its inputs. Running an edited copy against a clean spec
# would record the spec's digest for a matrix this file actually shaped, which
# is the silent pairing the digest exists to prevent.
if ! cmp -s "${BASH_SOURCE[0]}" "$ORCHESTRATOR"; then
  fail "the running orchestrator differs from $ORCHESTRATOR, whose digest the row would record; commit or stash the change, or pass --skill-ref to evaluate this checkout"
fi

# RUN-EVAL-ORIGINAL-END lifecycle-verify
RUN_EVAL_ORIGINAL_LIFECYCLE_VERIFY
