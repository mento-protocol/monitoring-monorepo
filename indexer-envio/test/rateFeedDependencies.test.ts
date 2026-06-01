import assert from "node:assert/strict";
import {
  indexerTestHelpers,
  type MockDbWith,
  type WritableEntity,
} from "./helpers/indexerTestHarness.js";
import {
  _clearBreakerMocks,
  _clearBootstrapCaches,
} from "../src/EventHandlers.ts";
import { makeRateFeedDependencyId } from "../src/breakers.ts";
import { registerMockRateFeedDependenciesHttp } from "../src/rpc/http-test-mock-bridge.js";

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
});
