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
  ETHEREUM_CHAIN_ID,
  FIRST_TRACKED_STETH_BLOCK,
  FIRST_TRACKED_STETH_TX,
  STETH_ADDRESS,
  TRACKED_STETH_WALLETS,
  V3_REVENUE_LAUNCH_BLOCK,
  V3_REVENUE_LAUNCH_TIMESTAMP,
} from "../src/handlers/steth/shared.ts";
import {
  recordStethWalletLaunchBaselines,
  recordStethYieldDailySnapshots,
} from "../src/handlers/steth/dailySnapshots.ts";
import {
  _clearMockStethBalanceOf,
  _setMockStethBalanceOf,
} from "../src/rpc/steth.ts";
import { stethBalanceOfEffect } from "../src/rpc/effects.ts";
import { ZERO_ADDRESS } from "../src/constants.ts";

type MockDb = MockDbWith<{
  StethCostBasisLot: EntityCollection;
  StethWalletLaunchBaseline: WritableEntity & EntityCollection;
  StethPosition: WritableEntity & EntityReader;
  StethYieldDailySnapshot: WritableEntity & EntityCollection;
  StethYieldMovement: EntityCollection;
  StethYieldSummary: WritableEntity & EntityReader;
}>;

const TestHelpers = indexerTestHelpers<MockDb>();
const { MockDb, Steth } = TestHelpers;

const WAD = 10n ** 18n;
const RESERVE_SAFE = TRACKED_STETH_WALLETS[0];
const OPS_SAFE = TRACKED_STETH_WALLETS[1];
const EXTERNAL = "0x0000000000000000000000000000000000000abc";
const describeReserveYield =
  process.env.RESERVE_YIELD_EVENT_TESTS === "1" ? describe : describe.skip;

function steth(value: number): bigint {
  return BigInt(value) * WAD;
}

function dayAfterLaunch(day: number): bigint {
  return V3_REVENUE_LAUNCH_TIMESTAMP + BigInt(day) * 86_400n;
}

function txHash(index: number): string {
  return `0x${index.toString(16).padStart(64, "0")}`;
}

function mockData(
  blockNumber: number,
  logIndex: number,
  blockTimestamp = 1_700_000_000 + blockNumber,
  hash = txHash(logIndex + blockNumber),
) {
  return createMockEventData({
    chainId: ETHEREUM_CHAIN_ID,
    srcAddress: STETH_ADDRESS,
    blockNumber,
    blockTimestamp,
    logIndex,
    transaction: { hash },
  });
}

async function transfer(
  mockDb: MockDb,
  blockNumber: number,
  logIndex: number,
  from: string,
  to: string,
  value: bigint,
  blockTimestamp?: number,
  hash?: string,
): Promise<MockDb> {
  const event = Steth.Transfer.createMockEvent({
    from,
    to,
    value,
    mockEventData: mockData(blockNumber, logIndex, blockTimestamp, hash),
  });
  return Steth.Transfer.processEvent({ event, mockDb });
}

function summary(mockDb: MockDb) {
  const row = mockDb.entities.StethYieldSummary.get("1-steth") as
    | Record<string, bigint | number | string | string[]>
    | undefined;
  assert.ok(row, "expected StethYieldSummary row");
  return row;
}

function stethSnapshotContext(
  mockDb: MockDb,
  balances: Record<string, bigint | null>,
): Parameters<typeof recordStethYieldDailySnapshots>[0] {
  return {
    StethPosition: {
      get: async (id: string) => mockDb.entities.StethPosition.get(id),
      set: (entity: { id: string }) => {
        mockDb.entities.StethPosition.set(entity);
      },
    },
    StethCostBasisLot: {
      set: (entity: { id: string }) => {
        mockDb.entities.StethCostBasisLot.set(entity);
      },
    },
    StethWalletLaunchBaseline: {
      get: async (id: string) =>
        mockDb.entities.StethWalletLaunchBaseline.get(id),
      set: (entity: { id: string }) => {
        mockDb.entities.StethWalletLaunchBaseline.set(entity);
      },
    },
    StethYieldDailySnapshot: {
      get: async (id: string) =>
        mockDb.entities.StethYieldDailySnapshot.get(id),
      set: (entity: { id: string }) => {
        mockDb.entities.StethYieldDailySnapshot.set(entity);
      },
    },
    effect: async (effect, input) => {
      if (effect === stethBalanceOfEffect) {
        const account = input.account.toLowerCase();
        return balances[account] ?? null;
      }
      throw new Error("unexpected effect");
    },
    isPreload: false,
  } as unknown as Parameters<typeof recordStethYieldDailySnapshots>[0];
}

