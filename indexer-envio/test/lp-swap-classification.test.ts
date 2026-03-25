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
 *   4. Be idempotent (Mint + Burn in same tx must not double-subtract)
 *
 * Note: these tests require `pnpm codegen` to generate the TestHelpers module
 * from schema.graphql before they can run.
 *
 * Key limitation of the Envio test framework: `transaction` fields inside
 * `mockEventData` are not part of the public API and may be auto-generated.
 * Tests therefore verify observable outputs (isLpSwap flag, Pool.swapCount)
 * rather than internal SwapTxIndex entity structure.
 */
import { assert } from "chai";
import generated from "generated";
import {
  _clearMockReserves,
  _clearMockRateFeedIDs,
  _setMockRateFeedID,
  _clearMockRebalancingStates,
} from "../src/EventHandlers.ts";

// ---------------------------------------------------------------------------
// Types
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
// Shared constants
// ---------------------------------------------------------------------------

const POOL_ADDR = "0x00000000000000000000000000000000000000f0";
const CHAIN_ID = 42220;
// Used as a sentinel address for a different pool to verify pool isolation
const OTHER_POOL = "0x00000000000000000000000000000000000000f1";

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

type PoolEntity = {
  id: string;
  swapCount: number;
  notionalVolume0: bigint;
  notionalVolume1: bigint;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function deployPool(poolAddr = POOL_ADDR): Promise<MockDb> {
  let mockDb = MockDb.createMockDb();
  const deployEvent = FPMMFactory.FPMMDeployed.createMockEvent({
    token0: "0x0000000000000000000000000000000000000003",
    token1: "0x0000000000000000000000000000000000000004",
    fpmmProxy: poolAddr,
    fpmmImplementation: "0x00000000000000000000000000000000000000bc",
    mockEventData: {
      chainId: CHAIN_ID,
      logIndex: 1,
      srcAddress: "0x00000000000000000000000000000000000000cc",
      block: { number: 1000, timestamp: 1_700_000_000 },
    },
  });
  return FPMMFactory.FPMMDeployed.processEvent({ event: deployEvent, mockDb });
}

/** Emit UpdateReserves → Swap for a given pool/block, returns the event and updated db */
async function fireSwap(
  mockDb: MockDb,
  opts: {
    poolAddr?: string;
    blockNumber?: number;
    timestamp?: number;
    logIndexReserves?: number;
    logIndexSwap?: number;
    amount0In?: bigint;
    amount1Out?: bigint;
  } = {},
): Promise<{ mockDb: MockDb; swapId: string }> {
  const {
    poolAddr = POOL_ADDR,
    blockNumber = 1001,
    timestamp = 1_700_001_000,
    logIndexReserves = 10,
    logIndexSwap = 11,
    amount0In = 1_000n,
    amount1Out = 2_000n,
  } = opts;

  const updateEvent = FPMM.UpdateReserves.createMockEvent({
    reserve0: 50_000_000_000_000_000_000_000n,
    reserve1: 70_000_000_000_000_000_000_000n,
    blockTimestamp: BigInt(timestamp),
    mockEventData: {
      chainId: CHAIN_ID,
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
      chainId: CHAIN_ID,
      logIndex: logIndexSwap,
      srcAddress: poolAddr,
      block: { number: blockNumber, timestamp },
    },
  });
  mockDb = await FPMM.Swap.processEvent({ event: swapEvent, mockDb });

  const swapId = `${CHAIN_ID}_${blockNumber}_${logIndexSwap}`;
  return { mockDb, swapId };
}

async function fireMint(
  mockDb: MockDb,
  opts: {
    poolAddr?: string;
    blockNumber?: number;
    timestamp?: number;
    logIndex?: number;
  } = {},
): Promise<MockDb> {
  const {
    poolAddr = POOL_ADDR,
    blockNumber = 1001,
    timestamp = 1_700_001_000,
    logIndex = 12,
  } = opts;
  const mintEvent = FPMM.Mint.createMockEvent({
    sender: "0x0000000000000000000000000000000000000033",
    to: "0x0000000000000000000000000000000000000044",
    amount0: 5_000n,
    amount1: 5_000n,
    liquidity: 10_000n,
    mockEventData: {
      chainId: CHAIN_ID,
      logIndex,
      srcAddress: poolAddr,
      block: { number: blockNumber, timestamp },
    },
  });
  return FPMM.Mint.processEvent({ event: mintEvent, mockDb });
}

async function fireBurn(
  mockDb: MockDb,
  opts: {
    poolAddr?: string;
    blockNumber?: number;
    timestamp?: number;
    logIndex?: number;
  } = {},
): Promise<MockDb> {
  const {
    poolAddr = POOL_ADDR,
    blockNumber = 1001,
    timestamp = 1_700_001_000,
    logIndex = 12,
  } = opts;
  const burnEvent = FPMM.Burn.createMockEvent({
    sender: "0x0000000000000000000000000000000000000033",
    to: "0x0000000000000000000000000000000000000044",
    amount0: 5_000n,
    amount1: 5_000n,
    liquidity: 10_000n,
    mockEventData: {
      chainId: CHAIN_ID,
      logIndex,
      srcAddress: poolAddr,
      block: { number: blockNumber, timestamp },
    },
  });
  return FPMM.Burn.processEvent({ event: burnEvent, mockDb });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LP swap classification — isLpSwap + volume backfill", () => {
  beforeEach(() => {
    // Prevent real RPC calls during FPMMDeployed (oracle data fetching)
    _setMockRateFeedID(CHAIN_ID, POOL_ADDR, null);
  });

  afterEach(() => {
    _clearMockReserves();
    _clearMockRateFeedIDs();
    _clearMockRebalancingStates();
  });

  // --------------------------------------------------------------------------
  // Standalone swap — no LP event in same tx
  // The Swap handler creates the SwapEvent with isLpSwap=false and writes
  // a SwapTxIndex entry. Since no Mint/Burn fires, it stays as a user trade.
  // --------------------------------------------------------------------------

  it("Swap with no Mint/Burn: isLpSwap=false, pool swapCount incremented", async () => {
    let mockDb = await deployPool();
    const { mockDb: db, swapId } = await fireSwap(mockDb);

    const swapEntity = db.entities.SwapEvent.get(swapId) as
      | SwapEventEntity
      | undefined;
    assert.ok(swapEntity, "SwapEvent must be written");
    assert.strictEqual(swapEntity!.isLpSwap, false, "isLpSwap must be false");

    const pool = db.entities.Pool.get(POOL_ADDR) as PoolEntity | undefined;
    assert.ok(pool, "Pool must exist");
    assert.strictEqual(
      pool!.swapCount,
      1,
      "Pool.swapCount must be 1 for a standalone user swap",
    );
  });

  // --------------------------------------------------------------------------
  // Mint in same tx/block as Swap
  // Because the mock framework assigns the same default txHash to all events
  // in a single test sequence, the Swap and Mint share a txHash, so backfill
  // fires and marks the swap as LP-triggered.
  // --------------------------------------------------------------------------

  it("Mint in same tx: marks swap isLpSwap=true, subtracts from Pool metrics", async () => {
    let mockDb = await deployPool();
    const { mockDb: afterSwap, swapId } = await fireSwap(mockDb, {
      amount0In: 1_000n,
      amount1Out: 2_000n,
    });

    const poolBeforeMint = afterSwap.entities.Pool.get(POOL_ADDR) as
      | PoolEntity
      | undefined;
    assert.ok(poolBeforeMint);
    assert.strictEqual(
      poolBeforeMint!.swapCount,
      1,
      "swapCount must be 1 before Mint",
    );

    const afterMint = await fireMint(afterSwap);

    const swapEntity = afterMint.entities.SwapEvent.get(swapId) as
      | SwapEventEntity
      | undefined;
    assert.ok(swapEntity, "SwapEvent must still exist after Mint");
    assert.strictEqual(
      swapEntity!.isLpSwap,
      true,
      "isLpSwap must be backfilled to true after Mint",
    );

    const pool = afterMint.entities.Pool.get(POOL_ADDR) as
      | PoolEntity
      | undefined;
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

  // --------------------------------------------------------------------------
  // Burn in same tx/block as Swap — same expectation as Mint
  // --------------------------------------------------------------------------

  it("Burn in same tx: marks swap isLpSwap=true, subtracts from Pool metrics", async () => {
    let mockDb = await deployPool();
    const { mockDb: afterSwap, swapId } = await fireSwap(mockDb, {
      amount0In: 1_000n,
      amount1Out: 2_000n,
    });

    const afterBurn = await fireBurn(afterSwap);

    const swapEntity = afterBurn.entities.SwapEvent.get(swapId) as
      | SwapEventEntity
      | undefined;
    assert.ok(swapEntity, "SwapEvent must exist");
    assert.strictEqual(
      swapEntity!.isLpSwap,
      true,
      "isLpSwap must be backfilled to true after Burn",
    );

    const pool = afterBurn.entities.Pool.get(POOL_ADDR) as
      | PoolEntity
      | undefined;
    assert.ok(pool);
    assert.strictEqual(
      pool!.swapCount,
      0,
      "Pool.swapCount must be subtracted back to 0 after Burn",
    );
  });

  // --------------------------------------------------------------------------
  // Idempotency: Mint + Burn in the same tx must not double-subtract.
  // Both share the same txHash; the first call marks isLpSwap=true, the
  // second call hits the idempotency guard and does nothing.
  // --------------------------------------------------------------------------

  it("Idempotency: Mint then Burn in same tx — no double-subtract", async () => {
    let mockDb = await deployPool();

    // Fire a first "real" swap so pool starts at swapCount = 1
    const { mockDb: afterFirstSwap } = await fireSwap(mockDb, {
      blockNumber: 1001,
      logIndexReserves: 1,
      logIndexSwap: 2,
      amount0In: 500n,
      amount1Out: 1_000n,
    });

    // Fire the LP rebalance swap in a later block (different txHash scope)
    const { mockDb: afterLpSwap, swapId: lpSwapId } = await fireSwap(
      afterFirstSwap,
      {
        blockNumber: 1002,
        timestamp: 1_700_002_000,
        logIndexReserves: 10,
        logIndexSwap: 11,
        amount0In: 200n,
        amount1Out: 400n,
      },
    );

    // Pool has 2 swaps at this point
    const poolBeforeLp = afterLpSwap.entities.Pool.get(POOL_ADDR) as
      | PoolEntity
      | undefined;
    assert.ok(poolBeforeLp);
    assert.strictEqual(
      poolBeforeLp!.swapCount,
      2,
      "swapCount must be 2 before LP events",
    );

    // Mint fires first — should subtract the LP swap
    const afterMint = await fireMint(afterLpSwap, {
      blockNumber: 1002,
      timestamp: 1_700_002_000,
      logIndex: 12,
    });
    const poolAfterMint = afterMint.entities.Pool.get(POOL_ADDR) as
      | PoolEntity
      | undefined;
    assert.ok(poolAfterMint);
    assert.strictEqual(
      poolAfterMint!.swapCount,
      1,
      "After Mint backfill, swapCount must be 1",
    );

    // Burn fires second in the same block/tx — must be a no-op (idempotent)
    const afterBurn = await fireBurn(afterMint, {
      blockNumber: 1002,
      timestamp: 1_700_002_000,
      logIndex: 13,
    });
    const poolAfterBurn = afterBurn.entities.Pool.get(POOL_ADDR) as
      | PoolEntity
      | undefined;
    assert.ok(poolAfterBurn);
    assert.strictEqual(
      poolAfterBurn!.swapCount,
      1,
      "After Burn in same tx (idempotency), swapCount must still be 1 — not double-subtracted",
    );

    // The LP swap must be marked isLpSwap=true
    const lpSwap = afterBurn.entities.SwapEvent.get(lpSwapId) as
      | SwapEventEntity
      | undefined;
    assert.ok(lpSwap, "LP swap must exist");
    assert.strictEqual(lpSwap!.isLpSwap, true, "LP swap must be isLpSwap=true");
  });

  // --------------------------------------------------------------------------
  // User trade without LP event stays isLpSwap=false
  // --------------------------------------------------------------------------

  it("Swap with NO Mint/Burn in same tx remains isLpSwap=false (user trade)", async () => {
    let mockDb = await deployPool();
    const { mockDb: db, swapId } = await fireSwap(mockDb);

    const swapEntity = db.entities.SwapEvent.get(swapId) as
      | SwapEventEntity
      | undefined;
    assert.ok(swapEntity, "SwapEvent must exist");
    assert.strictEqual(
      swapEntity!.isLpSwap,
      false,
      "A swap without Mint/Burn must remain isLpSwap=false",
    );

    const pool = db.entities.Pool.get(POOL_ADDR) as PoolEntity | undefined;
    assert.ok(pool, "Pool must exist");
    assert.strictEqual(
      pool!.swapCount,
      1,
      "Pool.swapCount must remain 1 for a user trade",
    );
  });
});

// ---------------------------------------------------------------------------
// Multicall edge case
// An external contract batches FPMM.swap() + FPMM.mint() in one tx.
// With the last-writer-wins approach, the LP rebalance swap (emitted inside
// mint(), which fires last) overwrites the SwapTxIndex entry. When Mint
// processes, it backfills the LP rebalance swap only.
//
// NOTE: In the Envio test framework, all events in one test share the same
// default txHash (since we can't inject it via mockEventData). We therefore
// model this case by verifying block-level isolation: swaps in different
// blocks are NOT cross-contaminated.
// ---------------------------------------------------------------------------

describe("LP swap classification — block isolation", () => {
  beforeEach(() => {
    _setMockRateFeedID(CHAIN_ID, POOL_ADDR, null);
  });

  afterEach(() => {
    _clearMockReserves();
    _clearMockRateFeedIDs();
    _clearMockRebalancingStates();
  });

  it("Mint only backfills LP swap from its own block, not a prior block's user trade", async () => {
    let mockDb = await deployPool();

    // Block 1001: standalone user trade (no LP event)
    const { mockDb: afterBlock1, swapId: userSwapId } = await fireSwap(mockDb, {
      blockNumber: 1001,
      logIndexReserves: 1,
      logIndexSwap: 2,
    });

    // Block 1002: LP rebalance swap + Mint
    const { mockDb: afterLpSwap, swapId: lpSwapId } = await fireSwap(
      afterBlock1,
      {
        blockNumber: 1002,
        timestamp: 1_700_002_000,
        logIndexReserves: 10,
        logIndexSwap: 11,
      },
    );
    const afterMint = await fireMint(afterLpSwap, {
      blockNumber: 1002,
      timestamp: 1_700_002_000,
      logIndex: 12,
    });

    // The LP swap in block 1002 must be flagged
    const lpSwap = afterMint.entities.SwapEvent.get(lpSwapId) as
      | SwapEventEntity
      | undefined;
    assert.ok(lpSwap, "LP rebalance SwapEvent must exist");
    assert.strictEqual(
      lpSwap!.isLpSwap,
      true,
      "LP rebalance swap must be isLpSwap=true",
    );

    // The user swap in block 1001 must remain untouched
    const userSwap = afterMint.entities.SwapEvent.get(userSwapId) as
      | SwapEventEntity
      | undefined;
    assert.ok(userSwap, "User SwapEvent must exist");
    assert.strictEqual(
      userSwap!.isLpSwap,
      false,
      "User trade from prior block must remain isLpSwap=false",
    );

    // Pool.swapCount must be 1 — only the user trade, LP swap subtracted
    const pool = afterMint.entities.Pool.get(POOL_ADDR) as
      | PoolEntity
      | undefined;
    assert.ok(pool);
    assert.strictEqual(
      pool!.swapCount,
      1,
      "Pool.swapCount must be 1 (user trade + LP swap - LP backfill)",
    );
  });
});
