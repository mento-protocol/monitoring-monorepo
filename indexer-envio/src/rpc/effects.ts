// ---------------------------------------------------------------------------
// Envio Effect API wrappers for the 16 RPC fetchers used by handlers.
//
// Why effects: with `preload_handlers: true` (config.multichain.mainnet.yaml),
// Envio runs each handler twice per event (preload + processing). Without the
// Effect API, every `client.readContract` call inside the fetchers fires twice
// and is never deduped or batched across concurrent handlers. Wrapping these
// fetchers in `createEffect` gives us:
//
//   1. Per-batch memoization (preload + processing share the same result).
//   2. Concurrent-call deduplication when many handlers in one batch hit the
//      same (chainId, address, blockNumber) tuple.
//   3. Parallel execution of independent effect calls during the preload phase.
//
// Future medium-tier upgrade: `cache: true` flips on persistent Postgres-
// backed caching for an effect, dramatically speeding up re-indexes after
// every push. We keep `cache: false` everywhere for now — block-scoped
// effects (groups C, D, E) MUST stay false even on medium because reorgs
// would silently corrupt cached values; immutable / governance-rare effects
// (groups A, B, F) are safe to flip later.
// ---------------------------------------------------------------------------

import { createEffect, S } from "envio";
import {
  fetchErc20Decimals,
  fetchFees,
  fetchInvertRateFeed,
  fetchNumReporters,
  fetchRebalanceIncentiveAtBlock,
  fetchRebalanceThreshold,
  fetchRebalancingState,
  fetchReferenceRateFeedID,
  fetchReportExpiry,
  fetchReserves,
  fetchTokenDecimalsScaling,
  fetchTradingLimits,
} from "./pool-state";
import {
  fetchBreakerDefaults,
  fetchBreakerFeedState,
  fetchBreakerKind,
  fetchBreakerList,
  type BreakerKindRpc,
} from "./breakers";

// ---------------------------------------------------------------------------
// Output schemas — defined once so they can be shared / referenced. Sury
// re-exports from envio omit `S.literal`, so string-union types like
// `BreakerKindRpc` ride as `S.string` and get cast at the call site.
//
// `S.nullable(T)` accepts null on input but produces `T | undefined` on
// output (Sury's design). Effect handlers that wrap fetchers returning
// `T | null` therefore coalesce `null ?? undefined` before returning. Call
// sites awaiting `context.effect(...)` see `T | undefined`; legacy callers
// of `fetch*` continue to see `T | null` until they migrate in commits 2-3.
// ---------------------------------------------------------------------------

const reservesShape = S.schema({
  reserve0: S.bigint,
  reserve1: S.bigint,
});

const rebalancingStateShape = S.schema({
  oraclePriceNumerator: S.bigint,
  oraclePriceDenominator: S.bigint,
  rebalanceThreshold: S.int32,
  priceDifference: S.bigint,
});

const feesShape = S.schema({
  lpFee: S.optional(S.int32),
  protocolFee: S.optional(S.int32),
  rebalanceReward: S.optional(S.int32),
});

const tradingLimitsShape = S.schema({
  config: S.schema({
    limit0: S.bigint,
    limit1: S.bigint,
    decimals: S.int32,
  }),
  state: S.schema({
    lastUpdated0: S.int32,
    lastUpdated1: S.int32,
    netflow0: S.bigint,
    netflow1: S.bigint,
  }),
});

const breakerDefaultsShape = S.schema({
  activatesTradingMode: S.int32,
  defaultCooldownTime: S.bigint,
  defaultRateChangeThreshold: S.bigint,
});

const breakerFeedStateShape = S.schema({
  enabled: S.boolean,
  tradingMode: S.int32,
  lastStatusUpdatedAt: S.bigint,
  cooldownTime: S.bigint,
  rateChangeThreshold: S.bigint,
  smoothingFactor: S.nullable(S.bigint),
  medianRatesEMA: S.nullable(S.bigint),
  referenceValue: S.nullable(S.bigint),
});

// ---------------------------------------------------------------------------
// Group A — immutable / governance-rare, address-keyed.
// `cache: false` initially; safe to flip to `true` on medium tier (the
// fetched values are immutable per (chainId, address) for the indexer's
// timescales — a governance change would re-deploy and re-index anyway).
// ---------------------------------------------------------------------------

