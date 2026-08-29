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
  if [[ $SPEC_TEMP -eq 1 && -n $SPEC ]]; then
    git -C "$REPO" worktree remove --force "$SPEC" >/dev/null 2>&1 || true
    # The spec lives under the git directory rather than under `$TMPDIR`, so no
    # OS sweep ever collects what a failed removal leaves behind.
    rm -rf "$SPEC"
    git -C "$REPO" worktree prune >/dev/null 2>&1 || true
  fi
  if [[ -n $SHIM ]]; then
    rm -rf "$SHIM"
  fi
  if [[ -n $SKILL_SNAPSHOT ]]; then
    rm -rf "$SKILL_SNAPSHOT"
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

# --- a failed run still leaves a trace ---------------------------------------

# The scoring artifacts a failed run must not publish beside its row.
#
# `--score` writes `calibration.json` before the first cell and one
# `result-<pr>-<condition>-<draw>.json` per cell it scores, and both survive the
# failure that follows: a judge that dies mid-pass leaves the cells already
# scored, and a scored row that then fails `--validate` leaves the whole set.
# `failedRow` publishes zero placeholders for the conditions, the calibration
# and the cost, so the freshness workflow's `--revalidate-appended` job — which
# recomputes a row from exactly these files — reads the leftovers as this run's
# real numbers and rejects the failure PR. Clear them. `cells/` stays: it is the
# paid resume cache a retry seeds from, and `KEEP_CELLS` keeps it out of the
# commit rather than off the disk.
clear_scoring_artifacts() {
  rm -f "$RUN_DIR"/calibration.json "$RUN_DIR"/result-*.json
}

# Appends the status:failed trace row. Returns non-zero when the row was not
# recorded, which is the one case the caller must not report as a clean run.
write_failed_row() {
  local reason="$1"
  local row="$RUN_DIR/row.json"
  clear_scoring_artifacts
  # shellcheck disable=SC2016  # the single-quoted block is node source
  node --input-type=module -e '
    const [planPath, contractPath, spec, ledger, rowPath, reason] = process.argv.slice(1);
    (async () => {
      const fixtures = await import(`${spec}/scripts/review/review-eval-fixtures.mjs`);
      const shape = await import(`${spec}/scripts/review/review-eval-result-shape.mjs`);
      const ledgerMod = await import(`${spec}/scripts/review/review-eval-ledger.mjs`);
      const fs = await import("node:fs");
      const { contract, digest } = fixtures.loadContract(contractPath);
      const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
      const row = shape.failedRow({ plan, contract, contractDigest: digest, reason });
      fs.writeFileSync(rowPath, `${JSON.stringify(row, null, 2)}\n`);
      ledgerMod.appendRow(ledger, row);
    })().catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    });
  ' "$PLAN_JSON" "$CONTRACT" "$SPEC" "$LEDGER" "$row" "$reason" || {
    log "could not write the failed row: $reason"
    return 1
  }
  log "appended a status:failed ledger row — $reason"
}