function dailySnapshots(mockDb: MockDb) {
  return mockDb.entities.StethYieldDailySnapshot.getAll() as Array<{
    wallet: string;
    timestamp: bigint;
    balanceAmount: bigint;
    principalAmount: bigint;
    realizedYieldAmount: bigint;
    unrealizedYieldAmount: bigint;
    totalEarnedYieldAmount: bigint;
    dailyEarnedYieldAmount: bigint;
  }>;
}

function walletSnapshot(mockDb: MockDb, wallet: string, timestamp: bigint) {
  const row = dailySnapshots(mockDb).find(
    (snapshot) =>
      snapshot.wallet === wallet && snapshot.timestamp === timestamp,
  );
  assert.ok(row, `expected stETH snapshot for ${wallet} at ${timestamp}`);
  return row;
}

function setStethBalance(
  blockNumber: number | bigint,
  account: string,
  value: bigint | null,
): void {
  _setMockStethBalanceOf({
    chainId: ETHEREUM_CHAIN_ID,
    tokenAddress: STETH_ADDRESS,
    account,
    blockNumber: BigInt(blockNumber),
    value,
  });
}

// Run through `pnpm indexer:reserve-yield:test`, which codegens the dedicated
// chain-1 reserve-yield config before executing these event-level tests.
describeReserveYield("stETH reserve-yield ledger", () => {
  afterEach(() => {
    _clearMockStethBalanceOf();
  });

  it("records the first tracked stETH mint as FIFO principal", async () => {
    let mockDb = MockDb.createMockDb();

    mockDb = await transfer(
      mockDb,
      FIRST_TRACKED_STETH_BLOCK,
      355,
      ZERO_ADDRESS,
      RESERVE_SAFE,
      1809999999999999999998n,
      1_706_525_367,
      FIRST_TRACKED_STETH_TX,
    );

    const reservePosition = mockDb.entities.StethPosition.get(
      `1-${RESERVE_SAFE}`,
    ) as { balance: bigint; principalAmount: bigint };
    assert.equal(reservePosition.balance, 1809999999999999999998n);
    assert.equal(reservePosition.principalAmount, 1809999999999999999998n);
    assert.equal(mockDb.entities.StethCostBasisLot.getAll().length, 1);
    assert.deepEqual(summary(mockDb), {
      id: "1-steth",
      chainId: 1,
      token: STETH_ADDRESS,
      trackedWallets: [...TRACKED_STETH_WALLETS],
      currentBalance: 1809999999999999999998n,
      remainingPrincipalAmount: 1809999999999999999998n,
      realizedYieldAmount: 0n,
      transferredOutYieldAmount: 0n,
      unrealizedYieldAmount: 0n,
      totalEarnedYieldAmount: 0n,
      lastMovementTxHash: FIRST_TRACKED_STETH_TX,
      lastUpdatedBlock: BigInt(FIRST_TRACKED_STETH_BLOCK),
      lastUpdatedTimestamp: 1_706_525_367n,
    });
  });

  it("counts transfer-out excess over remaining FIFO principal as earned stETH", async () => {
    let mockDb = MockDb.createMockDb();

    mockDb = await transfer(mockDb, 100, 1, EXTERNAL, RESERVE_SAFE, steth(100));
    mockDb = await transfer(mockDb, 101, 2, RESERVE_SAFE, EXTERNAL, steth(110));

    const movements = mockDb.entities.StethYieldMovement.getAll() as Array<{
      kind: string;
      amount: bigint;
      principalAmount: bigint;
      yieldAmount: bigint;
    }>;
    assert.equal(movements.length, 2);
    assert.deepEqual(movements[1], {
      id: "1_101_2",
      chainId: 1,
      kind: "transfer_out",
      from: RESERVE_SAFE,
      to: EXTERNAL,
      amount: steth(110),
      principalAmount: steth(100),
      yieldAmount: steth(10),
      txHash: txHash(103),
      blockNumber: 101n,
      blockTimestamp: 1_700_000_101n,
    });
    assert.equal(summary(mockDb).realizedYieldAmount, steth(10));
    assert.equal(summary(mockDb).transferredOutYieldAmount, steth(10));
    assert.equal(summary(mockDb).remainingPrincipalAmount, 0n);
  });

  it("moves principal between tracked wallets without realizing yield", async () => {
    let mockDb = MockDb.createMockDb();

    mockDb = await transfer(mockDb, 100, 1, EXTERNAL, RESERVE_SAFE, steth(100));
    mockDb = await transfer(mockDb, 101, 2, RESERVE_SAFE, OPS_SAFE, steth(40));

    const reservePosition = mockDb.entities.StethPosition.get(
      `1-${RESERVE_SAFE}`,
    ) as { balance: bigint; principalAmount: bigint };
    const opsPosition = mockDb.entities.StethPosition.get(`1-${OPS_SAFE}`) as {
      balance: bigint;
      principalAmount: bigint;
    };
    assert.equal(reservePosition.balance, steth(60));
    assert.equal(reservePosition.principalAmount, steth(60));
    assert.equal(opsPosition.balance, steth(40));
    assert.equal(opsPosition.principalAmount, steth(40));
    assert.equal(summary(mockDb).realizedYieldAmount, 0n);
    assert.equal(summary(mockDb).remainingPrincipalAmount, steth(100));
  });

  it("rejects tracked outflows when position principal is not backed by FIFO lots", async () => {
    const mockDb = MockDb.createMockDb();
    mockDb.entities.StethPosition.set({
      id: `1-${RESERVE_SAFE}`,
      chainId: 1,
      wallet: RESERVE_SAFE,
      balance: steth(100),
      principalAmount: steth(100),
      realizedYieldAmount: 0n,
      transferredOutYieldAmount: 0n,
      lastUpdatedBlock: 99n,
      lastUpdatedTimestamp: 1_700_000_099n,
    });

    await assert.rejects(
      transfer(mockDb, 100, 1, RESERVE_SAFE, EXTERNAL, steth(40)),
    );
    assert.equal(mockDb.entities.StethYieldMovement.getAll().length, 0);
    assert.equal(mockDb.entities.StethYieldSummary.get("1-steth"), undefined);
  });

  it("rejects internal transfers when position principal is not backed by FIFO lots", async () => {
    const mockDb = MockDb.createMockDb();
    mockDb.entities.StethPosition.set({
      id: `1-${RESERVE_SAFE}`,
      chainId: 1,
      wallet: RESERVE_SAFE,
      balance: steth(100),
      principalAmount: steth(100),
      realizedYieldAmount: 0n,
      transferredOutYieldAmount: 0n,
      lastUpdatedBlock: 99n,
      lastUpdatedTimestamp: 1_700_000_099n,
    });

    await assert.rejects(
      transfer(mockDb, 100, 1, RESERVE_SAFE, OPS_SAFE, steth(40)),
    );
    assert.equal(mockDb.entities.StethYieldMovement.getAll().length, 0);
    assert.equal(mockDb.entities.StethCostBasisLot.getAll().length, 0);
    assert.equal(mockDb.entities.StethYieldSummary.get("1-steth"), undefined);
  });

  it("ignores transfers that do not touch tracked wallets", async () => {
    const mockDb = await transfer(
      MockDb.createMockDb(),
      100,
      1,
      EXTERNAL,
      "0x0000000000000000000000000000000000000def",
      steth(1),
    );

    assert.equal(mockDb.entities.StethYieldMovement.getAll().length, 0);
    assert.equal(mockDb.entities.StethYieldSummary.get("1-steth"), undefined);
  });

  it("baselines pre-launch rebases as principal before daily actuals accrue", async () => {
    let mockDb = MockDb.createMockDb();
    mockDb = await transfer(mockDb, 100, 1, EXTERNAL, RESERVE_SAFE, steth(100));

    const context = stethSnapshotContext(mockDb, {
      [RESERVE_SAFE]: steth(110),
      [OPS_SAFE]: 0n,
    });
    assert.equal(
      await recordStethWalletLaunchBaselines(
        context,
        V3_REVENUE_LAUNCH_TIMESTAMP - 1n,
      ),
      true,
    );

    const baseline = mockDb.entities.StethWalletLaunchBaseline.get(
      `1-steth-${RESERVE_SAFE}-launch`,
    ) as {
      balanceAmount: bigint;
      principalTopUpAmount: bigint;
      realizedYieldAmountAtLaunch: bigint;
    };
    assert.equal(baseline.balanceAmount, steth(110));
    assert.equal(baseline.principalTopUpAmount, steth(10));
    assert.equal(baseline.realizedYieldAmountAtLaunch, 0n);

    const reservePosition = mockDb.entities.StethPosition.get(
      `1-${RESERVE_SAFE}`,
    ) as { balance: bigint; principalAmount: bigint };
    assert.equal(reservePosition.balance, steth(110));
    assert.equal(reservePosition.principalAmount, steth(110));
    assert.equal(
      walletSnapshot(mockDb, RESERVE_SAFE, V3_REVENUE_LAUNCH_TIMESTAMP)
        .totalEarnedYieldAmount,
      0n,
    );

    const day1 = dayAfterLaunch(1);
    assert.equal(
      await recordStethYieldDailySnapshots(
        stethSnapshotContext(mockDb, {
          [RESERVE_SAFE]: steth(112),
          [OPS_SAFE]: 0n,
        }),
        {
          chainId: ETHEREUM_CHAIN_ID,
          blockNumber: BigInt(V3_REVENUE_LAUNCH_BLOCK + 7_200),
          blockTimestamp: day1,
        },
      ),
      true,
    );
    const snapshot = walletSnapshot(mockDb, RESERVE_SAFE, day1);
    assert.equal(snapshot.principalAmount, steth(110));
    assert.equal(snapshot.totalEarnedYieldAmount, steth(2));
    assert.equal(snapshot.dailyEarnedYieldAmount, steth(2));
  });

  it("keeps post-launch stETH yield with the source wallet after an internal transfer", async () => {
    let mockDb = MockDb.createMockDb();
    mockDb = await transfer(mockDb, 100, 1, EXTERNAL, RESERVE_SAFE, steth(100));

    await recordStethWalletLaunchBaselines(
      stethSnapshotContext(mockDb, {
        [RESERVE_SAFE]: steth(100),
        [OPS_SAFE]: 0n,
      }),
      V3_REVENUE_LAUNCH_TIMESTAMP - 1n,
    );

    const day1 = dayAfterLaunch(1);
    await recordStethYieldDailySnapshots(
      stethSnapshotContext(mockDb, {
        [RESERVE_SAFE]: steth(110),
        [OPS_SAFE]: 0n,
      }),
      {
        chainId: ETHEREUM_CHAIN_ID,
        blockNumber: BigInt(V3_REVENUE_LAUNCH_BLOCK + 7_200),
        blockTimestamp: day1,
      },
    );

    const transferBlock = V3_REVENUE_LAUNCH_BLOCK + 14_400;
    setStethBalance(transferBlock, RESERVE_SAFE, steth(60));
    setStethBalance(transferBlock, OPS_SAFE, steth(50));
    mockDb = await transfer(
      mockDb,
      transferBlock,
      2,
      RESERVE_SAFE,
      OPS_SAFE,
      steth(50),
      Number(dayAfterLaunch(2)),
    );

    const day2 = dayAfterLaunch(2);
    await recordStethYieldDailySnapshots(
      stethSnapshotContext(mockDb, {
        [RESERVE_SAFE]: steth(60),
        [OPS_SAFE]: steth(50),
      }),
      {
        chainId: ETHEREUM_CHAIN_ID,
        blockNumber: BigInt(transferBlock),
        blockTimestamp: day2,
      },
    );
    const reserveSnapshot = walletSnapshot(mockDb, RESERVE_SAFE, day2);
    const opsSnapshot = walletSnapshot(mockDb, OPS_SAFE, day2);

    assert.equal(reserveSnapshot.balanceAmount, steth(60));
    assert.equal(reserveSnapshot.principalAmount, steth(50));
    assert.equal(reserveSnapshot.totalEarnedYieldAmount, steth(10));
    assert.equal(reserveSnapshot.dailyEarnedYieldAmount, 0n);
    assert.equal(opsSnapshot.balanceAmount, steth(50));
    assert.equal(opsSnapshot.principalAmount, steth(50));
    assert.equal(opsSnapshot.totalEarnedYieldAmount, 0n);
  });

  it("skips stETH daily snapshots when a historical balance read is unavailable", async () => {
    let mockDb = MockDb.createMockDb();
    mockDb = await transfer(mockDb, 100, 1, EXTERNAL, RESERVE_SAFE, steth(100));

    await recordStethWalletLaunchBaselines(
      stethSnapshotContext(mockDb, {
        [RESERVE_SAFE]: steth(100),
        [OPS_SAFE]: 0n,
      }),
      V3_REVENUE_LAUNCH_TIMESTAMP - 1n,
    );
    const before = dailySnapshots(mockDb).length;

    assert.equal(
      await recordStethYieldDailySnapshots(
        stethSnapshotContext(mockDb, {
          [RESERVE_SAFE]: steth(101),
          [OPS_SAFE]: null,
        }),
        {
          chainId: ETHEREUM_CHAIN_ID,
          blockNumber: BigInt(V3_REVENUE_LAUNCH_BLOCK + 7_200),
          blockTimestamp: dayAfterLaunch(1),
        },
      ),
      false,
    );
    assert.equal(dailySnapshots(mockDb).length, before);
  });

  it("skips the stETH snapshot batch when a tracked wallet baseline is missing", async () => {
    let mockDb = MockDb.createMockDb();
    mockDb = await transfer(mockDb, 100, 1, EXTERNAL, RESERVE_SAFE, steth(100));
    mockDb.entities.StethWalletLaunchBaseline.set({
      id: `1-steth-${RESERVE_SAFE}-launch`,
      chainId: ETHEREUM_CHAIN_ID,
      token: STETH_ADDRESS,
      wallet: RESERVE_SAFE,
      launchBlock: BigInt(V3_REVENUE_LAUNCH_BLOCK),
      launchTimestamp: V3_REVENUE_LAUNCH_TIMESTAMP,
      balanceAmount: steth(100),
      principalTopUpAmount: 0n,
      realizedYieldAmountAtLaunch: 0n,
      transferredOutYieldAmountAtLaunch: 0n,
      sampledAtBlock: BigInt(V3_REVENUE_LAUNCH_BLOCK),
      sampledAtTimestamp: V3_REVENUE_LAUNCH_TIMESTAMP - 1n,
    });

    assert.equal(
      await recordStethYieldDailySnapshots(
        stethSnapshotContext(mockDb, {
          [RESERVE_SAFE]: steth(101),
          [OPS_SAFE]: 0n,
        }),
        {
          chainId: ETHEREUM_CHAIN_ID,
          blockNumber: BigInt(V3_REVENUE_LAUNCH_BLOCK + 7_200),
          blockTimestamp: dayAfterLaunch(1),
        },
      ),
      false,
    );
    assert.equal(dailySnapshots(mockDb).length, 0);
  });
});
