import assert from "node:assert/strict";
import {
  legacyTestHelpers,
  type LegacyMockDbWith,
  type LegacyMockEventData,
  type LegacyWritableEntity,
} from "./helpers/legacyMockDb.js";
import {
  legacyMockEventData,
  seedLegacyFpmmPool,
} from "./helpers/legacyEvents.js";
import {
  _setMockERC20Decimals,
  _clearMockERC20Decimals,
} from "../src/EventHandlers.ts";
import { makePoolId } from "../src/helpers.ts";

type MockDb = LegacyMockDbWith<{
  Pool: LegacyWritableEntity;
}>;

const TestHelpers = legacyTestHelpers<MockDb>();
const { MockDb, FPMMFactory, FPMM } = TestHelpers;

const POOL_ADDRESS = "0x00000000000000000000000000000000000000aa";
const TOKEN0 = "0x00000000000000000000000000000000000000b0";
const TOKEN1 = "0x00000000000000000000000000000000000000b1";
const FACTORY = "0x00000000000000000000000000000000000000cc";

async function seedFpmmPool(mockDb: MockDb): Promise<MockDb> {
  // Mock the ERC20 decimals fallback so the FPMMDeployed handler doesn't
  // hit real RPC during the decimals0/decimals1 fetcher fall-through.
  // Without this, the test occasionally times out on slower CI runners
  // waiting on Forno when the test addresses don't exist on-chain.
  _setMockERC20Decimals(42220, TOKEN0, 18);
  _setMockERC20Decimals(42220, TOKEN1, 18);
  return seedLegacyFpmmPool(mockDb, FPMMFactory.FPMMDeployed, {
    token0: TOKEN0,
    token1: TOKEN1,
    poolAddress: POOL_ADDRESS,
    factoryAddress: FACTORY,
    blockNumber: 100,
    blockTimestamp: 1_700_000_000,
  });
}

function mockEventData(logIndex = 1, blockNumber = 200): LegacyMockEventData {
  return legacyMockEventData({
    logIndex,
    srcAddress: POOL_ADDRESS,
    blockNumber,
    blockTimestamp: 1_700_000_500,
  });
}

describe("FPMM fee-config event handlers", () => {
  beforeEach(() => {
    _clearMockERC20Decimals();
  });

  it("LPFeeUpdated writes newFee (as Number) to Pool.lpFee and touches updatedAt", async function () {
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