# Refuse a detail_dir that must never reach `rm -rf "$REPO/$detail"`.
#
# `json_field` prints `String(doc[key])`, so a missing key arrives as the word
# "undefined" and a JSON null as "null" — neither is empty, and both would name
# a directory in the checkout root. An empty value is worse: it makes the
# removal target `$REPO/` and deletes the checkout before `cp` can fail. The
# check is on path components, so a legitimate name that merely contains ".."
# passes while a component that climbs out of the checkout does not.
# It runs in the current shell, never in a command substitution: `fail` exits,
# and inside `$(...)` that would exit the subshell and let the caller continue.
require_safe_detail() {
  local value="$1" component
  local -a parts
  case "$value" in
    "" | undefined | null)
      fail "row.json has no usable detail_dir (got '$value'); refusing to touch $REPO"
      ;;
    /*)
      fail "detail_dir must be relative to the checkout, not absolute: $value"
      ;;
  esac
  IFS=/ read -r -a parts <<<"$value"
  for component in "${parts[@]}"; do
    if [[ $component == ".." ]]; then
      fail "detail_dir must not climb out of the checkout: $value"
    fi
  done
}

# Copy the run detail into the checkout and publish the row, or print the
# commands that would. Sets PUBLISHED=1 only when a PR was actually opened.
# $1 is the verdict the branch and commit are named for; $2 is the body file
# inside the detail directory.
PUBLISHED=0

# The raw cells never belong in the PR — they are megabytes of model transcript
# — but the run directory IS the resume cache, and normally it is the very
# directory being published. Deleting `cells` there makes a retry re-spend the
# whole paid matrix. So the cells are kept out of the commit with an exclude
# pathspec instead, and removed from disk only once the run they belong to can
# no longer be resumed. `abort` sets this to 1: that run ended before it scored,
# and its completed cells are exactly what the retry must reuse.
KEEP_CELLS=0

publish_row() {
  local verdict="$1" body_file="$2" detail branch title
  local -a add_argv
  PUBLISHED=0
  detail="$(json_field "$RUN_DIR/row.json" detail_dir)"
  require_safe_detail "$detail"
  mkdir -p "$REPO/$(dirname "$detail")"
  if [[ "$RUN_DIR" != "$REPO/$detail" ]]; then
    rm -rf "${REPO:?}/$detail"
    cp -R "$RUN_DIR" "$REPO/$detail"
    # The copy is not the cache, so its cells go whatever this run's fate.
    rm -rf "${REPO:?}/$detail/cells"
  elif [[ $KEEP_CELLS -eq 0 ]]; then
    rm -rf "${REPO:?}/$detail/cells"
  else
    log "keeping the resume cache at $REPO/$detail/cells for a retry"
  fi
  # Excluded whether or not the directory is still there: a negative pathspec
  # that matches nothing is not an error, and `$detail` matches on its own.
  add_argv=(docs/evals/review-skill-ledger.jsonl "$detail" ":(exclude)$detail/cells")

  # The same pathspec goes on the commit, not just the add. The pre-flight only
  # asks whether `$LEDGER` is dirty, and a --skill-ref candidate run skips even
  # that, so the operator's index can hold unrelated staged work — and a
  # pathless `git commit` sweeps the whole index into the ledger PR, publishing
  # code or docs nobody meant to send. Naming the paths makes this a partial
  # commit: only the ledger and the detail directory go in, and anything else
  # the operator staged stays staged in their checkout.

  # The detail directory basename already identifies this run: date, the first
  # eight of the comparability key, the kind, and the skill digest. A date-only
  # branch collides the moment two runs finish on the same UTC day — which the
  # candidate procedure requires, an installed run and a --skill-ref run in one
  # sitting — and the collision surfaces at `git checkout -b` or at the push,
  # after the paid run and the ledger append are already done.
  branch="eval/review-skill-$(basename "$detail")"
  title="Review-skill eval $(date -u +%Y-%m-%d): $verdict"

  printf '\n----- ledger PR -----\n'
  printf 'git -C %q checkout -b %q\n' "$REPO" "$branch"
  printf 'git -C %q add %q %q %q\n' "$REPO" "${add_argv[@]}"
  printf 'git -C %q commit -m %q -- %q %q %q\n' "$REPO" "chore(evals): review-skill eval $verdict" "${add_argv[@]}"
  printf 'git -C %q push -u origin %q\n' "$REPO" "$branch"
  printf 'gh pr create --repo mento-protocol/monitoring-monorepo --title %q --body-file %q\n' \
    "$title" "$REPO/$detail/$body_file"
  printf '\nNo auto-merge. A human reads the report and approves.\n'

  if [[ $OPEN_PR -eq 1 ]]; then
    log "opening the ledger PR"
    if git -C "$REPO" checkout -b "$branch" &&
      git -C "$REPO" add "${add_argv[@]}" &&
      git -C "$REPO" commit -m "chore(evals): review-skill eval $verdict" -- "${add_argv[@]}" &&
      git -C "$REPO" push -u origin "$branch" &&
      gh pr create --repo mento-protocol/monitoring-monorepo \
        --title "$title" --body-file "$REPO/$detail/$body_file"; then
      PUBLISHED=1
      keep_baseline_copy
    else
      log "the ledger PR could not be opened; the commands above are the recovery path"
    fi
  fi
}

# The candidate procedure runs the installed skill and the candidate in one
# sitting and compares them with --against. Publishing leaves the checkout on
# the eval branch, and the candidate run must branch from main instead — but
# both the appended ledger row and the detail directory live only on that eval
# branch, so `git checkout main` deletes them and an --against that names the
# row's executed_at then resolves against a ledger that no longer holds it. The
# candidate's pre-flight aborts before the candidate spends anything, which is
# the right failure and still a wasted installed run.
#
# --against also takes a row file, and a row carries every bit the comparison
# reads: `buildVsBaseline` pairs the two `per_defect` vectors and needs no
# detail directory of its own. So keep one copy outside the checkout, where no
# branch switch can reach it, and print the exact argument to pass.
keep_baseline_copy() {
  local kept="$TMPROOT/review-eval-installed-row.json"
  # Only an installed run is ever the baseline, and only a complete one. A
  # candidate run writing here would overwrite the anchor of its own sitting.
  if [[ -n $SKILL_REF ]] ||
    [[ $(json_field "$RUN_DIR/row.json" status) != "complete" ]]; then
    return 0
  fi
  cp "$RUN_DIR/row.json" "$kept" || {
    log "could not keep a baseline copy of the row at $kept"
    return 0
  }
  log "baseline copy for a same-sitting candidate run: --against $kept"
}

abort() {
  # The failed row goes into the checkout's ledger, so leaving it there and
  # exiting zero wedges the schedule: launchd reads a healthy run while the next
  # one refuses to start against a ledger with uncommitted changes, and nothing
  # ever reaches a PR or the freshness workflow. Publish the row the way a
  # scored one is published, and exit zero only when a PR actually carries it.
  # Otherwise exit non-zero with the commands that finish the job printed above.
  # This run never scored, so its completed cells are still worth money and are
  # the only thing that makes a retry cheap. Publishing must not delete them.
  KEEP_CELLS=1
  write_failed_row "$1" ||
    fail "the run failed and the failure row could not be appended: $1"
  # shellcheck disable=SC2016  # the backticks are markdown in the PR body
  printf '# Review-skill eval: run failed\n\n%s\n\nThe row is `status: failed`, `verdict: INCOMPLETE`. It exists so the run leaves a trace; it scores nothing.\n' \
    "$1" >"$RUN_DIR/failure.md"
  publish_row INCOMPLETE failure.md
  if [[ $PUBLISHED -eq 1 ]]; then
    exit 0
  fi
  fail "the run failed, the row was appended to $LEDGER, and no PR carries it yet; run the commands above (or re-run with --pr) — the next run refuses to start while that ledger has uncommitted changes"
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
