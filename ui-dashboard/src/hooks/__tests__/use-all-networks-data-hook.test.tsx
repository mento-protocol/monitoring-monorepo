import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { InitialNetworkData, NetworkData } from "@/lib/fetch-all-networks";
import type { Network } from "@/lib/networks";
import type { Pool } from "@/lib/types";

const harness = vi.hoisted(() => ({
  fetchAllNetworks: vi.fn<() => Promise<NetworkData[]>>(),
  fetcher: undefined as (() => Promise<NetworkData[]>) | undefined,
}));

vi.mock("@/lib/fetch-all-networks", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/fetch-all-networks")>();
  return {
    ...actual,
    fetchAllNetworks: harness.fetchAllNetworks,
    seedIncrementalRowCacheFromNetworkData: vi.fn(),
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
    _key: string,
    fetcher: () => Promise<NetworkData[]>,
    config: { fallbackData?: NetworkData[] },
  ) => {
    harness.fetcher = fetcher;
    return {
      data: config.fallbackData,
      error: undefined,
      isLoading: false,
    };
  },
  useSWRConfig: () => ({ cache: { get: () => undefined } }),
}));

import { useAllNetworksData } from "../use-all-networks-data";

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

function networkData(pool: Pool): InitialNetworkData {
  return {
    network: NETWORK,
    pools: [pool],
    feeSnapshots: [],
    liveHealthError: null,
  } as InitialNetworkData;
}

function Probe({ fallback }: { fallback: InitialNetworkData[] }) {
  useAllNetworksData(fallback, 0);
  return null;
}

describe("useAllNetworksData cold-cache reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.fetcher = undefined;
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
});
