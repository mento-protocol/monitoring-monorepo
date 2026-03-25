/// <reference types="mocha" />
/**
 * Tests for LP-triggered swap classification (isLpSwap flag).
 *
 * When a Mint or Burn fires in the same transaction as a Swap, the swap
 * is an internal LP rebalance — not a user trade. The backfillLpSwap
 * helper must:
 *   1. Mark the SwapEvent.isLpSwap = true
 *   2. Subtract the swap volume from Pool.swapCount / notionalVolume0/1
 *   3. Subtract from PoolSnapshot.swapCount / swapVolume0/1 / cumulative fields
 *   4. Be idempotent (double-calling must not double-subtract)
 *
 * Note: tests require `pnpm codegen` to have been run first to generate
 * the TestHelpers module from schema.graphql.
 */
import { assert } from "chai";
import generated from "generated";
import { _setMockReserves, _clearMockReserves } from "../src/EventHandlers.ts";

// ---------------------------------------------------------------------------
// Shared types (local copies of what generated module provides)
// ---------------------------------------------------------------------------

type MockDb = {
  entities: {
    FactoryDeployment: { get: (id: string) => unknown };
    Pool: {
      get: (id: string) => unknown;
      set: (entity: unknown) => MockDb;
    };
    SwapEvent: { get: (id: string) => unknown };
    SwapTxIndex: { get: (id: string) => unknown };
    LiquidityEvent: { get: (id: string) => unknown };
    PoolSnapshot: { get: (id: string) => unknown };
  };
};

type GeneratedModule = {
  TestHelpers: {
    MockDb: { createMockDb: () => MockDb };
    FPMMFactory: {
      FPMMDeployed: {
        createMockEvent: (args: unknown) => unknown;
        processEvent: (args: {
          event: unknown;
          mockDb: MockDb;
        }) => Promise<MockDb>;
      };
    };
    FPMM: {
      Swap: {
        createMockEvent: (args: unknown) => unknown;
        processEvent: (args: {
          event: unknown;
          mockDb: MockDb;
        }) => Promise<MockDb>;
      };
      Mint: {
        createMockEvent: (args: unknown) => unknown;
        processEvent: (args: {
          event: unknown;
          mockDb: MockDb;
        }) => Promise<MockDb>;
      };
      Burn: {
        createMockEvent: (args: unknown) => unknown;
        processEvent: (args: {
          event: unknown;
          mockDb: MockDb;
        }) => Promise<MockDb>;
      };
      UpdateReserves: {
        createMockEvent: (args: unknown) => unknown;
        processEvent: (args: {
          event: unknown;
          mockDb: MockDb;
        }) => Promise<MockDb>;
      };
    };
  };
};

const { TestHelpers } = generated as unknown as GeneratedModule;
const { MockDb, FPMMFactory, FPMM } = TestHelpers;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const POOL_ADDR = "0x00000000000000000000000000000000000000f0";
const CHAIN_ID = 42220;
const TX_HASH =
  "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

type SwapEventEntity = {
  id: string;
  poolId: string;
  isLpSwap: boolean;
  amount0In: bigint;
  amount0Out: bigint;
  amount1In: bigint;
  amount1Out: bigint;
  txHash: string;
  [key: string]: unknown;
};

type SwapTxIndexEntity = {
  id: string;
  swapEventId: string;
};

type PoolEntity = {
  id: string;
  swapCount: number;
  notionalVolume0: bigint;
  notionalVolume1: bigint;
  [key: string]: unknown;
};

type SnapshotEntity = {
  id: string;
  swapCount: number;
  swapVolume0: bigint;
  swapVolume1: bigint;
  cumulativeSwapCount: number;
  cumulativeVolume0: bigint;
  cumulativeVolume1: bigint;
  [key: string]: unknown;
};

