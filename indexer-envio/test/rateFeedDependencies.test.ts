import assert from "node:assert/strict";
import {
  indexerTestHelpers,
  type MockDbWith,
  type WritableEntity,
} from "./helpers/indexerTestHarness.js";
import {
  _clearBreakerMocks,
  _clearBootstrapCaches,
  _setMockBreakerList,
  _setMockBreakerKind,
  _setMockBreakerDefaults,
  _setMockBreakerFeedState,
} from "../src/EventHandlers.ts";
import { makeRateFeedDependencyId } from "../src/breakers.ts";
import { registerMockRateFeedDependenciesHttp } from "../src/rpc/http-test-mock-bridge.js";
import { makePool } from "./helpers/makePool.js";

// These tests drive the REAL `fetchRateFeedDependencies` array-walk + control
// read through the RateFeedDependenciesSet handler (`force` refresh → effect →
// fetcher). The per-index http mocks (NOT the fetcher-boundary map) exercise the
// loop terminator + the out-of-bounds-vs-transient disambiguation the harness
// otherwise can't reach — see the fetcher's block comment for why that matters.

type MockDb = MockDbWith<{
  RateFeedDependency: WritableEntity;
  Pool: WritableEntity;
}>;

const TestHelpers = indexerTestHelpers<MockDb>();
const { MockDb, BreakerBox } = TestHelpers;

const CHAIN_ID = 42220;
// Real Celo addresses so `requireContractAddress(chainId, "BreakerBox")` resolves
// and the mocked walk matches production's actual feed/dependency wiring.
const BREAKER_BOX_ADDR = "0x303ed1df62fa067659b586ebee8de0ece824ab39";
const FEED_X = "0x25f21a1f97607edf6852339fad709728cffb9a9d"; // dependent feed
const DEP_Y = "0xa1a8003936862e7a15092a91898d69fa8bce290c";
const DEP_Z = "0x40dc8528167557353fdcd98548ab2139a670dd0b";
const OLD_DEP = "0xed35e46b095197da30ddffa5b91d386886d5ce0d";

function edgeId(dependsOn: string): string {
  return makeRateFeedDependencyId(CHAIN_ID, FEED_X, dependsOn);
}

function depEvent(deps: string[]) {
  return BreakerBox.RateFeedDependenciesSet.createMockEvent({
    rateFeedID: FEED_X,
    // Ignored by the handler (the on-chain indexed array is only a topic hash);
    // present for event shape only.
    dependencies: deps,
    mockEventData: {
      chainId: CHAIN_ID,
      logIndex: 0,
      srcAddress: BREAKER_BOX_ADDR,
      block: { number: 200, timestamp: 1_700_000_900 },
    },
  });
}

