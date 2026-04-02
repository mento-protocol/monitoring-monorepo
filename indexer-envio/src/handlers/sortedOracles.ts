// ---------------------------------------------------------------------------
// SortedOracles event handlers (OracleReported, MedianUpdated, expiry)
// ---------------------------------------------------------------------------

import { SortedOracles, type Pool, type OracleSnapshot } from "generated";
import { eventId, asAddress, asBigInt } from "../helpers";
import { computePriceDifference } from "../priceDifference";
import { computeHealthStatus } from "../pool";
import { recordHealthSample } from "../healthScore";
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
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  // Chain-scoped — getPoolsByFeed filters by chainId to prevent cross-chain
  // oracle bleed (same rateFeedID exists on both Celo and Monad). See rpc.ts.
  const poolIds = await getPoolsByFeed(context, event.chainId, rateFeedID);
  if (poolIds.length === 0) return;

  const oracleTimestamp = event.params.timestamp;

  for (const poolId of poolIds) {
    const existing = await context.Pool.get(poolId);
    if (!existing) continue;

    // Resolve oracleExpiry from DB if already populated, otherwise fetch via RPC
    // (one-time seed — subsequent events use the DB value).
    const oracleExpiry =
      existing.oracleExpiry > 0n
        ? existing.oracleExpiry
        : ((await fetchReportExpiry(event.chainId, rateFeedID, blockNumber)) ??
          existing.oracleExpiry);

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
    const healthStatus = computeHealthStatus(withDev);
    const finalPool = { ...withDev, healthStatus };
    context.Pool.set(finalPool);

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
      source: "oracle_reported",
      blockNumber,
      txHash: event.transaction.hash,
      ...snapshotFields,
    };
    context.OracleSnapshot.set(snapshot);
  }
});

// ---------------------------------------------------------------------------
// SortedOracles.MedianUpdated
// ---------------------------------------------------------------------------

SortedOracles.MedianUpdated.handler(async ({ event, context }) => {
  const rateFeedID = asAddress(event.params.token);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  const poolIds = await getPoolsByFeed(context, event.chainId, rateFeedID);
  if (poolIds.length === 0) return;

  for (const poolId of poolIds) {
    const existing = await context.Pool.get(poolId);
    if (!existing) continue;

    const oracleExpiry =
      existing.oracleExpiry > 0n
        ? existing.oracleExpiry
        : ((await fetchReportExpiry(event.chainId, rateFeedID, blockNumber)) ??
          existing.oracleExpiry);

    const oraclePrice = event.params.value;

    const updatedPool: Pool = {
      ...existing,
      oraclePrice,
      oracleTimestamp: blockTimestamp,
      oracleTxHash: event.transaction.hash,
      oracleOk: true,
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
    const healthStatus = computeHealthStatus(withDev);
    const finalPool = { ...withDev, healthStatus };

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
  }
});

// ---------------------------------------------------------------------------
// SortedOracles.TokenReportExpirySet
// ---------------------------------------------------------------------------

SortedOracles.TokenReportExpirySet.handler(async ({ event, context }) => {
  const rateFeedID = asAddress(event.params.token);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);
  const poolIds = await getPoolsByFeed(context, event.chainId, rateFeedID);
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
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);
  const pools = await getPoolsWithReferenceFeed(context, event.chainId);

  for (const pool of pools) {
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
  }
});
