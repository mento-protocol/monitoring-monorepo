import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { InitialNetworkData, NetworkData } from "@/lib/fetch-all-networks";
import type { Network } from "@/lib/networks";
import type { Pool, PoolSnapshotWindow } from "@/lib/types";
import {
  SWR_KEY_ALL_NETWORKS_DATA,
  SWR_KEY_POOLS_NETWORKS_DATA,
} from "@/lib/swr-keys";

const harness = vi.hoisted(() => ({
  fetchAllNetworks: vi.fn<() => Promise<NetworkData[]>>(),
  fetcher: undefined as (() => Promise<NetworkData[]>) | undefined,
  fetchers: [] as (() => Promise<NetworkData[]>)[],
  cacheKeys: [] as string[],
  mutateRequest: undefined as Promise<NetworkData[]> | undefined,
  seedIncrementalRowCacheFromNetworkData: vi.fn(),
}));

vi.mock("@/lib/fetch-all-networks", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/fetch-all-networks")>();
  return {
    ...actual,
    fetchAllNetworks: harness.fetchAllNetworks,
    seedIncrementalRowCacheFromNetworkData:
      harness.seedIncrementalRowCacheFromNetworkData,
  };
});

vi.mock("@/hooks/use-live-pool-health", () => ({
  useLivePoolHealth: (networkData: NetworkData[]) => ({
    networkData,
    error: null,
  }),
}));

vi.mock("swr", () => ({
  default: (
    key: string,
    fetcher: () => Promise<NetworkData[]>,
    config: { fallbackData?: NetworkData[] },
  ) => {
    harness.cacheKeys.push(key);
    harness.fetcher = fetcher;
    harness.fetchers.push(fetcher);
    return {
      data: config.fallbackData,
      error: undefined,
      isLoading: false,
      mutate: () => {
        const request = fetcher();
        harness.mutateRequest = request;
        return request;
      },
    };
  },
  useSWRConfig: () => ({ cache: { get: () => undefined } }),
}));

import {
  useAllNetworksData,
  type AllNetworksDataCacheScope,
} from "../use-all-networks-data";

const NETWORK = {
  id: "celo-mainnet",
  label: "Celo",
  chainId: 42220,
} as Network;

const ACTIVE_VP = {
  id: "42220-0xactive",
  chainId: 42220,
  token0: "0xtoken0",
  token1: "0xtoken1",
  source: "virtual_pool_factory",
  wrappedExchangeId: "0xexchange",
  wrappedExchangeMinimumReports: "2",
  createdAtBlock: "1",
  createdAtTimestamp: "1000",
  updatedAtBlock: "2",
  updatedAtTimestamp: "2000",
} satisfies Pool;

const TODAY_MIDNIGHT = 1_700_006_400;
const SECONDS_PER_DAY = 86_400;

function dailySnapshot(daysAgo: number): PoolSnapshotWindow {
  return {
    poolId: ACTIVE_VP.id,
    timestamp: String(TODAY_MIDNIGHT - daysAgo * SECONDS_PER_DAY),
    reserves0: "1",
    reserves1: "1",
    swapCount: daysAgo + 1,
    swapVolume0: "1",
    swapVolume1: "1",
  };
}

const DAILY_HISTORY = [0, 6, 7, 29, 30].map(dailySnapshot);

function networkData(
  pool: Pool,
  snapshotsAllDailyCapped = true,
): InitialNetworkData {
  return {
    network: NETWORK,
    pools: [pool],
    snapshotWindows: {
      w24h: { from: TODAY_MIDNIGHT - SECONDS_PER_DAY, to: TODAY_MIDNIGHT },
      w7d: { from: TODAY_MIDNIGHT - 7 * SECONDS_PER_DAY, to: TODAY_MIDNIGHT },
      w30d: {
        from: TODAY_MIDNIGHT - 30 * SECONDS_PER_DAY,
        to: TODAY_MIDNIGHT,
      },
    },
    snapshots: [],
    snapshots7d: [],
    snapshots30d: [],
    snapshotsAllDaily: DAILY_HISTORY,
    snapshotsAllDailyCapped,
    feeSnapshots: [],
    liveHealthError: null,
  } as InitialNetworkData;
}

let latestResult: ReturnType<typeof useAllNetworksData> | undefined;

function Probe({
  fallback,
  cacheScope = "home",
}: {
  fallback: InitialNetworkData[];
  cacheScope?: AllNetworksDataCacheScope;
}) {
  latestResult = useAllNetworksData(fallback, 0, cacheScope);
  return null;
}

