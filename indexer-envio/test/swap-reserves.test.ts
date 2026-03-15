/// <reference types="mocha" />
import { assert } from "chai";
import generated from "generated";
import { _setMockReserves, _clearMockReserves } from "../src/EventHandlers.ts";

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
    };
  };
};

const { TestHelpers } = generated as unknown as GeneratedModule;
const { MockDb, FPMMFactory, FPMM } = TestHelpers;

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
  });

  it("updates reserves from mocked getReserves() on FPMM.Swap", async () => {
    const POOL_ADDR = "0x00000000000000000000000000000000000000e0";
    const MOCK_R0 = 50_000_000_000_000_000_000_000n;
    const MOCK_R1 = 70_000_000_000_000_000_000_000n;

    // Pre-set mock reserves so fetchReserves() returns known values
    _setMockReserves(42220, POOL_ADDR, {
      reserve0: MOCK_R0,
      reserve1: MOCK_R1,
    });

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

  it("preserves previous reserves when getReserves() returns null (RPC failure)", async () => {
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

    // Pre-seed reserves on the pool entity
    const seeded = mockDb.entities.Pool.get(POOL_ADDR) as PoolEntity;
    assert.ok(seeded, "Pool must exist after deploy");
    mockDb = mockDb.entities.Pool.set({
      ...seeded,
      reserves0: SEED_R0,
      reserves1: SEED_R1,
    });

    // Mock getReserves() returning null (simulates RPC failure)
    _setMockReserves(42220, POOL_ADDR, null);

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
});
