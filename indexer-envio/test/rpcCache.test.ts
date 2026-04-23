/// <reference types="mocha" />
import { assert } from "chai";
import {
  _resetRebalancingStateCacheForTests,
  _resetReportExpiryInFlightForTests,
  _setRpcClientForTests,
  _testHooks,
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
  let originalDelayFn: typeof _testHooks.delayFn;

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
    // Block-not-available retries sleep before falling back; no-op the
    // delay so the fallback test completes quickly.
    originalDelayFn = _testHooks.delayFn;
    _testHooks.delayFn = async () => {};
  });

  afterEach(() => {
    _setRpcClientForTests(CHAIN, null);
    _resetRebalancingStateCacheForTests();
    _testHooks.delayFn = originalDelayFn;
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

  it("does NOT cache a fallback response — a retry refires the RPC", async () => {
    // Drive `readContractWithBlockFallback` into its block-not-available
    // fallback branch: throw a matching error until all retries exhaust,
    // then resolve. Per rpc.ts's matcher (BLOCK_NOT_AVAILABLE_RE), the
    // error message must include "not available" or "out of range". The
    // fallback call omits `blockNumber` — assert via the args we receive.
    let firstSettled = false;
    mockImpl = async (args: any) => {
      callCount++;
      if (!firstSettled) {
        // 1 original + 3 retries = 4 rejected, then the 5th call is the
        // fallback (no blockNumber). Reject 4 times then succeed.
        if (callCount <= 4) {
          throw new Error("block is out of range");
        }
        // Fallback call — no blockNumber in args.
        if (args.blockNumber !== undefined) {
          throw new Error("unexpected blockNumber on fallback call");
        }
        firstSettled = true;
        return REBALANCING_TUPLE as unknown;
      }
      // Second fetchRebalancingState call: normal success with block.
      return REBALANCING_TUPLE as unknown;
    };
    const first = await fetchRebalancingState(CHAIN, POOL, 400n);
    assert.isNotNull(first);
    const callsAfterFirst = callCount;
    // Fallback happened; cache must NOT serve this on the next call.
    const second = await fetchRebalancingState(CHAIN, POOL, 400n);
    assert.isNotNull(second);
    assert.isAbove(
      callCount,
      callsAfterFirst,
      "fallback response must not be cached — second call should have hit RPC",
    );
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

describe("fetchReportExpiry — in-flight dedup + cache hygiene", () => {
  const CHAIN = 42220;
  const FEED = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  let callCount = 0;
  let mockImpl: (args: any) => Promise<unknown>;
  let originalDelayFn: typeof _testHooks.delayFn;

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
    originalDelayFn = _testHooks.delayFn;
    _testHooks.delayFn = async () => {};
  });

  afterEach(() => {
    _setRpcClientForTests(CHAIN, null);
    _resetReportExpiryInFlightForTests();
    _testHooks.delayFn = originalDelayFn;
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

  it("does NOT populate the value cache on a fallback response", async () => {
    // Drive the block-not-available fallback path. The existing guard
    // in fetchReportExpiry (!usedAnyFallback → reportExpiryCache.set)
    // prevents the returned value from being cached when any of the
    // underlying reads fell back to `latest`. A second call at the
    // same key must refire RPC instead of reading a stale cached
    // fallback response.
    let firstSettled = false;
    mockImpl = async (args: any) => {
      callCount++;
      if (!firstSettled) {
        if (callCount <= 4) {
          throw new Error("block is out of range");
        }
        if (args.blockNumber !== undefined) {
          throw new Error("unexpected blockNumber on fallback call");
        }
        firstSettled = true;
        return 3600n;
      }
      return 3600n;
    };
    const first = await fetchReportExpiry(CHAIN, FEED, 600n);
    assert.equal(first, 3600n);
    const callsAfterFirst = callCount;
    const second = await fetchReportExpiry(CHAIN, FEED, 600n);
    assert.equal(second, 3600n);
    assert.isAbove(
      callCount,
      callsAfterFirst,
      "fallback response must not be cached — second call should have hit RPC",
    );
  });

  it("returns null on error and does NOT cache the failure", async () => {
    let shouldThrow = true;
    mockImpl = async () => {
      callCount++;
      if (shouldThrow) {
        throw new Error("rpc broken");
      }
      return 3600n;
    };
    const first = await fetchReportExpiry(CHAIN, FEED, 700n);
    assert.isNull(first);
    // Let subsequent calls succeed — cache must not have pinned `null`.
    shouldThrow = false;
    const second = await fetchReportExpiry(CHAIN, FEED, 700n);
    assert.equal(second, 3600n);
    assert.isAbove(callCount, 1, "second call must have hit RPC after null");
  });
});
