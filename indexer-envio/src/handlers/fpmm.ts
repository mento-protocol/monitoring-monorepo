// ---------------------------------------------------------------------------
// FPMM and FPMMFactory event handlers
// ---------------------------------------------------------------------------

import {
  FPMMFactory,
  FPMM,
  type Pool,
  type FactoryDeployment,
  type SwapEvent,
  type LiquidityEvent,
  type LiquidityPosition,
  type ReserveUpdate,
  type RebalanceEvent,
  type OracleSnapshot,
  type TradingLimit,
} from "generated";
import {
  eventId,
  asAddress,
  asBigInt,
  makePoolId,
  extractAddressFromPoolId,
} from "../helpers";
import {
  scalingFactorToDecimals,
  ORACLE_ADAPTER_SCALE_FACTOR,
} from "../priceDifference";
import {
  TRADING_LIMITS_INTERNAL_DECIMALS,
  computeLimitPressures,
  computeLimitStatus,
} from "../tradingLimits";
import {
  fetchRebalancingState,
  fetchInvertRateFeed,
  fetchRebalanceThreshold,
  fetchReferenceRateFeedID,
  fetchTokenDecimalsScaling,
  fetchReportExpiry,
  fetchNumReporters,
  fetchTradingLimits,
  fetchFees,
} from "../rpc";
import {
  DEFAULT_ORACLE_FIELDS,
  maybePreloadPool,
  upsertPool,
  upsertSnapshot,
} from "../pool";
import { recordHealthSample } from "../healthScore";
import { isKnownFeeToken } from "../feeToken";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

async function applyLiquidityPositionDelta({
  context,
  chainId,
  poolId,
  address,
  delta,
  blockNumber,
  blockTimestamp,
}: {
  context: {
    LiquidityPosition: {
      get: (id: string) => Promise<LiquidityPosition | undefined>;
      set: (entity: LiquidityPosition) => void;
    };
  };
  chainId: number;
  poolId: string;
  address: string;
  delta: bigint;
  blockNumber: bigint;
  blockTimestamp: bigint;
}) {
  // Skip self-transfers where the pool contract receives its own LP tokens
  // (this happens during mint/burn ops — pool is neither an LP owner nor zero).
  const rawPoolAddress = extractAddressFromPoolId(poolId);
  if (address === ZERO_ADDRESS || address === rawPoolAddress || delta === 0n)
    return;

  const id = `${poolId}-${address}`;
  const existing = await context.LiquidityPosition.get(id);
  const prevBalance = existing?.netLiquidity ?? 0n;
  const nextBalance = prevBalance + delta;

  context.LiquidityPosition.set({
    id,
    chainId,
    poolId,
    address,
    netLiquidity: nextBalance > 0n ? nextBalance : 0n,
    lastUpdatedBlock: blockNumber,
    lastUpdatedTimestamp: blockTimestamp,
  });
}

// ---------------------------------------------------------------------------
// FPMMFactory
// ---------------------------------------------------------------------------

