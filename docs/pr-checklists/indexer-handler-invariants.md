---
title: Indexer Handler Invariants
status: active
owner: eng
canonical: true
last_verified: 2026-07-22
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
- Envio stores rate-limit state on each created effect object. In the multichain
  indexer, a provider-specific floor or burst policy must use a chain/provider-
  scoped effect object; never apply one chain's RPC limit to an effect shared by
  every chain. Keep preload and processing on the same selected object so
  identical-input deduplication still works.
- Envio V3 runs each handler in a concurrent preload pass and then an ordered
  processing pass. Any direct `context.effect(...)` whose key can be derived
  before writes must be requested before or inside the positive
  `context.isPreload` return, then reused with the identical effect + input key
  during processing. An event-only input is not a processing-only dependency.
- Start event-derived effects before any entity-dependent early return. A
  concurrent preload pass can see an empty lookup while ordered processing for
  the same event sees a row created by an earlier event in the batch.
- For effects whose eligibility depends on entity state, derive the condition
  independently in preload and processing; never carry eligibility across the
  phase boundary in a module-scoped `Set`, `Map`, or other mutable marker.
  Hosted Envio may run the passes in different workers or after a restart. Use
  the identical event-only effect key in both passes. If ordered processing
  newly exposes a row, take a bounded safe serialized exact-block path when the
  handler requires that event's state; otherwise fail closed with a documented
  ordered-state exemption. Do not substitute a later event's value for exact
  event/block state.
- Do not hide phase-bridging state in an imported handler helper. The blocking
  code-quality invariant starts at registered `indexer.onEvent`, `onBlock`, and
  `contractRegister` callbacks and follows TypeScript-resolved imported calls,
  transitive calls,
  callbacks, aliases, destructuring, and arguments. Every top-level handler
  binding is a potential module-state root regardless of initializer. The
  invariant rejects direct assignment, update, deletion, object/record write,
  and native collection/array mutator forms reached through those
  symbol-propagated paths. Returned module-state aliases and custom receiver
  methods that mutate through `this` still require manual review until
  [#1462](https://github.com/mento-protocol/monitoring-monorepo/issues/1462) is
  resolved. Deterministic read-only lookup state and module-initialization
  builders remain valid. A necessary processing-only write requires an adjacent
  `// phase-state-exempt: <reason>; ... #<issue>.` at each mutation call site;
  never exempt an entire binding. A bounded or rebuildable optimization cache
  whose loss can only repeat authoritative/idempotent work may instead use
  `// phase-state-cache: <why loss cannot change entity output>.` at each write.
- The blocking code-quality invariant rejects a direct effect that exists only
  after a positive preload return (including exact `maybePreloadPool(...)` and
  `maybePreloadBreaker(...)` wrappers)
  or after an earlier return-bearing branch. A call that must remain
  processing-only for ordered-state correctness, or is permanently bounded,
  must carry an adjacent call-site
  `// preload-effect-exempt: <ordered-state or bounded-cardinality reason>`
  comment. A comment on the preload guard does not suppress direct-effect
  checks.
- When code that preload cannot eagerly reach—after an entity-dependent return
  or a positive preload return—calls a helper that directly or transitively
  reaches `context.effect`, the invariant derives that boundary from TypeScript
  symbols. Declare the exact used set with one or more adjacent
  `// preload-effect-helpers: <helper names>` lines. Pair the declaration with
  a non-empty `// preload-handler-note: <reason>` line. Missing and unused
  declarations both fail so a broad handler marker cannot hide a future
  effect. A phase-stable event-derived filter is valid only when the effect is
  still awaited during preload; state that fact in the note. Do not exempt an
  effect that scales with swaps, reports, transfers,
  or another replay-traffic event stream merely for convenience. When preload
  would violate sequential state semantics, name the exact ordering invariant
  and track a preload-safe redesign.
- When adding an effect to a replayed handler, audit the event's historical
  cardinality and add preload-aware coverage. Processing-only correctness tests
  do not prove that hosted replay will batch the external calls.
- SortedOracles freshness is event-sourced. For a tracked feed without an
  `OracleFeedState`, only the first `OracleReported` or
  `OracleReportRemoved` may perform the bounded processing-only bootstrap: one
  exact-boundary `getTimestamps` call plus an effective expiry. When a currently
  referencing pool row was last persisted before the event block, use the
  parent block, apply the current log, and reuse a unique positive pool expiry
  if available. Otherwise initialize exact block-close timestamps and expiry,
  then absorb that block's report/removal logs. Keep the
  timestamp-list effect provider-family scoped and uncached. Missing or
  malformed arrays, reporters, timestamps, or expiry fail the event before
  entity writes; never fall back to latest-block state.
- After bootstrap, apply `OracleReported` reporter/timestamp upserts and
  `OracleReportRemoved` deletions in block/log order, then recompute the upper
  median timestamp at sorted index `floor(count / 2)`. `MedianUpdated` consumes
  that state and `OracleRemoved` does not mutate it. Expiry events update only
  the persisted expiry. Cover same-block ordering, flat reports, removals,
  malformed bootstraps, and absent state before changing this path.
- Do not restore traffic-scaled `medianTimestamp` or `reportExpiry` effects to
  `OracleReported`, `OracleReportRemoved`, or `MedianUpdated`. A change to this
  replay contract requires a full replay, a replay-integrity marker bump with
  verifier regression coverage, and matching `OracleReportRemoved`
  registration in both mainnet and testnet configs.
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
