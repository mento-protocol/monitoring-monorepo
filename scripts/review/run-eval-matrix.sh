#!/usr/bin/env bash
# The matrix scheduler for run-eval.sh: the cells of one fixture PR run strictly
# in sequence, and whole PR groups run concurrently.
# This file is sourced after run-eval-runtime.sh. Do not execute it directly.
#
# Every cell resets and cleans its PR's single fixture checkout, stages `.skill`
# into it, and then lets a contestant edit that tree with a real Bash tool, so
# two cells of one PR can never overlap. Two cells of different PRs touch
# different checkouts, which is the shape ADR 0086 already gives the experiment
# lane: draws of one PR in sequence, PR groups concurrent. Serial cells put the
# 39-cell full matrix at 8 to 9 hours against a 4.5-hour matrix deadline; three
# groups at once is the same cap the experiment lane uses.
#
# The cost is unchanged: the same cells run, in the same plan order inside their
# group, against the same fixtures.

# How many PR groups may run at once. 1 is the old strictly serial matrix.
MATRIX_PR_CONCURRENCY="${REVIEW_EVAL_PR_CONCURRENCY:-3}"
if [[ ! $MATRIX_PR_CONCURRENCY =~ ^[1-9][0-9]*$ ]]; then
  fail "REVIEW_EVAL_PR_CONCURRENCY must be a positive whole number of PR groups"
fi

# Live group workers, and the scratch directory their outcomes are written to.
# Both are globals because `cleanup` reaches them through `matrix_cleanup` on
# the EXIT path, after `run_matrix` has already returned or been signalled.
MATRIX_STATUS_DIR=""
MATRIX_WORKER_PIDS=()
MATRIX_WORKER_SLOTS=()

