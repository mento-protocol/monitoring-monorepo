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
} from "../pool";
import { recordBreachTransition } from "../deviationBreach";
import { recordHealthSample } from "../healthScore";
import { computeOracleJumpBps } from "../oracleJump";
import {
  fetchReportExpiry,
  getPoolsByFeed,
  updatePoolsOracleExpiry,
  getPoolsWithReferenceFeed,
} from "../rpc";

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
          : ((await fetchReportExpiry(
              event.chainId,
              rateFeedID,
              blockNumber,
            )) ?? existing.oracleExpiry);

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
      context.Pool.set({ ...finalPool, ...poolUpdate, ...breachPoolUpdate });

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
    }),
  );
});

// ---------------------------------------------------------------------------
// SortedOracles.MedianUpdated
// ---------------------------------------------------------------------------

SortedOracles.MedianUpdated.handler(async ({ event, context }) => {
  const rateFeedID = asAddress(event.params.token);

  const poolIds = await getPoolsByFeed(context, event.chainId, rateFeedID);
  if (poolIds.length === 0) return;

  // See OracleReported handler.
  if (await maybePreloadPool(context, poolIds)) return;
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  // See OracleReported handler — parallel fan-out across distinct pools.
  await Promise.all(
    poolIds.map(async (poolId) => {
      const existing = await context.Pool.get(poolId);
      if (!existing) return;

      const oracleExpiry =
        existing.oracleExpiry > 0n
          ? existing.oracleExpiry
          : ((await fetchReportExpiry(
              event.chainId,
              rateFeedID,
              blockNumber,
            )) ?? existing.oracleExpiry);

      const oraclePrice = event.params.value;

      // Median-to-median jump: `existing.lastMedianPrice` is the previous
      // `MedianUpdated.value` (not `existing.oraclePrice`, which gets
      // overwritten by OracleReported with per-reporter values between
      // medians). Null means no prior median to compare against, or the new
      // median is 0 (transient oracle outage — leave the jump fields
      // untouched rather than record a spurious 100%-down crash).
      const jumpBps = computeOracleJumpBps(
        existing.lastMedianPrice,
        oraclePrice,
      );
      const lastOracleJumpBps = jumpBps ?? existing.lastOracleJumpBps;
      const lastOracleJumpAt =
        jumpBps !== null ? blockTimestamp : existing.lastOracleJumpAt;
      const lastMedianPrice =
        oraclePrice > 0n ? oraclePrice : existing.lastMedianPrice;

      const updatedPool: Pool = {
        ...existing,
        oraclePrice,
        oracleTimestamp: blockTimestamp,
        oracleTxHash: event.transaction.hash,
        oracleOk: true,
        oracleExpiry,
        oracleNumReporters: existing.oracleNumReporters,
        lastMedianPrice,
        lastOracleJumpBps,
        lastOracleJumpAt,
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
      context.Pool.set({
        ...finalPool,
        ...poolUpdate,
        ...breachPoolUpdate,
      });

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
    }),
  );
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
  const oracleExpiry = await fetchReportExpiry(
    event.chainId,
    rateFeedID,
    blockNumber,
  );

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
      const oracleExpiry = await fetchReportExpiry(
        event.chainId,
        pool.referenceRateFeedID,
        blockNumber,
      );
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
