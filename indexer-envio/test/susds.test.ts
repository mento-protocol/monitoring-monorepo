import assert from "node:assert/strict";
import {
  indexerTestHelpers,
  type EntityCollection,
  type EntityReader,
  type MockDbWith,
  type WritableEntity,
} from "./helpers/indexerTestHarness.js";
import { createMockEventData } from "./helpers/eventFixtures.js";
import {
  _clearMockSusdsSharePrices,
  _setMockSusdsSharePrice,
} from "../src/rpc/susds.ts";
import {
  ETHEREUM_CHAIN_ID,
  SUSDS_ADDRESS,
  TRACKED_SUSDS_WALLETS,
  V3_REVENUE_LAUNCH_BLOCK,
  V3_REVENUE_LAUNCH_BLOCK_TIMESTAMP,
  V3_REVENUE_LAUNCH_TIMESTAMP,
  ZERO,
} from "../src/handlers/susds/shared.ts";
import {
  handleSusdsYieldDailySnapshotHeartbeat,
  handleSusdsYieldLaunchBaseline,
  readSharePrice,
  recordSusdsYieldLaunchBaseline,
  recordSusdsYieldDailySnapshot,
  recordSusdsYieldHeartbeatSnapshot,
} from "../src/handlers/susds/dailySnapshots.ts";
import { ZERO_ADDRESS } from "../src/constants.ts";
import {
  blockTimestampEffect,
  RESERVE_YIELD_SAMPLER_MAX_EFFECT_DISPATCHES_PER_SECOND,
  susdsSharePriceEffect,
} from "../src/rpc/effects.ts";

type MockDb = MockDbWith<{
  SusdsCostBasisLot: EntityCollection;
  SusdsPosition: WritableEntity & EntityReader;
  SusdsYieldLaunchBaseline: WritableEntity & EntityCollection;
  SusdsYieldSamplerProgress: WritableEntity & EntityReader;
  SusdsYieldDailySnapshot: WritableEntity & EntityCollection;
  SusdsYieldMovement: EntityCollection;
  SusdsYieldSummary: WritableEntity & EntityReader;
}>;

const TestHelpers = indexerTestHelpers<MockDb>();
const { MockDb, Susds } = TestHelpers;

const WAD = 10n ** 18n;
const RESERVE_SAFE = TRACKED_SUSDS_WALLETS[0];
const AUSD_OPS_SAFE = TRACKED_SUSDS_WALLETS[1];
const EXTERNAL = "0x0000000000000000000000000000000000000abc";
const describeReserveYield =
  process.env.RESERVE_YIELD_EVENT_TESTS === "1" ? describe : describe.skip;

function dollars(value: number): bigint {
  return BigInt(value) * WAD;
}

function txHash(index: number): string {
  return `0x${index.toString(16).padStart(64, "0")}`;
}

function mockData(
  blockNumber: number,
  logIndex: number,
  blockTimestamp = 1_700_000_000 + blockNumber,
) {
  return createMockEventData({
    chainId: ETHEREUM_CHAIN_ID,
    srcAddress: SUSDS_ADDRESS,
    blockNumber,
    blockTimestamp,
    logIndex,
    transaction: { hash: txHash(logIndex + blockNumber) },
  });
}

function setSharePrice(blockNumber: number, priceUsdWei: bigint): void {
  _setMockSusdsSharePrice(
    ETHEREUM_CHAIN_ID,
    SUSDS_ADDRESS,
    BigInt(blockNumber),
    priceUsdWei,
  );
}

async function deposit(
  mockDb: MockDb,
  blockNumber: number,
  logIndex: number,
  assets: bigint,
  shares: bigint,
  blockTimestamp?: number,
): Promise<MockDb> {
  const event = Susds.Deposit.createMockEvent({
    sender: RESERVE_SAFE,
    owner: RESERVE_SAFE,
    assets,
    shares,
    mockEventData: mockData(blockNumber, logIndex, blockTimestamp),
  });
  return Susds.Deposit.processEvent({ event, mockDb });
}

async function transfer(
  mockDb: MockDb,
  blockNumber: number,
  logIndex: number,
  from: string,
  to: string,
  value: bigint,
  blockTimestamp?: number,
): Promise<MockDb> {
  const event = Susds.Transfer.createMockEvent({
    from,
    to,
    value,
    mockEventData: mockData(blockNumber, logIndex, blockTimestamp),
  });
  return Susds.Transfer.processEvent({ event, mockDb });
}

async function withdraw(
  mockDb: MockDb,
  blockNumber: number,
  logIndex: number,
  assets: bigint,
  shares: bigint,
  blockTimestamp?: number,
): Promise<MockDb> {
  const event = Susds.Withdraw.createMockEvent({
    sender: AUSD_OPS_SAFE,
    receiver: AUSD_OPS_SAFE,
    owner: AUSD_OPS_SAFE,
    assets,
    shares,
    mockEventData: mockData(blockNumber, logIndex, blockTimestamp),
  });
  return Susds.Withdraw.processEvent({ event, mockDb });
}

function summary(mockDb: MockDb) {
  const row = mockDb.entities.SusdsYieldSummary.get("1-susds") as
    | Record<string, bigint | number | string | string[]>
    | undefined;
  assert.ok(row, "expected SusdsYieldSummary row");
  return row;
}

function dailySnapshots(mockDb: MockDb) {
  return mockDb.entities.SusdsYieldDailySnapshot.getAll() as Array<{
    id: string;
    timestamp: bigint;
    sharePriceUsdWei: bigint;
    totalEarnedYieldUsdWei: bigint;
    dailyEarnedYieldUsdWei: bigint;
    dailyRealizedYieldUsdWei: bigint;
    dailyUnrealizedYieldUsdWei: bigint;
    sampledAtBlock: bigint;
    sampledAtTimestamp: bigint;
  }>;
}

