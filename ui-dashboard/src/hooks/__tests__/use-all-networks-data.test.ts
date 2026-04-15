import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchNetworkData, fetchAllNetworks } from "../use-all-networks-data";
import type { Network } from "@/lib/networks";
import type { Pool } from "@/lib/types";

// ---------------------------------------------------------------------------
// Minimal fixture helpers
// ---------------------------------------------------------------------------

const MOCK_NETWORK: Network = {
  id: "celo-mainnet",
  label: "Celo",
  chainId: 42220,
  contractsNamespace: null,
  hasuraUrl: "https://hasura.example.com/v1/graphql",
  hasuraSecret: "",
  explorerBaseUrl: "https://celoscan.io",
  tokenSymbols: {},
  addressLabels: {},
  local: false,
  hasVirtualPools: false,
  testnet: false,
};

const MOCK_NETWORK_2: Network = {
  ...MOCK_NETWORK,
  id: "celo-sepolia",
  label: "Celo Sepolia",
  chainId: 11142220,
  hasuraUrl: "https://hasura-sepolia.example.com/v1/graphql",
};

const MOCK_NETWORK_WITH_SECRET: Network = {
  ...MOCK_NETWORK,
  hasuraSecret: "  my-secret  ", // intentional whitespace to test trimming
};

function makePool(id: string): Pool {
  return {
    id,
    chainId: 42220,
    token0: null,
    token1: null,
    source: "FPMM",
    createdAtBlock: "1",
    createdAtTimestamp: "1000",
    updatedAtBlock: "2",
    updatedAtTimestamp: "2000",
  };
}

// ---------------------------------------------------------------------------
// Mock graphql-request
// ---------------------------------------------------------------------------

vi.mock("graphql-request", () => {
  const MockGraphQLClient = vi.fn();
  MockGraphQLClient.prototype.request = vi.fn();
  return { GraphQLClient: MockGraphQLClient };
});

import { GraphQLClient } from "graphql-request";

/**
 * Sets up a per-query mock. IMPORTANT: check PoolSnapshot before Pool,
 * since "Pool" is a substring of "PoolSnapshot".
 */