// Dynamically register the deployed pool + its fee tokens so Envio starts
// indexing all FPMM events (Swap, Mint, Burn, etc.) without needing a
// hardcoded address list in the config. Envio deduplicates addresses, so
// re-registering the same address on re-runs is harmless.
//
// SECURITY GATE: `addERC20FeeToken` is only called for tokens present in the
// canonical Mento registry (`@mento-protocol/contracts`). This prevents a
// compromised factory owner (or a misconfigured deployment) from registering
// an attacker-controlled ERC20 that spams Transfer events at the yield-split
// address — each of which would otherwise force the indexer to read pool
// state and burn RPC/DB quota. Pool creation itself is `onlyOwner` in the
// FPMMFactory, so this is defense in depth. New legitimate fee tokens ship
// via a `@mento-protocol/contracts` bump (plus a resync) — if a new token
// is observed here without a registry entry we log a warning so the gap is
// visible in operations. See: Codex finding
// https://chatgpt.com/codex/cloud/security/findings/bcfbd2e38c388191a52fb85205eb326d
//
// Note: contractRegister callbacks are a framework-level hook that Envio
// invokes before the handler. The Envio test harness (processEvent) only
// exercises the .handler() path, so this callback has no direct test
// coverage — this is a framework limitation, not an oversight. We mitigate
// by unit-testing `isKnownFeeToken` directly and asserting the callback is
// registered via the handler-registry introspection tests.
FPMMFactory.FPMMDeployed.contractRegister(({ event, context }) => {
  context.addFPMM(event.params.fpmmProxy);

  // Always log the pool address + tokens at registration so operators can
  // correlate a "token rejected" warning back to its source pool.
  const token0 = event.params.token0;
  const token1 = event.params.token1;

  if (isKnownFeeToken(event.chainId, token0)) {
    context.addERC20FeeToken(token0);
  } else {
    console.warn(
      `[FPMMFactory] Rejecting fee-token registration for unknown token0=${token0} ` +
        `on chain ${event.chainId} (pool=${event.params.fpmmProxy}). ` +
        `Bump @mento-protocol/contracts if this token is legitimate.`,
    );
  }

  if (isKnownFeeToken(event.chainId, token1)) {
    context.addERC20FeeToken(token1);
  } else {
    console.warn(
      `[FPMMFactory] Rejecting fee-token registration for unknown token1=${token1} ` +
        `on chain ${event.chainId} (pool=${event.params.fpmmProxy}). ` +
        `Bump @mento-protocol/contracts if this token is legitimate.`,
    );
  }
});

FPMMFactory.FPMMDeployed.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolAddr = asAddress(event.params.fpmmProxy); // raw address for RPC calls
  const poolId = makePoolId(event.chainId, poolAddr); // namespaced ID for DB entities
  // See UpdateReserves handler — heavy RPC fan-out (6+ Promise.all reads)
  // gets skipped during preload and runs only in processing.
  if (await maybePreloadPool(context, poolId)) return;
  const token0 = asAddress(event.params.token0);
  const token1 = asAddress(event.params.token1);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  // Fetch oracle state from chain at pool creation
  let oracleDelta: Partial<typeof DEFAULT_ORACLE_FIELDS> = {};

  const [
    rateFeedID,
    rebalanceThreshold,
    dec0Raw,
    dec1Raw,
    invertRateFeed,
    fees,
  ] = await Promise.all([
    fetchReferenceRateFeedID(event.chainId, poolAddr),
    // Use standalone getters — they work even when the oracle is stale,
    // unlike getRebalancingState() which reverts on stale/expired oracle data.
    fetchRebalanceThreshold(event.chainId, poolAddr),
    // Fetch token decimals scaling factors (e.g. 1e18 for 18-decimal tokens)
    fetchTokenDecimalsScaling(event.chainId, poolAddr, "decimals0", token0),
    fetchTokenDecimalsScaling(event.chainId, poolAddr, "decimals1", token1),
    fetchInvertRateFeed(event.chainId, poolAddr),
    fetchFees(event.chainId, poolAddr),
  ]);
  // Convert scaling factor (1e18, 1e6, etc.) to decimals count (18, 6, etc.)
  const token0Decimals = dec0Raw
    ? (scalingFactorToDecimals(dec0Raw) ?? 18)
    : 18;
  const token1Decimals = dec1Raw
    ? (scalingFactorToDecimals(dec1Raw) ?? 18)
    : 18;

  if (rateFeedID) {
    oracleDelta.referenceRateFeedID = rateFeedID;
    // Seed oracleExpiry and oracleNumReporters at pool creation so oracle
    // handlers can read them from the DB without per-event RPC calls.
    const [oracleExpiry, numReporters] = await Promise.all([
      fetchReportExpiry(event.chainId, rateFeedID, blockNumber),
      fetchNumReporters(event.chainId, rateFeedID, blockNumber),
    ]);
    if (oracleExpiry !== null) {
      oracleDelta.oracleExpiry = oracleExpiry;
    }
    if (numReporters !== null) {
      oracleDelta.oracleNumReporters = numReporters;
    }
  }

  oracleDelta.invertRateFeed = invertRateFeed;

  if (rebalanceThreshold > 0) {
    oracleDelta.rebalanceThreshold = rebalanceThreshold;
  }

  const pool = await upsertPool({
    context,
    chainId: event.chainId,
    poolId,
    token0,
    token1,
    source: "fpmm_factory",
    blockNumber,
    blockTimestamp,
    txHash: event.transaction.hash,
    oracleDelta,
    tokenDecimals: { token0Decimals, token1Decimals },
  });

  // Persist fee config read at pool creation
  if (fees) {
    context.Pool.set({
      ...pool,
      lpFee: fees.lpFee,
      protocolFee: fees.protocolFee,
    });
  }

  const deployment: FactoryDeployment = {
    id,
    chainId: event.chainId,
    poolId,
    token0,
    token1,
    implementation: asAddress(event.params.fpmmImplementation),
    factoryAddress: asAddress(event.srcAddress),
    txHash: event.transaction.hash,
    blockNumber,
    blockTimestamp,
  };

  context.FactoryDeployment.set(deployment);
});

