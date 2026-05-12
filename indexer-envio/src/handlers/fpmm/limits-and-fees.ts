// ---------------------------------------------------------------------------
// FPMM limits and fees handlers: TradingLimitConfigured + LiquidityStrategyUpdated
// + LPFeeUpdated + ProtocolFeeUpdated + RebalanceIncentiveUpdated
// + RebalanceThresholdUpdated
// ---------------------------------------------------------------------------

import {
  indexer,
  type OracleSnapshot,
  type Pool,
  type TradingLimit,
} from "envio";
import { asAddress, asBigInt, eventId, makePoolId } from "../../helpers.js";
import {
  TRADING_LIMITS_INTERNAL_DECIMALS,
  computeLimitPressures,
  computeLimitStatus,
} from "../../tradingLimits.js";
import {
  rebalancingStateEffect,
  tradingLimitsEffect,
} from "../../rpc/effects.js";
import {
  computeHealthStatus,
  effectiveThreshold,
  isNeverRebalance,
  persistableThreshold,
  maybePreloadPool,
  selfHealInvertRateFeed,
  selfHealTokenDecimals,
  upsertPool,
  upsertSnapshot,
} from "../../pool.js";
import {
  computePriceDifference,
  pickActiveThreshold,
} from "../../priceDifference.js";
import { recordHealthSample } from "../../healthScore.js";

// ---------------------------------------------------------------------------
// FPMM.TradingLimitConfigured
// ---------------------------------------------------------------------------

indexer.onEvent(
  { contract: "FPMM", event: "TradingLimitConfigured" },
  async ({ event, context }) => {
    const poolId = makePoolId(event.chainId, event.srcAddress);
    // See state-sync.ts → UpdateReserves handler. `fetchTradingLimits` is a raw
    // RPC call that must not run in preload for the same in-batch-state reasons.
    if (await maybePreloadPool(context, poolId)) return;
    const token = asAddress(event.params.token);
    const blockNumber = asBigInt(event.block.number);
    const blockTimestamp = asBigInt(event.block.timestamp);

    const eventLimit0 = event.params.config.limit0;
    const eventLimit1 = event.params.config.limit1;

    const limits = await context.effect(tradingLimitsEffect, {
      chainId: event.chainId,
      poolAddress: event.srcAddress,
      token: event.params.token,
      blockNumber,
    });

    const limit0 = limits ? limits.config.limit0 : eventLimit0;
    const limit1 = limits ? limits.config.limit1 : eventLimit1;
    const decimals = TRADING_LIMITS_INTERNAL_DECIMALS;
    const netflow0 = limits ? limits.state.netflow0 : 0n;
    const netflow1 = limits ? limits.state.netflow1 : 0n;
    const lastUpdated0 = limits ? BigInt(limits.state.lastUpdated0) : 0n;
    const lastUpdated1 = limits ? BigInt(limits.state.lastUpdated1) : 0n;

    const { p0, p1 } = computeLimitPressures(
      netflow0,
      netflow1,
      limit0,
      limit1,
    );
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
  },
);

// ---------------------------------------------------------------------------
// FPMM.LiquidityStrategyUpdated
// ---------------------------------------------------------------------------

indexer.onEvent(
  { contract: "FPMM", event: "LiquidityStrategyUpdated" },
  async ({ event, context }) => {
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
  },
);

// ---------------------------------------------------------------------------
// Fee / incentive updates — three handlers share the same read-modify-write
// shape against a single Pool field, so the body lives in this helper and
// each handler is a one-liner that picks the target field + param name.
// ---------------------------------------------------------------------------

type FeeFieldKey = "lpFee" | "protocolFee" | "rebalanceReward";