function mockRequest(impl: (query: string) => unknown) {
  (
    GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
  ).mockImplementation((query: string) => Promise.resolve(impl(query)));
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// fetchNetworkData — happy path
// ---------------------------------------------------------------------------

describe("fetchNetworkData — happy path", () => {
  it("returns pools, fees, and snapshots on full success", async () => {
    const pool = makePool("pool-1");
    mockRequest((query) => {
      // IMPORTANT: PoolSnapshot must be checked before Pool (substring match)
      if (query.includes("PoolSnapshot")) return { PoolSnapshot: [] };
      if (query.includes("ProtocolFeeTransfer"))
        return { ProtocolFeeTransfer: [] };
      if (query.includes("LiquidityPosition"))
        return {
          LiquidityPosition: [
            { address: "0xa" },
            { address: "0xb" },
            { address: "0xc" },
            { address: "0xd" },
            { address: "0xe" },
          ],
        };
      if (query.includes("Pool")) return { Pool: [pool] };
      return {};
    });

    const result = await fetchNetworkData(MOCK_NETWORK, {
      w24h: { from: 0, to: 1000 },
      w7d: { from: 0, to: 7000 },
      w30d: { from: 0, to: 30000 },
    });

    expect(result.error).toBeNull();
    expect(result.feesError).toBeNull();
    expect(result.snapshotsError).toBeNull();
    expect(result.snapshots30dError).toBeNull();
    expect(result.pools).toHaveLength(1);
    expect(result.pools[0].id).toBe("pool-1");
    expect(result.fees).not.toBeNull();
    expect(result.uniqueLpCount).toBe(5);
    expect(result.rates).toBeInstanceOf(Map);

    // Verify the request shape per query type (call order can vary because
    // the fees/snapshots/LP triad fires via Promise.allSettled after Pool).
    const calls = (GraphQLClient.prototype.request as ReturnType<typeof vi.fn>)
      .mock.calls;
    const byQuery = (needle: string) =>
      calls.filter(([q]) => typeof q === "string" && q.includes(needle));

    // One pool query, one fees query, one LP query.
    expect(byQuery("Pool(")[0][1]).toEqual({ chainId: 42220 });
    expect(byQuery("ProtocolFeeTransfer")[0][1]).toEqual({ chainId: 42220 });
    expect(byQuery("LiquidityPosition")[0][1]).toEqual({
      poolIds: ["pool-1"],
    });
    // PoolSnapshotsAll paginates: with an empty response, the loop exits after
    // the first page. Assert that page was requested with limit + offset=0.
    const snapshotCalls = byQuery("PoolSnapshot");
    expect(snapshotCalls).toHaveLength(1);
    expect(snapshotCalls[0][1]).toEqual({
      poolIds: ["pool-1"],
      limit: 1000,
      offset: 0,
    });
  });

  it("deduplicates LP addresses across multiple positions", async () => {
    const pool = makePool("pool-dedup");
    mockRequest((query) => {
      if (query.includes("PoolSnapshot")) return { PoolSnapshot: [] };
      if (query.includes("ProtocolFeeTransfer"))
        return { ProtocolFeeTransfer: [] };
      if (query.includes("LiquidityPosition"))
        return {
          LiquidityPosition: [
            { address: "0xa" },
            { address: "0xa" },
            { address: "0xb" },
            { address: "0xb" },
            { address: "0xc" },
          ],
        };
      if (query.includes("Pool")) return { Pool: [pool] };
      return {};
    });

    const result = await fetchNetworkData(MOCK_NETWORK, {
      w24h: { from: 0, to: 1000 },
      w7d: { from: 0, to: 7000 },
      w30d: { from: 0, to: 30000 },
    });

    expect(result.uniqueLpCount).toBe(3);
  });

  it("trims whitespace from hasuraSecret before setting auth header", async () => {
    mockRequest(() => ({
      Pool: [],
      ProtocolFeeTransfer: [],
      PoolSnapshot: [],
    }));

    await fetchNetworkData(MOCK_NETWORK_WITH_SECRET, {
      w24h: { from: 0, to: 1000 },
      w7d: { from: 0, to: 7000 },
      w30d: { from: 0, to: 30000 },
    });

    const constructorArgs = (GraphQLClient as ReturnType<typeof vi.fn>).mock
      .calls[0];
    const headers = constructorArgs[1]?.headers ?? {};
    expect(headers["x-hasura-admin-secret"]).toBe("my-secret");
  });

  it("omits auth header when secret is empty", async () => {
    mockRequest(() => ({
      Pool: [],
      ProtocolFeeTransfer: [],
      PoolSnapshot: [],
    }));

    await fetchNetworkData(MOCK_NETWORK, {
      w24h: { from: 0, to: 1000 },
      w7d: { from: 0, to: 7000 },
      w30d: { from: 0, to: 30000 },
    });

    const constructorArgs = (GraphQLClient as ReturnType<typeof vi.fn>).mock
      .calls[0];
    const headers = constructorArgs[1]?.headers ?? {};
    expect(headers["x-hasura-admin-secret"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// fetchNetworkData — snapshot pagination
// ---------------------------------------------------------------------------

describe("fetchNetworkData — snapshot pagination", () => {
  it("issues POOL_SNAPSHOTS_ALL with a deterministic tiebreaker", async () => {
    // Regression guard: without a secondary sort key, Postgres tie order on
    // shared timestamps isn't stable across paginated offsets, which
    // duplicates/skips rows at page boundaries.
    mockRequest((query) => {
      if (query.includes("PoolSnapshot")) return { PoolSnapshot: [] };
      if (query.includes("ProtocolFeeTransfer"))
        return { ProtocolFeeTransfer: [] };
      if (query.includes("LiquidityPosition")) return { LiquidityPosition: [] };
      if (query.includes("Pool")) return { Pool: [makePool("pool-sort")] };
      return {};
    });

    await fetchNetworkData(MOCK_NETWORK, {
      w24h: { from: 0, to: 1000 },
      w7d: { from: 0, to: 7000 },
      w30d: { from: 0, to: 30000 },
    });

    const calls = (GraphQLClient.prototype.request as ReturnType<typeof vi.fn>)
      .mock.calls;
    const snapshotCall = calls.find(
      ([q]) => typeof q === "string" && q.includes("PoolSnapshotsAll"),
    );
    expect(snapshotCall).toBeDefined();
    const queryText = String(snapshotCall![0]).replace(/\s+/g, " ");
    expect(queryText).toMatch(/order_by:\s*\[.*timestamp.*id.*\]/);
  });

  it("stops paginating once a page returns fewer than the page size", async () => {
    // First page: exactly page-size rows (could be more). Second page: partial
    // (< page size) → signal that this is the last page, stop.
    const fullPage = Array.from({ length: 1000 }, (_, i) => ({
      poolId: "pool-p",
      timestamp: String(i),
      reserves0: "0",
      reserves1: "0",
      swapCount: 0,
      swapVolume0: "0",
      swapVolume1: "0",
    }));
    const partialPage = fullPage.slice(0, 42);
    let snapshotCall = 0;
    mockRequest((query) => {
      if (query.includes("PoolSnapshot")) {
        snapshotCall++;
        return { PoolSnapshot: snapshotCall === 1 ? fullPage : partialPage };
      }
      if (query.includes("ProtocolFeeTransfer"))
        return { ProtocolFeeTransfer: [] };
      if (query.includes("LiquidityPosition")) return { LiquidityPosition: [] };
      if (query.includes("Pool")) return { Pool: [makePool("pool-p")] };
      return {};
    });

    const result = await fetchNetworkData(MOCK_NETWORK, {
      w24h: { from: 0, to: 1000 },
      w7d: { from: 0, to: 7000 },
      w30d: { from: 0, to: 30000 },
    });

    expect(snapshotCall).toBe(2);
    expect(result.snapshotsAll).toHaveLength(1042);
    expect(result.snapshotsAllError).toBeNull();
  });

  it("flags truncation on overflow but preserves already-fetched rows", async () => {
    // Every page returns a full page → loop hits MAX_PAGES without finding a
    // short page. Returns the accumulated rows (newest-first) with
    // `truncated: true`; rows that WERE fetched stay intact so 24h/7d/30d
    // windows still work — only the "All" range is partial.
    const now = Math.floor(Date.now() / 1000);
    const fullPage = Array.from({ length: 1000 }, (_, i) => ({
      poolId: "pool-overflow",
      timestamp: String(now - i * 60), // every row within the last ~17h → all fit in w24h
      reserves0: "0",
      reserves1: "0",
      swapCount: 0,
      swapVolume0: "0",
      swapVolume1: "0",
    }));
    mockRequest((query) => {
      if (query.includes("PoolSnapshot")) return { PoolSnapshot: fullPage };
      if (query.includes("ProtocolFeeTransfer"))
        return { ProtocolFeeTransfer: [] };
      if (query.includes("LiquidityPosition")) return { LiquidityPosition: [] };
      if (query.includes("Pool")) return { Pool: [makePool("pool-overflow")] };
      return {};
    });

    const result = await fetchNetworkData(MOCK_NETWORK, {
      w24h: { from: now - 86400, to: now },
      w7d: { from: now - 7 * 86400, to: now },
      w30d: { from: now - 30 * 86400, to: now },
    });

    // No error — pagination succeeded, just with a cap.
    expect(result.snapshotsAllError).toBeNull();
    // Truncation flagged for the "All" range.
    expect(result.snapshotsAllTruncated).toBe(true);
    // Recent windows are NOT blanked — they carry the fetched rows.
    expect(result.snapshots.length).toBeGreaterThan(0);
    expect(result.snapshotsAll.length).toBeGreaterThan(0);
    // Exactly 100 pages × 1000 rows = 100k accumulated before bail-out.
    expect(result.snapshotsAll.length).toBe(100 * 1000);
  });

  it("preserves already-fetched rows when a later page errors mid-loop", async () => {
    // Page 1 succeeds, page 2 errors (network glitch). Before this fix the
    // whole pagination promise would reject, blanking every snapshot window
    // even though page 1 had valid recent data. Now: return the accumulated
    // rows + truncated=true, surface via the partial-data badge.
    const now = Math.floor(Date.now() / 1000);
    const fullPage = Array.from({ length: 1000 }, (_, i) => ({
      poolId: "pool-mid-err",
      timestamp: String(now - i * 60),
      reserves0: "0",
      reserves1: "0",
      swapCount: 0,
      swapVolume0: "0",
      swapVolume1: "0",
    }));
    let snapshotCall = 0;
    (GraphQLClient.prototype.request as ReturnType<typeof vi.fn>)
      .mockReset()
      .mockImplementation((query: string) => {
        if (query.includes("PoolSnapshot")) {
          snapshotCall++;
          if (snapshotCall === 1)
            return Promise.resolve({ PoolSnapshot: fullPage });
          return Promise.reject(new Error("upstream timeout on page 2"));
        }
        if (query.includes("ProtocolFeeTransfer"))
          return Promise.resolve({ ProtocolFeeTransfer: [] });
        if (query.includes("LiquidityPosition"))
          return Promise.resolve({ LiquidityPosition: [] });
        if (query.includes("Pool"))
          return Promise.resolve({ Pool: [makePool("pool-mid-err")] });
        return Promise.resolve({});
      });

    const result = await fetchNetworkData(MOCK_NETWORK, {
      w24h: { from: now - 86400, to: now },
      w7d: { from: now - 7 * 86400, to: now },
      w30d: { from: now - 30 * 86400, to: now },
    });

    expect(result.snapshotsAllError).toBeNull();
    expect(result.snapshotsAllTruncated).toBe(true);
    // Page 1's 1000 rows survive — recent windows don't blank.
    expect(result.snapshotsAll.length).toBe(1000);
    expect(result.snapshots.length).toBeGreaterThan(0);
  });

  it("propagates the error when the very first page fails", async () => {
    // No rows accumulated yet → nothing to salvage; caller should see an
    // explicit error state rather than a confident-but-empty dashboard.
    (GraphQLClient.prototype.request as ReturnType<typeof vi.fn>)
      .mockReset()
      .mockImplementation((query: string) => {
        if (query.includes("PoolSnapshot"))
          return Promise.reject(new Error("upstream timeout on page 1"));
        if (query.includes("ProtocolFeeTransfer"))
          return Promise.resolve({ ProtocolFeeTransfer: [] });
        if (query.includes("LiquidityPosition"))
          return Promise.resolve({ LiquidityPosition: [] });
        if (query.includes("Pool"))
          return Promise.resolve({ Pool: [makePool("pool-first-err")] });
        return Promise.resolve({});
      });

    const result = await fetchNetworkData(MOCK_NETWORK, {
      w24h: { from: 0, to: 1000 },
      w7d: { from: 0, to: 7000 },
      w30d: { from: 0, to: 30000 },
    });

    expect(result.snapshotsAllError).not.toBeNull();
    expect(result.snapshotsAll).toHaveLength(0);
    expect(result.snapshotsAllTruncated).toBe(false);
  });

  it("derives window arrays from snapshotsAll by timestamp", async () => {
    const now = Math.floor(Date.now() / 1000);
    const snap = (timestamp: number) => ({
      poolId: "pool-window",
      timestamp: String(timestamp),
      reserves0: "0",
      reserves1: "0",
      swapCount: 0,
      swapVolume0: "0",
      swapVolume1: "0",
    });
    // 3h ago → in 24h window. 2 days ago → in 7d/30d only. 10d ago → 30d only.
    const allSnapshots = [
      snap(now - 3 * 3600),
      snap(now - 2 * 86400),
      snap(now - 10 * 86400),
    ];
    mockRequest((query) => {
      if (query.includes("PoolSnapshot")) return { PoolSnapshot: allSnapshots };
      if (query.includes("ProtocolFeeTransfer"))
        return { ProtocolFeeTransfer: [] };
      if (query.includes("LiquidityPosition")) return { LiquidityPosition: [] };
      if (query.includes("Pool")) return { Pool: [makePool("pool-window")] };
      return {};
    });

    const result = await fetchNetworkData(MOCK_NETWORK, {
      w24h: { from: now - 86400, to: now },
      w7d: { from: now - 7 * 86400, to: now },
      w30d: { from: now - 30 * 86400, to: now },
    });

    expect(result.snapshotsAll).toHaveLength(3);
    expect(result.snapshots).toHaveLength(1); // only 3h-ago fits in 24h
    expect(result.snapshots7d).toHaveLength(2); // 3h-ago + 2d-ago
    expect(result.snapshots30d).toHaveLength(3); // all three
  });
});

// ---------------------------------------------------------------------------
// fetchNetworkData — pools query failure
// ---------------------------------------------------------------------------

describe("fetchNetworkData — pools query failure", () => {
  it("returns error and empty data when pools query throws", async () => {
    const poolsError = new Error("pools query failed");
    (
      GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
    ).mockRejectedValue(poolsError);

    const result = await fetchNetworkData(MOCK_NETWORK, {
      w24h: { from: 0, to: 1000 },
      w7d: { from: 0, to: 7000 },
      w30d: { from: 0, to: 30000 },
    });

    expect(result.error).toBe(poolsError);
    expect(result.pools).toHaveLength(0);
    expect(result.snapshots).toHaveLength(0);
    expect(result.fees).toBeNull();
    expect(result.feesError).toBeNull();
    expect(result.snapshotsError).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fetchNetworkData — fees query failure only
// ---------------------------------------------------------------------------

describe("fetchNetworkData — fees query failure only", () => {
  it("surfaces feesError, pools succeed, snapshots succeed", async () => {
    const pool = makePool("pool-a");
    const feesErr = new Error("fees timeout");

    (
      GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
    ).mockImplementation((query: string) => {
      if (query.includes("ProtocolFeeTransfer")) return Promise.reject(feesErr);
      if (query.includes("PoolSnapshot"))
        return Promise.resolve({ PoolSnapshot: [] });
      if (query.includes("Pool")) return Promise.resolve({ Pool: [pool] });
      return Promise.resolve({});
    });

    const result = await fetchNetworkData(MOCK_NETWORK, {
      w24h: { from: 0, to: 1000 },
      w7d: { from: 0, to: 7000 },
      w30d: { from: 0, to: 30000 },
    });

    expect(result.error).toBeNull();
    expect(result.feesError).toBe(feesErr);
    expect(result.snapshotsError).toBeNull();
    expect(result.pools).toHaveLength(1);
    expect(result.fees).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fetchNetworkData — snapshots query failure only
// ---------------------------------------------------------------------------

describe("fetchNetworkData — snapshots query failure only", () => {
  it("surfaces snapshotsError, pools and fees succeed", async () => {
    const pool = makePool("pool-b");
    const snapErr = new Error("snapshots unavailable");

    (
      GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
    ).mockImplementation((query: string) => {
      if (query.includes("PoolSnapshot")) return Promise.reject(snapErr);
      if (query.includes("ProtocolFeeTransfer"))
        return Promise.resolve({ ProtocolFeeTransfer: [] });
      if (query.includes("Pool")) return Promise.resolve({ Pool: [pool] });
      return Promise.resolve({});
    });

    const result = await fetchNetworkData(MOCK_NETWORK, {
      w24h: { from: 0, to: 1000 },
      w7d: { from: 0, to: 7000 },
      w30d: { from: 0, to: 30000 },
    });

    expect(result.error).toBeNull();
    expect(result.snapshotsError).toBe(snapErr);
    expect(result.feesError).toBeNull();
    expect(result.pools).toHaveLength(1);
    expect(result.snapshots).toHaveLength(0);
    expect(result.fees).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fetchNetworkData — non-Error rejections wrapped
// ---------------------------------------------------------------------------

describe("fetchNetworkData — non-Error thrown values", () => {
  it("wraps string rejection in Error for pools failure", async () => {
    (
      GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
    ).mockRejectedValue("something went wrong");

    const result = await fetchNetworkData(MOCK_NETWORK, {
      w24h: { from: 0, to: 1000 },
      w7d: { from: 0, to: 7000 },
      w30d: { from: 0, to: 30000 },
    });

    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toBe("something went wrong");
  });
});

// ---------------------------------------------------------------------------
// fetchNetworkData — LP query failure only
// ---------------------------------------------------------------------------

describe("fetchNetworkData — LP query failure only", () => {
  it("surfaces uniqueLpCount as null when LP query rejects", async () => {
    const pool = makePool("pool-lp");
    const lpErr = new Error("LP query timeout");

    (
      GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
    ).mockImplementation((query: string) => {
      if (query.includes("LiquidityPosition")) return Promise.reject(lpErr);
      if (query.includes("PoolSnapshot")) return { PoolSnapshot: [] };
      if (query.includes("ProtocolFeeTransfer"))
        return { ProtocolFeeTransfer: [] };
      if (query.includes("Pool")) return { Pool: [pool] };
      return {};
    });

    const result = await fetchNetworkData(MOCK_NETWORK, {
      w24h: { from: 0, to: 1000 },
      w7d: { from: 0, to: 7000 },
      w30d: { from: 0, to: 30000 },
    });

    expect(result.error).toBeNull();
    expect(result.pools).toHaveLength(1);
    expect(result.fees).not.toBeNull();
    expect(result.uniqueLpCount).toBeNull();
    expect(result.lpError).toBe(lpErr);
  });
});

// ---------------------------------------------------------------------------
// fetchNetworkData — cross-network isolation
// (These tests exercise fetchNetworkData in isolation, not fetchAllNetworks.
//  See the fetchAllNetworks section below for orchestration-level tests.)
// ---------------------------------------------------------------------------

describe("fetchNetworkData — cross-network isolation", () => {
  it("one network pools failure does not affect the other network", async () => {
    const pool = makePool("pool-x");
    const poolsErr = new Error("network down");

    // Simulate network1 succeeding, network2 failing
    const result1 = await (async () => {
      (
        GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
      ).mockImplementation((query: string) => {
        if (query.includes("PoolSnapshot"))
          return Promise.resolve({ PoolSnapshot: [] });
        if (query.includes("ProtocolFeeTransfer"))
          return Promise.resolve({ ProtocolFeeTransfer: [] });
        if (query.includes("Pool")) return Promise.resolve({ Pool: [pool] });
        return Promise.resolve({});
      });
      return fetchNetworkData(MOCK_NETWORK, {
        w24h: { from: 0, to: 1000 },
        w7d: { from: 0, to: 7000 },
        w30d: { from: 0, to: 30000 },
      });
    })();

    vi.clearAllMocks();

    const result2 = await (async () => {
      (
        GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
      ).mockRejectedValue(poolsErr);
      return fetchNetworkData(MOCK_NETWORK_2, {
        w24h: { from: 0, to: 1000 },
        w7d: { from: 0, to: 7000 },
        w30d: { from: 0, to: 30000 },
      });
    })();

    // Network 1: success
    expect(result1.error).toBeNull();
    expect(result1.pools).toHaveLength(1);
    expect(result1.network.id).toBe("celo-mainnet");

    // Network 2: error, but still returns correct network metadata
    expect(result2.error).toBe(poolsErr);
    expect(result2.pools).toHaveLength(0);
    expect(result2.network.id).toBe("celo-sepolia");
  });

  it("network index maps correctly to network metadata on rejection", async () => {
    // Verify that a failing network still carries the correct network object
    const err = new Error("timeout");
    (
      GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
    ).mockRejectedValue(err);

    const result = await fetchNetworkData(MOCK_NETWORK_2, {
      w24h: { from: 0, to: 1000 },
      w7d: { from: 0, to: 7000 },
      w30d: { from: 0, to: 30000 },
    });

    expect(result.network).toBe(MOCK_NETWORK_2);
    expect(result.error).toBe(err);
  });

  it("fees failure on one network does not affect pools or snapshots", async () => {
    const pool = makePool("pool-c");
    const feesErr = new Error("fees down");

    (
      GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
    ).mockImplementation((query: string) => {
      if (query.includes("ProtocolFeeTransfer")) return Promise.reject(feesErr);
      if (query.includes("PoolSnapshot"))
        return Promise.resolve({ PoolSnapshot: [] });
      if (query.includes("Pool")) return Promise.resolve({ Pool: [pool] });
      return Promise.resolve({});
    });

    const result = await fetchNetworkData(MOCK_NETWORK, {
      w24h: { from: 0, to: 1000 },
      w7d: { from: 0, to: 7000 },
      w30d: { from: 0, to: 30000 },
    });

    expect(result.error).toBeNull();
    expect(result.pools).toHaveLength(1);
    expect(result.feesError).toBe(feesErr);
    expect(result.snapshotsError).toBeNull();
    expect(result.fees).toBeNull();
  });

  it("snapshots failure on one network does not affect pools or fees", async () => {
    const pool = makePool("pool-d");
    const snapErr = new Error("snapshots down");

    (
      GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
    ).mockImplementation((query: string) => {
      if (query.includes("PoolSnapshot")) return Promise.reject(snapErr);
      if (query.includes("ProtocolFeeTransfer"))
        return Promise.resolve({ ProtocolFeeTransfer: [] });
      if (query.includes("Pool")) return Promise.resolve({ Pool: [pool] });
      return Promise.resolve({});
    });

    const result = await fetchNetworkData(MOCK_NETWORK, {
      w24h: { from: 0, to: 1000 },
      w7d: { from: 0, to: 7000 },
      w30d: { from: 0, to: 30000 },
    });

    expect(result.error).toBeNull();
    expect(result.pools).toHaveLength(1);
    expect(result.snapshotsError).toBe(snapErr);
    expect(result.feesError).toBeNull();
    expect(result.snapshots).toHaveLength(0);
    expect(result.fees).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fetchAllNetworks — orchestration (Promise.allSettled + rejection mapping)
// ---------------------------------------------------------------------------
// These tests call fetchAllNetworks() directly and control which networks it
// sees by mocking @/lib/networks. This verifies the actual orchestration path:
// allSettled mapping, index→network metadata preservation, and rejection wrapping.

vi.mock("@/lib/networks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/networks")>();
  return {
    ...actual,
    NETWORK_IDS: ["celo-mainnet", "celo-sepolia"],
    NETWORKS: {
      "celo-mainnet": {
        id: "celo-mainnet",
        label: "Celo",
        chainId: 42220,
        contractsNamespace: null,
        hasuraUrl: "https://mainnet.example.com/v1/graphql",
        hasuraSecret: "",
        explorerBaseUrl: "https://celoscan.io",
        tokenSymbols: {},
        addressLabels: {},
        local: false,
        hasVirtualPools: false,
        testnet: false,
      },
      "celo-sepolia": {
        id: "celo-sepolia",
        label: "Celo Sepolia",
        chainId: 11142220,
        contractsNamespace: null,
        hasuraUrl: "https://sepolia.example.com/v1/graphql",
        hasuraSecret: "",
        explorerBaseUrl: "https://celo-sepolia.blockscout.com",
        tokenSymbols: {},
        addressLabels: {},
        local: false,
        hasVirtualPools: false,
        testnet: false,
      },
    },
    isConfiguredNetworkId: (id: string) =>
      ["celo-mainnet", "celo-sepolia"].includes(id),
  };
});

describe("fetchAllNetworks — orchestration", () => {
  it("returns one result per configured network", async () => {
    (
      GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      Pool: [],
      ProtocolFeeTransfer: [],
      PoolSnapshot: [],
    });

    const results = await fetchAllNetworks();

    expect(results).toHaveLength(2);
    expect(results[0].network.id).toBe("celo-mainnet");
    expect(results[1].network.id).toBe("celo-sepolia");
  });

  it("fulfilled network has correct pools and no error", async () => {
    const pool = makePool("pool-main");
    (
      GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
    ).mockImplementation((query: string) => {
      if (query.includes("PoolSnapshot"))
        return Promise.resolve({ PoolSnapshot: [] });
      if (query.includes("ProtocolFeeTransfer"))
        return Promise.resolve({ ProtocolFeeTransfer: [] });
      if (query.includes("Pool")) return Promise.resolve({ Pool: [pool] });
      return Promise.resolve({});
    });

    const results = await fetchAllNetworks();
    const mainnet = results.find((r) => r.network.id === "celo-mainnet")!;

    expect(mainnet.error).toBeNull();
    expect(mainnet.pools).toHaveLength(1);
    expect(mainnet.pools[0].id).toBe("pool-main");
  });

  it("rejected network maps error and preserves network metadata", async () => {
    const err = new Error("sepolia down");
    (
      GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
    ).mockImplementation(() => {
      // Fail only the sepolia URL
      const url = (GraphQLClient as ReturnType<typeof vi.fn>).mock.calls.at(
        -1,
      )?.[0];
      if (url?.includes("sepolia")) return Promise.reject(err);
      return Promise.resolve({
        Pool: [],
        ProtocolFeeTransfer: [],
        PoolSnapshot: [],
      });
    });

    const results = await fetchAllNetworks();
    const sepolia = results.find((r) => r.network.id === "celo-sepolia")!;

    expect(sepolia.network.id).toBe("celo-sepolia");
    expect(sepolia.error).toBe(err);
    expect(sepolia.pools).toHaveLength(0);
  });

  it("one network failing does not prevent others from succeeding", async () => {
    const pool = makePool("pool-ok");
    // Track call count: mainnet gets calls 1-3 (pools/fees/snapshots),
    // sepolia gets call 4 which we reject.
    let callCount = 0;
    (
      GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
    ).mockImplementation((query: string) => {
      callCount++;
      // Reject every request to the sepolia client (constructed second)
      const constructedUrls = (
        GraphQLClient as ReturnType<typeof vi.fn>
      ).mock.calls.map((c: unknown[]) => c[0] as string);
      const lastUrl = constructedUrls[constructedUrls.length - 1] ?? "";
      if (lastUrl.includes("sepolia"))
        return Promise.reject(new Error("sepolia down"));
      if (query.includes("PoolSnapshot"))
        return Promise.resolve({ PoolSnapshot: [] });
      if (query.includes("ProtocolFeeTransfer"))
        return Promise.resolve({ ProtocolFeeTransfer: [] });
      return Promise.resolve({ Pool: [pool] });
    });

    const results = await fetchAllNetworks();
    const mainnet = results.find((r) => r.network.id === "celo-mainnet")!;
    const sepolia = results.find((r) => r.network.id === "celo-sepolia")!;

    expect(mainnet.error).toBeNull();
    expect(sepolia.error).not.toBeNull();
    // callCount used to suppress unused-var lint
    expect(callCount).toBeGreaterThan(0);
  });

  it("wraps non-Error rejections in Error objects", async () => {
    (
      GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
    ).mockRejectedValue("string rejection");

    const results = await fetchAllNetworks();

    for (const result of results) {
      expect(result.error).toBeInstanceOf(Error);
    }
  });
});
