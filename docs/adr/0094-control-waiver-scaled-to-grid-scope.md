---
title: The control-drift waiver is scaled to control's grid scope
status: active
owner: eng
canonical: true
last_verified: 2026-09-10
scope: ci/process
date: 2026-09
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0094 — The control-drift waiver is scaled to control's grid scope

**Status:** Accepted (Sep 2026), in force.
**Scope:** ci/process

## Context

`controlMoved()` waives one RED: a net regression the `control` condition fell
with is model drift, not a skill regression, so the run is AMBER and the reason
says the score is not attributable. The waiver has two tests. The direction test
asks whether control moved the way the headline did. The magnitude test asks
whether control moved far enough to explain the loss.

Since [ADR 0090](0090-canonical-eval-matrix-freshness-floor.md) `control` runs
the six grid fixtures alone — 39 of the 51 scorable defects — while the headline
covers all nine. The magnitude test still asked control for
`regression_net_flips` (6), the number the headline has to move over its 51.
Drift spread evenly over the suite therefore reaches 6 on the headline and about
4.6 on control, so it fires the RED and cannot waive it. That is a RED that
should have been AMBER: an investigation opened against the skill for a move the
model made. ADR 0090 recorded the gap and left the threshold alone; ADR 0091
carried it as issue 2333.

## Decision

A pre-registered rule `verdict_rules.control_waiver_net_flips: 5` supplies the
magnitude test. Five is 6 × 39 / 51 rounded up. Rounding up keeps the waiver at
least as strict per defect as the rule it waives: at 4 it would excuse a RED on
a smaller proportional move than the one that fired it.

The direction test is unchanged and still reads `flips.delta`, the headline's
movement over every defect it scored. Keying direction to control's own slice
would let a grid gain sitting beside a larger non-grid loss wave through a net
regression whose grid share points the other way.

`checkContract` derives both bounds from the contract's own scorable id lists:
the value must be a positive whole number, at most `regression_net_flips`, and
at least `ceil(regression_net_flips × grid_scorable / total_scorable)`. A
fixture added to or dropped from the grid moves the lower bound, so a widening
fails validation until the number is registered again. The threshold stays
pre-registered rather than silently re-derived from whatever the grid happens to
hold.

The rule binds the contracts that carry the key, the binding
[ADR 0091](0091-promote-needs-replay-corroboration.md) set for
`promote_corroboration_net_flips`. A contract from before this change never
registered it, and `--report --contract <archived>` has to reproduce the verdict
that run saw, so an absent key leaves `regression_net_flips` in place. A key
present with a value the gate cannot read waives nothing: the contract claims
the scaled waiver and the gate cannot apply it.

## Alternatives considered

- **Lower `regression_net_flips` instead.** Rejected: it moves the RED line and
  the PROMOTE line together, and the two errors do not cost the same.
- **Round 4.6 down to 4.** Rejected: the waiver would then excuse a RED on a
  smaller move per defect than the one that triggered it.
- **Compute the threshold at verdict time from the fixture counts.** Rejected:
  the number would change under a fixture edit with no decision recorded, which
  is what pre-registration exists to prevent.
- **Key the direction test to control's grid slice as well.** Rejected: a grid
  gain beside a larger non-grid loss would waive a net regression that control
  contradicts. `review-eval-report.test.mjs` holds that case.

## Consequences

- The contract digest moves, and with it `matcher_digest` and the comparability
  key, so the first run after this change resolves no baseline and re-anchors.
  ADR 0090 and ADR 0091 each did the same.
- Evenly spread model drift now reads AMBER with the reason naming both moves
  and the threshold, instead of RED against the skill.
- A regression control did not follow is still RED, and every absolute floor —
  P1 recall, the wrong-claims ceiling, empty-PR cells — is unchanged. The waiver
  covers the paired regression alone.
- Widening the grid is now a two-part change: the fixture edit and a re-registered
  `control_waiver_net_flips`. Validation names the required floor.
- Issue 2333 closes with this record.

## Evidence

- `scripts/review/review-eval-report.mjs` (`controlMoved`,
  `controlWaiverThreshold`) holds the rule;
  `scripts/review/review-eval-fixtures.mjs` (`checkContract`, `scorableScopes`)
  validates the key and its bounds.
- `docs/evals/review-skill-fixtures.json` pre-registers
  `control_waiver_net_flips: 5`.
- `scripts/review/review-eval-report.test.mjs` covers the evenly spread drift
  that now waives, a move one flip short of the threshold, an archived contract
  without the key, an unreadable value, and the grid gain the direction test
  still refuses; `scripts/review/review-eval-fixtures.test.mjs` covers both
  bounds and the derived floor.
- Raised on [issue 2333](https://github.com/mento-protocol/monitoring-monorepo/issues/2333).