export const erc20DecimalsEffect = createEffect(
  {
    name: "erc20Decimals",
    input: { chainId: S.int32, tokenAddress: S.string },
    output: S.nullable(S.int32),
    rateLimit: { calls: 200, per: "second" },
    cache: false,
  },
  async ({ input }) =>
    (await fetchErc20Decimals(input.chainId, input.tokenAddress)) ?? undefined,
);

export const referenceRateFeedIDEffect = createEffect(
  {
    name: "referenceRateFeedID",
    input: { chainId: S.int32, poolAddress: S.string },
    output: S.nullable(S.string),
    rateLimit: { calls: 200, per: "second" },
    cache: false,
  },
  async ({ input }) =>
    (await fetchReferenceRateFeedID(input.chainId, input.poolAddress)) ??
    undefined,
);

// Output is nullable: with `preload_handlers: true` an effect that fabricated
// `false` on a transient RPC blip during preload would memoize and persist
// the wrong orientation — call sites must skip the assignment on undefined
// and let the schema default ride until the next event re-fetches.
export const invertRateFeedEffect = createEffect(
  {
    name: "invertRateFeed",
    input: { chainId: S.int32, poolAddress: S.string },
    output: S.nullable(S.boolean),
    rateLimit: { calls: 200, per: "second" },
    cache: false,
  },
  async ({ input }) =>
    (await fetchInvertRateFeed(input.chainId, input.poolAddress)) ?? undefined,
);

export const rebalanceThresholdEffect = createEffect(
  {
    name: "rebalanceThreshold",
    input: { chainId: S.int32, poolAddress: S.string },
    output: S.int32,
    rateLimit: { calls: 200, per: "second" },
    cache: false,
  },
  async ({ input }) =>
    fetchRebalanceThreshold(input.chainId, input.poolAddress),
);

export const tokenDecimalsScalingEffect = createEffect(
  {
    name: "tokenDecimalsScaling",
    input: {
      chainId: S.int32,
      poolAddress: S.string,
      // FPMM exposes both `decimals0()` and `decimals1()`; effect input
      // chooses which getter to call. Using `S.string` (no enum) is fine —
      // the inner fetcher accepts the union and casts safely at the wire.
      fn: S.string,
      // Optional fallback to ERC20 `decimals()` if the FPMM getter is
      // missing (older deployments). Undefined → no fallback.
      fallbackTokenAddress: S.optional(S.string),
    },
    output: S.nullable(S.bigint),
    rateLimit: { calls: 200, per: "second" },
    cache: false,
  },
  async ({ input }) =>
    (await fetchTokenDecimalsScaling(
      input.chainId,
      input.poolAddress,
      input.fn as "decimals0" | "decimals1",
      input.fallbackTokenAddress,
    )) ?? undefined,
);

// ---------------------------------------------------------------------------
// Group B — fee config (per-pool, governance-rare).
// `cache: false` initially; safe to flip on medium. Per-getter mock
// granularity (`FetchFeesMock` rejection semantics) lives inside `fetchFees`
// itself, which the effect handler delegates to.
//
// Rate limit matches Group A's 200/s ceiling so it isn't artificially tighter
// than peers; `fetchFees` internally fans out 3 readContract calls per
// invocation (lpFee/protocolFee/rebalanceIncentive), but viem's batched
// transport collapses them at the wire so the effective HTTP rate is one
// per invocation.
// ---------------------------------------------------------------------------

export const feesEffect = createEffect(
  {
    name: "fees",
    input: { chainId: S.int32, poolAddress: S.string },
    output: S.nullable(feesShape),
    rateLimit: { calls: 200, per: "second" },
    cache: false,
  },
  // Schema's `S.optional(S.int32)` outputs `number | undefined` with the key
  // always present; the fetcher returns `Partial<>` (key may be missing).
  // Spread to materialize all keys with explicit undefined where missing.
  async ({ input }) => {
    const result = await fetchFees(input.chainId, input.poolAddress);
    if (result === null) return undefined;
    return {
      lpFee: result.lpFee,
      protocolFee: result.protocolFee,
      rebalanceReward: result.rebalanceReward,
    };
  },
);

