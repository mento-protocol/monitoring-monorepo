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
} from "../src/EventHandlers.ts";
import {
  ETHEREUM_CHAIN_ID,
  SUSDS_ADDRESS,
  TRACKED_SUSDS_WALLETS,
  V3_REVENUE_LAUNCH_TIMESTAMP,
  recordSusdsYieldDailySnapshot,
} from "../src/handlers/susds.ts";
import { ZERO_ADDRESS } from "../src/constants.ts";

type MockDb = MockDbWith<{
  SusdsCostBasisLot: EntityCollection;
  SusdsPosition: WritableEntity & EntityReader;
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
    totalEarnedYieldUsdWei: bigint;
    dailyEarnedYieldUsdWei: bigint;
    dailyRealizedYieldUsdWei: bigint;
    dailyUnrealizedYieldUsdWei: bigint;
    sampledAtBlock: bigint;
  }>;
}

function dailySnapshotContext(
  mockDb: MockDb,
): Parameters<typeof recordSusdsYieldDailySnapshot>[0] {
  return {
    SusdsPosition: {
      get: async (id: string) => mockDb.entities.SusdsPosition.get(id),
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

describe("sUSDS reserve yield accounting", () => {
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
