/// <reference types="mocha" />
import { assert } from "chai";
import generated from "generated";
import {
  _setMockReserves,
  _clearMockReserves,
  _setMockERC20Decimals,
  _clearMockERC20Decimals,
} from "../src/EventHandlers.ts";

type MockDb = {
  entities: {
    FactoryDeployment: { get: (id: string) => unknown };
    Pool: {
      get: (id: string) => unknown;
      set: (entity: unknown) => MockDb;
    };
    SwapEvent: { get: (id: string) => unknown };
  };
};

type EventProcessor = {
  createMockEvent: (args: unknown) => unknown;
  processEvent: (args: { event: unknown; mockDb: MockDb }) => Promise<MockDb>;
};

type GeneratedModule = {
  TestHelpers: {
    MockDb: { createMockDb: () => MockDb };
    FPMMFactory: {
      FPMMDeployed: EventProcessor;
    };
    FPMM: {
      Swap: EventProcessor;
      UpdateReserves: EventProcessor;
    };
    VirtualPoolFactory: {
      VirtualPoolDeployed: EventProcessor;
    };
    VirtualPool: {
      Swap: EventProcessor;
      UpdateReserves: EventProcessor;
    };
  };
};

const { TestHelpers } = generated as unknown as GeneratedModule;
const { MockDb, FPMMFactory, FPMM, VirtualPoolFactory, VirtualPool } =
  TestHelpers;

type PoolEntity = {
  id: string;
  reserves0: bigint;
  reserves1: bigint;
  swapCount: number;
  [key: string]: unknown;
};