// ---------------------------------------------------------------------------
// FPMM.Swap
// ---------------------------------------------------------------------------

FPMM.Swap.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = makePoolId(event.chainId, event.srcAddress);
  if (await maybePreloadPool(context, poolId)) return;
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  const volume0 =
    event.params.amount0In > event.params.amount0Out
      ? event.params.amount0In
      : event.params.amount0Out;
  const volume1 =
    event.params.amount1In > event.params.amount1Out
      ? event.params.amount1In
      : event.params.amount1Out;

  // No fetchReserves RPC call needed: the FPMM contract calls _update()
  // before emitting Swap, so an UpdateReserves event with the exact post-swap
  // reserves always precedes this Swap event in the same tx. By the time this
  // handler runs, the UpdateReserves handler has already written reserves to
  // the Pool entity.
  const pool = await upsertPool({
    context,
    chainId: event.chainId,
    poolId,
    source: "fpmm_swap",
    blockNumber,
    blockTimestamp,
    txHash: event.transaction.hash,
    swapDelta: { volume0, volume1 },
  });

  await upsertSnapshot({
    context,
    pool,
    blockTimestamp,
    blockNumber,
    swapDelta: { volume0, volume1 },
  });

  // Update trading limits for FPMM pools (guard: getTradingLimits reverts on VirtualPools)
  if (
    pool.source &&
    pool.source.includes("fpmm") &&
    pool.token0 &&
    pool.token1
  ) {
    const [limits0, limits1] = await Promise.all([
      fetchTradingLimits(
        event.chainId,
        event.srcAddress,
        pool.token0,
        blockNumber,
      ),
      fetchTradingLimits(
        event.chainId,
        event.srcAddress,
        pool.token1,
        blockNumber,
      ),
    ]);

    let worstP0 = 0;
    let worstP1 = 0;

    if (limits0) {
      const { p0, p1 } = computeLimitPressures(
        limits0.state.netflow0,
        limits0.state.netflow1,
        limits0.config.limit0,
        limits0.config.limit1,
      );
      worstP0 = Math.max(worstP0, p0, p1);
      const tl: TradingLimit = {
        id: `${poolId}-${pool.token0}`,
        chainId: event.chainId,
        poolId,
        token: pool.token0,
        limit0: limits0.config.limit0,
        limit1: limits0.config.limit1,
        decimals: TRADING_LIMITS_INTERNAL_DECIMALS,
        netflow0: limits0.state.netflow0,
        netflow1: limits0.state.netflow1,
        lastUpdated0: BigInt(limits0.state.lastUpdated0),
        lastUpdated1: BigInt(limits0.state.lastUpdated1),
        limitPressure0: p0.toFixed(4),
        limitPressure1: p1.toFixed(4),
        limitStatus: computeLimitStatus(p0, p1),
        updatedAtBlock: blockNumber,
        updatedAtTimestamp: blockTimestamp,
      };
      context.TradingLimit.set(tl);
    }

    if (limits1) {
      const { p0, p1 } = computeLimitPressures(
        limits1.state.netflow0,
        limits1.state.netflow1,
        limits1.config.limit0,
        limits1.config.limit1,
      );
      worstP1 = Math.max(worstP1, p0, p1);
      const tl: TradingLimit = {
        id: `${poolId}-${pool.token1}`,
        chainId: event.chainId,
        poolId,
        token: pool.token1,
        limit0: limits1.config.limit0,
        limit1: limits1.config.limit1,
        decimals: TRADING_LIMITS_INTERNAL_DECIMALS,
        netflow0: limits1.state.netflow0,
        netflow1: limits1.state.netflow1,
        lastUpdated0: BigInt(limits1.state.lastUpdated0),
        lastUpdated1: BigInt(limits1.state.lastUpdated1),
        limitPressure0: p0.toFixed(4),
        limitPressure1: p1.toFixed(4),
        limitStatus: computeLimitStatus(p0, p1),
        updatedAtBlock: blockNumber,
        updatedAtTimestamp: blockTimestamp,
      };
      context.TradingLimit.set(tl);
    }

    if (limits0 || limits1) {
      // Log when only one token's limits were fetched — partial state is usable
      // but indicates an RPC hiccup that will be retried on the next Swap.
      if (!limits0 || !limits1) {
        console.warn(
          `[FPMM.Swap] Partial trading limit fetch for pool ${poolId}: ` +
            `limits0=${!!limits0} limits1=${!!limits1}. ` +
            `limitStatus will reflect the available data only.`,
        );
      }
      const overallWorst = Math.max(worstP0, worstP1);
      const limitStatus = computeLimitStatus(overallWorst, 0);
      const updatedPool = await context.Pool.get(poolId);
      if (updatedPool) {
        context.Pool.set({
          ...updatedPool,
          limitStatus,
          limitPressure0: worstP0.toFixed(4),
          limitPressure1: worstP1.toFixed(4),
        });
      }
    }
  }

  const swap: SwapEvent = {
    id,
    chainId: event.chainId,
    poolId,
    sender: asAddress(event.params.sender),
    recipient: asAddress(event.params.to),
    amount0In: event.params.amount0In,
    amount1In: event.params.amount1In,
    amount0Out: event.params.amount0Out,
    amount1Out: event.params.amount1Out,
    txHash: event.transaction.hash,
    blockNumber,
    blockTimestamp,
  };

  context.SwapEvent.set(swap);
});

