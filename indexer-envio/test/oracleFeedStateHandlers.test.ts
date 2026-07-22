import assert from "node:assert/strict";
import type { Pool } from "envio";
import {
  indexerTestHelpers,
  processMockEvents,
  type EntityCollection,
  type MockDbWith,
  type WritableEntity,
} from "./helpers/indexerTestHarness.js";
import {
  _clearBootstrapCaches,
  _clearBreakerMocks,
  _clearMockMedianTimestamps,
  _clearMockReportExpiry,
  _setMockBreakerList,
  _setMockOracleReportTimestamps,
  _setMockReportExpiryConfig,
} from "../src/EventHandlers.ts";
import { makePoolId } from "../src/helpers.ts";
import {
  bootstrapOracleFeedState,
  oracleFeedStateId,
} from "../src/oracleFeedState.ts";
import {
  bootstrapOracleExpiryState,
  oracleExpiryStateId,
} from "../src/oracleExpiryState.ts";
import { registerMockRateFeedDependenciesHttp } from "../src/rpc/http-test-mock-bridge.js";
import { makePool } from "./helpers/makePool.js";

type MockDb = MockDbWith<{
  Breaker: WritableEntity;
  BreakerConfig: WritableEntity;
  DeviationThresholdBreach: EntityCollection;
  OracleFeedState: WritableEntity;
  OracleExpiryState: WritableEntity;
  OracleSnapshot: EntityCollection;
  Pool: WritableEntity<Pool>;
  PoolDailySnapshot: EntityCollection;
  RateFeed: WritableEntity;
  RateFeedDependency: WritableEntity;
}>;

const TestHelpers = indexerTestHelpers<MockDb>();
const { MockDb, SortedOracles } = TestHelpers;

const CHAIN_ID = 42220;
const FEED = "0xf4f9bbda9cd6841fcb9b1510f9269e2db42a6e3a";
const SORTED_ORACLES = "0xefb84935239dacdecf7c5ba76d8de40b077b7b33";
const ONE = 10n ** 24n;

function createTrackedPoolDb(address: string, overrides: Partial<Pool> = {}) {
  const poolId = makePoolId(CHAIN_ID, address);
  let mockDb = MockDb.createMockDb();
  mockDb = mockDb.entities.Pool.set(
    makePool({
      id: poolId,
      referenceRateFeedID: FEED,
      reserves0: 10n ** 21n,
      reserves1: 10n ** 21n,
      invertRateFeedKnown: true,
      tokenDecimalsKnown: true,
      oracleExpiry: 3_600n,
      lastMedianPrice: ONE,
      medianLive: true,
      ...overrides,
    }),
  );
  return { mockDb, poolId };
}

