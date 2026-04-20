import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fetchNetworkData,
  fetchAllNetworks,
  warnedCapKeys,
  partialPageLastCapturedAt,
} from "../use-all-networks-data";
import type { Network } from "@/lib/networks";
import type { Pool } from "@/lib/types";

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

import * as Sentry from "@sentry/nextjs";

// Minimal fixture helpers

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

// Mock graphql-request

vi.mock("graphql-request", () => {
  const MockGraphQLClient = vi.fn();
  MockGraphQLClient.prototype.request = vi.fn();
  return { GraphQLClient: MockGraphQLClient };
});

import { GraphQLClient } from "graphql-request";

/**
 * Sets up a per-query mock.
 *
 * Ordering matters — each entity name is a substring of every longer entity
 * name that shares its prefix:
 *   "Pool"              matches Pool, PoolSnapshot, PoolDailySnapshot
 *   "PoolSnapshot"      matches PoolSnapshot, PoolDailySnapshot
 *   "PoolDailySnapshot" matches only PoolDailySnapshot
 *
 * Check most-specific first (PoolDailySnapshot > PoolSnapshot > Pool).
 * If `impl` does not handle a PoolDailySnapshot query (impl returns something
 * without that key), we default to an empty page so the pagination loop exits
 * cleanly rather than silently routing the query to the PoolSnapshot branch.
 */
