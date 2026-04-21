/// <reference types="mocha" />
import { strict as assert } from "assert";
import {
  _evictCacheForChain,
  _getOracleCacheStats,
} from "../src/EventHandlers";

// Regression guard for the unbounded-cache OOM fix in src/rpc.ts.
// The original bug: numReportersCache and reportExpiryCache were keyed by
// chainId:feedId:blockNumber and never evicted, so they grew without bound.
// The fix evicts a chain's entries whenever that chain advances to a new block.

describe("evictCacheForChain (cache eviction helper)", () => {
  it("clears only the advancing chain's entries", () => {
    const cache = new Map<string, number>([
      ["1:f1:100", 1],
      ["1:f2:100", 2],
      ["2:f1:100", 3],
    ]);
    const lastBlocks = new Map<number, bigint>([
      [1, 100n],
      [2, 100n],
    ]);

    _evictCacheForChain(cache, lastBlocks, 1, 101n);

    assert.deepEqual([...cache.keys()].sort(), ["2:f1:100"]);
    assert.equal(lastBlocks.get(1), 101n);
    assert.equal(lastBlocks.get(2), 100n);
  });

  it("is a no-op when the block matches the last seen block", () => {
    const cache = new Map<string, number>([["1:f1:100", 1]]);
    const lastBlocks = new Map<number, bigint>([[1, 100n]]);

    _evictCacheForChain(cache, lastBlocks, 1, 100n);

    assert.deepEqual([...cache.keys()], ["1:f1:100"]);
  });

  it("records lastBlock on first sighting of a chain (no entries to evict)", () => {
    const cache = new Map<string, number>();
    const lastBlocks = new Map<number, bigint>();

    _evictCacheForChain(cache, lastBlocks, 42, 1000n);

    assert.equal(cache.size, 0);
    assert.equal(lastBlocks.get(42), 1000n);
  });

  it("does not collide chain prefixes (chainId 1 must not match chainId 11)", () => {
    const cache = new Map<string, number>([
      ["1:f:100", 1],
      ["11:f:100", 2],
      ["111:f:100", 3],
    ]);
    const lastBlocks = new Map<number, bigint>([
      [1, 100n],
      [11, 100n],
      [111, 100n],
    ]);

    _evictCacheForChain(cache, lastBlocks, 1, 101n);

    assert.deepEqual(new Set(cache.keys()), new Set(["11:f:100", "111:f:100"]));
  });

  it("bounds cache size across many block advances on a single chain", () => {
    const cache = new Map<string, number>();
    const lastBlocks = new Map<number, bigint>();

    // Simulate 10_000 sequential blocks; each block populates one entry.
    for (let i = 1n; i <= 10_000n; i++) {
      _evictCacheForChain(cache, lastBlocks, 1, i);
      cache.set(`1:f:${i}`, Number(i));
    }

    // After 10_000 blocks the cache must NOT have grown unbounded —
    // exactly one entry should remain (the current block's).
    assert.equal(cache.size, 1);
  });

  it("bounds cache size across interleaved multichain blocks", () => {
    const cache = new Map<string, number>();
    const lastBlocks = new Map<number, bigint>();

    // Alternate two chains across 1000 distinct blocks each.
    for (let i = 1n; i <= 1_000n; i++) {
      _evictCacheForChain(cache, lastBlocks, 1, i);
      cache.set(`1:f:${i}`, 1);
      _evictCacheForChain(cache, lastBlocks, 2, i + 5_000n);
      cache.set(`2:f:${i + 5_000n}`, 2);
    }

    // Each chain holds at most one block's worth of entries at any time;
    // cache size should be bounded by chains × entries_per_block (= 2 here).
    assert.ok(
      cache.size <= 2,
      `cache size ${cache.size} exceeds expected bound (2)`,
    );
  });
});

describe("_getOracleCacheStats", () => {
  it("returns size of all three block-scoped caches", () => {
    const stats = _getOracleCacheStats();
    assert.equal(typeof stats.numReporters, "number");
    assert.equal(typeof stats.reportExpiry, "number");
    assert.equal(typeof stats.reserves, "number");
  });
});
