---
title: Replayed SortedOracles events are handler-layer no-ops; the pure guards stay fail-closed
status: active
owner: eng
canonical: true
last_verified: 2026-09-15
scope: indexer-envio
date: 2026-09
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0105 — Replayed SortedOracles events are handler-layer no-ops

**Status:** Accepted (Sep 2026), in force. Refines one clause of
[ADR 0046](0046-event-sourced-oracle-freshness.md); that ADR stays in force.
**Scope:** indexer-envio

## Context

[ADR 0046](0046-event-sourced-oracle-freshness.md) made SortedOracles freshness
event-sourced: `OracleFeedState` and `OracleExpiryState` carry a
`(updatedAtBlock, updatedAtLogIndex)` watermark, and the pure transitions throw
when an event arrives at or behind it. That fail-closed rule assumes each event
reaches a handler exactly once.

Envio does not deliver exactly once. Two runtime facts, read in
`envio@3.10.0`, set the delivery contract:

- A batch is cut by item count, not by block. When the cut falls inside a
  block, `FetchState.getProgressBlockNumberAt` (`FetchState.res:3096`) records
  progress as `nextItem.blockNumber - 1`. `PgStorage.writeBatch`
  (`PgStorage.res:1367-1435`) then commits that block's **entity writes** and
  the lower `envio_chains.progress_block` in one transaction. The commit is
  atomic, so this is not a torn write — the entity frontier is deliberately
  ahead of recorded progress by the partial block.
- On the next start, `Persistence.resumeInitialState` restores that
  `progress_block` and `FetchState` resumes at `progress_block + 1`
  (`FetchState.res:1584`, `FetchState.res:2629`). The whole partial block is
  fetched and delivered again, against entity rows that already reflect part
  of it.

Processing also runs ahead of the writer: `BatchProcessing.processNextBatch`
hands a processed batch to `Writing.commitBatch`, which queues it for an
asynchronous write fiber. A process death drops the queued batches — their
entity writes and their progress together — so the resume window is at least
the tail partial block and can be several batches wide.

On 2026-09-15 the from-genesis resync of commit `a57133c21` crashed with
`OracleReported is out of order block=60779445 logIndex=4`, eight seconds after
a silent process death and restart. The next restart passed, because the second
run's batches cut elsewhere. The failure is a property of the delivery
contract, not of that block.

## Decision

Detect an already-applied event at the handler layer and make it a logged
no-op. Keep every throw in the pure transitions.

- `oracleFeedState.ts` and `oracleExpiryState.ts` each export
  `isEventAlreadyApplied(state, event)`: true when `eventPosition(state, event)`
  is negative or `event.blockNumber <= state.bootstrapThroughBlock`. That is
  the union of the orderings the five throw sites reject
  (`applyOracleReport`, `applyOracleReportRemoval`, `applyOracleFeedExpiry`,
  and both `validateEventOrder` messages behind `applyTokenReportExpiry` and
  `applyGlobalReportExpiry`).
- `resolveOracleFeedState` and `resolveOracleExpiryState` consult the predicate
  before calling a transition. When it holds they emit one `context.log.warn`
  carrying the token `sortedOracles.replayedEventIgnored`, the guarded helper
  that rejected the event (`site=`), the chain, feed, event position, and the
  row's watermark, then return the persisted row with no `set`. One event can
  reach two of these helpers, so `site=` is what makes a token attributable.
- `updateOracleFeedStateExpiryIfPresent` uses the narrower
  `isEventBehindWatermark` — `eventPosition(state, event) < 0` alone, the only
  ordering `applyOracleFeedExpiry` rejects. The wider predicate belongs to the
  resolvers, which own their bootstrap. The feed row's block-close bootstrap
  takes its expiry from `OracleExpiryState` as that row stood at bootstrap
  time, so a later expiry log in the same block still has to propagate here.
  Widening this site would leave `OracleFeedState.reportExpiry` stale and let
  it overwrite the correct `Pool.oracleExpiry` on the next report.
- In both expiry transitions the guard precedes the value validation, so a
  replayed log with an invalid expiry is ignored rather than rejected. That is
  sound: an invalid value throws on first delivery, so the watermark can never
  be past one.
- The re-delivered tail of an interrupted batch lands exactly on the
  watermark, where `eventPosition` is 0 and the predicate is false. Both feed
  transitions return their input unchanged there and throw on a conflicting
  payload, and every applying path rebuilds the row, so
  `resolveOracleFeedState` reads that case off reference equality and reports
  it as a replay too.
- `resolveOracleFeedState` returns `{ state, replayed }`, and the
  `OracleReported` and `OracleReportRemoved` handlers return on `replayed`
  before their downstream pool path. A replay means the batch that first
  applied the event committed, and Envio commits a batch's entity writes in one
  transaction, so every downstream write for that event is already persisted.
  Redoing them would rewrite the event-keyed `OracleSnapshot` row from
  post-window pool and median state, and no later event repairs an
  event-keyed row.
- The transitions keep throwing. A caller that reaches one with an
  out-of-order event still fails the batch, so the guard cannot be bypassed by
  a future call site that forgets the predicate.
