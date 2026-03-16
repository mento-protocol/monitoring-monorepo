---
title: EventHandlers.ts Refactoring Plan
date: 2026-03-15
type: design
tags: [mento, indexer, refactor, envio]
status: draft
---

# EventHandlers.ts Refactoring Plan

## Executive Summary

`EventHandlers.ts` is a 2,243-line monolith that handles all blockchain event processing for the Mento v3 indexer. It mixes RPC data fetching, business logic, entity construction, caching, test mocking infrastructure, ABI definitions, and handler registration into a single file. Despite generally correct logic and good inline documentation, the file is hard to navigate, impossible to test in isolation, and will get worse as new chains or pool types are added.

**The core problem:** every concern lives at the same level of abstraction in the same file. Adding a new event type or changing how oracle data is fetched requires understanding and navigating the entire 2,200-line context.

---

## 1. Problems Identified

### 1.1 Structural Issues

| Problem                                         | Lines                                  | Impact                                                                                                                                                                                                |
| ----------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Single-file monolith**                        | 1–2243                                 | Every change touches the same file; merge conflicts guaranteed when multiple people work on it                                                                                                        |
| **Mixed abstraction levels**                    | Throughout                             | ABI definitions sit next to caching logic, next to business rules, next to handler registration                                                                                                       |
| **Inline ABI definitions**                      | 346–445, 2130–2145                     | 100+ lines of JSON ABI literals cluttering the logic; these are static data, not code                                                                                                                 |
| **Module-level mutable state**                  | 110, 117, 142, 202, 209, 215–216, 2125 | 7+ `Map` caches and mutable vars at module scope — invisible dependencies, impossible to reset between tests without exported `_clear*` functions                                                     |
| **Test mock infrastructure in production code** | 117–162                                | `_setMockRebalancingState`, `_setMockReserves`, `_clearMock*` are exported test hooks embedded in the production module. They're a code smell — production code shouldn't know about its test harness |

### 1.2 Duplication

| Duplicated Pattern                                | Occurrences | Lines                                                                                  |
| ------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------- |
| **FPMM vs VirtualPool Swap handler**              | 2           | 1113–1262 vs 1887–1943 — nearly identical except VirtualPool skips trading limits      |
| **FPMM vs VirtualPool Mint handler**              | 2           | 1264–1301 vs 1945–1982 — identical logic                                               |
| **FPMM vs VirtualPool Burn handler**              | 2           | 1303–1340 vs 1984–2021 — identical logic                                               |
| **FPMM vs VirtualPool UpdateReserves**            | 2           | 1342–1430 vs 2023–2061 — FPMM adds oracle fetch, otherwise same                        |
| **FPMM vs VirtualPool Rebalanced**                | 2           | 1432–1534 vs 2063–2111 — FPMM adds oracle fetch, otherwise same                        |
| **OracleReported vs MedianUpdated**               | 2           | 1626–1703 vs 1705–1773 — nearly identical, differ only in snapshot `source` string     |
| **Oracle price extraction from rebalancingState** | 2           | 1362–1378 vs 1458–1472 — same isInverted/ORACLE_ADAPTER_SCALE_FACTOR logic copy-pasted |
| **Trading limit entity construction**             | 2           | 1184–1201 vs 1215–1229 — same TradingLimit creation for token0 vs token1               |

**~600 lines are duplicated or near-duplicated.** That's 27% of the file.

### 1.3 Coupling and Dependency Issues

- **RPC calls are inlined in business logic.** Every handler that needs on-chain data calls `getRpcClient()` directly via `fetchRebalancingState`, `fetchReserves`, etc. No abstraction boundary — can't swap for a different data source, can't batch, can't rate-limit.
- **Caching is ad-hoc.** Each RPC function has its own caching strategy (block-scoped for reserves, key-based for numReporters/reportExpiry, none for invertRateFeed/rebalanceThreshold). No unified cache layer, no eviction policy, no observability.
- **`computePriceDifference` is called from 3 places** with slightly different preconditions — once in `upsertPool` (fallback), once in `OracleReported`, once in `MedianUpdated`. The inline computation in the oracle handlers duplicates the pool update + healthStatus recomputation logic that `upsertPool` already handles.

