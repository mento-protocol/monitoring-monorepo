/// <reference types="mocha" />
import assert from "node:assert/strict";
import generated from "generated";
import { makePoolId } from "../src/helpers.ts";

type MockDb = {
  entities: {
    Pool: { get: (id: string) => unknown; set: (e: unknown) => MockDb };
    [key: string]: { get: (id: string) => unknown };
  };
};

type EventProcessor<E> = {
  createMockEvent: (args: E) => unknown;
  processEvent: (args: { event: unknown; mockDb: MockDb }) => Promise<MockDb>;
};

type MockEventData = {
  chainId: number;
  logIndex: number;
  srcAddress: string;
  block: { number: number; timestamp: number };
};

type FeeUpdatedArgs = {
  oldFee: bigint;
  newFee: bigint;
  mockEventData: MockEventData;
};

type IncentiveUpdatedArgs = {
  oldIncentive: bigint;
  newIncentive: bigint;
  mockEventData: MockEventData;
};

type DeployedArgs = {
  token0: string;
  token1: string;
  fpmmProxy: string;
  fpmmImplementation: string;
  mockEventData: MockEventData;
};

type GeneratedModule = {
  TestHelpers: {
    MockDb: { createMockDb: () => MockDb };
    FPMMFactory: { FPMMDeployed: EventProcessor<DeployedArgs> };
    FPMM: {
      LPFeeUpdated: EventProcessor<FeeUpdatedArgs>;
      ProtocolFeeUpdated: EventProcessor<FeeUpdatedArgs>;
      RebalanceIncentiveUpdated: EventProcessor<IncentiveUpdatedArgs>;
    };
  };
};

const { TestHelpers } = generated as unknown as GeneratedModule;
const { MockDb, FPMMFactory, FPMM } = TestHelpers;

const POOL_ADDRESS = "0x00000000000000000000000000000000000000aa";
const TOKEN0 = "0x00000000000000000000000000000000000000b0";
const TOKEN1 = "0x00000000000000000000000000000000000000b1";
const FACTORY = "0x00000000000000000000000000000000000000cc";

async function seedFpmmPool(mockDb: MockDb): Promise<MockDb> {
  const deployEvent = FPMMFactory.FPMMDeployed.createMockEvent({
    token0: TOKEN0,
    token1: TOKEN1,
    fpmmProxy: POOL_ADDRESS,
    fpmmImplementation: "0x00000000000000000000000000000000000000bc",
    mockEventData: {
      chainId: 42220,
      logIndex: 0,
      srcAddress: FACTORY,
      block: { number: 100, timestamp: 1_700_000_000 },
    },
  });
  return FPMMFactory.FPMMDeployed.processEvent({ event: deployEvent, mockDb });
}

function mockEventData(logIndex = 1, blockNumber = 200): MockEventData {
  return {
    chainId: 42220,
    logIndex,
    srcAddress: POOL_ADDRESS,
    block: { number: blockNumber, timestamp: 1_700_000_500 },
  };
}

describe("FPMM fee-config event handlers", () => {
  it("LPFeeUpdated writes newFee (as Number) to Pool.lpFee and touches updatedAt", async function () {
    this.timeout(10_000);
    let mockDb = MockDb.createMockDb();
    mockDb = await seedFpmmPool(mockDb);

    const event = FPMM.LPFeeUpdated.createMockEvent({
      oldFee: 10n,
      newFee: 42n,
      mockEventData: mockEventData(1, 250),
    });
    mockDb = await FPMM.LPFeeUpdated.processEvent({ event, mockDb });

    const pool = mockDb.entities.Pool.get(makePoolId(42220, POOL_ADDRESS)) as
      | { lpFee: number; updatedAtBlock: bigint }
      | undefined;
    assert.ok(pool, "Pool should exist after seed");
    assert.equal(pool!.lpFee, 42);
    assert.equal(pool!.updatedAtBlock, 250n);
  });

  it("ProtocolFeeUpdated writes newFee to Pool.protocolFee without touching lpFee", async function () {
    this.timeout(10_000);
    let mockDb = MockDb.createMockDb();
    mockDb = await seedFpmmPool(mockDb);

    const event = FPMM.ProtocolFeeUpdated.createMockEvent({
      oldFee: 0n,
      newFee: 7n,
      mockEventData: mockEventData(2, 300),
    });
    mockDb = await FPMM.ProtocolFeeUpdated.processEvent({ event, mockDb });

    const pool = mockDb.entities.Pool.get(makePoolId(42220, POOL_ADDRESS)) as
      | { lpFee: number; protocolFee: number; updatedAtBlock: bigint }
      | undefined;
    assert.ok(pool);
    assert.equal(pool!.protocolFee, 7);
    assert.equal(pool!.updatedAtBlock, 300n);
    // lpFee not touched — stays at the seed-time sentinel (-1) or whatever
    // fetchFees returned; the point is ProtocolFeeUpdated must not clobber it.
    assert.notEqual(pool!.lpFee, 7);
  });

  it("RebalanceIncentiveUpdated writes newIncentive to Pool.rebalanceReward", async function () {
    this.timeout(10_000);
    let mockDb = MockDb.createMockDb();
    mockDb = await seedFpmmPool(mockDb);

    const event = FPMM.RebalanceIncentiveUpdated.createMockEvent({
      oldIncentive: 0n,
      newIncentive: 25n,
      mockEventData: mockEventData(3, 350),
    });
    mockDb = await FPMM.RebalanceIncentiveUpdated.processEvent({
      event,
      mockDb,
    });

    const pool = mockDb.entities.Pool.get(makePoolId(42220, POOL_ADDRESS)) as
      | { rebalanceReward: number; updatedAtBlock: bigint }
      | undefined;
    assert.ok(pool);
    assert.equal(pool!.rebalanceReward, 25);
    assert.equal(pool!.updatedAtBlock, 350n);
  });

  it("returns silently when Pool does not exist (no-op on unknown pool)", async function () {
    this.timeout(10_000);
    const mockDb = MockDb.createMockDb();
    // Do NOT seed — pool is unknown.

    const event = FPMM.LPFeeUpdated.createMockEvent({
      oldFee: 0n,
      newFee: 99n,
      mockEventData: mockEventData(1, 400),
    });
    const next = await FPMM.LPFeeUpdated.processEvent({ event, mockDb });

    const pool = next.entities.Pool.get(makePoolId(42220, POOL_ADDRESS));
    assert.equal(
      pool,
      undefined,
      "Handler must not create a pool from thin air",
    );
  });
});
