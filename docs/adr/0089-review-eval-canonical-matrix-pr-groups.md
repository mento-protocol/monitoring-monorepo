---
title: The canonical review-eval matrix runs PR groups concurrently
status: active
owner: eng
canonical: true
last_verified: 2026-09-09
scope: ci/process
date: 2026-09
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0089 — The canonical review-eval matrix runs PR groups concurrently

**Status:** Accepted (Sep 2026), in force. Extends
[ADR 0086](0086-review-eval-lane-any-grid-multi-draw.md), which recorded the
same scheduling shape for the separate experiment lane.
**Scope:** ci/process

## Context

`scripts/review/run-eval.sh` produces the row of record: the canonical
review-skill eval writes into `docs/evals/review-skill-ledger.jsonl` and its
cells are the only place this repository spends model quota outside a review
bot. It ran that matrix one cell at a time. The 2026-09-04 six-fixture full run
(`docs/evals/review-skill-runs/2026-09-04-cde7103e-full-96edaa2a`) completed 6
pipeline cells in 100 minutes, 701 to 1559 seconds each, which puts the 39-cell
full matrix at 8 to 9 hours. The default matrix deadline is 4.5 hours — three
quarters of `--deadline 21600` — so the run reached that bound mid-matrix and
reported a partial row; the operator restarted it with `--deadline 57600`.

Serialization is required _inside_ one fixture PR and nowhere else. Every cell
resets and cleans that PR's single checkout, stages `.skill/` into it, and then
lets a contestant edit the tree with a real Bash tool, so two cells of one PR
would delete each other's working tree. Two PRs are separate checkouts, cached
per PR and head (`fx-<pr>-<head>`), built through per-PR temporary directories.

## Decision

- The canonical matrix schedules cells as PR groups. The cells of one PR run
  strictly in sequence in plan order; whole groups run concurrently, up to
  `REVIEW_EVAL_PR_CONCURRENCY` (3 by default, 1 for the old serial matrix).
- The scheduler is its own sourced helper, `scripts/review/run-eval-matrix.sh`,
  and it is an orchestrator source: it is copied into the sealed run-time source
  snapshot, compared against the spec worktree, and length-framed into
  `orchestrator_digest` through `ORCHESTRATOR_FILES`.
- Group workers lead their own process groups. A worker that is signalled
  forwards to the process groups its children lead, because `run_bounded` puts
  each bounded cell command in a group of its own. The worker reads its own pid
  from a file the parent wrote, not from `BASHPID`, which the `/bin/bash` the
  launchd job execs does not have.
- Accounting is per cell, not per group: each cell writes its own status file
  and the parent sums them, so `D done, F failed, of T` is exact under
  concurrency and `T` is the whole planned matrix. No worker starts a cell past
  `MATRIX_DEADLINE`, and a worker that dies without its completion marker is
  reaped rather than waited on forever.

## Alternatives considered

- **Keep the matrix serial and widen the deadline.** Rejected: it makes every
  full run an 8-to-9-hour operator commitment for no measurement benefit, and
  the widened deadline has to be passed by hand each time or the row comes back
  partial.
- **Give every cell its own fixture clone and run all 39 concurrently.**
  Rejected: it removes the constraint by paying for it — 39 checkouts of the
  fixture repository instead of 6 — and it puts 39 model sessions in flight at
  once against one account's rate limits. The per-PR tree is also what makes a
  cell's reset auditable; per-cell trees would multiply the surface where a
  contestant's edits could leak between cells.
- **Reuse the experiment lane's Node scheduler.** Rejected: the canonical runner
  is deliberately shell, sealed and digested as shell, and its cell body is a
  shell function that stages the skill and bounds two model calls. Moving the
  loop into Node would move the orchestrator digest's subject matter with it.

## Consequences

- Every cached cell produced before this change is refused and re-run. The
  scheduler is in `ORCHESTRATOR_FILES`, so its bytes are in every cell
  fingerprint; that is the mechanism working, not a regression.
- The full run's wall-clock time is unmeasured until the next full run. The
  runbook records `hours TBD` until then.
- The row is unchanged: same cell ids, same per-PR order, same fingerprints,
  same ledger shape. A run's evidence stays byte-comparable with a serial one.
- A cell's log is buffered and emitted as one write. That is indivisible on the
  regular file the launchd job redirects to and guaranteed only to `PIPE_BUF`
  through a pipe, so `run-eval.sh | tee` can still interleave two failing cells.

## Evidence

- PR [#2323](https://github.com/mento-protocol/monitoring-monorepo/pull/2323),
  closing issue #2300.
- `scripts/review/run-eval-matrix.sh` holds the scheduler;
  `scripts/review/review-eval-run-plan.mjs` lists it in `ORCHESTRATOR_FILES`;
  `scripts/review/run-eval-source-snapshot.sh` copies, seals and digests it.
- `scripts/review/review-eval.test.mjs` covers the grouping, the serial mode,
  the deadline under concurrency, exact accounting with a failing cell, a killed
  worker, and signal forwarding to a bounded child's own process group.
- `docs/evals/review-skill.md` is the runbook for the behavior.
