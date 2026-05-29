import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  indexerTestHelpers,
  type MockDbWith,
  type MockEventData,
  type WritableEntity,
} from "./helpers/indexerTestHarness.js";
import {
  createMockEventData,
  seedFpmmPoolFixture,
} from "./helpers/eventFixtures.js";
import {
  _setMockERC20Decimals,
  _clearMockERC20Decimals,
  _setMockRebalancingState,
  _clearMockRebalancingStates,
} from "../src/EventHandlers.ts";
import { makePoolId } from "../src/helpers.ts";

type MockDb = MockDbWith<{
  Pool: WritableEntity;
}>;

const TestHelpers = indexerTestHelpers<MockDb>();
const { MockDb, FPMMFactory, FPMM } = TestHelpers;

const POOL_ADDRESS = "0x00000000000000000000000000000000000000aa";
const TOKEN0 = "0x00000000000000000000000000000000000000b0";
const TOKEN1 = "0x00000000000000000000000000000000000000b1";
const FACTORY = "0x00000000000000000000000000000000000000cc";
const LIMITS_AND_FEES_SOURCE = fileURLToPath(
  new URL("../src/handlers/fpmm/limits-and-fees.ts", import.meta.url),
);

async function seedFpmmPool(mockDb: MockDb): Promise<MockDb> {
  // Mock the ERC20 decimals fallback so the FPMMDeployed handler doesn't
  // hit real RPC during the decimals0/decimals1 fetcher fall-through.
  // Without this, the test occasionally times out on slower CI runners
  // waiting on Forno when the test addresses don't exist on-chain.
  _setMockERC20Decimals(42220, TOKEN0, 18);
  _setMockERC20Decimals(42220, TOKEN1, 18);
  return seedFpmmPoolFixture(mockDb, FPMMFactory.FPMMDeployed, {
    token0: TOKEN0,
    token1: TOKEN1,
    poolAddress: POOL_ADDRESS,
    factoryAddress: FACTORY,
    blockNumber: 100,
    blockTimestamp: 1_700_000_000,
  });
}

function mockEventData(logIndex = 1, blockNumber = 200): MockEventData {
  return createMockEventData({
    logIndex,
    srcAddress: POOL_ADDRESS,
    blockNumber,
    blockTimestamp: 1_700_000_500,
  });
}

describe("FPMM fee-config event handlers", () => {
  beforeEach(() => {
    _clearMockERC20Decimals();
    _clearMockRebalancingStates();
  });

  afterEach(() => {
    _clearMockERC20Decimals();
    _clearMockRebalancingStates();
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

  it("RebalanceThresholdUpdated preserves exact-zero degeneracy when decimals are unknown", async function () {
    let mockDb = MockDb.createMockDb();
    mockDb = await seedFpmmPool(mockDb);

    _setMockRebalancingState(42220, POOL_ADDRESS, {
      oraclePriceNumerator: 10n ** 12n,
      oraclePriceDenominator: 10n ** 12n,
      rebalanceThreshold: 6000,
      priceDifference: 8_500n,
    });

    const poolId = makePoolId(42220, POOL_ADDRESS);
    const seeded = mockDb.entities.Pool.get(poolId) as
      | Record<string, unknown>
      | undefined;
    assert.ok(seeded, "Pool should exist after seed");
    mockDb = mockDb.entities.Pool.set({
      ...seeded,
      token0: undefined,
      token1: undefined,
      tokenDecimalsKnown: false,
      reserves0: 0n,
      reserves1: 1_000n * 10n ** 18n,
      degenerateReserves: false,
      invertRateFeedKnown: true,
      rebalanceThresholdsKnown: true,
      oracleOk: true,
    });

    const event = FPMM.RebalanceThresholdUpdated.createMockEvent({
      oldThresholdAbove: 5000n,
      oldThresholdBelow: 5000n,
      newThresholdAbove: 6000n,
      newThresholdBelow: 6000n,
      mockEventData: mockEventData(4, 500),
    });
    mockDb = await FPMM.RebalanceThresholdUpdated.processEvent({
      event,
      mockDb,
    });

    const pool = mockDb.entities.Pool.get(poolId) as
      | { degenerateReserves: boolean; priceDifference: bigint }
      | undefined;
    assert.ok(pool);
    assert.equal(pool.degenerateReserves, true);
    assert.equal(pool.priceDifference, 8_500n);
  });

  it("keeps direct Pool writes behind the preload guard", () => {
    const source = readFileSync(LIMITS_AND_FEES_SOURCE, "utf8");
    const guardedWrites = source.match(
      /if \(await maybePreloadPool\(context, poolId\)\) return;/g,
    );

    assert.equal(
      guardedWrites?.length,
      4,
      "Current preload-guarded surfaces are TradingLimitConfigured, LiquidityStrategyUpdated, LPFeeUpdated/ProtocolFeeUpdated/RebalanceIncentiveUpdated, and RebalanceThresholdUpdated",
    );
  });
});