async function updatePoolFeeField(
  context: {
    Pool: {
      get: (id: string) => Promise<Pool | undefined>;
      set: (entity: Pool) => void;
    };
  },
  event: {
    chainId: number;
    srcAddress: string;
    block: { number: number; timestamp: number };
  },
  field: FeeFieldKey,
  newValue: bigint,
): Promise<void> {
  const poolId = makePoolId(event.chainId, event.srcAddress);
  const pool = await context.Pool.get(poolId);
  if (!pool) return;
  context.Pool.set({
    ...pool,
    [field]: Number(newValue),
    updatedAtBlock: asBigInt(event.block.number),
    updatedAtTimestamp: asBigInt(event.block.timestamp),
  });
}

indexer.onEvent(
  { contract: "FPMM", event: "LPFeeUpdated" },
  async ({ event, context }) =>
    updatePoolFeeField(context, event, "lpFee", event.params.newFee),
);

indexer.onEvent(
  { contract: "FPMM", event: "ProtocolFeeUpdated" },
  async ({ event, context }) =>
    updatePoolFeeField(context, event, "protocolFee", event.params.newFee),
);

indexer.onEvent(
  { contract: "FPMM", event: "RebalanceIncentiveUpdated" },
  async ({ event, context }) =>
    updatePoolFeeField(
      context,
      event,
      "rebalanceReward",
      event.params.newIncentive,
    ),
);

// ---------------------------------------------------------------------------
// FPMM.RebalanceThresholdUpdated
// ---------------------------------------------------------------------------

