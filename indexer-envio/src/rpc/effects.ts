// ---------------------------------------------------------------------------
// Envio Effect API wrappers for the 16 RPC fetchers used by handlers.
//
// Why effects: with v3 preload optimization enabled by default, Envio runs
// each handler twice per event (preload + processing). Without the
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

import { createEffect as createEnvioEffect, S } from "envio";
import {
  fetchErc20Decimals,
  fetchInvertRateFeed,
  fetchRebalanceThresholds,
  fetchRebalancingState,
  fetchReserves,
  fetchTokenDecimalsScaling,
  fetchTradingLimits,
} from "./pool-state.js";
import {
  fetchNumReporters,
  fetchReferenceRateFeedID,
  fetchReportExpiry,
} from "./oracle-state.js";
import { fetchFees, fetchRebalanceIncentiveAtBlock } from "./pool-fees.js";
import {
  fetchPoolExchange,
  fetchVirtualPoolExchangeId,
  VP_PROBE_RPC_ERROR,
} from "./biPoolManager.js";
import {
  fetchBreakerDefaults,
  fetchBreakerFeedState,
  fetchBreakerKind,
  fetchBreakerList,
  type BreakerKindRpc,
} from "./breakers.js";
import { resolveFeeTokenMeta, UNKNOWN_FEE_TOKEN_META } from "../feeToken.js";
import { trackEffectExecution } from "../performance.js";

type UntypedCreateEffect = (
  options: unknown,
  handler: (args: unknown) => Promise<unknown>,
) => unknown;

const createEffect = ((options: unknown, handler: unknown) => {
  const effectName =
    typeof options === "object" &&
    options !== null &&
    "name" in options &&
    typeof (options as { name?: unknown }).name === "string"
      ? (options as { name: string }).name
      : "unknown";

  return (createEnvioEffect as unknown as UntypedCreateEffect)(
    options,
    (args) =>
      trackEffectExecution(effectName, () =>
        (handler as (value: unknown) => Promise<unknown>)(args),
      ),
  );
}) as typeof createEnvioEffect;

// ---------------------------------------------------------------------------
// Output schemas — defined once so they can be shared / referenced. Sury
// re-exports from envio omit `S.literal`, so string-union types like
// `BreakerKindRpc` ride as `S.string` and get cast at the call site.
//
// `S.nullable(T)` accepts null on input and produces `T | null` on output.
// Effect handlers that wrap fetchers returning `T | null` return null on
// misses; callers skip writes and retry on the next event.
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
    lastUpdated0: S.bigint,
    lastUpdated1: S.bigint,
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

// BiPoolManager.getPoolExchange struct as flattened by `fetchPoolExchange`.
const poolExchangeShape = S.schema({
  asset0: S.string,
  asset1: S.string,
  pricingModule: S.string,
  bucket0: S.bigint,
  bucket1: S.bigint,
  lastBucketUpdate: S.bigint,
  spread: S.bigint,
  referenceRateFeedID: S.string,
  referenceRateResetFrequency: S.bigint,
  minimumReports: S.bigint,
  stablePoolResetSize: S.bigint,
});

const vpExchangeIdShape = S.schema({
  exchangeProvider: S.string,
  exchangeId: S.string,
});

const feeTokenMetaShape = S.schema({
  symbol: S.string,
  decimals: S.int32,
});

// ---------------------------------------------------------------------------
// Group A — immutable / governance-rare, address-keyed.
// `cache: true` on medium tier — these values are per-(chainId, address)
// and don't change at the indexer's timescales. Postgres-backed cache
// survives re-syncs and skips the RPC entirely on the second touch.
// A governance change would re-deploy the contract and re-index anyway.
//
// IMPORTANT: every handler in this group sets `context.cache = false` on
// transient-RPC-failure paths. Without that opt-out, a single failed read
// during the first touch would persist `null`/`undefined` in Postgres and
// every subsequent self-heal call would receive the cached miss instead
// of retrying the RPC after the network recovered. The pattern is:
// fetcher returns null on failure → handler sets cache=false → returns
// null → caller skips the entity write → next event re-fetches.
// ---------------------------------------------------------------------------

export const erc20DecimalsEffect = createEffect(
  {
    name: "erc20Decimals",
    input: { chainId: S.int32, tokenAddress: S.string },
    output: S.nullable(S.int32),
    rateLimit: { calls: 200, per: "second" },
    cache: true,
  },
  async ({ input, context }) => {
    const result = await fetchErc20Decimals(
      input.chainId,
      input.tokenAddress,
      context.log,
    );
    if (result === null) {
      context.cache = false;
      return null;
    }
    return result;
  },
);

