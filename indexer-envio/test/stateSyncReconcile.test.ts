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
  _clearMockMedianTimestamps,
  _clearMockRateFeedIDs,
  _clearMockReportExpiry,
  _clearMockReserves,
  _setMockMedianTimestamp,
  _setMockRateFeedID,
  _setMockRebalancingState,
  _setMockReportExpiry,
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
const RATE_FEED_ID = "0xf4f9bbda9cd6841fcb9b1510f9269e2db42a6e3a";
const ONE_YEAR_SECONDS = 31_536_000n;
const MEDIAN_TIMESTAMP = 1_700_888_137n;

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

function rebalanceThresholdUpdatedEvent(): unknown {
  const data: MockEventData = createMockEventData({
    chainId: CHAIN_ID,
    logIndex: 3,
    srcAddress: POOL_ADDRESS,
    blockNumber: 902,
    blockTimestamp: 1_700_900_200,
  });
  return FPMM.RebalanceThresholdUpdated.createMockEvent({
    oldThresholdAbove: 250n,
    oldThresholdBelow: 250n,
    newThresholdAbove: 300n,
    newThresholdBelow: 300n,
    mockEventData: data,
  });
}

function unreconciledOraclePool(overrides: Partial<Pool> = {}): Pool {
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
    // Mirrors the Polygon EURm/EUROP bootstrap: the feed's configured
    // one-year expiry was indexed correctly, but its latest report predated
    // the pool, so no OracleReported event initialized the local cursors.
    oracleExpiry: ONE_YEAR_SECONDS,
    oracleTimestamp: 1_700_000_000n,
    lastOracleReportAt: 0n,
    lastMedianPrice: 0n,
    priceDifference: 9_999n,
    oraclePrice: 42n,
    reserves0: 1_000_000n * 10n ** 18n,
    reserves1: 1_000_000n * 10n ** 18n,
    referenceRateFeedID: RATE_FEED_ID,
    oracleFreshnessWindow: 3_600n,
    lpFee: 0,
    protocolFee: 0,
    rebalanceReward: -2,
    ...overrides,
  });
}

function blankFeedOraclePool(): Pool {
  return unreconciledOraclePool({
    referenceRateFeedID: "",
    oracleExpiry: 0n,
    lastOracleReportAt: 0n,
  });
}

function mockBlankFeedRecovery(): void {
  _setMockRateFeedID(CHAIN_ID, POOL_ADDRESS, RATE_FEED_ID);
  _setMockReportExpiry(CHAIN_ID, RATE_FEED_ID, ONE_YEAR_SECONDS);
  _setMockMedianTimestamp(CHAIN_ID, RATE_FEED_ID, MEDIAN_TIMESTAMP);
}

function assertRecoveredOracleConfig(pool: Pool): void {
  assert.equal(pool.referenceRateFeedID, RATE_FEED_ID);
  assert.equal(pool.oracleExpiry, ONE_YEAR_SECONDS);
  assert.equal(pool.lastOracleReportAt, MEDIAN_TIMESTAMP);
  assert.equal(pool.oracleOk, true);
}

describe("state-sync reconcile (issue #1053 scenario 5)", () => {
  beforeEach(() => {
    _setMockMedianTimestamp(CHAIN_ID, RATE_FEED_ID, MEDIAN_TIMESTAMP);
  });

  afterEach(() => {
    _clearMockMedianTimestamps();
    _clearMockRateFeedIDs();
    _clearMockReportExpiry();
    _clearMockRebalancingStates();
    _clearMockReserves();
  });

  it("restores a one-year-expiry oracle after UpdateReserves RPC succeeds", async () => {
    // Stale, previously-persisted values a naive "keep accumulating"
    // implementation might otherwise hold onto.
    const staleFixture = unreconciledOraclePool({
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
    assert.equal(
      pool.oracleExpiry,
      ONE_YEAR_SECONDS,
      "RPC recovery must preserve the per-feed one-year expiry",
    );
    assert.equal(
      pool.lastOracleReportAt,
      MEDIAN_TIMESTAMP,
      "RPC recovery must persist SortedOracles' exact median timestamp",
    );
  });

  it("restores oracleOk after a successful Rebalanced RPC fallback", async () => {
    const staleFixture = unreconciledOraclePool();

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
    assert.equal(pool.lastOracleReportAt, MEDIAN_TIMESTAMP);
  });

  it("recovers a blank feed and exact freshness config on UpdateReserves", async () => {
    const staleFixture = blankFeedOraclePool();
    mockBlankFeedRecovery();
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
    assertRecoveredOracleConfig(pool);
  });

  it("recovers a blank feed and exact freshness config on Rebalanced", async () => {
    const staleFixture = blankFeedOraclePool();
    mockBlankFeedRecovery();
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
    assertRecoveredOracleConfig(pool);
  });

  it("recovers a blank feed and exact freshness config on RebalanceThresholdUpdated", async () => {
    const staleFixture = blankFeedOraclePool();
    mockBlankFeedRecovery();
    _setMockRebalancingState(CHAIN_ID, POOL_ADDRESS, {
      oraclePriceNumerator: 2n * 10n ** 24n,
      oraclePriceDenominator: 1n,
      rebalanceThreshold: 300,
      priceDifference: 450n,
    });

    let mockDb = MockDb.createMockDb();
    mockDb = mockDb.entities.Pool.set(staleFixture);
    mockDb = await FPMM.RebalanceThresholdUpdated.processEvent({
      event: rebalanceThresholdUpdatedEvent(),
      mockDb,
    });

    const pool = mockDb.entities.Pool.get(staleFixture.id) as Pool;
    assert.ok(pool);
    assertRecoveredOracleConfig(pool);
    assert.equal(pool.rebalanceThreshold, 300);
    assert.equal(pool.priceDifference, 450n);
  });

  it("keeps oracleOk false when the UpdateReserves RPC fails", async () => {
    const staleFixture = unreconciledOraclePool();
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
    const staleFixture = unreconciledOraclePool();
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
