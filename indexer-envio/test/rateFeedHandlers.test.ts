import assert from "node:assert/strict";
import type { Pool, RateFeed } from "envio";
import {
  indexerTestHelpers,
  type MockDbWith,
  type WritableEntity,
} from "./helpers/indexerTestHarness.js";
import { makePool } from "./helpers/makePool.js";
import { makePoolId } from "../src/helpers.js";
import { makeRateFeedId } from "../src/oracleReporters.js";
import {
  _clearMockRateFeedOracles,
  _clearMockNumReporters,
  _setMockRateFeedOracles,
  _setMockNumReporters,
} from "../src/EventHandlers.ts";
import { UNKNOWN_ORACLE_REPORTERS } from "../src/constants.js";

type MockDb = MockDbWith<{
  Pool: WritableEntity<Pool>;
  RateFeed: WritableEntity<RateFeed>;
}>;

const TestHelpers = indexerTestHelpers<MockDb>();
const { MockDb, SortedOracles } = TestHelpers;

const CELO = 42220;
const MONAD = 143;
const CELO_GBP_FEED = "0xf590b62f9cfcc6409075b1ecac8176fe25744b88";
const CELO_GBP_REPORTER = "0x215d3ba962597defb38da439ed4db8e8a63e409a";
const MONAD_GBP_FEED = "0xea4103a6a122fbe2cdb07a80d4d293be07bb29fa";
const MONAD_GBP_REPORTER = "0xdb8fc8c6daac8f73e21e9cc145440ab899d60e55";
const UNKNOWN_REPORTER = "0x0000000000000000000000000000000000000001";
const SORTED_ORACLES = "0xefb84935239dacdecf7c5ba76d8de40b077b7b33";

