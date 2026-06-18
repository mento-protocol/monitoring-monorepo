import type { BiPoolExchange, EffectCaller, Pool } from "envio";
import { UNKNOWN_ORACLE_REPORTERS, ZERO_ADDRESS } from "../constants.js";
import { lookupPricingModuleName } from "../contractAddresses.js";
import {
  extractAddressFromPoolId,
  isVirtualPool,
  needsOracleReporterCountRefresh,
} from "../helpers.js";
import {
  parseDecimalsPair,
  scalingFactorToDecimals,
} from "../priceDifference.js";
import {
  decodeInvertRateFeedEffectResult,
  invertRateFeedEffect,
  numReportersEffect,
  poolExchangeEffect,
  rebalanceThresholdsEffect,
  tokenDecimalsScalingEffect,
  vpExchangeIdEffect,
} from "../rpc/effects.js";
import type { PoolContext } from "./types.js";

/** Self-heal `invertRateFeed` when it was never successfully read at pool
 * deployment (factory's RPC fan-out hit a transient blip → the field rode
 * the schema default). Returns the same pool when already healed / not
 * applicable, otherwise returns a copy with `invertRateFeed` corrected and
 * `invertRateFeedKnown: true`.
 *
 * Must be called before any code path reads `pool.invertRateFeed` to
 * compute oracle/health/priceDifference state — including the
 * `OracleReported`/`MedianUpdated` handlers (which write directly without
 * going through `upsertPool`) and the `UpdateReserves`/`Rebalanced`
 * handlers (which read `existing.invertRateFeed` before `upsertPool` runs).
 *
 * Effect-level dedup means this is one RPC read per (pool, batch) when
 * unhealed; once `invertRateFeedKnown` flips true, subsequent calls are
 * pure object identity returns — no RPC, no Pool.set side-effect. The
 * caller's own Pool.set persists the healed value. */
export async function selfHealInvertRateFeed(
  context: { effect: EffectCaller },
  pool: Pool,
): Promise<Pool> {
  if (pool.invertRateFeedKnown || pool.source === "" || isVirtualPool(pool)) {
    return pool;
  }
  const poolAddr = extractAddressFromPoolId(pool.id);
  const invert = await context.effect(invertRateFeedEffect, {
    chainId: pool.chainId,
    poolAddress: poolAddr,
  });
  const decoded = decodeInvertRateFeedEffectResult(invert);
  if (decoded === null) return pool;
  return {
    ...pool,
    invertRateFeed: decoded,
    invertRateFeedKnown: true,
  };
}

/** Self-heal `token0Decimals` / `token1Decimals` when the factory's
 * `tokenDecimalsScalingEffect` reads failed at deploy. Without this, a
 * non-18-decimal pool whose factory RPC blipped would silently keep the
 * schema default 18/18 forever — `normalizeTo18` would not scale the
 * affected reserve, and every priceDifference computation downstream
 * would be wrong by `10^(18 - real_dec)` factor.
 *
 * Cache-true effect: `tokenDecimalsScalingEffect` is per-(chain, pool, fn)
 * and the on-chain decimals are immutable, so this is one RPC pair per
 * unhealed pool across the entire run. Once `tokenDecimalsKnown` flips
 * true, subsequent calls are pure object-identity returns.
 *
 * Caller's own `Pool.set` persists the healed values. */
