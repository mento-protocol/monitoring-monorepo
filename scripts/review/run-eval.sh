#!/usr/bin/env bash
# Run the review-skill evaluation end to end. This is the only script that
# spends model quota, and it never runs in CI.
#
# The contract that scores a run is the committed one: the script adds a
# detached worktree of origin/main and reads the fixtures, truth, prompts and
# scorer from there, so a dirty working tree cannot silently change what is
# being measured. --skill-ref is the deliberate exception for evaluating a
# candidate skill; it uses the current checkout and stamps dirty into the row.
#
# Leak-proofing during a contestant run: every GitHub token variable is unset,
# a gh that refuses is placed first on PATH, and git runs with no global or
# system config, no credential helper, no prompt, no askpass and no protocol
# but file. This is defense in depth, not containment — the model API hosts
# stay reachable because codex and claude need them, and a cell runs with Bash.
# The stronger controls are structural: the fixture is a detached checkout at a
# 2026-08 commit, the answer key exists only on main, and a transcript that
# names a withheld commit is scored as a hard leak signal.
#
# Every cell writes its own output directory and is resumable. A failed cell is
# never cached: a session-limit error returns in seconds and, cached, would
# permanently score as a zero-recall review. A cached cell is reused only when
# its fingerprint — skill digest, kind, contract digest — matches this run.
# A run that ends before it scores keeps those cells so the retry reuses them;
# they never reach the PR.
#
# The detail directory belongs to one execution. A run killed before it recorded
# anything is retried into the same directory and reuses its cells; once a ledger
# row points at that directory it is evidence, so the next execution takes the
# next name and seeds its cells from the old one instead of overwriting a row's
# plan, results, report and publication branch.
#
# One run at a time. The fixture cache and the ledger are shared, so the script
# takes a lock under --cache-dir and refuses to start while another run holds
# it, rather than letting two runs rewrite each other's fixture checkouts.
#
# Usage:
#   run-eval.sh [--kind full|canary|auto] [--skill-ref PATH] [--pr] [--no-pr]
#               [--repo PATH] [--cache-dir DIR] [--deadline SECONDS]
#               [--against REF]
#
# --against names the baseline row this run is scored, validated and reported
# against: a row file path or an executed_at prefix. The candidate procedure
# needs it — a --skill-ref run must be compared against the installed run from
# the same sitting, not against the ledger's stored anchor, or the comparison
# carries whatever the model did between the anchor and today.
#
# --deadline bounds the whole run, cells and scoring together. Three quarters of
# it start cells and bound each finder and contestant process; the rest is
# reserved for the judge pass, which is itself bounded.
#
# Default is --no-pr: the branch, push and gh pr create commands are printed,
# not executed. Every run appends its row to the checkout's ledger — a scored
# one and the status:failed row of a run that fails alike — so both publish the
# same way, and both exit non-zero when the run could only print the commands.
# Until they are run the next run refuses to start against a ledger with
# uncommitted changes, and the scheduled job runs without --pr.

set -euo pipefail

KIND="auto"
SKILL_REF=""
OPEN_PR=0
REPO=""
CACHE_DIR="${HOME}/.cache/mento-review-eval"
DEADLINE=21600
AGAINST=""
SPEC=""
SPEC_TEMP=0
SHIM=""
SKILL_SNAPSHOT=""
LOCK_DIR=""
RUN_DIR=""
PLAN_JSON=""
STARTED=0
STATUS_NOTE=""

fail() {
  printf 'FATAL: %s\n' "$*" >&2
  exit 1
}

log() {
  printf '%s  %s\n' "$(date -u +%H:%M:%S)" "$*"
}

require_value() {
  if [[ -z ${2:-} || ${2:-} == --* ]]; then
    fail "$1 requires a value"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --kind)
      require_value "$1" "${2:-}"
      KIND="$2"
      shift 2
      ;;
    --skill-ref)
      require_value "$1" "${2:-}"
      SKILL_REF="$2"
      shift 2
      ;;
    --repo)
      require_value "$1" "${2:-}"
      REPO="$2"
      shift 2
      ;;
    --cache-dir)
      require_value "$1" "${2:-}"
      CACHE_DIR="$2"
      shift 2
      ;;
    --against)
      require_value "$1" "${2:-}"
      AGAINST="$2"
      shift 2
      ;;
    --deadline)
      require_value "$1" "${2:-}"
      # The matrix loop compares this arithmetically. A word evaluates to 0
      # there and silently ends the run before its first cell; a suffixed
      # duration such as `6h` aborts on an arithmetic syntax error. Refuse
      # both here, where the message can name the cause.
      [[ $2 =~ ^[0-9]+$ && $2 -gt 0 ]] ||
        fail "--deadline must be a positive whole number of seconds"
      DEADLINE="$2"
      shift 2
      ;;
    --pr)
      OPEN_PR=1
      shift
      ;;
    --no-pr)
      OPEN_PR=0
      shift
      ;;
    -h | --help)
      sed -n '2,57p' "$0"
      exit 0
      ;;
    *) fail "unknown argument: $1" ;;
  esac
done

case "$KIND" in
  full | canary | auto) ;;
  *) fail "--kind must be full, canary, or auto" ;;
esac

if [[ -z $REPO ]]; then
  REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi
[[ -d "$REPO/.git" || -f "$REPO/.git" ]] || fail "$REPO is not a git checkout"

LEDGER="$REPO/docs/evals/review-skill-ledger.jsonl"
[[ -f $LEDGER ]] || fail "ledger $LEDGER is missing"

command -v claude >/dev/null 2>&1 || fail "claude CLI is not on PATH"
command -v codex >/dev/null 2>&1 || fail "codex CLI is not on PATH"
command -v node >/dev/null 2>&1 || fail "node is not on PATH"

TMPROOT="${TMPDIR:-/tmp}"

