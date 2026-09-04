---
title: The experiment lane runs the whole grid and decides on paired draws
status: active
owner: eng
canonical: true
last_verified: 2026-09-04
scope: ci/process
date: 2026-09
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0086 — The experiment lane runs the whole grid and decides on paired draws

**Status:** Accepted (Sep 2026), in force. Supersedes ADR 0083 on the fixed
three-fixture grid and the single-draw thresholds.
**Scope:** ci/process

## Context

ADR 0083 pinned the lane to grid fixtures 1990, 1995 and 1999 and to one draw
per fixture, and it wrote the resulting counts into the policy: two net known
matches to pass a screen, 9 of 12 candidate P1 matches to pass a holdout. A
fixture added to the grid could not be used, and a fixture removed from it broke
planning.

The bar was also calibrated on one sample of a verifier that samples. Today's
screens had the incumbent alone drawing 15, 18, 16, 16 and 17 known matches on
identical inputs. A +2 bar on one draw therefore sits inside the incumbent's own
spread: a candidate can clear it, or miss it, without differing from the
incumbent at all.

## Decision

The lane takes the contract's grid as it stands: every fixture with
`grid: true`, in PR order, three or more. `--draws N` repeats each fixture as N
lanes, default one and at most five, recorded in the plan and in every stage.
The cap is a spend guard: each draw adds `grid x 2` paid verifier cells to
every stage, and a wider panel is bought with fixtures rather than repeats.
Every draw of a lane replays the same frozen report through both arms, cell ids
and cache identities carry the draw index, and the treatment order alternates on
the parity of the fixture index plus the draw index. Every draw of one PR shares
that PR's materialized fixture tree, so the draws of a PR run in sequence and
only whole PRs run at once, three of them; that number is a concurrency cap, not
the panel size.

Every threshold is derived from the panel rather than written down. The screen
needs a paired net of `max(2, round(0.06 x scorable ids x draws))`, the combined
holdout `max(3, round(0.06 x scorable ids x draws x 2))`. P1 opportunities are
the grid's P1 ids times the two frozen reports times the draws; a finalist needs
0.75 of them matched and a P1 net of `max(2, round(P1 opportunities / 6))`. Both
per-PR bars are `ceil(PRs / 2)`. At three fixtures and one draw these promote
bars are ADR 0083's own numbers; the verdicts they produce are not, because the
significance rule below changed with them.

The reject bound is derived separately, and is
`-max(2, round(0.06 x scorable ids x draws))` at both stages. It is not the
negated promote bar: the combined bar doubles because the holdout reads a second
frozen report per fixture, and doubling the reject bound with it would stop
calling a loss the screen already rejects. Derived this way the old grid keeps
ADR 0083's minus two at both stages.

A grid that froze no P1 defect anywhere sets `candidate_p1_min` and
`p1_net_min` to zero and records `p1_gates: "not applicable"`, and `--plan`
says so on stderr. Left at their floors those bars would ask a finalist for a P1
net of two out of zero opportunities, which is a campaign that cannot pass.

The decision reads paired differences, one per lane: `d` is the candidate's
known matches minus the incumbent's on the same report and the same draw.
`PROMISING` needs the net, no P1 net loss, the per-PR bar, and a one-sided
exact sign-flip permutation test at `p_greater <= 0.10`. That test binds at
every panel width, so a narrow panel fails on the p-value it actually earned
rather than being waved past the check: three same-direction differences floor
at 1/8 and four at 1/16, so fewer than four informative differences in one
direction can never promote. Only the non-zero differences are enumerated, and
only they select the method: a tied lane flips to itself and changes neither
tail, so ties never widen the distribution and never force sampling. Flips are
enumerated exactly up to twenty informative pairs and sampled 20,000 times above
that from a generator seeded on the plan digest. A net at or below the reject
bound, a P1 net loss, or a significant permutation in the opposite direction is
`REJECT`. Claim-inflation classification keeps its ratio rule on the claim
totals. The decision records the p-value in its reasons, and the pair count, the
non-zero count and the thresholds in its metrics.

## Alternatives considered

