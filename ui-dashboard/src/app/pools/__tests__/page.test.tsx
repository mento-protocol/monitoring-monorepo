/** @vitest-environment jsdom */

import { act, type AnchorHTMLAttributes, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SWRResponse } from "swr";
import type { Network } from "@/lib/networks";
import type { GlobalPoolEntry } from "@/components/global-pools-table";
import { POOLS_TABLE_SKELETON_ROWS } from "@/components/pools-table-skeleton";
import { POOL_DETAIL_WITH_HEALTH } from "@/lib/queries";
import type { SwapEvent } from "@/lib/types";

const mockReplace = vi.fn();
const mockPreloadGQL = vi.fn();
let mockSearchParams = new URLSearchParams();

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

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
  preloadGQL: (...args: unknown[]) => mockPreloadGQL(...args),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: ReactNode;
  } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

// Keep the real `showInitialSkeleton` (a pure helper) and mock only the hook —
// a bare factory would leave the new named export undefined, crashing render.
vi.mock("@/hooks/use-all-networks-data", async () => ({
  ...(await vi.importActual<typeof import("@/hooks/use-all-networks-data")>(
    "@/hooks/use-all-networks-data",
  )),
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

vi.mock("@/components/sender-cell", () => ({
  SenderCell: ({ address }: { address: string }) => <td>{address}</td>,
}));

import { useGQL } from "@/lib/graphql";
import { useAllNetworksData } from "@/hooks/use-all-networks-data";
import { PoolsPageClient as PoolsPage } from "../_components/pools-page-client";

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

const CELO_POOL_ADDRESS = "0x" + "a".repeat(40);
const MONAD_POOL_ADDRESS = "0x" + "b".repeat(40);

const celoPool = {
  id: `42220-${CELO_POOL_ADDRESS}`,
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
  id: `143-${MONAD_POOL_ADDRESS}`,
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
    brokerSnapshotsAllDaily: [],
    brokerSnapshotsAllDailyTruncated: false,
    olsPoolIds: new Set(),
    cdpPoolIds: new Set(),
    reservePoolIds: new Set(),
    strategyError: null,
    fees: null,
    feeSnapshots: [],
    feeSnapshotsError: null,
    feeSnapshotsTruncated: false,
    ratesError: null,
    poolLabels: new Map(),
    uniqueLpAddresses: null,
    uniqueLpAddressesTruncated: false,
    rates: new Map(),
    error: null,
    snapshotsError: null,
    snapshots7dError: null,
    snapshots30dError: null,
    snapshotsAllDailyError: null,
    brokerSnapshotsAllDailyError: null,
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

const recentSwap: SwapEvent = {
  id: "42220-swap-1",
  chainId: 42220,
  poolId: celoPool.id,
  sender: "0x0000000000000000000000000000000000000003",
  recipient: "0x0000000000000000000000000000000000000004",
  amount0In: "1000000000000000000",
  amount1In: "0",
  amount0Out: "0",
  amount1Out: "1000000000000000000",
  txHash: `0x${"1".repeat(64)}`,
  blockNumber: "123",
  blockTimestamp: "1700000000",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSearchParams = new URLSearchParams();
  vi.mocked(useAllNetworksData).mockReturnValue(baseAllNetworksResult);
});

describe("PoolsPage multichain rendering", () => {
  it("keeps pools visible and discloses a live-health refresh failure", () => {
    vi.mocked(useAllNetworksData).mockReturnValue({
      ...baseAllNetworksResult,
      networkData: baseAllNetworksResult.networkData.map((data, index) =>
        index === 0
          ? {
              ...data,
              liveHealthError: { message: "health timeout" },
            }
          : data,
      ),
    });
    vi.mocked(useGQL).mockReturnValue(baseSwapsResult as SWRResponse);

    const html = renderToStaticMarkup(<PoolsPage />);

    expect(html).toContain("Live pool health refresh failed");
    expect(html).toContain("showing the last confirmed state");
    expect(html).toContain('data-testid="global-pools-table"');
  });

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
    mockSearchParams = new URLSearchParams(`pool=143-${MONAD_POOL_ADDRESS}`);

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
    expect(poolSwapsSeen).toEqual([{ poolId: monadPool.id, limit: 25 }]);
  });

  it("normalizes direct raw-address pool filters before querying swaps", () => {
    mockSearchParams = new URLSearchParams(`pool=${CELO_POOL_ADDRESS}`);

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

    renderToStaticMarkup(<PoolsPage />);

    expect(poolSwapsSeen).toEqual([{ poolId: celoPool.id, limit: 25 }]);
  });

  it("preloads the exact pool-detail key on Recent Swaps hover and focus", () => {
    vi.mocked(useGQL).mockReturnValue({
      data: { SwapEvent: [recentSwap] },
      error: null,
      isLoading: false,
    } as SWRResponse);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(<PoolsPage />);
    });
    const link = container.querySelector<HTMLAnchorElement>(
      `a[href="/pool/${celoPool.id}"]`,
    );
    expect(link).not.toBeNull();

    act(() => {
      link?.dispatchEvent(
        new MouseEvent("mouseover", {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
    });
    expect(mockPreloadGQL).toHaveBeenCalledWith(
      celoNet,
      POOL_DETAIL_WITH_HEALTH,
      { id: celoPool.id, chainId: celoNet.chainId },
    );

    mockPreloadGQL.mockClear();
    act(() => {
      link?.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    expect(mockPreloadGQL).toHaveBeenCalledWith(
      celoNet,
      POOL_DETAIL_WITH_HEALTH,
      { id: celoPool.id, chainId: celoNet.chainId },
    );

    act(() => root.unmount());
    container.remove();
  });
});

// Loading branches must reserve the same table geometry the loaded
// `GlobalPoolsTable` / `SwapTable` land at, not a generic bar-list
// `<Skeleton rows={n} />`. The Recent Swaps skeleton uses a local 45px
// header / 37px row rhythm (`SwapsTableSkeleton` in pools-skeletons.tsx,
// measured against the real SwapTable — shorter than the shared
// `TableSkeleton`'s 36/44 since every swap-row cell is single-line); the
// Pools-section fallback below uses `PoolsTableSkeleton`'s 45px header /
// 58px row rhythm (`@/components/pools-table-skeleton`) — the same shape
// this route's own `loading.tsx` and the homepage's stand-ins reserve.
// `renderToStaticMarkup` serializes inline
// `style={{ height }}` as `style="height:Npx"`, so counting those substrings
// in the SSR string is a cheap structural proxy for "N rows at the right
// height" without needing a jsdom DOM.
describe("PoolsPage loading-state skeleton parity", () => {
  function countHeightPx(html: string, px: number): number {
    return html.split(`style="height:${px}px"`).length - 1;
  }

  it("Recent Swaps loading skeleton reserves exactly `limit` rows (not a hardcoded count)", () => {
    mockSearchParams = new URLSearchParams("limit=10");
    vi.mocked(useGQL).mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: true,
    } as SWRResponse);

    const html = renderToStaticMarkup(<PoolsPage />);

    expect(countHeightPx(html, 37)).toBe(10);
    expect(countHeightPx(html, 45)).toBeGreaterThanOrEqual(1);
  });

  it("Recent Swaps loading skeleton tracks a different `limit` selection (50)", () => {
    mockSearchParams = new URLSearchParams("limit=50");
    vi.mocked(useGQL).mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: true,
    } as SWRResponse);

    const html = renderToStaticMarkup(<PoolsPage />);

    expect(countHeightPx(html, 37)).toBe(50);
  });

  it("Pools section loading skeleton is table-shaped (header + POOLS_TABLE_SKELETON_ROWS rows) during the initial network fetch", () => {
    vi.mocked(useAllNetworksData).mockReturnValue({
      networkData: [],
      isLoading: true,
      error: null,
    });
    vi.mocked(useGQL).mockReturnValue(baseSwapsResult as SWRResponse);

    const html = renderToStaticMarkup(<PoolsPage />);

    // Isolated to the Pools section: swaps are settled+empty here (renders
    // EmptyBox, not a skeleton), so every 58px bar belongs to this table.
    expect(countHeightPx(html, 58)).toBe(POOLS_TABLE_SKELETON_ROWS);
    expect(countHeightPx(html, 45)).toBe(1);
    expect(html).not.toContain('data-testid="global-pools-table"');
  });
});