### 1.4 Testability Issues

- **No dependency injection.** RPC clients, caches, and contract addresses are module-level singletons. Testing requires exported `_setMock*` escape hatches.
- **Handlers are not unit-testable in isolation.** They're anonymous closures registered via Envio's global `Contract.Event.handler()` API — you can't call a handler directly, you must go through the full MockDb/event pipeline.
- **Test file (`Test.ts`) is also a monolith** at 39.7 KB, partly because it has to set up the entire world for each test since there's no way to test individual concerns.

### 1.5 Missing Concerns

- **No error logging with context.** Every `catch` block returns `null` silently. RPC failures are invisible — you only notice when dashboard data goes stale.
- **No metrics/observability.** No counters for RPC calls made, cache hits, handler execution time, or errors. In production, you're flying blind.
- **No input validation.** Event params are trusted and cast directly (e.g., `event.params.config as unknown as [bigint, bigint, number]`). A contract upgrade emitting a different tuple layout would produce silent corruption.

---

## 2. Proposed Module Breakdown

```
src/
├── EventHandlers.ts          # Slim: only handler registration (wiring)
├── handlers/
│   ├── fpmm.ts               # FPMM-specific handler logic
│   ├── virtualPool.ts        # VirtualPool-specific handler logic
│   ├── oracle.ts             # SortedOracles handlers
│   ├── protocolFees.ts       # ERC20FeeToken Transfer handler
│   └── shared.ts             # Shared handler building blocks (swap, mint, burn, etc.)
├── services/
│   ├── rpcClient.ts          # RPC client factory + default URLs
│   ├── oracleService.ts      # fetchRebalancingState, fetchNumReporters, fetchReportExpiry
│   ├── poolService.ts        # fetchReserves, fetchRebalanceThreshold, fetchReferenceRateFeedID, fetchInvertRateFeed, fetchTokenDecimalsScaling
│   ├── tradingLimitService.ts # fetchTradingLimits + limit pressure/status computation
│   └── feeTokenService.ts    # resolveFeeTokenMeta
├── domain/
│   ├── pool.ts               # upsertPool, getOrCreatePool, DEFAULT_ORACLE_FIELDS, SOURCE_PRIORITY
│   ├── snapshot.ts           # upsertSnapshot, hourBucket, snapshotId
│   ├── priceDifference.ts    # computePriceDifference, normalizeTo18, scalingFactorToDecimals
│   └── healthStatus.ts       # computeHealthStatus, computeLimitStatus, computeLimitPressures
├── abis/
│   ├── fpmmMinimal.ts        # FPMM_MINIMAL_ABI
│   ├── fpmmTradingLimits.ts  # FPMM_TRADING_LIMITS_ABI
│   └── erc20.ts              # ERC20_DECIMALS_ABI
├── cache.ts                  # Unified cache with TTL/block-scoped eviction
├── constants.ts              # SORTED_ORACLES_DECIMALS, ORACLE_ADAPTER_SCALE_FACTOR, YIELD_SPLIT_ADDRESS, etc.
├── helpers.ts                # eventId, asAddress, asBigInt
└── contractAddresses.ts      # (existing, unchanged)
```

### Why this structure?

- **`handlers/`** — One file per contract domain. Each file exports named functions that take `(event, context, services)` and return void. The top-level `EventHandlers.ts` wires them into Envio's registration API. This makes handlers independently testable.
- **`services/`** — RPC interaction layer. Each service is a class or set of functions that accept a `client` (viem PublicClient) as a parameter, making them mockable without test hooks in production code.
- **`domain/`** — Pure business logic, no I/O. `computePriceDifference`, `computeHealthStatus`, `upsertPool` (taking a context interface). These are the easiest to test and the most important to get right.
- **`abis/`** — Static data extracted from inline definitions. Trivial but decluttering.
- **`cache.ts`** — Unified caching abstraction. Currently there are 5+ independent Map caches with inconsistent eviction. A simple `BlockScopedCache<T>` class would handle all of them.

