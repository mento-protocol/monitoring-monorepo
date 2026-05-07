// ---------------------------------------------------------------------------
// SortedOracles event handlers (OracleReported, MedianUpdated, expiry)
// ---------------------------------------------------------------------------

import { SortedOracles, type Pool, type OracleSnapshot } from "generated";
import { eventId, asAddress, asBigInt } from "../helpers";
import { computePriceDifference } from "../priceDifference";
import {
  computeHealthStatus,
  maybePreloadPool,
  nextDeviationBreachStartedAt,
  upsertDailySnapshot,
} from "../pool";
import { recordBreachTransition } from "../deviationBreach";
import { recordHealthSample } from "../healthScore";
import { computeMedianLineageNext } from "../oracleJump";
import {
  getPoolsByFeed,
  updatePoolsOracleExpiry,
  getPoolsWithReferenceFeed,
  getBreakerConfigsByFeed,
} from "../rpc";
import { reportExpiryEffect } from "../rpc/effects";
import { bootstrapFeedBreakerConfigs, nextMedianEMA } from "../breakers";

// ---------------------------------------------------------------------------
// SortedOracles.OracleReported
// ---------------------------------------------------------------------------

SortedOracles.OracleReported.handler(async ({ event, context }) => {
  const rateFeedID = asAddress(event.params.token);

  // Chain-scoped — getPoolsByFeed filters by chainId to prevent cross-chain
  // oracle bleed (same rateFeedID exists on both Celo and Monad). See rpc.ts.
  const poolIds = await getPoolsByFeed(context, event.chainId, rateFeedID);
  if (poolIds.length === 0) return;

  // Preload phase: seed Pool + open-breach-row lookups so Envio can
  // batch them, then bail. Processing phase runs RPC + writes with
  // consistent in-batch state. See `maybePreloadPool` in pool.ts.
  if (await maybePreloadPool(context, poolIds)) return;
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  const oracleTimestamp = event.params.timestamp;

  // Each poolId is distinct (getPoolsByFeed returns unique rows) so pool
  // writes don't race. Fan out in parallel — on a rate feed shared by 5-10
  // pools this collapses N sequential awaits into 1 concurrent batch.
  await Promise.all(
    poolIds.map(async (poolId) => {
      const existing = await context.Pool.get(poolId);
      if (!existing) return;

      // Resolve oracleExpiry from DB if already populated, otherwise fetch
      // via RPC (one-time seed — subsequent events use the DB value).
      const oracleExpiry =
        existing.oracleExpiry > 0n
          ? existing.oracleExpiry
          : ((await context.effect(reportExpiryEffect, {
              chainId: event.chainId,
              rateFeedID,
              blockNumber,
            })) ?? existing.oracleExpiry);

      const oraclePrice = event.params.value;

      const updatedPool: Pool = {
        ...existing,
        oracleTimestamp,
        oracleTxHash: event.transaction.hash,
        oracleOk: true,
        oraclePrice,
        oracleExpiry,
        oracleNumReporters: existing.oracleNumReporters,
        updatedAtBlock: blockNumber,
        updatedAtTimestamp: blockTimestamp,
      };
      const priceDifference =
        !updatedPool.source?.includes("virtual") && oraclePrice > 0n
          ? computePriceDifference(updatedPool)
          : updatedPool.priceDifference;
      const withDev = { ...updatedPool, priceDifference };
      const deviationBreachStartedAt = nextDeviationBreachStartedAt(
        existing,
        withDev,
        blockTimestamp,
      );
      const withBreach = { ...withDev, deviationBreachStartedAt };
      const healthStatus = computeHealthStatus(withBreach, blockTimestamp);
      const finalPool = { ...withBreach, healthStatus };

      const breachPoolUpdate = await recordBreachTransition(
        context,
        existing,
        finalPool,
        {
          blockTimestamp,
          blockNumber,
          txHash: event.transaction.hash,
          source: "oracle_reported",
        },
      );

      // Health score: compute snapshot fields + update pool accumulators
      const { snapshotFields, poolUpdate } = recordHealthSample(
        finalPool,
        priceDifference,
        existing.rebalanceThreshold,
        blockTimestamp,
      );
      const persistedPool: Pool = {
        ...finalPool,
        ...poolUpdate,
        ...breachPoolUpdate,
      };
      context.Pool.set(persistedPool);

      const snapshot: OracleSnapshot = {
        id:
          eventId(event.chainId, event.block.number, event.logIndex) +
          `-${poolId}`,
        chainId: event.chainId,
        poolId,
        timestamp: blockTimestamp,
        oraclePrice,
        oracleOk: true,
        numReporters: existing.oracleNumReporters,
        priceDifference,
        rebalanceThreshold: existing.rebalanceThreshold,
        source: "oracle_reported",
        blockNumber,
        txHash: event.transaction.hash,
        ...snapshotFields,
      };
      context.OracleSnapshot.set(snapshot);

      // Refresh the daily snapshot's frozen health counters even though no
      // pool-side activity (swap/rebalance/mint/burn/UR) fired. Without
      // this, a quiet pool whose only updates are oracle reports has no
      // PoolDailySnapshot rows after the last activity event, and the 7d
      // tile's "latest row <= sevenDaysAgo" anchor silently broadens past
      // 7 days instead of degrading to "—".
      await upsertDailySnapshot({
        context,
        pool: persistedPool,
        blockTimestamp,
        blockNumber,
      });
    }),
  );
});