function dailySnapshotContext(
  mockDb: MockDb,
): Parameters<typeof recordSusdsYieldDailySnapshot>[0] {
  return {
    SusdsPosition: {
      get: async (id: string) => mockDb.entities.SusdsPosition.get(id),
    },
    SusdsYieldLaunchBaseline: {
      get: async (id: string) =>
        mockDb.entities.SusdsYieldLaunchBaseline.get(id),
      set: (entity: { id: string }) => {
        mockDb.entities.SusdsYieldLaunchBaseline.set(entity);
      },
    },
    SusdsYieldSamplerProgress: {
      get: async (id: string) =>
        mockDb.entities.SusdsYieldSamplerProgress.get(id),
      set: (entity: { id: string }) => {
        mockDb.entities.SusdsYieldSamplerProgress.set(entity);
      },
    },
    SusdsYieldDailySnapshot: {
      get: async (id: string) =>
        mockDb.entities.SusdsYieldDailySnapshot.get(id),
      set: (entity: { id: string }) => {
        mockDb.entities.SusdsYieldDailySnapshot.set(entity);
      },
    },
  } as unknown as Parameters<typeof recordSusdsYieldDailySnapshot>[0];
}

function heartbeatContext(
  mockDb: MockDb,
  blockTimestamp: bigint | null,
  sharePriceUsdWei: bigint | null,
  expectedBlockNumber = 300n,
): Parameters<typeof recordSusdsYieldHeartbeatSnapshot>[0] {
  return {
    ...dailySnapshotContext(mockDb),
    isPreload: false,
    effect: async (effect, input) => {
      if (effect === blockTimestampEffect) {
        assert.deepEqual(input, {
          chainId: ETHEREUM_CHAIN_ID,
          blockNumber: expectedBlockNumber,
        });
        return blockTimestamp;
      }
      if (effect === susdsSharePriceEffect) {
        assert.deepEqual(input, {
          chainId: ETHEREUM_CHAIN_ID,
          tokenAddress: SUSDS_ADDRESS,
          blockNumber: expectedBlockNumber,
        });
        return sharePriceUsdWei;
      }
      throw new Error("unexpected effect");
    },
  } as unknown as Parameters<typeof recordSusdsYieldHeartbeatSnapshot>[0];
}

function samplerProgress(mockDb: MockDb) {
  return mockDb.entities.SusdsYieldSamplerProgress.get("1-susds-sampler") as
    | { sampledAtBlock: bigint; sampledAtTimestamp: bigint }
    | undefined;
}