// ---------------------------------------------------------------------------
// FPMM.Mint
// ---------------------------------------------------------------------------

FPMM.Mint.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = makePoolId(event.chainId, event.srcAddress);
  if (await maybePreloadPool(context, poolId)) return;
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  const pool = await upsertPool({
    context,
    chainId: event.chainId,
    poolId,
    source: "fpmm_mint",
    blockNumber,
    blockTimestamp,
    txHash: event.transaction.hash,
  });

  await upsertSnapshot({
    context,
    pool,
    blockTimestamp,
    blockNumber,
    mintDelta: true,
  });

  const liquidityEvent: LiquidityEvent = {
    id,
    chainId: event.chainId,
    poolId,
    kind: "MINT",
    sender: asAddress(event.params.sender),
    recipient: asAddress(event.params.to),
    amount0: event.params.amount0,
    amount1: event.params.amount1,
    liquidity: event.params.liquidity,
    txHash: event.transaction.hash,
    blockNumber,
    blockTimestamp,
  };

  context.LiquidityEvent.set(liquidityEvent);
});

// ---------------------------------------------------------------------------
// FPMM.Burn
// ---------------------------------------------------------------------------

FPMM.Burn.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = makePoolId(event.chainId, event.srcAddress);
  if (await maybePreloadPool(context, poolId)) return;
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  const pool = await upsertPool({
    context,
    chainId: event.chainId,
    poolId,
    source: "fpmm_burn",
    blockNumber,
    blockTimestamp,
    txHash: event.transaction.hash,
  });

  await upsertSnapshot({
    context,
    pool,
    blockTimestamp,
    blockNumber,
    burnDelta: true,
  });

  const liquidityEvent: LiquidityEvent = {
    id,
    chainId: event.chainId,
    poolId,
    kind: "BURN",
    sender: asAddress(event.params.sender),
    recipient: asAddress(event.params.to),
    amount0: event.params.amount0,
    amount1: event.params.amount1,
    liquidity: event.params.liquidity,
    txHash: event.transaction.hash,
    blockNumber,
    blockTimestamp,
  };

  context.LiquidityEvent.set(liquidityEvent);
});