describe("SortedOracles event-sourced feed state", () => {
  beforeEach(() => {
    _clearBreakerMocks();
    _clearBootstrapCaches();
    _setMockBreakerList(CHAIN_ID, []);
    _setMockReportExpiryConfig(CHAIN_ID, FEED, {
      globalReportExpiry: 3_600n,
      tokenReportExpiry: 0n,
      reportExpiry: 3_600n,
    });
    registerMockRateFeedDependenciesHttp(CHAIN_ID, FEED, []);
  });

  afterEach(() => {
    _clearBreakerMocks();
    _clearMockMedianTimestamps();
    _clearMockReportExpiry();
  });

  it("skips the timestamp-list bootstrap when no pools track the feed", async () => {
    const blockTimestamp = 1_700_002_000;
    const mockDb = await SortedOracles.OracleReported.processEvent({
      event: SortedOracles.OracleReported.createMockEvent({
        token: FEED,
        oracle: "0x00000000000000000000000000000000000000aa",
        value: ONE,
        timestamp: BigInt(blockTimestamp - 100),
        mockEventData: {
          chainId: CHAIN_ID,
          logIndex: 7,
          srcAddress: SORTED_ORACLES,
          block: { number: 60_664_501, timestamp: blockTimestamp },
        },
      }),
      mockDb: MockDb.createMockDb(),
    });

    assert.deepEqual(mockDb.entities.Pool.getAll(), []);
    assert.equal(
      mockDb.entities.OracleFeedState.get(oracleFeedStateId(CHAIN_ID, FEED)),
      undefined,
    );
  });

  it("absorbs block-close state when an old pool starts tracking mid-block", async () => {
    const firstTimestamp = 1_700_002_150n;
    const secondTimestamp = 1_700_002_250n;
    const thirdTimestamp = 1_700_002_275n;
    _setMockOracleReportTimestamps(CHAIN_ID, FEED, {
      reporters: [
        "0x00000000000000000000000000000000000000aa",
        "0x00000000000000000000000000000000000000bb",
        "0x00000000000000000000000000000000000000cc",
      ],
      timestamps: [firstTimestamp, secondTimestamp, thirdTimestamp],
    });
    const block = { number: 60_664_502, timestamp: 1_700_002_300 };
    const poolId = makePoolId(
      CHAIN_ID,
      "0x0000000000000000000000000000000000008566",
    );
    let mockDb = MockDb.createMockDb();
    mockDb = mockDb.entities.Pool.set(
      makePool({
        id: poolId,
        referenceRateFeedID: "",
        createdAtBlock: 60_000_000n,
        createdAtTimestamp: 1_600_000_000n,
        updatedAtBlock: 60_664_000n,
        updatedAtTimestamp: 1_699_000_000n,
      }),
    );
    mockDb = await SortedOracles.OracleReported.processEvent({
      event: SortedOracles.OracleReported.createMockEvent({
        token: FEED,
        oracle: "0x00000000000000000000000000000000000000aa",
        value: ONE,
        timestamp: firstTimestamp,
        mockEventData: {
          chainId: CHAIN_ID,
          logIndex: 1,
          srcAddress: SORTED_ORACLES,
          block,
        },
      }),
      mockDb,
    });
    assert.equal(
      mockDb.entities.OracleFeedState.get(oracleFeedStateId(CHAIN_ID, FEED)),
      undefined,
    );

    // Simulate a deploy-RPC self-heal assigning the feed between oracle logs.
    mockDb = mockDb.entities.Pool.set(
      makePool({
        id: poolId,
        referenceRateFeedID: FEED,
        reserves0: 10n ** 21n,
        reserves1: 10n ** 21n,
        invertRateFeedKnown: true,
        tokenDecimalsKnown: true,
        oracleExpiry: 300n,
        lastMedianPrice: ONE,
        createdAtBlock: 60_000_000n,
        createdAtTimestamp: 1_600_000_000n,
        updatedAtBlock: BigInt(block.number),
        updatedAtTimestamp: BigInt(block.timestamp),
      }),
    );
    mockDb = await SortedOracles.OracleReported.processEvent({
      event: SortedOracles.OracleReported.createMockEvent({
        token: FEED,
        oracle: "0x00000000000000000000000000000000000000bb",
        value: ONE,
        timestamp: secondTimestamp,
        mockEventData: {
          chainId: CHAIN_ID,
          logIndex: 7,
          srcAddress: SORTED_ORACLES,
          block,
        },
      }),
      mockDb,
    });

    let state = mockDb.entities.OracleFeedState.get(
      oracleFeedStateId(CHAIN_ID, FEED),
    ) as {
      activeReporters: string[];
      activeReportTimestamps: bigint[];
      medianReportTimestamp: bigint;
      reportExpiry: bigint;
      bootstrapThroughBlock: bigint;
      updatedAtTimestamp: bigint;
    };
    assert.deepEqual(state.activeReporters, [
      "0x00000000000000000000000000000000000000aa",
      "0x00000000000000000000000000000000000000bb",
      "0x00000000000000000000000000000000000000cc",
    ]);
    assert.equal(state.medianReportTimestamp, secondTimestamp);
    assert.equal(state.reportExpiry, 3_600n);
    assert.equal(state.bootstrapThroughBlock, BigInt(block.number));
    assert.equal(state.updatedAtTimestamp, BigInt(block.timestamp));
    const expiryState = mockDb.entities.OracleExpiryState.get(
      oracleExpiryStateId(CHAIN_ID, FEED),
    ) as { reportExpiry: bigint; bootstrapThroughBlock: bigint };
    assert.equal(expiryState.reportExpiry, 3_600n);
    assert.equal(expiryState.bootstrapThroughBlock, BigInt(block.number));
    assert.equal(mockDb.entities.Pool.get(poolId)?.oracleExpiry, 3_600n);

    // The block-close snapshot already includes this later log. Processing it
    // must be an absorbed no-op rather than a duplicate transition failure.
    mockDb = await SortedOracles.OracleReported.processEvent({
      event: SortedOracles.OracleReported.createMockEvent({
        token: FEED,
        oracle: "0x00000000000000000000000000000000000000cc",
        value: ONE,
        timestamp: thirdTimestamp,
        mockEventData: {
          chainId: CHAIN_ID,
          logIndex: 9,
          srcAddress: SORTED_ORACLES,
          block,
        },
      }),
      mockDb,
    });
    state = mockDb.entities.OracleFeedState.get(
      oracleFeedStateId(CHAIN_ID, FEED),
    ) as typeof state;
    assert.deepEqual(state.activeReportTimestamps, [
      firstTimestamp,
      secondTimestamp,
      thirdTimestamp,
    ]);
    assert.equal(state.medianReportTimestamp, secondTimestamp);
  });

  it("bootstraps once, then processes later reports without another timestamp RPC", async () => {
    _setMockOracleReportTimestamps(CHAIN_ID, FEED, {
      reporters: [
        "0x00000000000000000000000000000000000000aa",
        "0x00000000000000000000000000000000000000bb",
        "0x00000000000000000000000000000000000000cc",
      ],
      timestamps: [1_700_002_800n, 1_700_002_850n, 1_700_002_900n],
    });
    const seeded = createTrackedPoolDb(
      "0x0000000000000000000000000000000000008561",
    );
    let { mockDb } = seeded;
    const { poolId } = seeded;

    mockDb = await SortedOracles.OracleReported.processEvent({
      event: SortedOracles.OracleReported.createMockEvent({
        token: FEED,
        oracle: "0x00000000000000000000000000000000000000aa",
        value: ONE,
        timestamp: 1_700_002_950n,
        mockEventData: {
          chainId: CHAIN_ID,
          logIndex: 4,
          srcAddress: SORTED_ORACLES,
          block: { number: 60_664_510, timestamp: 1_700_003_000 },
        },
      }),
      mockDb,
    });

    const feedStateId = oracleFeedStateId(CHAIN_ID, FEED);
    const initialState = mockDb.entities.OracleFeedState.get(feedStateId) as {
      bootstrapThroughBlock: bigint;
      medianReportTimestamp: bigint;
    };
    assert.equal(initialState.bootstrapThroughBlock, 60_664_509n);
    assert.equal(initialState.medianReportTimestamp, 1_700_002_900n);

    // A second process invocation has a fresh Envio effect cache. If the
    // handler regresses to traffic-scaled getTimestamps calls, this explicit
    // RPC failure makes the event fail instead of silently passing via cache.
    _setMockOracleReportTimestamps(CHAIN_ID, FEED, null);
    mockDb = await SortedOracles.OracleReported.processEvent({
      event: SortedOracles.OracleReported.createMockEvent({
        token: FEED,
        oracle: "0x00000000000000000000000000000000000000bb",
        value: ONE,
        timestamp: 1_700_003_050n,
        mockEventData: {
          chainId: CHAIN_ID,
          logIndex: 2,
          srcAddress: SORTED_ORACLES,
          block: { number: 60_664_511, timestamp: 1_700_003_100 },
        },
      }),
      mockDb,
    });

    assert.equal(
      (
        mockDb.entities.OracleFeedState.get(feedStateId) as {
          medianReportTimestamp: bigint;
        }
      ).medianReportTimestamp,
      1_700_002_950n,
    );
    assert.equal(
      mockDb.entities.Pool.get(poolId)?.lastOracleReportAt,
      1_700_002_950n,
    );
  });

  it("lets MedianUpdated consume state written by the preceding report log", async () => {
    _setMockOracleReportTimestamps(CHAIN_ID, FEED, {
      reporters: [
        "0x00000000000000000000000000000000000000aa",
        "0x00000000000000000000000000000000000000bb",
      ],
      timestamps: [1_700_003_000n, 1_700_003_050n],
    });
    const seeded = createTrackedPoolDb(
      "0x0000000000000000000000000000000000008567",
    );
    let { mockDb } = seeded;
    const { poolId } = seeded;
    const block = { number: 60_664_530, timestamp: 1_700_003_200 };
    const medianValue = 11n * 10n ** 23n;

    mockDb = await processMockEvents({
      events: [
        SortedOracles.OracleReported.createMockEvent({
          token: FEED,
          oracle: "0x00000000000000000000000000000000000000aa",
          value: 2n * ONE,
          timestamp: 1_700_003_100n,
          mockEventData: {
            chainId: CHAIN_ID,
            logIndex: 4,
            srcAddress: SORTED_ORACLES,
            block,
          },
        }),
        SortedOracles.MedianUpdated.createMockEvent({
          token: FEED,
          value: medianValue,
          mockEventData: {
            chainId: CHAIN_ID,
            logIndex: 5,
            srcAddress: SORTED_ORACLES,
            block,
          },
        }),
      ],
      mockDb,
    });

    assert.equal(mockDb.entities.Pool.get(poolId)?.oraclePrice, medianValue);
    assert.equal(
      mockDb.entities.Pool.get(poolId)?.lastOracleReportAt,
      1_700_003_100n,
    );
  });

  it("updates pool freshness when a removal changes only the timestamp median", async () => {
    _setMockOracleReportTimestamps(CHAIN_ID, FEED, {
      reporters: [
        "0x00000000000000000000000000000000000000aa",
        "0x00000000000000000000000000000000000000bb",
        "0x00000000000000000000000000000000000000cc",
      ],
      timestamps: [1_700_003_000n, 1_700_003_100n, 1_700_003_200n],
    });
    const seeded = createTrackedPoolDb(
      "0x0000000000000000000000000000000000008563",
      { oracleOk: true },
    );
    let { mockDb } = seeded;
    const { poolId } = seeded;

    mockDb = await SortedOracles.OracleReportRemoved.processEvent({
      event: SortedOracles.OracleReportRemoved.createMockEvent({
        token: FEED,
        oracle: "0x00000000000000000000000000000000000000cc",
        mockEventData: {
          chainId: CHAIN_ID,
          logIndex: 7,
          srcAddress: SORTED_ORACLES,
          block: { number: 60_664_512, timestamp: 1_700_003_300 },
        },
      }),
      mockDb,
    });

    const state = mockDb.entities.OracleFeedState.get(
      oracleFeedStateId(CHAIN_ID, FEED),
    ) as { medianReportTimestamp: bigint; activeReporters: string[] };
    assert.equal(state.medianReportTimestamp, 1_700_003_100n);
    assert.deepEqual(state.activeReporters, [
      "0x00000000000000000000000000000000000000aa",
      "0x00000000000000000000000000000000000000bb",
    ]);
    assert.equal(
      mockDb.entities.Pool.get(poolId)?.lastOracleReportAt,
      1_700_003_100n,
    );
  });

  it("updates persisted feed and pool expiry from TokenReportExpirySet", async () => {
    const feedStateId = oracleFeedStateId(CHAIN_ID, FEED);
    const seeded = createTrackedPoolDb(
      "0x0000000000000000000000000000000000008564",
      { oracleExpiry: 300n },
    );
    let { mockDb } = seeded;
    const { poolId } = seeded;
    mockDb = mockDb.entities.OracleFeedState.set(
      bootstrapOracleFeedState({
        chainId: CHAIN_ID,
        rateFeedID: FEED,
        reporters: ["0x00000000000000000000000000000000000000aa"],
        timestamps: [1_700_003_000n],
        reportExpiry: 300n,
        bootstrapThroughBlock: 60_664_519n,
      }),
    );

    mockDb = await SortedOracles.TokenReportExpirySet.processEvent({
      event: SortedOracles.TokenReportExpirySet.createMockEvent({
        token: FEED,
        reportExpiry: 31_536_000n,
        mockEventData: {
          chainId: CHAIN_ID,
          logIndex: 1,
          srcAddress: SORTED_ORACLES,
          block: { number: 60_664_520, timestamp: 1_700_003_500 },
        },
      }),
      mockDb,
    });

    assert.equal(
      (
        mockDb.entities.OracleFeedState.get(feedStateId) as {
          reportExpiry: bigint;
        }
      ).reportExpiry,
      31_536_000n,
    );
    assert.equal(mockDb.entities.Pool.get(poolId)?.oracleExpiry, 31_536_000n);
  });

  it("restores the global expiry when a token override is cleared", async () => {
    const tokenOverride = 31_536_000n;
    const globalExpiry = 150n;
    _setMockReportExpiryConfig(CHAIN_ID, FEED, {
      globalReportExpiry: globalExpiry,
      tokenReportExpiry: tokenOverride,
      reportExpiry: tokenOverride,
    });
    const feedStateId = oracleFeedStateId(CHAIN_ID, FEED);
    const seeded = createTrackedPoolDb(
      "0x0000000000000000000000000000000000008565",
      { oracleExpiry: tokenOverride },
    );
    let { mockDb } = seeded;
    const { poolId } = seeded;
    mockDb = mockDb.entities.OracleFeedState.set(
      bootstrapOracleFeedState({
        chainId: CHAIN_ID,
        rateFeedID: FEED,
        reporters: ["0x00000000000000000000000000000000000000aa"],
        timestamps: [1_700_003_000n],
        reportExpiry: tokenOverride,
        bootstrapThroughBlock: 60_664_520n,
      }),
    );

    mockDb = await SortedOracles.TokenReportExpirySet.processEvent({
      event: SortedOracles.TokenReportExpirySet.createMockEvent({
        token: FEED,
        reportExpiry: 0n,
        mockEventData: {
          chainId: CHAIN_ID,
          logIndex: 3,
          srcAddress: SORTED_ORACLES,
          block: { number: 60_664_521, timestamp: 1_700_003_600 },
        },
      }),
      mockDb,
    });

    const state = mockDb.entities.OracleFeedState.get(feedStateId) as {
      reportExpiry: bigint;
      updatedAtBlock: bigint;
      updatedAtLogIndex: number;
      updatedAtTimestamp: bigint;
    };
    assert.equal(state.reportExpiry, globalExpiry);
    assert.equal(state.updatedAtBlock, 60_664_521n);
    assert.equal(state.updatedAtLogIndex, 3);
    assert.equal(state.updatedAtTimestamp, 1_700_003_600n);
    assert.equal(mockDb.entities.Pool.get(poolId)?.oracleExpiry, globalExpiry);
  });

  it("applies same-block token and global expiry events in log order", async () => {
    const tokenOverride = 31_536_000n;
    const feedStateId = oracleFeedStateId(CHAIN_ID, FEED);
    const expiryStateId = oracleExpiryStateId(CHAIN_ID, FEED);
    const seeded = createTrackedPoolDb(
      "0x0000000000000000000000000000000000008566",
      { oracleExpiry: tokenOverride },
    );
    let { mockDb } = seeded;
    const { poolId } = seeded;
    mockDb = mockDb.entities.OracleFeedState.set(
      bootstrapOracleFeedState({
        chainId: CHAIN_ID,
        rateFeedID: FEED,
        reporters: ["0x00000000000000000000000000000000000000aa"],
        timestamps: [1_700_003_000n],
        reportExpiry: tokenOverride,
        bootstrapThroughBlock: 60_664_519n,
      }),
    );
    mockDb = mockDb.entities.OracleExpiryState.set(
      bootstrapOracleExpiryState({
        chainId: CHAIN_ID,
        rateFeedID: FEED,
        globalReportExpiry: 300n,
        tokenReportExpiry: tokenOverride,
        bootstrapThroughBlock: 60_664_519n,
      }),
    );
    // Prove both events consume persisted raw state instead of consulting the
    // block-close RPC value, which could include the later log.
    _setMockReportExpiryConfig(CHAIN_ID, FEED, null);
    const block = { number: 60_664_520, timestamp: 1_700_003_500 };

    mockDb = await SortedOracles.TokenReportExpirySet.processEvent({
      event: SortedOracles.TokenReportExpirySet.createMockEvent({
        token: FEED,
        reportExpiry: 0n,
        mockEventData: {
          chainId: CHAIN_ID,
          logIndex: 1,
          srcAddress: SORTED_ORACLES,
          block,
        },
      }),
      mockDb,
    });
    const clearedState = mockDb.entities.OracleExpiryState.get(
      expiryStateId,
    ) as { reportExpiry: bigint; updatedAtLogIndex: number };
    assert.equal(clearedState.reportExpiry, 300n);
    assert.equal(clearedState.updatedAtLogIndex, 1);
    assert.equal(mockDb.entities.Pool.get(poolId)?.oracleExpiry, 300n);

    mockDb = await SortedOracles.ReportExpirySet.processEvent({
      event: SortedOracles.ReportExpirySet.createMockEvent({
        reportExpiry: 600n,
        mockEventData: {
          chainId: CHAIN_ID,
          logIndex: 3,
          srcAddress: SORTED_ORACLES,
          block,
        },
      }),
      mockDb,
    });
    const expiryState = mockDb.entities.OracleExpiryState.get(
      expiryStateId,
    ) as {
      globalReportExpiry: bigint;
      tokenReportExpiry: bigint;
      reportExpiry: bigint;
      updatedAtLogIndex: number;
    };
    assert.equal(expiryState.globalReportExpiry, 600n);
    assert.equal(expiryState.tokenReportExpiry, 0n);
    assert.equal(expiryState.reportExpiry, 600n);
    assert.equal(expiryState.updatedAtLogIndex, 3);
    assert.equal(
      (
        mockDb.entities.OracleFeedState.get(feedStateId) as {
          reportExpiry: bigint;
        }
      ).reportExpiry,
      600n,
    );
    assert.equal(mockDb.entities.Pool.get(poolId)?.oracleExpiry, 600n);
  });

  it("ignores zero-clear events for feeds that were never tracked", async () => {
    _setMockReportExpiryConfig(CHAIN_ID, FEED, null);
    const mockDb = await SortedOracles.TokenReportExpirySet.processEvent({
      event: SortedOracles.TokenReportExpirySet.createMockEvent({
        token: FEED,
        reportExpiry: 0n,
        mockEventData: {
          chainId: CHAIN_ID,
          logIndex: 1,
          srcAddress: SORTED_ORACLES,
          block: { number: 60_664_521, timestamp: 1_700_003_600 },
        },
      }),
      mockDb: MockDb.createMockDb(),
    });

    assert.deepEqual(mockDb.entities.Pool.getAll(), []);
    assert.equal(
      mockDb.entities.OracleExpiryState.get(
        oracleExpiryStateId(CHAIN_ID, FEED),
      ),
      undefined,
    );
  });

  it("fails before writes when a cleared override fallback is unavailable", async () => {
    const tokenOverride = 31_536_000n;
    _setMockReportExpiryConfig(CHAIN_ID, FEED, null);
    const feedStateId = oracleFeedStateId(CHAIN_ID, FEED);
    const seeded = createTrackedPoolDb(
      "0x0000000000000000000000000000000000008567",
      { oracleExpiry: tokenOverride },
    );
    let { mockDb } = seeded;
    const { poolId } = seeded;
    mockDb = mockDb.entities.OracleFeedState.set(
      bootstrapOracleFeedState({
        chainId: CHAIN_ID,
        rateFeedID: FEED,
        reporters: ["0x00000000000000000000000000000000000000aa"],
        timestamps: [1_700_003_000n],
        reportExpiry: tokenOverride,
        bootstrapThroughBlock: 60_664_521n,
      }),
    );

    await assert.rejects(
      SortedOracles.TokenReportExpirySet.processEvent({
        event: SortedOracles.TokenReportExpirySet.createMockEvent({
          token: FEED,
          reportExpiry: 0n,
          mockEventData: {
            chainId: CHAIN_ID,
            logIndex: 4,
            srcAddress: SORTED_ORACLES,
            block: { number: 60_664_522, timestamp: 1_700_003_700 },
          },
        }),
        mockDb,
      }),
      /Worker exited with code 1/,
    );

    assert.equal(
      (
        mockDb.entities.OracleFeedState.get(feedStateId) as {
          reportExpiry: bigint;
        }
      ).reportExpiry,
      tokenOverride,
    );
    assert.equal(mockDb.entities.Pool.get(poolId)?.oracleExpiry, tokenOverride);
  });

  it("preserves a token override when the global expiry changes", async () => {
    const tokenOverride = 31_536_000n;
    _setMockReportExpiryConfig(CHAIN_ID, FEED, {
      globalReportExpiry: 300n,
      tokenReportExpiry: tokenOverride,
      reportExpiry: tokenOverride,
    });
    const feedStateId = oracleFeedStateId(CHAIN_ID, FEED);
    const seeded = createTrackedPoolDb(
      "0x0000000000000000000000000000000000008568",
      { oracleExpiry: tokenOverride },
    );
    let { mockDb } = seeded;
    const { poolId } = seeded;
    mockDb = mockDb.entities.OracleFeedState.set(
      bootstrapOracleFeedState({
        chainId: CHAIN_ID,
        rateFeedID: FEED,
        reporters: ["0x00000000000000000000000000000000000000aa"],
        timestamps: [1_700_003_000n],
        reportExpiry: tokenOverride,
        bootstrapThroughBlock: 60_664_520n,
      }),
    );

    mockDb = await SortedOracles.ReportExpirySet.processEvent({
      event: SortedOracles.ReportExpirySet.createMockEvent({
        reportExpiry: 150n,
        mockEventData: {
          chainId: CHAIN_ID,
          logIndex: 2,
          srcAddress: SORTED_ORACLES,
          block: { number: 60_664_521, timestamp: 1_700_003_600 },
        },
      }),
      mockDb,
    });

    const state = mockDb.entities.OracleFeedState.get(feedStateId) as {
      reportExpiry: bigint;
      updatedAtBlock: bigint;
    };
    assert.equal(state.reportExpiry, tokenOverride);
    assert.equal(state.updatedAtBlock, 60_664_521n);
    assert.equal(mockDb.entities.Pool.get(poolId)?.oracleExpiry, tokenOverride);
  });
});
