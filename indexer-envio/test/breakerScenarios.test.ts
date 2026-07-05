import assert from "node:assert/strict";
import type { Breaker, BreakerConfig } from "envio";
import {
  indexerTestHelpers,
  type EntityCollection,
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

// Issue #1052 gap-closing suite. See breakerHandlers.test.ts for the shared
// bootstrap + trip/reset baseline this file extends — kept separate to
// respect the 600-line-per-file soft cap (breakerHandlers.test.ts is already
// past it).

type MockDb = MockDbWith<{
  Breaker: WritableEntity;
  BreakerConfig: WritableEntity & EntityCollection;
  Pool: WritableEntity & EntityCollection;
  RateFeed: EntityCollection;
  OracleSnapshot: EntityCollection;
}>;

const TestHelpers = indexerTestHelpers<MockDb>();
const { MockDb, BreakerBox, SortedOracles } = TestHelpers;

const CHAIN_ID = 42220;
// Match the real Celo BreakerBox address so any future test that hits
// `requireContractAddress(chainId, "BreakerBox")` finds them (see
// breakerHandlers.test.ts).
const BREAKER_BOX_ADDR = "0x303ed1df62fa067659b586ebee8de0ece824ab39";
const MD_BREAKER = "0x49349f92d2b17d491e42c8fdb02d19f072f9b5d9";
const FEED = "0xf4f9bbda9cd6841fcb9b1510f9269e2db42a6e3a";
const UNKNOWN_FEED = "0x000000000000000000000000000000000000eee1";
const GHOST_BREAKER = "0x000000000000000000000000000000000000f001";

const COOLDOWN = 900n; // 15 min — production value
const THRESHOLD = 4n * 10n ** 22n; // 4% Fixidity
const SMOOTHING = 5n * 10n ** 21n; // 0.5% — production value
const FIXED_1 = 10n ** 24n;

describe("Issue #1052 scenario gap-closing", () => {
  beforeEach(() => {
    _clearBreakerMocks();
    _clearBootstrapCaches();
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
      cooldownTime: 0n,
      rateChangeThreshold: 0n,
      smoothingFactor: SMOOTHING,
      medianRatesEMA: 1_171_560_280_196_965_000_000_000n,
      referenceValue: null,
    });
  });

  afterEach(() => {
    _clearBreakerMocks();
  });

  // ---------------------------------------------------------------------
  // Scenario 3 — median event on an unknown feed / zero registered pools
  // ---------------------------------------------------------------------
  it("SortedOracles.MedianUpdated on an unregistered feed is a clean no-op (no scratch rows)", async () => {
    const mockDb = MockDb.createMockDb();
    const event = SortedOracles.MedianUpdated.createMockEvent({
      token: UNKNOWN_FEED,
      value: 1_000_000_000_000_000_000_000_000n,
      mockEventData: {
        chainId: CHAIN_ID,
        logIndex: 0,
        srcAddress: "0xefb84935239dacdecf7c5ba76d8de40b077b7b33",
        block: { number: 100, timestamp: 1_700_000_500 },
      },
    });
    const next = await SortedOracles.MedianUpdated.processEvent({
      event,
      mockDb,
    });

    // No pool references UNKNOWN_FEED and no BreakerConfig governs it, so the
    // handler must bail before touching RateFeed / BreakerConfig / Pool /
    // OracleSnapshot — none of those entity tables should gain a row.
    assert.equal(next.entities.Pool.getAll().length, 0);
    assert.equal(next.entities.RateFeed.getAll().length, 0);
    assert.equal(next.entities.BreakerConfig.getAll().length, 0);
    assert.equal(next.entities.OracleSnapshot.getAll().length, 0);
  });

  // ---------------------------------------------------------------------
  // Scenario 4 — EMA seeding parity: unseeded 0n first update vs a
  // subsequent blended step, driven through the real MedianUpdated handler
  // (not just the pure `nextMedianEMA` unit tests in breakers.test.ts).
  // ---------------------------------------------------------------------
  it("SortedOracles.MedianUpdated seeds an unseeded (0n) EMA on first update, then blends on the next", async () => {
    _setMockBreakerFeedState(CHAIN_ID, MD_BREAKER, FEED, {
      enabled: true,
      tradingMode: 0,
      lastStatusUpdatedAt: 1_700_000_000n,
      cooldownTime: 0n,
      rateChangeThreshold: 0n,
      smoothingFactor: SMOOTHING,
      medianRatesEMA: 0n, // unseeded — mirrors MedianRateEMAReset / a fresh breaker
      referenceValue: null,
    });

    // No Pool entities — EMA is stored on BreakerConfig, not Pool, so the
    // handler's config-update loop still runs when getPoolsByFeed returns [].
    let mockDb = MockDb.createMockDb();
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

    const cfgId = makeBreakerConfigId(CHAIN_ID, MD_BREAKER, FEED);
    const seeded = mockDb.entities.BreakerConfig.get(cfgId);
    assert.ok(
      seeded,
      "BreakerConfig must exist after BreakerStatusUpdated bootstrap",
    );
    assert.equal(
      (seeded as { medianRatesEMA: bigint }).medianRatesEMA,
      0n,
      "precondition: EMA unseeded",
    );

    // First median: previousEMA === 0n, so the handler must SEED (contract
    // line 182-186 semantics) — EMA becomes the raw median, not a blend.
    const M1 = 1_100_000_000_000_000_000_000_000n; // 1.10
    mockDb = await SortedOracles.MedianUpdated.processEvent({
      event: SortedOracles.MedianUpdated.createMockEvent({
        token: FEED,
        value: M1,
        mockEventData: {
          chainId: CHAIN_ID,
          logIndex: 5,
          srcAddress: "0xefb84935239dacdecf7c5ba76d8de40b077b7b33",
          block: { number: 300, timestamp: 1_700_002_000 },
        },
      }),
      mockDb,
    });
    const afterFirstRaw = mockDb.entities.BreakerConfig.get(cfgId);
    assert.ok(
      afterFirstRaw,
      "BreakerConfig must exist after the first MedianUpdated",
    );
    const afterFirst = afterFirstRaw as {
      medianRatesEMA: bigint;
      lastMedianRate: bigint;
      lastUpdatedAt: bigint;
    };
    assert.equal(
      afterFirst.medianRatesEMA,
      M1,
      "first update seeds EMA = median",
    );
    assert.equal(afterFirst.lastMedianRate, M1);
    assert.equal(afterFirst.lastUpdatedAt, 1_700_002_000n);

    // Second median: previousEMA is now non-zero, so the handler must BLEND
    // per the Fixidity formula instead of re-seeding.
    const M2 = 1_150_000_000_000_000_000_000_000n; // 1.15
    mockDb = await SortedOracles.MedianUpdated.processEvent({
      event: SortedOracles.MedianUpdated.createMockEvent({
        token: FEED,
        value: M2,
        mockEventData: {
          chainId: CHAIN_ID,
          logIndex: 6,
          srcAddress: "0xefb84935239dacdecf7c5ba76d8de40b077b7b33",
          block: { number: 301, timestamp: 1_700_002_100 },
        },
      }),
      mockDb,
    });
    const afterSecondRaw = mockDb.entities.BreakerConfig.get(cfgId);
    assert.ok(
      afterSecondRaw,
      "BreakerConfig must exist after the second MedianUpdated",
    );
    const afterSecond = afterSecondRaw as {
      medianRatesEMA: bigint;
      lastMedianRate: bigint;
      lastUpdatedAt: bigint;
    };
    const expectedBlend =
      (M2 * SMOOTHING + afterFirst.medianRatesEMA * (FIXED_1 - SMOOTHING)) /
      FIXED_1;
    assert.equal(
      afterSecond.medianRatesEMA,
      expectedBlend,
      "second update blends per the Fixidity EMA formula, not a re-seed",
    );
    assert.equal(afterSecond.lastMedianRate, M2);
    assert.equal(afterSecond.lastUpdatedAt, 1_700_002_100n);
  });

  // ---------------------------------------------------------------------
  // Scenario 5 — cold-start reconciliation for the feed's OWN breaker (not
  // a dependency): BreakerBox events predate start_block, so the very first
  // MedianUpdated for the feed must eager-bootstrap the BreakerConfig AND
  // reconcile an already-TRIPPED state onto the feed's pools in one pass.
  // Distinct from the dependency-edge cold-start tests already covered in
  // breakerHandlers.test.ts (those trip via a DEPENDENCY feed; here the
  // feed's own breaker config is the one bootstrapped as already tripped).
  // ---------------------------------------------------------------------
  it("SortedOracles.MedianUpdated cold-starts an already-tripped OWN breaker config and halts the feed's pools", async () => {
    _setMockBreakerFeedState(CHAIN_ID, MD_BREAKER, FEED, {
      enabled: true,
      tradingMode: 3, // TRIPPED at RPC-read time — BreakerTripped predates start_block
      lastStatusUpdatedAt: 1_700_000_000n,
      cooldownTime: 0n,
      rateChangeThreshold: 0n,
      smoothingFactor: SMOOTHING,
      medianRatesEMA: 1_000_000n,
      referenceValue: null,
    });

    let mockDb = MockDb.createMockDb();
    const poolId = makePoolId(
      CHAIN_ID,
      "0x000000000000000000000000000000000000d005",
    );
    mockDb = mockDb.entities.Pool.set(
      makePool({
        id: poolId,
        referenceRateFeedID: FEED,
        breakerTripped: false,
      }),
    );

    // No prior BreakerBox event has ever fired for this feed — this is the
    // FIRST event of any kind, so BreakerConfig starts with zero rows.
    assert.equal(
      mockDb.entities.BreakerConfig.getAll().length,
      0,
      "precondition: no BreakerConfig rows exist yet",
    );

    mockDb = await SortedOracles.MedianUpdated.processEvent({
      event: SortedOracles.MedianUpdated.createMockEvent({
        token: FEED,
        value: 1_180_000_000_000_000_000_000_000n,
        mockEventData: {
          chainId: CHAIN_ID,
          logIndex: 5,
          srcAddress: "0xefb84935239dacdecf7c5ba76d8de40b077b7b33",
          block: { number: 300, timestamp: 1_700_002_000 },
        },
      }),
      mockDb,
    });

    const pool = mockDb.entities.Pool.get(poolId);
    assert.ok(pool, "Pool must exist for poolId");
    assert.equal(
      (pool as { breakerTripped: boolean }).breakerTripped,
      true,
      "the feed's own already-tripped breaker must be reconciled onto the pool in the same event that bootstraps it",
    );
  });

  // ---------------------------------------------------------------------
  // Scenario 7 — halt propagation fans out to (and back from) EVERY pool on
  // a shared feed, not just the first one. breakerHaltSync.test.ts proves
  // the pure `syncPoolsBreakerHalt` fan-out with 2 pools (trip direction
  // only); this drives the real BreakerTripped + ResetSuccessful handlers
  // through the harness with 3 pools, both directions.
  // ---------------------------------------------------------------------
  it("BreakerTripped halts every pool on the feed; ResetSuccessful un-halts every pool", async () => {
    let mockDb = MockDb.createMockDb();
    const poolIds = [
      makePoolId(CHAIN_ID, "0x000000000000000000000000000000000000a002"),
      makePoolId(CHAIN_ID, "0x000000000000000000000000000000000000b003"),
      makePoolId(CHAIN_ID, "0x000000000000000000000000000000000000c004"),
    ];
    for (const id of poolIds) {
      mockDb = mockDb.entities.Pool.set(
        makePool({ id, referenceRateFeedID: FEED, breakerTripped: false }),
      );
    }

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
    for (const id of poolIds) {
      assert.equal(
        (mockDb.entities.Pool.get(id) as { breakerTripped: boolean })
          .breakerTripped,
        true,
        `pool ${id} must be halted after the trip`,
      );
    }

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
    for (const id of poolIds) {
      assert.equal(
        (mockDb.entities.Pool.get(id) as { breakerTripped: boolean })
          .breakerTripped,
        false,
        `pool ${id} must be un-halted after the reset`,
      );
    }
  });

  // ---------------------------------------------------------------------
  // Scenario 8 — a mode transition fans out across a feed's BreakerConfig
  // rows; one row may reference a breaker address with no corresponding
  // Breaker entity (e.g. a governance edge the indexer never resolved).
  // The handler must apply the override to every row without throwing and
  // without corrupting the config that DOES resolve to a real Breaker.
  // ---------------------------------------------------------------------
  it("TradingModeUpdated applies to a config with an unresolved breaker without corrupting a sibling registered breaker's config", async () => {
    let mockDb = MockDb.createMockDb();
    const poolId = makePoolId(
      CHAIN_ID,
      "0x000000000000000000000000000000000001111",
    );
    mockDb = mockDb.entities.Pool.set(
      makePool({
        id: poolId,
        referenceRateFeedID: FEED,
        breakerTripped: false,
      }),
    );

    // Registered breaker + config (seeded directly, mirroring how Pool
    // fixtures are hand-seeded elsewhere — precondition state, not the
    // behavior under test).
    const registeredBreaker: Breaker = {
      id: makeBreakerId(CHAIN_ID, MD_BREAKER),
      chainId: CHAIN_ID,
      address: MD_BREAKER,
      kind: "MEDIAN_DELTA",
      activatesTradingMode: 3,
      defaultCooldownTime: COOLDOWN,
      defaultRateChangeThreshold: THRESHOLD,
      registeredAtBlock: 50n,
      registeredAtTimestamp: 1_699_000_000n,
      removed: false,
    };
    mockDb = mockDb.entities.Breaker.set(registeredBreaker);

    const registeredCfg: BreakerConfig = {
      id: makeBreakerConfigId(CHAIN_ID, MD_BREAKER, FEED),
      chainId: CHAIN_ID,
      breaker_id: registeredBreaker.id,
      breakerAddress: MD_BREAKER,
      rateFeedID: FEED,
      enabled: true,
      cooldownTime: 0n, // inherits the breaker default (900s)
      rateChangeThreshold: 0n,
      smoothingFactor: SMOOTHING,
      medianRatesEMA: 1_000_000n,
      referenceValue: undefined,
      lastMedianRate: undefined,
      lastUpdatedAt: undefined,
      status: "OK",
      tradingMode: 0,
      lastStatusUpdatedAt: 1_700_000_000n,
      cooldownEndsAt: 0n,
      lastTripAt: undefined,
      lastTripTxHash: undefined,
      lastResetAt: undefined,
      tripCountLifetime: 0,
    };
    mockDb = mockDb.entities.BreakerConfig.set(registeredCfg);

    // Ghost breaker: a config on the SAME feed referencing a breaker_id with
    // NO matching Breaker entity — `context.Breaker.get(...)` resolves
    // undefined for this row.
    const ghostCfg: BreakerConfig = {
      id: makeBreakerConfigId(CHAIN_ID, GHOST_BREAKER, FEED),
      chainId: CHAIN_ID,
      breaker_id: makeBreakerId(CHAIN_ID, GHOST_BREAKER),
      breakerAddress: GHOST_BREAKER,
      rateFeedID: FEED,
      enabled: true,
      cooldownTime: 120n, // distinct own value — must NOT borrow the registered breaker's default
      rateChangeThreshold: 0n,
      smoothingFactor: undefined,
      medianRatesEMA: undefined,
      referenceValue: undefined,
      lastMedianRate: undefined,
      lastUpdatedAt: undefined,
      status: "OK",
      tradingMode: 0,
      lastStatusUpdatedAt: 1_700_000_000n,
      cooldownEndsAt: 0n,
      lastTripAt: undefined,
      lastTripTxHash: undefined,
      lastResetAt: undefined,
      tripCountLifetime: 0,
    };
    mockDb = mockDb.entities.BreakerConfig.set(ghostCfg);

    const blockTimestamp = 1_700_005_000;
    mockDb = await BreakerBox.TradingModeUpdated.processEvent({
      event: BreakerBox.TradingModeUpdated.createMockEvent({
        rateFeedID: FEED,
        tradingMode: 3n,
        mockEventData: {
          chainId: CHAIN_ID,
          logIndex: 2,
          srcAddress: BREAKER_BOX_ADDR,
          block: { number: 250, timestamp: blockTimestamp },
        },
      }),
      mockDb,
    });

    const registeredAfterRaw = mockDb.entities.BreakerConfig.get(
      registeredCfg.id,
    );
    assert.ok(
      registeredAfterRaw,
      "BreakerConfig must exist for the registered breaker after TradingModeUpdated",
    );
    const registeredAfter = registeredAfterRaw as {
      tradingMode: number;
      status: string;
      cooldownEndsAt: bigint;
    };
    assert.equal(registeredAfter.tradingMode, 3);
    assert.equal(registeredAfter.status, "TRIPPED");
    assert.equal(
      registeredAfter.cooldownEndsAt,
      BigInt(blockTimestamp) + COOLDOWN,
      "registered breaker's config uses the breaker's inherited (900s) cooldown",
    );

    const ghostAfterRaw = mockDb.entities.BreakerConfig.get(ghostCfg.id);
    assert.ok(
      ghostAfterRaw,
      "BreakerConfig must exist for the ghost breaker after TradingModeUpdated",
    );
    const ghostAfter = ghostAfterRaw as {
      tradingMode: number;
      status: string;
      cooldownEndsAt: bigint;
    };
    assert.equal(ghostAfter.tradingMode, 3);
    assert.equal(ghostAfter.status, "TRIPPED");
    assert.equal(
      ghostAfter.cooldownEndsAt,
      BigInt(blockTimestamp) + 120n,
      "unresolved-breaker config falls back to its OWN cooldownTime, not the sibling's default",
    );

    const poolRaw = mockDb.entities.Pool.get(poolId);
    assert.ok(
      poolRaw,
      "Pool must exist for poolId after TradingModeUpdated fan-out",
    );
    const pool = poolRaw as { breakerTripped: boolean };
    assert.equal(
      pool.breakerTripped,
      true,
      "the pool halt fan-out still runs even though one config's breaker was unresolved",
    );
  });
});