/** Convert the `feesEffect` output (explicit `undefined` keys) into a
 * Partial-style object (omits undefined keys). Use this at call sites that
 * spread the result onto a Pool entity whose `lpFee` / `protocolFee` /
 * `rebalanceReward` fields are typed `number` (not `number | undefined`). */
export function compactFees(
  f:
    | {
        lpFee: number | undefined;
        protocolFee: number | undefined;
        rebalanceReward: number | undefined;
      }
    | undefined,
): Partial<{ lpFee: number; protocolFee: number; rebalanceReward: number }> {
  if (!f) return {};
  const out: Partial<{
    lpFee: number;
    protocolFee: number;
    rebalanceReward: number;
  }> = {};
  if (f.lpFee !== undefined) out.lpFee = f.lpFee;
  if (f.protocolFee !== undefined) out.protocolFee = f.protocolFee;
  if (f.rebalanceReward !== undefined) out.rebalanceReward = f.rebalanceReward;
  return out;
}

// ---------------------------------------------------------------------------
// Group C — block-scoped, address-keyed.
// MUST stay `cache: false` permanently even on medium. Reason: Celo archive-
// block reorgs (rare but real) would silently corrupt persisted cached
// values; reindex of the same block range expects fresh reads.
// ---------------------------------------------------------------------------

export const reservesEffect = createEffect(
  {
    name: "reserves",
    input: {
      chainId: S.int32,
      poolAddress: S.string,
      blockNumber: S.bigint,
    },
    output: S.nullable(reservesShape),
    rateLimit: { calls: 200, per: "second" },
    cache: false,
  },
  async ({ input }) =>
    (await fetchReserves(
      input.chainId,
      input.poolAddress,
      input.blockNumber,
    )) ?? undefined,
);

export const rebalancingStateEffect = createEffect(
  {
    name: "rebalancingState",
    input: {
      chainId: S.int32,
      poolAddress: S.string,
      blockNumber: S.bigint,
    },
    output: S.nullable(rebalancingStateShape),
    rateLimit: { calls: 200, per: "second" },
    cache: false,
  },
  async ({ input }) =>
    (await fetchRebalancingState(
      input.chainId,
      input.poolAddress,
      input.blockNumber,
    )) ?? undefined,
);

export const rebalanceIncentiveAtBlockEffect = createEffect(
  {
    name: "rebalanceIncentiveAtBlock",
    input: {
      chainId: S.int32,
      poolAddress: S.string,
      blockNumber: S.bigint,
    },
    output: S.nullable(S.int32),
    rateLimit: { calls: 100, per: "second" },
    cache: false,
  },
  async ({ input }) =>
    (await fetchRebalanceIncentiveAtBlock(
      input.chainId,
      input.poolAddress,
      input.blockNumber,
    )) ?? undefined,
);

// ---------------------------------------------------------------------------
// Group D — block-scoped, feed-keyed (sortedOracles).
// MUST stay `cache: false` permanently. Same reorg rationale as Group C.
// ---------------------------------------------------------------------------

export const numReportersEffect = createEffect(
  {
    name: "numReporters",
    input: {
      chainId: S.int32,
      rateFeedID: S.string,
      blockNumber: S.bigint,
    },
    output: S.nullable(S.int32),
    rateLimit: { calls: 200, per: "second" },
    cache: false,
  },
  async ({ input }) =>
    (await fetchNumReporters(
      input.chainId,
      input.rateFeedID,
      input.blockNumber,
    )) ?? undefined,
);

export const reportExpiryEffect = createEffect(
  {
    name: "reportExpiry",
    input: {
      chainId: S.int32,
      rateFeedID: S.string,
      blockNumber: S.bigint,
    },
    output: S.nullable(S.bigint),
    rateLimit: { calls: 200, per: "second" },
    cache: false,
  },
  async ({ input }) =>
    (await fetchReportExpiry(
      input.chainId,
      input.rateFeedID,
      input.blockNumber,
    )) ?? undefined,
);