export const referenceRateFeedIDEffect = createEffect(
  {
    name: "referenceRateFeedID",
    input: { chainId: S.int32, poolAddress: S.string },
    output: S.nullable(S.string),
    rateLimit: { calls: 200, per: "second" },
    cache: true,
  },
  async ({ input, context }) => {
    const result = await fetchReferenceRateFeedID(
      input.chainId,
      input.poolAddress,
      context.log,
    );
    if (result === null) {
      context.cache = false;
      return null;
    }
    return result;
  },
);

const INVERT_RATE_FEED_UNKNOWN = -1;
const INVERT_RATE_FEED_FALSE = 0;
const INVERT_RATE_FEED_TRUE = 1;
export const INVERT_RATE_FEED_EFFECT_NAME = "invertRateFeedV2";

export function decodeInvertRateFeedEffectResult(
  value: number,
): boolean | null {
  if (value === INVERT_RATE_FEED_UNKNOWN) return null;
  if (value === INVERT_RATE_FEED_FALSE) return false;
  if (value === INVERT_RATE_FEED_TRUE) return true;
  throw new Error(`[invertRateFeedEffect] Unexpected encoded value ${value}`);
}

// Keep the cached output integer-encoded. Hosted Envio v3 rejects cached
// nullable boolean writes for this effect (`boolean` -> `jsonb[]` cast), while
// nullable integer effects are used elsewhere successfully. The effect name is
// intentionally versioned: older hosted caches for `invertRateFeed` may contain
// boolean/null payloads from the pre-encoded output schema, and replaying those
// through the integer schema would fail decode before self-heal can run. The
// sentinel keeps the same call-site semantics: null means transient RPC miss,
// so skip writes and retry later.
export const invertRateFeedEffect = createEffect(
  {
    name: INVERT_RATE_FEED_EFFECT_NAME,
    input: { chainId: S.int32, poolAddress: S.string },
    output: S.int32,
    rateLimit: { calls: 200, per: "second" },
    cache: true,
  },
  async ({ input, context }) => {
    const result = await fetchInvertRateFeed(
      input.chainId,
      input.poolAddress,
      context.log,
    );
    if (result === null) {
      context.cache = false;
      return INVERT_RATE_FEED_UNKNOWN;
    }
    return result ? INVERT_RATE_FEED_TRUE : INVERT_RATE_FEED_FALSE;
  },
);

const rebalanceThresholdsShape = S.schema({
  above: S.int32,
  below: S.int32,
});

// Block-scoped: thresholds are governance-mutable via
// `RebalanceThresholdUpdated`, so the cached value would have to vary by
// block. Cross-deploy persistent caching of a per-block result has
// negligible benefit (the effect runs only at FPMMDeployed and on
// self-heal, not in the hot path), so stay `cache: false` permanently
// — same rule as the other Group C block-scoped effects.
export const rebalanceThresholdsEffect = createEffect(
  {
    name: "rebalanceThresholds",
    input: {
      chainId: S.int32,
      poolAddress: S.string,
      blockNumber: S.bigint,
    },
    output: S.nullable(rebalanceThresholdsShape),
    rateLimit: { calls: 200, per: "second" },
    cache: false,
  },
  async ({ input, context }) =>
    (await fetchRebalanceThresholds(
      input.chainId,
      input.poolAddress,
      input.blockNumber,
      context.log,
    )) ?? null,
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
    cache: true,
  },
  // Effect-calls-effect: when the FPMM-direct read fails, route the ERC20
  // fallback through `erc20DecimalsEffect` rather than calling
  // `fetchErc20Decimals` directly. This way two concurrent pool deployments
  // that share a fallback token produce one ERC20 read per (chain, token)
  // per batch instead of N. Trades a tiny bit of orchestration here for
  // proper dedup on the slow-path.
  async ({ input, context }) => {
    const direct = await fetchTokenDecimalsScaling(
      input.chainId,
      input.poolAddress,
      input.fn as "decimals0" | "decimals1",
      context.log,
    );
    if (direct !== null) return direct;
    // From here every "no result" path is a transient miss that we don't
    // want to persist — without the cache opt-out a single failed
    // deployment-time read would pin every later self-heal call on the
    // wrong (default 18) decimals.
    if (!input.fallbackTokenAddress) {
      context.cache = false;
      return null;
    }
    const decimals = await context.effect(erc20DecimalsEffect, {
      chainId: input.chainId,
      tokenAddress: input.fallbackTokenAddress,
    });
    if (decimals === null) {
      context.cache = false;
      return null;
    }
    return 10n ** BigInt(decimals);
  },
);