// ---------------------------------------------------------------------------
// FPMM.Transfer (LP token ownership)
// ---------------------------------------------------------------------------

FPMM.Transfer.handler(async ({ event, context }) => {
  const poolId = makePoolId(event.chainId, event.srcAddress);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);
  const from = asAddress(event.params.from);
  const to = asAddress(event.params.to);
  const value = event.params.value;

  // LiquidityPosition tracks actual LP token ownership. For burns, the owner is
  // only observable via LP token Transfer events (owner -> pool, then pool -> 0x0),
  // not the Burn event's `to` beneficiary.
  await applyLiquidityPositionDelta({
    context,
    chainId: event.chainId,
    poolId,
    address: from,
    delta: -value,
    blockNumber,
    blockTimestamp,
  });
  await applyLiquidityPositionDelta({
    context,
    chainId: event.chainId,
    poolId,
    address: to,
    delta: value,
    blockNumber,
    blockTimestamp,
  });
});

// ---------------------------------------------------------------------------
// FPMM.UpdateReserves
// ---------------------------------------------------------------------------

FPMM.UpdateReserves.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = makePoolId(event.chainId, event.srcAddress);
  // Preload phase: signal Pool + open-breach-row dependencies so Envio
  // preloads them, then bail. All RPC + writes run only in processing.
  // Envio docs explicitly warn against direct `fetch` in preload — the
  // calls run twice per event (stale-data risk). Empirically, letting
  // RPC run in preload also caused in-batch Pool writes to not propagate
  // between sequential handlers, manifesting as breach rows closing
  // with `endedByEvent = "unknown"` even when a Rebalanced event fired
  // right after the UR handlers in the same tx. See `maybePreloadPool`.
  if (await maybePreloadPool(context, poolId)) return;
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  // RPC and Pool.get are independent — fire in parallel to eliminate the
  // serial RTT. `context.Pool.get` only matters on the rebalancingState
  // success path (to read invertRateFeed), so the "waste" on the RPC-null
  // path is tolerable and already cached by Envio's in-batch store.
  // Use raw srcAddress for RPC calls (not the namespaced poolId).
  const [rebalancingState, existing] = await Promise.all([
    fetchRebalancingState(
      event.chainId,
      asAddress(event.srcAddress),
      blockNumber,
    ),
    context.Pool.get(poolId),
  ]);

  let oracleDelta: Partial<typeof DEFAULT_ORACLE_FIELDS> = {};
  // Hoist oraclePrice outside the if-block so it's accessible for OracleSnapshot
  // construction without a non-null assertion on oracleDelta.oraclePrice.
  let updateReservesOraclePrice = 0n;
  if (rebalancingState) {
    const isInverted = existing?.invertRateFeed ?? false;
    updateReservesOraclePrice = isInverted
      ? rebalancingState.oraclePriceDenominator * ORACLE_ADAPTER_SCALE_FACTOR
      : rebalancingState.oraclePriceNumerator * ORACLE_ADAPTER_SCALE_FACTOR;

    oracleDelta = {
      oraclePrice: updateReservesOraclePrice,
      rebalanceThreshold: rebalancingState.rebalanceThreshold,
      priceDifference: rebalancingState.priceDifference,
      oracleTimestamp: blockTimestamp,
    };
  }

  const pool = await upsertPool({
    context,
    chainId: event.chainId,
    poolId,
    source: "fpmm_update_reserves",
    blockNumber,
    blockTimestamp,
    txHash: event.transaction.hash,
    reservesDelta: {
      reserve0: event.params.reserve0,
      reserve1: event.params.reserve1,
    },
    oracleDelta,
    // Reuse the Pool read from the concurrent Promise.all above — avoids
    // a second context.Pool.get inside getOrCreatePool.
    existing: { pool: existing },
  });

  if (rebalancingState) {
    // Health score: compute snapshot fields + update pool accumulators.
    // Note: upsertPool above calls context.Pool.set(pool) internally with
    // default health fields. We immediately overwrite with the correct
    // health accumulators here. Safe because Envio is single-threaded, but
    // the double-write is intentional — health update must come after upsertPool
    // so we have the final pool state to accumulate against.
    const { snapshotFields, poolUpdate } = recordHealthSample(
      pool,
      pool.priceDifference,
      pool.rebalanceThreshold,
      blockTimestamp,
    );
    context.Pool.set({ ...pool, ...poolUpdate });
    const snapshot: OracleSnapshot = {
      id: eventId(event.chainId, event.block.number, event.logIndex),
      chainId: event.chainId,
      poolId,
      timestamp: blockTimestamp,
      oraclePrice: updateReservesOraclePrice,
      oracleOk: pool.oracleOk,
      numReporters: pool.oracleNumReporters,
      priceDifference: pool.priceDifference,
      rebalanceThreshold: pool.rebalanceThreshold,
      source: "update_reserves",
      blockNumber,
      txHash: event.transaction.hash,
      ...snapshotFields,
    };
    context.OracleSnapshot.set(snapshot);
  }

  await upsertSnapshot({
    context,
    pool,
    blockTimestamp,
    blockNumber,
  });

  const reserveUpdate: ReserveUpdate = {
    id,
    chainId: event.chainId,
    poolId,
    reserve0: event.params.reserve0,
    reserve1: event.params.reserve1,
    blockTimestampInPool: event.params.blockTimestamp,
    txHash: event.transaction.hash,
    blockNumber,
    blockTimestamp,
  };

  context.ReserveUpdate.set(reserveUpdate);
});

