import assert from "node:assert/strict";
import type { Pool } from "envio";
import {
  indexerTestHelpers,
  type MockDbWith,
  type MockEventData,
  type WritableEntity,
} from "./helpers/indexerTestHarness.js";
import { createMockEventData } from "./helpers/eventFixtures.js";
import {
  _clearMockRebalancingStates,
  _clearMockReserves,
  _setMockRebalancingState,
  _setMockReserves,
} from "../src/EventHandlers.ts";
import { makePool } from "./helpers/makePool.ts";
import { makePoolId } from "../src/helpers.ts";

// ---------------------------------------------------------------------------
// Issue #1053 scenario 5 — `FPMM.UpdateReserves` state-sync reconcile when
// the on-chain read (`getRebalancingState` RPC, standing in for the
// contract's live state) disagrees with the Pool row's currently-persisted
// (accumulated) `priceDifference` / `rebalanceThreshold` / `oraclePrice`.
//
// `oracleOk: false` forces `tryDeriveRebalanceState` to return null, so the
// handlers fall through to the authoritative RPC. A successful contract read
// proves the oracle is live because getRebalancingState reverts when it is
// stale or expired.
// ---------------------------------------------------------------------------

type MockDb = MockDbWith<{ Pool: WritableEntity }>;

const TestHelpers = indexerTestHelpers<MockDb>();
const { MockDb, FPMM } = TestHelpers;

const CHAIN_ID = 42220;
const POOL_ADDRESS = "0x00000000000000000000000000000000000000fe";

function updateReservesEvent(): unknown {
  const data: MockEventData = createMockEventData({
    chainId: CHAIN_ID,
    logIndex: 1,
    srcAddress: POOL_ADDRESS,
    blockNumber: 900,
    blockTimestamp: 1_700_900_000,
  });
  return FPMM.UpdateReserves.createMockEvent({
    reserve0: 900_000n * 10n ** 18n,
    reserve1: 1_100_000n * 10n ** 18n,
    blockTimestamp: 1_700_900_000n,
    mockEventData: data,
  });
}

function rebalancedEvent(): unknown {
  const data: MockEventData = createMockEventData({
    chainId: CHAIN_ID,
    logIndex: 2,
    srcAddress: POOL_ADDRESS,
    blockNumber: 901,
    blockTimestamp: 1_700_900_100,
  });
  return FPMM.Rebalanced.createMockEvent({
    sender: "0x00000000000000000000000000000000000000aa",
    priceDifferenceBefore: 600n,
    priceDifferenceAfter: 50n,
    mockEventData: data,
  });
}

function staleOraclePool(overrides: Partial<Pool> = {}): Pool {
  return makePool({
    id: makePoolId(CHAIN_ID, POOL_ADDRESS),
    chainId: CHAIN_ID,
    token0: "0x00000000000000000000000000000000000000b0",
    token1: "0x00000000000000000000000000000000000000b1",
    tokenDecimalsKnown: true,
    invertRateFeedKnown: true,
    invertRateFeed: false,
    rebalanceThresholdsKnown: true,
    rebalanceThresholdAbove: 250,
    rebalanceThresholdBelow: 250,
    rebalanceThreshold: 250,
    oracleOk: false,
    priceDifference: 9_999n,
    oraclePrice: 42n,
    reserves0: 1_000_000n * 10n ** 18n,
    reserves1: 1_000_000n * 10n ** 18n,
    referenceRateFeedID: "0xf4f9bbda9cd6841fcb9b1510f9269e2db42a6e3a",
    oracleFreshnessWindow: 3_600n,
    lpFee: 0,
    protocolFee: 0,
    rebalanceReward: -2,
    ...overrides,
  });
}

