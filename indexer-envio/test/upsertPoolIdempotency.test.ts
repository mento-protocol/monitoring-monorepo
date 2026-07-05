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
  _clearMockVpExchangeIds,
  _setMockVpExchangeId,
} from "../src/EventHandlers.ts";
import { makePool } from "./helpers/makePool.ts";
import { makePoolId } from "../src/helpers.ts";

// ---------------------------------------------------------------------------
// Issue #1053 scenario 3 — idempotency. Re-processing an already-healed pool
// must clobber no field: replaying the exact same event twice (a reorg
// replay / resync overlap) has to leave the Pool row byte-for-byte
// identical, and repeated live events afterward must not let the healed
// self-heal fields drift even though cumulative counters keep advancing.
//
// Fixture is deliberately "fully healed" up front (all self-heal flags
// already known) and set up so `tryDeriveRebalanceState` succeeds without
// any RPC fallback — the only effect the handler can reach is
// `vpExchangeIdEffect` (upsertPool's wrapped-exchange probe runs
// unconditionally even for FPMMs), which is mocked to its permanent
// "not a VP" result.
// ---------------------------------------------------------------------------

type MockDb = MockDbWith<{ Pool: WritableEntity }>;

const TestHelpers = indexerTestHelpers<MockDb>();
const { MockDb, FPMM } = TestHelpers;

const CHAIN_ID = 42220;
const POOL_ADDRESS = "0x00000000000000000000000000000000000000ff";
const FEED = "0xf4f9bbda9cd6841fcb9b1510f9269e2db42a6e3a";

function healedFpmmPool(): Pool {
  return makePool({
    id: makePoolId(CHAIN_ID, POOL_ADDRESS),
    chainId: CHAIN_ID,
    token0: "0x00000000000000000000000000000000000000b0",
    token1: "0x00000000000000000000000000000000000000b1",
    token0Decimals: 6,
    token1Decimals: 18,
    tokenDecimalsKnown: true,
    source: "fpmm_swap",
    wrappedExchangeId: "",
    reserves0: 1_000_000n * 10n ** 6n,
    reserves1: 1_000_000n * 10n ** 18n,
    rebalanceThresholdsKnown: true,
    rebalanceThresholdAbove: 500,
    rebalanceThresholdBelow: 500,
    rebalanceThreshold: 500,
    invertRateFeedKnown: true,
    invertRateFeed: false,
    oracleOk: true,
    medianLive: true,
    lastMedianPrice: 10n ** 24n,
    oracleExpiry: 999_999_999n,
    lastOracleReportAt: 1_700_000_000n,
    referenceRateFeedID: FEED,
    oracleFreshnessWindow: 3_600n,
    oracleNumReporters: 3,
    lpFee: 25,
    protocolFee: 15,
    rebalanceReward: 3,
    breakerTripped: false,
    hasHealthData: true,
    createdAtBlock: 90n,
    createdAtTimestamp: 1_699_000_000n,
  });
}

function updateReservesEvent(logIndex: number, blockNumber: number) {
  const blockTimestamp = 1_700_000_500 + blockNumber;
  const data: MockEventData = createMockEventData({
    chainId: CHAIN_ID,
    logIndex,
    srcAddress: POOL_ADDRESS,
    blockNumber,
    blockTimestamp,
  });
  return FPMM.UpdateReserves.createMockEvent({
    reserve0: 1_050_000n * 10n ** 6n,
    reserve1: 950_000n * 10n ** 18n,
    blockTimestamp: BigInt(blockTimestamp),
    mockEventData: data,
  });
}

describe("upsertPool idempotency (issue #1053 scenario 3)", () => {
  beforeEach(() => {
    _clearMockVpExchangeIds();
    _setMockVpExchangeId(CHAIN_ID, POOL_ADDRESS, null); // permanent "not a VP"
  });

  it("replaying the exact same UpdateReserves event twice leaves the Pool row byte-for-byte identical", async () => {
    let mockDb = MockDb.createMockDb();
    mockDb = mockDb.entities.Pool.set(healedFpmmPool());

    const event = updateReservesEvent(1, 200);
    mockDb = await FPMM.UpdateReserves.processEvent({ event, mockDb });
    const poolId = makePoolId(CHAIN_ID, POOL_ADDRESS);
    const afterFirst = mockDb.entities.Pool.get(poolId) as Pool;
    assert.ok(afterFirst);

    // Replay: same event object, same mockDb chain (simulates a reorg
    // replay / resync re-delivering an already-processed block range).
    mockDb = await FPMM.UpdateReserves.processEvent({ event, mockDb });
    const afterReplay = mockDb.entities.Pool.get(poolId) as Pool;
    assert.ok(afterReplay);

    for (const key of Object.keys(afterFirst) as (keyof Pool)[]) {
      assert.deepEqual(
        afterReplay[key],
        afterFirst[key],
        `expected Pool.${String(key)} unchanged on exact-event replay`,
      );
    }
  });

  it("self-heal fields stay pinned across repeated live events even while cumulative counters advance", async () => {
    let mockDb = MockDb.createMockDb();
    mockDb = mockDb.entities.Pool.set(healedFpmmPool());
    const poolId = makePoolId(CHAIN_ID, POOL_ADDRESS);

    const healFields = (pool: Pool) => ({
      token0Decimals: pool.token0Decimals,
      token1Decimals: pool.token1Decimals,
      tokenDecimalsKnown: pool.tokenDecimalsKnown,
      invertRateFeed: pool.invertRateFeed,
      invertRateFeedKnown: pool.invertRateFeedKnown,
      referenceRateFeedID: pool.referenceRateFeedID,
      wrappedExchangeId: pool.wrappedExchangeId,
      lpFee: pool.lpFee,
      protocolFee: pool.protocolFee,
      rebalanceReward: pool.rebalanceReward,
      breakerTripped: pool.breakerTripped,
    });

    mockDb = await FPMM.UpdateReserves.processEvent({
      event: updateReservesEvent(1, 200),
      mockDb,
    });
    const afterFirst = mockDb.entities.Pool.get(poolId) as Pool;
    const pinnedFields = healFields(afterFirst);

    mockDb = await FPMM.UpdateReserves.processEvent({
      event: updateReservesEvent(2, 300),
      mockDb,
    });
    const afterSecond = mockDb.entities.Pool.get(poolId) as Pool;

    mockDb = await FPMM.UpdateReserves.processEvent({
      event: updateReservesEvent(3, 400),
      mockDb,
    });
    const afterThird = mockDb.entities.Pool.get(poolId) as Pool;

    assert.deepEqual(healFields(afterSecond), pinnedFields);
    assert.deepEqual(healFields(afterThird), pinnedFields);

    // Sanity check the fixture actually exercised a live event each time
    // (reserves tracked the latest UpdateReserves params, not frozen).
    assert.equal(afterThird.reserves0, 1_050_000n * 10n ** 6n);
    assert.equal(afterThird.reserves1, 950_000n * 10n ** 18n);
  });
});
