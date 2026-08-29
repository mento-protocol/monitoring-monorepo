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
# One run at a time. The fixture cache and the ledger are shared but move
# independently — the cache with --cache-dir, the ledger and the detail
# directory with --repo — so the script locks both roots and refuses to start
# while another run holds either, rather than letting two runs rewrite each
# other's fixture checkouts or race the same ledger appends.
#
# Usage:
#   run-eval.sh [--kind full|canary|auto] [--skill-ref PATH] [--pr] [--no-pr]
#               [--repo PATH] [--cache-dir DIR] [--deadline SECONDS]
#               [--against REF]
#
# --against names the baseline row this run is planned, scored, validated and
# reported against: a row file path or an executed_at prefix. The candidate
# procedure needs it — a --skill-ref run must be compared against the installed
# run from the same sitting, not against the ledger's stored anchor, or the
# comparison carries whatever the model did between the anchor and today.
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
BASELINE_SNAPSHOT=""
# RUN-EVAL-SPLIT-ONLY-BEGIN source-snapshot-state
RUN_EVAL_ORIGINAL_ARGS=("$@")
RUN_EVAL_SOURCE_SNAPSHOT="${RUN_EVAL_SOURCE_SNAPSHOT:-}"
RUN_EVAL_SOURCE_TOKEN="${RUN_EVAL_SOURCE_TOKEN:-}"
for RUN_EVAL_INHERITED_EXPORT in $(compgen -e RUN_EVAL_); do
  export -n "${RUN_EVAL_INHERITED_EXPORT?}"
