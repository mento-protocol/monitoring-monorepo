/// <reference types="mocha" />
import { assert } from "chai";
import generated from "generated";
import {
  _setMockReserves,
  _clearMockReserves,
  _clearMockERC20Decimals,
} from "../src/EventHandlers.ts";
import {
  makePoolId,
  dailySnapshotId,
  snapshotId,
  dayBucket,
  hourBucket,
} from "../src/helpers.ts";

const pid = (addr: string): string => makePoolId(42220, addr);

type MockDb = {
  entities: {
    Pool: { get: (id: string) => unknown };
    PoolSnapshot: { get: (id: string) => unknown };
    PoolDailySnapshot: { get: (id: string) => unknown };
  };
};

type EventProcessor = {
  createMockEvent: (args: unknown) => unknown;
  processEvent: (args: { event: unknown; mockDb: MockDb }) => Promise<MockDb>;
};

type GeneratedModule = {
  TestHelpers: {
    MockDb: { createMockDb: () => MockDb };
    FPMMFactory: { FPMMDeployed: EventProcessor };
    FPMM: { Swap: EventProcessor; UpdateReserves: EventProcessor };
    VirtualPoolFactory: { VirtualPoolDeployed: EventProcessor };
    VirtualPool: { Swap: EventProcessor; UpdateReserves: EventProcessor };
  };
};

const { TestHelpers } = generated as unknown as GeneratedModule;
const { MockDb, FPMMFactory, FPMM, VirtualPoolFactory, VirtualPool } =
  TestHelpers;

type SnapshotLike = {
  id: string;
  poolId: string;
  timestamp: bigint;
  swapCount: number;
  swapVolume0: bigint;
  swapVolume1: bigint;
  cumulativeSwapCount: number;
  cumulativeVolume0: bigint;
};

const deployPool = async (
  mockDb: MockDb,
  poolAddr: string,
  blockNumber: number,
  blockTimestamp: number,
): Promise<MockDb> => {
  const deployEvent = FPMMFactory.FPMMDeployed.createMockEvent({
    token0: "0x0000000000000000000000000000000000000003",
    token1: "0x0000000000000000000000000000000000000004",
    fpmmProxy: poolAddr,
    fpmmImplementation: "0x00000000000000000000000000000000000000bc",
    mockEventData: {
      chainId: 42220,
      logIndex: 0,
      srcAddress: "0x00000000000000000000000000000000000000cc",
      block: { number: blockNumber, timestamp: blockTimestamp },
    },
  });
  return FPMMFactory.FPMMDeployed.processEvent({ event: deployEvent, mockDb });
};

/**
 * Fire a Swap preceded by UpdateReserves in the same tx (mirrors contract behavior).
 * volume = amount0In = 1e18; amount1Out = 2e18 so swapVolume0 = 1e18, swapVolume1 = 2e18.
 */
const fireSwap = async (
  mockDb: MockDb,
  poolAddr: string,
  blockNumber: number,
  blockTimestamp: number,
  amount0In: bigint,
  amount1Out: bigint,
): Promise<MockDb> => {
  const updateEvent = FPMM.UpdateReserves.createMockEvent({
    reserve0: 1_000_000_000_000_000_000_000n,
    reserve1: 1_000_000_000_000_000_000_000n,
    blockTimestamp: BigInt(blockTimestamp),
    mockEventData: {
      chainId: 42220,
      logIndex: 1,
      srcAddress: poolAddr,
      block: { number: blockNumber, timestamp: blockTimestamp },
    },
  });
  let next = await FPMM.UpdateReserves.processEvent({
    event: updateEvent,
    mockDb,
  });
  const swapEvent = FPMM.Swap.createMockEvent({
    sender: "0x0000000000000000000000000000000000000011",
    to: "0x0000000000000000000000000000000000000022",
    amount0In,
    amount1In: 0n,
    amount0Out: 0n,
    amount1Out,
    mockEventData: {
      chainId: 42220,
      logIndex: 2,
      srcAddress: poolAddr,
      block: { number: blockNumber, timestamp: blockTimestamp },
    },
  });
  next = await FPMM.Swap.processEvent({ event: swapEvent, mockDb: next });
  return next;
};

