import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";
import type { Network } from "@/lib/networks";
import type {
  InitialNetworkData,
  NetworkData,
} from "@/lib/network-fetcher/types";

const {
  mockFetchAllNetworks,
  cacheCallbackOutcomes,
  cacheState,
  capturedCacheKeyParts,
} = vi.hoisted(() => ({
  mockFetchAllNetworks: vi.fn(),
  /** Records whether each unstable_cache callback invocation resolved
   *  (cacheable) or threw (never written to the cache). */
  cacheCallbackOutcomes: [] as ("resolved" | "threw")[],
  /** Stateful JSON store for the `unstable_cache` fake. Fresh hits return a
   *  JSON-parsed copy without invoking the callback. Stale hits return the
   *  same copy immediately while revalidating in the background. */
  cacheState: {
    value: undefined as unknown,
    stale: false,
    backgroundRevalidations: [] as Promise<void>[],
  },
  /** Key parts passed to unstable_cache at module init — asserted so the
   *  deploy/config salt can't silently disappear. */
  capturedCacheKeyParts: [] as string[][],
}));

// next/cache needs the Next.js incremental-cache runtime; outside it the repo
// convention is an identity wrapper (see pool-detail-ssr.test.ts). This one
// additionally uses a stateful JSON store so tests exercise the same
// serialize-on-write / parse-on-hit boundary as Vercel's Data Cache. Armed
// stale entries are served immediately while the callback revalidates in the
// background; background errors are swallowed and leave the stale value in
// place, matching `unstable_cache`'s stale-while-revalidate behavior.
vi.mock("next/cache", () => ({
  unstable_cache: <TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => Promise<TResult>,
    keyParts?: string[],
  ) => {
    if (keyParts) capturedCacheKeyParts.push(keyParts);

    const jsonRoundTrip = <T>(value: T): T =>
      JSON.parse(JSON.stringify(value)) as T;
    const invoke = async (args: TArgs): Promise<TResult> => {
      try {
        const result = await fn(...args);
        cacheCallbackOutcomes.push("resolved");
        return result;
      } catch (err) {
        cacheCallbackOutcomes.push("threw");
        throw err;
      }
    };

    return async (...args: TArgs): Promise<TResult> => {
      if (cacheState.value !== undefined) {
        const cached = jsonRoundTrip(cacheState.value) as TResult;
        if (cacheState.stale) {
          const revalidation = invoke(args)
            .then((result) => {
              cacheState.value = jsonRoundTrip(result);
              cacheState.stale = false;
            })
            .catch(() => undefined);
          cacheState.backgroundRevalidations.push(revalidation);
        }
        return cached;
      }

      const result = await invoke(args);
      cacheState.value = jsonRoundTrip(result);
      return result;
    };
  },
}));

vi.mock("@/lib/network-fetcher/fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/network-fetcher/fetch")>()),
  fetchAllNetworks: mockFetchAllNetworks,
}));

