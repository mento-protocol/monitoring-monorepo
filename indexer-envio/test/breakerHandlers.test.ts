import assert from "node:assert/strict";
import {
  indexerTestHelpers,
  type EntityReader,
  type MockDbWith,
  type WritableEntity,
} from "./helpers/indexerTestHarness.js";
import {
  _setMockBreakerKind,
  _setMockBreakerDefaults,
  _setMockBreakerFeedState,
  _setMockBreakerList,
  _clearBreakerMocks,
  _clearBootstrapCaches,
} from "../src/EventHandlers.ts";
import { makeBreakerConfigId, makeBreakerId } from "../src/breakers.ts";
import { makePoolId } from "../src/helpers.ts";
import { makePool } from "./helpers/makePool.js";

type MockDb = MockDbWith<{
  Breaker: WritableEntity;
  BreakerConfig: WritableEntity;
  BreakerTripEvent: EntityReader;
  Pool: WritableEntity;
}>;

const TestHelpers = indexerTestHelpers<MockDb>();
const { MockDb, BreakerBox, MedianDeltaBreaker, SortedOracles } = TestHelpers;

const CHAIN_ID = 42220;
// Match the real Celo addresses so any future test that hits
// `requireContractAddress(chainId, "BreakerBox")` finds them.
const BREAKER_BOX_ADDR = "0x303ed1df62fa067659b586ebee8de0ece824ab39";
const MD_BREAKER = "0x49349f92d2b17d491e42c8fdb02d19f072f9b5d9";
const FEED = "0xf4f9bbda9cd6841fcb9b1510f9269e2db42a6e3a";

const COOLDOWN = 900n; // 15 min — production value
const THRESHOLD = 4n * 10n ** 22n; // 4% Fixidity