// ---------------------------------------------------------------------------
// FPMM.Rebalanced
// ---------------------------------------------------------------------------

FPMM.Rebalanced.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = makePoolId(event.chainId, event.srcAddress);
  // See UpdateReserves handler for the full rationale. Critical here
  // because FPMM emits 2× UR + 1× Rebalanced in the same rebalance tx
  // and we need sequential in-batch state visibility so Rebalanced sees
  // the anchor UR held.
  if (await maybePreloadPool(context, poolId)) return;
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  // Fire RPC + Pool.get concurrently (see UpdateReserves handler).
  // Use raw srcAddress for RPC calls (not the namespaced poolId).
  const [rebalancingState, existing] = await Promise.all([
    fetchRebalancingState(
      event.chainId,
      asAddress(event.srcAddress),
      blockNumber,
    ),
    context.Pool.get(poolId),
  ]);

  const rebalancerAddress = asAddress(event.params.sender);

  // Compute effectiveness ratio up-front so it can ride along on oracleDelta
  // into the Pool row (as `lastEffectivenessRatio`) AND be reused verbatim by
  // the RebalanceEvent construction below.
  const priceDifferenceBefore = event.params.priceDifferenceBefore;
  const priceDifferenceAfter = event.params.priceDifferenceAfter;
  const improvement = priceDifferenceBefore - priceDifferenceAfter;
  const effectivenessRatio =
    priceDifferenceBefore > 0n
      ? (Number(improvement) / Number(priceDifferenceBefore)).toFixed(4)
      : "0.0000";

  let oracleDelta: Partial<typeof DEFAULT_ORACLE_FIELDS> = {
    lastRebalancedAt: blockTimestamp,
    rebalancerAddress,
    rebalanceLivenessStatus: "ACTIVE",
    priceDifference: event.params.priceDifferenceAfter,
    lastEffectivenessRatio: effectivenessRatio,
  };

  // Hoist oraclePrice outside the if-block so it's accessible for OracleSnapshot
  // construction without a non-null assertion on oracleDelta.oraclePrice.
  let rebalancedOraclePrice = 0n;
  if (rebalancingState) {
    const isInverted = existing?.invertRateFeed ?? false;
    rebalancedOraclePrice = isInverted
      ? rebalancingState.oraclePriceDenominator * ORACLE_ADAPTER_SCALE_FACTOR
      : rebalancingState.oraclePriceNumerator * ORACLE_ADAPTER_SCALE_FACTOR;

    oracleDelta = {
      ...oracleDelta,
      oraclePrice: rebalancedOraclePrice,
      rebalanceThreshold: rebalancingState.rebalanceThreshold,
      oracleTimestamp: blockTimestamp,
    };
  }

  const pool = await upsertPool({
    context,
    chainId: event.chainId,
    poolId,
    source: "fpmm_rebalanced",
    blockNumber,
    blockTimestamp,
    txHash: event.transaction.hash,
    strategy: rebalancerAddress,
    rebalanceDelta: true,
    oracleDelta,
    // Reuse the Pool read from the concurrent Promise.all above.
    existing: { pool: existing },
  });

  if (rebalancingState) {
    // Health score: compute snapshot fields + update pool accumulators.
    // Note: upsertPool above calls context.Pool.set(pool) internally with
    // default health fields. We immediately overwrite with the correct
    // health accumulators here. Safe because Envio is single-threaded, but
    // the double-write is intentional — health update must come after upsertPool
    // so we have the final pool state to accumulate against.
    const { snapshotFields, poolUpdate } = recordHealthSample(
      pool,
      pool.priceDifference,
      pool.rebalanceThreshold,
      blockTimestamp,
    );
    context.Pool.set({ ...pool, ...poolUpdate });

    const snapshot: OracleSnapshot = {
      id: eventId(event.chainId, event.block.number, event.logIndex),
      chainId: event.chainId,
      poolId,
      timestamp: blockTimestamp,
      oraclePrice: rebalancedOraclePrice,
      oracleOk: pool.oracleOk,
      numReporters: pool.oracleNumReporters,
      priceDifference: pool.priceDifference,
      rebalanceThreshold: pool.rebalanceThreshold,
      source: "rebalanced",
      blockNumber,
      txHash: event.transaction.hash,
      ...snapshotFields,
    };
    context.OracleSnapshot.set(snapshot);
  }

  await upsertSnapshot({
    context,
    pool,
    blockTimestamp,
    blockNumber,
    rebalanceDelta: true,
  });

  const rebalanced: RebalanceEvent = {
    id,
    chainId: event.chainId,
    poolId,
    sender: rebalancerAddress,
    caller: event.transaction.from ?? "",
    priceDifferenceBefore,
    priceDifferenceAfter,
    improvement,
    effectivenessRatio,
    txHash: event.transaction.hash,
    blockNumber,
    blockTimestamp,
  };

  context.RebalanceEvent.set(rebalanced);
});