// Run through `pnpm indexer:reserve-yield:test`, which codegens the dedicated
// chain-1 reserve-yield config before executing these event-level tests.
describeReserveYield("sUSDS reserve yield accounting", () => {
  it("bounds aggregate reserve-yield sampler effect dispatches", () => {
    assert.equal(RESERVE_YIELD_SAMPLER_MAX_EFFECT_DISPATCHES_PER_SECOND, 12);
  });

  afterEach(() => {
    _clearMockSusdsSharePrices();
  });

  it("tracks deposits, internal transfers, realized outflows, and withdrawals", async () => {
    let mockDb = MockDb.createMockDb();

    setSharePrice(100, dollars(106) / 100n);
    mockDb = await deposit(mockDb, 100, 0, dollars(1060), dollars(1000));

    let reservePosition = mockDb.entities.SusdsPosition.get(
      `1-${RESERVE_SAFE}`,
    ) as { shares: bigint; costBasisUsdWei: bigint } | undefined;
    assert.ok(reservePosition, "expected reserve position after deposit");
    assert.equal(reservePosition.shares, dollars(1000));
    assert.equal(reservePosition.costBasisUsdWei, dollars(1060));
    assert.equal(summary(mockDb).totalEarnedYieldUsdWei, 0n);

    setSharePrice(110, dollars(108) / 100n);
    mockDb = await transfer(
      mockDb,
      110,
      1,
      RESERVE_SAFE,
      AUSD_OPS_SAFE,
      dollars(400),
    );

    reservePosition = mockDb.entities.SusdsPosition.get(`1-${RESERVE_SAFE}`) as
      | { shares: bigint; costBasisUsdWei: bigint }
      | undefined;
    const opsPosition = mockDb.entities.SusdsPosition.get(
      `1-${AUSD_OPS_SAFE}`,
    ) as { shares: bigint; costBasisUsdWei: bigint } | undefined;
    assert.ok(reservePosition, "expected reserve position after transfer");
    assert.ok(opsPosition, "expected ops position after transfer");
    assert.equal(reservePosition.shares, dollars(600));
    assert.equal(reservePosition.costBasisUsdWei, dollars(636));
    assert.equal(opsPosition.shares, dollars(400));
    assert.equal(opsPosition.costBasisUsdWei, dollars(424));
    assert.equal(summary(mockDb).unrealizedYieldUsdWei, dollars(20));
    assert.equal(summary(mockDb).realizedYieldUsdWei, 0n);

    setSharePrice(120, dollars(110) / 100n);
    mockDb = await transfer(
      mockDb,
      120,
      2,
      RESERVE_SAFE,
      EXTERNAL,
      dollars(100),
    );

    assert.equal(summary(mockDb).realizedYieldUsdWei, dollars(4));
    assert.equal(summary(mockDb).transferredOutYieldUsdWei, dollars(4));
    assert.equal(summary(mockDb).unrealizedYieldUsdWei, dollars(36));
    assert.equal(summary(mockDb).totalEarnedYieldUsdWei, dollars(40));

    setSharePrice(130, dollars(111) / 100n);
    mockDb = await withdraw(mockDb, 130, 3, dollars(222), dollars(200));

    const finalSummary = summary(mockDb);
    assert.equal(finalSummary.currentShares, dollars(700));
    assert.equal(finalSummary.costBasisUsdWei, dollars(742));
    assert.equal(finalSummary.realizedYieldUsdWei, dollars(14));
    assert.equal(finalSummary.redeemedYieldUsdWei, dollars(10));
    assert.equal(finalSummary.unrealizedYieldUsdWei, dollars(35));
    assert.equal(finalSummary.totalEarnedYieldUsdWei, dollars(49));

    const movements = mockDb.entities.SusdsYieldMovement.getAll() as Array<{
      kind: string;
      yieldUsdWei: bigint;
    }>;
    assert.deepEqual(
      movements.map((movement) => movement.kind),
      ["deposit", "internal_transfer", "transfer_out", "withdraw"],
    );
    assert.equal(movements[2]?.yieldUsdWei, dollars(4));
    assert.equal(movements[3]?.yieldUsdWei, dollars(10));
  });

  it("ignores mint/burn Transfer events because Deposit/Withdraw carry assets", async () => {
    const mockDb = MockDb.createMockDb();
    setSharePrice(100, dollars(106) / 100n);

    const updatedDb = await transfer(
      mockDb,
      100,
      0,
      ZERO_ADDRESS,
      RESERVE_SAFE,
      dollars(1000),
    );

    assert.equal(updatedDb.entities.SusdsYieldMovement.getAll().length, 0);
    assert.equal(
      updatedDb.entities.SusdsYieldSummary.get("1-susds"),
      undefined,
    );
  });

  it("ignores tracked self-transfers without reading share price", async () => {
    let mockDb = MockDb.createMockDb();
    setSharePrice(100, dollars(106) / 100n);
    mockDb = await deposit(mockDb, 100, 0, dollars(1060), dollars(1000));
    const before = summary(mockDb);
    const beforeCurrentShares = before.currentShares;
    const beforeCostBasis = before.costBasisUsdWei;
    const beforeTotalEarnedYield = before.totalEarnedYieldUsdWei;

    _clearMockSusdsSharePrices();
    mockDb = await transfer(
      mockDb,
      110,
      1,
      RESERVE_SAFE,
      RESERVE_SAFE,
      dollars(250),
    );

    const after = summary(mockDb);
    assert.equal(mockDb.entities.SusdsYieldMovement.getAll().length, 1);
    assert.equal(after.currentShares, beforeCurrentShares);
    assert.equal(after.costBasisUsdWei, beforeCostBasis);
    assert.equal(after.totalEarnedYieldUsdWei, beforeTotalEarnedYield);
  });

  it("writes sUSDS daily snapshots from cumulative yield without double-counting same-day samples", async () => {
    let mockDb = MockDb.createMockDb();
    const day1 = V3_REVENUE_LAUNCH_TIMESTAMP + 86_400n;
    const day2 = day1 + 86_400n;

    setSharePrice(100, WAD);
    mockDb = await deposit(
      mockDb,
      100,
      0,
      dollars(1000),
      dollars(1000),
      Number(day1 + 3_600n),
    );

    await recordSusdsYieldDailySnapshot(
      dailySnapshotContext(mockDb),
      {
        chainId: ETHEREUM_CHAIN_ID,
        blockNumber: 101n,
        blockTimestamp: day1 + 3_600n,
      },
      WAD,
    );

    let rows = dailySnapshots(mockDb);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.timestamp, day1);
    assert.equal(rows[0]?.totalEarnedYieldUsdWei, 0n);
    assert.equal(rows[0]?.dailyEarnedYieldUsdWei, 0n);

    await recordSusdsYieldDailySnapshot(
      dailySnapshotContext(mockDb),
      {
        chainId: ETHEREUM_CHAIN_ID,
        blockNumber: 200n,
        blockTimestamp: day1 + 43_200n,
      },
      dollars(110) / 100n,
    );

    rows = dailySnapshots(mockDb);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.totalEarnedYieldUsdWei, dollars(100));
    assert.equal(rows[0]?.dailyEarnedYieldUsdWei, dollars(100));
    assert.equal(rows[0]?.dailyUnrealizedYieldUsdWei, dollars(100));

    await recordSusdsYieldDailySnapshot(
      dailySnapshotContext(mockDb),
      {
        chainId: ETHEREUM_CHAIN_ID,
        blockNumber: 201n,
        blockTimestamp: day1 + 50_000n,
      },
      dollars(110) / 100n,
    );

    rows = dailySnapshots(mockDb);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.dailyEarnedYieldUsdWei, dollars(100));
    assert.equal(rows[0]?.sampledAtBlock, 201n);

    await recordSusdsYieldDailySnapshot(
      dailySnapshotContext(mockDb),
      {
        chainId: ETHEREUM_CHAIN_ID,
        blockNumber: 300n,
        blockTimestamp: day2 + 3_600n,
      },
      dollars(120) / 100n,
    );

    rows = dailySnapshots(mockDb).sort((a, b) =>
      a.timestamp < b.timestamp ? -1 : 1,
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[1]?.timestamp, day2);
    assert.equal(rows[1]?.totalEarnedYieldUsdWei, dollars(200));
    assert.equal(rows[1]?.dailyEarnedYieldUsdWei, dollars(100));
  });

  it("clamps daily earned yield to zero when cumulative sUSDS yield compresses", async () => {
    let mockDb = MockDb.createMockDb();
    const day1 = V3_REVENUE_LAUNCH_TIMESTAMP + 86_400n;
    const day2 = day1 + 86_400n;

    setSharePrice(100, WAD);
    mockDb = await deposit(
      mockDb,
      100,
      0,
      dollars(1000),
      dollars(1000),
      Number(day1 + 3_600n),
    );

    await recordSusdsYieldDailySnapshot(
      dailySnapshotContext(mockDb),
      {
        chainId: ETHEREUM_CHAIN_ID,
        blockNumber: 200n,
        blockTimestamp: day1 + 43_200n,
      },
      dollars(110) / 100n,
    );
    await recordSusdsYieldDailySnapshot(
      dailySnapshotContext(mockDb),
      {
        chainId: ETHEREUM_CHAIN_ID,
        blockNumber: 300n,
        blockTimestamp: day2 + 3_600n,
      },
      dollars(105) / 100n,
    );

    const rows = dailySnapshots(mockDb).sort((a, b) =>
      a.timestamp < b.timestamp ? -1 : 1,
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[1]?.totalEarnedYieldUsdWei, dollars(50));
    assert.equal(rows[1]?.dailyEarnedYieldUsdWei, 0n);
    assert.equal(rows[1]?.dailyUnrealizedYieldUsdWei, -dollars(50));
  });

  it("keeps the UTC-day baseline across same-day compression and recovery", async () => {
    let mockDb = MockDb.createMockDb();
    setSharePrice(V3_REVENUE_LAUNCH_BLOCK - 1, WAD);
    mockDb = await deposit(
      mockDb,
      V3_REVENUE_LAUNCH_BLOCK - 1,
      0,
      dollars(1000),
      dollars(1000),
      Number(V3_REVENUE_LAUNCH_TIMESTAMP - 1n),
    );

    await recordSusdsYieldLaunchBaseline(dailySnapshotContext(mockDb), {
      blockTimestamp: V3_REVENUE_LAUNCH_BLOCK_TIMESTAMP,
      sharePriceUsdWei: dollars(110) / 100n,
    });
    await recordSusdsYieldDailySnapshot(
      dailySnapshotContext(mockDb),
      {
        chainId: ETHEREUM_CHAIN_ID,
        blockNumber: BigInt(V3_REVENUE_LAUNCH_BLOCK) + 600n,
        blockTimestamp: V3_REVENUE_LAUNCH_TIMESTAMP + 3_600n,
      },
      dollars(105) / 100n,
    );
    await recordSusdsYieldDailySnapshot(
      dailySnapshotContext(mockDb),
      {
        chainId: ETHEREUM_CHAIN_ID,
        blockNumber: BigInt(V3_REVENUE_LAUNCH_BLOCK) + 1_200n,
        blockTimestamp: V3_REVENUE_LAUNCH_TIMESTAMP + 7_200n,
      },
      dollars(108) / 100n,
    );

    let rows = dailySnapshots(mockDb);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.totalEarnedYieldUsdWei, dollars(80));
    assert.equal(rows[0]?.dailyEarnedYieldUsdWei, 0n);

    await recordSusdsYieldDailySnapshot(
      dailySnapshotContext(mockDb),
      {
        chainId: ETHEREUM_CHAIN_ID,
        blockNumber: BigInt(V3_REVENUE_LAUNCH_BLOCK) + 1_800n,
        blockTimestamp: V3_REVENUE_LAUNCH_TIMESTAMP + 10_800n,
      },
      dollars(112) / 100n,
    );

    rows = dailySnapshots(mockDb);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.totalEarnedYieldUsdWei, dollars(120));
    assert.equal(rows[0]?.dailyEarnedYieldUsdWei, dollars(20));
  });

  it("uses the latest prior sUSDS daily snapshot when the previous UTC day is missing", async () => {
    let mockDb = MockDb.createMockDb();
    const day1 = V3_REVENUE_LAUNCH_TIMESTAMP + 86_400n;
    const day3 = day1 + 2n * 86_400n;

    setSharePrice(100, WAD);
    mockDb = await deposit(
      mockDb,
      100,
      0,
      dollars(1000),
      dollars(1000),
      Number(day1 + 3_600n),
    );

    await recordSusdsYieldDailySnapshot(
      dailySnapshotContext(mockDb),
      {
        chainId: ETHEREUM_CHAIN_ID,
        blockNumber: 200n,
        blockTimestamp: day1 + 43_200n,
      },
      dollars(110) / 100n,
    );
    await recordSusdsYieldDailySnapshot(
      dailySnapshotContext(mockDb),
      {
        chainId: ETHEREUM_CHAIN_ID,
        blockNumber: 400n,
        blockTimestamp: day3 + 3_600n,
      },
      dollars(130) / 100n,
    );

    const rows = dailySnapshots(mockDb).sort((a, b) =>
      a.timestamp < b.timestamp ? -1 : 1,
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.totalEarnedYieldUsdWei, dollars(100));
    assert.equal(rows[1]?.totalEarnedYieldUsdWei, dollars(300));
    assert.equal(rows[1]?.dailyEarnedYieldUsdWei, dollars(200));
  });

  it("skips event-time snapshots when the previous UTC day is missing", async () => {
    let mockDb = MockDb.createMockDb();
    const day1 = V3_REVENUE_LAUNCH_TIMESTAMP + 86_400n;
    const day3 = day1 + 2n * 86_400n;

    setSharePrice(100, WAD);
    mockDb = await deposit(
      mockDb,
      100,
      0,
      dollars(1000),
      dollars(1000),
      Number(day1 + 3_600n),
    );
    assert.equal(dailySnapshots(mockDb).length, 0);
    assert.equal(
      mockDb.entities.SusdsYieldLaunchBaseline.get("1-susds-launch"),
      undefined,
    );

    setSharePrice(300, dollars(130) / 100n);
    mockDb = await transfer(
      mockDb,
      300,
      1,
      RESERVE_SAFE,
      AUSD_OPS_SAFE,
      dollars(100),
      Number(day3 + 3_600n),
    );
    assert.equal(dailySnapshots(mockDb).length, 0);
    assert.equal(
      mockDb.entities.SusdsYieldLaunchBaseline.get("1-susds-launch"),
      undefined,
    );

    setSharePrice(400, dollars(130) / 100n);
    mockDb = await withdraw(
      mockDb,
      400,
      2,
      dollars(130),
      dollars(100),
      Number(day3 + 7_200n),
    );

    const rows = dailySnapshots(mockDb);
    assert.equal(rows.length, 0);
    assert.equal(
      mockDb.entities.SusdsYieldLaunchBaseline.get("1-susds-launch"),
      undefined,
    );
    assert.deepEqual(
      (
        mockDb.entities.SusdsYieldMovement.getAll() as Array<{ kind: string }>
      ).map((movement) => movement.kind),
      ["deposit", "internal_transfer", "withdraw"],
    );
    assert.equal(summary(mockDb).currentShares, dollars(900));
    assert.equal(summary(mockDb).totalEarnedYieldUsdWei, dollars(300));
  });

  it("keeps late event yield in its UTC day across the next heartbeat", async () => {
    let mockDb = MockDb.createMockDb();
    const day1 = V3_REVENUE_LAUNCH_TIMESTAMP + 86_400n;
    const day2 = day1 + 86_400n;
    const firstHeartbeatBlock = BigInt(V3_REVENUE_LAUNCH_BLOCK) + 600n;
    const eventBlock = V3_REVENUE_LAUNCH_BLOCK + 601;
    const nextHeartbeatBlock = BigInt(V3_REVENUE_LAUNCH_BLOCK) + 1_200n;

    setSharePrice(V3_REVENUE_LAUNCH_BLOCK - 1, WAD);
    mockDb = await deposit(
      mockDb,
      V3_REVENUE_LAUNCH_BLOCK - 1,
      0,
      dollars(1000),
      dollars(1000),
      Number(V3_REVENUE_LAUNCH_TIMESTAMP - 1n),
    );
    await recordSusdsYieldLaunchBaseline(dailySnapshotContext(mockDb), {
      blockTimestamp: V3_REVENUE_LAUNCH_BLOCK_TIMESTAMP,
      sharePriceUsdWei: WAD,
    });

    await recordSusdsYieldHeartbeatSnapshot(
      heartbeatContext(
        mockDb,
        day1 + 82_800n,
        dollars(110) / 100n,
        firstHeartbeatBlock,
      ),
      firstHeartbeatBlock,
    );
    assert.deepEqual(samplerProgress(mockDb), {
      id: "1-susds-sampler",
      chainId: ETHEREUM_CHAIN_ID,
      token: SUSDS_ADDRESS,
      sampledAtBlock: firstHeartbeatBlock,
      sampledAtTimestamp: day1 + 82_800n,
    });

    const eventTimestamp = day1 + 86_390n;
    setSharePrice(eventBlock, dollars(120) / 100n);
    mockDb = await transfer(
      mockDb,
      eventBlock,
      1,
      RESERVE_SAFE,
      EXTERNAL,
      dollars(100),
      Number(eventTimestamp),
    );

    let eventDay = dailySnapshots(mockDb).find(
      (snapshot) => snapshot.timestamp === day1,
    );
    assert.ok(eventDay, "expected event-day sUSDS snapshot");
    assert.equal(eventDay.totalEarnedYieldUsdWei, dollars(200));
    assert.equal(eventDay.dailyEarnedYieldUsdWei, dollars(200));
    assert.equal(eventDay.dailyRealizedYieldUsdWei, dollars(20));
    assert.equal(eventDay.dailyUnrealizedYieldUsdWei, dollars(180));
    assert.equal(eventDay.sampledAtBlock, BigInt(eventBlock));
    assert.equal(eventDay.sampledAtTimestamp, eventTimestamp);
    assert.equal(samplerProgress(mockDb)?.sampledAtBlock, firstHeartbeatBlock);

    mockDb = await transfer(
      mockDb,
      eventBlock,
      1,
      RESERVE_SAFE,
      EXTERNAL,
      dollars(100),
      Number(eventTimestamp),
    );
    eventDay = dailySnapshots(mockDb).find(
      (snapshot) => snapshot.timestamp === day1,
    );
    assert.ok(eventDay, "expected idempotent event-day sUSDS snapshot");
    assert.equal(eventDay.totalEarnedYieldUsdWei, dollars(200));
    assert.equal(eventDay.sampledAtBlock, BigInt(eventBlock));

    await recordSusdsYieldHeartbeatSnapshot(
      heartbeatContext(
        mockDb,
        day2 + 300n,
        dollars(120) / 100n,
        nextHeartbeatBlock,
      ),
      nextHeartbeatBlock,
    );

    const nextDay = dailySnapshots(mockDb).find(
      (snapshot) => snapshot.timestamp === day2,
    );
    assert.ok(nextDay, "expected next-day sUSDS snapshot");
    assert.equal(nextDay.totalEarnedYieldUsdWei, dollars(200));
    assert.equal(nextDay.dailyEarnedYieldUsdWei, 0n);
    assert.equal(nextDay.dailyRealizedYieldUsdWei, 0n);
    assert.equal(nextDay.dailyUnrealizedYieldUsdWei, 0n);
    assert.deepEqual(samplerProgress(mockDb), {
      id: "1-susds-sampler",
      chainId: ETHEREUM_CHAIN_ID,
      token: SUSDS_ADDRESS,
      sampledAtBlock: nextHeartbeatBlock,
      sampledAtTimestamp: day2 + 300n,
    });
  });

  it("writes sUSDS daily snapshots from a block-number-only heartbeat", async () => {
    let mockDb = MockDb.createMockDb();
    const day1 = V3_REVENUE_LAUNCH_TIMESTAMP + 86_400n;
    const day2 = day1 + 86_400n;

    setSharePrice(100, WAD);
    mockDb = await deposit(
      mockDb,
      100,
      0,
      dollars(1000),
      dollars(1000),
      Number(day1 + 3_600n),
    );

    await recordSusdsYieldDailySnapshot(
      dailySnapshotContext(mockDb),
      {
        chainId: ETHEREUM_CHAIN_ID,
        blockNumber: 101n,
        blockTimestamp: day1 + 3_600n,
      },
      WAD,
    );

    await recordSusdsYieldLaunchBaseline(dailySnapshotContext(mockDb), {
      blockTimestamp: V3_REVENUE_LAUNCH_BLOCK_TIMESTAMP,
      sharePriceUsdWei: WAD,
    });

    const didWrite = await recordSusdsYieldHeartbeatSnapshot(
      heartbeatContext(mockDb, day2 + 3_600n, dollars(120) / 100n),
      300n,
    );

    const rows = dailySnapshots(mockDb).sort((a, b) =>
      a.timestamp < b.timestamp ? -1 : 1,
    );
    assert.equal(didWrite, true);
    assert.equal(rows.length, 3);
    assert.equal(rows[2]?.timestamp, day2);
    assert.equal(rows[2]?.totalEarnedYieldUsdWei, dollars(200));
    assert.equal(rows[2]?.dailyEarnedYieldUsdWei, dollars(200));
    assert.equal(rows[2]?.sampledAtBlock, 300n);
  });

  it("preloads raw sUSDS heartbeat effects without writing snapshots", async () => {
    const mockDb = MockDb.createMockDb();
    const calls: Array<{ effect: unknown; input: unknown }> = [];
    const context = {
      ...heartbeatContext(
        mockDb,
        V3_REVENUE_LAUNCH_TIMESTAMP + 86_400n + 1n,
        WAD,
        300n,
      ),
      isPreload: true,
      effect: async (effect: unknown, input: unknown) => {
        calls.push({ effect, input });
        if (effect === blockTimestampEffect) return null;
        if (effect === susdsSharePriceEffect) return null;
        throw new Error("unexpected effect");
      },
    } as Parameters<
      typeof handleSusdsYieldDailySnapshotHeartbeat
    >[0]["context"];

    const didWrite = await handleSusdsYieldDailySnapshotHeartbeat({
      block: { number: 300 },
      context,
    });

    assert.equal(didWrite, false);
    assert.equal(calls.length, 2);
    assert.equal(dailySnapshots(mockDb).length, 0);
    assert.equal(samplerProgress(mockDb), undefined);
  });

  it("keeps sUSDS timestamp-null skip ahead of a hydrated share-price failure", async () => {
    const mockDb = MockDb.createMockDb();
    const calls: Array<{ effect: unknown; input: unknown }> = [];
    const context = {
      ...heartbeatContext(mockDb, null, WAD, 300n),
      effect: async (effect: unknown, input: unknown) => {
        calls.push({ effect, input });
        if (effect === blockTimestampEffect) return null;
        if (effect === susdsSharePriceEffect) return null;
        throw new Error("unexpected effect");
      },
    } as Parameters<
      typeof handleSusdsYieldDailySnapshotHeartbeat
    >[0]["context"];

    assert.equal(
      await handleSusdsYieldDailySnapshotHeartbeat({
        block: { number: 300 },
        context: { ...context, isPreload: true },
      }),
      false,
    );
    const preloadCalls = [...calls];
    calls.length = 0;
    assert.equal(
      await handleSusdsYieldDailySnapshotHeartbeat({
        block: { number: 300 },
        context: { ...context, isPreload: false },
      }),
      false,
    );
    assert.deepEqual(calls, preloadCalls);
  });

  it("skips a null post-launch share price and resumes at the next heartbeat", async () => {
    let mockDb = MockDb.createMockDb();
    const day1 = V3_REVENUE_LAUNCH_TIMESTAMP + 86_400n;
    const day2 = day1 + 86_400n;

    setSharePrice(100, WAD);
    mockDb = await deposit(
      mockDb,
      100,
      0,
      dollars(1000),
      dollars(1000),
      Number(day1 + 3_600n),
    );
    await recordSusdsYieldLaunchBaseline(dailySnapshotContext(mockDb), {
      blockTimestamp: V3_REVENUE_LAUNCH_BLOCK_TIMESTAMP,
      sharePriceUsdWei: WAD,
    });

    assert.equal(
      await handleSusdsYieldDailySnapshotHeartbeat({
        block: { number: 300 },
        context: heartbeatContext(mockDb, day2 + 3_600n, null, 300n),
      }),
      false,
    );
    assert.equal(dailySnapshots(mockDb).length, 1);

    assert.equal(
      await handleSusdsYieldDailySnapshotHeartbeat({
        block: { number: 900 },
        context: heartbeatContext(
          mockDb,
          day2 + 7_200n,
          dollars(120) / 100n,
          900n,
        ),
      }),
      true,
    );
    const rows = dailySnapshots(mockDb).sort((a, b) =>
      a.timestamp < b.timestamp ? -1 : 1,
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[1]?.sampledAtBlock, 900n);
  });

  it("skips the sUSDS heartbeat before launch when the share price is null", async () => {
    const mockDb = MockDb.createMockDb();

    assert.equal(
      await handleSusdsYieldDailySnapshotHeartbeat({
        block: { number: 300 },
        context: heartbeatContext(
          mockDb,
          V3_REVENUE_LAUNCH_TIMESTAMP - 1n,
          null,
        ),
      }),
      false,
    );
    assert.equal(dailySnapshots(mockDb).length, 0);
  });

  it("runs the sUSDS heartbeat onBlock handler path", async () => {
    let mockDb = MockDb.createMockDb();
    const day1 = V3_REVENUE_LAUNCH_TIMESTAMP + 86_400n;
    const day2 = day1 + 86_400n;
    const depositBlock = 22_990_100;
    const heartbeatBlock = 22_990_300;
    const heartbeatBlockNumber = BigInt(heartbeatBlock);
    const heartbeatTimestamp = day2 + 3_600n;
    const heartbeatSharePrice = dollars(120) / 100n;

    setSharePrice(depositBlock, WAD);
    mockDb = await deposit(
      mockDb,
      depositBlock,
      0,
      dollars(1000),
      dollars(1000),
      Number(day1 + 3_600n),
    );

    await recordSusdsYieldDailySnapshot(
      dailySnapshotContext(mockDb),
      {
        chainId: ETHEREUM_CHAIN_ID,
        blockNumber: BigInt(depositBlock + 1),
        blockTimestamp: day1 + 3_600n,
      },
      WAD,
    );

    await recordSusdsYieldLaunchBaseline(dailySnapshotContext(mockDb), {
      blockTimestamp: V3_REVENUE_LAUNCH_BLOCK_TIMESTAMP,
      sharePriceUsdWei: WAD,
    });

    const context = heartbeatContext(
      mockDb,
      heartbeatTimestamp,
      heartbeatSharePrice,
      heartbeatBlockNumber,
    );
    const didWrite = await handleSusdsYieldDailySnapshotHeartbeat({
      block: { number: heartbeatBlock },
      context: {
        ...context,
      },
    });

    const rows = dailySnapshots(mockDb).sort((a, b) =>
      a.timestamp < b.timestamp ? -1 : 1,
    );
    assert.equal(didWrite, true);
    assert.equal(rows.length, 3);
    assert.equal(rows[2]?.timestamp, day2);
    assert.equal(rows[2]?.sharePriceUsdWei, heartbeatSharePrice);
    assert.equal(rows[2]?.totalEarnedYieldUsdWei, dollars(200));
    assert.equal(rows[2]?.dailyEarnedYieldUsdWei, dollars(200));
    assert.equal(rows[2]?.sampledAtBlock, heartbeatBlockNumber);
    assert.equal(rows[2]?.sampledAtTimestamp, heartbeatTimestamp);
  });

  it("writes the exact launch baseline with pre-launch share price and zero launch-day yield", async () => {
    let mockDb = MockDb.createMockDb();
    const preLaunchTimestamp = V3_REVENUE_LAUNCH_TIMESTAMP - 1n;
    setSharePrice(V3_REVENUE_LAUNCH_BLOCK - 1, WAD);
    mockDb = await deposit(
      mockDb,
      V3_REVENUE_LAUNCH_BLOCK - 1,
      0,
      dollars(1000),
      dollars(1000),
      Number(preLaunchTimestamp),
    );

    const context = {
      ...heartbeatContext(
        mockDb,
        V3_REVENUE_LAUNCH_BLOCK_TIMESTAMP,
        WAD,
        BigInt(V3_REVENUE_LAUNCH_BLOCK),
      ),
      ...dailySnapshotContext(mockDb),
      isPreload: false,
    } as Parameters<typeof handleSusdsYieldLaunchBaseline>[0]["context"];
    const didWrite = await handleSusdsYieldLaunchBaseline({
      block: { number: V3_REVENUE_LAUNCH_BLOCK },
      context,
    });

    const rows = dailySnapshots(mockDb);
    assert.equal(didWrite, true);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.timestamp, V3_REVENUE_LAUNCH_TIMESTAMP);
    assert.equal(rows[0]?.sharePriceUsdWei, WAD);
    assert.equal(rows[0]?.dailyEarnedYieldUsdWei, 0n);
    assert.equal(rows[0]?.dailyUnrealizedYieldUsdWei, 0n);
    const launchBaseline = mockDb.entities.SusdsYieldLaunchBaseline.get(
      "1-susds-launch",
    ) as { sharePriceUsdWei: bigint; sampledAtBlock: bigint } | undefined;
    assert.ok(launchBaseline, "expected immutable sUSDS launch baseline");
    assert.equal(launchBaseline.sharePriceUsdWei, WAD);
    assert.equal(
      launchBaseline.sampledAtBlock,
      BigInt(V3_REVENUE_LAUNCH_BLOCK),
    );
  });

  it("keeps the launch baseline immutable across consecutive same-day samples", async () => {
    let mockDb = MockDb.createMockDb();
    setSharePrice(V3_REVENUE_LAUNCH_BLOCK - 1, WAD);
    mockDb = await deposit(
      mockDb,
      V3_REVENUE_LAUNCH_BLOCK - 1,
      0,
      dollars(1000),
      dollars(1000),
      Number(V3_REVENUE_LAUNCH_TIMESTAMP - 1n),
    );

    assert.equal(
      await recordSusdsYieldLaunchBaseline(dailySnapshotContext(mockDb), {
        blockTimestamp: V3_REVENUE_LAUNCH_BLOCK_TIMESTAMP,
        sharePriceUsdWei: WAD,
      }),
      true,
    );

    const firstSampleBlock = BigInt(V3_REVENUE_LAUNCH_BLOCK) + 600n;
    const firstSampleTimestamp = V3_REVENUE_LAUNCH_TIMESTAMP + 3_600n;
    assert.equal(
      await recordSusdsYieldHeartbeatSnapshot(
        heartbeatContext(
          mockDb,
          firstSampleTimestamp,
          dollars(110) / 100n,
          firstSampleBlock,
        ),
        firstSampleBlock,
      ),
      true,
    );

    const secondSampleBlock = firstSampleBlock + 600n;
    const secondSampleTimestamp = V3_REVENUE_LAUNCH_TIMESTAMP + 7_200n;
    assert.equal(
      await recordSusdsYieldHeartbeatSnapshot(
        heartbeatContext(
          mockDb,
          secondSampleTimestamp,
          dollars(120) / 100n,
          secondSampleBlock,
        ),
        secondSampleBlock,
      ),
      true,
    );

    const rows = dailySnapshots(mockDb);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.dailyEarnedYieldUsdWei, dollars(200));
    assert.equal(rows[0]?.sampledAtBlock, secondSampleBlock);
    const launchBaseline = mockDb.entities.SusdsYieldLaunchBaseline.get(
      "1-susds-launch",
    ) as { sharePriceUsdWei: bigint; sampledAtBlock: bigint } | undefined;
    assert.ok(launchBaseline, "expected immutable sUSDS launch baseline");
    assert.equal(launchBaseline.sharePriceUsdWei, WAD);
    assert.equal(
      launchBaseline.sampledAtBlock,
      BigInt(V3_REVENUE_LAUNCH_BLOCK),
    );
  });

  it("fails a null launch timestamp and does not let the next sample invent a baseline", async () => {
    let mockDb = MockDb.createMockDb();
    setSharePrice(V3_REVENUE_LAUNCH_BLOCK - 1, WAD);
    mockDb = await deposit(
      mockDb,
      V3_REVENUE_LAUNCH_BLOCK - 1,
      0,
      dollars(1000),
      dollars(1000),
      Number(V3_REVENUE_LAUNCH_TIMESTAMP - 1n),
    );

    await assert.rejects(
      handleSusdsYieldLaunchBaseline({
        block: { number: V3_REVENUE_LAUNCH_BLOCK },
        context: {
          ...heartbeatContext(
            mockDb,
            null,
            WAD,
            BigInt(V3_REVENUE_LAUNCH_BLOCK),
          ),
          isPreload: false,
        },
      }),
      /launch block timestamp unavailable or invalid/,
    );
    assert.equal(dailySnapshots(mockDb).length, 0);

    await assert.rejects(
      recordSusdsYieldLaunchBaseline(dailySnapshotContext(mockDb), {
        blockTimestamp: V3_REVENUE_LAUNCH_BLOCK_TIMESTAMP,
        sharePriceUsdWei: null,
      }),
      /convertToAssets\(1e18\) unavailable at block 24573203/,
    );
    assert.equal(dailySnapshots(mockDb).length, 0);

    await assert.rejects(
      recordSusdsYieldLaunchBaseline(dailySnapshotContext(mockDb), {
        blockTimestamp: V3_REVENUE_LAUNCH_BLOCK_TIMESTAMP,
        sharePriceUsdWei: "1e18" as unknown as bigint,
      }),
      /invalid share price at block 24573203/,
    );
    assert.equal(dailySnapshots(mockDb).length, 0);

    await assert.rejects(
      handleSusdsYieldLaunchBaseline({
        block: { number: V3_REVENUE_LAUNCH_BLOCK },
        context: {
          ...heartbeatContext(
            mockDb,
            V3_REVENUE_LAUNCH_BLOCK_TIMESTAMP - 1n,
            WAD,
            BigInt(V3_REVENUE_LAUNCH_BLOCK),
          ),
          isPreload: false,
        },
      }),
      /does not match expected/,
    );
    assert.equal(dailySnapshots(mockDb).length, 0);

    await recordSusdsYieldDailySnapshot(
      dailySnapshotContext(mockDb),
      {
        chainId: ETHEREUM_CHAIN_ID,
        blockNumber: 200n,
        blockTimestamp: V3_REVENUE_LAUNCH_TIMESTAMP + 1n,
      },
      WAD,
    );
    const skipped = await recordSusdsYieldHeartbeatSnapshot(
      heartbeatContext(
        mockDb,
        V3_REVENUE_LAUNCH_TIMESTAMP + 86_400n,
        dollars(110) / 100n,
        BigInt(V3_REVENUE_LAUNCH_BLOCK) + 600n,
      ),
      BigInt(V3_REVENUE_LAUNCH_BLOCK) + 600n,
    );
    assert.equal(skipped, false);
    assert.equal(dailySnapshots(mockDb).length, 1);

    await recordSusdsYieldLaunchBaseline(dailySnapshotContext(mockDb), {
      blockTimestamp: V3_REVENUE_LAUNCH_BLOCK_TIMESTAMP,
      sharePriceUsdWei: WAD,
    });
    const sampled = await recordSusdsYieldHeartbeatSnapshot(
      heartbeatContext(
        mockDb,
        V3_REVENUE_LAUNCH_TIMESTAMP + 86_400n,
        dollars(110) / 100n,
        BigInt(V3_REVENUE_LAUNCH_BLOCK) + 600n,
      ),
      BigInt(V3_REVENUE_LAUNCH_BLOCK) + 600n,
    );
    const rows = dailySnapshots(mockDb).sort((a, b) =>
      a.timestamp < b.timestamp ? -1 : 1,
    );
    assert.equal(sampled, true);
    assert.equal(rows.length, 2);
    assert.equal(rows[1]?.dailyEarnedYieldUsdWei, dollars(100));
  });

  it("rejects zero share prices before event, launch, and sampler writes", async () => {
    let mockDb = MockDb.createMockDb();
    setSharePrice(100, ZERO);
    await assert.rejects(deposit(mockDb, 100, 0, dollars(1000), dollars(1000)));
    assert.equal(mockDb.entities.SusdsYieldMovement.getAll().length, 0);
    await assert.rejects(
      readSharePrice(
        heartbeatContext(mockDb, V3_REVENUE_LAUNCH_TIMESTAMP, ZERO, 100n),
        {
          chainId: ETHEREUM_CHAIN_ID,
          blockNumber: 100n,
          blockTimestamp: V3_REVENUE_LAUNCH_TIMESTAMP,
        },
      ),
      /invalid share price at block 100/,
    );

    mockDb = MockDb.createMockDb();
    await assert.rejects(
      recordSusdsYieldLaunchBaseline(dailySnapshotContext(mockDb), {
        blockTimestamp: V3_REVENUE_LAUNCH_BLOCK_TIMESTAMP,
        sharePriceUsdWei: ZERO,
      }),
      /invalid share price at block 24573203/,
    );
    assert.equal(dailySnapshots(mockDb).length, 0);

    await assert.rejects(
      recordSusdsYieldHeartbeatSnapshot(
        heartbeatContext(mockDb, V3_REVENUE_LAUNCH_TIMESTAMP + 86_400n, ZERO),
        300n,
      ),
      /invalid share price at block 300/,
    );
    assert.equal(dailySnapshots(mockDb).length, 0);
  });

  it("excludes pre-v3 yield and preserves only launch-to-sample yield", async () => {
    let mockDb = MockDb.createMockDb();
    setSharePrice(V3_REVENUE_LAUNCH_BLOCK - 1, WAD);
    mockDb = await deposit(
      mockDb,
      V3_REVENUE_LAUNCH_BLOCK - 1,
      0,
      dollars(1000),
      dollars(1000),
      Number(V3_REVENUE_LAUNCH_TIMESTAMP - 1n),
    );
    await recordSusdsYieldLaunchBaseline(dailySnapshotContext(mockDb), {
      blockTimestamp: V3_REVENUE_LAUNCH_BLOCK_TIMESTAMP,
      sharePriceUsdWei: dollars(110) / 100n,
    });

    const launchRows = dailySnapshots(mockDb);
    assert.equal(launchRows.length, 1);
    assert.equal(launchRows[0]?.totalEarnedYieldUsdWei, dollars(100));
    assert.equal(launchRows[0]?.dailyEarnedYieldUsdWei, 0n);

    const sampleTimestamp = V3_REVENUE_LAUNCH_TIMESTAMP + 86_400n;
    const didWrite = await recordSusdsYieldHeartbeatSnapshot(
      heartbeatContext(
        mockDb,
        sampleTimestamp,
        dollars(120) / 100n,
        BigInt(V3_REVENUE_LAUNCH_BLOCK) + 600n,
      ),
      BigInt(V3_REVENUE_LAUNCH_BLOCK) + 600n,
    );
    const rows = dailySnapshots(mockDb).sort((a, b) =>
      a.timestamp < b.timestamp ? -1 : 1,
    );
    assert.equal(didWrite, true);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.totalEarnedYieldUsdWei, dollars(100));
    assert.equal(rows[0]?.dailyEarnedYieldUsdWei, 0n);
    assert.equal(rows[1]?.totalEarnedYieldUsdWei, dollars(200));
    assert.equal(rows[1]?.dailyEarnedYieldUsdWei, dollars(100));
  });

  it("skips the sUSDS heartbeat snapshot when block timestamp RPC returns null", async () => {
    const mockDb = MockDb.createMockDb();

    const didWrite = await recordSusdsYieldHeartbeatSnapshot(
      heartbeatContext(mockDb, null, WAD),
      300n,
    );

    assert.equal(didWrite, false);
    assert.equal(dailySnapshots(mockDb).length, 0);
  });

  it("uses the first post-launch sUSDS daily snapshot as the delta baseline", async () => {
    let mockDb = MockDb.createMockDb();
    const beforeLaunch = Number(V3_REVENUE_LAUNCH_TIMESTAMP - 3_600n);
    const launchDay = V3_REVENUE_LAUNCH_TIMESTAMP;

    setSharePrice(100, WAD);
    mockDb = await deposit(
      mockDb,
      100,
      0,
      dollars(1000),
      dollars(1000),
      beforeLaunch,
    );

    await recordSusdsYieldDailySnapshot(
      dailySnapshotContext(mockDb),
      {
        chainId: ETHEREUM_CHAIN_ID,
        blockNumber: 200n,
        blockTimestamp: launchDay + 3_600n,
      },
      dollars(110) / 100n,
    );

    const rows = dailySnapshots(mockDb);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.totalEarnedYieldUsdWei, dollars(100));
    assert.equal(rows[0]?.dailyEarnedYieldUsdWei, 0n);
    assert.equal(rows[0]?.dailyUnrealizedYieldUsdWei, 0n);
  });

  it("does not write daily snapshots before the v3 revenue cutoff", async () => {
    let mockDb = MockDb.createMockDb();

    setSharePrice(100, WAD);
    mockDb = await deposit(
      mockDb,
      100,
      0,
      dollars(1000),
      dollars(1000),
      Number(V3_REVENUE_LAUNCH_TIMESTAMP - 60n),
    );

    assert.equal(dailySnapshots(mockDb).length, 0);
  });
});
