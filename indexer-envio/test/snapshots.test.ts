import assert from "node:assert/strict";
import type { PoolDailySnapshot } from "envio";
import { describe, it } from "vitest";
import { dailySnapshotId, dayBucket } from "../src/helpers.ts";
import { upsertDailySnapshot } from "../src/pool/snapshots.ts";
import { makePool } from "./helpers/makePool.ts";

describe("upsertDailySnapshot", () => {
  it("repairs stale reserve and cumulative fields without inventing deltas", async () => {
    const timestamp = 1_736_928_000n;
    const pool = makePool({
      id: "42220-0x00000000000000000000000000000000000000aa",
      reserves0: 100n,
      reserves1: 200n,
      swapCount: 7,
      notionalVolume0: 1_000n,
      notionalVolume1: 2_000n,
      healthBinarySeconds: 300n,
      healthTotalSeconds: 600n,
    });
    const id = dailySnapshotId(pool.id, dayBucket(timestamp));
    const existing: PoolDailySnapshot = {
      id,
      chainId: pool.chainId,
      poolId: pool.id,
      timestamp: dayBucket(timestamp),
      reserves0: 1n,
      reserves1: 2n,
      swapCount: 3,
      swapVolume0: 30n,
      swapVolume1: 40n,
      rebalanceCount: 1,
      mintCount: 2,
      burnCount: 3,
      cumulativeSwapCount: 4,
      cumulativeVolume0: 400n,
      cumulativeVolume1: 500n,
      cumulativeHealthBinarySeconds: 10n,
      cumulativeHealthTotalSeconds: 20n,
      blockNumber: 10n,
    };
    const saved: PoolDailySnapshot[] = [];
    const context = {
      PoolDailySnapshot: {
        get: async () => existing,
        set: (entity: PoolDailySnapshot) => saved.push(entity),
      },
    };

    await upsertDailySnapshot({
      context: context as never,
      pool,
      blockTimestamp: timestamp + 3600n,
      blockNumber: 20n,
    });

    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0], {
      ...existing,
      reserves0: pool.reserves0,
      reserves1: pool.reserves1,
      cumulativeSwapCount: pool.swapCount,
      cumulativeVolume0: pool.notionalVolume0,
      cumulativeVolume1: pool.notionalVolume1,
      cumulativeHealthBinarySeconds: pool.healthBinarySeconds,
      cumulativeHealthTotalSeconds: pool.healthTotalSeconds,
      blockNumber: 20n,
    });
  });
});