# shellcheck disable=SC2329  # invoked by the EXIT trap below
cleanup() {
  local code=$?
  if [[ $SPEC_TEMP -eq 1 && -n $SPEC ]]; then
    git -C "$REPO" worktree remove --force "$SPEC" >/dev/null 2>&1 || true
  fi
  if [[ -n $SHIM ]]; then
    rm -rf "$SHIM"
  fi
  if [[ -n $SKILL_SNAPSHOT ]]; then
    rm -rf "$SKILL_SNAPSHOT"
  fi
  if [[ -n $LOCK_DIR ]]; then
    rm -rf "$LOCK_DIR"
  fi
  return "$code"
}
trap cleanup EXIT

# --- the run lock ------------------------------------------------------------

# One fixture cache, one ledger, one run at a time. Every cell resets and cleans
# the shared per-PR checkout, stages or purges `.skill` in it, and then runs a
# model inside it. Two runs that overlap — the launchd job starting while a
# manual run is mid-matrix, or two manual runs — take turns rewriting the same
# tree, so one scores a review of the other's skill state and neither result
# means anything. Both also append to the same ledger.
#
# mkdir is the lock: it is atomic on every filesystem this runs on and needs no
# flock, which macOS does not ship. The holder's pid goes inside so a lock left
# behind by a SIGKILL can be told from a live run and reclaimed. The pid is
# written before LOCK_DIR is set — the holder must be identifiable the instant
# the directory exists, or a second run arriving in that window reads no pid and
# reclaims a live lock. The read side waits for it for the same reason.
# `kill -0` on a recycled pid can keep a stale lock held; that fails closed, and
# the message names the directory to remove.
acquire_run_lock() {
  local lock="$CACHE_DIR/run.lock" holder="" waited=0
  mkdir -p "$CACHE_DIR" || fail "the fixture cache $CACHE_DIR is not writable"
  if ! mkdir "$lock" 2>/dev/null; then
    while ((waited < 5)); do
      waited=$((waited + 1))
      holder="$(cat "$lock/pid" 2>/dev/null || true)"
      if [[ $holder =~ ^[0-9]+$ ]]; then
        break
      fi
      sleep 0.2
    done
    if [[ $holder =~ ^[0-9]+$ ]] && kill -0 "$holder" 2>/dev/null; then
      fail "another review eval (pid $holder) holds $lock; a run rewrites the shared fixtures, so wait for it to finish"
    fi
    log "reclaiming a run lock left behind by pid ${holder:-unknown}"
    rm -rf "$lock"
    mkdir "$lock" 2>/dev/null ||
      fail "could not take the run lock at $lock; remove it if no eval is running"
  fi
  printf '%s\n' "$$" >"$lock/pid"
  LOCK_DIR="$lock"
}

acquire_run_lock

# --- the spec worktree -------------------------------------------------------

if [[ -n $SKILL_REF ]]; then
  [[ -d $SKILL_REF ]] || fail "--skill-ref $SKILL_REF is not a directory"
  SKILL_REF="$(cd "$SKILL_REF" && pwd)"
  SPEC="$REPO"
  log "candidate run: spec is the current checkout, skill is $SKILL_REF"
else
  git -C "$REPO" fetch origin --tags --quiet
  # The spec worktree pins the contract at origin/main, but the ledger, the
  # baseline it resolves, and the branch the PR commands cut all come from this
  # checkout. On a feature branch or behind origin/main the scheduled run would
  # plan against a ledger that is missing newer rows, score against the wrong
  # anchor, and offer to commit the row on top of unrelated work. Refuse before
  # a cell spends anything; the operator's own runs use --skill-ref.
  HEAD_SHA="$(git -C "$REPO" rev-parse HEAD)"
  MAIN_SHA="$(git -C "$REPO" rev-parse origin/main)"
  if [[ $HEAD_SHA != "$MAIN_SHA" ]]; then
    fail "the checkout at $REPO is at ${HEAD_SHA:0:8}, not origin/main (${MAIN_SHA:0:8}); check out main and pull before a default run, or pass --skill-ref for a candidate run"
  fi
  if ! git -C "$REPO" diff --quiet -- "$LEDGER" ||
    ! git -C "$REPO" diff --cached --quiet -- "$LEDGER"; then
    fail "$LEDGER has uncommitted changes; a run appends to it, so commit or discard them first"
  fi
  SPEC="$(mktemp -d "$TMPROOT/review-eval-spec.XXXXXX")"
  rm -rf "$SPEC"
  git -C "$REPO" worktree add --detach "$SPEC" origin/main --quiet
  SPEC_TEMP=1
  log "spec worktree at $SPEC ($(git -C "$SPEC" rev-parse --short HEAD))"
fi

CLI="$SPEC/scripts/review/review-eval.mjs"
CONTRACT="$SPEC/docs/evals/review-skill-fixtures.json"
ORCHESTRATOR="$SPEC/scripts/review/run-eval.sh"
[[ -f $CLI ]] || fail "$CLI is missing; the spec worktree has no harness"

# This script decides the contestant's tools, turn limit, skill staging, finder
# truncation and environment, so its bytes are hashed into `comparability_key`
# and into every cell fingerprint — from the spec worktree, which is where the
# harness reads all of its inputs. Running an edited copy against a clean spec
# would record the spec's digest for a matrix this file actually shaped, which
# is the silent pairing the digest exists to prevent.
if ! cmp -s "${BASH_SOURCE[0]}" "$ORCHESTRATOR"; then
  fail "the running orchestrator differs from $ORCHESTRATOR, whose digest the row would record; commit or stash the change, or pass --skill-ref to evaluate this checkout"
fi

# --- plan --------------------------------------------------------------------

node "$CLI" --root "$SPEC" --ledger "$LEDGER" --check-fixtures --offline >/dev/null ||
  fail "the committed contract does not validate"