function mockRequest(impl: (query: string) => unknown) {
  (
    GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
  ).mockImplementation((query: string) => {
    if (query.includes("PoolDailySnapshot")) {
      const r = impl(query);
      if (r != null && typeof r === "object" && "PoolDailySnapshot" in r)
        return Promise.resolve(r);
      return Promise.resolve({ PoolDailySnapshot: [] });
    }
    return Promise.resolve(impl(query));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Sentry de-dup maps live at module scope — clear between tests so
  // previous runs don't suppress subsequent captures.
  warnedCapKeys.clear();
  partialPageLastCapturedAt.clear();
});

// fetchNetworkData — happy path

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
    expect(result.uniqueLpAddresses).toHaveLength(5);
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

    expect(result.uniqueLpAddresses).toEqual(
      expect.arrayContaining(["0xa", "0xb", "0xc"]),
    );
    expect(result.uniqueLpAddresses).toHaveLength(3);
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

// fetchNetworkData — snapshot pagination

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
    // First page: exactly page-size rows. Second page: partial (< page size)
    // → last page, stop. Each row has a unique (poolId, timestamp) so the
    // client-side dedup is a no-op here.
    const makeRow = (timestamp: number) => ({
      poolId: "pool-p",
      timestamp: String(timestamp),
      reserves0: "0",
      reserves1: "0",
      swapCount: 0,
      swapVolume0: "0",
      swapVolume1: "0",
    });
    const page1 = Array.from({ length: 1000 }, (_, i) => makeRow(i));
    const page2 = Array.from({ length: 42 }, (_, i) => makeRow(1000 + i));
    let snapshotCall = 0;
    mockRequest((query) => {
      if (query.includes("PoolSnapshot")) {
        snapshotCall++;
        return { PoolSnapshot: snapshotCall === 1 ? page1 : page2 };
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

  it("dedups rows that appear in multiple pages (concurrent-insert drift)", async () => {
    // If a new snapshot arrives between page 1 and page 2, offset pagination
    // overlaps: the last row of page 1 reappears as the first row of page 2.
    // Dedup by (poolId, timestamp) should collapse the duplicate — otherwise
    // the chart would double-count that hour's volume.
    const makeRow = (timestamp: number) => ({
      poolId: "pool-dup",
      timestamp: String(timestamp),
      reserves0: "0",
      reserves1: "0",
      swapCount: 0,
      swapVolume0: "0",
      swapVolume1: "0",
    });
    // Page 1: rows 0..999. Page 2: rows 999..1038 (first row overlaps). Page 3: empty.
    const page1 = Array.from({ length: 1000 }, (_, i) => makeRow(i));
    const page2 = Array.from({ length: 40 }, (_, i) => makeRow(999 + i));
    let call = 0;
    mockRequest((query) => {
      if (query.includes("PoolSnapshot")) {
        call++;
        if (call === 1) return { PoolSnapshot: page1 };
        if (call === 2) return { PoolSnapshot: page2 };
        return { PoolSnapshot: [] };
      }
      if (query.includes("ProtocolFeeTransfer"))
        return { ProtocolFeeTransfer: [] };
      if (query.includes("LiquidityPosition")) return { LiquidityPosition: [] };
      if (query.includes("Pool")) return { Pool: [makePool("pool-dup")] };
      return {};
    });

    const result = await fetchNetworkData(MOCK_NETWORK, {
      w24h: { from: 0, to: 1000 },
      w7d: { from: 0, to: 7000 },
      w30d: { from: 0, to: 30000 },
    });

    // 1000 from page 1 + 40 from page 2 − 1 overlap = 1039.
    expect(result.snapshotsAll).toHaveLength(1039);
  });

  it("flags truncation on overflow but preserves already-fetched rows", async () => {
    // Every page returns 1000 UNIQUE rows → loop hits MAX_PAGES without
    // finding a short page. Return accumulated rows with `truncated: true,
    // error: null` — 24h/7d/30d windows still work from what we have.
    const now = Math.floor(Date.now() / 1000);
    let rowCursor = 0;
    mockRequest((query) => {
      if (query.includes("PoolSnapshot")) {
        const batch = Array.from({ length: 1000 }, () => {
          // Unique timestamps across all pages so dedup doesn't collapse.
          // All fit in the 24h window (minute-granularity across ~70 days
          // worth of minutes — still > 24h but page 1 alone covers >24h).
          const ts = now - rowCursor * 60;
          rowCursor++;
          return {
            poolId: "pool-overflow",
            timestamp: String(ts),
            reserves0: "0",
            reserves1: "0",
            swapCount: 0,
            swapVolume0: "0",
            swapVolume1: "0",
          };
        });
        return { PoolSnapshot: batch };
      }
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

    // Overflow is a known safety cap, not a fault — error stays null.
    expect(result.snapshotsAllError).toBeNull();
    expect(result.snapshotsAllTruncated).toBe(true);
    expect(result.snapshots.length).toBeGreaterThan(0);
    expect(result.snapshotsAll).toHaveLength(100 * 1000);
  });

  it("emits captureMessage once per network when the cap is hit", async () => {
    // Two networks (celo-mainnet, celo-sepolia) both hit the pagination cap.
    // Dedup key is `${network}:${responseKey}`, so each network should emit
    // exactly one "hasura-snapshot-cap-exhausted" warning tagged with its
    // own network id. A third fetch against a network that already warned
    // should NOT re-emit — that's the dedup guarantee.
    const now = Math.floor(Date.now() / 1000);
    let rowCursor = 0;
    const alwaysFullPage = (query: string) => {
      if (query.includes("PoolSnapshot")) {
        const batch = Array.from({ length: 1000 }, () => ({
          poolId: "pool-cap",
          timestamp: String(now - rowCursor++ * 60),
          reserves0: "0",
          reserves1: "0",
          swapCount: 0,
          swapVolume0: "0",
          swapVolume1: "0",
        }));
        return { PoolSnapshot: batch };
      }
      if (query.includes("ProtocolFeeTransfer"))
        return { ProtocolFeeTransfer: [] };
      if (query.includes("LiquidityPosition")) return { LiquidityPosition: [] };
      if (query.includes("Pool")) return { Pool: [makePool("pool-cap")] };
      return {};
    };
    mockRequest(alwaysFullPage);

    const windows = {
      w24h: { from: now - 86400, to: now },
      w7d: { from: now - 7 * 86400, to: now },
      w30d: { from: now - 30 * 86400, to: now },
    };

    await fetchNetworkData(MOCK_NETWORK, windows);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(
      (Sentry.captureMessage as ReturnType<typeof vi.fn>).mock.calls[0][1].tags
        .network,
    ).toBe("celo-mainnet");

    await fetchNetworkData(MOCK_NETWORK_2, windows);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(2);
    expect(
      (Sentry.captureMessage as ReturnType<typeof vi.fn>).mock.calls[1][1].tags
        .network,
    ).toBe("celo-sepolia");

    // Re-running celo-mainnet should NOT re-emit — dedup by network.
    await fetchNetworkData(MOCK_NETWORK, windows);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(2);
  });

  it("on mid-loop failure, only flags the window whose coverage is actually incomplete", async () => {
    // Page 1 succeeds (1000 rows at 30-minute spacing → ~20.8 days of
    // history); page 2 errors. Windows fully covered by those rows stay
    // error-free; windows that extend beyond the oldest fetched row surface
    // an error so Summary subs can partial-badge selectively.
    const now = Math.floor(Date.now() / 1000);
    const page1 = Array.from({ length: 1000 }, (_, i) => ({
      poolId: "pool-mid-err",
      timestamp: String(now - i * 1800), // 30-min spacing → oldest ≈ 20.8d
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
            return Promise.resolve({ PoolSnapshot: page1 });
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

    // snapshotsAllError is set (pagination failed).
    expect(result.snapshotsAllError).not.toBeNull();
    expect(result.snapshotsAllTruncated).toBe(true);
    // 24h and 7d windows are inside the fetched rows → no per-window error.
    expect(result.snapshotsError).toBeNull();
    expect(result.snapshots7dError).toBeNull();
    // 30d window extends beyond oldestFetched (≈ 20.8d) → flagged.
    expect(result.snapshots30dError).not.toBeNull();
    // Preserved rows still drive the derived window arrays.
    expect(result.snapshotsAll).toHaveLength(1000);
    expect(result.snapshots.length).toBeGreaterThan(0);
    expect(result.snapshots7d.length).toBeGreaterThan(0);
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
    // With no preserved rows, every window is incomplete — all three per-
    // window errors light up so consumers show the fully-errored state.
    expect(result.snapshotsError).toBe(result.snapshotsAllError);
    expect(result.snapshots7dError).toBe(result.snapshotsAllError);
    expect(result.snapshots30dError).toBe(result.snapshotsAllError);
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

// fetchNetworkData — daily snapshot pagination

describe("fetchNetworkData — daily snapshot pagination", () => {
  const makeDaily = (timestamp: number) => ({
    poolId: "pool-daily",
    timestamp: String(timestamp),
    reserves0: "0",
    reserves1: "0",
    swapCount: 1,
    swapVolume0: "1000000000000000000",
    swapVolume1: "2000000000000000000",
  });

  it("populates snapshotsAllDaily on success, leaving error null and truncated false", async () => {
    const now = Math.floor(Date.now() / 1000);
    mockRequest((query) => {
      if (query.includes("PoolDailySnapshot"))
        return { PoolDailySnapshot: [makeDaily(now - 86400)] };
      if (query.includes("PoolSnapshot")) return { PoolSnapshot: [] };
      if (query.includes("ProtocolFeeTransfer"))
        return { ProtocolFeeTransfer: [] };
      if (query.includes("LiquidityPosition")) return { LiquidityPosition: [] };
      if (query.includes("Pool")) return { Pool: [makePool("pool-daily")] };
      return {};
    });

    const result = await fetchNetworkData(MOCK_NETWORK, {
      w24h: { from: now - 86400, to: now },
      w7d: { from: now - 7 * 86400, to: now },
      w30d: { from: now - 30 * 86400, to: now },
    });

    expect(result.snapshotsAllDailyError).toBeNull();
    expect(result.snapshotsAllDailyTruncated).toBe(false);
    expect(result.snapshotsAllDaily).toHaveLength(1);
  });

  it("sets snapshotsAllDailyError and returns empty rows on first-page failure", async () => {
    (GraphQLClient.prototype.request as ReturnType<typeof vi.fn>)
      .mockReset()
      .mockImplementation((query: string) => {
        if (query.includes("PoolDailySnapshot"))
          return Promise.reject(new Error("daily snapshot timeout"));
        if (query.includes("PoolSnapshot"))
          return Promise.resolve({ PoolSnapshot: [] });
        if (query.includes("ProtocolFeeTransfer"))
          return Promise.resolve({ ProtocolFeeTransfer: [] });
        if (query.includes("LiquidityPosition"))
          return Promise.resolve({ LiquidityPosition: [] });
        if (query.includes("Pool"))
          return Promise.resolve({ Pool: [makePool("pool-daily-err")] });
        return Promise.resolve({});
      });

    const result = await fetchNetworkData(MOCK_NETWORK, {
      w24h: { from: 0, to: 1000 },
      w7d: { from: 0, to: 7000 },
      w30d: { from: 0, to: 30000 },
    });

    expect(result.snapshotsAllDailyError).not.toBeNull();
    expect(result.snapshotsAllDaily).toHaveLength(0);
    expect(result.snapshotsAllDailyTruncated).toBe(false);
  });

  it("flags snapshotsAllDailyTruncated and preserves rows on overflow", async () => {
    // Every page returns 1000 unique rows → loop hits MAX_PAGES cap.
    let rowCursor = 0;
    mockRequest((query) => {
      if (query.includes("PoolDailySnapshot")) {
        const batch = Array.from({ length: 1000 }, () => {
          const ts = Math.floor(Date.now() / 1000) - rowCursor * 86400;
          rowCursor++;
          return makeDaily(ts);
        });
        return { PoolDailySnapshot: batch };
      }
      if (query.includes("PoolSnapshot")) return { PoolSnapshot: [] };
      if (query.includes("ProtocolFeeTransfer"))
        return { ProtocolFeeTransfer: [] };
      if (query.includes("LiquidityPosition")) return { LiquidityPosition: [] };
      if (query.includes("Pool"))
        return { Pool: [makePool("pool-daily-overflow")] };
      return {};
    });

    const result = await fetchNetworkData(MOCK_NETWORK, {
      w24h: { from: 0, to: 1000 },
      w7d: { from: 0, to: 7000 },
      w30d: { from: 0, to: 30000 },
    });

    expect(result.snapshotsAllDailyError).toBeNull();
    expect(result.snapshotsAllDailyTruncated).toBe(true);
    // Rows from all MAX_PAGES pages are preserved.
    expect(result.snapshotsAllDaily.length).toBeGreaterThan(0);
  });
});

// fetchNetworkData — pools query failure

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

// fetchNetworkData — fees query failure only

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

// fetchNetworkData — snapshots query failure only

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

// fetchNetworkData — non-Error rejections wrapped

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

// fetchNetworkData — LP query failure only

describe("fetchNetworkData — LP query failure only", () => {
  it("surfaces uniqueLpAddresses as null when LP query rejects", async () => {
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
    expect(result.uniqueLpAddresses).toBeNull();
    expect(result.lpError).toBe(lpErr);
  });
});

// fetchNetworkData — cross-network isolation
// (These tests exercise fetchNetworkData in isolation, not fetchAllNetworks.
//  See the fetchAllNetworks section below for orchestration-level tests.)

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

// fetchAllNetworks — orchestration (Promise.allSettled + rejection mapping)
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
