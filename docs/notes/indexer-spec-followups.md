---
title: Parked indexer metric ideas
status: archived
owner: eng
canonical: false
last_verified: 2026-07-24
archived: 2026-05-29
archived_reason: "Unprioritized metric ideas moved from BACKLOG.md; promote only after current-source verification and concrete demand."
doc_type: note
scope: indexer-envio
review_interval_days: 365
garden_lane: notes-plans-archive
---

# Parked indexer metric ideas

Migrated off `BACKLOG.md` on 2026-05-29. These unprioritized ideas remain
non-canonical history rather than active work. Promote one to a GitHub issue
only when there is concrete demand and the proposal has been reverified against
the current schema.

- **`turnoverCum` per pool** — cumulative `notionalCum / time-weighted-avg(tvlUsdM)`
  since T0. We track `notionalVolume0/1` but never compute time-weighted TVL;
  needs a TWAP-style accumulator on `Pool` updated on every reserves change
  (∑ tvl·dt, ∑ dt).
- **`timeInWarnCum` per pool** — cumulative seconds spent in warn (deviation
  breach inside grace window, pre-critical) since T0. Mirror the existing
  critical rollup (`Pool.cumulativeCriticalSeconds`); requires tracking
  warn-state transitions the way `DeviationThresholdBreach` tracks critical.
- **Indexer-side chain/global totals** — add a protocol-level aggregate entity
  only if server-side totals become necessary. The dashboard currently
  aggregates pool, TVL, swap, and fee totals client-side.
- **CDP live-risk refinements** — compute accrual-aware TCR and ICR percentiles.
  The stability-pool floor has shipped through `minBoldInSp` and `spHeadroom`;
  it is no longer part of this parked idea.