// ---------------------------------------------------------------------------
// FPMM.TradingLimitConfigured
// ---------------------------------------------------------------------------

FPMM.TradingLimitConfigured.handler(async ({ event, context }) => {
  const poolId = makePoolId(event.chainId, event.srcAddress);
  // See UpdateReserves handler. `fetchTradingLimits` is a raw RPC call
  // that must not run in preload for the same in-batch-state reasons.
  if (await maybePreloadPool(context, poolId)) return;
  const token = asAddress(event.params.token);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  const configTuple = event.params.config as unknown as [
    bigint,
    bigint,
    number,
  ];
  const eventLimit0 = configTuple[0];
  const eventLimit1 = configTuple[1];

  const limits = await fetchTradingLimits(
    event.chainId,
    event.srcAddress,
    event.params.token,
    blockNumber,
  );

  const limit0 = limits ? limits.config.limit0 : eventLimit0;
  const limit1 = limits ? limits.config.limit1 : eventLimit1;
  const decimals = TRADING_LIMITS_INTERNAL_DECIMALS;
  const netflow0 = limits ? limits.state.netflow0 : 0n;
  const netflow1 = limits ? limits.state.netflow1 : 0n;
  const lastUpdated0 = limits ? BigInt(limits.state.lastUpdated0) : 0n;
  const lastUpdated1 = limits ? BigInt(limits.state.lastUpdated1) : 0n;

  const { p0, p1 } = computeLimitPressures(netflow0, netflow1, limit0, limit1);
  const limitStatus = computeLimitStatus(p0, p1);

  const tl: TradingLimit = {
    id: `${poolId}-${token}`,
    chainId: event.chainId,
    poolId,
    token,
    limit0,
    limit1,
    decimals,
    netflow0,
    netflow1,
    lastUpdated0,
    lastUpdated1,
    limitPressure0: p0.toFixed(4),
    limitPressure1: p1.toFixed(4),
    limitStatus,
    updatedAtBlock: blockNumber,
    updatedAtTimestamp: blockTimestamp,
  };
  context.TradingLimit.set(tl);

  const pool = await context.Pool.get(poolId);
  if (pool) {
    context.Pool.set({
      ...pool,
      limitStatus,
      limitPressure0: p0.toFixed(4),
      limitPressure1: p1.toFixed(4),
    });
  }
});

