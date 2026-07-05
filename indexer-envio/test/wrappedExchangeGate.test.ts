import assert from "node:assert/strict";
import {
  indexerTestHelpers,
  type EntityReader,
  type MockDbWith,
  type MockEventData,
  type WritableEntity,
} from "./helpers/indexerTestHarness.js";
import { createMockEventData } from "./helpers/eventFixtures.js";
import {
  _clearMockNumReporters,
  _clearMockPoolExchanges,
  _clearMockTokenDecimalsScaling,
  _clearMockVpExchangeIds,
  _setMockNumReporters,
  _setMockPoolExchange,
  _setMockTokenDecimalsScaling,
  _setMockVpExchangeId,
} from "../src/EventHandlers.ts";
import type { PoolExchangeStruct } from "../src/rpc/biPoolManager.ts";
import { makePoolId } from "../src/helpers.ts";

// ---------------------------------------------------------------------------
// Issue #1053 scenario 1 — `hasCompleteWrappedExchangeLink` gate
// (`src/pool/self-heal.ts:501-535`), driven end-to-end through the harness.
//
// The other 4 sub-conditions of the gate (BiPoolExchange row missing/back-
// link mismatch, feed-ID mismatch, freshness-window mismatch, reporter-count
// staleness) are already exercised — each one false-in-isolation triggering
// a targeted repair — by test/biPoolManager.test.ts:
//   - "reverse-link backfill: ExchangeCreated AFTER VP heals fills tokens..."
//   - "repairs already-linked VirtualPools whose Pool feed is stale"
//   - "repairs already-linked VirtualPools whose reporter count is a legacy zero"
//   - "marks already-linked legacy-zero VirtualPool reporter counts unknown..."
//   - "links deprecated exchange stubs during VirtualPool heal" (isDeprecated
//     stub short-circuit branch)
// What's missing — and what this file closes — is the "all conditions true"
// half of the acceptance criterion: proving the gate short-circuits and the
// heal does NOT re-fire once the link is fully consistent.
// ---------------------------------------------------------------------------

type MockDb = MockDbWith<{
  Pool: WritableEntity;
  BiPoolExchange: EntityReader;
}>;

const TestHelpers = indexerTestHelpers<MockDb>();
const { MockDb, BiPoolManager, VirtualPool } = TestHelpers;

const CHAIN_ID = 42220;
const BIPOOL_MANAGER_ADDRESS = "0x22d9db95e6ae61c104a7b6f6c78d7993b94ec901";
const VP_ADDRESS = "0x000000000000000000000000000000000000beef";
const ASSET0 = "0x00000000000000000000000000000000000000a0";
const ASSET1 = "0x00000000000000000000000000000000000000a1";
const CONSTANT_SUM_MAINNET = "0xdebed1f6f6ce9f6e73aa25f95acbffe2397550fb";
const EXCHANGE_A = "0x" + "11".repeat(32);
const FEED_A = "0x000000000000000000000000000000000000bea1";
const EXCHANGE_B = "0x" + "22".repeat(32); // "poison" — must never be adopted.
const FEED_B = "0x000000000000000000000000000000000000bea2";

function mockEventData(logIndex: number, blockNumber: number): MockEventData {
  return createMockEventData({
    chainId: CHAIN_ID,
    logIndex,
    srcAddress: VP_ADDRESS,
    blockNumber,
    blockTimestamp: 1_700_000_000 + blockNumber,
  });
}

function structFor(exchangeId: string, feed: string): PoolExchangeStruct {
  return {
    asset0: ASSET0,
    asset1: ASSET1,
    pricingModule: CONSTANT_SUM_MAINNET,
    bucket0: 1_000_000n,
    bucket1: 2_000_000n,
    lastBucketUpdate: 1_700_001_000n,
    spread: 5n * 10n ** 21n,
    referenceRateFeedID: feed,
    referenceRateResetFrequency: 360n,
    minimumReports: 3n,
    stablePoolResetSize: 100_000n,
  };
}

