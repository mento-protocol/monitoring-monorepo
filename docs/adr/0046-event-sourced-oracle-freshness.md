---
title: Oracle freshness is reconstructed from persisted report events
status: active
owner: eng
canonical: true
last_verified: 2026-07-24
scope: indexer-envio
date: 2026-07
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0046 — Oracle freshness is reconstructed from persisted report events

**Status:** Accepted (Jul 2026), in force.
**Scope:** indexer-envio (constrains dashboard and metrics freshness reads)

## Context

`Pool.lastOracleReportAt` must match SortedOracles' median reporter timestamp,
including flat reports that advance reporter timestamps without emitting
`MedianUpdated`. The previous implementation recovered that value with an
exact historical `medianTimestamp` call for every tracked `OracleReported` and
`MedianUpdated`. Polygon's report history made those archive reads dominate
hosted replay time and tied replay throughput to a public RPC rate limit.

SortedOracles already emits enough ordered information to maintain the active
reporter timestamp list after one exact starting snapshot. Report removal is a
separate `OracleReportRemoved` event; `OracleRemoved` alone does not prove that
a live report was deleted.

## Decision

Persist one `OracleFeedState` row per feed referenced by an indexed pool:

- On the first tracked `OracleReported` or `OracleReportRemoved`, read
  `getTimestamps` at an exact block boundary and obtain the effective positive
  report expiry. If a currently referencing pool row was last persisted before
  the event block, bootstrap the parent block and apply the current log normally.
- Otherwise bootstrap exact block-close timestamps and effective expiry, then
  absorb report/removal logs from that block. JSON-RPC cannot snapshot an
  intra-block boundary, and a report before pool deployment or feed-assignment
  self-heal would otherwise be missing from the parent snapshot forever. Pool
  health accounting is block-timestamp based, so block-close initialization
  preserves the final block state without adding time to an earlier interval.
- Apply `OracleReported` reporter/timestamp upserts and
  `OracleReportRemoved` deletions in block/log order. Recompute the contract's
  upper median timestamp from the persisted active reports after each change.
- Let `MedianUpdated` consume the state written by its preceding report or
  removal log; it must not perform a traffic-scaled RPC fallback.
- Bootstrap raw global/token expiry configuration once per tracked feed into
  `OracleExpiryState`, then apply `ReportExpirySet` and
  `TokenReportExpirySet` in block/log order. A zero token value derives the
  global fallback from persisted state, so a later same-block governance log
  cannot leak backward. Never-tracked feeds create no state and perform no RPC.
- Fail the event before writes when an exact bootstrap, positive expiry, or
  ordered state transition cannot be proven. A semantics change requires a
  replay-integrity marker bump and a clean full replay before promotion.

## Alternatives considered

- **Keep one exact `medianTimestamp` read per report** — rejected: it is exact,
  but makes high-cardinality historical event traffic wait on archive RPC and
  was the dominant Polygon replay bottleneck.
- **Use the latest-block value after a historical RPC failure** — rejected: it
  imports future reports into an older replay boundary and can silently renew
  freshness.
- **Use the `MedianUpdated` event timestamp or value-change cadence** —
  rejected: a reporter can refresh a flat value without emitting that event,
  so the feed would become falsely stale.
- **Treat `OracleRemoved` as report removal** — rejected: the contract emits
  the distinct `OracleReportRemoved` event only when a report actually existed.

## Consequences

- Normal `OracleReported`, `OracleReportRemoved`, and `MedianUpdated` traffic is
  independent of archive RPC throughput after one bootstrap per tracked feed.
- Feeds that never become pool dependencies do not create state or add replay
  writes. A newly tracked feed's first block is intentionally block-atomic;
  later blocks use exact log-order transitions.
- Replays persist a small active-reporter list per feed and perform deterministic
  sorting after each report transition.
- A bootstrap provider outage fails closed and requires retry or a clean replay;
  the indexer never fabricates an historical freshness anchor.
- The dashboard and metrics bridge continue reading `Pool.lastOracleReportAt`
  and `Pool.oracleExpiry`; they do not need a new runtime query path.
- Both mainnet and testnet configs must retain `OracleReportRemoved`, and deploy
  verification must reject pre-v3 oracle-freshness replays.

## Evidence

- `indexer-envio/src/oracleFeedState.ts` implements the pure ordered state
  transitions and SortedOracles upper-median rule.
- `indexer-envio/src/oracleExpiryState.ts` implements raw/effective expiry
  fallback and ordered governance transitions.
- `indexer-envio/src/handlers/oracleFeedState.ts` owns bounded bootstrap,
  fail-closed validation, report removal, and pool freshness propagation.
- `indexer-envio/test/oracleFeedState.test.ts`,
  `indexer-envio/test/oracleExpiryState.test.ts`, and
  `indexer-envio/test/oracleFeedStateHandlers.test.ts` cover deterministic
  transitions, same-block ordering, bootstrap bounding, expiry changes, and
  removal-only freshness updates.
- `indexer-envio/config/replay-integrity.json` and
  `scripts/deploy-indexer-verify.mjs` enforce the full-replay boundary.