// ---------------------------------------------------------------------------
// FPMM.LiquidityStrategyUpdated
// ---------------------------------------------------------------------------

FPMM.LiquidityStrategyUpdated.handler(async ({ event, context }) => {
  const poolId = makePoolId(event.chainId, event.srcAddress);
  const strategy = asAddress(event.params.strategy);
  const status = event.params.status;

  const pool = await context.Pool.get(poolId);
  if (!pool) return;

  if (status) {
    context.Pool.set({ ...pool, rebalancerAddress: strategy });
  } else if (pool.rebalancerAddress === strategy) {
    context.Pool.set({ ...pool, rebalancerAddress: "" });
  }
});

// ---------------------------------------------------------------------------
// FPMM.LPFeeUpdated
// ---------------------------------------------------------------------------

FPMM.LPFeeUpdated.handler(async ({ event, context }) => {
  const poolId = makePoolId(event.chainId, event.srcAddress);
  const pool = await context.Pool.get(poolId);
  if (!pool) return;

  context.Pool.set({
    ...pool,
    lpFee: Number(event.params.newFee),
    updatedAtBlock: asBigInt(event.block.number),
    updatedAtTimestamp: asBigInt(event.block.timestamp),
  });
});

// ---------------------------------------------------------------------------
// FPMM.ProtocolFeeUpdated
// ---------------------------------------------------------------------------

FPMM.ProtocolFeeUpdated.handler(async ({ event, context }) => {
  const poolId = makePoolId(event.chainId, event.srcAddress);
  const pool = await context.Pool.get(poolId);
  if (!pool) return;

  context.Pool.set({
    ...pool,
    protocolFee: Number(event.params.newFee),
    updatedAtBlock: asBigInt(event.block.number),
    updatedAtTimestamp: asBigInt(event.block.timestamp),
  });
});