function mockVpAs(exchangeId: string, feed: string): void {
  _setMockVpExchangeId(CHAIN_ID, VP_ADDRESS, {
    exchangeProvider: BIPOOL_MANAGER_ADDRESS,
    exchangeId,
  });
  _setMockPoolExchange(
    CHAIN_ID,
    BIPOOL_MANAGER_ADDRESS,
    exchangeId,
    structFor(exchangeId, feed),
  );
  // A positive, resolved reporter count is required for the gate's
  // reporter-count condition to ever settle true — without this,
  // `oracleNumReporters` stays at the -1 "unknown" sentinel forever and
  // `needsOracleReporterCountRefresh` keeps reporting incomplete, which
  // would mask the "heal fires exactly once" claim these tests make.
  _setMockNumReporters(CHAIN_ID, feed, 3);
}

function swapEvent(logIndex: number, blockNumber: number) {
  return VirtualPool.Swap.createMockEvent({
    sender: ASSET0,
    amount0In: 1_000_000n,
    amount1In: 0n,
    amount0Out: 0n,
    amount1Out: 990_000n,
    to: ASSET1,
    mockEventData: mockEventData(logIndex, blockNumber),
  });
}

type PoolRow = {
  wrappedExchangeId?: string;
  referenceRateFeedID: string;
  oracleFreshnessWindow: bigint;
  oracleNumReporters: number;
  token0?: string;
  token1?: string;
  token0Decimals: number;
  token1Decimals: number;
};

/** Narrow a Pool row down to the fields `hasCompleteWrappedExchangeLink`
 * actually gates on. `updatedAtBlock`/`updatedAtTimestamp` always advance
 * with the event, so a whole-row comparison across events would be a false
 * negative for the "steady state" claim these tests make. */
function linkFields(pool: PoolRow): Omit<PoolRow, never> {
  const {
    wrappedExchangeId,
    referenceRateFeedID,
    oracleFreshnessWindow,
    oracleNumReporters,
    token0,
    token1,
    token0Decimals,
    token1Decimals,
  } = pool;
  return {
    wrappedExchangeId,
    referenceRateFeedID,
    oracleFreshnessWindow,
    oracleNumReporters,
    token0,
    token1,
    token0Decimals,
    token1Decimals,
  };
}

