import type { EffectCaller, Pool } from "envio";
import { ZERO_ADDRESS } from "../constants.js";
import { lookupPricingModuleName } from "../contractAddresses.js";
import { extractAddressFromPoolId, isVirtualPool } from "../helpers.js";
import {
  parseDecimalsPair,
  scalingFactorToDecimals,
} from "../priceDifference.js";
import {
  decodeInvertRateFeedEffectResult,
  invertRateFeedEffect,
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
  // leaderboard snapshots — a non-18-decimal USD leg would stay mis-scaled
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
  // Fully-healed gate: VP-confirmed AND tokens populated AND BiPoolExchange
  // row seeded. Token presence and exchange presence both block retries
  // on transient `poolExchangeEffect` / `tokenDecimalsScalingEffect`
  // failures. Without the exchange-row check, a `VirtualPoolDeployed`
  // event that succeeds in setting tokens but fails the exchange seed
  // RPC would leave `wrappedExchangeId` pinned + tokens populated → the
  // gate would skip heal forever, leaving no `BiPoolExchange` row and
  // an empty `referenceRateFeedID` (round 7 codex #3). The bytecode
  // effect is `cache:true`, so re-running the heal on every event for
  // a fully-healed pool is cheap.
  if (pool.wrappedExchangeId && pool.token0 && pool.token1) {
    const exchangeRowId = `${pool.chainId}-${pool.wrappedExchangeId}`;
    const existing = await context.BiPoolExchange.get(exchangeRowId);
    if (existing?.wrappedByPoolId === pool.id) return pool;
    // Else fall through — exchange seed still owed.
    // If the row exists but is missing the back-reference, keep healing:
    // older exchange-first rows can be marked checked before the VP link
    // becomes visible, and the dashboard's VP exchange query keys on
    // `wrappedByPoolId`.
  }
  const poolAddr = extractAddressFromPoolId(pool.id);
  const result = await context.effect(vpExchangeIdEffect, {
    chainId: pool.chainId,
    vpAddress: poolAddr,
  });
  if (!result) return pool;
  const exchangeRowId = `${pool.chainId}-${result.exchangeId}`;
  let exchange = await context.BiPoolExchange.get(exchangeRowId);
  // Round 3 #5: seed the BiPoolExchange row inline if it doesn't exist
  // yet. Pre-start_block ordering: VP.Swap is the first observed event,
  // BiPoolManager.ExchangeCreated fired before our start_block (so it
  // never replays). Without seeding here, token + decimal backfill
  // can't run, and the swap handler immediately persists
  // `SwapEvent.volumeUsdWei` from default 18/18 decimals → mis-scaled
  // forever (the later reverse-link backfill only updates the Pool
  // row, not historical SwapEvent / leaderboard rows). RPC-fetch the
  // struct via the same effect `BiPoolManager.ExchangeCreated` uses
  // and materialize a row keyed on the bytecode-extracted
  // exchangeProvider/exchangeId. Skip on RPC failure (transient) and
  // on all-zero struct (destroyed exchange).
  if (!exchange) {
    const struct = await context.effect(poolExchangeEffect, {
      chainId: pool.chainId,
      exchangeProvider: result.exchangeProvider,
      exchangeId: result.exchangeId,
      blockNumber,
    });
    // Match `ensureBiPoolExchange`'s "destroyed exchange" test: reject
    // ONLY the all-zero-and-no-pricing-module case. Pre-`BucketsUpdated`
    // (newly-created exchange before its first bucket reset) returns
    // zero buckets but has a real `pricingModule` + assets — that's a
    // valid seed. A bucket-zero gate would reject those and skip the
    // token/decimal backfill on the first VP swap.
    if (struct && struct.pricingModule !== ZERO_ADDRESS) {
      const seeded = {
        id: exchangeRowId,
        chainId: pool.chainId,
        exchangeId: result.exchangeId,
        exchangeProvider: result.exchangeProvider,
        asset0: struct.asset0,
        asset1: struct.asset1,
        pricingModule: struct.pricingModule,
        pricingModuleName:
          lookupPricingModuleName(pool.chainId, struct.pricingModule) ??
          undefined,
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
      exchange = seeded;
    }
  }
  let healedFeedId = pool.referenceRateFeedID;
  let healedToken0 = pool.token0;
  let healedToken1 = pool.token1;
  let healedToken0Decimals = pool.token0Decimals;
  let healedToken1Decimals = pool.token1Decimals;
  // Track per-leg whether THIS pass actually fetched decimals (vs.
  // inheriting them from the spread). Round 5 used `dec > 0` which
  // was satisfied by the schema-default 18 — codex caught this as a
  // false-positive that would prevent `selfHealTokenDecimals` from
  // ever retrying a transient blip on a non-18dp leg. Only flip
  // `tokenDecimalsKnown=true` when both legs were fetched this pass.
  let fetchedDec0 = false;
  let fetchedDec1 = false;
  if (exchange) {
    if (exchange.wrappedByPoolId !== pool.id) {
      context.BiPoolExchange.set({
        ...exchange,
        wrappedByPoolId: pool.id,
        wrappedByPoolIdChecked: true,
        updatedAtBlock: blockNumber,
        updatedAtTimestamp: blockTimestamp,
      });
    }
    // Once we've set wrappedByPoolId, ensureBiPoolExchange's null-guarded
    // retry path won't re-run the feedID mirror on subsequent BucketsUpdated
    // events. Mirror it here too so the oracle-price tile lights up
    // immediately on first self-heal — otherwise it'd stay "—" until the
    // NEXT bucket reset (~360s), even though the feedID is in scope.
    await mirrorFeedIdToPool(
      context,
      pool.id,
      exchange.referenceRateFeedID,
      blockNumber,
      blockTimestamp,
    );
    // CRUCIAL: also flow the mirrored feedID back to the caller so
    // `upsertPool`'s next spread doesn't overwrite the just-persisted
    // value. `mirrorFeedIdToPool` does its own `Pool.set`, but the
    // healed Pool returned from this function feeds into `next` in
    // upsertPool which then persists again — without carrying the
    // updated feedID here, that second write would blank the mirror
    // that just landed.
    if (
      exchange.referenceRateFeedID &&
      exchange.referenceRateFeedID !== ZERO_ADDRESS
    ) {
      healedFeedId = exchange.referenceRateFeedID;
    }
    // Backfill pair tokens. Swap/Mint/Burn-first scenario: the Pool was
    // created via getOrCreate without `defaults.token0/token1` (those
    // events don't carry the pair). Without this, the first swap is
    // valued at $0 and the dashboard renders "?" symbols until some
    // later asset-bearing event arrives — which may never happen for
    // pre-start_block VPs. The BiPoolExchange row already has the
    // assets from BiPoolManager.ExchangeCreated. Only fill on miss
    // (existing token0/token1 wins on direct conflict). Skip
    // ZERO_ADDRESS — a zeroed exchange row (transient RPC backfill at
    // ExchangeCreated time) shouldn't pin token0/token1 to 0x0 + then
    // fire an `eth_call decimals()` against it. Mirrors the same guard
    // in `mirrorTokensAndDecimalsToPool` (reverse-link).
    // Backfill pair tokens + decimals AS A UNIT (round 4 codex #1).
    // Pinning the address while leaving decimals at the default 18 was
    // a bug: the new gate above (`&& pool.token0 && pool.token1`) would
    // see token0 set + skip retries, leaving a 6dp USDC leg permanently
    // mis-scaled. Fix: only pin the token when decimals fetch succeeds.
    // On transient `tokenDecimalsScalingEffect` failure, leave both
    // unset — gate stays open, next event retries the pair.
    //
    // Default 18 is wrong for any non-18dp leg (e.g. USDC at 6dp) —
    // `buildSwapTraderFields` runs immediately after `upsertPool`
    // returns and uses these to scale `volumeUsdWei`. `tokenDecimalsScalingEffect`
    // is cache:true (one RPC per chain/token per sync) and tries
    // `decimals0()`/`decimals1()` on the pool first (null for VPs — that
    // getter lives on FPMM), then falls back to ERC20 `decimals()` on
    // the token address. ZERO_ADDRESS guard mirrors the same in
    // `mirrorTokensAndDecimalsToPool`.
    const fillToken0 =
      !healedToken0 && exchange.asset0 && exchange.asset0 !== ZERO_ADDRESS;
    const fillToken1 =
      !healedToken1 && exchange.asset1 && exchange.asset1 !== ZERO_ADDRESS;
    if (fillToken0) {
      const dec = await context.effect(tokenDecimalsScalingEffect, {
        chainId: pool.chainId,
        poolAddress: poolAddr,
        fn: "decimals0",
        fallbackTokenAddress: exchange.asset0,
      });
      if (dec) {
        healedToken0 = exchange.asset0;
        healedToken0Decimals = scalingFactorToDecimals(dec) ?? 18;
        fetchedDec0 = true;
      }
    }
    if (fillToken1) {
      const dec = await context.effect(tokenDecimalsScalingEffect, {
        chainId: pool.chainId,
        poolAddress: poolAddr,
        fn: "decimals1",
        fallbackTokenAddress: exchange.asset1,
      });
      if (dec) {
        healedToken1 = exchange.asset1;
        healedToken1Decimals = scalingFactorToDecimals(dec) ?? 18;
        fetchedDec1 = true;
      }
    }
  }
  // Flip `tokenDecimalsKnown` only when this pass actually fetched both
  // legs' decimals via the effect. Inheriting `decimals > 0` from the
  // schema default (18) is NOT proof of trust — that's the
  // false-positive codex flagged. If decimals were already known
  // before this call, preserve true. Otherwise the cross-pass
  // coordination falls to `selfHealTokenDecimals` (which fires both
  // legs independently and sets the flag when both succeed).
  const decimalsKnown = pool.tokenDecimalsKnown || (fetchedDec0 && fetchedDec1);
  return {
    ...pool,
    wrappedExchangeId: result.exchangeId,
    referenceRateFeedID: healedFeedId,
    token0: healedToken0,
    token1: healedToken1,
    token0Decimals: healedToken0Decimals,
    token1Decimals: healedToken1Decimals,
    tokenDecimalsKnown: decimalsKnown,
  };
}

/** Mirror a v2 exchange's `referenceRateFeedID` onto its wrapping
 * VirtualPool's Pool row so the existing SortedOracles `getPoolsByFeed`
 * lookup picks up the VP naturally. Idempotent — no-op when already in
 * sync. Skips zero/empty feedIDs (still pre-RPC-backfill or destroyed
 * exchange) so a transient source value can't blank a previously-set
 * link. Used from both directions of the VP↔BiPoolExchange linkage
 * (VirtualPoolDeployed forward, BiPoolManager.ExchangeCreated reverse,
 * plus `selfHealWrappedExchangeId` post-self-heal).
 *
 * Context narrowed to just `Pool` access — callers from both PoolContext
 * (upsertPool path) and HandlerContext (event handlers) work. */
export async function mirrorFeedIdToPool(
  context: { Pool: PoolContext["Pool"] },
  poolId: string,
  feedId: string,
  blockNumber: bigint,
  blockTimestamp: bigint,
): Promise<void> {
  if (!feedId || feedId === ZERO_ADDRESS) return;
  const pool = await context.Pool.get(poolId);
  if (!pool || pool.referenceRateFeedID === feedId) return;
  context.Pool.set({
    ...pool,
    referenceRateFeedID: feedId,
    updatedAtBlock: blockNumber,
    updatedAtTimestamp: blockTimestamp,
  });
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
  poolId: string,
  asset0: string,
  asset1: string,
  blockNumber: bigint,
  blockTimestamp: bigint,
): Promise<void> {
  const pool = await context.Pool.get(poolId);
  if (!pool) return;
  // Fully verified: tokens populated AND `tokenDecimalsKnown=true`.
  // Otherwise fall through so cross-pass / partial-fetch state can be
  // re-validated (round 7 codex #1+#2).
  if (pool.tokenDecimalsKnown && pool.token0 && pool.token1) return;
  const fillToken0 = !pool.token0 && asset0 && asset0 !== ZERO_ADDRESS;
  const fillToken1 = !pool.token1 && asset1 && asset1 !== ZERO_ADDRESS;
  const poolAddr = extractAddressFromPoolId(poolId);
  // Round 4 codex #1: pin token + decimals as a unit. If the decimals
  // fetch transiently fails, leave the address unset too so the next
  // event re-tries the pair — pinning the address while leaving
  // decimals at default 18 would lock in a mis-scaled valuation for
  // any non-18dp token (e.g. USDC at 6dp).
  let nextToken0 = pool.token0;
  let nextToken1 = pool.token1;
  let nextToken0Decimals = pool.token0Decimals;
  let nextToken1Decimals = pool.token1Decimals;
  // Per-leg track whether THIS pass actually fetched decimals. The flag
  // flips below only when BOTH legs end up known — either via a fresh
  // fetch this pass OR via a fetch in this pass that confirms the
  // existing value (cross-pass case). `tokenDecimalsScalingEffect` is
  // `cache:true`, so re-fetching a leg whose decimals are already in
  // place is essentially free.
  let fetchedDec0 = false;
  let fetchedDec1 = false;
  // Round 7 codex #1+#2: even when both tokens are populated already,
  // run the decimals fetch when `tokenDecimalsKnown=false` so the flag
  // gets flipped on the cross-pass case (each leg landed via a
  // separate event). Use the existing token address as the fallback
  // when we're not filling.
  const fallback0 = fillToken0 ? asset0 : pool.token0;
  const fallback1 = fillToken1 ? asset1 : pool.token1;
  if (fallback0 && fallback0 !== ZERO_ADDRESS) {
    const dec = await context.effect(tokenDecimalsScalingEffect, {
      chainId: pool.chainId,
      poolAddress: poolAddr,
      fn: "decimals0",
      fallbackTokenAddress: fallback0,
    });
    if (dec) {
      if (fillToken0) nextToken0 = asset0;
      nextToken0Decimals = scalingFactorToDecimals(dec) ?? 18;
      fetchedDec0 = true;
    }
  }
  if (fallback1 && fallback1 !== ZERO_ADDRESS) {
    const dec = await context.effect(tokenDecimalsScalingEffect, {
      chainId: pool.chainId,
      poolAddress: poolAddr,
      fn: "decimals1",
      fallbackTokenAddress: fallback1,
    });
    if (dec) {
      if (fillToken1) nextToken1 = asset1;
      nextToken1Decimals = scalingFactorToDecimals(dec) ?? 18;
      fetchedDec1 = true;
    }
  }
  // Decide if any state actually changed. A change is: a token address
  // newly filled, decimals updated, or the trust-flag flipping.
  const decimalsKnownNext =
    pool.tokenDecimalsKnown || (fetchedDec0 && fetchedDec1);
  const tokensChanged =
    nextToken0 !== pool.token0 || nextToken1 !== pool.token1;
  const decimalsChanged =
    nextToken0Decimals !== pool.token0Decimals ||
    nextToken1Decimals !== pool.token1Decimals;
  const flagFlipped = decimalsKnownNext !== pool.tokenDecimalsKnown;
  if (!tokensChanged && !decimalsChanged && !flagFlipped) return;
  context.Pool.set({
    ...pool,
    token0: nextToken0,
    token1: nextToken1,
    token0Decimals: nextToken0Decimals,
    token1Decimals: nextToken1Decimals,
    tokenDecimalsKnown: decimalsKnownNext,
    updatedAtBlock: blockNumber,
    updatedAtTimestamp: blockTimestamp,
  });
}