- Preload stays write-free and silent. Every SortedOracles handler returns
  inside its `context.isPreload` branch before these helpers run, and the
  runtime independently hands the preload pass `Logging.noopLogger`
  (`UserContext.res:321`), so the token cannot be emitted twice per event.

## Alternatives considered

- **Keep crashing and rely on the restart loop** — rejected. The crash is the
  expected outcome of at-least-once delivery, so it converts a routine restart
  into a second restart and a red deployment. The 2026-09-15 resync needed two
  restarts to pass; a longer replay window would not have terminated.
- **Content-verified replay detection** — rejected. The row cannot support it.
  `OracleFeedState` stores only the current reporter set and the watermark, so
  a re-delivered `OracleReported` for a reporter whose timestamp has since
  moved is indistinguishable from a genuine inversion by content alone. Only
  the position is authoritative.
- **Widen the pure guards to return the state instead of throwing** —
  rejected. The transitions are the contract ADR 0046 relies on; a silent
  return there would also swallow a real ordering defect reached from a new
  call site.

## Consequences

- A genuine intra-run ordering inversion no longer halts the indexer. It
  surfaces as the `sortedOracles.replayedEventIgnored` token instead of a
  crash. Per [ADR 0052](0052-envio-logs-prometheus-grafana-alerting.md) Envio
  logs diagnose and do not alert, so an operator reads it with
  `pnpm deploy:indexer:logs "$COMMIT" --level warn --since 2h` and greps the
  token. The token is a warning, so `--errors-only` will not show it.
- Expected tokens cluster right after a restart. Tokens with no preceding
  restart in the same deployment are the signal worth investigating.
- The feed row proves the batch committed, not that every pool in the fan-out
  wrote. `OracleReported` catches `OracleReportedPreWriteFailure` per pool and
  logs it, so a transient RPC failure can leave one pool unwritten in a batch
  that otherwise committed; a replay then skips that pool's repair. The next
  report for the feed repairs it, and the pre-write failure already logs its
  own warning, so no state is permanently incomplete. Proving per-pool
  completion needs persisted evidence the row does not carry today.
- A re-delivery inside a feed's own bootstrap block stays undetected. That
  branch returns the persisted row for every log in the block without
  recording which logs it has seen, so a first delivery and a re-delivery are
  indistinguishable there. This predates the guard — the branch never threw —
  and the exposure is one block per feed. Closing it needs a persisted per-log
  frontier on `OracleFeedState`, which is a schema change with its own resync,
  so it is not done here.
- The two expiry handlers still run their downstream path on a replay:
  `updatePoolsOracleExpiry` rewrites `Pool.oracleExpiry` with the same value
  and restamps `Pool.updatedAtBlock` and `updatedAtTimestamp` from the
  replayed, lower block. Before this change the transition threw and that
  whole batch rolled back, so these writes are newly reachable. They converge —
  the whole window is re-delivered in order and ends at the same values, and
  no row there is keyed by the event — but `Pool` carries no ordering
  watermark, so that convergence rests entirely on in-order re-delivery.
  Giving `Pool` its own watermark would touch every write path in the indexer
  and is out of scope here.
- Committed replay output for a clean run is unchanged, so
  `config/replay-integrity.json` needs no bump.

## Evidence

- Envio runtime, `envio@3.10.0`: `src/FetchState.res:3096`
  (`getProgressBlockNumberAt`), `src/PgStorage.res:1367-1435` (one
  `Postgres.beginSql` around `setProgressedChains` and the entity writes),
  `src/Persistence.res:280-297` (`resumeInitialState`),
  `src/BatchProcessing.res.mjs:62-75` and `src/Writing.res.mjs:176-179`
  (processing ahead of the write fiber), `src/UserContext.res:321`
  (`Logging.noopLogger` in preload).
- Production crash: from-genesis resync of `a57133c21`, 2026-09-15,
  `OracleReported is out of order block=60779445 logIndex=4`.
- Enforced by `indexer-envio/src/oracleFeedState.ts`,
  `indexer-envio/src/oracleExpiryState.ts`,
  `indexer-envio/src/handlers/oracleFeedState.ts`, and
  `indexer-envio/src/handlers/oracleExpiryState.ts`.
- Covered by `indexer-envio/test/oracleFeedStateHandlers.test.ts`: replayed
  `OracleReported`, `OracleReportRemoved`, `TokenReportExpirySet` and
  `ReportExpirySet` logs, the last over two feeds; a same-position conflict
  that still throws; an above-watermark event that still applies; and an expiry
  log at the feed row's bootstrap boundary that still propagates; an identical
  `OracleReported` re-delivered exactly at the watermark. The replayed
  `OracleReported` case also asserts the pool row is untouched and no
  `OracleSnapshot` row exists, which fails when the handler's early return is
  removed. The token assertions match on `site=`, so a count is attributable to
  a helper. Against the pre-fix handlers the replay cases reproduce the
  production message verbatim.
- Reconciliation observation, 2026-09-15, against
  `https://indexer.hyperindex.xyz/2f3dd15/v1/graphql`: pool
  `42220-0x9861f6d2fe392b934c86ec89d2886ceb772b2b41` reports
  `Pool.swapCount = 395` against 395 `SwapEvent` rows with 395 distinct ids —
  no evidence that the same replay window double-counted a read-modify-write
  accumulator.