describe("useAllNetworksData cold-cache reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.fetcher = undefined;
    harness.fetchers.length = 0;
    harness.cacheKeys.length = 0;
    harness.mutateRequest = undefined;
    latestResult = undefined;
  });

  it("isolates the intentionally stripped /pools fallback under its own SWR key", () => {
    const fallback = [networkData(ACTIVE_VP)];

    renderToStaticMarkup(<Probe fallback={fallback} />);
    renderToStaticMarkup(<Probe fallback={fallback} cacheScope="pools" />);

    expect(harness.cacheKeys).toEqual([
      SWR_KEY_ALL_NETWORKS_DATA,
      SWR_KEY_POOLS_NETWORKS_DATA,
    ]);
    expect(SWR_KEY_POOLS_NETWORKS_DATA).not.toBe(SWR_KEY_ALL_NETWORKS_DATA);
  });

  it("retains the SSR VirtualPool extension on the first client refresh", async () => {
    const fallback = [networkData(ACTIVE_VP)];
    harness.fetchAllNetworks.mockResolvedValue([
      networkData({
        ...ACTIVE_VP,
        wrappedExchangeMinimumReports: undefined,
      }),
    ]);
    renderToStaticMarkup(<Probe fallback={fallback} />);

    const refreshed = await harness.fetcher!();

    expect(refreshed[0]?.pools[0]?.wrappedExchangeMinimumReports).toBe("2");
    expect(refreshed[0]?.liveHealthError?.message).toContain(
      "did not reconfirm 1 VirtualPool extension",
    );
  });

  it("restores omitted daily windows before consumers and cache seeding", () => {
    const fallback = [networkData(ACTIVE_VP)];

    renderToStaticMarkup(<Probe fallback={fallback} />);

    const restored = latestResult!.networkData[0]!;
    expect(restored.snapshots.map((row) => row.timestamp)).toEqual([
      String(TODAY_MIDNIGHT),
    ]);
    expect(restored.snapshots7d.map((row) => row.timestamp)).toEqual(
      [0, 6].map((daysAgo) =>
        String(TODAY_MIDNIGHT - daysAgo * SECONDS_PER_DAY),
      ),
    );
    expect(restored.snapshots30d.map((row) => row.timestamp)).toEqual(
      [0, 6, 7, 29].map((daysAgo) =>
        String(TODAY_MIDNIGHT - daysAgo * SECONDS_PER_DAY),
      ),
    );
    expect(harness.seedIncrementalRowCacheFromNetworkData).toHaveBeenCalledWith(
      [restored],
    );
    // The transport object is immutable: it still carries the explicit empty
    // tuples, proving restoration did not re-inflate the Flight prop itself.
    expect(fallback[0]!.snapshots).toEqual([]);
    expect(fallback[0]!.snapshots7d).toEqual([]);
    expect(fallback[0]!.snapshots30d).toEqual([]);
  });

  it("coalesces repeated full-history requests while the capped seed refresh is in flight", async () => {
    const fallback = [networkData(ACTIVE_VP)];
    let resolveFetch!: (value: NetworkData[]) => void;
    harness.fetchAllNetworks.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    renderToStaticMarkup(<Probe fallback={fallback} />);

    const first = latestResult!.requestFullSnapshotHistory();
    const second = latestResult!.requestFullSnapshotHistory();

    expect(second).toBe(first);
    expect(harness.fetchAllNetworks).toHaveBeenCalledTimes(1);
    resolveFetch([networkData(ACTIVE_VP, false) as NetworkData]);
    await Promise.all([first, second]);
  });

  it("starts an All request without Promise.finally support", () => {
    const fallback = [networkData(ACTIVE_VP)];
    harness.fetchAllNetworks.mockResolvedValueOnce([
      networkData(ACTIVE_VP, false) as NetworkData,
    ]);
    renderToStaticMarkup(<Probe fallback={fallback} />);

    const finallyDescriptor = Object.getOwnPropertyDescriptor(
      Promise.prototype,
      "finally",
    )!;
    Object.defineProperty(Promise.prototype, "finally", {
      ...finallyDescriptor,
      value: undefined,
    });

    try {
      expect(() => latestResult!.requestFullSnapshotHistory()).not.toThrow();
      expect(harness.fetchAllNetworks).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(Promise.prototype, "finally", finallyDescriptor);
    }
  });

  it("joins a user-triggered All request to mount revalidation at the fetch boundary", async () => {
    const fallback = [networkData(ACTIVE_VP)];
    let resolveFetch!: (value: NetworkData[]) => void;
    harness.fetchAllNetworks.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    renderToStaticMarkup(<Probe fallback={fallback} />);

    // Model SWR starting a mount revalidation before the chart asks for All.
    const mountRequest = harness.fetcher!();
    const allRequest = latestResult!.requestFullSnapshotHistory();

    expect(harness.fetchAllNetworks).toHaveBeenCalledTimes(1);
    expect(harness.mutateRequest).toBe(mountRequest);

    const completed = networkData(ACTIVE_VP, false) as NetworkData;
    resolveFetch([completed]);
    const [mountResult] = await Promise.all([mountRequest, allRequest]);

    expect(mountResult).toEqual([completed]);
  });

  it("shares one raw fan-out across hook instances but reconciles each caller's fallback", async () => {
    const firstFallback = [networkData(ACTIVE_VP)];
    const secondFallback = [
      networkData({
        ...ACTIVE_VP,
        wrappedExchangeMinimumReports: "3",
      }),
    ];
    let resolveFetch!: (value: NetworkData[]) => void;
    harness.fetchAllNetworks.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    renderToStaticMarkup(<Probe fallback={firstFallback} />);
    const firstInstanceFetcher = harness.fetchers[0]!;
    renderToStaticMarkup(<Probe fallback={secondFallback} />);

    const firstMountRequest = firstInstanceFetcher();
    const secondAllRequest = latestResult!.requestFullSnapshotHistory();

    expect(harness.fetchAllNetworks).toHaveBeenCalledTimes(1);
    resolveFetch([
      networkData({
        ...ACTIVE_VP,
        wrappedExchangeMinimumReports: undefined,
      }) as NetworkData,
    ]);
    const [firstResult, secondResult] = await Promise.all([
      firstMountRequest,
      harness.mutateRequest!,
      secondAllRequest,
    ]);

    expect(firstResult[0]?.pools[0]?.wrappedExchangeMinimumReports).toBe("2");
    expect(secondResult[0]?.pools[0]?.wrappedExchangeMinimumReports).toBe("3");
  });

  it("does not refetch when the visible snapshot history is already complete", async () => {
    renderToStaticMarkup(<Probe fallback={[networkData(ACTIVE_VP, false)]} />);

    await latestResult!.requestFullSnapshotHistory();

    expect(harness.fetchAllNetworks).not.toHaveBeenCalled();
  });

  it("treats bounded Broker rows as incomplete even when v3 history is complete", async () => {
    const fallback = {
      ...networkData(ACTIVE_VP, false),
      brokerSnapshotsAllDailyCapped: true,
    } satisfies InitialNetworkData;
    harness.fetchAllNetworks.mockResolvedValueOnce([
      {
        ...fallback,
        brokerSnapshotsAllDailyCapped: false,
      } as NetworkData,
    ]);
    renderToStaticMarkup(<Probe fallback={[fallback]} />);

    await latestResult!.requestFullSnapshotHistory();

    expect(latestResult!.isSnapshotHistoryCapped).toBe(true);
    expect(latestResult!.isPoolSnapshotHistoryCapped).toBe(false);
    expect(latestResult!.poolSnapshotHistoryError).toBeNull();
    expect(harness.fetchAllNetworks).toHaveBeenCalledTimes(1);
  });

  it("isolates a Broker-only completion failure from the TVL error channel", () => {
    const fallback = {
      ...networkData(ACTIVE_VP, false),
      brokerSnapshotsAllDailyCapped: true,
      brokerSnapshotsAllDailyTruncated: true,
    } satisfies InitialNetworkData;

    renderToStaticMarkup(<Probe fallback={[fallback]} />);

    expect(latestResult!.isSnapshotHistoryCapped).toBe(true);
    expect(latestResult!.snapshotHistoryError?.message).toBe(
      "Full Broker history pagination was truncated",
    );
    expect(latestResult!.isPoolSnapshotHistoryCapped).toBe(false);
    expect(latestResult!.poolSnapshotHistoryError).toBeNull();
  });

  it("retains bounded Broker rows when completion fails before page one", async () => {
    const recentBrokerRow = {
      id: "broker-recent",
      timestamp: String(TODAY_MIDNIGHT),
      volumeUsdWei: "1000000000000000000",
      swapCount: 1,
    };
    const fallback = {
      ...networkData(ACTIVE_VP, false),
      brokerSnapshotsAllDaily: [recentBrokerRow],
      brokerSnapshotsAllDailyCapped: true,
    } satisfies InitialNetworkData;
    harness.fetchAllNetworks.mockResolvedValueOnce([
      {
        ...fallback,
        brokerSnapshotsAllDaily: [],
        brokerSnapshotsAllDailyCapped: true,
        brokerSnapshotsAllDailyError: { message: "Broker unavailable" },
      } as NetworkData,
    ]);
    renderToStaticMarkup(<Probe fallback={[fallback]} />);

    const refreshed = await harness.fetcher!();

    expect(refreshed[0]!.brokerSnapshotsAllDaily).toEqual([recentBrokerRow]);
    expect(refreshed[0]!.brokerSnapshotsAllDailyCapped).toBe(true);
    expect(refreshed[0]!.brokerSnapshotsAllDailyError?.message).toBe(
      "Broker unavailable",
    );
  });

  it("surfaces a failed completion while keeping the bounded history marked incomplete", () => {
    const failedFallback = {
      ...networkData(ACTIVE_VP),
      snapshotsAllDailyError: { message: "full history timeout" },
      snapshotsAllDailyTruncated: true,
    } satisfies InitialNetworkData;

    renderToStaticMarkup(<Probe fallback={[failedFallback]} />);

    expect(latestResult!.isSnapshotHistoryCapped).toBe(true);
    expect(latestResult!.snapshotHistoryError?.message).toBe(
      "full history timeout",
    );
  });
});