describe("state-sync reconcile (issue #1053 scenario 5)", () => {
  afterEach(() => {
    _clearMockRebalancingStates();
    _clearMockReserves();
  });

  it("adopts UpdateReserves RPC state and restores oracleOk", async () => {
    // Stale, previously-persisted values a naive "keep accumulating"
    // implementation might otherwise hold onto.
    const staleFixture = staleOraclePool({
      oracleOk: false, // forces RPC fallback despite otherwise-derivable state
      rebalanceThreshold: 100, // stale
      priceDifference: 9_999n, // stale
      oraclePrice: 42n, // stale
    });

    // Fresh on-chain state disagrees with every one of those stale fields.
    _setMockRebalancingState(CHAIN_ID, POOL_ADDRESS, {
      oraclePriceNumerator: 2n * 10n ** 24n,
      oraclePriceDenominator: 1n,
      rebalanceThreshold: 250,
      priceDifference: 555n,
    });

    let mockDb = MockDb.createMockDb();
    mockDb = mockDb.entities.Pool.set(staleFixture);

    mockDb = await FPMM.UpdateReserves.processEvent({
      event: updateReservesEvent(),
      mockDb,
    });

    const pool = mockDb.entities.Pool.get(staleFixture.id) as Pool;
    assert.ok(pool);
    assert.equal(
      pool.priceDifference,
      555n,
      "priceDifference must reconcile to the fresh on-chain read",
    );
    assert.equal(
      pool.rebalanceThreshold,
      250,
      "rebalanceThreshold must reconcile to the fresh on-chain read",
    );
    assert.equal(
      pool.oraclePrice,
      2n * 10n ** 24n * 1_000_000n, // ORACLE_ADAPTER_SCALE_FACTOR
      "oraclePrice must reconcile to the fresh on-chain read, not the stale value",
    );
    // Reserves themselves always reconcile to the event's own params
    // (the contract's ground truth), regardless of the RPC path above.
    assert.equal(pool.reserves0, 900_000n * 10n ** 18n);
    assert.equal(pool.reserves1, 1_100_000n * 10n ** 18n);
    assert.equal(
      pool.oracleOk,
      true,
      "successful getRebalancingState must restore the live-oracle flag",
    );
  });

  it("restores oracleOk after a successful Rebalanced RPC fallback", async () => {
    const staleFixture = staleOraclePool();

    _setMockRebalancingState(CHAIN_ID, POOL_ADDRESS, {
      oraclePriceNumerator: 2n * 10n ** 24n,
      oraclePriceDenominator: 1n,
      rebalanceThreshold: 250,
      priceDifference: 50n,
    });
    _setMockReserves(CHAIN_ID, POOL_ADDRESS, {
      reserve0: staleFixture.reserves0,
      reserve1: staleFixture.reserves1,
    });

    let mockDb = MockDb.createMockDb();
    mockDb = mockDb.entities.Pool.set(staleFixture);
    mockDb = await FPMM.Rebalanced.processEvent({
      event: rebalancedEvent(),
      mockDb,
    });

    const pool = mockDb.entities.Pool.get(staleFixture.id) as Pool;
    assert.ok(pool);
    assert.equal(
      pool.oracleOk,
      true,
      "successful getRebalancingState must restore the live-oracle flag",
    );
  });

  it("keeps oracleOk false when the UpdateReserves RPC fails", async () => {
    const staleFixture = staleOraclePool();
    _setMockRebalancingState(CHAIN_ID, POOL_ADDRESS, null);

    let mockDb = MockDb.createMockDb();
    mockDb = mockDb.entities.Pool.set(staleFixture);
    mockDb = await FPMM.UpdateReserves.processEvent({
      event: updateReservesEvent(),
      mockDb,
    });

    const pool = mockDb.entities.Pool.get(staleFixture.id) as Pool;
    assert.ok(pool);
    assert.equal(pool.oracleOk, false);
  });

  it("keeps oracleOk false when the Rebalanced RPC fails", async () => {
    const staleFixture = staleOraclePool();
    _setMockRebalancingState(CHAIN_ID, POOL_ADDRESS, null);
    _setMockReserves(CHAIN_ID, POOL_ADDRESS, {
      reserve0: staleFixture.reserves0,
      reserve1: staleFixture.reserves1,
    });

    let mockDb = MockDb.createMockDb();
    mockDb = mockDb.entities.Pool.set(staleFixture);
    mockDb = await FPMM.Rebalanced.processEvent({
      event: rebalancedEvent(),
      mockDb,
    });

    const pool = mockDb.entities.Pool.get(staleFixture.id) as Pool;
    assert.ok(pool);
    assert.equal(pool.oracleOk, false);
  });
});
