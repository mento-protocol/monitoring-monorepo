#!/usr/bin/env bash
# The spec worktree and the run plan for run-eval.sh.
# This file is sourced before the first plan phase. Do not execute it directly.
#
# Reads: REPO, LEDGER, SKILL_REF, KIND, FINDER, VERIFIER, AGAINST, LOCK_ROOT,
# TMPROOT, CLI, CONTRACT, SPEC.
# Writes: SPEC, SPEC_TEMP, HEAD_SHA, MAIN_SHA, CLI, CONTRACT, ORCHESTRATOR,
# PLAN_OUT, PLAN_ARGS, DETAIL_DIR, KIND, RUN_DIR, PLAN_JSON, BASELINE_SNAPSHOT,
# AGAINST, CELL_COUNT.
#
# Every phase prints, assigns a global or `fail`s, so the wrapper calls each one
# bare, never in a command substitution. `fail`, `log` and `json_field` belong
# to the wrapper; `json_field` is defined there before `plan_generate` runs.

# --- the spec worktree -------------------------------------------------------

plan_prepare_spec() {
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
    # shellcheck disable=SC2034 # read by the lifecycle cleanup
    SPEC_TEMP=1
    log "spec worktree at $SPEC ($(git -C "$SPEC" rev-parse --short HEAD))"
  fi
}

plan_bind_contract_paths() {
  CLI="$SPEC/scripts/review/review-eval.mjs"
  CONTRACT="$SPEC/docs/evals/review-skill-fixtures.json"
  # shellcheck disable=SC2034 # read by the lifecycle verify stage
  ORCHESTRATOR="$SPEC/scripts/review/run-eval.sh"
  [[ -f $CLI ]] || fail "$CLI is missing; the spec worktree has no harness"
}

# --- plan --------------------------------------------------------------------

plan_check_contract() {
  node "$CLI" --root "$SPEC" --ledger "$LEDGER" --check-fixtures --offline >/dev/null ||
    fail "the committed contract does not validate"
}

# An unresolvable --against would otherwise surface at --score, after the
# matrix has already spent its hours and dollars. Resolve it now with the same
# logic --score consumes; the resolved row is re-derived there, not cached here.
plan_resolve_against() {
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
}

# The optional flags both plan calls pass. They were two identical blocks; one
# function keeps the second plan from drifting away from the first, which would
# plan the persistent run directory against a different treatment.
plan_build_args() {
  if [[ -n $FINDER ]]; then
    PLAN_ARGS+=(--finder "$FINDER")
  fi
  if [[ -n $VERIFIER ]]; then
    PLAN_ARGS+=(--verifier "$VERIFIER")
  fi
  if [[ -n $SKILL_REF ]]; then
    PLAN_ARGS+=(--skill-ref "$SKILL_REF")
  fi
  if [[ -n $AGAINST ]]; then
    PLAN_ARGS+=(--against "$AGAINST")
  fi
}

plan_generate() {
  PLAN_OUT="$(mktemp "$TMPROOT/review-eval-plan.XXXXXX")"
  PLAN_ARGS=(--root "$SPEC" --ledger "$LEDGER" --plan --kind "$KIND" --json)
  plan_build_args
  node "$CLI" "${PLAN_ARGS[@]}" >"$PLAN_OUT" || fail "planning failed"

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
  plan_build_args
  node "$CLI" "${PLAN_ARGS[@]}" >"$PLAN_OUT" ||
    fail "planning into $RUN_DIR failed"
  RUN_DIR="$(json_field "$PLAN_OUT" plan_dir)"
  PLAN_JSON="$RUN_DIR/plan.json"
}

# The first preflight proves that --against resolves to an intrinsically usable
# row. The generated plan now supplies the remaining checks before paid work:
# full schema and frozen-matrix validation, plus the exact comparison lineage.
plan_snapshot_baseline() {
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
}

plan_log_estimate() {
  # shellcheck disable=SC2016  # the single-quoted block is node source
  CELL_COUNT="$(node -e '
    const plan = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const free = plan.estimate.unmetered_cells, u = free ? ` (${free} unmetered)` : "";
    process.stdout.write(`${plan.cells.length} cells, about $${plan.estimate.claude_usd}${u}`);
  ' "$PLAN_JSON")"
  log "plan $KIND: $CELL_COUNT"
  log "detail directory $RUN_DIR"
}