// ---------------------------------------------------------------------------
// SortedOracles.MedianUpdated
// ---------------------------------------------------------------------------

SortedOracles.MedianUpdated.handler(async ({ event, context }) => {
  const rateFeedID = asAddress(event.params.token);
  const oraclePrice = event.params.value;

  // Two parallel concerns share this event: pool-side oracle/breach state
  // (existing) and breaker-side EMA / lastMedianRate mirror (new). Look up
  // both up front so neither's emptiness suppresses the other, and so a
  // single preload-phase pass warms both entity caches.
  const [poolIds, breakerConfigs] = await Promise.all([
    getPoolsByFeed(context, event.chainId, rateFeedID),
    getBreakerConfigsByFeed(context, event.chainId, rateFeedID),
  ]);

  if (poolIds.length === 0 && breakerConfigs.length === 0) return;

  // Preload phase: warm pool + breaker entities, no writes. Mirrors
  // `maybePreloadPool` semantics — return without proceeding to writes.
  if (context.isPreload) {
    await Promise.all([
      maybePreloadPool(context, poolIds),
      ...breakerConfigs.map(async (cfg) => {
        await context.Breaker.get(cfg.breaker_id);
      }),
    ]);
    return;
  }

  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  // ----- Pool fan-out (existing logic, unchanged) -----------------------
  // See OracleReported handler — parallel fan-out across distinct pools.
  await Promise.all(
    poolIds.map(async (poolId) => {
      const existing = await context.Pool.get(poolId);
      if (!existing) return;

      const oracleExpiry =
        existing.oracleExpiry > 0n
          ? existing.oracleExpiry
          : ((await context.effect(reportExpiryEffect, {
              chainId: event.chainId,
              rateFeedID,
              blockNumber,
            })) ?? existing.oracleExpiry);

      const lineage = computeMedianLineageNext(
        existing,
        oraclePrice,
        blockTimestamp,
      );

      const updatedPool: Pool = {
        ...existing,
        oraclePrice,
        oracleTimestamp: blockTimestamp,
        oracleTxHash: event.transaction.hash,
        oracleOk: true,
        oracleExpiry,
        oracleNumReporters: existing.oracleNumReporters,
        ...lineage,
        updatedAtBlock: blockNumber,
        updatedAtTimestamp: blockTimestamp,
      };
      const priceDifference =
        !updatedPool.source?.includes("virtual") && oraclePrice > 0n
          ? computePriceDifference(updatedPool)
          : updatedPool.priceDifference;
      const withDev = { ...updatedPool, priceDifference };
      const deviationBreachStartedAt = nextDeviationBreachStartedAt(
        existing,
        withDev,
        blockTimestamp,
      );
      const withBreach = { ...withDev, deviationBreachStartedAt };
      const healthStatus = computeHealthStatus(withBreach, blockTimestamp);
      const finalPool = { ...withBreach, healthStatus };

      const breachPoolUpdate = await recordBreachTransition(
        context,
        existing,
        finalPool,
        {
          blockTimestamp,
          blockNumber,
          txHash: event.transaction.hash,
          source: "median_updated",
        },
      );

      // Health score: compute snapshot fields + update pool accumulators
      const { snapshotFields, poolUpdate } = recordHealthSample(
        finalPool,
        priceDifference,
        existing.rebalanceThreshold,
        blockTimestamp,
      );
      const persistedPool: Pool = {
        ...finalPool,
        ...poolUpdate,
        ...breachPoolUpdate,
      };
      context.Pool.set(persistedPool);

      const snapshot: OracleSnapshot = {
        id:
          eventId(event.chainId, event.block.number, event.logIndex) +
          `-${poolId}`,
        chainId: event.chainId,
        poolId,
        timestamp: blockTimestamp,
        oraclePrice,
        oracleOk: true,
        numReporters: existing.oracleNumReporters,
        priceDifference,
        rebalanceThreshold: existing.rebalanceThreshold,
        source: "oracle_median_updated",
        blockNumber,
        txHash: event.transaction.hash,
        ...snapshotFields,
      };
      context.OracleSnapshot.set(snapshot);

      // Refresh the daily snapshot's frozen health counters even when no
      // pool-side activity fires — see the OracleReported handler for why.
      await upsertDailySnapshot({
        context,
        pool: persistedPool,
        blockTimestamp,
        blockNumber,
      });
    }),
  );

  // ----- Breaker EMA + lastMedianRate mirror ----------------------------
  // BreakerBox._checkAndSetBreakers fires from SortedOracles only on median
  // change (this event), so this is the correct hook for EMA mutation —
  // not OracleReported, which fires per-reporter without recomputing EMA.
  // Skip configs that are not enabled (the contract skips them too — see
  // BreakerBox.sol:336-342). For each MedianDelta config, compute the new
  // EMA per the contract's Fixidity formula. ValueDelta keeps the same
  // referenceValue but still gets `lastMedianRate` / `lastUpdatedAt`.
  //
  // We DO mirror zero medians (oracle outage / all reports expired). The
  // dashboard's `computeLiveDelta` treats `lastMedianRate === 0` as "no
  // valid data" and renders the missing-data dash; if we skipped the mirror
  // here, the panel would keep showing the pre-outage value as if it were
  // still live, misleading reset-path triage. The contract itself does not
  // recompute EMA on zero medians (BreakerBox.sol:336-342 only fires on
  // non-zero), so we skip the EMA branch but still write the zero into
  // `lastMedianRate` + bump `lastUpdatedAt`.
  {
    let configsForMirror = breakerConfigs;
    // Eager bootstrap: for v3 feeds whose breaker config was set entirely
    // before our `start_block`, no later event triggers lazy hydration. On
    // the first MedianUpdated for a feed with zero rows AND at least one
    // indexed pool referencing it, enumerate BreakerBox.getBreakers() and
    // seed the configs. The bootstrap is in-memory-cached per feed so the
    // cost is paid exactly once.
    if (configsForMirror.length === 0 && poolIds.length > 0) {
      await bootstrapFeedBreakerConfigs(
        context,
        event.chainId,
        rateFeedID,
        blockNumber,
        blockTimestamp,
      );
      configsForMirror = await getBreakerConfigsByFeed(
        context,
        event.chainId,
        rateFeedID,
      );
    }
    if (configsForMirror.length > 0) {
      await Promise.all(
        configsForMirror.map(async (cfg) => {
          if (!cfg.enabled) return;
          const breaker = await context.Breaker.get(cfg.breaker_id);
          if (!breaker) return;
          // EMA only recomputes on a positive median (the contract skips
          // zero medians too — BreakerBox.sol:336-342). On a zero median,
          // preserve the existing EMA but still mirror the zero into
          // `lastMedianRate` so the panel renders the missing-data dash.
          const nextEMA =
            breaker.kind === "MEDIAN_DELTA" && oraclePrice > 0n
              ? nextMedianEMA(
                  oraclePrice,
                  cfg.medianRatesEMA ?? 0n,
                  cfg.smoothingFactor ?? 0n,
                )
              : cfg.medianRatesEMA;
          // Skip the write only when ALL three fields would be unchanged — same
          // median, same EMA, AND same `lastUpdatedAt`. Distinct MedianUpdated
          // events always carry distinct block timestamps, so the optimization
          // here only kicks in for same-block event replay during preload. We
          // must include `lastUpdatedAt` in the comparison so that a repeated
          // median value (oracle reports that round to the same rate) still
          // refreshes the "last seen" timestamp.
          if (
            cfg.lastMedianRate === oraclePrice &&
            cfg.medianRatesEMA === nextEMA &&
            cfg.lastUpdatedAt === blockTimestamp
          ) {
            return;
          }
          context.BreakerConfig.set({
            ...cfg,
            lastMedianRate: oraclePrice,
            lastUpdatedAt: blockTimestamp,
            medianRatesEMA: nextEMA,
          });
        }),
      );
    }
  }
});