// ---------------------------------------------------------------------------
// Group B — fee config (per-pool, governance-rare).
// `cache: true` on medium — per-getter mock granularity
// (`FetchFeesMock` rejection semantics) lives inside `fetchFees` itself,
// which the effect handler delegates to.
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
    cache: true,
  },
  // Schema's `S.optional(S.int32)` outputs `number | undefined` with the key
  // always present; the fetcher returns `Partial<>` (key may be missing).
  // Spread to materialize all keys with explicit undefined where missing.
  //
  // Cache-poisoning guard: `fetchFees` returns null on full RPC failure
  // and a partial object when ANY of the three getters transiently fail
  // (the missing field stays undefined → upsertPool keeps `-1` for retry).
  // Caching either case would freeze the failure forever, so set
  // `context.cache = false` whenever the result isn't fully populated.
  // Real `-2` ("getter unsupported on this contract") values are
  // permanent and DO get cached — only undefined is treated as transient.
  async ({ input, context }) => {
    const result = await fetchFees(
      input.chainId,
      input.poolAddress,
      context.log,
    );
    if (result === null) {
      context.cache = false;
      return null;
    }
    if (
      result.lpFee === undefined ||
      result.protocolFee === undefined ||
      result.rebalanceReward === undefined
    ) {
      context.cache = false;
    }
    return {
      lpFee: result.lpFee,
      protocolFee: result.protocolFee,
      rebalanceReward: result.rebalanceReward,
    };
  },
);

export const feeTokenMetaEffect = createEffect(
  {
    name: "feeTokenMeta",
    input: { chainId: S.int32, tokenAddress: S.string },
    output: feeTokenMetaShape,
    rateLimit: { calls: 200, per: "second" },
    cache: true,
  },
  // `resolveFeeTokenMeta` returns UNKNOWN/18 only for transient RPC failure
  // with no static fallback. Let the handler persist that degraded event, but
  // don't save it to Envio's durable effect cache — the next event must retry.
  async ({ input, context }) => {
    const result = await resolveFeeTokenMeta(
      input.chainId,
      input.tokenAddress,
      context.log,
    );
    if (
      result.symbol === UNKNOWN_FEE_TOKEN_META.symbol &&
      result.decimals === UNKNOWN_FEE_TOKEN_META.decimals
    ) {
      context.cache = false;
    }
    return result;
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
    | null
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
  async ({ input, context }) =>
    (await fetchReserves(
      input.chainId,
      input.poolAddress,
      input.blockNumber,
      context.log,
    )) ?? null,
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
  async ({ input, context }) =>
    (await fetchRebalancingState(
      input.chainId,
      input.poolAddress,
      input.blockNumber,
      context.log,
    )) ?? null,
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
  async ({ input, context }) =>
    (await fetchRebalanceIncentiveAtBlock(
      input.chainId,
      input.poolAddress,
      input.blockNumber,
      context.log,
    )) ?? null,
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
  async ({ input, context }) =>
    (await fetchNumReporters(
      input.chainId,
      input.rateFeedID,
      input.blockNumber,
      context.log,
    )) ?? null,
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
  async ({ input, context }) =>
    (await fetchReportExpiry(
      input.chainId,
      input.rateFeedID,
      input.blockNumber,
      context.log,
    )) ?? null,
);

// ---------------------------------------------------------------------------
// Group E — trading limits.
// MUST stay `cache: false` permanently (block-scoped state). Swap handlers use
// this as the authoritative per-swap path because local event derivation cannot
// prove row contiguity after a transient miss or fee-history correctness during
// a full replay.
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
  async ({ input, context }) =>
    (await fetchTradingLimits(
      input.chainId,
      input.poolAddress,
      input.token,
      input.blockNumber,
      context.log,
    )) ?? null,
);

// ---------------------------------------------------------------------------
// Group F — circuit breakers (per-chain governance state).
//   - `breakerKindEffect`: address-keyed (no blockNumber input). `cache: true`
//     on medium gives durable per-address dedup that survives re-indexes.
//   - `breakerListEffect`: block-keyed in the input shape, so caching by
//     (chainId, blockNumber) only dedups within a single block range.
//     Stays `cache: false` — flipping would create one cache row per block
//     for a value that's nearly invariant, with no real re-sync benefit
//     unless we also drop blockNumber from the cache key (separate change).
//   - `breakerDefaultsEffect` and `breakerFeedStateEffect`: block-scoped
//     state. Stay `cache: false` permanently — reorg risk + per-block
//     entries make persistent caching counter-productive.
// ---------------------------------------------------------------------------

