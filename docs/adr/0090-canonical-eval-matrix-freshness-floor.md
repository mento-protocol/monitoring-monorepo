---
title: The canonical review-eval matrix is a freshness floor
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

# ADR 0090 — The canonical review-eval matrix is a freshness floor

**Status:** Accepted (Sep 2026), in force.
**Scope:** ci/process

## Context

A full canonical run planned 39 cells: two live `pipeline` draws of all nine
fixtures, one `replay` cell per frozen finder report on the six grid fixtures,
and one `control` cell on all nine. That is about $145 of contestant spend, and
the judge pass over the same cells costs about $4 and nine minutes each — about
$155 and six hours more. The 2026-09-05 attempt did not fit the judge pass
inside one usage window and re-spent nineteen cells on the retry.

The second live draw exists because the finder samples, and the spread is real:
the 2026-09 programme watched one codex configuration draw 19 and then 10 known
defects on identical diffs. Two draws does not measure that spread — two points
estimate nothing — and it does not remove it: the scorer folds a condition's
draws with OR, so a second draw damps run-to-run noise in the headline flip
count and buys nothing else. Nothing ranks on this condition either. Ranking is
the experiment lane's job, and the lane earns it a different way: every draw of
a lane replays one frozen finder report through both arms
([ADR 0086](0086-review-eval-lane-any-grid-multi-draw.md)), so the finder is
held fixed and the difference it reports is the skill.

`control` ran on all nine fixtures. It is read as a paired per-defect
difference against the previous run's `control`, and the three non-grid
fixtures (PRs 1982, 1984 and 2001) were added to widen what `pipeline` reviews,
not to add paired evidence.

## Decision

A full run plans 27 cells: one live `pipeline` draw of every fixture (9), one
`replay` cell per frozen finder report on the grid (12), and one `control` cell
per grid fixture (6). `PIPELINE_DRAWS` is 1, and `planCells` and
`plannedMatrix` both take `control` from `gridFixtures()`.

The canonical row's job is to say the operating point still works and to anchor
the next comparison, so it buys breadth of PRs rather than repeat draws.

The damping the second draw provided goes with it, and `replay` replaces it as
the corroborating signal: it is variance-free by construction, it is unchanged
at 12 cells, and a `pipeline` flip verdict that `replay` does not corroborate
is read as unproven rather than acted on.

The ledger's complete-matrix draw checks become floors rather than equalities,
so a row recorded under a larger matrix still validates: it ran a superset of
today's cells, and it carries a different comparability key in any case.

## Alternatives considered

- **Keep two draws and cut `replay`.** Rejected: `replay` is the only
  variance-free signal in the suite and the cheapest condition per cell.
- **Keep two draws and cut fixtures.** Rejected: the grid was widened to six
  fixtures in 2026-09 precisely because three PRs gave too few paired P1
  opportunities.
- **Leave the matrix at 39 cells and run it less often.** Rejected: the run is
  already quarterly, and a staler freshness floor is the thing the ledger
  exists to prevent.

## Consequences

- A run costs about $99 of contestant spend and about $108 of judging, roughly
  30% less than before, and the judge pass drops from about six hours to about
  four. Matrix wall-clock time is not claimed here: since
  [ADR 0089](0089-review-eval-canonical-matrix-pr-groups.md) the runner works PR
  groups concurrently, so twelve fewer cells shortens the serial worst case but
  the measured figure comes from the next full run.
- The comparability key moves, because `planCells` and `plannedMatrix` are both
  hashed into `matcher_digest`. Rows scored under the 39-cell matrix become a
  separate series: they still validate and still report, but the first 27-cell
  run resolves no baseline and re-anchors.
- `pipeline` records one bit per defect, so its number is a single live sample
  and carries the finder's spread. `verdict()` still calls six net flips RED or
  PROMOTE, and finder sampling alone can now reach that on a run where nothing
  changed. Read a `pipeline` flip beside `replay` before acting on it: `replay`
  runs frozen reports, so it does not move with the finder. `replay` covers the
  39 grid defects only, so a flip on one of the 12 defects from PRs 1982, 1984
  and 2001 is unchecked rather than uncorroborated. The thresholds in
  `verdict_rules` are pre-registered and are deliberately not re-tuned here.
- That reading is not enforced. A PROMOTE re-anchors the baseline on its own
  and its verdict is recomputed from the row's numbers, so it cannot be lowered
  by hand.
  [Issue 2324](https://github.com/mento-protocol/monitoring-monorepo/issues/2324)
  carries the rule change, which is its own pre-registered decision.
- `control` recall is measured over the 39 grid defects while `pipeline` covers
  all 51. The two rates are over different denominators and must not be
  subtracted from each other within a run.

## Evidence

- `scripts/review/review-eval-fixtures.mjs` (`PIPELINE_DRAWS`,
  `plannedMatrix`) and `scripts/review/review-eval-run-plan.mjs`
  (`planCells`) plan the matrix; `scripts/review/review-eval.test.mjs` asserts
  the 9/12/6 composition and that `control` cells exist only for grid fixtures.
- `scripts/review/review-eval-ledger.mjs` (`completeMatrixProblems`) holds the
  draw floors; `scripts/review/review-eval-ledger.test.mjs` covers both a short
  matrix and an over-sampled historical row.
- `docs/evals/review-skill.md` is the runbook this decision changes.
