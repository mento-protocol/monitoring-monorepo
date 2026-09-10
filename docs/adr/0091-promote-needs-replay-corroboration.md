---
title: A PROMOTE needs replay corroboration before it re-anchors
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

# ADR 0091 — A PROMOTE needs replay corroboration before it re-anchors

**Status:** Accepted (Sep 2026), in force.
**Scope:** ci/process

## Context

A `PROMOTE` verdict moves the review-eval baseline by itself. `resolveBaseline`
picks the newest `PROMOTE` row of the comparability key, and `revalidateRow`
recomputes the verdict from the row's own numbers, so an operator cannot record
a lower verdict by hand. From then on every run is paired against that row's
bits.

Since [ADR 0090](0090-canonical-eval-matrix-freshness-floor.md) the `pipeline`
condition takes one live finder draw per PR instead of two. The finder samples:
the 2026-09 programme watched one codex configuration draw 19 and then 10 known
defects on identical diffs. Six net apparent gains on `pipeline` alone are
therefore more likely to be sampling than they were with two OR-folded draws,
and a spurious `PROMOTE` becomes the anchor every later run reads, with the bias
invisible from that point on.

ADR 0090 wrote down the reading — a `pipeline` flip `replay` does not
corroborate is unproven — and recorded that the harness does not enforce it.

## Decision

A pre-registered rule `verdict_rules.promote_corroboration_net_flips: 3` gates
the PROMOTE branch of `verdict()`. When the headline condition is `pipeline` and
the pipeline flips would give PROMOTE, the row is PROMOTE only if `replay`
corroborates: both rows carry a `replay` condition, the two share at least
`noise_floor_defects` scored defects, and `replay` gained at least
`promote_corroboration_net_flips` net defects. Uncorroborated, the verdict is
GREEN and the reasons carry the pipeline gain plus one line naming why `replay`
did not corroborate it and stating that the gain does not re-anchor the
baseline.

Three is half the PROMOTE threshold. `replay` replays frozen finder reports over
the 39 grid defects with two OR-folded draws, so it carries no finder sampling
and less verifier sampling than a single-draw `pipeline`. Asking it for half the
threshold in the same direction, on at least the noise-floor number of shared
defects, confirms the direction beyond noise without demanding that one verifier
reproduce a PROMOTE-sized gain on 39 defects.

The gate reads a `pipeline` headline only. When `replay` is the headline no live
pipeline cell scored, and `replay`'s finder is frozen, so there is no finder
sampling to corroborate away.

RED is unchanged. A spurious RED costs an investigation; a spurious PROMOTE
silently moves the reference.

## Alternatives considered

- **Refuse the anchor in `resolveBaseline` instead.** Rejected: the verdict
  printed in the report and the ledger would still read PROMOTE while the
  baseline quietly stayed put, so the reader and the harness would disagree.
- **Raise `regression_net_flips`.** Rejected: it moves the RED line with the
  PROMOTE line, and the cost of the two errors is not symmetric.
- **Ask `replay` for the full six net flips.** Rejected: `replay` sees 39 of the
  51 defects, so it would demand a larger effect from the narrower condition and
  no real improvement would clear it.
- **Leave it to the reviewer.** Rejected: `revalidateRow` recomputes the
  verdict, so a reviewer who disagrees cannot record a lower one.

## Consequences

- The contract digest moves, and with it `matcher_digest` and the comparability
  key, so the first run after this change resolves no baseline and re-anchors.
  That was already true of ADR 0090's matrix change.
- A real improvement that only `pipeline` shows now needs a second run, or the
  experiment lane, to promote. The lane holds the finder fixed and is where
  ranking belongs ([ADR 0086](0086-review-eval-lane-any-grid-multi-draw.md)).
- An uncorroborated gain reads GREEN, so the report states it as a gain and says
  it did not re-anchor. Nothing is lost from the record.
- The rule binds the contracts that carry the key. `--report --contract` with a
  contract from before this change still prints the verdict that run saw, so
  history does not move under a rule its runs never ran against.
- Scaling the control-drift waiver threshold to control's 39-defect scope was a
  separate verdict-rule decision, taken in
  [ADR 0094](0094-control-waiver-scaled-to-grid-scope.md).

## Evidence

- `scripts/review/review-eval-report.mjs` (`verdict`,
  `promoteCorroborationGap`) holds the rule;
  `scripts/review/review-eval-fixtures.mjs` validates the new key.
- `docs/evals/review-skill-fixtures.json` pre-registers
  `promote_corroboration_net_flips: 3`.
- `scripts/review/review-eval-report.test.mjs` covers a corroborated PROMOTE, an
  uncorroborated gain on every branch, an unchanged RED, and a `replay`
  headline; `scripts/review/review-eval.test.mjs` proves the recorded PROMOTE
  fails `revalidateRow` and never becomes the anchor.
- Raised on [issue 2324](https://github.com/mento-protocol/monitoring-monorepo/issues/2324).