export const breakerListEffect = createEffect(
  {
    name: "breakerList",
    input: { chainId: S.int32, blockNumber: S.bigint },
    output: S.nullable(S.array(S.string)),
    rateLimit: { calls: 50, per: "second" },
    cache: false,
  },
  async ({ input, context }) =>
    (await fetchBreakerList(input.chainId, input.blockNumber, context.log)) ??
    null,
);

export const breakerKindEffect = createEffect(
  {
    name: "breakerKind",
    input: { chainId: S.int32, breakerAddress: S.string },
    // BreakerKindRpc is a string union; ride as S.string and cast at call site.
    output: S.nullable(S.string),
    rateLimit: { calls: 50, per: "second" },
    cache: true,
  },
  // `fetchBreakerKind` returns null only on transient probe failure;
  // MEDIAN_DELTA / VALUE_DELTA / MARKET_HOURS are all permanent
  // classifications and safe to cache. Skip the cache only on null
  // so a flaky probe doesn't poison every later breaker bootstrap.
  async ({ input, context }) => {
    const result = await fetchBreakerKind(
      input.chainId,
      input.breakerAddress,
      context.log,
    );
    if (result === null) {
      context.cache = false;
      return null;
    }
    return result;
  },
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
  async ({ input, context }) =>
    (await fetchBreakerDefaults(
      input.chainId,
      input.breakerAddress,
      input.kind as BreakerKindRpc,
      input.blockNumber,
      context.log,
    )) ?? null,
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
  async ({ input, context }) => {
    const result = await fetchBreakerFeedState(
      input.chainId,
      input.breakerAddress,
      input.kind as BreakerKindRpc,
      input.rateFeedID,
      input.blockNumber,
      context.log,
    );
    if (result === null) return null;
    // The schema's nullable inner fields output `T | null`; the fetcher
    // returns `T | null` for kind-specific fields. Map at the boundary.
    return {
      ...result,
      smoothingFactor: result.smoothingFactor ?? null,
      medianRatesEMA: result.medianRatesEMA ?? null,
      referenceValue: result.referenceValue ?? null,
    };
  },
);

// ---------------------------------------------------------------------------
// Group G — BiPoolManager / VirtualPool seed reads.
//
// Both effects fire on entity creation or self-heal, so they're not on the
// per-event hot path for already-healed rows. Caching:
//   - `poolExchangeEffect`: `cache: false`. The struct is read at the event
//     block and includes bucket reserves which mutate every
//     `referenceRateResetFrequency` (~360s); reindexing a block range expects
//     a fresh block-scoped read, not a cached value from another block.
//   - `vpExchangeIdEffect`: `cache: true`. Bytecode is immutable for a
//     deployed contract, so a cache row keyed by (chainId, vpAddress) is
//     accurate forever and skips an RPC on every full re-sync.
// ---------------------------------------------------------------------------

export const poolExchangeEffect = createEffect(
  {
    name: "poolExchange",
    input: {
      chainId: S.int32,
      exchangeProvider: S.string,
      exchangeId: S.string,
      blockNumber: S.bigint,
    },
    output: S.nullable(poolExchangeShape),
    rateLimit: { calls: 50, per: "second" },
    cache: false,
  },
  async ({ input, context }) =>
    (await fetchPoolExchange(
      input.chainId,
      input.exchangeProvider,
      input.exchangeId,
      input.blockNumber,
      context.log,
    )) ?? null,
);

export const vpExchangeIdEffect = createEffect(
  {
    name: "vpExchangeId",
    input: { chainId: S.int32, vpAddress: S.string },
    output: S.nullable(vpExchangeIdShape),
    rateLimit: { calls: 50, per: "second" },
    cache: true,
  },
  // `fetchVirtualPoolExchangeId` returns three discriminated cases:
  //   1. `VirtualPoolExchangeId` — bytecode matched the VP pattern → cache
  //      forever (bytecode is immutable per address).
  //   2. `null` — got bytecode (or `0x`) but pattern didn't match → permanent
  //      not-VP classification, cache forever as `null`. After PR #369
  //      dropped the source-string gate in `selfHealWrappedExchangeId`, FPMM
  //      addresses also reach this effect; caching their not-VP miss is what
  //      keeps the FPMM hot path from paying an `eth_getCode` per event.
  //   3. `VP_PROBE_RPC_ERROR` — `getCode` itself rejected → transient,
  //      `context.cache = false` so a deployment-time RPC blip doesn't
  //      persist as a permanent miss.
  async ({ input, context }) => {
    const result = await fetchVirtualPoolExchangeId(
      input.chainId,
      input.vpAddress,
      context.log,
    );
    if (result === VP_PROBE_RPC_ERROR) {
      context.cache = false;
      return null;
    }
    return result ?? null;
  },
);