# An unresolvable --against would otherwise surface at --score, after the
# matrix has already spent its hours and dollars. Resolve it now with the same
# logic --score consumes; the resolved row is re-derived there, not cached here.
if [[ -n $AGAINST ]]; then
  # shellcheck disable=SC2016  # the single-quoted block is node source
  node --input-type=module -e '
    const [spec, ledger, reference] = process.argv.slice(1);
    const { readLedger } = await import(`${spec}/scripts/review/review-eval-ledger.mjs`);
    const { resolveRowReference } = await import(`${spec}/scripts/review/review-eval-result-shape.mjs`);
    resolveRowReference({ reference, rows: readLedger(ledger), repoRoot: spec });
  ' "$SPEC" "$LEDGER" "$AGAINST" >/dev/null 2>&1 ||
    fail "--against $AGAINST does not resolve to exactly one ledger row or row file"
fi

PLAN_OUT="$(mktemp "$TMPROOT/review-eval-plan.XXXXXX")"
PLAN_ARGS=(--root "$SPEC" --ledger "$LEDGER" --plan --kind "$KIND" --json)
if [[ -n $SKILL_REF ]]; then
  PLAN_ARGS+=(--skill-ref "$SKILL_REF")
fi
node "$CLI" "${PLAN_ARGS[@]}" >"$PLAN_OUT" || fail "planning failed"

# Read one top-level string field out of a JSON file.
json_field() {
  # shellcheck disable=SC2016  # the single-quoted block is node source
  node -e '
    const doc = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(String(doc[process.argv[2]]));
  ' "$1" "$2"
}

# The plan directory is also the resume cache, so it must outlive this process.
# Planned against the spec worktree it would land inside a temporary directory
# the EXIT trap removes, and an interrupted run would re-spend the whole matrix
# instead of reusing its completed cells. Plan again into the persistent detail
# directory under the real checkout, with the kind the first plan resolved.
# Planning reads the contract and the ledger and spends nothing.
DETAIL_DIR="$(json_field "$PLAN_OUT" detail_dir)"
KIND="$(json_field "$PLAN_OUT" kind)"
RUN_DIR="$REPO/$DETAIL_DIR"
PLAN_ARGS=(--root "$SPEC" --ledger "$LEDGER" --plan --kind "$KIND" --json
  --out "$RUN_DIR")
if [[ -n $SKILL_REF ]]; then
  PLAN_ARGS+=(--skill-ref "$SKILL_REF")
fi
node "$CLI" "${PLAN_ARGS[@]}" >"$PLAN_OUT" ||
  fail "planning into $RUN_DIR failed"
RUN_DIR="$(json_field "$PLAN_OUT" plan_dir)"
PLAN_JSON="$RUN_DIR/plan.json"
# shellcheck disable=SC2016  # the single-quoted block is node source
CELL_COUNT="$(node -e '
  const plan = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(`${plan.cells.length} cells, about $${plan.estimate.claude_usd}`);
' "$PLAN_JSON")"
log "plan $KIND: $CELL_COUNT"
log "detail directory $RUN_DIR"

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
# the group id is read back so a shell that gave the job no group of its own
# falls back to the bare pid rather than signalling this script's own group.
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
  local own_pgid child_pgid target="$pid"
  own_pgid="$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')"
  child_pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
  if [[ -n $child_pgid && -n $own_pgid && $child_pgid != "$own_pgid" ]]; then
    target="-$child_pgid"
  fi
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
  kill -TERM "$watcher" 2>/dev/null || true
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

