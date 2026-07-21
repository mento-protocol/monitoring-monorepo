---
title: Indexer Handler Invariants
status: active
owner: eng
canonical: true
last_verified: 2026-07-21
doc_type: checklist
scope: indexer-envio
review_interval_days: 90
garden_lane: pr-checklists-process
---

# Indexer Handler Invariants

Use this checklist when changing Envio handlers, RPC effects, self-heal stages,
entity identities, or tests that drive those paths. For schema or dashboard
propagation, also apply [`stateful-data-ui.md`](stateful-data-ui.md).

## Entity identity and rollups

- Composite IDs must survive same-block writes. Parent ID plus timestamp is
  insufficient; include `chainId + blockNumber + logIndex` or
  `txHash + logIndex`.
- Lifetime aggregates such as cumulative critical seconds, breach count, and
  volume belong on the parent entity and are incremented by handlers. Hosted
  Hasura caps list queries at 1,000 rows, so client aggregation loses history.
- FX-pool durations use trading-seconds. Do not mix wall-clock and
  trading-second durations on one entity; the shared calendar is
  `shared-config/fx-calendar.json`.

## RPC cache and freshness

- Block-keyed RPC caches must be bounded with an LRU or block-height eviction;
  never retain one entry per block in an unbounded `Map`.
- Envio V3 runs each handler in a concurrent preload pass and then an ordered
  processing pass. Any direct `context.effect(...)` whose key can be derived
  before writes must be requested before or inside the positive
  `context.isPreload` return, then reused with the identical effect + input key
  during processing. An event-only input is not a processing-only dependency.
- The blocking code-quality invariant rejects a direct effect that exists only
  after a positive preload return. A genuinely processing-dependent or
  permanently bounded call must carry an adjacent
  `// preload-effect-exempt: <bounded-cardinality reason>` comment. Do not use
  the exemption for an effect that scales with swaps, reports, transfers, or
  another replay-traffic event stream.
- When adding an effect to a replayed handler, audit the event's historical
  cardinality and add preload-aware coverage. Processing-only correctness tests
  do not prove that hosted replay will batch the external calls.
- Local derivations from `lastMedianPrice` must use
  `hasFreshLiveMedian(pool, eventTimestamp)`, not merely `medianLive` or a
  non-zero price. The gate requires non-zero median, `medianLive`, `oracleOk`,
  known `oracleExpiry`, known `lastOracleReportAt`, and an unexpired report.
- Add stale-anchor regressions for every sibling path that recomputes
  median-derived deviation without a contract-provided value, including
  `OracleReported` fan-out and `upsertPool` calls from swap, mint, burn,
  update-reserves, and fee-only events. A fresh non-median reporter must not
  refresh a stale median anchor.
- Multi-getter effects use `Promise.allSettled` and distinct sentinels:
  `-1` means not attempted/retry; `-2` means the getter is absent/stop retrying.
  Every RPC helper catches synchronous `getRpcClient` failures.

## Self-heal coordination

When a new heal step changes Pool fields or entity-kind classification:

- Widen every gate-style predicate that consumes those fields across indexer,
  dashboard, and metrics bridge. Audit health/limit/rebalancer predicates,
  detail panels, list-row gates, hooks, SortedOracles handlers, and bridge
  filters instead of fixing only the initiating helper.
- Add new fields to every consuming GraphQL query: detail, list, and OG. Keep
  `metrics-bridge`'s `!pool.wrappedExchangeId` exclusion and its
  `wrappedExchangeId` query field so healed virtual pools cannot create phantom
  FPMM gauges. New bridge annotations should use isolated companion queries so
  older Hasura schemas degrade only that annotation.
- Decide cross-pass semantics before coding. If a flag depends on both legs of
  a pair and events may arrive separately, either revalidate cheap cached
  effects on every call or coordinate through a dedicated cross-pass helper.
  Schema defaults or `value > 0` truthiness do not prove the pair is complete.
- A retry gate must include required downstream side effects, not only entity
  fields. Partial state after a transient effect failure must not suppress the
  next repair attempt; an extra entity read is preferable to permanently
  incomplete state.
- Re-audit every RPC effect the merged heal pipeline can reach before extending
  tests. Seed each mock or use the harness; CI cannot depend on a developer
  machine's access to a live RPC.

## Vitest and RPC mocks

- `vitest.config.ts` owns the 60-second timeout. Do not add Mocha
  `this.timeout(...)` calls or Mocha reference pragmas.
- Multi-event integration tests stay hermetic. Seed RPC mocks before processing
  or use `test/helpers/indexerTestHarness.ts`, which waits for the local HTTP
  test bridge.
- Direct RPC tests that clear in-memory mocks and intentionally fall through to
  HTTP must await `expectHttpRpcMockFallback()` from
  `test/helpers/httpRpc.ts` before the assertion.

## Environment parsing

- Package env modules parse through Zod at module load. Fields with a safe
  numeric/enum fallback use `.catch(default)`, not `.default()`, so invalid and
  absent inputs both preserve the prior fallback behavior.
- Tests that mutate `process.env` after module load and dynamic computed-key
  reads stay direct; the static parse cannot observe later stubs.

## Cross-check before review

- Exercise dashboard-dependent queries against local Hasura with a
  representative high-history pool to expose row-cap assumptions.
- Prove new entity IDs under two writes in the same block.
- Run the package tests selected by `pnpm agent:quality-gate --run`.