---

## 3. Key Abstractions to Introduce

### 3.1 RPC Service Interface

```typescript
interface PoolRpcService {
  getRebalancingState(
    poolAddress: string,
    blockNumber?: bigint,
  ): Promise<RebalancingState | null>;
  getReserves(
    poolAddress: string,
    blockNumber?: bigint,
  ): Promise<{ reserve0: bigint; reserve1: bigint } | null>;
  getRebalanceThreshold(poolAddress: string): Promise<number>;
  getReferenceRateFeedID(poolAddress: string): Promise<string | null>;
  getInvertRateFeed(poolAddress: string): Promise<boolean>;
  getTokenDecimalsScaling(
    poolAddress: string,
    fn: "decimals0" | "decimals1",
  ): Promise<bigint | null>;
  getTradingLimits(
    poolAddress: string,
    token: string,
  ): Promise<TradingLimitData | null>;
}
```

**Why:** Every `fetch*` function today takes `chainId` + raw address and internally resolves the RPC client. An interface per chain lets you:

- Mock in tests without `_setMock*` hacks
- Add instrumentation/metrics at one point
- Rate-limit or batch RPC calls centrally

### 3.2 Block-Scoped Cache

```typescript
class BlockCache<T> {
  private cache = new Map<string, T>();
  private lastBlock: bigint | undefined;

  get(key: string, blockNumber: bigint): T | undefined { ... }
  set(key: string, blockNumber: bigint, value: T): void { ... }
}
```

Replaces the ad-hoc `reservesCache`, `numReportersCache`, `reportExpiryCache` with a single pattern.

### 3.3 Shared Handler Builders

The FPMM and VirtualPool handlers for Swap/Mint/Burn/UpdateReserves/Rebalanced share 80%+ of their logic. Extract shared building blocks:

```typescript
// handlers/shared.ts
export async function handleSwap(params: {
  event: SwapEventParams;
  context: HandlerContext;
  rpcService: PoolRpcService;
  poolType: "fpmm" | "virtual";
}): Promise<void> { ... }

export async function handleLiquidity(params: {
  event: LiquidityEventParams;
  context: HandlerContext;
  kind: "MINT" | "BURN";
}): Promise<void> { ... }
```

FPMM handlers call the shared function and then add FPMM-specific logic (trading limits, oracle fetch). VirtualPool handlers call the shared function directly.

### 3.4 Oracle Update Builder

`OracleReported` and `MedianUpdated` are identical except for the `source` string. Extract:

```typescript
export async function handleOracleUpdate(params: {
  event: OracleEventParams;
  context: HandlerContext;
  source: "oracle_reported" | "oracle_median_updated";
}): Promise<void> { ... }
```

---

## 4. What to Keep As-Is

- **`upsertPool` / `upsertSnapshot`** — Well-designed, handles cumulative counters correctly. Move to `domain/pool.ts` and `domain/snapshot.ts` but keep the logic.
- **`computePriceDifference`** — Correct, well-documented math. Move to `domain/priceDifference.ts`.
- **`computeHealthStatus` / `computeLimitStatus`** — Simple and correct. Move to `domain/healthStatus.ts`.
- **`contractAddresses.ts`** — Already properly factored out.
- **The overall data model** (schema.graphql, entity types) — Sound design, no changes needed.
- **The `SOURCE_PRIORITY` / `pickPreferredSource` pattern** — Clever solution to the "which handler created this pool" problem.

---

## 5. What to Delete

- **`_setMockRebalancingState`, `_setMockReserves`, `_clearMock*` exports** — Replace with dependency injection. Tests pass a mock `PoolRpcService` instead of mutating module-level Maps.
- **`NULL_RESERVES` sentinel** — Artifact of the mock system. Goes away with DI.
- **`_testRebalancingStates`, `_testReserves` Maps** — Same.
- **Duplicated VirtualPool handlers** — Replace with shared handler + thin wrappers.
- **Duplicated `OracleReported` / `MedianUpdated` logic** — Merge into `handleOracleUpdate`.