describe("PoolDailySnapshot rollup", () => {
  afterEach(() => {
    _clearMockReserves();
    _clearMockERC20Decimals();
  });

  it("accumulates two same-day swaps into one PoolDailySnapshot row", async () => {
    const POOL_ADDR = "0x00000000000000000000000000000000000000f0";
    // 2025-01-15 08:00:00 UTC and 2025-01-15 14:30:00 UTC — same UTC day.
    const TS_MORNING = 1_736_928_000;
    const TS_AFTERNOON = 1_736_951_400;

    let mockDb = MockDb.createMockDb();
    mockDb = await deployPool(mockDb, POOL_ADDR, 100, TS_MORNING - 10);
    mockDb = await fireSwap(
      mockDb,
      POOL_ADDR,
      101,
      TS_MORNING,
      1_000_000_000_000_000_000n,
      2_000_000_000_000_000_000n,
    );
    mockDb = await fireSwap(
      mockDb,
      POOL_ADDR,
      102,
      TS_AFTERNOON,
      3_000_000_000_000_000_000n,
      5_000_000_000_000_000_000n,
    );

    const dayTs = dayBucket(BigInt(TS_MORNING));
    const dailyId = dailySnapshotId(pid(POOL_ADDR), dayTs);
    const daily = mockDb.entities.PoolDailySnapshot.get(dailyId) as
      | SnapshotLike
      | undefined;
    assert.ok(daily, "PoolDailySnapshot must exist after swaps");
    assert.equal(daily!.timestamp, dayTs, "timestamp is UTC day bucket");
    assert.equal(daily!.swapCount, 2, "two swaps accumulated");
    assert.equal(
      daily!.swapVolume0,
      4_000_000_000_000_000_000n,
      "swapVolume0 = 1e18 + 3e18",
    );
    assert.equal(
      daily!.swapVolume1,
      7_000_000_000_000_000_000n,
      "swapVolume1 = 2e18 + 5e18",
    );
    assert.equal(daily!.cumulativeSwapCount, 2, "running total after 2 swaps");
  });

  it("creates separate PoolDailySnapshot rows across a UTC day boundary", async () => {
    const POOL_ADDR = "0x00000000000000000000000000000000000000f1";
    // 2025-01-15 23:00:00 UTC and 2025-01-16 01:00:00 UTC — different UTC days.
    const TS_DAY1 = 1_736_982_000;
    const TS_DAY2 = 1_736_989_200;

    let mockDb = MockDb.createMockDb();
    mockDb = await deployPool(mockDb, POOL_ADDR, 200, TS_DAY1 - 10);
    mockDb = await fireSwap(
      mockDb,
      POOL_ADDR,
      201,
      TS_DAY1,
      1_000_000_000_000_000_000n,
      2_000_000_000_000_000_000n,
    );
    mockDb = await fireSwap(
      mockDb,
      POOL_ADDR,
      202,
      TS_DAY2,
      4_000_000_000_000_000_000n,
      7_000_000_000_000_000_000n,
    );

    const day1Id = dailySnapshotId(pid(POOL_ADDR), dayBucket(BigInt(TS_DAY1)));
    const day2Id = dailySnapshotId(pid(POOL_ADDR), dayBucket(BigInt(TS_DAY2)));

    const day1 = mockDb.entities.PoolDailySnapshot.get(day1Id) as
      | SnapshotLike
      | undefined;
    const day2 = mockDb.entities.PoolDailySnapshot.get(day2Id) as
      | SnapshotLike
      | undefined;

    assert.ok(day1, "day 1 PoolDailySnapshot must exist");
    assert.ok(day2, "day 2 PoolDailySnapshot must exist");
    assert.notEqual(day1!.id, day2!.id, "distinct daily rows");

    assert.equal(day1!.swapCount, 1);
    assert.equal(day1!.swapVolume0, 1_000_000_000_000_000_000n);
    assert.equal(day1!.cumulativeSwapCount, 1);

    assert.equal(day2!.swapCount, 1);
    assert.equal(day2!.swapVolume0, 4_000_000_000_000_000_000n);
    // Cumulative reflects Pool.swapCount at write time, which includes day 1.
    assert.equal(day2!.cumulativeSwapCount, 2);
    assert.equal(
      day2!.cumulativeVolume0,
      5_000_000_000_000_000_000n,
      "cumulativeVolume0 = notionalVolume0 after both swaps",
    );
  });

  it("keeps writing the hourly PoolSnapshot unchanged alongside the daily rollup", async () => {
    const POOL_ADDR = "0x00000000000000000000000000000000000000f2";
    const TS = 1_736_940_000; // arbitrary mid-hour timestamp

    let mockDb = MockDb.createMockDb();
    mockDb = await deployPool(mockDb, POOL_ADDR, 300, TS - 10);
    mockDb = await fireSwap(
      mockDb,
      POOL_ADDR,
      301,
      TS,
      2_000_000_000_000_000_000n,
      3_000_000_000_000_000_000n,
    );

    const hourlyId = snapshotId(pid(POOL_ADDR), hourBucket(BigInt(TS)));
    const hourly = mockDb.entities.PoolSnapshot.get(hourlyId) as
      | SnapshotLike
      | undefined;
    assert.ok(hourly, "hourly PoolSnapshot still written");
    assert.equal(hourly!.swapCount, 1);
    assert.equal(hourly!.swapVolume0, 2_000_000_000_000_000_000n);

    const dailyId = dailySnapshotId(pid(POOL_ADDR), dayBucket(BigInt(TS)));
    const daily = mockDb.entities.PoolDailySnapshot.get(dailyId) as
      | SnapshotLike
      | undefined;
    assert.ok(daily, "daily PoolDailySnapshot also written");
    assert.equal(daily!.swapCount, 1);
    assert.equal(daily!.swapVolume0, 2_000_000_000_000_000_000n);
  });

  it("VirtualPool.Swap writes to PoolDailySnapshot (non-FPMM writer path)", async () => {
    // VirtualPool events share upsertSnapshot() → upsertDailySnapshot() via the
    // same shared handler as FPMM. This test ensures the rollup isn't accidentally
    // gated on a FPMM-specific branch.
    const POOL_ADDR = "0x00000000000000000000000000000000000000f3";
    const TS = 1_737_100_800; // 2025-01-17 08:00:00 UTC

    let mockDb = MockDb.createMockDb();

    // Deploy VirtualPool
    const deployEvent = VirtualPoolFactory.VirtualPoolDeployed.createMockEvent({
      pool: POOL_ADDR,
      token0: "0x0000000000000000000000000000000000000003",
      token1: "0x0000000000000000000000000000000000000004",
      mockEventData: {
        chainId: 42220,
        logIndex: 0,
        srcAddress: "0x00000000000000000000000000000000000000cc",
        block: { number: 400, timestamp: TS - 10 },
      },
    });
    mockDb = await VirtualPoolFactory.VirtualPoolDeployed.processEvent({
      event: deployEvent,
      mockDb,
    });

    // UpdateReserves precedes Swap (mirrors on-chain tx ordering)
    const updateEvent = VirtualPool.UpdateReserves.createMockEvent({
      reserve0: 1_000_000_000_000_000_000_000n,
      reserve1: 1_000_000_000_000_000_000_000n,
      blockTimestamp: BigInt(TS),
      mockEventData: {
        chainId: 42220,
        logIndex: 1,
        srcAddress: POOL_ADDR,
        block: { number: 401, timestamp: TS },
      },
    });
    mockDb = await VirtualPool.UpdateReserves.processEvent({
      event: updateEvent,
      mockDb,
    });

    // Fire VirtualPool.Swap
    const swapEvent = VirtualPool.Swap.createMockEvent({
      sender: "0x0000000000000000000000000000000000000011",
      to: "0x0000000000000000000000000000000000000022",
      amount0In: 5_000_000_000_000_000_000n,
      amount1In: 0n,
      amount0Out: 0n,
      amount1Out: 9_000_000_000_000_000_000n,
      mockEventData: {
        chainId: 42220,
        logIndex: 2,
        srcAddress: POOL_ADDR,
        block: { number: 401, timestamp: TS },
      },
    });
    mockDb = await VirtualPool.Swap.processEvent({ event: swapEvent, mockDb });

    const dayTs = dayBucket(BigInt(TS));
    const dailyId = dailySnapshotId(pid(POOL_ADDR), dayTs);
    const daily = mockDb.entities.PoolDailySnapshot.get(dailyId) as
      | SnapshotLike
      | undefined;
    assert.ok(daily, "PoolDailySnapshot must exist after VirtualPool.Swap");
    assert.equal(daily!.swapCount, 1, "swap accumulated from VirtualPool path");
    assert.equal(
      daily!.swapVolume0,
      5_000_000_000_000_000_000n,
      "swapVolume0 correct",
    );
  });
});

// Silence "unused import" warnings from strict TS when _setMockReserves
// isn't exercised directly — the helpers above use FPMM.UpdateReserves to
// seed reserves without touching the mock RPC layer.
void _setMockReserves;
