import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Network } from "@/lib/networks";
import type { NetworkData } from "@/lib/network-fetcher/types";

const { mockFetchAllNetworks, cacheCallbackOutcomes, staleCacheEntry } =
  vi.hoisted(() => ({
    mockFetchAllNetworks: vi.fn(),
    /** Records whether each unstable_cache callback invocation resolved
     *  (cacheable) or threw (never written to the cache). */
    cacheCallbackOutcomes: [] as ("resolved" | "threw")[],
    /** When armed, the unstable_cache mock returns this value WITHOUT
     *  invoking the callback — mirroring Next's stale-hit path, where the
     *  cached entry is served immediately and the background revalidation
     *  (including any error it throws) is swallowed. */
    staleCacheEntry: { value: undefined as unknown },
  }));

// next/cache needs the Next.js incremental-cache runtime; outside it the repo
// convention is an identity wrapper (see pool-detail-ssr.test.ts). This one
// additionally records resolve/throw so tests can assert which payloads would
// have been written to the shared cache, and can serve an armed stale entry
// to simulate `unstable_cache`'s serve-stale-while-background-revalidate.
vi.mock("next/cache", () => ({
  unstable_cache:
    <TArgs extends unknown[], TResult>(
      fn: (...args: TArgs) => Promise<TResult>,
    ) =>
    async (...args: TArgs): Promise<TResult> => {
      if (staleCacheEntry.value !== undefined) {
        return staleCacheEntry.value as TResult;
      }
      try {
        const result = await fn(...args);
        cacheCallbackOutcomes.push("resolved");
        return result;
      } catch (err) {
        cacheCallbackOutcomes.push("threw");
        throw err;
      }
    },
}));

vi.mock("@/lib/network-fetcher/fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/network-fetcher/fetch")>()),
  fetchAllNetworks: mockFetchAllNetworks,
}));

import {
  dehydrateNetworkData,
  fetchInitialNetworkData,
  rehydrateNetworkData,
} from "@/lib/network-fetcher/server-cache";
import { blankNetworkData } from "@/lib/network-fetcher/fetch";

const network = {
  id: "celo-mainnet",
  label: "Celo",
  chainId: 42220,
  contractsNamespace: null,
  hasuraUrl: "https://example.invalid/graphql",
  hasuraSecret: "",
  explorerBaseUrl: "https://example.invalid",
  tokenSymbols: {},
  addressLabels: {},
  local: false,
  testnet: false,
  hasVirtualPools: true,
} as Network;

const windows = {
  w24h: { from: 0, to: 86_400 },
  w7d: { from: 0, to: 604_800 },
  w30d: { from: 0, to: 2_592_000 },
};

function healthyNetworkData(overrides: Partial<NetworkData> = {}): NetworkData {
  return blankNetworkData(network, windows, {
    rates: new Map([["42220:cUSD", 1.0004]]),
    poolLabels: new Map([
      [
        "0xabc",
        {
          id: "0xabc",
          token0: "0x1",
          token1: "0x2",
          source: "fpmm",
        } as NetworkData["poolLabels"] extends Map<string, infer V> ? V : never,
      ],
    ]),
    olsPoolIds: new Set(["0xols"]),
    cdpPoolIds: new Set(["0xcdp"]),
    reservePoolIds: new Set(["0xres"]),
    feeSnapshots: [
      { id: "fee-1" } as NetworkData["feeSnapshots"][number],
      { id: "fee-2" } as NetworkData["feeSnapshots"][number],
    ],
    ...overrides,
  });
}