---

## 6. Migration Path

### Phase 0: Test Coverage Baseline (do this FIRST)

Before touching any logic, ensure regression safety:

1. **Run existing tests and record pass/fail baseline.** Confirm all tests pass today.
2. **Add snapshot tests for key entity outputs.** For each handler type, create a test that:
   - Feeds a known event through MockDb
   - Asserts the exact entity state (all fields) written to context
   - This is your regression detector — any refactoring that changes field values will be caught.
3. **Add integration test for multi-event sequences.** Test that a sequence of `FPMMDeployed → Swap → OracleReported → Rebalanced → UpdateReserves` produces the correct final Pool state with correct cumulative counters.
4. **Add edge case tests** for:
   - Pool with `invertRateFeed = true` (oracle price inversion)
   - 6-decimal token pools (USDC/USDT normalization)
   - Multiple oracle reports in the same block (cache behavior)
   - RPC failure mid-handler (null returns, stale data preservation)

### Phase 1: Extract Static Data (low risk, high clarity)

1. Move ABIs to `src/abis/` — three small files.
2. Move constants to `src/constants.ts`.
3. Move helpers (`eventId`, `asAddress`, `asBigInt`, `hourBucket`, `snapshotId`) to `src/helpers.ts`.
4. Update imports in EventHandlers.ts.
5. **Verify: all tests still pass. The indexer is functionally identical.**

### Phase 2: Extract Domain Logic (medium risk)

1. Move `computePriceDifference`, `normalizeTo18`, `scalingFactorToDecimals` to `src/domain/priceDifference.ts`.
2. Move `computeHealthStatus`, `computeLimitStatus`, `computeLimitPressures` to `src/domain/healthStatus.ts`.
3. Move `upsertPool`, `getOrCreatePool`, `DEFAULT_ORACLE_FIELDS`, `SOURCE_PRIORITY`, `pickPreferredSource`, and their types to `src/domain/pool.ts`.
4. Move `upsertSnapshot` to `src/domain/snapshot.ts`.
5. **Verify: all tests still pass.**

### Phase 3: Extract RPC Services (medium risk)

1. Create `src/services/rpcClient.ts` — move `getRpcClient`, `DEFAULT_RPC_BY_CHAIN`, the `rpcClients` Map.
2. Create `src/services/oracleService.ts` — move `fetchRebalancingState`, `fetchNumReporters`, `fetchReportExpiry`, `fetchInvertRateFeed`, `fetchReferenceRateFeedID`. Each function now takes a `client` parameter instead of internally calling `getRpcClient`.
3. Create `src/services/poolService.ts` — move `fetchReserves`, `fetchRebalanceThreshold`, `fetchTokenDecimalsScaling`.
4. Create `src/services/tradingLimitService.ts` — move `fetchTradingLimits` + computation helpers.
5. Create `src/services/feeTokenService.ts` — move `resolveFeeTokenMeta`.
6. Create `src/cache.ts` — replace ad-hoc Maps with `BlockCache<T>`.
7. **Remove `_setMock*` / `_clearMock*` exports.** Update tests to use mock service implementations.
8. **Verify: all tests still pass.**

### Phase 4: Deduplicate Handlers (highest risk — most logic change)

1. Create `src/handlers/shared.ts` with `handleSwap`, `handleLiquidity`, `handleUpdateReserves`, `handleRebalanced`.
2. Create `src/handlers/fpmm.ts` — FPMM handlers that call shared functions + add FPMM-specific logic (oracle, trading limits).
3. Create `src/handlers/virtualPool.ts` — VirtualPool handlers that call shared functions directly.
4. Create `src/handlers/oracle.ts` — merge `OracleReported` and `MedianUpdated` into `handleOracleUpdate`.
5. Create `src/handlers/protocolFees.ts` — move `ERC20FeeToken.Transfer` handler.
6. Slim `EventHandlers.ts` to ~80 lines: just imports + `Contract.Event.handler()` wiring.
7. **Verify: all tests still pass. Run a full re-sync on a testnet to validate end-to-end.**