describe("Swap handler — reserve syncing", () => {
  afterEach(() => {
    _clearMockReserves();
    _clearMockERC20Decimals();
  });

  it("updates reserves via UpdateReserves preceding FPMM.Swap (matching contract behavior)", async () => {
    const POOL_ADDR = "0x00000000000000000000000000000000000000e0";
    const MOCK_R0 = 50_000_000_000_000_000_000_000n;
    const MOCK_R1 = 70_000_000_000_000_000_000_000n;

    let mockDb = MockDb.createMockDb();

    // Deploy pool first
    const deployEvent = FPMMFactory.FPMMDeployed.createMockEvent({
      token0: "0x0000000000000000000000000000000000000003",
      token1: "0x0000000000000000000000000000000000000004",
      fpmmProxy: POOL_ADDR,
      fpmmImplementation: "0x00000000000000000000000000000000000000bc",
      mockEventData: {
        chainId: 42220,
        logIndex: 10,
        srcAddress: "0x00000000000000000000000000000000000000cc",
        block: { number: 1000, timestamp: 1_700_010_000 },
      },
    });
    mockDb = await FPMMFactory.FPMMDeployed.processEvent({
      event: deployEvent,
      mockDb,
    });

    // The FPMM contract calls _update() before emit Swap, so UpdateReserves
    // always precedes Swap in the same tx. Simulate this event ordering.
    const updateEvent = FPMM.UpdateReserves.createMockEvent({
      reserve0: MOCK_R0,
      reserve1: MOCK_R1,
      blockTimestamp: 1_700_010_100n,
      mockEventData: {
        chainId: 42220,
        logIndex: 11,
        srcAddress: POOL_ADDR,
        block: { number: 1001, timestamp: 1_700_010_100 },
      },
    });
    mockDb = await FPMM.UpdateReserves.processEvent({
      event: updateEvent,
      mockDb,
    });

    // Fire a Swap event (no fetchReserves RPC — reserves already set above)
    const swapEvent = FPMM.Swap.createMockEvent({
      sender: "0x0000000000000000000000000000000000000011",
      to: "0x0000000000000000000000000000000000000022",
      amount0In: 1_000_000_000_000_000_000n,
      amount1In: 0n,
      amount0Out: 0n,
      amount1Out: 2_000_000_000_000_000_000n,
      mockEventData: {
        chainId: 42220,
        logIndex: 12,
        srcAddress: POOL_ADDR,
        block: { number: 1001, timestamp: 1_700_010_100 },
      },
    });
    mockDb = await FPMM.Swap.processEvent({ event: swapEvent, mockDb });

    const pool = mockDb.entities.Pool.get(POOL_ADDR) as PoolEntity | undefined;
    assert.ok(pool, "Pool must exist after Swap");
    assert.equal(
      pool!.reserves0,
      MOCK_R0,
      `expected reserves0 = ${MOCK_R0}, got ${pool!.reserves0}`,
    );
    assert.equal(
      pool!.reserves1,
      MOCK_R1,
      `expected reserves1 = ${MOCK_R1}, got ${pool!.reserves1}`,
    );
  });

  it("FPMM.Swap preserves existing reserves (does not fetch or overwrite)", async () => {
    const POOL_ADDR = "0x00000000000000000000000000000000000000e1";
    const SEED_R0 = 30_000_000_000_000_000_000_000n;
    const SEED_R1 = 40_000_000_000_000_000_000_000n;

    let mockDb = MockDb.createMockDb();

    // Deploy pool
    const deployEvent = FPMMFactory.FPMMDeployed.createMockEvent({
      token0: "0x0000000000000000000000000000000000000003",
      token1: "0x0000000000000000000000000000000000000004",
      fpmmProxy: POOL_ADDR,
      fpmmImplementation: "0x00000000000000000000000000000000000000bc",
      mockEventData: {
        chainId: 42220,
        logIndex: 10,
        srcAddress: "0x00000000000000000000000000000000000000cc",
        block: { number: 1100, timestamp: 1_700_011_000 },
      },
    });
    mockDb = await FPMMFactory.FPMMDeployed.processEvent({
      event: deployEvent,
      mockDb,
    });

    // Pre-seed reserves on the pool entity (simulates prior UpdateReserves)
    const seeded = mockDb.entities.Pool.get(POOL_ADDR) as PoolEntity;
    assert.ok(seeded, "Pool must exist after deploy");
    mockDb = mockDb.entities.Pool.set({
      ...seeded,
      reserves0: SEED_R0,
      reserves1: SEED_R1,
    });

    // Fire a Swap event
    const swapEvent = FPMM.Swap.createMockEvent({
      sender: "0x0000000000000000000000000000000000000011",
      to: "0x0000000000000000000000000000000000000022",
      amount0In: 1_000_000_000_000_000_000n,
      amount1In: 0n,
      amount0Out: 0n,
      amount1Out: 2_000_000_000_000_000_000n,
      mockEventData: {
        chainId: 42220,
        logIndex: 11,
        srcAddress: POOL_ADDR,
        block: { number: 1101, timestamp: 1_700_011_100 },
      },
    });
    mockDb = await FPMM.Swap.processEvent({ event: swapEvent, mockDb });

    const pool = mockDb.entities.Pool.get(POOL_ADDR) as PoolEntity | undefined;
    assert.ok(pool, "Pool must exist after Swap");
    // Reserves must NOT be zeroed — they should remain at seeded values
    assert.equal(
      pool!.reserves0,
      SEED_R0,
      `reserves0 must be preserved (${SEED_R0}), got ${pool!.reserves0}`,
    );
    assert.equal(
      pool!.reserves1,
      SEED_R1,
      `reserves1 must be preserved (${SEED_R1}), got ${pool!.reserves1}`,
    );
  });

  // ---------------------------------------------------------------------------
  // VirtualPool.Swap — same reserve-sync path as FPMM.Swap
  // ---------------------------------------------------------------------------

  it("VirtualPool.Swap uses reserves set by preceding UpdateReserves", async () => {
    const POOL_ADDR = "0x00000000000000000000000000000000000000e2";
    const MOCK_R0 = 80_000_000_000_000_000_000_000n;
    const MOCK_R1 = 90_000_000_000_000_000_000_000n;

    let mockDb = MockDb.createMockDb();

    // Deploy VirtualPool
    const deployEvent = VirtualPoolFactory.VirtualPoolDeployed.createMockEvent({
      pool: POOL_ADDR,
      token0: "0x0000000000000000000000000000000000000003",
      token1: "0x0000000000000000000000000000000000000004",
      mockEventData: {
        chainId: 42220,
        logIndex: 10,
        srcAddress: "0x00000000000000000000000000000000000000cc",
        block: { number: 2000, timestamp: 1_700_020_000 },
      },
    });
    mockDb = await VirtualPoolFactory.VirtualPoolDeployed.processEvent({
      event: deployEvent,
      mockDb,
    });

    // UpdateReserves precedes Swap in the same tx (contract calls _update() first)
    const updateEvent = VirtualPool.UpdateReserves.createMockEvent({
      reserve0: MOCK_R0,
      reserve1: MOCK_R1,
      blockTimestamp: 1_700_020_100n,
      mockEventData: {
        chainId: 42220,
        logIndex: 11,
        srcAddress: POOL_ADDR,
        block: { number: 2001, timestamp: 1_700_020_100 },
      },
    });
    mockDb = await VirtualPool.UpdateReserves.processEvent({
      event: updateEvent,
      mockDb,
    });

    // Fire VirtualPool.Swap (no fetchReserves RPC — reserves already set above)
    const swapEvent = VirtualPool.Swap.createMockEvent({
      sender: "0x0000000000000000000000000000000000000011",
      to: "0x0000000000000000000000000000000000000022",
      amount0In: 1_000_000_000_000_000_000n,
      amount1In: 0n,
      amount0Out: 0n,
      amount1Out: 2_000_000_000_000_000_000n,
      mockEventData: {
        chainId: 42220,
        logIndex: 12,
        srcAddress: POOL_ADDR,
        block: { number: 2001, timestamp: 1_700_020_100 },
      },
    });
    mockDb = await VirtualPool.Swap.processEvent({
      event: swapEvent,
      mockDb,
    });

    const pool = mockDb.entities.Pool.get(POOL_ADDR) as PoolEntity | undefined;
    assert.ok(pool, "VirtualPool must exist after Swap");
    assert.equal(
      pool!.reserves0,
      MOCK_R0,
      `expected reserves0 = ${MOCK_R0}, got ${pool!.reserves0}`,
    );
    assert.equal(
      pool!.reserves1,
      MOCK_R1,
      `expected reserves1 = ${MOCK_R1}, got ${pool!.reserves1}`,
    );
  });

  it("VirtualPool.Swap preserves existing reserves (does not fetch or overwrite)", async () => {
    const POOL_ADDR = "0x00000000000000000000000000000000000000e3";
    const SEED_R0 = 60_000_000_000_000_000_000_000n;
    const SEED_R1 = 55_000_000_000_000_000_000_000n;

    let mockDb = MockDb.createMockDb();

    // Deploy VirtualPool
    const deployEvent = VirtualPoolFactory.VirtualPoolDeployed.createMockEvent({
      pool: POOL_ADDR,
      token0: "0x0000000000000000000000000000000000000003",
      token1: "0x0000000000000000000000000000000000000004",
      mockEventData: {
        chainId: 42220,
        logIndex: 10,
        srcAddress: "0x00000000000000000000000000000000000000cc",
        block: { number: 2100, timestamp: 1_700_021_000 },
      },
    });
    mockDb = await VirtualPoolFactory.VirtualPoolDeployed.processEvent({
      event: deployEvent,
      mockDb,
    });

    // Pre-seed reserves (simulates prior UpdateReserves)
    const seeded = mockDb.entities.Pool.get(POOL_ADDR) as PoolEntity;
    assert.ok(seeded, "VirtualPool must exist after deploy");
    mockDb = mockDb.entities.Pool.set({
      ...seeded,
      reserves0: SEED_R0,
      reserves1: SEED_R1,
    });

    const swapEvent = VirtualPool.Swap.createMockEvent({
      sender: "0x0000000000000000000000000000000000000011",
      to: "0x0000000000000000000000000000000000000022",
      amount0In: 1_000_000_000_000_000_000n,
      amount1In: 0n,
      amount0Out: 0n,
      amount1Out: 2_000_000_000_000_000_000n,
      mockEventData: {
        chainId: 42220,
        logIndex: 11,
        srcAddress: POOL_ADDR,
        block: { number: 2101, timestamp: 1_700_021_100 },
      },
    });
    mockDb = await VirtualPool.Swap.processEvent({
      event: swapEvent,
      mockDb,
    });

    const pool = mockDb.entities.Pool.get(POOL_ADDR) as PoolEntity | undefined;
    assert.ok(pool, "VirtualPool must exist after Swap");
    assert.equal(
      pool!.reserves0,
      SEED_R0,
      `reserves0 must be preserved (${SEED_R0}), got ${pool!.reserves0}`,
    );
    assert.equal(
      pool!.reserves1,
      SEED_R1,
      `reserves1 must be preserved (${SEED_R1}), got ${pool!.reserves1}`,
    );
  });

  // ---------------------------------------------------------------------------
  // FPMMDeployed — ERC20 decimals fallback
  // Regression test for Monad AUSD/USDm pool (0xb0a…) where decimals0() failed
  // at index time due to RPC rate-limiting, causing the indexer to fall back to
  // 18 instead of AUSD's actual 6 decimals. The fix: fall back to ERC20 decimals().
  // ---------------------------------------------------------------------------

  it("FPMMDeployed uses ERC20 decimals() fallback when decimals0() RPC call fails", async () => {
    // In tests, no real RPC is available, so decimals0()/decimals1() calls always
    // fail and return null — exactly simulating the production failure scenario.
    // We inject the correct ERC20 decimals so the fallback path is exercised.
    const POOL_ADDR = "0x00000000000000000000000000000000000000e4";
    const TOKEN0 = "0x00000000efe302beaa2b3e6e1b18d08d69a9012a"; // AUSD (6dp)
    const TOKEN1 = "0xbc69212b8e4d445b2307c9d32dd68e2a4df00115"; // USDm (18dp)

    _setMockERC20Decimals(42220, TOKEN0, 6);
    _setMockERC20Decimals(42220, TOKEN1, 18);

    let mockDb = MockDb.createMockDb();

    const deployEvent = FPMMFactory.FPMMDeployed.createMockEvent({
      token0: TOKEN0,
      token1: TOKEN1,
      fpmmProxy: POOL_ADDR,
      fpmmImplementation: "0x00000000000000000000000000000000000000bc",
      mockEventData: {
        chainId: 42220,
        logIndex: 10,
        srcAddress: "0x00000000000000000000000000000000000000cc",
        block: { number: 3000, timestamp: 1_700_030_000 },
      },
    });
    mockDb = await FPMMFactory.FPMMDeployed.processEvent({
      event: deployEvent,
      mockDb,
    });

    const pool = mockDb.entities.Pool.get(POOL_ADDR) as
      | (PoolEntity & { token0Decimals: number; token1Decimals: number })
      | undefined;
    assert.ok(pool, "Pool must exist after FPMMDeployed");
    assert.equal(
      pool!.token0Decimals,
      6,
      `Expected token0Decimals=6 (AUSD), got ${pool!.token0Decimals}`,
    );
    assert.equal(
      pool!.token1Decimals,
      18,
      `Expected token1Decimals=18 (USDm), got ${pool!.token1Decimals}`,
    );
  });

  it("FPMMDeployed falls back to 18 when both decimals0() and ERC20 decimals() fail", async () => {
    // No ERC20 mock set — both pool and token calls fail → safe default of 18.
    const POOL_ADDR = "0x00000000000000000000000000000000000000e5";

    let mockDb = MockDb.createMockDb();

    const deployEvent = FPMMFactory.FPMMDeployed.createMockEvent({
      token0: "0x0000000000000000000000000000000000000003",
      token1: "0x0000000000000000000000000000000000000004",
      fpmmProxy: POOL_ADDR,
      fpmmImplementation: "0x00000000000000000000000000000000000000bc",
      mockEventData: {
        chainId: 42220,
        logIndex: 10,
        srcAddress: "0x00000000000000000000000000000000000000cc",
        block: { number: 3100, timestamp: 1_700_031_000 },
      },
    });
    mockDb = await FPMMFactory.FPMMDeployed.processEvent({
      event: deployEvent,
      mockDb,
    });

    const pool = mockDb.entities.Pool.get(POOL_ADDR) as
      | (PoolEntity & { token0Decimals: number; token1Decimals: number })
      | undefined;
    assert.ok(pool, "Pool must exist after FPMMDeployed");
    assert.equal(
      pool!.token0Decimals,
      18,
      `Expected fallback token0Decimals=18, got ${pool!.token0Decimals}`,
    );
    assert.equal(
      pool!.token1Decimals,
      18,
      `Expected fallback token1Decimals=18, got ${pool!.token1Decimals}`,
    );
  });
});