export async function selfHealTokenDecimals(
  context: { effect: EffectCaller },
  pool: Pool,
): Promise<Pool> {
  // VPs were previously skipped because they don't go through the local
  // priceDifference recompute path. But `buildSwapTraderFields` still uses
  // `token0Decimals` / `token1Decimals` to compute `volumeUsdWei` and
  // volume snapshots — a non-18-decimal USD leg would stay mis-scaled
  // for a VP with a deploy-time decimal blip. Cache:true effect, so the
  // RPC pair fires once per VP across the run regardless of how many
  // events touch it.
  if (pool.tokenDecimalsKnown || pool.source === "") {
    return pool;
  }
  // Skip when both pair tokens are still unset — the only way the direct
  // `decimals0`/`decimals1` getters could be authoritative without
  // a fallback is on FPMMs, which always have tokens set from their
  // factory event. If tokens aren't set yet, this is a pre-start_block
  // VP whose `selfHealWrappedExchangeId` couldn't backfill from
  // `BiPoolExchange` (transient seed failure) — running the direct
  // RPC here without a fallback is a wasted call. The next event,
  // post-reverse-link backfill, will retry with tokens populated.
  if (!pool.token0 || !pool.token1) return pool;
  const poolAddr = extractAddressFromPoolId(pool.id);
  const [dec0Raw, dec1Raw] = await Promise.all([
    context.effect(tokenDecimalsScalingEffect, {
      chainId: pool.chainId,
      poolAddress: poolAddr,
      fn: "decimals0",
      fallbackTokenAddress: pool.token0,
    }),
    context.effect(tokenDecimalsScalingEffect, {
      chainId: pool.chainId,
      poolAddress: poolAddr,
      fn: "decimals1",
      fallbackTokenAddress: pool.token1,
    }),
  ]);
  const parsed = parseDecimalsPair(dec0Raw, dec1Raw);
  if (!parsed.tokenDecimalsKnown) return pool;
  return { ...pool, ...parsed };
}

/** Self-heal `rebalanceThresholdAbove/Below` when the factory's
 * `rebalanceThresholdsEffect` failed at deploy. Without this, a transient
 * RPC blip would permanently leave both split fields at 0 → derive returns
 * null forever → the entity-derived path is dead for that pool. Block-
 * scoped read (effect is `cache: false` because thresholds are governance-
 * mutable). The caller's own Pool.set persists the healed values. */
export async function selfHealRebalanceThresholds(
  context: { effect: EffectCaller },
  pool: Pool,
  blockNumber: bigint,
): Promise<Pool> {
  if (
    pool.rebalanceThresholdsKnown ||
    pool.source === "" ||
    isVirtualPool(pool)
  ) {
    return pool;
  }
  const poolAddr = extractAddressFromPoolId(pool.id);
  const thresholds = await context.effect(rebalanceThresholdsEffect, {
    chainId: pool.chainId,
    poolAddress: poolAddr,
    blockNumber,
  });
  if (thresholds === null) return pool;
  // Refresh the legacy `rebalanceThreshold` only when at least one side is
  // configured. Both-zero means "never rebalance" — leave the legacy field
  // at whatever the next state-sync event pins.
  const broadest = Math.max(thresholds.above, thresholds.below);
  return {
    ...pool,
    rebalanceThresholdAbove: thresholds.above,
    rebalanceThresholdBelow: thresholds.below,
    rebalanceThresholdsKnown: true,
    rebalanceThreshold: broadest > 0 ? broadest : pool.rebalanceThreshold,
  };
}

/** Self-heal `Pool.wrappedExchangeId` for VirtualPools whose
 * `VirtualPoolDeployed` event fired pre-start_block (and so the bytecode
 * extraction in the factory handler never ran).
 *
 * Authoritative VP detector is `vpExchangeIdEffect` (bytecode pattern).
 * The previous source-based gate (`isVirtualPool(pool)`) read
 * `pool.source.includes("virtual")` — but VirtualPool.Swap / Mint / Burn
 * handlers reuse the `fpmm_*` source keys (intentional: they share
 * priority with FPMM events for `pickPreferredSource`), so a pre-
 * start_block VP whose first observed event was one of those would
 * never get the "virtual" substring and the heal would be skipped.
 * The bytecode pattern is definitive — it returns null for FPMMs and
 * `{exchangeProvider, exchangeId}` for VPs.
 *
 * The effect is `cache: true` and bytecode is immutable, so the RPC
 * fires once per address across the whole sync regardless of whether
 * the address is a VP or an FPMM. `vpExchangeIdEffect` distinguishes
 * "got bytecode, not a VP" (cached as a permanent miss) from "RPC
 * threw" (transient, not cached) — see the effect's comment for the
 * discriminator. After the cache populates, FPMMs cost zero RPC on
 * subsequent events.
 *
 * Also patches the matching `BiPoolExchange.wrappedByPoolId` back-
 * reference if the exchange row already exists, so the dashboard's
 * `wrappedByPoolId`-keyed GraphQL query finds the join after a heal
 * that only the Pool side knew about. When the BiPoolExchange row is
 * present, also backfills `token0`/`token1` from its `asset0`/`asset1`
 * if the Pool was created without them (Swap/Mint/Burn-first scenario:
 * those events don't carry the pair tokens, so the first VP swap
 * would otherwise show "?" symbols + zero USD valuation until some
 * later asset-bearing event lands).
 *
 * No-op on pools that already have `wrappedExchangeId` set. */
