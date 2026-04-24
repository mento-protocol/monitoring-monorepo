import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SWRResponse } from "swr";
import type { Network } from "@/lib/networks";
import type { GlobalPoolEntry } from "@/components/global-pools-table";

const mockReplace = vi.fn();
let mockSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
  useRouter: () => ({ replace: mockReplace }),
  usePathname: () => "/pools",
}));

vi.mock("@/components/network-provider", () => ({
  useNetwork: () => ({
    network: {
      id: "celo-mainnet",
      label: "Celo",
      chainId: 42220,
      hasuraUrl: "https://example.com/graphql",
      hasuraSecret: "",
      explorerBaseUrl: "https://celoscan.io",
      tokenSymbols: {},
      addressLabels: {},
      contractsNamespace: null,
      local: false,
      hasVirtualPools: false,
      testnet: false,
    },
    networkId: "celo-mainnet",
  }),
}));

vi.mock("@/lib/graphql", () => ({
  useGQL: vi.fn(),
}));

vi.mock("@/hooks/use-all-networks-data", () => ({
  useAllNetworksData: vi.fn(),
}));

vi.mock("@/components/global-pools-table", () => ({
  GlobalPoolsTable: ({
    entries,
    olsPoolKeys,
    volume24hByKey,
    volume7dByKey,
    tvlChangeWoWByKey,
  }: {
    entries: GlobalPoolEntry[];
    olsPoolKeys?: Set<string>;
    volume24hByKey?: Map<string, number | null | undefined>;
    volume7dByKey?: Map<string, number | null | undefined>;
    tvlChangeWoWByKey?: Map<string, number | null>;
  }) => (
    <div data-testid="global-pools-table">
      <span data-testid="entries-count">{entries.length}</span>
      <span data-testid="chains">
        {[...new Set(entries.map((e) => e.network.id))].join(",")}
      </span>
      <span data-testid="ols">
        {olsPoolKeys ? Array.from(olsPoolKeys).join(",") : ""}
      </span>
      <span data-testid="vol24h-keys">
        {volume24hByKey ? Array.from(volume24hByKey.keys()).join(",") : ""}
      </span>
      <span data-testid="vol7d-keys">
        {volume7dByKey ? Array.from(volume7dByKey.keys()).join(",") : ""}
      </span>
      <span data-testid="wow-keys">
        {tvlChangeWoWByKey
          ? Array.from(tvlChangeWoWByKey.keys()).join(",")
          : ""}
      </span>
    </div>
  ),
  globalPoolKey: ({ network, pool }: GlobalPoolEntry) =>
    `${network.id}:${pool.id}`,
}));

import { useGQL } from "@/lib/graphql";
import { useAllNetworksData } from "@/hooks/use-all-networks-data";
import PoolsPage from "../page";

function makeNetwork(id: string, chainId: number, label = id): Network {
  return {
    id: id as Network["id"],
    label,
    chainId,
    hasuraUrl: `https://${id}.example.com`,
    hasuraSecret: "",
    explorerBaseUrl: "https://example.com",
    tokenSymbols: {},
    addressLabels: {},
    contractsNamespace: null,
    local: false,
    hasVirtualPools: false,
    testnet: false,
  };
}

const celoNet = makeNetwork("celo-mainnet", 42220, "Celo");
const monadNet = makeNetwork("monad-mainnet", 143, "Monad");

const celoPool = {
  id: "42220-0xpool-celo",
  chainId: 42220,
  token0: "0x1",
  token1: "0x2",
  source: "fpmm_factory",
  createdAtBlock: "1",
  createdAtTimestamp: "1",
  updatedAtBlock: "1",
  updatedAtTimestamp: "1",
};

const monadPool = {
  id: "143-0xpool-monad",
  chainId: 143,
  token0: "0x3",
  token1: "0x4",
  source: "fpmm_factory",
  createdAtBlock: "1",
  createdAtTimestamp: "1",
  updatedAtBlock: "1",
  updatedAtTimestamp: "1",
};

function makeNetworkData(
  network: Network,
  pool: { id: string },
): ReturnType<typeof useAllNetworksData>["networkData"][number] {
  return {
    network,
    snapshotWindows: {
      w24h: { from: 0, to: 0 },
      w7d: { from: 0, to: 0 },
      w30d: { from: 0, to: 0 },
    },
    pools: [pool as never],
    snapshots: [],
    snapshots7d: [],
    snapshots30d: [],
    snapshotsAllDaily: [],
    snapshotsAllDailyTruncated: false,
    tradingLimits: [],
    olsPoolIds: new Set(),
    cdpPoolIds: new Set(),
    reservePoolIds: new Set(),
    fees: null,
    feeTransfers: [],
    uniqueLpAddresses: null,
    rates: new Map(),
    error: null,
    feesError: null,
    snapshotsError: null,
    snapshots7dError: null,
    snapshots30dError: null,
    snapshotsAllDailyError: null,
    lpError: null,
  };
}

const baseAllNetworksResult = {
  networkData: [
    makeNetworkData(celoNet, celoPool),
    makeNetworkData(monadNet, monadPool),
  ],
  isLoading: false,
  error: null,
};

const baseSwapsResult = {
  data: { SwapEvent: [] },
  error: null,
  isLoading: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSearchParams = new URLSearchParams();
  vi.mocked(useAllNetworksData).mockReturnValue(baseAllNetworksResult);
});

describe("PoolsPage multichain rendering", () => {
  it("renders GlobalPoolsTable with entries from every configured chain", () => {
    vi.mocked(useGQL).mockImplementation((): SWRResponse => {
      return {
        data: { OlsPool: [] },
        error: null,
        isLoading: false,
      } as SWRResponse;
    });

    const html = renderToStaticMarkup(<PoolsPage />);
    expect(html).toContain('data-testid="global-pools-table"');
    expect(html).toContain('data-testid="entries-count">2<');
    expect(html).toContain("celo-mainnet,monad-mainnet");
  });

  it("accepts a Monad (foreign-chain) namespaced pool filter without blocking", () => {
    mockSearchParams = new URLSearchParams(
      "pool=143-0xBC69212B8E4D445B2307C9D32Dd68E2A4Df00115",
    );

    const poolSwapsSeen: unknown[] = [];
    vi.mocked(useGQL).mockImplementation(
      (query: string | null, variables?: unknown): SWRResponse => {
        if (query?.includes("query PoolSwaps")) {
          poolSwapsSeen.push(variables);
          return baseSwapsResult as SWRResponse;
        }
        return baseSwapsResult as SWRResponse;
      },
    );

    const html = renderToStaticMarkup(<PoolsPage />);
    expect(html).not.toContain("belongs to chain 143");
    expect(html).not.toContain("Switch networks to view its swaps");
    expect(poolSwapsSeen).toEqual([
      { poolId: "143-0xBC69212B8E4D445B2307C9D32Dd68E2A4Df00115", limit: 25 },
    ]);
  });
});
