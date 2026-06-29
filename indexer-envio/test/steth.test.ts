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
} from "../src/handlers/steth/shared.ts";
import { ZERO_ADDRESS } from "../src/constants.ts";

type MockDb = MockDbWith<{
  StethCostBasisLot: EntityCollection;
  StethPosition: WritableEntity & EntityReader;
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

// Run through `pnpm indexer:reserve-yield:test`, which codegens the dedicated
// chain-1 reserve-yield config before executing these event-level tests.
describeReserveYield("stETH reserve-yield ledger", () => {
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
});
