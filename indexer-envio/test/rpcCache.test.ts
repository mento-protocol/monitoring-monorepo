/// <reference types="mocha" />
import { assert } from "chai";
import {
  _resetRebalancingStateCacheForTests,
  _resetReportExpiryInFlightForTests,
  _setRpcClientForTests,
  fetchRebalancingState,
  fetchReportExpiry,
} from "../src/rpc";

// Matches the 7-tuple shape `parseRebalancingState` expects in rpc.ts.
const REBALANCING_TUPLE = [
  1_000_000_000_000_000_000n, // oraclePriceNumerator
  1_000_000_000_000_000_000n, // oraclePriceDenominator
  0n,
  0n,
  true,
  3333, // rebalanceThreshold
  42n, // priceDifference
] as const;

describe("fetchRebalancingState — LRU cache", () => {
  const CHAIN = 42220;
  const POOL = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  let callCount = 0;
  let lastArgs: any;
  let mockImpl: (args: any) => Promise<unknown>;

  beforeEach(() => {
    callCount = 0;
    lastArgs = null;
    mockImpl = async (args: any) => {
      callCount++;
      lastArgs = args;
      return REBALANCING_TUPLE as unknown;
    };
    _setRpcClientForTests(CHAIN, {
      readContract: (args: unknown) => mockImpl(args),
    });
    _resetRebalancingStateCacheForTests();
  });

  afterEach(() => {
    _setRpcClientForTests(CHAIN, null);
    _resetRebalancingStateCacheForTests();
  });

  it("serves the second call from cache when (chain, addr, block) match", async () => {
    const a = await fetchRebalancingState(CHAIN, POOL, 100n);
    const b = await fetchRebalancingState(CHAIN, POOL, 100n);
    assert.equal(callCount, 1);
    assert.deepEqual(a, b);
    assert.equal(a?.rebalanceThreshold, 3333);
  });

  it("misses the cache for a different blockNumber", async () => {
    await fetchRebalancingState(CHAIN, POOL, 100n);
    await fetchRebalancingState(CHAIN, POOL, 101n);
    assert.equal(callCount, 2);
  });

  it("dedups concurrent in-flight calls — one RPC for N simultaneous callers", async () => {
    // Hold the RPC open until we've fired all three concurrent calls;
    // without Promise-caching they'd each launch their own flight.
    let release: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    mockImpl = async () => {
      callCount++;
      await gate;
      return REBALANCING_TUPLE as unknown;
    };
    const triple = Promise.all([
      fetchRebalancingState(CHAIN, POOL, 200n),
      fetchRebalancingState(CHAIN, POOL, 200n),
      fetchRebalancingState(CHAIN, POOL, 200n),
    ]);
    release!();
    const [a, b, c] = await triple;
    assert.equal(callCount, 1);
    assert.deepEqual(a, b);
    assert.deepEqual(b, c);
  });

  it("does NOT cache null results — a retry refires the RPC", async () => {
    mockImpl = async () => {
      callCount++;
      throw new Error("boom");
    };
    const first = await fetchRebalancingState(CHAIN, POOL, 300n);
    const second = await fetchRebalancingState(CHAIN, POOL, 300n);
    assert.isNull(first);
    assert.isNull(second);
    // Both calls hit the RPC — no sticky cached failure.
    assert.equal(callCount, 2);
  });

  it("evicts the oldest entry once the LRU exceeds its cap (256)", async () => {
    // Fill to cap + 1 using distinct block numbers as cache keys.
    const CAP = 256;
    for (let i = 0; i < CAP + 1; i++) {
      await fetchRebalancingState(CHAIN, POOL, BigInt(1000 + i));
    }
    // Block 1000 was the oldest — should have been evicted. A re-fetch
    // hits RPC again; block 1001 stays cached.
    const hitsBefore = callCount;
    await fetchRebalancingState(CHAIN, POOL, 1001n);
    assert.equal(
      callCount,
      hitsBefore,
      "block 1001 should still be cached (not evicted)",
    );
    await fetchRebalancingState(CHAIN, POOL, 1000n);
    assert.equal(
      callCount,
      hitsBefore + 1,
      "block 1000 was evicted — refetch should have hit RPC",
    );
  });

  it("refreshes LRU position on cache hit so re-accessed keys don't get evicted", async () => {
    // Populate 256 keys, then re-access the OLDEST, then insert one more.
    // The previously-oldest should now be protected; the second-oldest
    // should be evicted instead.
    const CAP = 256;
    for (let i = 0; i < CAP; i++) {
      await fetchRebalancingState(CHAIN, POOL, BigInt(2000 + i));
    }
    // Touch block 2000 — it should move to the tail.
    await fetchRebalancingState(CHAIN, POOL, 2000n);
    // Insert a fresh key, triggering eviction of whatever sits at the head.
    await fetchRebalancingState(CHAIN, POOL, BigInt(2000 + CAP));
    const hitsBefore = callCount;
    await fetchRebalancingState(CHAIN, POOL, 2000n);
    assert.equal(
      callCount,
      hitsBefore,
      "block 2000 was re-accessed — LRU should have moved it to the tail, preserving it across the next insert",
    );
  });
});

describe("fetchReportExpiry — in-flight dedup", () => {
  const CHAIN = 42220;
  const FEED = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  let callCount = 0;
  let mockImpl: (args: any) => Promise<unknown>;

  beforeEach(() => {
    callCount = 0;
    mockImpl = async () => {
      callCount++;
      return 3600n;
    };
    _setRpcClientForTests(CHAIN, {
      readContract: (args: unknown) => mockImpl(args),
    });
    _resetReportExpiryInFlightForTests();
  });

  afterEach(() => {
    _setRpcClientForTests(CHAIN, null);
    _resetReportExpiryInFlightForTests();
  });

  it("dedups concurrent in-flight calls for the same (chain, feedID, block)", async () => {
    // The value cache (reportExpiryCache) only populates after the RPC
    // resolves, so without Promise dedup N concurrent callers would all
    // miss and re-RPC.
    let release: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    mockImpl = async () => {
      callCount++;
      await gate;
      return 3600n;
    };
    const triple = Promise.all([
      fetchReportExpiry(CHAIN, FEED, 500n),
      fetchReportExpiry(CHAIN, FEED, 500n),
      fetchReportExpiry(CHAIN, FEED, 500n),
    ]);
    release!();
    const [a, b, c] = await triple;
    assert.equal(callCount, 1);
    assert.equal(a, 3600n);
    assert.equal(b, 3600n);
    assert.equal(c, 3600n);
  });
});
