import assert from "node:assert/strict";
import {
  indexerTestHelpers,
  type EntityCollection,
  type MockDbWith,
  type WritableEntity,
} from "./helpers/indexerTestHarness.js";
import {
  _clearBootstrapCaches,
  _clearBreakerMocks,
  _setMockBreakerDefaults,
  _setMockBreakerFeedState,
  _setMockBreakerKind,
  _setMockBreakerList,
} from "../src/EventHandlers.ts";
import { makePoolId } from "../src/helpers.ts";
import { makePool } from "./helpers/makePool.js";
import { registerMockRateFeedDependenciesHttp } from "../src/rpc/http-test-mock-bridge.js";

type MockDb = MockDbWith<{
  Breaker: WritableEntity;
  BreakerConfig: WritableEntity;
  DeviationThresholdBreach: EntityCollection;
  OracleSnapshot: EntityCollection;
  Pool: WritableEntity;
  PoolDailySnapshot: EntityCollection;
  RateFeed: WritableEntity;
  RateFeedDependency: WritableEntity;
}>;

const TestHelpers = indexerTestHelpers<MockDb>();
const { MockDb, SortedOracles } = TestHelpers;

const CHAIN_ID = 42220;
const MD_BREAKER = "0x49349f92d2b17d491e42c8fdb02d19f072f9b5d9";
const FEED = "0xf4f9bbda9cd6841fcb9b1510f9269e2db42a6e3a";
const SORTED_ORACLES = "0xefb84935239dacdecf7c5ba76d8de40b077b7b33";
const ONE = 10n ** 24n;

describe("SortedOracles.OracleReported median parity", () => {
  beforeEach(() => {
    _clearBreakerMocks();
    _clearBootstrapCaches();
    _setMockBreakerList(CHAIN_ID, [MD_BREAKER]);
    _setMockBreakerKind(CHAIN_ID, MD_BREAKER, "MEDIAN_DELTA");
    _setMockBreakerDefaults(CHAIN_ID, MD_BREAKER, {
      activatesTradingMode: 3,
      defaultCooldownTime: 900n,
      defaultRateChangeThreshold: 4n * 10n ** 22n,
    });
    _setMockBreakerFeedState(CHAIN_ID, MD_BREAKER, FEED, {
      enabled: true,
      tradingMode: 0,
      lastStatusUpdatedAt: 1_700_000_000n,
      cooldownTime: 0n,
      rateChangeThreshold: 0n,
      smoothingFactor: 5n * 10n ** 21n,
      medianRatesEMA: ONE,
      referenceValue: null,
    });
  });

  afterEach(() => {
    _clearBreakerMocks();
  });

  async function processReport({
    lastMedianPrice,
    medianLive = true,
    existingPriceDifference = 0n,
    value,
    blockTimestamp = 1_700_002_000,
  }: {
    lastMedianPrice: bigint;
    medianLive?: boolean;
    existingPriceDifference?: bigint;
    value: bigint;
    blockTimestamp?: number;
  }) {
    registerMockRateFeedDependenciesHttp(CHAIN_ID, FEED, []);

    let mockDb = MockDb.createMockDb();
    const poolId = makePoolId(
      CHAIN_ID,
      "0x0000000000000000000000000000000000008560",
    );
    mockDb = mockDb.entities.Pool.set(
      makePool({
        id: poolId,
        referenceRateFeedID: FEED,
        reserves0: 10n ** 21n,
        reserves1: 10n ** 21n,
        invertRateFeedKnown: true,
        tokenDecimalsKnown: true,
        oracleExpiry: 1_700_010_000n,
        lastMedianPrice,
        medianLive,
        priceDifference: existingPriceDifference,
      }),
    );

    const blockNumber = 301;
    const logIndex = 6;
    mockDb = await SortedOracles.OracleReported.processEvent({
      event: SortedOracles.OracleReported.createMockEvent({
        token: FEED,
        reporter: "0x00000000000000000000000000000000000000aa",
        value,
        timestamp: BigInt(blockTimestamp - 100),
        mockEventData: {
          chainId: CHAIN_ID,
          logIndex,
          srcAddress: SORTED_ORACLES,
          block: { number: blockNumber, timestamp: blockTimestamp },
        },
      }),
      mockDb,
    });

    return {
      mockDb,
      poolId,
      snapshotId: `${CHAIN_ID}_${blockNumber}_${logIndex}-${poolId}`,
      blockTimestamp: BigInt(blockTimestamp),
    };
  }

  it("does not open a breach for an outlier reporter quote when the median is in-band", async () => {
    const { mockDb, poolId, snapshotId } = await processReport({
      lastMedianPrice: ONE,
      value: 3n * ONE,
    });

    const pool = mockDb.entities.Pool.get(poolId)!;
    const snapshot = mockDb.entities.OracleSnapshot.get(snapshotId)!;

    assert.equal(pool.deviationBreachStartedAt, 0n);
    assert.equal(pool.healthStatus, "OK");
    assert.equal(pool.priceDifference, 0n);
    assert.equal(pool.oraclePrice, 3n * ONE);
    assert.equal(snapshot.priceDifference, 0n);
    assert.equal(snapshot.oraclePrice, 3n * ONE);
  });

  it("opens a breach for a deviating median even when the reporter quote looks in-band", async () => {
    const { mockDb, poolId, blockTimestamp } = await processReport({
      lastMedianPrice: 3n * ONE,
      value: ONE,
    });

    const pool = mockDb.entities.Pool.get(poolId)!;

    assert.equal(pool.deviationBreachStartedAt, blockTimestamp);
    assert.equal(pool.healthStatus, "WARN");
  });

  it("freezes deviation when the median is unusable", async () => {
    const { mockDb, poolId } = await processReport({
      lastMedianPrice: 0n,
      medianLive: false,
      existingPriceDifference: 123n,
      value: 3n * ONE,
    });

    const pool = mockDb.entities.Pool.get(poolId)!;

    assert.equal(pool.priceDifference, 123n);
    assert.equal(pool.deviationBreachStartedAt, 0n);
  });
});