import {
  dehydrateNetworkData,
  fetchInitialNetworkData,
  MAX_SERVED_STALENESS_MS,
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

function armStaleCacheEntry(value: unknown): void {
  cacheState.value = value;
  cacheState.stale = true;
}

beforeEach(() => {
  mockFetchAllNetworks.mockReset();
  cacheCallbackOutcomes.length = 0;
  cacheState.value = undefined;
  cacheState.stale = false;
  cacheState.backgroundRevalidations.length = 0;
});

afterEach(async () => {
  await Promise.all(cacheState.backgroundRevalidations);
  vi.useRealTimers();
});

describe("InitialNetworkData type contract", () => {
  it("exposes feeSnapshots as an empty tuple with no readable row type", () => {
    expectTypeOf<
      Awaited<ReturnType<typeof fetchInitialNetworkData>>["networks"][number]
    >().toEqualTypeOf<InitialNetworkData>();
    expectTypeOf<InitialNetworkData["feeSnapshots"]>().toEqualTypeOf<[]>();
    expectTypeOf<
      InitialNetworkData["feeSnapshots"][number]
    >().toEqualTypeOf<never>();
  });
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

describe("cache key salting", () => {
  it("salts the unstable_cache key with a deploy marker and the configured network ids", () => {
    // Captured at module init by the next/cache mock. A deploy that changes
    // the configured network set or ships new payload-shape code must never
    // hit an entry written by older code — Vercel's Data Cache persists
    // across deployments within an environment.
    expect(capturedCacheKeyParts).toHaveLength(1);
    const parts = capturedCacheKeyParts[0]!;
    expect(parts[0]).toBe("all-networks-ssr");
    // Deploy salt: VERCEL_GIT_COMMIT_SHA in prod, "dev" locally/in tests.
    expect(parts[1]).toBeTruthy();
    // Config salt: pipe-joined configured network ids (may be "" when no
    // network env is configured in the test environment — the join itself
    // must still be present as a distinct key part).
    expect(parts).toHaveLength(3);
  });
});

describe("fetchInitialNetworkData", () => {
  it("returns the rehydrated healthy payload and marks it cacheable", async () => {
    mockFetchAllNetworks.mockResolvedValueOnce([healthyNetworkData()]);

    const result = await fetchInitialNetworkData();

    expect(result.networks).toHaveLength(1);
    expect(result.networks[0]!.rates.get("42220:cUSD")).toBe(1.0004);
    expect(result.networks[0]!.olsPoolIds.has("0xols")).toBe(true);
    expect(result.fetchedAtMs).toBeGreaterThan(0);
    expect(cacheCallbackOutcomes).toEqual(["resolved"]);
  });

  it("serves a fresh JSON cache hit without refetching and restores Map/Set fields", async () => {
    mockFetchAllNetworks.mockResolvedValueOnce([healthyNetworkData()]);

    const first = await fetchInitialNetworkData();
    // Intentional sequence: the first call must populate the fake cache before
    // the second proves a serialized fresh-hit read.
    // react-doctor-disable-next-line react-doctor/server-sequential-independent-await
    const second = await fetchInitialNetworkData();

    expect(mockFetchAllNetworks).toHaveBeenCalledTimes(1);
    expect(cacheCallbackOutcomes).toEqual(["resolved"]);
    expect(second).not.toBe(first);
    expect(second.networks[0]!.rates).toEqual(
      new Map([["42220:cUSD", 1.0004]]),
    );
    expect(second.networks[0]!.poolLabels.get("0xabc")).toMatchObject({
      id: "0xabc",
    });
    expect(second.networks[0]!.olsPoolIds).toEqual(new Set(["0xols"]));
    expect(second.networks[0]!.cdpPoolIds).toEqual(new Set(["0xcdp"]));
    expect(second.networks[0]!.reservePoolIds).toEqual(new Set(["0xres"]));
    expect(second.networks[0]!.feeSnapshots).toEqual([]);
  });

  it("strips raw feeSnapshots rows but keeps the fee outcome fields", async () => {
    mockFetchAllNetworks.mockResolvedValueOnce([
      healthyNetworkData({ feeSnapshotsTruncated: true }),
    ]);

    const [data] = (await fetchInitialNetworkData()).networks;

    expect(data!.feeSnapshots).toEqual([]);
    expect(data!.feeSnapshotsError).toBeNull();
    expect(data!.feeSnapshotsTruncated).toBe(true);
  });

  it("still returns a degraded payload but never caches it", async () => {
    mockFetchAllNetworks.mockResolvedValueOnce([
      healthyNetworkData({ ratesError: { message: "oracle query failed" } }),
    ]);

    const { networks, fetchedAtMs } = await fetchInitialNetworkData();

    expect(networks[0]!.ratesError).toEqual({ message: "oracle query failed" });
    expect(networks[0]!.rates.get("42220:cUSD")).toBe(1.0004);
    // Degraded payloads are fetched in-band, so they report as fresh —
    // the client freshness gate must not re-fetch a just-fetched payload
    // for staleness reasons (the degraded path already revalidates).
    expect(fetchedAtMs).toBeGreaterThan(0);
    expect(cacheCallbackOutcomes).toEqual(["threw"]);
  });

  it("treats an empty payload as degraded instead of pinning it", async () => {
    mockFetchAllNetworks.mockResolvedValueOnce([]);

    const result = await fetchInitialNetworkData();

    expect(result.networks).toEqual([]);
    expect(cacheCallbackOutcomes).toEqual(["threw"]);
  });

  it("rethrows unexpected errors from the fetch", async () => {
    mockFetchAllNetworks.mockRejectedValueOnce(new Error("boom"));

    await expect(fetchInitialNetworkData()).rejects.toThrow("boom");
  });

  // Stale-hit path: `unstable_cache` serves stale entries and swallows
  // background-revalidation errors, so only the fetchedAt age gate bounds
  // what the server will serve (MAX_SERVED_STALENESS_MS); staleness within
  // that bound is handled client-side by the hook's freshness gate.
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

    it("serves a cached payload younger than the bound while refreshing in the background", async () => {
      armStaleCacheEntry(staleEntry(MAX_SERVED_STALENESS_MS - 1_000));
      mockFetchAllNetworks.mockResolvedValueOnce([healthyNetworkData()]);

      const result = await fetchInitialNetworkData();
      await Promise.all(cacheState.backgroundRevalidations);

      expect(mockFetchAllNetworks).toHaveBeenCalledTimes(1);
      expect(cacheCallbackOutcomes).toEqual(["resolved"]);
      expect(result.networks).toHaveLength(1);
      expect(result.networks[0]!.rates.get("42220:cUSD")).toBe(1.0004);
      // The served entry's real fetch time crosses to the client so the
      // hook's freshness gate can decide to revalidate on mount.
      expect(result.fetchedAtMs).toBe(NOW - (MAX_SERVED_STALENESS_MS - 1_000));
    });

    it("keeps the stale value when background revalidation rejects a degraded payload", async () => {
      armStaleCacheEntry(staleEntry(MAX_SERVED_STALENESS_MS - 1_000));
      mockFetchAllNetworks.mockResolvedValueOnce([
        healthyNetworkData({ ratesError: { message: "oracle query failed" } }),
      ]);

      const result = await fetchInitialNetworkData();
      await Promise.all(cacheState.backgroundRevalidations);

      expect(mockFetchAllNetworks).toHaveBeenCalledTimes(1);
      expect(cacheCallbackOutcomes).toEqual(["threw"]);
      expect(cacheState.stale).toBe(true);
      expect(result.networks[0]!.ratesError).toBeNull();
      expect(result.networks[0]!.rates.get("42220:cUSD")).toBe(1.0004);
    });

    it("foreground-refetches a cached payload older than the staleness bound", async () => {
      // Distinguishable stale rate — the assertion below proves the fresh
      // payload wins, not the pinned cache entry.
      armStaleCacheEntry(
        staleEntry(MAX_SERVED_STALENESS_MS + 1, {
          rates: new Map([["42220:cUSD", 999]]),
        }),
      );
      mockFetchAllNetworks.mockResolvedValueOnce([healthyNetworkData()]);

      const result = await fetchInitialNetworkData();

      expect(mockFetchAllNetworks).toHaveBeenCalledTimes(1);
      expect(result.networks[0]!.rates.get("42220:cUSD")).toBe(1.0004);
    });

    it("surfaces a fresh degraded payload past the staleness bound instead of the stale healthy one", async () => {
      armStaleCacheEntry(staleEntry(MAX_SERVED_STALENESS_MS + 1));
      mockFetchAllNetworks.mockResolvedValueOnce([
        healthyNetworkData({ ratesError: { message: "oracle query failed" } }),
      ]);

      const [data] = (await fetchInitialNetworkData()).networks;

      expect(mockFetchAllNetworks).toHaveBeenCalledTimes(1);
      // Error channel intact → client mount revalidation fires, instead of
      // the stale healthy payload masking a live outage.
      expect(data!.ratesError).toEqual({ message: "oracle query failed" });
    });

    it("coalesces concurrent over-age refetches into one upstream fan-out", async () => {
      armStaleCacheEntry(
        staleEntry(MAX_SERVED_STALENESS_MS + 1, {
          rates: new Map([["42220:cUSD", 999]]),
        }),
      );
      mockFetchAllNetworks.mockResolvedValueOnce([healthyNetworkData()]);

      const [first, second] = await Promise.all([
        fetchInitialNetworkData(),
        fetchInitialNetworkData(),
      ]);

      expect(mockFetchAllNetworks).toHaveBeenCalledTimes(1);
      expect(first.networks[0]!.rates.get("42220:cUSD")).toBe(1.0004);
      expect(second.networks[0]!.rates.get("42220:cUSD")).toBe(1.0004);
    });
  });
});