beforeEach(() => {
  mockFetchAllNetworks.mockReset();
  cacheCallbackOutcomes.length = 0;
  staleCacheEntry.value = undefined;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("dehydrate/rehydrate round-trip", () => {
  it("restores Map and Set fields through a JSON round-trip", () => {
    const data = healthyNetworkData();

    const roundTripped = rehydrateNetworkData(
      // JSON round-trip mirrors what unstable_cache does to cached values
      // (JSON.parse of the stored body) — the exact step that silently turns
      // a raw Map/Set into `{}`.
      JSON.parse(JSON.stringify(dehydrateNetworkData(data))),
    );

    expect(roundTripped.rates).toEqual(new Map([["42220:cUSD", 1.0004]]));
    expect(roundTripped.olsPoolIds).toEqual(new Set(["0xols"]));
    expect(roundTripped.cdpPoolIds).toEqual(new Set(["0xcdp"]));
    expect(roundTripped.reservePoolIds).toEqual(new Set(["0xres"]));
    expect(roundTripped.poolLabels.get("0xabc")).toMatchObject({
      id: "0xabc",
    });
    expect(roundTripped.network).toEqual(network);
    expect(roundTripped.snapshotWindows).toEqual(windows);

    // Schema-evolution net: full deep equality so a future Map/Set field on
    // `NetworkData` that the dehydrate/rehydrate pair doesn't handle fails
    // here (it would silently flatten to `{}` in the JSON round-trip)
    // instead of shipping lost data.
    expect(roundTripped).toEqual(data);
  });
});

describe("fetchInitialNetworkData", () => {
  it("returns the rehydrated healthy payload and marks it cacheable", async () => {
    mockFetchAllNetworks.mockResolvedValueOnce([healthyNetworkData()]);

    const result = await fetchInitialNetworkData();

    expect(result).toHaveLength(1);
    expect(result[0]!.rates.get("42220:cUSD")).toBe(1.0004);
    expect(result[0]!.olsPoolIds.has("0xols")).toBe(true);
    expect(cacheCallbackOutcomes).toEqual(["resolved"]);
  });

  it("strips raw feeSnapshots rows but keeps the fee outcome fields", async () => {
    mockFetchAllNetworks.mockResolvedValueOnce([
      healthyNetworkData({ feeSnapshotsTruncated: true }),
    ]);

    const [data] = await fetchInitialNetworkData();

    expect(data!.feeSnapshots).toEqual([]);
    expect(data!.feeSnapshotsError).toBeNull();
    expect(data!.feeSnapshotsTruncated).toBe(true);
  });

  it("still returns a degraded payload but never caches it", async () => {
    mockFetchAllNetworks.mockResolvedValueOnce([
      healthyNetworkData({ ratesError: { message: "oracle query failed" } }),
    ]);

    const [data] = await fetchInitialNetworkData();

    expect(data!.ratesError).toEqual({ message: "oracle query failed" });
    expect(data!.rates.get("42220:cUSD")).toBe(1.0004);
    expect(cacheCallbackOutcomes).toEqual(["threw"]);
  });

  it("treats an empty payload as degraded instead of pinning it", async () => {
    mockFetchAllNetworks.mockResolvedValueOnce([]);

    const result = await fetchInitialNetworkData();

    expect(result).toEqual([]);
    expect(cacheCallbackOutcomes).toEqual(["threw"]);
  });

  it("rethrows unexpected errors from the fetch", async () => {
    mockFetchAllNetworks.mockRejectedValueOnce(new Error("boom"));

    await expect(fetchInitialNetworkData()).rejects.toThrow("boom");
  });

  // Stale-hit path: `unstable_cache` serves stale entries and swallows
  // background-revalidation errors, so only the fetchedAt age gate bounds
  // what visitors actually see (MAX_SERVED_STALENESS_MS = 90s).
  describe("fetchedAt age gate", () => {
    const NOW = 1_700_000_000_000;
    /** Cached-entry shape as written by the cache callback: dehydrated,
     *  fee-rows stripped, with the fetch-completion timestamp. */
    function staleEntry(ageMs: number, overrides: Partial<NetworkData> = {}) {
      return {
        fetchedAt: NOW - ageMs,
        networks: [
          dehydrateNetworkData(
            healthyNetworkData({ feeSnapshots: [], ...overrides }),
          ),
        ],
      };
    }

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
    });

    it("serves a cached payload younger than 90s without refetching", async () => {
      staleCacheEntry.value = staleEntry(89_000);

      const result = await fetchInitialNetworkData();

      expect(mockFetchAllNetworks).not.toHaveBeenCalled();
      expect(result).toHaveLength(1);
      expect(result[0]!.rates.get("42220:cUSD")).toBe(1.0004);
    });

    it("foreground-refetches a cached payload older than 90s", async () => {
      // Distinguishable stale rate — the assertion below proves the fresh
      // payload wins, not the pinned cache entry.
      staleCacheEntry.value = staleEntry(90_001, {
        rates: new Map([["42220:cUSD", 999]]),
      });
      mockFetchAllNetworks.mockResolvedValueOnce([healthyNetworkData()]);

      const result = await fetchInitialNetworkData();

      expect(mockFetchAllNetworks).toHaveBeenCalledTimes(1);
      expect(result[0]!.rates.get("42220:cUSD")).toBe(1.0004);
    });

    it("surfaces a fresh degraded payload past 90s instead of the stale healthy one", async () => {
      staleCacheEntry.value = staleEntry(90_001);
      mockFetchAllNetworks.mockResolvedValueOnce([
        healthyNetworkData({ ratesError: { message: "oracle query failed" } }),
      ]);

      const [data] = await fetchInitialNetworkData();

      expect(mockFetchAllNetworks).toHaveBeenCalledTimes(1);
      // Error channel intact → client mount revalidation fires, instead of
      // the stale healthy payload masking a live outage.
      expect(data!.ratesError).toEqual({ message: "oracle query failed" });
    });
  });
});