export async function selfHealWrappedExchangeId(
  context: PoolContext,
  pool: Pool,
  blockNumber: bigint,
  blockTimestamp: bigint,
): Promise<Pool> {
  if (await hasCompleteWrappedExchangeLink(context, pool)) return pool;
  const poolAddr = extractAddressFromPoolId(pool.id);
  const result = await context.effect(vpExchangeIdEffect, {
    chainId: pool.chainId,
    vpAddress: poolAddr,
  });
  if (!result) return pool;
  const exchange = await getOrSeedWrappedExchange(context, {
    pool,
    exchangeProvider: result.exchangeProvider,
    exchangeId: result.exchangeId,
    blockNumber,
    blockTimestamp,
  });
  const healed = await mirrorWrappedExchangeConfig(context, {
    pool,
    poolAddr,
    exchange,
    blockNumber,
    blockTimestamp,
  });
  const decimalsKnown =
    pool.tokenDecimalsKnown || (healed.fetchedDec0 && healed.fetchedDec1);
  return {
    ...pool,
    wrappedExchangeId: result.exchangeId,
    referenceRateFeedID: healed.feedId,
    oracleFreshnessWindow: healed.oracleFreshnessWindow,
    oracleNumReporters: healed.oracleNumReporters,
    token0: healed.token0,
    token1: healed.token1,
    token0Decimals: healed.token0Decimals,
    token1Decimals: healed.token1Decimals,
    tokenDecimalsKnown: decimalsKnown,
  };
}

type MirrorVirtualPoolOracleConfigArgs = {
  poolId: string;
  pool?: Pool;
  feedId: string;
  freshnessWindow: bigint;
  blockNumber: bigint;
  blockTimestamp: bigint;
};

type MirroredVirtualPoolOracleConfig = {
  feedId: string;
  oracleFreshnessWindow: bigint;
  oracleNumReporters: number;
};

export async function mirrorVirtualPoolOracleConfig(
  context: { Pool: PoolContext["Pool"]; effect: EffectCaller },
  args: MirrorVirtualPoolOracleConfigArgs,
): Promise<MirroredVirtualPoolOracleConfig | null> {
  const { poolId, feedId, freshnessWindow, blockNumber, blockTimestamp } = args;
  if (!feedId || feedId === ZERO_ADDRESS) return null;
  const pool = args.pool ?? (await context.Pool.get(poolId));
  if (!pool) return null;
  const nextFreshnessWindow = preferPositiveFreshnessWindow(
    pool.oracleFreshnessWindow,
    freshnessWindow,
  );
  const feedChanged = pool.referenceRateFeedID !== feedId;
  const needsReporterRefresh =
    feedChanged || needsOracleReporterCountRefresh(pool);
  const numReporters = needsReporterRefresh
    ? await context.effect(numReportersEffect, {
        chainId: pool.chainId,
        rateFeedID: feedId,
        blockNumber,
      })
    : null;
  const nextOracleNumReporters = nextMirroredOracleNumReporters({
    current: pool.oracleNumReporters,
    feedChanged,
    needsReporterRefresh,
    numReporters,
  });
  const mirrored = {
    feedId,
    oracleFreshnessWindow: nextFreshnessWindow,
    oracleNumReporters: nextOracleNumReporters,
  };
  if (
    pool.referenceRateFeedID === feedId &&
    pool.oracleFreshnessWindow === nextFreshnessWindow &&
    pool.oracleNumReporters === nextOracleNumReporters
  ) {
    return mirrored;
  }
  if (!args.pool) {
    context.Pool.set({
      ...pool,
      referenceRateFeedID: feedId,
      oracleFreshnessWindow: nextFreshnessWindow,
      oracleNumReporters: nextOracleNumReporters,
      updatedAtBlock: blockNumber,
      updatedAtTimestamp: blockTimestamp,
    });
  }
  return mirrored;
}