describe("BreakerBox handlers — bootstrap + state transitions", () => {
  beforeEach(() => {
    _clearBreakerMocks();
    _clearBootstrapCaches();
    // RPC self-heal payload for fetchBreakerKind / Defaults / FeedState.
    _setMockBreakerList(CHAIN_ID, [MD_BREAKER]);
    _setMockBreakerKind(CHAIN_ID, MD_BREAKER, "MEDIAN_DELTA");
    _setMockBreakerDefaults(CHAIN_ID, MD_BREAKER, {
      activatesTradingMode: 3,
      defaultCooldownTime: COOLDOWN,
      defaultRateChangeThreshold: THRESHOLD,
    });
    _setMockBreakerFeedState(CHAIN_ID, MD_BREAKER, FEED, {
      enabled: true,
      tradingMode: 0,
      lastStatusUpdatedAt: 1_700_000_000n,
      cooldownTime: 0n, // inherits default
      rateChangeThreshold: 0n, // inherits default
      smoothingFactor: 5n * 10n ** 21n, // 0.5%
      medianRatesEMA: 1_171_560_280_196_965_000_000_000n,
      referenceValue: null,
    });
  });

  afterEach(() => {
    _clearBreakerMocks();
  });

  it("BreakerStatusUpdated bootstraps Breaker + BreakerConfig from RPC mocks", async () => {
    const mockDb = MockDb.createMockDb();
    const event = BreakerBox.BreakerStatusUpdated.createMockEvent({
      breaker: MD_BREAKER,
      rateFeedID: FEED,
      status: true,
      mockEventData: {
        chainId: CHAIN_ID,
        logIndex: 0,
        srcAddress: BREAKER_BOX_ADDR,
        block: { number: 100, timestamp: 1_700_000_500 },
      },
    });
    const next = await BreakerBox.BreakerStatusUpdated.processEvent({
      event,
      mockDb,
    });

    const breaker = next.entities.Breaker.get(
      makeBreakerId(CHAIN_ID, MD_BREAKER),
    ) as
      | {
          kind: string;
          activatesTradingMode: number;
          defaultCooldownTime: bigint;
          defaultRateChangeThreshold: bigint;
          removed: boolean;
        }
      | undefined;
    assert.ok(breaker, "Breaker entity should be created via RPC self-heal");
    assert.equal(breaker!.kind, "MEDIAN_DELTA");
    assert.equal(breaker!.activatesTradingMode, 3);
    assert.equal(breaker!.defaultCooldownTime, COOLDOWN);
    assert.equal(breaker!.defaultRateChangeThreshold, THRESHOLD);
    assert.equal(breaker!.removed, false);

    const cfg = next.entities.BreakerConfig.get(
      makeBreakerConfigId(CHAIN_ID, MD_BREAKER, FEED),
    ) as
      | {
          enabled: boolean;
          status: string;
          tradingMode: number;
          cooldownEndsAt: bigint;
          medianRatesEMA: bigint;
          smoothingFactor: bigint;
        }
      | undefined;
    assert.ok(cfg, "BreakerConfig should be created");
    assert.equal(cfg!.enabled, true);
    assert.equal(cfg!.status, "OK");
    assert.equal(cfg!.tradingMode, 0);
    // cooldownEndsAt = lastStatusUpdatedAt (1_700_000_000) + effective cooldown (900)
    assert.equal(cfg!.cooldownEndsAt, 1_700_000_900n);
    assert.equal(cfg!.smoothingFactor, 5n * 10n ** 21n);
    assert.equal(cfg!.medianRatesEMA, 1_171_560_280_196_965_000_000_000n);
  });

  it("BreakerTripped writes BreakerTripEvent + transitions BreakerConfig to TRIPPED", async () => {
    let mockDb = MockDb.createMockDb();
    // First, bootstrap via BreakerStatusUpdated.
    const seed = BreakerBox.BreakerStatusUpdated.createMockEvent({
      breaker: MD_BREAKER,
      rateFeedID: FEED,
      status: true,
      mockEventData: {
        chainId: CHAIN_ID,
        logIndex: 0,
        srcAddress: BREAKER_BOX_ADDR,
        block: { number: 100, timestamp: 1_700_000_500 },
      },
    });
    mockDb = await BreakerBox.BreakerStatusUpdated.processEvent({
      event: seed,
      mockDb,
    });

    // Then trip.
    const tripEvent = BreakerBox.BreakerTripped.createMockEvent({
      breaker: MD_BREAKER,
      rateFeedID: FEED,
      mockEventData: {
        chainId: CHAIN_ID,
        logIndex: 7,
        srcAddress: BREAKER_BOX_ADDR,
        block: { number: 200, timestamp: 1_700_001_000 },
      },
    });
    mockDb = await BreakerBox.BreakerTripped.processEvent({
      event: tripEvent,
      mockDb,
    });

    const cfg = mockDb.entities.BreakerConfig.get(
      makeBreakerConfigId(CHAIN_ID, MD_BREAKER, FEED),
    ) as
      | {
          status: string;
          tradingMode: number;
          tripCountLifetime: number;
          lastStatusUpdatedAt: bigint;
          cooldownEndsAt: bigint;
          lastTripAt: bigint;
        }
      | undefined;
    assert.ok(cfg);
    assert.equal(cfg!.status, "TRIPPED");
    assert.equal(cfg!.tradingMode, 3);
    assert.equal(cfg!.tripCountLifetime, 1);
    assert.equal(cfg!.lastStatusUpdatedAt, 1_700_001_000n);
    assert.equal(cfg!.cooldownEndsAt, 1_700_001_000n + COOLDOWN);
    assert.equal(cfg!.lastTripAt, 1_700_001_000n);

    // BreakerTripEvent row should also exist. ID = eventId(chainId, blockNumber, logIndex).
    const tripRow = mockDb.entities.BreakerTripEvent.get(
      `${CHAIN_ID}_200_7`,
    ) as
      | {
          rateFeedID: string;
          thresholdAtTrip: bigint;
          medianRateAtTrip: bigint;
          referenceAtTrip: bigint;
        }
      | undefined;
    assert.ok(tripRow, "BreakerTripEvent should be written");
    assert.equal(tripRow!.rateFeedID, FEED);
    // thresholdAtTrip resolves the sentinel-0 inheritance to the EFFECTIVE
    // threshold so historical trip data captures the value that actually
    // caused the trip (not the inherit-marker). Per-feed override here is
    // 0 → falls back to breaker default (THRESHOLD = 4%).
    assert.equal(tripRow!.thresholdAtTrip, THRESHOLD);
    // referenceAtTrip = the EMA snapshot we mirrored at bootstrap time.
    assert.equal(tripRow!.referenceAtTrip, 1_171_560_280_196_965_000_000_000n);
  });

  it("BreakerTripped sets Pool.breakerTripped=true; ResetSuccessful clears it", async () => {
    let mockDb = MockDb.createMockDb();
    const poolId = makePoolId(
      CHAIN_ID,
      "0xabc0000000000000000000000000000000000001",
    );
    // Seed a pool wired to this feed, untripped.
    mockDb = mockDb.entities.Pool.set(
      makePool({
        id: poolId,
        chainId: CHAIN_ID,
        referenceRateFeedID: FEED,
        breakerTripped: false,
      }),
    );

    // Bootstrap the (MEDIAN_DELTA) breaker config for the feed.
    mockDb = await BreakerBox.BreakerStatusUpdated.processEvent({
      event: BreakerBox.BreakerStatusUpdated.createMockEvent({
        breaker: MD_BREAKER,
        rateFeedID: FEED,
        status: true,
        mockEventData: {
          chainId: CHAIN_ID,
          logIndex: 0,
          srcAddress: BREAKER_BOX_ADDR,
          block: { number: 100, timestamp: 1_700_000_500 },
        },
      }),
      mockDb,
    });

    // Trip → pool halted.
    mockDb = await BreakerBox.BreakerTripped.processEvent({
      event: BreakerBox.BreakerTripped.createMockEvent({
        breaker: MD_BREAKER,
        rateFeedID: FEED,
        mockEventData: {
          chainId: CHAIN_ID,
          logIndex: 7,
          srcAddress: BREAKER_BOX_ADDR,
          block: { number: 200, timestamp: 1_700_001_000 },
        },
      }),
      mockDb,
    });
    assert.equal(
      (mockDb.entities.Pool.get(poolId) as { breakerTripped: boolean })
        .breakerTripped,
      true,
      "pool should be halted after the price breaker trips",
    );

    // Reset → pool tradeable again.
    mockDb = await BreakerBox.ResetSuccessful.processEvent({
      event: BreakerBox.ResetSuccessful.createMockEvent({
        rateFeedID: FEED,
        breaker: MD_BREAKER,
        mockEventData: {
          chainId: CHAIN_ID,
          logIndex: 9,
          srcAddress: BREAKER_BOX_ADDR,
          block: { number: 300, timestamp: 1_700_002_000 },
        },
      }),
      mockDb,
    });
    assert.equal(
      (mockDb.entities.Pool.get(poolId) as { breakerTripped: boolean })
        .breakerTripped,
      false,
      "pool halt should clear after reset",
    );
  });

  it("ResetSuccessful transitions BreakerConfig back to OK and refreshes cooldownEndsAt", async () => {
    let mockDb = MockDb.createMockDb();
    // Seed + trip.
    const seed = BreakerBox.BreakerStatusUpdated.createMockEvent({
      breaker: MD_BREAKER,
      rateFeedID: FEED,
      status: true,
      mockEventData: {
        chainId: CHAIN_ID,
        logIndex: 0,
        srcAddress: BREAKER_BOX_ADDR,
        block: { number: 100, timestamp: 1_700_000_500 },
      },
    });
    mockDb = await BreakerBox.BreakerStatusUpdated.processEvent({
      event: seed,
      mockDb,
    });
    const trip = BreakerBox.BreakerTripped.createMockEvent({
      breaker: MD_BREAKER,
      rateFeedID: FEED,
      mockEventData: {
        chainId: CHAIN_ID,
        logIndex: 7,
        srcAddress: BREAKER_BOX_ADDR,
        block: { number: 200, timestamp: 1_700_001_000 },
      },
    });
    mockDb = await BreakerBox.BreakerTripped.processEvent({
      event: trip,
      mockDb,
    });

    // Reset.
    const reset = BreakerBox.ResetSuccessful.createMockEvent({
      rateFeedID: FEED,
      breaker: MD_BREAKER,
      mockEventData: {
        chainId: CHAIN_ID,
        logIndex: 9,
        srcAddress: BREAKER_BOX_ADDR,
        block: { number: 300, timestamp: 1_700_002_000 },
      },
    });
    mockDb = await BreakerBox.ResetSuccessful.processEvent({
      event: reset,
      mockDb,
    });

    const cfg = mockDb.entities.BreakerConfig.get(
      makeBreakerConfigId(CHAIN_ID, MD_BREAKER, FEED),
    ) as
      | {
          status: string;
          tradingMode: number;
          lastResetAt: bigint;
          cooldownEndsAt: bigint;
          tripCountLifetime: number;
        }
      | undefined;
    assert.ok(cfg);
    assert.equal(cfg!.status, "OK");
    assert.equal(cfg!.tradingMode, 0);
    assert.equal(cfg!.lastResetAt, 1_700_002_000n);
    assert.equal(cfg!.cooldownEndsAt, 1_700_002_000n + COOLDOWN);
    // tripCountLifetime is monotonic — reset doesn't decrement.
    assert.equal(cfg!.tripCountLifetime, 1);
  });

  it("MedianDeltaBreaker.MedianRateEMAReset zeroes medianRatesEMA so next median re-seeds", async () => {
    let mockDb = MockDb.createMockDb();
    const seed = BreakerBox.BreakerStatusUpdated.createMockEvent({
      breaker: MD_BREAKER,
      rateFeedID: FEED,
      status: true,
      mockEventData: {
        chainId: CHAIN_ID,
        logIndex: 0,
        srcAddress: BREAKER_BOX_ADDR,
        block: { number: 100, timestamp: 1_700_000_500 },
      },
    });
    mockDb = await BreakerBox.BreakerStatusUpdated.processEvent({
      event: seed,
      mockDb,
    });

    const reset = MedianDeltaBreaker.MedianRateEMAReset.createMockEvent({
      rateFeedID: FEED,
      mockEventData: {
        chainId: CHAIN_ID,
        logIndex: 1,
        srcAddress: MD_BREAKER,
        block: { number: 110, timestamp: 1_700_000_600 },
      },
    });
    mockDb = await MedianDeltaBreaker.MedianRateEMAReset.processEvent({
      event: reset,
      mockDb,
    });

    const cfg = mockDb.entities.BreakerConfig.get(
      makeBreakerConfigId(CHAIN_ID, MD_BREAKER, FEED),
    ) as { medianRatesEMA: bigint } | undefined;
    assert.ok(cfg);
    assert.equal(cfg!.medianRatesEMA, 0n);
  });

  it("BreakerRemoved marks the Breaker removed and disables all child configs on the same chain", async () => {
    let mockDb = MockDb.createMockDb();
    // Seed the Breaker + a config with enabled=true.
    const seed = BreakerBox.BreakerStatusUpdated.createMockEvent({
      breaker: MD_BREAKER,
      rateFeedID: FEED,
      status: true,
      mockEventData: {
        chainId: CHAIN_ID,
        logIndex: 0,
        srcAddress: BREAKER_BOX_ADDR,
        block: { number: 100, timestamp: 1_700_000_500 },
      },
    });
    mockDb = await BreakerBox.BreakerStatusUpdated.processEvent({
      event: seed,
      mockDb,
    });

    const removed = BreakerBox.BreakerRemoved.createMockEvent({
      breaker: MD_BREAKER,
      mockEventData: {
        chainId: CHAIN_ID,
        logIndex: 1,
        srcAddress: BREAKER_BOX_ADDR,
        block: { number: 200, timestamp: 1_700_001_000 },
      },
    });
    mockDb = await BreakerBox.BreakerRemoved.processEvent({
      event: removed,
      mockDb,
    });

    const breaker = mockDb.entities.Breaker.get(
      makeBreakerId(CHAIN_ID, MD_BREAKER),
    ) as { removed: boolean } | undefined;
    assert.ok(breaker);
    assert.equal(breaker!.removed, true);

    const cfg = mockDb.entities.BreakerConfig.get(
      makeBreakerConfigId(CHAIN_ID, MD_BREAKER, FEED),
    ) as { enabled: boolean } | undefined;
    assert.ok(cfg);
    assert.equal(cfg!.enabled, false);
  });

  it("TradingModeUpdated overrides BreakerConfig.tradingMode for matching feed", async () => {
    let mockDb = MockDb.createMockDb();
    const seed = BreakerBox.BreakerStatusUpdated.createMockEvent({
      breaker: MD_BREAKER,
      rateFeedID: FEED,
      status: true,
      mockEventData: {
        chainId: CHAIN_ID,
        logIndex: 0,
        srcAddress: BREAKER_BOX_ADDR,
        block: { number: 100, timestamp: 1_700_000_500 },
      },
    });
    mockDb = await BreakerBox.BreakerStatusUpdated.processEvent({
      event: seed,
      mockDb,
    });

    // Owner manually halts via setRateFeedTradingMode → mode 3.
    const override = BreakerBox.TradingModeUpdated.createMockEvent({
      rateFeedID: FEED,
      tradingMode: 3n,
      mockEventData: {
        chainId: CHAIN_ID,
        logIndex: 2,
        srcAddress: BREAKER_BOX_ADDR,
        block: { number: 250, timestamp: 1_700_001_500 },
      },
    });
    mockDb = await BreakerBox.TradingModeUpdated.processEvent({
      event: override,
      mockDb,
    });

    const cfg = mockDb.entities.BreakerConfig.get(
      makeBreakerConfigId(CHAIN_ID, MD_BREAKER, FEED),
    ) as
      | { tradingMode: number; status: string; lastStatusUpdatedAt: bigint }
      | undefined;
    assert.ok(cfg);
    assert.equal(cfg!.tradingMode, 3);
    assert.equal(cfg!.status, "TRIPPED");
    assert.equal(cfg!.lastStatusUpdatedAt, 1_700_001_500n);
  });

  it("TradingModeUpdated bootstraps missing BreakerConfig rows before applying override", async () => {
    let mockDb = MockDb.createMockDb();

    const override = BreakerBox.TradingModeUpdated.createMockEvent({
      rateFeedID: FEED,
      tradingMode: 3n,
      mockEventData: {
        chainId: CHAIN_ID,
        logIndex: 2,
        srcAddress: BREAKER_BOX_ADDR,
        block: { number: 250, timestamp: 1_700_001_500 },
      },
    });
    mockDb = await BreakerBox.TradingModeUpdated.processEvent({
      event: override,
      mockDb,
    });

    const cfg = mockDb.entities.BreakerConfig.get(
      makeBreakerConfigId(CHAIN_ID, MD_BREAKER, FEED),
    ) as { enabled: boolean; tradingMode: number; status: string } | undefined;
    assert.ok(cfg, "missing config should be hydrated from the breaker list");
    assert.equal(cfg!.enabled, true);
    assert.equal(cfg!.tradingMode, 3);
    assert.equal(cfg!.status, "TRIPPED");
  });

  it("TradingModeUpdated (manual override) drives Pool.breakerTripped and clears it", async () => {
    let mockDb = MockDb.createMockDb();
    const poolId = makePoolId(
      CHAIN_ID,
      "0xabc0000000000000000000000000000000000002",
    );
    mockDb = mockDb.entities.Pool.set(
      makePool({
        id: poolId,
        chainId: CHAIN_ID,
        referenceRateFeedID: FEED,
        breakerTripped: false,
      }),
    );

    // Manual halt override (bootstraps the MEDIAN_DELTA config, sets TRIPPED).
    mockDb = await BreakerBox.TradingModeUpdated.processEvent({
      event: BreakerBox.TradingModeUpdated.createMockEvent({
        rateFeedID: FEED,
        tradingMode: 3n,
        mockEventData: {
          chainId: CHAIN_ID,
          logIndex: 2,
          srcAddress: BREAKER_BOX_ADDR,
          block: { number: 250, timestamp: 1_700_001_500 },
        },
      }),
      mockDb,
    });
    assert.equal(
      (mockDb.entities.Pool.get(poolId) as { breakerTripped: boolean })
        .breakerTripped,
      true,
      "manual halt override should mark the pool halted",
    );

    // Manual clear (tradingMode 0).
    mockDb = await BreakerBox.TradingModeUpdated.processEvent({
      event: BreakerBox.TradingModeUpdated.createMockEvent({
        rateFeedID: FEED,
        tradingMode: 0n,
        mockEventData: {
          chainId: CHAIN_ID,
          logIndex: 3,
          srcAddress: BREAKER_BOX_ADDR,
          block: { number: 260, timestamp: 1_700_002_000 },
        },
      }),
      mockDb,
    });
    assert.equal(
      (mockDb.entities.Pool.get(poolId) as { breakerTripped: boolean })
        .breakerTripped,
      false,
      "manual clear should lift the halt",
    );
  });

  it("TradingModeUpdated leaves disabled BreakerConfigs untouched", async () => {
    let mockDb = MockDb.createMockDb();
    // Seed an ENABLED config, then immediately disable it.
    const seed = BreakerBox.BreakerStatusUpdated.createMockEvent({
      breaker: MD_BREAKER,
      rateFeedID: FEED,
      status: true,
      mockEventData: {
        chainId: CHAIN_ID,
        logIndex: 0,
        srcAddress: BREAKER_BOX_ADDR,
        block: { number: 100, timestamp: 1_700_000_500 },
      },
    });
    mockDb = await BreakerBox.BreakerStatusUpdated.processEvent({
      event: seed,
      mockDb,
    });
    const disable = BreakerBox.BreakerStatusUpdated.createMockEvent({
      breaker: MD_BREAKER,
      rateFeedID: FEED,
      status: false,
      mockEventData: {
        chainId: CHAIN_ID,
        logIndex: 1,
        srcAddress: BREAKER_BOX_ADDR,
        block: { number: 110, timestamp: 1_700_000_600 },
      },
    });
    mockDb = await BreakerBox.BreakerStatusUpdated.processEvent({
      event: disable,
      mockDb,
    });

    // Owner-override fires for this feed.
    const override = BreakerBox.TradingModeUpdated.createMockEvent({
      rateFeedID: FEED,
      tradingMode: 3n,
      mockEventData: {
        chainId: CHAIN_ID,
        logIndex: 2,
        srcAddress: BREAKER_BOX_ADDR,
        block: { number: 250, timestamp: 1_700_001_500 },
      },
    });
    mockDb = await BreakerBox.TradingModeUpdated.processEvent({
      event: override,
      mockDb,
    });

    // The disabled row must NOT have been flipped to TRIPPED — trading mode
    // stays 0, status stays OK, and lastStatusUpdatedAt is unchanged from the
    // RPC-self-heal seed (1_700_000_000n in the mock). If the handler had
    // touched the disabled row, the override block timestamp 1_700_001_500n
    // would have bled through.
    const cfg = mockDb.entities.BreakerConfig.get(
      makeBreakerConfigId(CHAIN_ID, MD_BREAKER, FEED),
    ) as
      | {
          enabled: boolean;
          tradingMode: number;
          status: string;
          lastStatusUpdatedAt: bigint;
        }
      | undefined;
    assert.ok(cfg);
    assert.equal(cfg!.enabled, false);
    assert.equal(cfg!.tradingMode, 0);
    assert.equal(cfg!.status, "OK");
    assert.notStrictEqual(cfg!.lastStatusUpdatedAt, 1_700_001_500n);
  });

  it("SortedOracles.MedianUpdated mirrors EMA + lastMedianRate for enabled MedianDelta configs", async () => {
    let mockDb = MockDb.createMockDb();
    const seed = BreakerBox.BreakerStatusUpdated.createMockEvent({
      breaker: MD_BREAKER,
      rateFeedID: FEED,
      status: true,
      mockEventData: {
        chainId: CHAIN_ID,
        logIndex: 0,
        srcAddress: BREAKER_BOX_ADDR,
        block: { number: 100, timestamp: 1_700_000_500 },
      },
    });
    mockDb = await BreakerBox.BreakerStatusUpdated.processEvent({
      event: seed,
      mockDb,
    });

    // Send a MedianUpdated event with a new median rate. The EMA should
    // recompute via Fixidity arithmetic; lastMedianRate should equal value.
    const newMedian = 1_180_000_000_000_000_000_000_000n; // 1.180
    const updated = SortedOracles.MedianUpdated.createMockEvent({
      token: FEED,
      value: newMedian,
      mockEventData: {
        chainId: CHAIN_ID,
        logIndex: 5,
        srcAddress: "0xefb84935239dacdecf7c5ba76d8de40b077b7b33",
        block: { number: 300, timestamp: 1_700_002_000 },
      },
    });
    mockDb = await SortedOracles.MedianUpdated.processEvent({
      event: updated,
      mockDb,
    });

    const cfg = mockDb.entities.BreakerConfig.get(
      makeBreakerConfigId(CHAIN_ID, MD_BREAKER, FEED),
    ) as
      | {
          lastMedianRate: bigint;
          lastUpdatedAt: bigint;
          medianRatesEMA: bigint;
        }
      | undefined;
    assert.ok(cfg);
    assert.equal(cfg!.lastMedianRate, newMedian);
    assert.equal(cfg!.lastUpdatedAt, 1_700_002_000n);
    // EMA blends 0.5% of new median with 99.5% of prior EMA. With prior
    // EMA = 1_171_560_280_196_965_000_000_000n and new = 1.180e24:
    //   newEMA = (1.180e24 * 5e21 + 1_171_560…e24 * (FIXED_1 - 5e21)) / FIXED_1
    // The result must be > prior EMA (drifting up toward new median) and
    // < new median (still mostly weighted to history). That's the
    // contract semantic the dashboard depends on.
    const FIXED_1 = 10n ** 24n;
    const sf = 5n * 10n ** 21n;
    const prior = 1_171_560_280_196_965_000_000_000n;
    const expected = (newMedian * sf + prior * (FIXED_1 - sf)) / FIXED_1;
    assert.equal(cfg!.medianRatesEMA, expected);
  });
});