# Appends the status:failed trace row. Returns non-zero when the row was not
# recorded, which is the one case the caller must not report as a clean run.
write_failed_row() {
  local reason="$1"
  local row="$RUN_DIR/row.json"
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

# --- the gh-refusing shim and the per-cell credential scrub -------------------

SHIM="$(mktemp -d "$TMPROOT/review-eval-shim.XXXXXX")"
cat >"$SHIM/gh" <<'SHIM_EOF'
#!/bin/sh
echo "gh is disabled during evaluation" >&2
exit 1
SHIM_EOF
chmod +x "$SHIM/gh"
mkdir -p "$SHIM/gh-empty"

# Every model call in a cell runs under this prefix. It unsets the four GitHub
# token variables, points gh at an empty config directory, and takes git's
# credential helper, terminal prompt, askpass and non-file protocols away, so a
# cell cannot fetch the withheld fix commit with the operator's credentials.
# This is defense in depth, not containment: the network stays open because the
# model API must be reachable. Naming a withheld commit is a hard leak signal.
#
# `OLDPWD` goes with them, and it is the one that hands over a path rather than
# a credential. Bash exports it, and `run_in_fixture` sets it by `cd`-ing from
# the invocation directory — the repository root, per the runbook — into the
# fixture, so the contestant inherits the source checkout's location. The answer
# key lives there, frozen on main under docs/evals/review-skill-truth/, and a
# cell that reads it copies out every defect while emitting no PR number,
# reviewer login or withheld SHA for `leakSignals()` to catch: the run scores a
# recall it never earned. A shell tool re-initializes `OLDPWD` for itself, but
# `claude` and `codex` are not shells and carry the inherited value in their own
# environment, so cut it at the boundary rather than lean on that.
# `PWD` stays, because it is the fixture the cell is supposed to be reviewing.
CELL_ENV=(env
  -u GH_TOKEN -u GITHUB_TOKEN -u GITHUB_PERSONAL_ACCESS_TOKEN
  -u GH_ENTERPRISE_TOKEN -u OLDPWD)
# The documented invocation is `pnpm review:eval:run`, and pnpm exports its own
# family of path-bearing variables into every script it runs — INIT_CWD,
# PNPM_SCRIPT_SRC_DIR, npm_package_json, npm_config_local_prefix and more, each
# carrying the checkout the answer key lives in. The family is open-ended, so
# scrub it by name pattern from the live environment instead of enumerating.
while IFS= read -r cell_env_var; do
  CELL_ENV+=(-u "$cell_env_var")
done < <(compgen -e | grep -E '^(npm_|PNPM_|INIT_CWD$|NODE_PATH$)' || true)
CELL_ENV+=(
  GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=
  GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/false GIT_ALLOW_PROTOCOL=file
  GH_CONFIG_DIR="$SHIM/gh-empty" PATH="$SHIM:$PATH")

# One scrubbed model call inside one fixture. `run_bounded` needs a command it
# can start in the background and signal, which a `(cd … && …)` subshell inside
# a command substitution is not; the `cd` is confined to that background job.
# shellcheck disable=SC2329  # started by name from run_bounded
run_in_fixture() {
  local fixture="$1"
  shift
  cd "$fixture" || return 1
  "${CELL_ENV[@]}" "$@"
}

# --- skill staging -----------------------------------------------------------

SKILL_SRC="${SKILL_REF:-${REVIEW_EVAL_SKILL_DIR:-$HOME/.claude/skills/review}}"
[[ -f "$SKILL_SRC/SKILL.md" ]] || fail "no SKILL.md under $SKILL_SRC"

# The skill is the treatment under test, and the plan records its digest once
# for the whole matrix — a cached cell's fingerprint carries that one digest
# too. A full run takes about two hours, which is long enough for the operator
# to keep editing the installed skill while it runs, so staging every cell from
# the live directory would measure new content under the old digest and put two
# treatments in one row. Snapshot the skill once, refuse the run if the
# snapshot is not what was planned, and stage every cell from the snapshot.
SKILL_SNAPSHOT="$(mktemp -d "$TMPROOT/review-eval-skill.XXXXXX")"
rm -rf "$SKILL_SNAPSHOT"
cp -R "$SKILL_SRC" "$SKILL_SNAPSHOT" ||
  fail "could not snapshot the skill at $SKILL_SRC"
chmod -R u+rwX "$SKILL_SNAPSHOT"
SKILL_DIR="$SKILL_SNAPSHOT"

# shellcheck disable=SC2016  # the single-quoted block is node source
PLANNED_SKILL_DIGEST="$(node -e '
  const plan = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(String(plan.inputs.skill_digest));
' "$PLAN_JSON")" || fail "the plan carries no skill digest"
# shellcheck disable=SC2016  # the single-quoted block is node source
SNAPSHOT_SKILL_DIGEST="$(node --input-type=module -e '
  const [spec, dir] = process.argv.slice(1);
  (async () => {
    const run = await import(`${spec}/scripts/review/review-eval-run.mjs`);
    process.stdout.write(run.skillDigest(dir));
  })().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
' "$SPEC" "$SKILL_SNAPSHOT")" || fail "could not digest the skill snapshot"
[[ $SNAPSHOT_SKILL_DIGEST == "$PLANNED_SKILL_DIGEST" ]] ||
  fail "the skill at $SKILL_SRC changed after planning (planned ${PLANNED_SKILL_DIGEST:0:8}, staged ${SNAPSHOT_SKILL_DIGEST:0:8}); re-run to plan against it"

purge_skill() {
  local fixture="$1"
  if [[ -d "$fixture/.skill" ]]; then
    chmod -R u+rwX "$fixture/.skill" 2>/dev/null || true
    rm -rf "$fixture/.skill"
  fi
}

# The first instruction line of a SKILL.md, frontmatter stripped. It is the one
# byte sequence a correctly staged preamble must carry, so it is what verifies
# the staging below.
skill_body_head() {
  awk 'NR==1 && /^---$/ {front=1; next} front && /^---$/ {front=0; next}
    !front && NF {print; exit}' "$1"
}

# The preamble mirrors the benchmark's staging exactly: frontmatter stripped,
# bundled files listed by their .skill/ path. Both halves are load-bearing —
# a skill whose references are unreachable measures a different treatment.
#
# The call site takes this on stdout inside a command substitution, so a failed
# `cp -R` would be discarded twice over and the framing printfs alone would
# still render a plausible, empty preamble. That cell would run, exit 0, cache,
# and be folded in as the skill's score. Both halves are checked here instead:
# a non-zero copy and a preamble that does not carry the snapshot's own first
# instruction line each return non-zero, and the caller fails the cell.
stage_skill() {
  local fixture="$1"
  purge_skill "$fixture"
  cp -R "$SKILL_DIR" "$fixture/.skill" || return 1
  chmod -R u+rwX "$fixture/.skill"
  local head preamble
  head="$(skill_body_head "$SKILL_DIR/SKILL.md")"
  preamble="$(
    printf 'A skill has been loaded for this task. Treat it as authoritative.\n\n'
    printf '<skill-instructions>\n'
    awk 'NR==1 && /^---$/ {front=1; next} front && /^---$/ {front=0; next} !front' \
      "$fixture/.skill/SKILL.md"
    printf '</skill-instructions>\n'
    extra="$(cd "$fixture/.skill" && find . -type f ! -name SKILL.md |
      sed 's|^\./|  - .skill/|' | LC_ALL=C sort)"
    if [[ -n $extra ]]; then
      # shellcheck disable=SC2016  # the backticks are markdown in the preamble
      printf '\nBundled files ship with these instructions in `.skill/` of your working '
      # shellcheck disable=SC2016  # the backticks are markdown in the preamble
      printf 'directory; a relative path in the instructions resolves to `.skill/<path>`:\n'
      printf '%s\n' "$extra"
    fi
  )"
  [[ -n $head && $preamble == *"$head"* ]] || return 1
  printf '%s\n' "$preamble"
}

# --- fixtures ----------------------------------------------------------------

declare -a FIXTURE_PRS=()
declare -a FIXTURE_PATHS=()
declare -a FIXTURE_HEADS=()

# `fixture_path` answers in these globals rather than on stdout. A command
# substitution would run it in a subshell, where the memo arrays below are a
# discarded copy — every cell would then miss the memo and re-run the whole
# `build-fixture.sh` leak verification for a fixture already on disk. The
# per-cell `reset_fixture` lives at the call site, so a memo hit still gets a
# clean tree at the pinned commit.
FIXTURE_PATH=""
FIXTURE_HEAD=""