// ---------------------------------------------------------------------------
// Group E — trading limits.
// MUST stay `cache: false` permanently (block-scoped state).
// Higher rate limit than other block-scoped effects: fires twice per FPMM
// Swap (once per token), so peak Celo catch-up of ~120 events/sec → up to
// ~240 fetcher invocations/sec. Effect-level batching collapses concurrent
// calls into multicalls, but the cap still needs headroom.
// ---------------------------------------------------------------------------

export const tradingLimitsEffect = createEffect(
  {
    name: "tradingLimits",
    input: {
      chainId: S.int32,
      poolAddress: S.string,
      token: S.string,
      // Most call sites pass blockNumber; `fetchTradingLimits` accepts it
      // as optional (the Swap handler always supplies it; UpdateReserves
      // limits-sync also supplies). Mirror the existing signature.
      blockNumber: S.optional(S.bigint),
    },
    output: S.nullable(tradingLimitsShape),
    rateLimit: { calls: 200, per: "second" },
    cache: false,
  },
  async ({ input }) =>
    (await fetchTradingLimits(
      input.chainId,
      input.poolAddress,
      input.token,
      input.blockNumber,
    )) ?? undefined,
);

// ---------------------------------------------------------------------------
// Group F — circuit breakers (per-chain governance state).
// `cache: false` initially. On a medium-tier upgrade:
//   - `breakerListEffect` and `breakerKindEffect` are address-keyed (no
//     blockNumber input), so `cache: true` produces durable per-address
//     dedup that survives across re-indexes — biggest win.
//   - `breakerDefaultsEffect` is block-keyed (blockNumber is part of the
//     input). `cache: true` is safe (governance-rare), but each block gets
//     its own cache row — re-indexing N blocks creates N entries per
//     breaker, so the persistent-cache benefit collapses to in-batch dedup.
//   - `breakerFeedStateEffect` is block-scoped state and stays `cache: false`.
// ---------------------------------------------------------------------------

export const breakerListEffect = createEffect(
  {
    name: "breakerList",
    input: { chainId: S.int32, blockNumber: S.bigint },
    output: S.nullable(S.array(S.string)),
    rateLimit: { calls: 50, per: "second" },
    cache: false,
  },
  async ({ input }) =>
    (await fetchBreakerList(input.chainId, input.blockNumber)) ?? undefined,
);

export const breakerKindEffect = createEffect(
  {
    name: "breakerKind",
    input: { chainId: S.int32, breakerAddress: S.string },
    // BreakerKindRpc is a string union; ride as S.string and cast at call site.
    output: S.nullable(S.string),
    rateLimit: { calls: 50, per: "second" },
    cache: false,
  },
  async ({ input }) =>
    (await fetchBreakerKind(input.chainId, input.breakerAddress)) ?? undefined,
);

export const breakerDefaultsEffect = createEffect(
  {
    name: "breakerDefaults",
    input: {
      chainId: S.int32,
      breakerAddress: S.string,
      kind: S.string,
      blockNumber: S.bigint,
    },
    output: S.nullable(breakerDefaultsShape),
    rateLimit: { calls: 50, per: "second" },
    cache: false,
  },
  async ({ input }) =>
    (await fetchBreakerDefaults(
      input.chainId,
      input.breakerAddress,
      input.kind as BreakerKindRpc,
      input.blockNumber,
    )) ?? undefined,
);

export const breakerFeedStateEffect = createEffect(
  {
    name: "breakerFeedState",
    input: {
      chainId: S.int32,
      breakerAddress: S.string,
      kind: S.string,
      rateFeedID: S.string,
      blockNumber: S.bigint,
    },
    output: S.nullable(breakerFeedStateShape),
    rateLimit: { calls: 50, per: "second" },
    cache: false,
  },
  async ({ input }) => {
    const result = await fetchBreakerFeedState(
      input.chainId,
      input.breakerAddress,
      input.kind as BreakerKindRpc,
      input.rateFeedID,
      input.blockNumber,
    );
    if (result === null) return undefined;
    // The schema's nullable inner fields output `T | undefined`, but the
    // fetcher returns `T | null` for kind-specific fields. Map at the boundary.
    return {
      ...result,
      smoothingFactor: result.smoothingFactor ?? undefined,
      medianRatesEMA: result.medianRatesEMA ?? undefined,
      referenceValue: result.referenceValue ?? undefined,
    };
  },
);