describe("RateFeed handlers", () => {
  afterEach(() => {
    _clearMockRateFeedOracles();
    _clearMockNumReporters();
  });

  it("writes chain-scoped RateFeed rows from OracleAdded", async () => {
    _setMockRateFeedOracles(CELO, CELO_GBP_FEED, [
      CELO_GBP_REPORTER,
      UNKNOWN_REPORTER,
    ]);
    let mockDb = MockDb.createMockDb();

    mockDb = await SortedOracles.OracleAdded.processEvent({
      event: SortedOracles.OracleAdded.createMockEvent({
        token: CELO_GBP_FEED,
        oracleAddress: CELO_GBP_REPORTER,
        mockEventData: {
          chainId: CELO,
          srcAddress: SORTED_ORACLES,
          block: { number: 100, timestamp: 1_700_000_000 },
        },
      }),
      mockDb,
    });

    const row = mockDb.entities.RateFeed.get(
      makeRateFeedId(CELO, CELO_GBP_FEED),
    );
    assert.ok(row);
    assert.equal(row.pair, "GBP/USD");
    assert.deepEqual(row.reporters, [CELO_GBP_REPORTER, UNKNOWN_REPORTER]);
    assert.deepEqual(row.reporterTypes, ["CHAINLINK", "MANUAL"]);
    assert.equal(row.reportersComplete, true);
    assert.equal(row.updatedAtBlock, 100n);
  });

  it("updates virtual pool reporter counts from OracleAdded numRates", async () => {
    _setMockRateFeedOracles(CELO, CELO_GBP_FEED, [
      CELO_GBP_REPORTER,
      UNKNOWN_REPORTER,
    ]);
    _setMockNumReporters(CELO, CELO_GBP_FEED, 1);
    const poolId = makePoolId(
      CELO,
      "0x8c0014afe032e4574481d8934504100bf23fcb56",
    );
    let mockDb = MockDb.createMockDb();
    mockDb = mockDb.entities.Pool.set(
      makePool({
        id: poolId,
        chainId: CELO,
        source: "virtual_pool_factory",
        referenceRateFeedID: CELO_GBP_FEED,
        oracleNumReporters: 0,
      }),
    );

    mockDb = await SortedOracles.OracleAdded.processEvent({
      event: SortedOracles.OracleAdded.createMockEvent({
        token: CELO_GBP_FEED,
        oracleAddress: CELO_GBP_REPORTER,
        mockEventData: {
          chainId: CELO,
          srcAddress: SORTED_ORACLES,
          block: { number: 100, timestamp: 1_700_000_000 },
        },
      }),
      mockDb,
    });

    const pool = mockDb.entities.Pool.get(poolId);
    assert.ok(pool);
    assert.equal(pool.oracleNumReporters, 1);
    assert.equal(pool.updatedAtBlock, 100n);
    assert.equal(pool.updatedAtTimestamp, 1_700_000_000n);
  });

  it("updates virtual pool reporter counts from OracleRemoved", async () => {
    _setMockRateFeedOracles(CELO, CELO_GBP_FEED, [CELO_GBP_REPORTER]);
    _setMockNumReporters(CELO, CELO_GBP_FEED, 1);
    const poolId = makePoolId(
      CELO,
      "0x8c0014afe032e4574481d8934504100bf23fcb56",
    );
    let mockDb = MockDb.createMockDb();
    mockDb = mockDb.entities.Pool.set(
      makePool({
        id: poolId,
        chainId: CELO,
        source: "virtual_pool_factory",
        referenceRateFeedID: CELO_GBP_FEED,
        oracleNumReporters: 2,
      }),
    );

    mockDb = await SortedOracles.OracleRemoved.processEvent({
      event: SortedOracles.OracleRemoved.createMockEvent({
        token: CELO_GBP_FEED,
        oracleAddress: UNKNOWN_REPORTER,
        mockEventData: {
          chainId: CELO,
          srcAddress: SORTED_ORACLES,
          block: { number: 101, timestamp: 1_700_000_060 },
        },
      }),
      mockDb,
    });

    const pool = mockDb.entities.Pool.get(poolId);
    assert.ok(pool);
    assert.equal(pool.oracleNumReporters, 1);
    assert.equal(pool.updatedAtBlock, 101n);
    assert.equal(pool.updatedAtTimestamp, 1_700_000_060n);
  });

  it("falls back to the OracleAdded event when reporter RPC is unavailable", async () => {
    _setMockRateFeedOracles(CELO, CELO_GBP_FEED, null);
    let mockDb = MockDb.createMockDb();

    mockDb = await SortedOracles.OracleAdded.processEvent({
      event: SortedOracles.OracleAdded.createMockEvent({
        token: CELO_GBP_FEED,
        oracleAddress: CELO_GBP_REPORTER,
        mockEventData: {
          chainId: CELO,
          srcAddress: SORTED_ORACLES,
          block: { number: 101, timestamp: 1_700_000_060 },
        },
      }),
      mockDb,
    });

    const row = mockDb.entities.RateFeed.get(
      makeRateFeedId(CELO, CELO_GBP_FEED),
    );
    assert.ok(row);
    assert.deepEqual(row.reporters, [CELO_GBP_REPORTER]);
    assert.deepEqual(row.reporterTypes, ["CHAINLINK"]);
    assert.equal(row.reportersComplete, false);
    assert.equal(row.updatedAtBlock, 101n);
  });

  it("keeps reporterTypes aligned with reporters when OracleRemoved falls back from a complete row", async () => {
    _setMockRateFeedOracles(CELO, CELO_GBP_FEED, null);
    const rateFeedId = makeRateFeedId(CELO, CELO_GBP_FEED);
    let mockDb = MockDb.createMockDb();
    mockDb = mockDb.entities.RateFeed.set({
      id: rateFeedId,
      chainId: CELO,
      feedAddress: CELO_GBP_FEED,
      pair: "GBP/USD",
      reporters: [CELO_GBP_REPORTER, UNKNOWN_REPORTER],
      reporterTypes: ["CHAINLINK", "MANUAL"],
      reportersComplete: true,
      updatedAtBlock: 100n,
      updatedAtTimestamp: 1_700_000_000n,
    });

    mockDb = await SortedOracles.OracleRemoved.processEvent({
      event: SortedOracles.OracleRemoved.createMockEvent({
        token: CELO_GBP_FEED,
        oracleAddress: UNKNOWN_REPORTER,
        mockEventData: {
          chainId: CELO,
          srcAddress: SORTED_ORACLES,
          block: { number: 101, timestamp: 1_700_000_060 },
        },
      }),
      mockDb,
    });

    const row = mockDb.entities.RateFeed.get(rateFeedId);
    assert.ok(row);
    assert.deepEqual(row.reporters, [CELO_GBP_REPORTER]);
    assert.deepEqual(row.reporterTypes, ["CHAINLINK"]);
    assert.equal(row.reportersComplete, true);
    assert.equal(row.updatedAtBlock, 101n);
  });

  it("retries RPC hydration after a partial OracleAdded fallback", async () => {
    _setMockRateFeedOracles(CELO, CELO_GBP_FEED, null);
    _setMockNumReporters(CELO, CELO_GBP_FEED, null);
    const poolId = makePoolId(
      CELO,
      "0x8c0014afe032e4574481d8934504100bf23fcb56",
    );
    let mockDb = MockDb.createMockDb();
    mockDb = mockDb.entities.Pool.set(
      makePool({
        id: poolId,
        chainId: CELO,
        referenceRateFeedID: CELO_GBP_FEED,
        tokenDecimalsKnown: true,
        invertRateFeedKnown: true,
        oracleExpiry: 300n,
        reserves0: 10n ** 18n,
        reserves1: 10n ** 18n,
      }),
    );

    mockDb = await SortedOracles.OracleAdded.processEvent({
      event: SortedOracles.OracleAdded.createMockEvent({
        token: CELO_GBP_FEED,
        oracleAddress: CELO_GBP_REPORTER,
        mockEventData: {
          chainId: CELO,
          srcAddress: SORTED_ORACLES,
          block: { number: 101, timestamp: 1_700_000_060 },
        },
      }),
      mockDb,
    });
    assert.equal(
      mockDb.entities.RateFeed.get(makeRateFeedId(CELO, CELO_GBP_FEED))
        ?.reportersComplete,
      false,
    );
    assert.equal(
      mockDb.entities.Pool.get(poolId)?.oracleNumReporters,
      UNKNOWN_ORACLE_REPORTERS,
    );

    _setMockRateFeedOracles(CELO, CELO_GBP_FEED, [
      CELO_GBP_REPORTER,
      UNKNOWN_REPORTER,
    ]);
    _setMockNumReporters(CELO, CELO_GBP_FEED, 2);
    mockDb = await SortedOracles.MedianUpdated.processEvent({
      event: SortedOracles.MedianUpdated.createMockEvent({
        token: CELO_GBP_FEED,
        value: 10n ** 24n,
        mockEventData: {
          chainId: CELO,
          srcAddress: SORTED_ORACLES,
          block: { number: 102, timestamp: 1_700_000_120 },
        },
      }),
      mockDb,
    });

    const row = mockDb.entities.RateFeed.get(
      makeRateFeedId(CELO, CELO_GBP_FEED),
    );
    assert.ok(row);
    assert.deepEqual(row.reporters, [CELO_GBP_REPORTER, UNKNOWN_REPORTER]);
    assert.deepEqual(row.reporterTypes, ["CHAINLINK", "MANUAL"]);
    assert.equal(row.reportersComplete, true);
    assert.equal(row.updatedAtBlock, 102n);
    assert.equal(mockDb.entities.Pool.get(poolId)?.oracleNumReporters, 2);
  });

  it("repairs unknown pool reporter counts when the feed row is already complete", async () => {
    _setMockNumReporters(CELO, CELO_GBP_FEED, 2);
    const poolId = makePoolId(
      CELO,
      "0x8c0014afe032e4574481d8934504100bf23fcb56",
    );
    let mockDb = MockDb.createMockDb();
    mockDb = mockDb.entities.RateFeed.set({
      id: makeRateFeedId(CELO, CELO_GBP_FEED),
      chainId: CELO,
      feedAddress: CELO_GBP_FEED,
      pair: "GBP/USD",
      reporters: [CELO_GBP_REPORTER, UNKNOWN_REPORTER],
      reporterTypes: ["CHAINLINK", "MANUAL"],
      reportersComplete: true,
      updatedAtBlock: 100n,
      updatedAtTimestamp: 1_700_000_000n,
    });
    mockDb = mockDb.entities.Pool.set(
      makePool({
        id: poolId,
        chainId: CELO,
        referenceRateFeedID: CELO_GBP_FEED,
        oracleNumReporters: UNKNOWN_ORACLE_REPORTERS,
        tokenDecimalsKnown: true,
        invertRateFeedKnown: true,
        oracleExpiry: 300n,
        reserves0: 10n ** 18n,
        reserves1: 10n ** 18n,
      }),
    );

    mockDb = await SortedOracles.MedianUpdated.processEvent({
      event: SortedOracles.MedianUpdated.createMockEvent({
        token: CELO_GBP_FEED,
        value: 10n ** 24n,
        mockEventData: {
          chainId: CELO,
          srcAddress: SORTED_ORACLES,
          block: { number: 103, timestamp: 1_700_000_180 },
        },
      }),
      mockDb,
    });

    assert.equal(mockDb.entities.Pool.get(poolId)?.oracleNumReporters, 2);
  });

  it("bootstraps an existing feed on MedianUpdated when add/remove events predate start_block", async () => {
    _setMockRateFeedOracles(CELO, CELO_GBP_FEED, [CELO_GBP_REPORTER]);
    const poolId = makePoolId(
      CELO,
      "0x8c0014afe032e4574481d8934504100bf23fcb56",
    );
    let mockDb = MockDb.createMockDb();
    mockDb = mockDb.entities.Pool.set(
      makePool({
        id: poolId,
        chainId: CELO,
        referenceRateFeedID: CELO_GBP_FEED,
        tokenDecimalsKnown: true,
        invertRateFeedKnown: true,
        oracleExpiry: 300n,
        reserves0: 10n ** 18n,
        reserves1: 10n ** 18n,
      }),
    );

    mockDb = await SortedOracles.MedianUpdated.processEvent({
      event: SortedOracles.MedianUpdated.createMockEvent({
        token: CELO_GBP_FEED,
        value: 10n ** 24n,
        mockEventData: {
          chainId: CELO,
          srcAddress: SORTED_ORACLES,
          block: { number: 200, timestamp: 1_700_000_120 },
        },
      }),
      mockDb,
    });

    const row = mockDb.entities.RateFeed.get(
      makeRateFeedId(CELO, CELO_GBP_FEED),
    );
    assert.ok(row);
    assert.equal(row.pair, "GBP/USD");
    assert.deepEqual(row.reporters, [CELO_GBP_REPORTER]);
    assert.deepEqual(row.reporterTypes, ["CHAINLINK"]);
    assert.equal(row.reportersComplete, true);
  });

  it("does not collide when the same feed address appears on two chains", async () => {
    _setMockRateFeedOracles(MONAD, MONAD_GBP_FEED, [MONAD_GBP_REPORTER]);
    _setMockRateFeedOracles(CELO, MONAD_GBP_FEED, [UNKNOWN_REPORTER]);
    let mockDb = MockDb.createMockDb();

    mockDb = await SortedOracles.OracleAdded.processEvent({
      event: SortedOracles.OracleAdded.createMockEvent({
        token: MONAD_GBP_FEED,
        oracleAddress: MONAD_GBP_REPORTER,
        mockEventData: {
          chainId: MONAD,
          srcAddress: SORTED_ORACLES,
          block: { number: 300, timestamp: 1_700_000_180 },
        },
      }),
      mockDb,
    });
    mockDb = await SortedOracles.OracleAdded.processEvent({
      event: SortedOracles.OracleAdded.createMockEvent({
        token: MONAD_GBP_FEED,
        oracleAddress: UNKNOWN_REPORTER,
        mockEventData: {
          chainId: CELO,
          srcAddress: SORTED_ORACLES,
          block: { number: 301, timestamp: 1_700_000_240 },
        },
      }),
      mockDb,
    });

    const monad = mockDb.entities.RateFeed.get(
      makeRateFeedId(MONAD, MONAD_GBP_FEED),
    );
    const celo = mockDb.entities.RateFeed.get(
      makeRateFeedId(CELO, MONAD_GBP_FEED),
    );
    assert.ok(monad);
    assert.ok(celo);
    assert.notEqual(monad.id, celo.id);
    assert.equal(monad.pair, "GBP/USD");
    assert.equal(celo.pair, "Unknown");
  });
});