fixture_path() {
  local pr="$1" index=0
  FIXTURE_PATH=""
  FIXTURE_HEAD=""
  for index in "${!FIXTURE_PRS[@]}"; do
    if [[ ${FIXTURE_PRS[$index]} == "$pr" ]]; then
      FIXTURE_PATH="${FIXTURE_PATHS[$index]}"
      FIXTURE_HEAD="${FIXTURE_HEADS[$index]}"
      return 0
    fi
  done
  # The head comes back beside the path because the per-cell reset targets it
  # explicitly. `materializeFixture` already refuses a build whose head is not
  # the contract's `first_head`, so this is the pinned commit by construction.
  local built head
  # shellcheck disable=SC2016  # the single-quoted block is node source
  built="$(node --input-type=module -e '
    const [contractPath, pr, cacheDir, srcRepo, repoRoot] = process.argv.slice(1);
    (async () => {
      const m = await import(`${repoRoot}/scripts/review/review-eval-fixtures.mjs`);
      const { contract } = m.loadContract(contractPath);
      const report = m.materializeFixture({
        contract, pr: Number(pr), cacheDir, srcRepo, repoRoot,
      });
      process.stdout.write(`${report.path}\n${report.head}\n`);
    })().catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    });
  ' "$CONTRACT" "$pr" "$CACHE_DIR" "$REPO" "$SPEC")" || return 1
  head="${built##*$'\n'}"
  built="${built%%$'\n'*}"
  if [[ -z $built || ! $head =~ ^[0-9a-f]{40}$ ]]; then
    printf 'FATAL: fixture for PR %s reported no pinned head\n' "$pr" >&2
    return 1
  fi
  FIXTURE_PRS+=("$pr")
  FIXTURE_PATHS+=("$built")
  FIXTURE_HEADS+=("$head")
  FIXTURE_PATH="$built"
  FIXTURE_HEAD="$head"
}

# Return one fixture to the commit the contract pins, before every cell.
#
# Cells share one fixture per PR and run with bypassPermissions and a real Bash
# tool, so the tree has to be restored between them. An argument-free
# `git reset --hard` restores whatever `HEAD` names now, which is the one thing
# a contestant can move: committing its own edits — or a prompt-injected commit
# from the diff under review — makes that commit the fixture. Every later cell
# for the PR then reviews the contestant's tree, and so does the novelty judge
# and the pre-judge login snapshot, which is how a corrupted condition score
# becomes the run of record. The reset names the pinned commit, and `HEAD` is
# read back afterwards so a reset that did not land fails the cell instead.
reset_fixture() {
  local fixture="$1" head="$2"
  git -C "$fixture" checkout --quiet --force --detach "$head" &&
    git -C "$fixture" reset --hard --quiet "$head" &&
    git -C "$fixture" clean -xdffq &&
    [[ "$(git -C "$fixture" rev-parse --verify --quiet HEAD)" == "$head" ]]
}

# --- the finder argv and the cell fingerprint --------------------------------

# The finder is spawned as an argument vector, never as a command string: the
# contract validator pins every element to [A-Za-z0-9._="@/:-], so reading one
# element per line reconstructs the array exactly and nothing is word-split.
FINDER_ARGV=()
while IFS= read -r finder_argv_element; do
  FINDER_ARGV+=("$finder_argv_element")
done < <(
  # shellcheck disable=SC2016  # the single-quoted block is node source
  node -e '
    const plan = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const cell = plan.cells.find((candidate) => Array.isArray(candidate.finder_argv));
    for (const element of cell?.finder_argv ?? []) {
      if (typeof element !== "string" || !/^[A-Za-z0-9._="@/:-]+$/.test(element)) {
        throw new Error(`finder argv element is not contract-safe: ${JSON.stringify(element)}`);
      }
      process.stdout.write(`${element}\n`);
    }
  ' "$PLAN_JSON"
)

# What a cached cell must have been produced under. An aborted run leaves cells
# behind, and the next run may carry an edited skill into the same directory.
# shellcheck disable=SC2016  # the single-quoted block is node source
FINGERPRINT_JSON="$(node --input-type=module -e '
  const [spec, planPath] = process.argv.slice(1);
  (async () => {
    const run = await import(`${spec}/scripts/review/review-eval-run.mjs`);
    const fs = await import("node:fs");
    const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    process.stdout.write(JSON.stringify(run.cellFingerprint({ plan })));
  })().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
' "$SPEC" "$PLAN_JSON")" || fail "the plan carries no cell fingerprint"

# Prints the reason a cached cell may not be reused and returns 0; returns 1
# when the cached cell matches this run and may be reused.
cell_reuse_refusal() {
  local reason
  # shellcheck disable=SC2016  # the single-quoted block is node source
  reason="$(node --input-type=module -e '
    const [spec, planPath, resultPath] = process.argv.slice(1);
    (async () => {
      const run = await import(`${spec}/scripts/review/review-eval-run.mjs`);
      const fs = await import("node:fs");
      const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
      const decision = run.cellReuseDecision({ plan, resultPath });
      if (decision.reuse) process.exit(1);
      process.stdout.write(decision.reason);
    })().catch((error) => {
      process.stdout.write(`the cached cell could not be read: ${error.message}`);
    });
  ' "$SPEC" "$PLAN_JSON" "$1" 2>/dev/null)" || return 1
  printf '%s' "$reason"
  return 0
}

# --- the resume cache --------------------------------------------------------

# Cells are what a run pays for, and the plan hands this execution its own
# detail directory as soon as a ledger row records the previous one. That older
# directory still holds paid cells, so they are copied in once — and then
# re-checked one at a time against this run's fingerprint, exactly as a cell
# found in place is, so a cell produced under an edited skill, contract,
# orchestrator or CLI is refused and re-run. Nothing is copied over cells this
# run already has.
RESUME_FROM="$(json_field "$PLAN_OUT" resume_from)"
case "$RESUME_FROM" in
  "" | undefined | null) RESUME_FROM="" ;;
  *) require_safe_detail "$RESUME_FROM" ;;
