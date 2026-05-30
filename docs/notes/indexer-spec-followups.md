---
title: Indexer SPEC §2 follow-up metrics (parked)
status: parked
owner: eng
last_verified: 2026-05-29
---

# Indexer SPEC §2 follow-up metrics (parked)

Migrated off `BACKLOG.md` 2026-05-29. These are low-priority SPEC §2 aggregate
metrics that no one has prioritized — parked here rather than filed as issues to
avoid a stale `needs-grooming` pile. Promote any of these to a GitHub issue (with
the agent-task form) when there is concrete demand.

- **`turnoverCum` per pool** — cumulative `notionalCum / time-weighted-avg(tvlUsdM)`
  since T0. We track `notionalVolume0/1` but never compute time-weighted TVL;
  needs a TWAP-style accumulator on `Pool` updated on every reserves change
  (∑ tvl·dt, ∑ dt).
- **`timeInWarnCum` per pool** — cumulative seconds spent in warn (deviation
  breach inside grace window, pre-critical) since T0. Mirror the existing
  critical rollup (`Pool.cumulativeCriticalSeconds`); requires tracking
  warn-state transitions the way `DeviationThresholdBreach` tracks critical.
- **ChainStat / GlobalStat** — protocol-level aggregate entity (total pools,
  total swaps, global TVL, `chainProtocolFeesCum` / `globalProtocolFeesCum`).
- **CDP live-risk refinements** — compute live TCR/ICR percentiles from accrued
  interest; add a governance-owned stability-pool buffer source if the protocol
  wants headroom measured against more than zero deposits.
