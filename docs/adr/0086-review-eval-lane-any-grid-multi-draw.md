---
title: The experiment lane runs any grid at N draws and decides on paired evidence
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

# ADR 0086 — The experiment lane runs any grid at N draws

**Status:** Accepted (Sep 2026), in force. Supersedes ADR 0083 on the fixed
three-fixture grid and the single-draw thresholds.
**Scope:** ci/process

## Context

[ADR 0083](0083-non-ledger-review-eval-experiments.md) pinned the lane to PRs
1990, 1995 and 1999 at one draw, with bars written as counts for that panel: +2
to promote, −2 to reject, 12 P1 opportunities, 24 rerun cells. Adding a grid
fixture failed planning, and the incumbent alone drew 15, 18, 16, 16 and 17
known matches on identical inputs, so +2 on one draw sat inside verifier noise.

## Decision

- The grid is every contract fixture marked `grid: true`, at least three; three
  is now the cap on fixture trees at once, not on panel size. Draws of one PR
  run in sequence on its shared tree, PRs run concurrently, and a live-paired
  PR runs one finder report for all its draws.
- `--plan --draws N` (1..5, default 1) repeats every fixture N times against the
  same frozen report. Lane ids carry `-d<k>`, every cache identity carries the
  draw, and arm order alternates on the parity of the fixture and the draw.
- Every threshold derives from the panel: the screen bar is
  `max(2, round(0.06 × scorable ids × draws))`, the combined bar doubles for the
  holdout's second report, and with `P` the P1 opportunities, `candidate_p1_min`
  is `round(0.75 × P)` and `p1_net_min` `max(2, round(P / 6))`, both zero when
  `P` is zero. The manifest counts the cells `planCells` derives.
- Decisions read the paired per-lane difference in known matches. A net loss
  reaching the stage's own bar, or any P1 net loss, is a `REJECT`.

## Alternative

Widen the grid and keep one draw. Rejected: more fixtures buy independent PRs
but still measure each once, leaving no repeat measurement of the same PR.

## Consequences

A stage costs `grid × draws × 2` verifier cells, so draws are a per-campaign
spend decision and five is the guard. Decisions report `sign_flip` — pairs,
informative pairs, and an exact one-sided p-value — as a non-gating diagnostic.

## Evidence

`review-eval-experiment-grid.mjs` derives the panel and its bars,
`review-eval-experiment-contract.test.mjs` replays four recorded screens on the
narrowed contract, and `review-eval-experiment-grid.test.mjs` a six-fixture grid.