# A worker's own signal handler, forwarding to the groups its children lead.
# One signal to the worker's group is not enough on its own: a cell's paid work
# runs under `run_bounded`, which deliberately does its own `set -m` and so puts
# the finder, the contestant or the scorer in a process group of its own. That
# child is not in the worker's group, and on an operator interrupt its watchdog
# dies with the worker, so nothing would be left to end it — the orphan spending
# quota that `run_bounded`'s group signalling exists to prevent. Every direct
# child is signalled by group; the ones that are not group leaders answer to the
# worker's own group signal instead, and the failed `kill` is discarded.
#
# The worker reads its own pid out of the file the parent wrote for it, rather
# than from `$$`, which inside a subshell is still the orchestrator's pid, or
# from `BASHPID`, which the `/bin/bash` 3.2 the launchd job runs does not have.
# A file the parent wrote is the same on every Bash. Before that file exists —
# a window of one write, against a matrix that runs for hours — this forwards
# nothing and the worker still dies of the group signal it was sent.
#
# The group ids are collected once, before the first signal, and the same list
# is used for both passes. A bounded child can exit on TERM while a model
# process in its group ignores it — the case `run_bounded`'s own watchdog is
# built around — and once that leader is gone its group is no longer any child
# of this worker. Re-reading the children for the KILL pass would miss exactly
# the group that still needs it. A process group outlives its leader as long as
# one member is alive, so the collected id still names it.
# shellcheck disable=SC2329  # invoked by the worker's TERM trap
matrix_worker_kill_children() {
  local pid_file="$1" self="" child
  local -a groups=()
  [[ -f $pid_file ]] || return 0
  read -r self <"$pid_file" || return 0
  [[ $self =~ ^[0-9]+$ ]] || return 0
  for child in $(pgrep -P "$self" 2>/dev/null || true); do
    groups+=("$child")
  done
  ((${#groups[@]} > 0)) || return 0
  for child in "${groups[@]}"; do
    kill -TERM "-$child" 2>/dev/null || true
  done
  sleep 1
  for child in "${groups[@]}"; do
    kill -KILL "-$child" 2>/dev/null || true
  done
}

# Every group worker leads its own process group, the way `run_bounded` makes
# its bounded child one, so the run can take a whole group down with one signal.
# TERM first, then KILL for whatever ignored it. The grace between them is what
# gives each worker's own handler time to forward the signal to the bounded
# child it started, which leads a group of its own.
# shellcheck disable=SC2329  # invoked by the TERM trap and by matrix_cleanup
matrix_kill_workers() {
  local pid
  ((${#MATRIX_WORKER_PIDS[@]} > 0)) || return 0
  for pid in ${MATRIX_WORKER_PIDS[@]+"${MATRIX_WORKER_PIDS[@]}"}; do
    kill -TERM "-$pid" 2>/dev/null || true
  done
  sleep 3
  for pid in ${MATRIX_WORKER_PIDS[@]+"${MATRIX_WORKER_PIDS[@]}"}; do
    kill -KILL "-$pid" 2>/dev/null || true
  done
  MATRIX_WORKER_PIDS=()
  MATRIX_WORKER_SLOTS=()
}

# The EXIT hook `cleanup` calls when this file was reached.
# shellcheck disable=SC2329  # invoked by cleanup in run-eval-lifecycle.sh
matrix_cleanup() {
  matrix_kill_workers
  if [[ -n $MATRIX_STATUS_DIR ]]; then
    rm -rf "$MATRIX_STATUS_DIR"
    MATRIX_STATUS_DIR=""
  fi
}

# One cell's buffered log, emitted as a single write. Group workers share the
# run's stdout, so writing a cell's lines as they are produced would splice one
# cell's failure reason into another's. The buffer is a handful of lines — the
# per-cell result and, on a failure, the bounded stderr tail — and every line of
# it already names its own cell.
#
# One `write` is indivisible on the regular file the scheduled launchd job
# redirects to. Through a pipe — an operator's own `run-eval.sh | tee run.log` —
# the kernel only guarantees it up to `PIPE_BUF`, 4096 bytes, and a failing
# cell's block can pass that: `log_stderr_tail` alone allows 4000 bytes of
# stderr, re-prefixed line by line. Two cells failing at once on a piped stdout
# can still interleave. Redirect to a file rather than pipe when that matters.
matrix_flush_cell_log() {
  local file="$1" buffered="" line
  if [[ ! -s $file ]]; then
    rm -f "$file"
    return 0
  fi
  while IFS= read -r line || [[ -n $line ]]; do
    buffered="$buffered$line"$'\n'
  done <"$file"
  printf '%s' "$buffered"
  rm -f "$file"
}

# One PR group: its cells, in plan order, one at a time. The outcome of each
# goes to its own status file rather than into this worker's exit code, because
# a group ends with some cells done and some failed and the parent has to
# account for both. A worker that reaches the matrix deadline stops starting
# cells and records that it did.
matrix_group_worker() {
  local pr="$1" status_dir="$2" slot="$3" rows="$4"
  local row cell_id condition draw model effort finder finder_report prompt_kind
  local cell=0 cell_log outcome
  while IFS= read -r row || [[ -n $row ]]; do
    [[ -n $row ]] || continue
    cell=$((cell + 1))
    IFS=$'\t' read -r cell_id _ condition draw model effort finder \
      finder_report prompt_kind <<<"$row"
    if [[ $(($(date +%s) - STARTED)) -ge $MATRIX_DEADLINE ]]; then
      : >"$status_dir/deadline"
      return 0
    fi
    cell_log="$status_dir/$slot.$cell.log"
    outcome="done"
    run_cell "$cell_id" "$pr" "$condition" "$draw" "$model" "$effort" \
      "$finder" "$finder_report" "$prompt_kind" >"$cell_log" 2>&1 ||
      outcome=failed
    matrix_flush_cell_log "$cell_log"
    printf '%s\n' "$outcome" >"$status_dir/$slot.$cell.status"
  done <<<"$rows"
}

# Start one group in the background, in a process group of its own. Monitor mode
# is what gives the job that group; it is switched off again immediately, and
# Bash makes the subshell the group leader, so its pid is also the group id.
matrix_start_group() {
  local status_dir="$1" slot="$2" pr="$3" rows="$4" monitor_off=0 worker
  local pid_file="$status_dir/$slot.pid"
  case "$-" in
    *m*) : ;;
    *) monitor_off=1 ;;
  esac
  set -m
  {
    # Job control belongs to the parent's scheduling, not to the group: inside
    # the worker `run_bounded` turns it on and off again around each bounded
    # child, which is the only place a cell needs a process group of its own.
    set +m
    MATRIX_WORKER_PID_FILE="$pid_file"
    trap 'matrix_worker_kill_children "$MATRIX_WORKER_PID_FILE"; exit 143' TERM INT
    matrix_group_worker "$pr" "$status_dir" "$slot" "$rows"
    : >"$status_dir/$slot.group"
  } </dev/null &
  worker=$!
  printf '%s\n' "$worker" >"$pid_file"
  MATRIX_WORKER_PIDS+=("$worker")
  MATRIX_WORKER_SLOTS+=("$slot")
  if ((monitor_off)); then
    set +m
  fi
}

# Block until fewer than $2 group workers are still running; $2 of 1 waits for
# all of them. A worker announces itself finished with a marker file, because
# `kill -0` alone cannot tell a live worker from one that exited and has not
# been reaped yet. A worker that was killed writes no marker, so a pid Bash has
# already reaped counts as finished too — without that second signal a SIGKILLed
# group would hold the whole run here forever. Its cells then have no status
# file, and the accounting below reports them as a partial matrix.
matrix_wait_for_capacity() {
  local status_dir="$1" limit="$2" index live slot pid
  local -a live_pids live_slots
  while :; do
    live_pids=()
    live_slots=()
    live=${#MATRIX_WORKER_PIDS[@]}
    for ((index = 0; index < live; index++)); do
      slot="${MATRIX_WORKER_SLOTS[$index]}"
      pid="${MATRIX_WORKER_PIDS[$index]}"
      if [[ -f "$status_dir/$slot.group" ]] || ! kill -0 "$pid" 2>/dev/null; then
        wait "$pid" 2>/dev/null || true
        continue
      fi
      live_pids+=("$pid")
      live_slots+=("$slot")
    done
    # Replaced, never cleared and then refilled: a TERM or INT trap runs between
    # two commands, and one that landed in that gap would find an empty pid
    # array and signal nothing while the workers it names are still live.
    if ((${#live_pids[@]} > 0)); then
      MATRIX_WORKER_PIDS=("${live_pids[@]}")
      MATRIX_WORKER_SLOTS=("${live_slots[@]}")
    else
      MATRIX_WORKER_PIDS=()
      MATRIX_WORKER_SLOTS=()
    fi
    ((${#MATRIX_WORKER_PIDS[@]} < limit)) && return 0
    sleep 1
  done
}

# Run the whole planned matrix. Sets DONE, FAILED, TOTAL and STATUS_NOTE.
run_matrix() {
  local row cell_id pr condition draw model effort finder finder_report
  local prompt_kind extra index count found next file outcome
  local -a group_prs=() group_rows=()

  TOTAL=0
  DONE=0
  FAILED=0
  # The whole matrix is read before a cell starts, and the plan's order is kept
  # inside every group, so a run's cell ids and their per-PR order are what a
  # serial run produced. Grouping only decides what may overlap.
  while IFS= read -r row || [[ -n $row ]]; do
    [[ -n $row ]] || continue
    IFS=$'\t' read -r cell_id pr condition draw model effort finder \
      finder_report prompt_kind extra <<<"$row"
    if [[ -n ${extra:-} ]]; then
      fail "the plan produced a cell row with an extra field: $extra"
    fi
    TOTAL=$((TOTAL + 1))
    found=0
    count=${#group_prs[@]}
    for ((index = 0; index < count; index++)); do
      if [[ ${group_prs[$index]} == "$pr" ]]; then
        group_rows[index]="${group_rows[$index]}$row"$'\n'
        found=1
        break
      fi
    done
    if ((found == 0)); then
      group_prs+=("$pr")
      group_rows+=("$row"$'\n')
    fi
  done < <(cell_rows)

  MATRIX_STATUS_DIR="$(mktemp -d "$TMPROOT/review-eval-matrix.XXXXXX")" ||
    fail "could not create the matrix status directory"
  log "scheduling ${#group_prs[@]} PR groups, up to $MATRIX_PR_CONCURRENCY at once"

  trap 'matrix_kill_workers; exit 143' TERM INT
  count=${#group_prs[@]}
  for ((next = 0; next < count; next++)); do
    matrix_wait_for_capacity "$MATRIX_STATUS_DIR" "$MATRIX_PR_CONCURRENCY"
    matrix_start_group "$MATRIX_STATUS_DIR" "$next" "${group_prs[$next]}" \
      "${group_rows[$next]}"
  done
  matrix_wait_for_capacity "$MATRIX_STATUS_DIR" 1
  trap - TERM INT

  for file in "$MATRIX_STATUS_DIR"/*.status; do
    [[ -f $file ]] || continue
    outcome=""
    read -r outcome <"$file" || true
    case "$outcome" in
      done) DONE=$((DONE + 1)) ;;
      *) FAILED=$((FAILED + 1)) ;;
    esac
  done
  # A cell with no status file never started. That is the deadline, or a worker
  # that was killed; both are a partial matrix, and the note has to say which.
  # shellcheck disable=SC2034  # STATUS_NOTE is read by run-eval.sh
  if [[ -f "$MATRIX_STATUS_DIR/deadline" ]]; then
    STATUS_NOTE="matrix deadline of ${MATRIX_DEADLINE}s reached"
    log "matrix deadline reached; the matrix is partial"
  elif ((DONE + FAILED < TOTAL)); then
    STATUS_NOTE="$((TOTAL - DONE - FAILED)) cells recorded no outcome"
    log "the matrix is partial; $((TOTAL - DONE - FAILED)) cells recorded no outcome"
  fi
  rm -rf "$MATRIX_STATUS_DIR"
  MATRIX_STATUS_DIR=""
}