/** Deploy a pool and return the seeded MockDb. */
async function deployPool(
  chainId = CHAIN_ID,
  poolAddr = POOL_ADDR,
): Promise<MockDb> {
  let mockDb = MockDb.createMockDb();
  const deployEvent = FPMMFactory.FPMMDeployed.createMockEvent({
    token0: "0x0000000000000000000000000000000000000003",
    token1: "0x0000000000000000000000000000000000000004",
    fpmmProxy: poolAddr,
    fpmmImplementation: "0x00000000000000000000000000000000000000bc",
    mockEventData: {
      chainId,
      logIndex: 1,
      srcAddress: "0x00000000000000000000000000000000000000cc",
      block: { number: 1000, timestamp: 1_700_000_000 },
    },
  });
  return FPMMFactory.FPMMDeployed.processEvent({ event: deployEvent, mockDb });
}

/** Fire UpdateReserves → Swap in the same block/tx, return updated MockDb. */
async function fireSwap(
  mockDb: MockDb,
  opts: {
    chainId?: number;
    poolAddr?: string;
    txHash?: string;
    blockNumber?: number;
    timestamp?: number;
    logIndexReserves?: number;
    logIndexSwap?: number;
    amount0In?: bigint;
    amount1Out?: bigint;
  } = {},
): Promise<MockDb> {
  const {
    chainId = CHAIN_ID,
    poolAddr = POOL_ADDR,
    txHash = TX_HASH,
    blockNumber = 1001,
    timestamp = 1_700_001_000,
    logIndexReserves = 10,
    logIndexSwap = 11,
    amount0In = 1_000_000_000_000_000_000n,
    amount1Out = 2_000_000_000_000_000_000n,
  } = opts;

  const updateEvent = FPMM.UpdateReserves.createMockEvent({
    reserve0: 50_000_000_000_000_000_000_000n,
    reserve1: 70_000_000_000_000_000_000_000n,
    blockTimestamp: BigInt(timestamp),
    mockEventData: {
      chainId,
      logIndex: logIndexReserves,
      srcAddress: poolAddr,
      block: { number: blockNumber, timestamp },
    },
  });
  mockDb = await FPMM.UpdateReserves.processEvent({
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
      chainId,
      logIndex: logIndexSwap,
      srcAddress: poolAddr,
      transaction: { hash: txHash },
      block: { number: blockNumber, timestamp },
    },
  });
  return FPMM.Swap.processEvent({ event: swapEvent, mockDb });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LP swap classification — isLpSwap + volume backfill", () => {
  afterEach(() => {
    _clearMockReserves();
  });

  // ---- standalone swap (no LP event) ----------------------------------------

  it("Swap with no Mint/Burn: isLpSwap=false, SwapTxIndex written", async () => {
    let mockDb = await deployPool();
    mockDb = await fireSwap(mockDb);

    // SwapEvent must exist with isLpSwap=false
    // id format: "{chainId}:{blockNumber}:{logIndex}"
    const swapEntity = mockDb.entities.SwapEvent.get(`${CHAIN_ID}:1001:11`) as
      | SwapEventEntity
      | undefined;
    assert.ok(swapEntity, "SwapEvent must be written");
    assert.strictEqual(swapEntity!.isLpSwap, false, "isLpSwap must be false");

    // SwapTxIndex must exist
    const indexId = `${CHAIN_ID}:${POOL_ADDR}:${TX_HASH}:11`;
    const indexEntity = mockDb.entities.SwapTxIndex.get(indexId) as
      | SwapTxIndexEntity
      | undefined;
    assert.ok(indexEntity, "SwapTxIndex must be written");
    assert.strictEqual(
      indexEntity!.swapEventId,
      `${CHAIN_ID}:1001:11`,
      "SwapTxIndex.swapEventId must point to the swap",
    );

    // Pool must count the swap as a trade
    const pool = mockDb.entities.Pool.get(POOL_ADDR) as PoolEntity | undefined;
    assert.ok(pool, "Pool must exist");
    assert.strictEqual(pool!.swapCount, 1, "swapCount must be 1");
  });

  // ---- Mint in same tx as Swap -----------------------------------------------

  it("Mint in same tx: marks swap isLpSwap=true, subtracts from Pool metrics", async () => {
    let mockDb = await deployPool();
    mockDb = await fireSwap(mockDb, { amount0In: 1_000n, amount1Out: 2_000n });

    const poolBeforeMint = mockDb.entities.Pool.get(POOL_ADDR) as
      | PoolEntity
      | undefined;
    assert.ok(poolBeforeMint, "Pool must exist");
    assert.strictEqual(
      poolBeforeMint!.swapCount,
      1,
      "swapCount must be 1 before Mint",
    );

    // Mint in the same transaction
    const mintEvent = FPMM.Mint.createMockEvent({
      sender: "0x0000000000000000000000000000000000000033",
      to: "0x0000000000000000000000000000000000000044",
      amount0: 5_000n,
      amount1: 5_000n,
      liquidity: 10_000n,
      mockEventData: {
        chainId: CHAIN_ID,
        logIndex: 12,
        srcAddress: POOL_ADDR,
        transaction: { hash: TX_HASH },
        block: { number: 1001, timestamp: 1_700_001_000 },
      },
    });
    mockDb = await FPMM.Mint.processEvent({ event: mintEvent, mockDb });

    // SwapEvent must now be marked as LP swap
    const swapEntity = mockDb.entities.SwapEvent.get(`${CHAIN_ID}:1001:11`) as
      | SwapEventEntity
      | undefined;
    assert.ok(swapEntity, "SwapEvent must still exist");
    assert.strictEqual(
      swapEntity!.isLpSwap,
      true,
      "isLpSwap must be backfilled to true after Mint",
    );

    // Pool.swapCount must be rolled back to 0
    const pool = mockDb.entities.Pool.get(POOL_ADDR) as PoolEntity | undefined;
    assert.ok(pool, "Pool must exist");
    assert.strictEqual(
      pool!.swapCount,
      0,
      "Pool.swapCount must be subtracted back to 0",
    );
    assert.strictEqual(
      pool!.notionalVolume0,
      0n,
      "Pool.notionalVolume0 must be subtracted back to 0",
    );
    assert.strictEqual(
      pool!.notionalVolume1,
      0n,
      "Pool.notionalVolume1 must be subtracted back to 0",
    );
  });

  // ---- Burn in same tx as Swap -----------------------------------------------

  it("Burn in same tx: marks swap isLpSwap=true, subtracts from Pool metrics", async () => {
    let mockDb = await deployPool();
    mockDb = await fireSwap(mockDb, {
      amount0In: 0n,
      amount1Out: 0n, // amount1In=500, amount0Out=300 scenario
    });

    // Burn in the same tx
    const burnEvent = FPMM.Burn.createMockEvent({
      sender: "0x0000000000000000000000000000000000000033",
      to: "0x0000000000000000000000000000000000000044",
      amount0: 300n,
      amount1: 500n,
      liquidity: 800n,
      mockEventData: {
        chainId: CHAIN_ID,
        logIndex: 12,
        srcAddress: POOL_ADDR,
        transaction: { hash: TX_HASH },
        block: { number: 1001, timestamp: 1_700_001_000 },
      },
    });
    mockDb = await FPMM.Burn.processEvent({ event: burnEvent, mockDb });

    const swapEntity = mockDb.entities.SwapEvent.get(`${CHAIN_ID}:1001:11`) as
      | SwapEventEntity
      | undefined;
    assert.ok(swapEntity, "SwapEvent must exist");
    assert.strictEqual(
      swapEntity!.isLpSwap,
      true,
      "isLpSwap must be backfilled to true after Burn",
    );

    const pool = mockDb.entities.Pool.get(POOL_ADDR) as PoolEntity | undefined;
    assert.ok(pool, "Pool must exist");
    assert.strictEqual(
      pool!.swapCount,
      0,
      "Pool.swapCount must be subtracted back to 0 after Burn",
    );
  });

  // ---- Idempotency: Mint then Burn in same tx --------------------------------

  it("Idempotency: Mint followed by Burn in same tx does NOT double-subtract", async () => {
    let mockDb = await deployPool();
    // Seed pool with prior real trade so swapCount starts at 1
    mockDb = await fireSwap(mockDb, {
      txHash:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      blockNumber: 1001,
      logIndexReserves: 1,
      logIndexSwap: 2,
    });

    // Now LP event with a rebalance swap in the same tx
    mockDb = await fireSwap(mockDb, {
      txHash: TX_HASH,
      blockNumber: 1002,
      timestamp: 1_700_002_000,
      logIndexReserves: 10,
      logIndexSwap: 11,
      amount0In: 500n,
      amount1Out: 1_000n,
    });

    const poolBeforeLp = mockDb.entities.Pool.get(POOL_ADDR) as
      | PoolEntity
      | undefined;
    assert.ok(poolBeforeLp);
    assert.strictEqual(
      poolBeforeLp!.swapCount,
      2,
      "Pool.swapCount must be 2 (two swaps) before LP events",
    );

    // Mint fires first
    const mintEvent = FPMM.Mint.createMockEvent({
      sender: "0x0000000000000000000000000000000000000033",
      to: "0x0000000000000000000000000000000000000044",
      amount0: 5_000n,
      amount1: 5_000n,
      liquidity: 10_000n,
      mockEventData: {
        chainId: CHAIN_ID,
        logIndex: 12,
        srcAddress: POOL_ADDR,
        transaction: { hash: TX_HASH },
        block: { number: 1002, timestamp: 1_700_002_000 },
      },
    });
    mockDb = await FPMM.Mint.processEvent({ event: mintEvent, mockDb });

    const afterMint = mockDb.entities.Pool.get(POOL_ADDR) as
      | PoolEntity
      | undefined;
    assert.ok(afterMint);
    assert.strictEqual(
      afterMint!.swapCount,
      1,
      "After Mint backfill, swapCount must be 1 (only the prior real trade)",
    );

    // Burn fires second in the same tx — backfill must be a no-op (idempotent)
    const burnEvent = FPMM.Burn.createMockEvent({
      sender: "0x0000000000000000000000000000000000000033",
      to: "0x0000000000000000000000000000000000000044",
      amount0: 5_000n,
      amount1: 5_000n,
      liquidity: 10_000n,
      mockEventData: {
        chainId: CHAIN_ID,
        logIndex: 13,
        srcAddress: POOL_ADDR,
        transaction: { hash: TX_HASH },
        block: { number: 1002, timestamp: 1_700_002_000 },
      },
    });
    mockDb = await FPMM.Burn.processEvent({ event: burnEvent, mockDb });

    const afterBurn = mockDb.entities.Pool.get(POOL_ADDR) as
      | PoolEntity
      | undefined;
    assert.ok(afterBurn);
    assert.strictEqual(
      afterBurn!.swapCount,
      1,
      "After Burn in same tx (idempotency check), swapCount must still be 1 — not double-subtracted",
    );
  });

  // ---- User trade does NOT get flagged ---------------------------------------

  it("Swap with NO Mint/Burn in same tx remains isLpSwap=false (user trade)", async () => {
    let mockDb = await deployPool();
    mockDb = await fireSwap(mockDb, {
      txHash:
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });

    const swapEntity = mockDb.entities.SwapEvent.get(`${CHAIN_ID}:1001:11`) as
      | SwapEventEntity
      | undefined;
    assert.ok(swapEntity, "SwapEvent must exist");
    assert.strictEqual(
      swapEntity!.isLpSwap,
      false,
      "A swap without Mint/Burn must remain isLpSwap=false",
    );

    const pool = mockDb.entities.Pool.get(POOL_ADDR) as PoolEntity | undefined;
    assert.ok(pool, "Pool must exist");
    assert.strictEqual(
      pool!.swapCount,
      1,
      "Pool.swapCount must remain 1 for a user trade",
    );
  });
});