// A governance threshold change can by itself open or close a breach
// (e.g. tightening from 300 to 100 makes a previously-healthy pool
// breached). Route through `upsertPool` so this event runs the same
// breach/health pipeline that state-sync handlers do — including
// `currentOpenBreachPeak` / `currentOpenBreachEntryThreshold` denorm
// maintenance, `selfHealInvertRateFeed` for the direction calc, and
// the `DeviationThresholdBreach` history row write. Then call
// `upsertSnapshot` to refresh the daily rollup, mirroring the oracle
// handlers — without it, threshold-only health transitions on a quiet
// pool can leave `PoolDailySnapshot.cumulativeHealth*` stale until the
// next reserve / oracle event.
indexer.onEvent(
  { contract: "FPMM", event: "RebalanceThresholdUpdated" },
  async ({ event, context }) => {
    const poolId = makePoolId(event.chainId, event.srcAddress);
    // Same preload-bail rationale as state-sync handlers: with v3 preload
    // optimization we'd otherwise run `recordBreachTransition`
    // (inside `upsertPool`) twice per event.
    if (await maybePreloadPool(context, poolId)) return;
    const initial = await context.Pool.get(poolId);
    if (!initial) return;
    const blockNumber = asBigInt(event.block.number);
    const blockTimestamp = asBigInt(event.block.timestamp);
    // Self-heal invertRateFeed + tokenDecimals before pickActiveThreshold +
    // computePriceDifference read them. Without invert healing, an inverted
    // pool whose deploy-time invert read failed and which gets a threshold
    // update before any state-sync event would persist the wrong-side active
    // threshold; without decimals healing, a non-18-decimal pool whose
    // deploy-time decimals read failed would compute `priceDifferenceFromMedian`
    // off the wrong reserve scale, leaving a stale-by-magnitude breach state.
    const existing = await selfHealTokenDecimals(
      context,
      await selfHealInvertRateFeed(context, initial),
    );
    const above = Number(event.params.newThresholdAbove);
    const below = Number(event.params.newThresholdBelow);
    // Gate the breach/health recompute on a fresh live median AND
    // non-degenerate reserves: the direction-pick + priceDifference both
    // depend on `lastMedianPrice` AND `norm1/norm0`, so without a usable
    // median the recompute would pass through a stale/expired median, and
    // without usable reserves `pickActiveThreshold` would fall back to
    // `above` (degenerate-reserve path) and `computePriceDifference` would
    // return `0n`. Same gates the entity-derive path uses, applied here so
    // a governance threshold update doesn't open/close breaches from
    // oracle/reserve data the contract would reject.
    const medianFresh =
      existing.lastMedianPrice > 0n &&
      existing.medianLive &&
      existing.invertRateFeedKnown &&
      // `tokenDecimalsKnown` gate — without real decimals, the local-median
      // path would compute `priceDifferenceFromMedian` via `normalizeTo18`
      // against the schema-default 18/18 and produce a result off by
      // `10^(18 - real_dec)`. Falls through to RPC, which is the right
      // safe-by-construction fallback (contract `getRebalancingState`
      // returns the real value).
      existing.tokenDecimalsKnown &&
      existing.oracleOk &&
      existing.oracleExpiry > 0n &&
      existing.lastOracleReportAt > 0n &&
      existing.lastOracleReportAt + existing.oracleExpiry > blockTimestamp &&
      existing.reserves0 > 0n &&
      existing.reserves1 > 0n;

    // Resolve the threshold-event's recompute inputs, preferring local
    // median when fresh (cheap, no RPC) and falling back to the contract's
    // `getRebalancingState` otherwise (covers quiet pools where local
    // median anchors stale even though the contract's median is fresh —
    // codex M1). `null` means neither path could produce a usable
    // priceDifference; the handler then writes only the threshold split
    // fields and preserves existing breach/health state.
    let priceDifferenceFromMedian: bigint | null = null;
    let active: number | null = null;
    if (medianFresh) {
      // Synthetic pool view using `lastMedianPrice` (clean median) for both
      // direction-pick AND priceDifference. Without this, upsertPool's
      // breach/health recompute would derive priceDifference from the
      // reporter-tainted `oraclePrice` (set by OracleReported).
      const medianView = {
        reserves0: existing.reserves0,
        reserves1: existing.reserves1,
        oraclePrice: existing.lastMedianPrice,
        invertRateFeed: existing.invertRateFeed,
        token0Decimals: existing.token0Decimals,
        token1Decimals: existing.token1Decimals,
      };
      active = pickActiveThreshold(medianView, { above, below });
      priceDifferenceFromMedian = computePriceDifference(medianView);
    } else {
      // Local median not usable — try the contract's authoritative state.
      // Threshold updates are rare governance events so the extra RPC is
      // acceptable. The contract's `getRebalancingState` returns the
      // direction-correct active threshold + priceDifference at this block.
      const rpc = await context.effect(rebalancingStateEffect, {
        chainId: event.chainId,
        poolAddress: asAddress(event.srcAddress),
        blockNumber,
      });
      if (rpc) {
        priceDifferenceFromMedian = rpc.priceDifference;
        active = rpc.rebalanceThreshold;
      }
    }
    // RPC fallback succeeded ⇒ contract had a live oracle at this block.
    // If the local pool row still has `oracleOk=false` from deploy-time
    // RPC misses or a prior stale state, lift it now so the upsertPool
    // health/breach pipeline + the post-upsert `oracleOk` gate see the
    // correct live-oracle status.
    const rpcSucceeded = !medianFresh && priceDifferenceFromMedian !== null;

    let upserted: Pool;
    if (priceDifferenceFromMedian === null || active === null) {
      // Neither local median nor RPC produced usable values.
      //
      // Known-zero (above == 0 && below == 0 == "never rebalance"): route
      // through `upsertPool` so `recordBreachTransition` closes any open
      // `DeviationThresholdBreach` row AND `computeHealthStatus` refreshes
      // `Pool.healthStatus` (avoids a stale CRITICAL gauge on the
      // `metrics-bridge` export). `isNeverRebalance(next)` short-circuits
      // both predicates to false / OK respectively, so the falling-edge
      // logic kicks in naturally. Falls through to the health-sample +
      // upsertSnapshot block below so the disable transition gets recorded
      // at this block's timestamp instead of waiting for the next oracle
      // event (uptime accrual would otherwise lag — codex round-4 P2).
      //
      // Non-known-zero: preserve existing breach/health state — direct
      // write just the threshold split fields + Known flag so derive can
      // succeed once a live median lands.
      const isKnownZero = above === 0 && below === 0;
      if (!isKnownZero) {
        context.Pool.set({
          ...existing,
          rebalanceThresholdAbove: above,
          rebalanceThresholdBelow: below,
          rebalanceThresholdsKnown: true,
          updatedAtBlock: blockNumber,
          updatedAtTimestamp: blockTimestamp,
        });
        return;
      }
      upserted = await upsertPool({
        context,
        chainId: event.chainId,
        poolId,
        source: "fpmm_threshold_updated",
        blockNumber,
        blockTimestamp,
        txHash: event.transaction.hash,
        oracleDelta: {
          rebalanceThreshold: 0,
          rebalanceThresholdAbove: 0,
          rebalanceThresholdBelow: 0,
          rebalanceThresholdsKnown: true,
        },
        existing: { pool: existing },
      });
    } else {
      upserted = await upsertPool({
        context,
        chainId: event.chainId,
        poolId,
        source: "fpmm_threshold_updated",
        blockNumber,
        blockTimestamp,
        txHash: event.transaction.hash,
        oracleDelta: {
          rebalanceThresholdAbove: above,
          rebalanceThresholdBelow: below,
          rebalanceThreshold: active,
          rebalanceThresholdsKnown: true,
          priceDifference: priceDifferenceFromMedian,
          ...(rpcSucceeded ? { oracleOk: true } : {}),
        },
        existing: { pool: existing },
      });
    }
    // Advance the health-time accumulators. Gate on `oracleOk` only:
    // `hasHealthData` would skip pools whose previous threshold was 0 and
    // therefore never accrued health. A governance change to a positive
    // threshold is exactly the moment health tracking should start —
    // dropping the gate lets `recordHealthSample` initialize the cursor.
    //
    // Write an `OracleSnapshot` row for the cursor-advance so the chart
    // history has an explicit entry at this block. Without it, the next
    // OracleReported/MedianUpdated snapshot's covered-interval would
    // appear to start from a phantom cursor advance and the chart-side
    // gap-detection would mis-attribute a discontinuity.
    let pool = upserted;
    if (upserted.oracleOk) {
      const { snapshotFields, poolUpdate } = recordHealthSample(
        upserted,
        upserted.priceDifference,
        Number(effectiveThreshold(upserted)),
        blockTimestamp,
        isNeverRebalance(upserted),
      );
      // Recompute `healthStatus` after the merge: `recordHealthSample` may
      // have flipped `hasHealthData: false → true`, and `upsertted`'s earlier
      // healthStatus was computed against the OLD value (codex P2 PR #370
      // #3214748736).
      const merged = { ...upserted, ...poolUpdate };
      pool = {
        ...merged,
        healthStatus: computeHealthStatus(merged, blockTimestamp),
      };
      context.Pool.set(pool);

      // Only write the OracleSnapshot row when we used the local median
      // (`medianFresh` path). On the RPC-fallback path `pool.lastMedianPrice`
      // may be 0 / stale, so the row would mix a fresh deviation with an
      // unrelated displayed oracle price.
      if (medianFresh) {
        const snapshot: OracleSnapshot = {
          id: eventId(event.chainId, event.block.number, event.logIndex),
          chainId: event.chainId,
          poolId,
          timestamp: blockTimestamp,
          // Use `lastMedianPrice` so the snapshot's displayed oracle price
          // is consistent with the priceDifference / threshold fields,
          // which were both computed from the median above.
          oraclePrice: pool.lastMedianPrice,
          oracleOk: pool.oracleOk,
          numReporters: pool.oracleNumReporters,
          priceDifference: pool.priceDifference,
          // See sortedOracles.OracleReported — `persistableThreshold` gates the
          // 1e12 never-rebalance sentinel out of this `Int!`-typed write.
          rebalanceThreshold: persistableThreshold(pool),
          source: "threshold_updated",
          blockNumber,
          txHash: event.transaction.hash,
          ...snapshotFields,
        };
        context.OracleSnapshot.set(snapshot);
      }
    }
    await upsertSnapshot({
      context,
      pool,
      blockTimestamp,
      blockNumber,
    });
  },
);
