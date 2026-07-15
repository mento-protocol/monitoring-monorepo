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
import type { PoolSnapshotWindow } from "@/lib/types";
import { buildSnapshotWindows } from "@/lib/volume";
import {
  INITIAL_SNAPSHOT_HISTORY_DAYS,
  SECONDS_PER_DAY,
} from "@/lib/network-fetcher/constants";

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

function snapshotRow(poolId: string, timestamp: number): PoolSnapshotWindow {
  return {
    poolId,
    timestamp: String(timestamp),
    reserves0: "1000000000000000000000000",
    reserves1: "1000000000000000000000000",
    swapCount: 42,
    swapVolume0: "25000000000000000000000",
    swapVolume1: "25000000000000000000000",
  };
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
    expectTypeOf<InitialNetworkData["snapshots"]>().toEqualTypeOf<[]>();
    expectTypeOf<InitialNetworkData["snapshots7d"]>().toEqualTypeOf<[]>();
    expectTypeOf<InitialNetworkData["snapshots30d"]>().toEqualTypeOf<[]>();
    expectTypeOf<
      InitialNetworkData["uniqueLpAddresses"]
    >().toEqualTypeOf<null>();
    expectTypeOf<
      InitialNetworkData["uniqueLpAddressesOmitted"]
    >().toEqualTypeOf<true>();
    expectTypeOf<
      InitialNetworkData["snapshotsAllDailyCapped"]
    >().toEqualTypeOf<boolean>();
    expectTypeOf<
      InitialNetworkData["brokerSnapshotsAllDailyCapped"]
    >().toEqualTypeOf<boolean | undefined>();
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
    expect(parts[0]).toBe("all-networks-ssr-v2");
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

    const result = await fetchInitialNetworkData("home");

    expect(result.networks).toHaveLength(1);
    expect(result.networks[0]!.rates.get("42220:cUSD")).toBe(1.0004);
    expect(result.networks[0]!.olsPoolIds.has("0xols")).toBe(true);
    expect(result.fetchedAtMs).toBeGreaterThan(0);
    expect(cacheCallbackOutcomes).toEqual(["resolved"]);
  });

  it("serves a fresh JSON cache hit without refetching and restores Map/Set fields", async () => {
    mockFetchAllNetworks.mockResolvedValueOnce([healthyNetworkData()]);

    const first = await fetchInitialNetworkData("home");
    // Intentional sequence: the first call must populate the fake cache before
    // the second proves a serialized fresh-hit read.
    // react-doctor-disable-next-line react-doctor/server-sequential-independent-await
    const second = await fetchInitialNetworkData("home");

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

    const [data] = (await fetchInitialNetworkData("home")).networks;

    expect(data!.feeSnapshots).toEqual([]);
    expect(data!.feeSnapshotsError).toBeNull();
    expect(data!.feeSnapshotsTruncated).toBe(true);
  });

  it("ships only the configured recent UTC-day buckets and marks the initial history capped", async () => {
    const now = Date.UTC(2026, 6, 15, 12, 34, 56);
    const today = Math.floor(now / 1000 / SECONDS_PER_DAY) * SECONDS_PER_DAY;
    const fullHistory = Array.from(
      { length: INITIAL_SNAPSHOT_HISTORY_DAYS + 5 },
      (_, daysAgo) => snapshotRow("pool-a", today - daysAgo * SECONDS_PER_DAY),
    );
    const source = healthyNetworkData({
      snapshotWindows: buildSnapshotWindows(now),
      snapshotsAllDaily: fullHistory,
    });
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mockFetchAllNetworks.mockResolvedValueOnce([source]);

    const [initial] = (await fetchInitialNetworkData("home")).networks;

    expect(initial!.snapshotsAllDaily).toHaveLength(
      INITIAL_SNAPSHOT_HISTORY_DAYS + 1,
    );
    expect(initial!.snapshotsAllDaily[0]!.timestamp).toBe(String(today));
    expect(initial!.snapshotsAllDaily.at(-2)!.timestamp).toBe(
      String(today - (INITIAL_SNAPSHOT_HISTORY_DAYS - 1) * SECONDS_PER_DAY),
    );
    // One latest pre-window anchor lets TVL forward-fill quiet pools from
    // their last confirmed reserves without carrying unbounded history.
    expect(initial!.snapshotsAllDaily.at(-1)!.timestamp).toBe(
      String(today - INITIAL_SNAPSHOT_HISTORY_DAYS * SECONDS_PER_DAY),
    );
    expect(initial!.snapshotsAllDailyCapped).toBe(true);
    expect(initial!.snapshots).toEqual([]);
    expect(initial!.snapshots7d).toEqual([]);
    expect(initial!.snapshots30d).toEqual([]);
    expect(source.snapshotsAllDaily).toHaveLength(
      INITIAL_SNAPSHOT_HISTORY_DAYS + 5,
    );
  });

  it("keeps exactly the latest pre-window TVL anchor for each pool", async () => {
    const now = Date.UTC(2026, 6, 15, 12, 34, 56);
    const today = Math.floor(now / 1000 / SECONDS_PER_DAY) * SECONDS_PER_DAY;
    const cutoff =
      today - (INITIAL_SNAPSHOT_HISTORY_DAYS - 1) * SECONDS_PER_DAY;
    const source = healthyNetworkData({
      snapshotWindows: buildSnapshotWindows(now),
      snapshotsAllDaily: [
        snapshotRow("active", cutoff),
        snapshotRow("active", cutoff - SECONDS_PER_DAY),
        snapshotRow("active", cutoff - 2 * SECONDS_PER_DAY),
        snapshotRow("quiet", cutoff - 3 * SECONDS_PER_DAY),
        snapshotRow("quiet", cutoff - 9 * SECONDS_PER_DAY),
      ],
    });
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mockFetchAllNetworks.mockResolvedValueOnce([source]);

    const [initial] = (await fetchInitialNetworkData("home")).networks;

    expect(
      initial!.snapshotsAllDaily.map((row) => [row.poolId, row.timestamp]),
    ).toEqual([
      ["active", String(cutoff)],
      ["active", String(cutoff - SECONDS_PER_DAY)],
      ["quiet", String(cutoff - 3 * SECONDS_PER_DAY)],
    ]);
    expect(initial!.snapshotsAllDailyCapped).toBe(true);
  });

  it("caps homepage Broker history to the same recent UTC-day window", async () => {
    const now = Date.UTC(2026, 6, 15, 12, 34, 56);
    const today = Math.floor(now / 1000 / SECONDS_PER_DAY) * SECONDS_PER_DAY;
    const brokerHistory = Array.from(
      { length: INITIAL_SNAPSHOT_HISTORY_DAYS + 7 },
      (_, daysAgo) => ({
        id: `broker-${daysAgo}`,
        timestamp: String(today - daysAgo * SECONDS_PER_DAY),
        volumeUsdWei: "1000000000000000000",
        swapCount: daysAgo,
      }),
    );
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mockFetchAllNetworks.mockResolvedValueOnce([
      healthyNetworkData({
        snapshotWindows: buildSnapshotWindows(now),
        brokerSnapshotsAllDaily: brokerHistory,
      }),
    ]);

    const [initial] = (await fetchInitialNetworkData("home")).networks;

    expect(initial!.brokerSnapshotsAllDaily).toHaveLength(
      INITIAL_SNAPSHOT_HISTORY_DAYS,
    );
    expect(initial!.brokerSnapshotsAllDaily.at(-1)!.timestamp).toBe(
      String(today - (INITIAL_SNAPSHOT_HISTORY_DAYS - 1) * SECONDS_PER_DAY),
    );
    expect(initial!.brokerSnapshotsAllDailyCapped).toBe(true);
  });

  it("aggregates homepage LPs exactly and removes homepage-only data from /pools", async () => {
    const secondNetwork = {
      ...network,
      id: "monad-mainnet",
      label: "Monad",
      chainId: 143,
    } as Network;
    mockFetchAllNetworks.mockResolvedValueOnce([
      healthyNetworkData({
        uniqueLpAddresses: ["0xAAA", "0xbbb"],
        brokerSnapshotsAllDaily: [
          {
            id: "broker-1",
            timestamp: "86400",
            volumeUsdWei: "1",
            swapCount: 1,
          },
        ],
      }),
      healthyNetworkData({
        network: secondNetwork,
        uniqueLpAddresses: ["0xaaa", "0xCCC"],
      }),
    ]);

    const homepage = await fetchInitialNetworkData("home");
    // Reads the same JSON-cached projection: route selection must not refetch.
    // This must remain sequential so the assertion proves a completed cache hit.
    // react-doctor-disable-next-line react-doctor/server-sequential-independent-await
    const pools = await fetchInitialNetworkData("pools");

    expect(mockFetchAllNetworks).toHaveBeenCalledTimes(1);
    expect(homepage.uniqueLpCount).toBe(3);
    expect(
      homepage.networks.every((data) => data.uniqueLpAddresses === null),
    ).toBe(true);
    expect(
      homepage.networks.every((data) => data.uniqueLpAddressesOmitted === true),
    ).toBe(true);
    expect(pools).not.toHaveProperty("uniqueLpCount");
    expect(
      pools.networks.every(
        (data) =>
          data.uniqueLpAddresses === null &&
          data.brokerSnapshotsAllDaily.length === 0,
      ),
    ).toBe(true);
    expect(pools.networks[0]!.brokerSnapshotsAllDailyCapped).toBe(true);
  });

  it("keeps every history-growing field in a representative payload below 500KB", async () => {
    const now = Date.UTC(2026, 6, 15, 12);
    const today = Math.floor(now / 1000 / SECONDS_PER_DAY) * SECONDS_PER_DAY;
    const poolCountPerNetwork = 20;
    const historyFor = (chainId: number) =>
      Array.from({ length: poolCountPerNetwork * 730 }, (_, index) =>
        snapshotRow(
          `${chainId}-0x${String(index % poolCountPerNetwork).padStart(40, "0")}`,
          today - Math.floor(index / poolCountPerNetwork) * SECONDS_PER_DAY,
        ),
      );
    const poolsFor = (chainId: number) =>
      Array.from({ length: poolCountPerNetwork }, (_, index) => ({
        id: `${chainId}-0x${String(index).padStart(40, "0")}`,
        chainId,
        token0: null,
        token1: null,
        source: "FPMM" as const,
        createdAtBlock: "0",
        createdAtTimestamp: "0",
        updatedAtBlock: "0",
        updatedAtTimestamp: "0",
      }));
    const brokerHistory = Array.from({ length: 730 }, (_, daysAgo) => ({
      id: `broker-${daysAgo}`,
      timestamp: String(today - daysAgo * SECONDS_PER_DAY),
      volumeUsdWei: "1000000000000000000",
      swapCount: daysAgo,
    }));
    const uniqueLpAddresses = Array.from(
      { length: 10_000 },
      (_, index) => `0x${String(index).padStart(40, "0")}`,
    );
    const source = healthyNetworkData({
      pools: poolsFor(network.chainId),
      snapshotWindows: buildSnapshotWindows(now),
      snapshotsAllDaily: historyFor(network.chainId),
      brokerSnapshotsAllDaily: brokerHistory,
      uniqueLpAddresses,
    });
    const secondNetwork = {
      ...network,
      id: "monad-mainnet",
      label: "Monad",
      chainId: 143,
    } as Network;
    const secondSource = healthyNetworkData({
      network: secondNetwork,
      pools: poolsFor(secondNetwork.chainId),
      snapshotWindows: buildSnapshotWindows(now),
      snapshotsAllDaily: historyFor(secondNetwork.chainId),
      uniqueLpAddresses: Array.from(
        { length: 10_000 },
        (_, index) => `0x${String(index + 5_000).padStart(40, "0")}`,
      ),
    });
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mockFetchAllNetworks.mockResolvedValueOnce([source, secondSource]);

    const result = await fetchInitialNetworkData("home");
    const fullBytes = Buffer.byteLength(
      JSON.stringify([source, secondSource].map(dehydrateNetworkData)),
    );
    // Measure the explicit JSON-safe representation rather than stringifying
    // rehydrated Maps/Sets (which would turn them into `{}` and undercount the
    // Data Cache / Flight transport).
    const projectedBytes = Buffer.byteLength(
      JSON.stringify({
        ...result,
        networks: result.networks.map(dehydrateNetworkData),
      }),
    );

    expect(fullBytes).toBeGreaterThan(500_000);
    expect(projectedBytes).toBeLessThan(500_000);
    expect(
      result.networks.every(
        (initial) =>
          initial.snapshotsAllDaily.length ===
          poolCountPerNetwork * (INITIAL_SNAPSHOT_HISTORY_DAYS + 1),
      ),
    ).toBe(true);
    expect(result.networks[0]!.brokerSnapshotsAllDaily).toHaveLength(
      INITIAL_SNAPSHOT_HISTORY_DAYS,
    );
    expect(
      result.networks.every((initial) => initial.uniqueLpAddresses === null),
    ).toBe(true);
    expect(result.networks.flatMap((initial) => initial.pools)).toHaveLength(
      40,
    );
    expect(result.uniqueLpCount).toBe(15_000);
  });

  it("still returns a degraded payload but never caches it", async () => {
    mockFetchAllNetworks.mockResolvedValueOnce([
      healthyNetworkData({ ratesError: { message: "oracle query failed" } }),
    ]);

    const { networks, fetchedAtMs } = await fetchInitialNetworkData("home");

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

    const result = await fetchInitialNetworkData("home");

    expect(result.networks).toEqual([]);
    expect(cacheCallbackOutcomes).toEqual(["threw"]);
  });

  it("rethrows unexpected errors from the fetch", async () => {
    mockFetchAllNetworks.mockRejectedValueOnce(new Error("boom"));

    await expect(fetchInitialNetworkData("home")).rejects.toThrow("boom");
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
        uniqueLpCount: 0,
      };
    }

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
    });

    it("serves a cached payload younger than the bound while refreshing in the background", async () => {
      armStaleCacheEntry(staleEntry(MAX_SERVED_STALENESS_MS - 1_000));
      mockFetchAllNetworks.mockResolvedValueOnce([healthyNetworkData()]);

      const result = await fetchInitialNetworkData("home");
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

      const result = await fetchInitialNetworkData("home");
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

      const result = await fetchInitialNetworkData("home");

      expect(mockFetchAllNetworks).toHaveBeenCalledTimes(1);
      expect(result.networks[0]!.rates.get("42220:cUSD")).toBe(1.0004);
    });

    it("surfaces a fresh degraded payload past the staleness bound instead of the stale healthy one", async () => {
      armStaleCacheEntry(staleEntry(MAX_SERVED_STALENESS_MS + 1));
      mockFetchAllNetworks.mockResolvedValueOnce([
        healthyNetworkData({ ratesError: { message: "oracle query failed" } }),
      ]);

      const [data] = (await fetchInitialNetworkData("home")).networks;

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
        fetchInitialNetworkData("home"),
        fetchInitialNetworkData("home"),
      ]);

      expect(mockFetchAllNetworks).toHaveBeenCalledTimes(1);
      expect(first.networks[0]!.rates.get("42220:cUSD")).toBe(1.0004);
      expect(second.networks[0]!.rates.get("42220:cUSD")).toBe(1.0004);
    });
  });
});