// ---------------------------------------------------------------------------
// Multicall regression: user swap + LP rebalance swap in same tx
// An external contract calls FPMM.swap() at logIndex 9, then FPMM.mint()
// at logIndex 13. mint() triggers an internal rebalance which emits
// Swap at logIndex 12 and Mint at logIndex 13.
// Only the swap at logIndex 12 (= mintLogIndex - 1) must be classified as
// LP-triggered; the user swap at logIndex 9 must remain isLpSwap=false.
// ---------------------------------------------------------------------------

describe("LP swap classification — multicall edge case", () => {
  afterEach(() => {
    _clearMockReserves();
  });

  it("only the directly preceding swap (logIndex - 1) is classified as LP-triggered", async () => {
    let mockDb = await deployPool();

    // User swap at logIndex 9 (earlier in the same tx)
    mockDb = await fireSwap(mockDb, {
      txHash: TX_HASH,
      blockNumber: 1001,
      timestamp: 1_700_001_000,
      logIndexReserves: 8,
      logIndexSwap: 9,
      amount0In: 3_000n,
      amount1Out: 6_000n,
    });

    // Internal LP rebalance swap at logIndex 12 (directly before Mint at 13)
    mockDb = await fireSwap(mockDb, {
      txHash: TX_HASH,
      blockNumber: 1001,
      timestamp: 1_700_001_000,
      logIndexReserves: 11,
      logIndexSwap: 12,
      amount0In: 500n,
      amount1Out: 1_000n,
    });

    // Mint at logIndex 13 — backfill must only touch logIndex 12
    const mintEvent = FPMM.Mint.createMockEvent({
      sender: "0x0000000000000000000000000000000000000033",
      to: "0x0000000000000000000000000000000000000044",
      amount0: 5_000n,
      amount1: 5_000n,
      liquidity: 10_000n,
      mockEventData: {
        chainId: CHAIN_ID,
        logIndex: 13,
        srcAddress: POOL_ADDR,
        transaction: { hash: TX_HASH },
        block: { number: 1001, timestamp: 1_700_001_000 },
      },
    });
    mockDb = await FPMM.Mint.processEvent({ event: mintEvent, mockDb });

    // Swap at logIndex 12 must be isLpSwap=true
    const lpSwap = mockDb.entities.SwapEvent.get(`${CHAIN_ID}:1001:12`) as
      | SwapEventEntity
      | undefined;
    assert.ok(lpSwap, "LP rebalance SwapEvent must exist");
    assert.strictEqual(
      lpSwap!.isLpSwap,
      true,
      "Swap at logIndex 12 (directly before Mint at 13) must be isLpSwap=true",
    );

    // User swap at logIndex 9 must remain isLpSwap=false
    const userSwap = mockDb.entities.SwapEvent.get(`${CHAIN_ID}:1001:9`) as
      | SwapEventEntity
      | undefined;
    assert.ok(userSwap, "User SwapEvent must exist");
    assert.strictEqual(
      userSwap!.isLpSwap,
      false,
      "User swap at logIndex 9 (not adjacent to Mint) must remain isLpSwap=false",
    );

    // Pool.swapCount must be 1 — user trade counted, LP rebalance subtracted
    const pool = mockDb.entities.Pool.get(POOL_ADDR) as PoolEntity | undefined;
    assert.ok(pool);
    assert.strictEqual(
      pool!.swapCount,
      1,
      "Pool.swapCount must be 1 (user trade counted, LP rebalance subtracted)",
    );
  });
});