function nextMirroredOracleNumReporters({
  current,
  feedChanged,
  needsReporterRefresh,
  numReporters,
}: {
  current: number;
  feedChanged: boolean;
  needsReporterRefresh: boolean;
  numReporters: number | null;
}): number {
  if (numReporters !== null) return numReporters;
  if (feedChanged || needsReporterRefresh) return UNKNOWN_ORACLE_REPORTERS;
  return current;
}

function preferPositiveFreshnessWindow(
  current: bigint,
  next: bigint | undefined,
): bigint {
  return next && next > 0n ? next : current;
}

/** Reverse-link backfill: when a `BiPoolExchange` row is created/updated
 * AFTER its wrapping VP has self-healed (so the back-link
 * `wrappedByPoolId` is already known), mirror `asset0`/`asset1` and the
 * matching decimals onto the Pool row. Mirrors the forward backfill in
 * `selfHealWrappedExchangeId` for the heal-before-exchange ordering.
 *
 * Without this, a VP that healed when no `BiPoolExchange` row existed
 * yet keeps `token0`/`token1` empty + decimals at the 18/18 default
 * forever — the heal helper only mirrored fields it could see at the
 * time, and `mirrorFeedIdToPool` only handles the feedID. The first
 * VP swap then valuates at `?/?` with mis-scaled USD until some later
 * asset-bearing event lands (which may never happen for pre-start_block
 * VPs).
 *
 * Idempotent: only fills missing fields (existing token0/token1 wins on
 * direct conflict). Skips the decimals RPC when the address backfill
 * isn't needed. Wider context type (handler `effect` + `Pool` access)
 * because the decimals fetcher uses `tokenDecimalsScalingEffect`. */
export async function mirrorTokensAndDecimalsToPool(
  context: {
    Pool: PoolContext["Pool"];
    effect: PoolContext["effect"];
  },
  args: {
    poolId: string;
    asset0: string;
    asset1: string;
    blockNumber: bigint;
    blockTimestamp: bigint;
  },
): Promise<void> {
  const { poolId, asset0, asset1, blockNumber, blockTimestamp } = args;
  const pool = await context.Pool.get(poolId);
  if (!pool) return;
  if (pool.tokenDecimalsKnown && pool.token0 && pool.token1) return;
  const poolAddr = extractAddressFromPoolId(poolId);
  const token0 = await resolveVpTokenLeg(context, {
    pool,
    poolAddr,
    currentToken: pool.token0,
    currentDecimals: pool.token0Decimals,
    asset: asset0,
    fn: "decimals0",
  });
  const token1 = await resolveVpTokenLeg(context, {
    pool,
    poolAddr,
    currentToken: pool.token1,
    currentDecimals: pool.token1Decimals,
    asset: asset1,
    fn: "decimals1",
  });
  const decimalsKnownNext =
    pool.tokenDecimalsKnown || (token0.fetched && token1.fetched);
  const tokensChanged =
    token0.token !== pool.token0 || token1.token !== pool.token1;
  const decimalsChanged =
    token0.decimals !== pool.token0Decimals ||
    token1.decimals !== pool.token1Decimals;
  const flagFlipped = decimalsKnownNext !== pool.tokenDecimalsKnown;
  if (!tokensChanged && !decimalsChanged && !flagFlipped) return;
  context.Pool.set({
    ...pool,
    token0: token0.token,
    token1: token1.token,
    token0Decimals: token0.decimals,
    token1Decimals: token1.decimals,
    tokenDecimalsKnown: decimalsKnownNext,
    updatedAtBlock: blockNumber,
    updatedAtTimestamp: blockTimestamp,
  });
}

type VpTokenBackfillState = {
  token0: Pool["token0"];
  token1: Pool["token1"];
  token0Decimals: number;
  token1Decimals: number;
  fetchedDec0: boolean;
  fetchedDec1: boolean;
};

type VpTokenLegResult = {
  token: Pool["token0"];
  decimals: number;
  fetched: boolean;
};