esac
if [[ -n $RESUME_FROM && -d "$REPO/$RESUME_FROM/cells" && ! -d "$RUN_DIR/cells" ]]; then
  mkdir -p "$RUN_DIR"
  if cp -R "$REPO/$RESUME_FROM/cells" "$RUN_DIR/cells"; then
    log "seeded the resume cache from $RESUME_FROM"
  else
    rm -rf "${RUN_DIR:?}/cells"
    log "could not seed the resume cache from $RESUME_FROM; every cell re-runs"
  fi
fi

# --- one cell ----------------------------------------------------------------

CLAUDE_TOOLS=(Read Write Edit Bash Grep Glob Agent TodoWrite)

run_cell() {
  local cell_id="$1" pr="$2" condition="$3" draw="$4" model="$5" effort="$6"
  local finder="$7" finder_report="$8" prompt_kind="$9"
  local out_dir="$RUN_DIR/cells/$cell_id"

  if [[ -f "$out_dir/result.json" ]]; then
    local refusal
    if refusal="$(cell_reuse_refusal "$out_dir/result.json")"; then
      log "  $cell_id not reused — $refusal; re-running"
      rm -rf "$out_dir"
    else
      log "  $cell_id reused"
      return 0
    fi
  fi

  local fixture fixture_head
  fixture_path "$pr" || {
    log "  $cell_id FAILED — fixture"
    return 1
  }
  fixture="$FIXTURE_PATH"
  fixture_head="$FIXTURE_HEAD"

  local started other_review="" codex_chars=0
  started="$(date +%s)"
  purge_skill "$fixture"
  # Without this a cell reviews the previous cell's edits, and control reviews
  # a mutated tree. The pinned commit is named rather than implied; see
  # `reset_fixture`.
  if ! reset_fixture "$fixture" "$fixture_head"; then
    log "  $cell_id FAILED — the fixture could not be reset to $fixture_head"
    return 1
  fi

  if [[ $condition == "pipeline" ]]; then
    if [[ ${#FINDER_ARGV[@]} -eq 0 ]]; then
      log "  $cell_id FAILED — the plan carries no finder argv"
      return 1
    fi
    # The finder writes to a file rather than into a pipeline so the run
    # deadline can bound it: a stalled finder inside a command substitution
    # never returns, and the between-cells deadline check never runs again.
    # A finder that hits its session limit or dies mid-report still writes what
    # it had, and that partial report is not a review: cached, it would score
    # forever as a finder that simply missed those defects. Fail the cell on an
    # unsuccessful exit, on the deadline, or on an empty report.
    local finder_out finder_status=0
    finder_out="$(mktemp "$TMPROOT/review-eval-finder.XXXXXX")"
    run_bounded "$finder_out" "$(remaining_seconds "$MATRIX_DEADLINE")" \
      run_in_fixture "$fixture" "${FINDER_ARGV[@]}" || finder_status=$?
    other_review="$(tail -c 30000 "$finder_out")"
    if [[ $finder_status -eq 124 ]]; then
      log "  $cell_id FAILED — the finder hit the run deadline; not cached"
      log_stderr_tail "$finder_out.err"
      rm -f "$finder_out" "$finder_out.err"
      return 1
    fi
    if [[ $finder_status -ne 0 ]]; then
      log "  $cell_id FAILED — the finder exited $finder_status; not cached"
      log_stderr_tail "$finder_out.err"
      rm -f "$finder_out" "$finder_out.err"
      return 1
    fi
    if [[ -z ${other_review//[[:space:]]/} ]]; then
      log "  $cell_id FAILED — the finder produced nothing; not cached"
      log_stderr_tail "$finder_out.err"
      rm -f "$finder_out" "$finder_out.err"
      return 1
    fi
    rm -f "$finder_out" "$finder_out.err"
  elif [[ $condition == "replay" ]]; then
    # The frozen report is the whole treatment for this condition. Reading it
    # is verified once by --check-fixtures, but the spec worktree is the live
    # checkout under --skill-ref and a candidate run can outlive the branch it
    # was planned on. An unreadable or empty report here would hand the model
    # an empty handoff and score that as a review of the change.
    if ! other_review="$(cat "$SPEC/$finder_report")" ||
      [[ -z ${other_review//[[:space:]]/} ]]; then
      log "  $cell_id FAILED — frozen finder report $finder_report is unreadable or empty; not cached"
      return 1
    fi
  fi
  codex_chars="${#other_review}"

  local prompt
  if [[ $prompt_kind == "handoff" ]]; then
    # shellcheck disable=SC2016  # the single-quoted block is node source
    prompt="$(REVIEW_EVAL_OTHER="$other_review" node -e '
      const fs = require("node:fs");
      const template = fs.readFileSync(process.argv[1], "utf8");
      // The replacement is a function on purpose. A string replacement gives
      // the finder output its own dollar-sign patterns, so a review that
      // happens to contain one would silently rewrite the prompt around it.
      process.stdout.write(
        template.replace("{{OTHER_REVIEW}}", () => process.env.REVIEW_EVAL_OTHER),
      );
    ' "$SPEC/scripts/review/prompts/handoff.md")"
  else
    prompt="$(cat "$SPEC/scripts/review/prompts/request.md")"
  fi

  local -a claude_args=(-p "$prompt" --model "$model" --effort "$effort"
    --setting-sources "" --output-format json
    --permission-mode bypassPermissions
    --allowed-tools "${CLAUDE_TOOLS[@]}" --max-turns 80)
  if [[ $condition != "control" ]]; then
    local preamble
    if ! preamble="$(stage_skill "$fixture")"; then
      log "  $cell_id FAILED — the skill did not stage into the fixture; not cached"
      purge_skill "$fixture"
      return 1
    fi
    claude_args+=(--append-system-prompt "$preamble")
  fi

  local raw other_file claude_status=0
  raw="$(mktemp "$TMPROOT/review-eval-cell.XXXXXX")"
  other_file="$(mktemp "$TMPROOT/review-eval-other.XXXXXX")"
  printf '%s' "$other_review" >"$other_file"
  # Bounded by what is left of the matrix budget for the same reason the finder
  # is: a contestant that stalls at a session limit would otherwise hold the
  # whole run open past the deadline it advertises.
  run_bounded "$raw" "$(remaining_seconds "$MATRIX_DEADLINE")" \
    run_in_fixture "$fixture" claude "${claude_args[@]}" || claude_status=$?
  if [[ $claude_status -ne 0 ]]; then
    purge_skill "$fixture"
    if [[ $claude_status -eq 124 ]]; then
      log "  $cell_id FAILED — claude hit the run deadline; not cached"
    else
      log "  $cell_id FAILED — claude exited $claude_status; not cached"
    fi
    log_stderr_tail "$raw.err"
    rm -f "$raw" "$raw.err" "$other_file"
    return 1
  fi
  purge_skill "$fixture"

  mkdir -p "$out_dir"
  # shellcheck disable=SC2016  # the single-quoted block is node source
  if ! REVIEW_EVAL_CELL="$cell_id" REVIEW_EVAL_PR="$pr" \
    REVIEW_EVAL_CONDITION="$condition" REVIEW_EVAL_DRAW="$draw" \
    REVIEW_EVAL_MODEL="$model" REVIEW_EVAL_EFFORT="$effort" \
    REVIEW_EVAL_FINDER="$finder" REVIEW_EVAL_FIXTURE="$fixture" \
    REVIEW_EVAL_SECONDS="$(($(date +%s) - started))" \
    REVIEW_EVAL_FINDER_CHARS="$codex_chars" \
    REVIEW_EVAL_FINGERPRINT="$FINGERPRINT_JSON" \
    node -e '
      const fs = require("node:fs");
      const raw = fs.readFileSync(process.argv[1], "utf8");
      let envelope;
      try { envelope = JSON.parse(raw); } catch { envelope = { is_error: true, result: raw.slice(-4000) }; }
      const ok = !envelope.is_error && typeof envelope.result === "string" && envelope.result.trim() !== "";
      if (!ok) process.exit(3);
      const other = fs.readFileSync(process.argv[2], "utf8");
      fs.writeFileSync(process.argv[3], `${JSON.stringify({
        cell_id: process.env.REVIEW_EVAL_CELL,
        pr: Number(process.env.REVIEW_EVAL_PR),
        condition: process.env.REVIEW_EVAL_CONDITION,
        draw: Number(process.env.REVIEW_EVAL_DRAW),
        model: process.env.REVIEW_EVAL_MODEL,
        effort: process.env.REVIEW_EVAL_EFFORT,
        finder: process.env.REVIEW_EVAL_FINDER || null,
        fixture_path: process.env.REVIEW_EVAL_FIXTURE,
        fingerprint: JSON.parse(process.env.REVIEW_EVAL_FINGERPRINT),
        ok: true,
        output: envelope.result,
        other_review: other,
        finder_chars: Number(process.env.REVIEW_EVAL_FINDER_CHARS),
        seconds: Number(process.env.REVIEW_EVAL_SECONDS),
        cost_usd: envelope.total_cost_usd ?? 0,
        turns: envelope.num_turns ?? null,
      }, null, 1)}\n`);
    ' "$raw" "$other_file" "$out_dir/result.json"; then
    rm -rf "$out_dir"
    log "  $cell_id FAILED — claude reported an error; not cached"
    log_stderr_tail "$raw.err"
    rm -f "$raw" "$raw.err" "$other_file"
    return 1
  fi
  rm -f "$raw" "$raw.err" "$other_file"
  log "  $cell_id ok $(($(date +%s) - started))s"
  return 0
}

# --- the matrix --------------------------------------------------------------

# One tab-separated line per planned cell, in plan order. Every field comes
# from the contract, so a tab or a newline in one of them would forge extra
# rows in the reader below: such a field aborts the run instead.
#
# The whole matrix is built before a single line is written. Writing as it goes
# would emit every cell up to the offending one, and the reader below cannot
# see that the writer died: the run would spend money on a truncated matrix and
# then score it as merely partial, which is exactly what the check is for.
cell_rows() {
  # shellcheck disable=SC2016  # the single-quoted block is node source
  node -e '
    const plan = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const lines = [];
    for (const cell of plan.cells) {
      const fields = [
        cell.cell_id, cell.pr, cell.condition, cell.draw, cell.model,
        cell.effort, cell.finder ?? "", cell.finder_report ?? "",
        cell.prompt,
      ].map(String);
      for (const [index, field] of fields.entries()) {
        if (/[\t\r\n]/.test(field)) {
          throw new Error(
            `cell ${cell.cell_id} field ${index} carries a tab or a newline: ${JSON.stringify(field)}`,
          );
        }
      }
      lines.push(fields.join("\t") + "\n");
    }
    process.stdout.write(lines.join(""));
  ' "$PLAN_JSON"
}

STARTED="$(date +%s)"
FAILED=0
DONE=0
TOTAL=0

while IFS=$'\t' read -r cell_id pr condition draw model effort finder \
  finder_report prompt_kind extra; do
  TOTAL=$((TOTAL + 1))
  if [[ -n ${extra:-} ]]; then
    fail "the plan produced a cell row with an extra field: $extra"
  fi
  if [[ $(($(date +%s) - STARTED)) -ge $MATRIX_DEADLINE ]]; then
    STATUS_NOTE="matrix deadline of ${MATRIX_DEADLINE}s reached"
    log "matrix deadline reached; the matrix is partial"
    break
  fi
  if run_cell "$cell_id" "$pr" "$condition" "$draw" "$model" "$effort" \
    "$finder" "$finder_report" "$prompt_kind"; then
    DONE=$((DONE + 1))
  else
    FAILED=$((FAILED + 1))
  fi
done < <(cell_rows)

log "matrix: $DONE done, $FAILED failed, of $TOTAL"
if [[ $DONE -eq 0 ]]; then
  abort "every cell failed${STATUS_NOTE:+ ($STATUS_NOTE)}"
fi

# --- score, validate, report -------------------------------------------------

# The same baseline reaches scoring, validation and the report. Naming it for
# only one of the three would have the row scored against the same-day run and
# then rechecked against the ledger's stored anchor, and the two verdicts would
# disagree for no reason a reader of the PR could see.
AGAINST_ARGS=()
if [[ -n $AGAINST ]]; then
  AGAINST_ARGS=(--against "$AGAINST")
  log "baseline for this run: $AGAINST"
fi

# Scoring runs inside the same deadline the matrix does, on the quarter of the
# budget the matrix loop reserved for it. Forty calibration replays and three
# judge calls per cell are not a bounded amount of time on their own: each judge
# call carries a one-hour timeout, so an unbounded scoring pass can outlast the
# whole matrix. `--score` writes the cells' scores under the run directory, so a
# pass stopped here re-runs against the cached cells rather than re-spending
# them.
SCORE_OUT="$(mktemp "$TMPROOT/review-eval-score.XXXXXX")"
SCORE_STATUS=0

log "scoring (this calls the judge)"
run_bounded "$SCORE_OUT" "$(remaining_seconds "$DEADLINE")" \
  node "$CLI" --root "$SPEC" --ledger "$LEDGER" --score "$RUN_DIR" \
  "${AGAINST_ARGS[@]+"${AGAINST_ARGS[@]}"}" --json || SCORE_STATUS=$?
cat "$SCORE_OUT"
# The harness prints why it refused on stderr — a digest mismatch, an
# unreadable plan, a judge that never answered. The failure row records only
# "scoring failed", so without this the one line that says what happened is
# gone by the time anyone reads the log.
if [[ $SCORE_STATUS -ne 0 ]]; then
  log_stderr_tail "$SCORE_OUT.err"
fi
rm -f "$SCORE_OUT" "$SCORE_OUT.err"
if [[ $SCORE_STATUS -eq 124 ]]; then
  abort "scoring hit the run deadline of ${DEADLINE}s"
elif [[ $SCORE_STATUS -ne 0 ]]; then
  abort "scoring failed"
fi

log "validating the row against its own detail"
# --detail-dir names the run directory explicitly: the contract comes from the
# spec worktree while the scored cells live under the real checkout, so the
# row's repo-relative detail_dir does not resolve against --root here.
node "$CLI" --root "$SPEC" --ledger "$LEDGER" --validate "$RUN_DIR/row.json" \
  --detail-dir "$RUN_DIR" "${AGAINST_ARGS[@]+"${AGAINST_ARGS[@]}"}" --append --json ||
  abort "the scored row did not revalidate; nothing was appended"

# Past this point the row is in the checkout's ledger. `set -e` exiting here
# would leave the schedule wedged exactly the way an unpublished row does: the
# ledger is dirty, the next run refuses to start against it, and no PR and no
# recovery commands were ever printed. So everything between the append and
# `publish_row` reports its own failure and carries on to publication — and
# never through `abort`, which would append a second row for the same run.
#
# The report is the PR body, and it can fail on its own: `--report` re-reads the
# ledger and the baseline, and a same-sitting `--against` file under /tmp can be
# gone by now. A stub body publishes the row and names what to re-run.
REPORT="$RUN_DIR/report.md"
REPORT_OUT="$(mktemp "$TMPROOT/review-eval-report.XXXXXX")"
REPORT_STATUS=0
node "$CLI" --root "$SPEC" --ledger "$LEDGER" --report \
  "${AGAINST_ARGS[@]+"${AGAINST_ARGS[@]}"}" >"$REPORT_OUT" 2>"$REPORT_OUT.err" ||
  REPORT_STATUS=$?
VERDICT="$(json_field "$RUN_DIR/row.json" verdict)" || VERDICT=""
# `json_field` prints `String(doc[key])`, so a missing key arrives as the word
# "undefined". Neither it nor an empty read may name a commit.
case "$VERDICT" in "" | undefined | null) VERDICT="UNKNOWN" ;; esac
if [[ $REPORT_STATUS -eq 0 ]]; then
  mv "$REPORT_OUT" "$REPORT"
else
  log "the report could not be generated (exit $REPORT_STATUS); publishing the appended row with a stub body"
  log_stderr_tail "$REPORT_OUT.err"
  # shellcheck disable=SC2016  # the backticks are markdown in the PR body
  printf '# Review-skill eval: %s\n\nThe row was scored and appended to `%s`, and the report could not be generated (`--report` exited %s). The row and the run detail in this commit are the evidence; re-run `pnpm review:eval -- --report` against this ledger to produce the table.\n' \
    "$VERDICT" "docs/evals/review-skill-ledger.jsonl" "$REPORT_STATUS" >"$REPORT"
  rm -f "$REPORT_OUT"
fi
rm -f "$REPORT_OUT.err"
log "verdict $VERDICT"

# --- publish -----------------------------------------------------------------

publish_row "$VERDICT" report.md

cat "$REPORT"

# A scored row wedges the schedule exactly the way a failed one does. It is in
# the checkout's ledger now, `--validate --append` put it there, and the
# installed launchd job runs without --pr. Exiting zero here would report a
# clean run while no PR carries the result and the next scheduled run refuses to
# start against a ledger with uncommitted changes. Exit zero only when a PR
# actually carries the row; otherwise the commands printed above finish the job.
if [[ $PUBLISHED -ne 1 ]]; then
  fail "the run scored $VERDICT, the row was appended to $LEDGER, and no PR carries it yet; run the commands above (or re-run with --pr) — the next run refuses to start while that ledger has uncommitted changes"
fi
exit 0