// ---------------------------------------------------------------------------
// SortedOracles.TokenReportExpirySet
// ---------------------------------------------------------------------------

SortedOracles.TokenReportExpirySet.handler(async ({ event, context }) => {
  const rateFeedID = asAddress(event.params.token);
  const poolIds = await getPoolsByFeed(context, event.chainId, rateFeedID);
  // See OracleReported handler.
  if (await maybePreloadPool(context, poolIds)) return;
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);
  const oracleExpiry = await context.effect(reportExpiryEffect, {
    chainId: event.chainId,
    rateFeedID,
    blockNumber,
  });

  await updatePoolsOracleExpiry(
    context,
    poolIds,
    oracleExpiry,
    blockNumber,
    blockTimestamp,
  );
});

// ---------------------------------------------------------------------------
// SortedOracles.ReportExpirySet
// ---------------------------------------------------------------------------

SortedOracles.ReportExpirySet.handler(async ({ event, context }) => {
  const pools = await getPoolsWithReferenceFeed(context, event.chainId);
  // See OracleReported handler.
  if (
    await maybePreloadPool(
      context,
      pools.map((p) => p.id),
    )
  )
    return;
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  await Promise.all(
    pools.map(async (pool) => {
      const oracleExpiry = await context.effect(reportExpiryEffect, {
        chainId: event.chainId,
        rateFeedID: pool.referenceRateFeedID,
        blockNumber,
      });
      await updatePoolsOracleExpiry(
        context,
        [pool.id],
        oracleExpiry,
        blockNumber,
        blockTimestamp,
      );
    }),
  );
});