describe("RateFeedDependenciesSet — RPC walk + edge reconcile (#712)", () => {
  beforeEach(() => {
    _clearBreakerMocks();
    _clearBootstrapCaches();
  });
  afterEach(() => _clearBreakerMocks());

  it("walks the array getter and reconciles every dependency edge", async () => {
    registerMockRateFeedDependenciesHttp(CHAIN_ID, FEED_X, [DEP_Y, DEP_Z]);
    const next = await BreakerBox.RateFeedDependenciesSet.processEvent({
      event: depEvent([DEP_Y, DEP_Z]),
      mockDb: MockDb.createMockDb(),
    });
    assert.ok(
      next.entities.RateFeedDependency.get(edgeId(DEP_Y)),
      "edge X->Y created (walked index 0)",
    );
    assert.ok(
      next.entities.RateFeedDependency.get(edgeId(DEP_Z)),
      "edge X->Z created (walked index 1, then terminated at the index-2 OOB)",
    );
  });

  it("creates no edges for a feed with no dependencies (index-0 OOB, control healthy)", async () => {
    registerMockRateFeedDependenciesHttp(CHAIN_ID, FEED_X, []);
    const next = await BreakerBox.RateFeedDependenciesSet.processEvent({
      event: depEvent([]),
      mockDb: MockDb.createMockDb(),
    });
    assert.equal(
      next.entities.RateFeedDependency.get(edgeId(DEP_Y)),
      undefined,
    );
  });

  it("replaces the set wholesale: removes a stale edge no longer present", async () => {
    registerMockRateFeedDependenciesHttp(CHAIN_ID, FEED_X, [DEP_Y]);
    const mockDb = MockDb.createMockDb();
    mockDb.entities.RateFeedDependency.set({
      id: edgeId(OLD_DEP),
      chainId: CHAIN_ID,
      rateFeedID: FEED_X,
      dependsOn: OLD_DEP,
    });
    const next = await BreakerBox.RateFeedDependenciesSet.processEvent({
      event: depEvent([DEP_Y]),
      mockDb,
    });
    assert.ok(
      next.entities.RateFeedDependency.get(edgeId(DEP_Y)),
      "new edge X->Y added",
    );
    assert.equal(
      next.entities.RateFeedDependency.get(edgeId(OLD_DEP)),
      undefined,
      "stale edge X->OLD removed",
    );
  });

  it("leaves edges unchanged on a transient RPC failure (never truncates)", async () => {
    // Both the index-0 read AND the control read error → fetcher returns null →
    // loadFeedDependencies reconciles nothing. The pre-existing edge must survive.
    registerMockRateFeedDependenciesHttp(CHAIN_ID, FEED_X, null);
    const mockDb = MockDb.createMockDb();
    mockDb.entities.RateFeedDependency.set({
      id: edgeId(OLD_DEP),
      chainId: CHAIN_ID,
      rateFeedID: FEED_X,
      dependsOn: OLD_DEP,
    });
    const next = await BreakerBox.RateFeedDependenciesSet.processEvent({
      event: depEvent([]),
      mockDb,
    });
    assert.ok(
      next.entities.RateFeedDependency.get(edgeId(OLD_DEP)),
      "transient failure must NOT truncate the existing edge set",
    );
  });

  it("inherits a pool-less, already-tripped dependency's halt (bootstraps the dep's config)", async () => {
    // DEP_Y is tripped on-chain via a MEDIAN_DELTA breaker but has NO pools and
    // no live BreakerBox event in range — only loading FEED_X's dependency edge
    // bootstraps Y's BreakerConfig. Without that bootstrap, computeOwnFeedHalted(Y)
    // would read zero rows and the dependent's pool would never inherit the halt.
    const MD_BREAKER = "0x49349f92d2b17d491e42c8fdb02d19f072f9b5d9";
    _setMockBreakerList(CHAIN_ID, [MD_BREAKER]);
    _setMockBreakerKind(CHAIN_ID, MD_BREAKER, "MEDIAN_DELTA");
    _setMockBreakerDefaults(CHAIN_ID, MD_BREAKER, {
      activatesTradingMode: 3,
      defaultCooldownTime: 900n,
      defaultRateChangeThreshold: 4n * 10n ** 22n,
    });
    _setMockBreakerFeedState(CHAIN_ID, MD_BREAKER, DEP_Y, {
      enabled: true,
      tradingMode: 3, // TRIPPED
      lastStatusUpdatedAt: 1_700_000_000n,
      cooldownTime: 0n,
      rateChangeThreshold: 0n,
      smoothingFactor: 5n * 10n ** 21n,
      medianRatesEMA: 1_000_000n,
      referenceValue: null,
    });
    registerMockRateFeedDependenciesHttp(CHAIN_ID, FEED_X, [DEP_Y]);

    const mockDb = MockDb.createMockDb();
    const poolId = `${CHAIN_ID}-0x00000000000000000000000000000000000000a1`;
    mockDb.entities.Pool.set(
      makePool({
        id: poolId,
        referenceRateFeedID: FEED_X,
        breakerTripped: false,
      }),
    );

    const next = await BreakerBox.RateFeedDependenciesSet.processEvent({
      event: depEvent([DEP_Y]),
      mockDb,
    });

    const pool = next.entities.Pool.get(poolId) as
      | { breakerTripped: boolean }
      | undefined;
    assert.equal(
      pool?.breakerTripped,
      true,
      "dependent pool inherits the pool-less dependency's halt",
    );
  });
});