async function resolveVpTokenLeg(
  context: { effect: PoolContext["effect"] },
  args: {
    pool: Pool;
    poolAddr: string;
    currentToken: Pool["token0"];
    currentDecimals: number;
    asset: string;
    fn: "decimals0" | "decimals1";
  },
): Promise<VpTokenLegResult> {
  const fillToken =
    !args.currentToken && args.asset && args.asset !== ZERO_ADDRESS;
  const fallbackToken = fillToken ? args.asset : args.currentToken;
  if (!fallbackToken || fallbackToken === ZERO_ADDRESS) {
    return {
      token: args.currentToken,
      decimals: args.currentDecimals,
      fetched: false,
    };
  }
  const dec = await context.effect(tokenDecimalsScalingEffect, {
    chainId: args.pool.chainId,
    poolAddress: args.poolAddr,
    fn: args.fn,
    fallbackTokenAddress: fallbackToken,
  });
  if (!dec) {
    return {
      token: args.currentToken,
      decimals: args.currentDecimals,
      fetched: false,
    };
  }
  return {
    token: fillToken ? args.asset : args.currentToken,
    decimals: scalingFactorToDecimals(dec) ?? 18,
    fetched: true,
  };
}

async function backfillMissingVpTokens(
  context: { effect: PoolContext["effect"] },
  args: {
    pool: Pool;
    poolAddr: string;
    exchange: BiPoolExchange;
    token0: Pool["token0"];
    token1: Pool["token1"];
    token0Decimals: number;
    token1Decimals: number;
  },
): Promise<VpTokenBackfillState> {
  const { pool, poolAddr, exchange } = args;
  const state: VpTokenBackfillState = {
    token0: args.token0,
    token1: args.token1,
    token0Decimals: args.token0Decimals,
    token1Decimals: args.token1Decimals,
    fetchedDec0: false,
    fetchedDec1: false,
  };
  if (!state.token0 && exchange.asset0 && exchange.asset0 !== ZERO_ADDRESS) {
    const dec = await context.effect(tokenDecimalsScalingEffect, {
      chainId: pool.chainId,
      poolAddress: poolAddr,
      fn: "decimals0",
      fallbackTokenAddress: exchange.asset0,
    });
    if (dec) {
      state.token0 = exchange.asset0;
      state.token0Decimals = scalingFactorToDecimals(dec) ?? 18;
      state.fetchedDec0 = true;
    }
  }
  if (!state.token1 && exchange.asset1 && exchange.asset1 !== ZERO_ADDRESS) {
    const dec = await context.effect(tokenDecimalsScalingEffect, {
      chainId: pool.chainId,
      poolAddress: poolAddr,
      fn: "decimals1",
      fallbackTokenAddress: exchange.asset1,
    });
    if (dec) {
      state.token1 = exchange.asset1;
      state.token1Decimals = scalingFactorToDecimals(dec) ?? 18;
      state.fetchedDec1 = true;
    }
  }
  return state;
}

async function hasCompleteWrappedExchangeLink(
  context: PoolContext,
  pool: Pool,
): Promise<boolean> {
  if (!pool.wrappedExchangeId || !pool.token0 || !pool.token1) return false;
  const exchangeRowId = `${pool.chainId}-${pool.wrappedExchangeId}`;
  const existing = await context.BiPoolExchange.get(exchangeRowId);
  if (existing?.wrappedByPoolId !== pool.id) return false;
  if (
    existing.referenceRateFeedID === ZERO_ADDRESS &&
    existing.referenceRateResetFrequency <= 0n
  ) {
    return existing.isDeprecated;
  }
  if (
    existing.referenceRateFeedID !== ZERO_ADDRESS &&
    pool.referenceRateFeedID !== existing.referenceRateFeedID
  ) {
    return false;
  }
  if (
    existing.referenceRateResetFrequency > 0n &&
    pool.oracleFreshnessWindow !== existing.referenceRateResetFrequency
  ) {
    return false;
  }
  if (
    existing.referenceRateFeedID !== ZERO_ADDRESS &&
    existing.minimumReports > 0n &&
    needsOracleReporterCountRefresh(pool)
  ) {
    return false;
  }
  return true;
}

