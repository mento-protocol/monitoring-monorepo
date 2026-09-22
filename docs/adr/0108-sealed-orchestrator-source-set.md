---
title: Every run-eval shell module joins the sealed orchestrator source set
status: active
owner: eng
canonical: true
last_verified: 2026-09-22
scope: evals
date: 2026-09
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0108 — Every run-eval shell module joins the sealed orchestrator source set

**Status:** Accepted (Sep 2026), in force. Extends
[ADR 0107](0107-enforced-shell-size-limits.md), which enforces the shell size
limits that make the split necessary.
**Scope:** evals

## Context

`scripts/review/run-eval.sh` is the only script that spends model quota. It
creates a private directory under the checkout's physical git directory, copies
its own sources into it, seals it `0500` with a PID-bound owner marker, and
`exec`s itself from there. Every later `source` reads
`$RUN_EVAL_SCRIPT_DIR`, which is that sealed directory. Before the first paid
cell, `run_eval_source_snapshot_verify_plan` recomputes a length-framed SHA-256
over the whole set and requires the persistent plan to record the same
`orchestrator_digest`. The digest is bound into `comparability_key`, so the set
also decides which runs may be compared.

The set was seven files: five `.sh` and the two `.mjs` modules the cell path
loads. ADR 0107 then put `run-eval.sh` (599 lines), `run-eval-lifecycle.sh`
(598) and `run-eval-runtime.sh` (599) over the 500-line limit with a baseline
row each, and the baseline may only ratchet down. Splitting them is the only
way to retire those rows, and a split creates new shell files that the run
sources at the same points the moved code ran.

A new module either joins the sealed set or it does not. That is the decision.

## Decision

**Every shell file `run-eval.sh` sources joins the sealed source set.** The set
is now ten files, in one fixed order, and the order is the same in every list
because the digest is order-sensitive:

```text
run-eval.sh
run-eval-source-snapshot.sh
run-eval-lifecycle.sh
run-eval-runtime.sh
run-eval-matrix.sh
run-eval-plan.sh
run-eval-publish.sh
run-eval-cell.sh
review-eval-cell-writer.mjs
review-eval-stream.mjs
```

Ten code sites name that set. `ORCHESTRATOR_FILES`
(`scripts/review/review-eval-run-plan.mjs`) is the source of truth for the
digest. `run-eval-source-snapshot.sh` holds four lists: the cleanup paths, the
accept loop, the restart copy loop — which omits the helper, because the
wrapper copies that one itself — and the digest arguments. `run-eval.sh` holds
the bootstrap trap's brace expansion, and `run-eval-lifecycle.sh` holds the
`verify` stage's `cmp` list. `scripts/review/review-eval.test.mjs` asserts the
basenames item by item, pins the digest as a constant, and now cross-checks the
lists against `ORCHESTRATOR_FILES` so a list missed in one place fails a test
rather than a run.

**A new module is sourced from `$RUN_EVAL_SCRIPT_DIR` alone**, with no
fallback, after the `RUN-EVAL-SOURCE-SNAPSHOT-END` marker:

```sh
# shellcheck source=scripts/review/run-eval-plan.sh
source "$RUN_EVAL_SCRIPT_DIR/run-eval-plan.sh"
```

## Alternatives considered

**Source new modules from the spec worktree with a fallback.**
`${RUN_EVAL_SCRIPT_DIR:-$SPEC/scripts/review}/run-eval-plan.sh` copies the
pattern `CELL_WRITER` already uses and needs no change to the snapshot lists or
the equivalence harness. Rejected on the security ground the snapshot exists
for: it would source unsealed shell out of the spec worktree whenever
`RUN_EVAL_SCRIPT_DIR` was empty, which is exactly the state the sealed snapshot
is there to make unreachable. `CELL_WRITER` gets away with the fallback because
node executes it under the plan's digest check; a `source` runs in the
orchestrator's own shell, before any check the wrapper could still make.

**Keep the new modules out of the digest.** The digest would then name a set
that no longer decides what a run does: the plan, the cell phases and the
publication path would all sit outside it, and an edit to any of them would
leave every cell fingerprint unchanged. That is the exact failure the two
`.mjs` modules were added to the set to prevent.

**Split into a `scripts/review/run-eval/` subdirectory.** The snapshot is flat
by construction — it copies each source by basename into one directory and
sources it as `$RUN_EVAL_SCRIPT_DIR/<basename>` — so a second level would need
the snapshot, its four lists and its cleanup to carry paths instead of names.
[ADR 0064](0064-scripts-module-directories.md) is also satisfied already:
`scripts/review/` is the module directory.

## Consequences

- Adding, removing or renaming a sourced shell module is a ten-site change, and
  the order must match in every list. `review-eval.test.mjs` fails first, and
  `run_eval_source_snapshot_verify_plan` fails closed at run time.
- Every such change moves `orchestrator_digest` and therefore
  `comparability_key`, so the eval series re-anchors: an explicit `--against` a
  pre-split row is refused, and the automatic path refuses with "baseline has a
  different comparability_key". Land the change between scheduled runs, and
  either accept the first post-split run as the new anchor or assemble a bridge
  row by hand, as `docs/evals/review-skill.md` describes.
- Cached paid cells from before the change stop being reusable.
  `cellReuseDecision` refuses a cell whose `orchestrator_digest` differs unless
  the pair is in `ORCHESTRATOR_REUSE_TRANSITIONS`, which holds one historical
  entry and is not to be extended: an entry asserts that raw cell behavior is
  unchanged, which nothing proves for a live run.
- `scripts/review/review-eval-split-equivalence-fixtures.mjs` sources the
  modules it needs to reach moved functions, so a split changes exactly one
  value in `testdata/review-eval-split-equivalence/expected.json`:
  `files["generated/shell-harness.sh"].sha256`. Any other changed value, and
  any change under `processes`, is a behavior change.
- Lines 1-56 of `run-eval.sh` stay byte-frozen: `--help` prints them with
  `sed -n '2,56p' "$0"` and `expected.json` pins that stdout.

## Evidence

- The sealed snapshot and its digest:
  [`scripts/review/run-eval-source-snapshot.sh`](../../scripts/review/run-eval-source-snapshot.sh)
- The list the digest reads:
  [`scripts/review/review-eval-run-plan.mjs`](../../scripts/review/review-eval-run-plan.mjs)
- The assertions and the pinned digest:
  [`scripts/review/review-eval.test.mjs`](../../scripts/review/review-eval.test.mjs)
- The behavior proof:
  [`scripts/review/review-eval-split-equivalence.test.mjs`](../../scripts/review/review-eval-split-equivalence.test.mjs)
- The runbook:
  [`docs/evals/review-skill.md`](../evals/review-skill.md)