done
unset RUN_EVAL_INHERITED_EXPORT
RUN_EVAL_ENTRY_SOURCE="${BASH_SOURCE[0]}"
RUN_EVAL_CREATED_SOURCE_SNAPSHOT=0
RUN_EVAL_SOURCE_OWNED=0
RUN_EVAL_BOOTSTRAP_SOURCE_OWNED=0
# shellcheck disable=SC2329  # invoked by the bootstrap EXIT trap below
cleanup_source_snapshot_bootstrap() {
  local code=$?
  if [[ $RUN_EVAL_BOOTSTRAP_SOURCE_OWNED -eq 1 ]]; then
    chmod 0700 "$RUN_EVAL_SOURCE_SNAPSHOT" >/dev/null 2>&1 || true
    rm -f -- "$RUN_EVAL_SOURCE_SNAPSHOT"/run-eval{,-source-snapshot,-lifecycle,-runtime}.sh
    if [[ $RUN_EVAL_SOURCE_TOKEN =~ ^[[:alnum:]]{12}$ ]]; then
      rm -f -- "$RUN_EVAL_SOURCE_SNAPSHOT/.review-eval-owner.$RUN_EVAL_SOURCE_TOKEN"
    fi
    rmdir -- "$RUN_EVAL_SOURCE_SNAPSHOT" >/dev/null 2>&1 || true
  fi
  return "$code"
}
if [[ -n $RUN_EVAL_SOURCE_SNAPSHOT || -n $RUN_EVAL_SOURCE_TOKEN ]]; then
  RUN_EVAL_SOURCE_PARENT="${RUN_EVAL_SOURCE_SNAPSHOT%/*}"
  RUN_EVAL_SOURCE_NAME="${RUN_EVAL_SOURCE_SNAPSHOT##*/}"
  RUN_EVAL_SOURCE_MARKER="$RUN_EVAL_SOURCE_SNAPSHOT/.review-eval-owner.$RUN_EVAL_SOURCE_TOKEN"
  RUN_EVAL_SOURCE_WRAPPER="$RUN_EVAL_SOURCE_SNAPSHOT/run-eval.sh"
  RUN_EVAL_SOURCE_HELPER="$RUN_EVAL_SOURCE_SNAPSHOT/run-eval-source-snapshot.sh"
  RUN_EVAL_SOURCE_PHYSICAL_PARENT="$(unset CDPATH; cd -P "$RUN_EVAL_SOURCE_PARENT" 2>/dev/null && pwd -P)" || RUN_EVAL_SOURCE_PHYSICAL_PARENT=""
  RUN_EVAL_SOURCE_PHYSICAL="$(unset CDPATH; cd -P "$RUN_EVAL_SOURCE_SNAPSHOT" 2>/dev/null && pwd -P)" || RUN_EVAL_SOURCE_PHYSICAL=""
  RUN_EVAL_MARKER_PID=""
  RUN_EVAL_MARKER_TOKEN=""
  if [[ -f $RUN_EVAL_SOURCE_MARKER && ! -L $RUN_EVAL_SOURCE_MARKER ]]; then
    IFS=$'\t' read -r RUN_EVAL_MARKER_PID RUN_EVAL_MARKER_TOKEN <"$RUN_EVAL_SOURCE_MARKER" || true
  fi
  if [[ -z $RUN_EVAL_SOURCE_SNAPSHOT || -z $RUN_EVAL_SOURCE_TOKEN ||
    ! $RUN_EVAL_SOURCE_TOKEN =~ ^[[:alnum:]]{12}$ ||
    ! $RUN_EVAL_SOURCE_NAME =~ ^review-eval-source\.[[:alnum:]]{6}$ ||
    $RUN_EVAL_SOURCE_PARENT != "$RUN_EVAL_SOURCE_PHYSICAL_PARENT" ||
    $RUN_EVAL_SOURCE_SNAPSHOT != "$RUN_EVAL_SOURCE_PHYSICAL" ||
    ${RUN_EVAL_SOURCE_PHYSICAL%/*} != "$RUN_EVAL_SOURCE_PHYSICAL_PARENT" ||
    -L $RUN_EVAL_SOURCE_SNAPSHOT || ! -f $RUN_EVAL_SOURCE_MARKER ||
    -L $RUN_EVAL_SOURCE_MARKER || $RUN_EVAL_MARKER_PID != "$$" ||
    $RUN_EVAL_MARKER_TOKEN != "$RUN_EVAL_SOURCE_TOKEN" ||
    $RUN_EVAL_ENTRY_SOURCE != "$RUN_EVAL_SOURCE_SNAPSHOT/run-eval.sh" ]]; then
    printf 'FATAL: the inherited orchestrator snapshot is not authenticated\n' >&2
    exit 1
  fi
  RUN_EVAL_BOOTSTRAP_SOURCE_OWNED=1
  trap cleanup_source_snapshot_bootstrap EXIT
  if [[ -w $RUN_EVAL_SOURCE_SNAPSHOT || -w $RUN_EVAL_SOURCE_MARKER ||
    ! -f $RUN_EVAL_SOURCE_WRAPPER || -L $RUN_EVAL_SOURCE_WRAPPER ||
    -w $RUN_EVAL_SOURCE_WRAPPER || ! -f $RUN_EVAL_SOURCE_HELPER ||
    -L $RUN_EVAL_SOURCE_HELPER || -w $RUN_EVAL_SOURCE_HELPER ]]; then
    printf 'FATAL: the inherited orchestrator snapshot is not sealed\n' >&2
    exit 1
  fi
  # shellcheck source=scripts/review/run-eval-source-snapshot.sh
  source "$RUN_EVAL_SOURCE_HELPER"
  run_eval_source_snapshot_arm || exit 1
fi
# RUN-EVAL-SPLIT-ONLY-END source-snapshot-state
LOCK_DIRS=()
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

# RUN-EVAL-EXTRACT-BEGIN lifecycle-setup
RUN_EVAL_LIVE_SCRIPT_DIR="$(unset CDPATH; cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# RUN-EVAL-SOURCE-SNAPSHOT-BEGIN
LOCK_ROOT="$(git -C "$REPO" rev-parse --absolute-git-dir 2>/dev/null)" ||
  fail "$REPO has no git directory for an immutable orchestrator snapshot"
LOCK_ROOT="$(unset CDPATH; cd -P "$LOCK_ROOT" 2>/dev/null && pwd -P)" ||
  fail "$REPO has no physical git directory for an immutable orchestrator snapshot"
if [[ -z $RUN_EVAL_SOURCE_SNAPSHOT && -z $RUN_EVAL_SOURCE_TOKEN ]]; then
  RUN_EVAL_SOURCE_SNAPSHOT="$(mktemp -d "$LOCK_ROOT/review-eval-source.XXXXXX")" ||
    fail "could not prepare an immutable orchestrator snapshot under $LOCK_ROOT"
  RUN_EVAL_BOOTSTRAP_SOURCE_OWNED=1
  trap cleanup_source_snapshot_bootstrap EXIT
  RUN_EVAL_SOURCE_HELPER="$RUN_EVAL_SOURCE_SNAPSHOT/run-eval-source-snapshot.sh"
  [[ -f $RUN_EVAL_LIVE_SCRIPT_DIR/run-eval-source-snapshot.sh &&
    ! -L $RUN_EVAL_LIVE_SCRIPT_DIR/run-eval-source-snapshot.sh ]] ||
    fail "the source-snapshot helper is not a regular file"
  cp "$RUN_EVAL_LIVE_SCRIPT_DIR/run-eval-source-snapshot.sh" "$RUN_EVAL_SOURCE_HELPER" ||
    fail "could not snapshot the source-snapshot helper"
  chmod 0400 "$RUN_EVAL_SOURCE_HELPER" ||
    fail "could not protect the source-snapshot helper"
  # shellcheck source=scripts/review/run-eval-source-snapshot.sh
  source "$RUN_EVAL_SOURCE_HELPER"
  run_eval_source_snapshot_restart \
    "$REPO" "$RUN_EVAL_LIVE_SCRIPT_DIR" "${RUN_EVAL_ORIGINAL_ARGS[@]}"
fi
run_eval_source_snapshot_accept "$LOCK_ROOT" "$RUN_EVAL_LIVE_SCRIPT_DIR" ||
  fail "the inherited orchestrator snapshot is not the sealed checkout source tuple"
unset RUN_EVAL_ORIGINAL_ARGS
RUN_EVAL_SCRIPT_DIR="$RUN_EVAL_SOURCE_SNAPSHOT"
# RUN-EVAL-SOURCE-SNAPSHOT-END
RUN_EVAL_LIFECYCLE_STAGE=setup
# shellcheck source=scripts/review/run-eval-lifecycle.sh
source "$RUN_EVAL_SCRIPT_DIR/run-eval-lifecycle.sh"
unset RUN_EVAL_LIFECYCLE_STAGE
# RUN-EVAL-EXTRACT-END lifecycle-setup
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
  # The spec worktree is a second checkout of origin/main, so it carries the
  # whole frozen answer key under docs/evals/review-skill-truth/. Under
  # `$TMPROOT` a `Bash`-enabled contestant finds it by listing the `TMPDIR` it
  # inherits, reads the defect bodies straight out of it, and can then write a
  # review that names no PR number, no reviewer login and no withheld SHA, so
  # `leakSignals()` records nothing and the run scores a recall it never earned.
  # Permissions cannot help — a cell runs as the same user — so the spec goes
  # where the source checkout itself is: under the git directory, which is not a
  # tracked path, is not on any cell's `PATH` or in its environment, and is only
  # reachable by someone who already knows where the checkout is.
  SPEC="$(mktemp -d "$LOCK_ROOT/review-eval-spec.XXXXXX")"
  rm -rf "$SPEC"
  git -C "$REPO" worktree add --detach "$SPEC" origin/main --quiet
  SPEC_TEMP=1
  log "spec worktree at $SPEC ($(git -C "$SPEC" rev-parse --short HEAD))"
fi

CLI="$SPEC/scripts/review/review-eval.mjs"
CONTRACT="$SPEC/docs/evals/review-skill-fixtures.json"
ORCHESTRATOR="$SPEC/scripts/review/run-eval.sh"
[[ -f $CLI ]] || fail "$CLI is missing; the spec worktree has no harness"

# RUN-EVAL-EXTRACT-BEGIN lifecycle-verify
RUN_EVAL_LIFECYCLE_STAGE=verify
# shellcheck source=scripts/review/run-eval-lifecycle.sh
source "$RUN_EVAL_SCRIPT_DIR/run-eval-lifecycle.sh"
unset RUN_EVAL_LIFECYCLE_STAGE
# RUN-EVAL-EXTRACT-END lifecycle-verify
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
    const { baselineEligibility } = await import(`${spec}/scripts/review/review-eval-report.mjs`);
    const row = resolveRowReference({ reference, rows: readLedger(ledger), repoRoot: spec });
    const eligibility = baselineEligibility(row);
    if (!eligibility.usable) throw new Error(eligibility.reason);
  ' "$SPEC" "$LEDGER" "$AGAINST" >/dev/null 2>&1 ||
    fail "--against $AGAINST does not resolve to one eligible complete full baseline row"
fi

PLAN_OUT="$(mktemp "$TMPROOT/review-eval-plan.XXXXXX")"
PLAN_ARGS=(--root "$SPEC" --ledger "$LEDGER" --plan --kind "$KIND" --json)
if [[ -n $SKILL_REF ]]; then
  PLAN_ARGS+=(--skill-ref "$SKILL_REF")
fi
if [[ -n $AGAINST ]]; then
  PLAN_ARGS+=(--against "$AGAINST")
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
if [[ -n $AGAINST ]]; then
  PLAN_ARGS+=(--against "$AGAINST")
fi
node "$CLI" "${PLAN_ARGS[@]}" >"$PLAN_OUT" ||
  fail "planning into $RUN_DIR failed"
RUN_DIR="$(json_field "$PLAN_OUT" plan_dir)"
PLAN_JSON="$RUN_DIR/plan.json"
# RUN-EVAL-SPLIT-ONLY-BEGIN source-snapshot-digest
run_eval_source_snapshot_verify_plan "$PLAN_JSON" "$RUN_EVAL_SCRIPT_DIR"
# RUN-EVAL-SPLIT-ONLY-END source-snapshot-digest
# The first preflight proves that --against resolves to an intrinsically usable
# row. The generated plan now supplies the remaining checks before paid work:
# full schema and frozen-matrix validation, plus the exact comparison lineage.
if [[ -n $AGAINST ]]; then
  BASELINE_SNAPSHOT="$(mktemp "$LOCK_ROOT/review-eval-baseline.XXXXXX")" ||
    fail "could not prepare an immutable baseline snapshot under $LOCK_ROOT"
  # shellcheck disable=SC2016  # the single-quoted block is node source
  node --input-type=module -e '
    const [spec, ledger, contractFile, planFile, reference, snapshot] = process.argv.slice(1);
    const { readFileSync, writeFileSync } = await import("node:fs");
    const { loadContract } = await import(`${spec}/scripts/review/review-eval-fixtures.mjs`);
    const { baselinePreflightProblems, readLedger } = await import(`${spec}/scripts/review/review-eval-ledger.mjs`);
    const { baselineEligibility } = await import(`${spec}/scripts/review/review-eval-report.mjs`);
    const { resolveRowReference } = await import(`${spec}/scripts/review/review-eval-result-shape.mjs`);
    const { baselinePlanIdentity } = await import(`${spec}/scripts/review/review-eval-run.mjs`);
    const { contract, digest } = loadContract(contractFile);
    const plan = JSON.parse(readFileSync(planFile, "utf8"));
    const row = resolveRowReference({ reference, rows: readLedger(ledger), repoRoot: spec });
    const eligibility = baselineEligibility(row);
    if (!eligibility.usable) throw new Error(eligibility.reason);
    const plannedBaseline = plan.baseline ?? null;
    const currentBaseline = baselinePlanIdentity(row);
    if (JSON.stringify(plannedBaseline) !== JSON.stringify(currentBaseline)) {
      throw new Error("the resolved baseline changed after planning");
    }
    const problems = baselinePreflightProblems({
      row,
      contract,
      contractDigest: digest,
      planComparabilityKey: plan.comparability_key,
      candidateExecutedAt: plan.planned_at,
    });
    if (problems.length > 0) throw new Error(problems.join(" | "));
    writeFileSync(snapshot, `${JSON.stringify(row)}\n`);
  ' "$SPEC" "$LEDGER" "$CONTRACT" "$PLAN_JSON" "$AGAINST" "$BASELINE_SNAPSHOT" >/dev/null 2>&1 ||
    fail "--against $AGAINST is malformed or incompatible with the generated plan"
  AGAINST="$BASELINE_SNAPSHOT"
fi
# shellcheck disable=SC2016  # the single-quoted block is node source
CELL_COUNT="$(node -e '
  const plan = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(`${plan.cells.length} cells, about $${plan.estimate.claude_usd}`);
' "$PLAN_JSON")"
log "plan $KIND: $CELL_COUNT"
log "detail directory $RUN_DIR"

# RUN-EVAL-EXTRACT-BEGIN lifecycle-support
RUN_EVAL_LIFECYCLE_STAGE=support
# shellcheck source=scripts/review/run-eval-lifecycle.sh
source "$RUN_EVAL_SCRIPT_DIR/run-eval-lifecycle.sh"
unset RUN_EVAL_LIFECYCLE_STAGE
# RUN-EVAL-EXTRACT-END lifecycle-support
# RUN-EVAL-EXTRACT-BEGIN cell-runtime
# shellcheck source=scripts/review/run-eval-runtime.sh
source "$RUN_EVAL_SCRIPT_DIR/run-eval-runtime.sh"
# RUN-EVAL-EXTRACT-END cell-runtime

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
