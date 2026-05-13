import type { Pool, PoolSnapshot, PoolDailySnapshot } from "envio";
import {
  dayBucket,
  dailySnapshotId,
  hourBucket,
  snapshotId,
} from "../helpers.js";
import type { SnapshotContext } from "./types.js";

// ---------------------------------------------------------------------------
// PoolSnapshot upsert
// ---------------------------------------------------------------------------

export const upsertSnapshot = async ({
  context,
  pool,
  blockTimestamp,
  blockNumber,
  swapDelta,
  rebalanceDelta,
  mintDelta,
  burnDelta,
}: {
  context: SnapshotContext;
  pool: Pool;
  blockTimestamp: bigint;
  blockNumber: bigint;
  swapDelta?: { volume0: bigint; volume1: bigint } | undefined;
  rebalanceDelta?: boolean | undefined;
  mintDelta?: boolean | undefined;
  burnDelta?: boolean | undefined;
}): Promise<void> => {
  const hourTs = hourBucket(blockTimestamp);
  const id = snapshotId(pool.id, hourTs);
  const existing = await context.PoolSnapshot.get(id);

  const snapshot: PoolSnapshot = existing
    ? {
        ...existing,
        reserves0: pool.reserves0,
        reserves1: pool.reserves1,
        swapCount: existing.swapCount + (swapDelta ? 1 : 0),
        swapVolume0: existing.swapVolume0 + (swapDelta?.volume0 ?? 0n),
        swapVolume1: existing.swapVolume1 + (swapDelta?.volume1 ?? 0n),
        rebalanceCount: existing.rebalanceCount + (rebalanceDelta ? 1 : 0),
        mintCount: existing.mintCount + (mintDelta ? 1 : 0),
        burnCount: existing.burnCount + (burnDelta ? 1 : 0),
        cumulativeSwapCount: pool.swapCount,
        cumulativeVolume0: pool.notionalVolume0,
        cumulativeVolume1: pool.notionalVolume1,
        blockNumber,
      }
    : {
        id,
        chainId: pool.chainId,
        poolId: pool.id,
        timestamp: hourTs,
        reserves0: pool.reserves0,
        reserves1: pool.reserves1,
        swapCount: swapDelta ? 1 : 0,
        swapVolume0: swapDelta?.volume0 ?? 0n,
        swapVolume1: swapDelta?.volume1 ?? 0n,
        rebalanceCount: rebalanceDelta ? 1 : 0,
        mintCount: mintDelta ? 1 : 0,
        burnCount: burnDelta ? 1 : 0,
        cumulativeSwapCount: pool.swapCount,
        cumulativeVolume0: pool.notionalVolume0,
        cumulativeVolume1: pool.notionalVolume1,
        blockNumber,
      };

  context.PoolSnapshot.set(snapshot);

  // Also write the day-bucketed rollup. Callers never need to invoke this
  // directly — handlers call upsertSnapshot, both entities get updated.
  await upsertDailySnapshot({
    context,
    pool,
    blockTimestamp,
    blockNumber,
    swapDelta,
    rebalanceDelta,
    mintDelta,
    burnDelta,
  });
};

// ---------------------------------------------------------------------------
// PoolDailySnapshot upsert — same read-merge-write pattern as upsertSnapshot,
// but bucketed per UTC day. Lets full-history pool charts fit in a single
// Hasura page (Envio's hosted endpoint caps every query at 1000 rows).
// Invoked from upsertSnapshot; exported so tests can exercise it directly.
// ---------------------------------------------------------------------------

export const upsertDailySnapshot = async ({
  context,
  pool,
  blockTimestamp,
  blockNumber,
  swapDelta,
  rebalanceDelta,
  mintDelta,
  burnDelta,
}: {
  context: SnapshotContext;
  pool: Pool;
  blockTimestamp: bigint;
  blockNumber: bigint;
  swapDelta?: { volume0: bigint; volume1: bigint } | undefined;
  rebalanceDelta?: boolean | undefined;
  mintDelta?: boolean | undefined;
  burnDelta?: boolean | undefined;
}): Promise<void> => {
  const dayTs = dayBucket(blockTimestamp);
  const id = dailySnapshotId(pool.id, dayTs);
  const existing = await context.PoolDailySnapshot.get(id);

  const snapshot: PoolDailySnapshot = existing
    ? {
        ...existing,
        reserves0: pool.reserves0,
        reserves1: pool.reserves1,
        swapCount: existing.swapCount + (swapDelta ? 1 : 0),
        swapVolume0: existing.swapVolume0 + (swapDelta?.volume0 ?? 0n),
        swapVolume1: existing.swapVolume1 + (swapDelta?.volume1 ?? 0n),
        rebalanceCount: existing.rebalanceCount + (rebalanceDelta ? 1 : 0),
        mintCount: existing.mintCount + (mintDelta ? 1 : 0),
        burnCount: existing.burnCount + (burnDelta ? 1 : 0),
        cumulativeSwapCount: pool.swapCount,
        cumulativeVolume0: pool.notionalVolume0,
        cumulativeVolume1: pool.notionalVolume1,
        cumulativeHealthBinarySeconds: pool.healthBinarySeconds,
        cumulativeHealthTotalSeconds: pool.healthTotalSeconds,
        blockNumber,
      }
    : {
        id,
        chainId: pool.chainId,
        poolId: pool.id,
        timestamp: dayTs,
        reserves0: pool.reserves0,
        reserves1: pool.reserves1,
        swapCount: swapDelta ? 1 : 0,
        swapVolume0: swapDelta?.volume0 ?? 0n,
        swapVolume1: swapDelta?.volume1 ?? 0n,
        rebalanceCount: rebalanceDelta ? 1 : 0,
        mintCount: mintDelta ? 1 : 0,
        burnCount: burnDelta ? 1 : 0,
        cumulativeSwapCount: pool.swapCount,
        cumulativeVolume0: pool.notionalVolume0,
        cumulativeVolume1: pool.notionalVolume1,
        cumulativeHealthBinarySeconds: pool.healthBinarySeconds,
        cumulativeHealthTotalSeconds: pool.healthTotalSeconds,
        blockNumber,
      };

  context.PoolDailySnapshot.set(snapshot);
};