- **Keep one draw and raise the bar.** Rejected. A higher bar on one draw buys
  its specificity with power: the observed incumbent spread of 15 to 18 would
  need a bar near +4, which no honest candidate improvement of this size
  reaches, so every real gain would read `INCONCLUSIVE`.
- **Take more draws and compare the two arms' means.** Rejected. The per-PR
  variance is the largest term — PR 1999 alone carries ten scorable ids — so an
  unpaired comparison spends most of its power on differences between fixtures
  that both arms saw. Pairing inside the lane removes that term before the test
  reads anything.
- **Keep the fixed three-PR list and add fixtures by editing the harness.**
  Rejected. The pinned list made the contract and the code two sources of truth
  for the panel, and the numbers derived from it were invisible constants.

## Consequences

- Cost scales with `grid x draws`: each stage is `grid x draws x 2` verifier
  cells, and `--dry-run` now prints that count in total and per arm so the
  operator prices a stage before paying for it.
- The three-PR single-draw panel is retired as a promotion panel, and that is
  the intended consequence. Three lanes cannot reach a 0.10 alpha at all, and
  the recorded 15 -> 19 screen has only two lanes that differ, at 1/4. The
  incumbent alone drew 15, 18, 16, 16 and 17 known matches on those same
  inputs, so a verdict from three lanes was reading its own verifier spread. The
  four recorded screens stay pinned as tests, now as `INCONCLUSIVE`,
  `INCONCLUSIVE`, `INCONCLUSIVE` and `REJECT`.
- One draw keeps today's cost. At six grid fixtures a single-draw screen reaches
  six pairs, and four of them differing already clears the alpha at 1/16.
- Two draws double the pairs, so a panel with tied lanes still reaches a width
  that can clear the alpha, at twice the cells.
- A stage stops at its first lane failure. The failing lane sets a stage-wide
  flag before its error is rethrown, and every group reads that flag before
  starting another lane, so a concurrent PR does not keep paying for draws whose
  stage can no longer produce a decision. Lanes already running finish, because
  their cells are paid for either way and a completed cell is cached for the
  rerun.
- A `live-paired` stage generates its finder output once per PR, before that
  PR's first draw, and hands the same report to every draw and both arms. A
  second call would make two draws of one PR measure two reports rather than the
  verifier's own spread.
- A fixture added to the grid joins the lane and moves every threshold with it.
  A grid that falls below three fixtures fails planning rather than judging on
  too little.
- The harness is now nine modules, each under the ADR 0065 line cap, and the
  plan's harness digest binds all of them.
- The canonical rerun manifest derives its cell count from the contract — two
  pipeline draws per fixture, one replay per frozen grid report, one control
  cell per fixture — so a fixture added to the grid widens the manifest instead
  of failing planning against a literal.

## Evidence

- `experimentPolicy` and `signFlipTest` in
  `scripts/review/review-eval-experiment-stats.mjs` derive the thresholds and
  run the permutation test.
- `experimentFixtures`, `treatmentOrder` and `stageLanes` in
  `scripts/review/review-eval-experiment-contract.mjs` build the grid and the
  draws.
- `pairedDifferences`, `recallFailures` and `regressions` in
  `scripts/review/review-eval-experiment-decision.mjs` decide on the pairs.
- `fullRerunCellCount` in
  `scripts/review/review-eval-experiment-contract.mjs` derives the manifest
  size, and `laneGroups` in
  `scripts/review/review-eval-experiment-runtime.mjs` keeps the draws of one PR
  off each other's fixture tree.
- `scripts/review/review-eval-experiment-screens.test.mjs` pins the four
  recorded screens; `scripts/review/review-eval-experiment-stats.test.mjs`
  covers the flip test in both directions, the tie handling against brute force,
  the reject bound and the inert P1 bars;
  `scripts/review/review-eval-experiment-contract.test.mjs` covers the per-draw
  identities, the draw cap and the zero-P1 grid; and
  `scripts/review/review-eval-experiment-runtime.test.mjs` covers the shared
  live source, the stage-abort flag and the lane checks in
  `laneForRecord`.
- The runbook passage in `docs/evals/review-skill.md`.
- ADR 0083 and issue #2187.