async function getOrSeedWrappedExchange(
  context: PoolContext,
  args: {
    pool: Pool;
    exchangeProvider: string;
    exchangeId: string;
    blockNumber: bigint;
    blockTimestamp: bigint;
  },
): Promise<BiPoolExchange | undefined> {
  const { pool, exchangeProvider, exchangeId, blockNumber, blockTimestamp } =
    args;
  const exchangeRowId = `${pool.chainId}-${exchangeId}`;
  const existing = await context.BiPoolExchange.get(exchangeRowId);
  const existingIsConfigStub =
    existing !== undefined && isWrappedExchangeConfigStub(existing);
  if (existing && (!existingIsConfigStub || existing.isDeprecated)) {
    return existing;
  }
  const struct = await context.effect(poolExchangeEffect, {
    chainId: pool.chainId,
    exchangeProvider,
    exchangeId,
    blockNumber,
  });
  if (!struct || struct.pricingModule === ZERO_ADDRESS) return existing;
  const seeded: BiPoolExchange = {
    id: exchangeRowId,
    chainId: pool.chainId,
    exchangeId,
    exchangeProvider,
    asset0: struct.asset0,
    asset1: struct.asset1,
    pricingModule: struct.pricingModule,
    pricingModuleName:
      lookupPricingModuleName(pool.chainId, struct.pricingModule) ?? undefined,
    spread: struct.spread,
    referenceRateFeedID: struct.referenceRateFeedID,
    referenceRateResetFrequency: struct.referenceRateResetFrequency,
    minimumReports: struct.minimumReports,
    stablePoolResetSize: struct.stablePoolResetSize,
    bucket0: struct.bucket0,
    bucket1: struct.bucket1,
    lastBucketUpdate: struct.lastBucketUpdate,
    isDeprecated: false,
    wrappedByPoolId: pool.id,
    wrappedByPoolIdChecked: true,
    createdAtBlock: blockNumber,
    createdAtTimestamp: blockTimestamp,
    updatedAtBlock: blockNumber,
    updatedAtTimestamp: blockTimestamp,
  };
  context.BiPoolExchange.set(seeded);
  return seeded;
}

function isWrappedExchangeConfigStub(exchange: BiPoolExchange): boolean {
  return (
    exchange.referenceRateFeedID === ZERO_ADDRESS &&
    exchange.referenceRateResetFrequency <= 0n
  );
}

type WrappedExchangeMirrorState = VpTokenBackfillState & {
  feedId: string;
  oracleFreshnessWindow: bigint;
  oracleNumReporters: number;
};

async function mirrorWrappedExchangeConfig(
  context: PoolContext,
  args: {
    pool: Pool;
    poolAddr: string;
    exchange: BiPoolExchange | undefined;
    blockNumber: bigint;
    blockTimestamp: bigint;
  },
): Promise<WrappedExchangeMirrorState> {
  const { pool, poolAddr, exchange, blockNumber, blockTimestamp } = args;
  const state: WrappedExchangeMirrorState = {
    feedId: pool.referenceRateFeedID,
    oracleFreshnessWindow: pool.oracleFreshnessWindow,
    token0: pool.token0,
    token1: pool.token1,
    token0Decimals: pool.token0Decimals,
    token1Decimals: pool.token1Decimals,
    fetchedDec0: false,
    fetchedDec1: false,
    oracleNumReporters: pool.oracleNumReporters,
  };
  if (!exchange) return state;
  if (exchange.wrappedByPoolId !== pool.id) {
    context.BiPoolExchange.set({
      ...exchange,
      wrappedByPoolId: pool.id,
      wrappedByPoolIdChecked: true,
      updatedAtBlock: blockNumber,
      updatedAtTimestamp: blockTimestamp,
    });
  }
  const mirrored = await mirrorVirtualPoolOracleConfig(context, {
    poolId: pool.id,
    pool,
    feedId: exchange.referenceRateFeedID,
    freshnessWindow: exchange.referenceRateResetFrequency,
    blockNumber,
    blockTimestamp,
  });
  if (mirrored) {
    state.feedId = mirrored.feedId;
    state.oracleFreshnessWindow = mirrored.oracleFreshnessWindow;
    state.oracleNumReporters = mirrored.oracleNumReporters;
  } else if (exchange.referenceRateFeedID !== ZERO_ADDRESS) {
    state.feedId = exchange.referenceRateFeedID;
    state.oracleFreshnessWindow = preferPositiveFreshnessWindow(
      state.oracleFreshnessWindow,
      exchange.referenceRateResetFrequency,
    );
  }
  return {
    ...state,
    ...(await backfillMissingVpTokens(context, {
      pool,
      poolAddr,
      exchange,
      token0: state.token0,
      token1: state.token1,
      token0Decimals: state.token0Decimals,
      token1Decimals: state.token1Decimals,
    })),
  };
}