describe("hasCompleteWrappedExchangeLink gate (issue #1053 scenario 1)", () => {
  beforeEach(() => {
    _clearMockPoolExchanges();
    _clearMockVpExchangeIds();
    _clearMockTokenDecimalsScaling();
    _clearMockNumReporters();
    _setMockTokenDecimalsScaling(CHAIN_ID, VP_ADDRESS, "decimals0", 10n ** 6n);
    _setMockTokenDecimalsScaling(CHAIN_ID, VP_ADDRESS, "decimals1", 10n ** 18n);
  });

  it("condition A (incomplete: no wrappedExchangeId/tokens yet) — first event heals from scratch", async () => {
    mockVpAs(EXCHANGE_A, FEED_A);
    let mockDb = MockDb.createMockDb();

    mockDb = await VirtualPool.Swap.processEvent({
      event: swapEvent(0, 100),
      mockDb,
    });

    const poolId = makePoolId(CHAIN_ID, VP_ADDRESS);
    const pool = mockDb.entities.Pool.get(poolId) as PoolRow | undefined;
    assert.ok(pool, "Pool must exist after the healing Swap");
    assert.equal(pool!.wrappedExchangeId, EXCHANGE_A.toLowerCase());
    assert.equal(pool!.referenceRateFeedID, FEED_A);
    assert.equal(pool!.token0, ASSET0);
    assert.equal(pool!.token1, ASSET1);
  });

  it("all conditions true — the heal fires exactly once; later events do not re-derive the link", async () => {
    mockVpAs(EXCHANGE_A, FEED_A);
    let mockDb = MockDb.createMockDb();

    // Event 1: heals from scratch (condition A false -> heal fires).
    mockDb = await VirtualPool.Swap.processEvent({
      event: swapEvent(0, 100),
      mockDb,
    });
    const poolId = makePoolId(CHAIN_ID, VP_ADDRESS);
    const afterFirstHeal = mockDb.entities.Pool.get(poolId) as
      | PoolRow
      | undefined;
    assert.ok(afterFirstHeal);
    assert.equal(afterFirstHeal!.wrappedExchangeId, EXCHANGE_A.toLowerCase());
    assert.equal(afterFirstHeal!.referenceRateFeedID, FEED_A);
    assert.equal(afterFirstHeal!.oracleFreshnessWindow, 360n);

    // Event 2: link is now fully consistent (all gate conditions true) —
    // steady-state re-processing must not drift any field.
    mockDb = await VirtualPool.Swap.processEvent({
      event: swapEvent(1, 200),
      mockDb,
    });
    const afterSteadyState = mockDb.entities.Pool.get(poolId) as
      | PoolRow
      | undefined;
    assert.ok(afterSteadyState);
    assert.deepEqual(
      linkFields(afterSteadyState!),
      linkFields(afterFirstHeal!),
    );

    // Event 3: flip the VP-bytecode-probe and PoolExchange mocks to a
    // DIFFERENT ("poisoned") exchange/feed. If the gate incorrectly
    // re-evaluated the heal (bypassing its short-circuit), the Pool row
    // would adopt EXCHANGE_B/FEED_B here. Because all 4 conditions were
    // already true, `hasCompleteWrappedExchangeLink` must return true and
    // `selfHealWrappedExchangeId` must return the pool unchanged — proving
    // the heal fired exactly once (at event 1) for this pool's lifetime.
    mockVpAs(EXCHANGE_B, FEED_B);
    mockDb = await VirtualPool.Swap.processEvent({
      event: swapEvent(2, 300),
      mockDb,
    });
    const afterPoisonedMock = mockDb.entities.Pool.get(poolId) as
      | PoolRow
      | undefined;
    assert.ok(afterPoisonedMock);
    assert.equal(
      afterPoisonedMock!.wrappedExchangeId,
      EXCHANGE_A.toLowerCase(),
      "gate must short-circuit — wrappedExchangeId must not adopt the poisoned mock",
    );
    assert.equal(afterPoisonedMock!.referenceRateFeedID, FEED_A);
    assert.equal(afterPoisonedMock!.oracleFreshnessWindow, 360n);

    const exchangeRow = mockDb.entities.BiPoolExchange.get(
      `${CHAIN_ID}-${EXCHANGE_A.toLowerCase()}`,
    );
    assert.ok(exchangeRow, "the original BiPoolExchange row must remain");
    const poisonedRow = mockDb.entities.BiPoolExchange.get(
      `${CHAIN_ID}-${EXCHANGE_B.toLowerCase()}`,
    );
    assert.equal(
      poisonedRow,
      undefined,
      "the poisoned exchange must never get seeded once the link is complete",
    );
  });

  it("BiPoolExchange row seeded via ExchangeCreated then VP heals — back-link condition already true short-circuits the seed RPC on the next event", async () => {
    // Complementary ordering to the "condition A" test above: exchange
    // exists FIRST (BiPoolManager.ExchangeCreated), then the VP heals
    // against it. Confirms the gate's back-link condition (BiPoolExchange
    // row present AND wrappedByPoolId === pool.id) is satisfied by the
    // heal's own write, not just by a subsequent independent event.
    mockVpAs(EXCHANGE_A, FEED_A);
    let mockDb = MockDb.createMockDb();

    const created = BiPoolManager.ExchangeCreated.createMockEvent({
      exchangeId: EXCHANGE_A,
      asset0: ASSET0,
      asset1: ASSET1,
      pricingModule: CONSTANT_SUM_MAINNET,
      mockEventData: createMockEventData({
        chainId: CHAIN_ID,
        logIndex: 0,
        srcAddress: BIPOOL_MANAGER_ADDRESS,
        blockNumber: 100,
        blockTimestamp: 1_700_000_000,
      }),
    });
    mockDb = await BiPoolManager.ExchangeCreated.processEvent({
      event: created,
      mockDb,
    });

    mockDb = await VirtualPool.Swap.processEvent({
      event: swapEvent(1, 200),
      mockDb,
    });
    const poolId = makePoolId(CHAIN_ID, VP_ADDRESS);
    const healed = mockDb.entities.Pool.get(poolId) as PoolRow | undefined;
    assert.ok(healed);
    assert.equal(healed!.wrappedExchangeId, EXCHANGE_A.toLowerCase());

    // Poison the mocks and process one more event — the back-link is
    // already correct, so this must be a no-op exactly like the test above.
    mockVpAs(EXCHANGE_B, FEED_B);
    mockDb = await VirtualPool.Swap.processEvent({
      event: swapEvent(2, 300),
      mockDb,
    });
    const stillHealed = mockDb.entities.Pool.get(poolId) as PoolRow | undefined;
    assert.ok(stillHealed);
    assert.deepEqual(linkFields(stillHealed!), linkFields(healed!));
  });
});