### Phase 5: Observability (bonus, post-refactor)

1. Add structured logging to RPC service calls (log on error, not just swallow).
2. Add counters: RPC calls, cache hits/misses, handler execution count.
3. Add validation on event param shapes (runtime type guards).

---

## 7. Regression Prevention

### What to Assert

| Invariant                                                                              | How to Test                                                                                                    |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Pool cumulative counters (swapCount, notionalVolume, rebalanceCount) only increase     | Property test: feed random sequence of swap/rebalance events, assert monotonic increase                        |
| `priceDifference` matches contract computation for known inputs                        | Golden-value tests with real mainnet data (capture a block's events + RPC state, replay offline)               |
| `healthStatus` transitions are correct (OK → WARN → CRITICAL based on deviation ratio) | Unit tests on `computeHealthStatus` with boundary values (0.79, 0.80, 0.99, 1.00)                              |
| Oracle price is always stored in feed direction regardless of `invertRateFeed`         | Test with `invertRateFeed=true` pool: verify `oraclePrice` matches the denominator×scale_factor, not numerator |
| Snapshot hourly bucketing is deterministic                                             | Unit test: same timestamp always produces same bucket; bucket boundaries are correct                           |
| Trading limit pressure [0,1] range, status thresholds                                  | Unit tests on `computeLimitPressures` + `computeLimitStatus`                                                   |
| ERC20FeeToken only tracks transfers from known FPMM pools                              | Test: transfer from non-pool address is ignored; transfer from FPMM pool is recorded                           |
| `source` priority is respected (factory > rebalanced > swap > mint/burn)               | Test: pool created by swap, then factory event arrives — source should become `fpmm_factory`                   |

### CI Integration

- Add a `test:refactor` script that runs the full test suite and fails on any regression.
- Consider adding a "sync test" that replays a small range of real mainnet blocks (e.g., 100 blocks) and asserts entity state matches a golden snapshot. This catches bugs that unit tests miss (event ordering, cross-handler interactions).

---

## 8. Risk Assessment

| Phase                   | Risk     | Mitigation                                                                                                                               |
| ----------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 1 (static data)   | Very low | Pure file moves, no logic change                                                                                                         |
| Phase 2 (domain logic)  | Low      | Functions are pure or near-pure; easy to test                                                                                            |
| Phase 3 (RPC services)  | Medium   | Changing how mocks work could break tests; need to update all test files simultaneously                                                  |
| Phase 4 (handler dedup) | High     | Logic consolidation could introduce subtle bugs in field mapping or delta computation. Must be done with snapshot tests already in place |
| Phase 5 (observability) | Low      | Additive, no behavior change                                                                                                             |

---

## 9. Estimated Effort

- Phase 0 (test baseline): ~1 day
- Phase 1 (extract static): ~2 hours
- Phase 2 (extract domain): ~3 hours
- Phase 3 (extract services): ~1 day (includes updating all test mocks)
- Phase 4 (dedup handlers): ~1–2 days (most complex, highest risk)
- Phase 5 (observability): ~half day

**Total: ~4 days of focused work, assuming single developer.**

---

## 10. Open Questions

1. **Envio handler registration constraints.** Does Envio require all handlers to be registered in a single file, or can they be registered from separate modules? If the former, the slim `EventHandlers.ts` wiring file is mandatory. Need to verify with Envio docs.
2. **Worker process model.** The comments mention Envio workers don't share in-memory state. Does this mean the caches (`numReportersCache`, `reportExpiryCache`, `reservesCache`) are already per-worker? If so, the `BlockCache` abstraction is fine, but cache hit rates will be lower than expected.
3. **Hot-path performance.** During historical backfill, handlers process thousands of events per second. Will the additional function call overhead from the module split matter? Almost certainly not — RPC latency dominates — but worth confirming with a benchmark on a real backfill.
