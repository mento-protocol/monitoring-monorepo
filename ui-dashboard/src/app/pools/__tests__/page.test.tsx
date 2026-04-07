import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SWRResponse } from "swr";

const mockReplace = vi.fn();
let mockSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
  useRouter: () => ({ replace: mockReplace }),
}));

vi.mock("@/components/network-provider", () => ({
  useNetwork: () => ({
    network: {
      id: "celo-mainnet-hosted",
      label: "Celo Mainnet",
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
  }),
}));

vi.mock("@/lib/graphql", () => ({
  useGQL: vi.fn(),
}));

vi.mock("@/components/pools-table", () => ({
  PoolsTable: ({
    olsPoolIds,
    volume24h,
    volume24hLoading,
    volume24hError,
    volume7d,
    volume7dLoading,
    volume7dError,
  }: {
    olsPoolIds: Set<string>;
    volume24h?: Map<string, number | null>;
    volume24hLoading?: boolean;
    volume24hError?: boolean;
    volume7d?: Map<string, number | null>;
    volume7dLoading?: boolean;
    volume7dError?: boolean;
  }) => (
    <div data-testid="pools-table">
      ols:{Array.from(olsPoolIds).join(",")}
      {volume24hLoading !== undefined && (
        <span data-testid="vol24h-loading">{String(volume24hLoading)}</span>
      )}
      {volume24hError !== undefined && (
        <span data-testid="vol24h-error">{String(volume24hError)}</span>
      )}
      {volume24h && (
        <span data-testid="vol24h-data">
          {JSON.stringify(Array.from(volume24h.entries()))}
        </span>
      )}
      {volume7dLoading !== undefined && (
        <span data-testid="vol7d-loading">{String(volume7dLoading)}</span>
      )}
      {volume7dError !== undefined && (
        <span data-testid="vol7d-error">{String(volume7dError)}</span>
      )}
      {volume7d && (
        <span data-testid="vol7d-data">
          {JSON.stringify(Array.from(volume7d.entries()))}
        </span>
      )}
    </div>
  ),
}));

import { useGQL } from "@/lib/graphql";
import PoolsPage from "../page";

const basePoolResult = {
  data: {
    Pool: [
      {
        id: "42220-0xpool",
        chainId: 42220,
        token0: "0x1",
        token1: "0x2",
        source: "fpmm_factory",
        createdAtBlock: "1",
        createdAtTimestamp: "1",
        updatedAtBlock: "1",
        updatedAtTimestamp: "1",
      },
    ],
  },
  error: null,
  isLoading: false,
};

const baseSwapsResult = {
  data: { SwapEvent: [] },
  error: null,
  isLoading: false,
};

const baseSnapshotResult = {
  data: { PoolSnapshot: [] },
  error: null,
  isLoading: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSearchParams = new URLSearchParams();
});

describe("PoolsPage OLS badge loading", () => {
  it("shows degraded-state feedback when OLS query fails", () => {
    vi.mocked(useGQL).mockImplementation(
      (query: string | null): SWRResponse => {
        if (query?.includes("query AllPoolsWithHealth"))
          return basePoolResult as SWRResponse;
        if (query?.includes("query AllOlsPools")) {
          return {
            data: undefined,
            error: new Error("Hasura timeout"),
            isLoading: false,
          } as SWRResponse;
        }
        if (query?.includes("query PoolSnapshotsWindow"))
          return baseSnapshotResult as SWRResponse;
        return baseSwapsResult as SWRResponse;
      },
    );

    const html = renderToStaticMarkup(<PoolsPage />);
    expect(html).toContain("OLS status unavailable right now: Hasura timeout");
    expect(html).toContain(
      "Pool list is loaded, but OLS badges may be incomplete",
    );
  });

  it("scopes pool and OLS queries to the active chain and recent swaps to chainId", () => {
    vi.mocked(useGQL).mockImplementation(
      (query: string | null, variables?: unknown): SWRResponse => {
        if (query?.includes("query AllPoolsWithHealth")) {
          expect(variables).toEqual({ chainId: 42220 });
          return basePoolResult as SWRResponse;
        }
        if (query?.includes("query AllOlsPools")) {
          expect(variables).toEqual({ chainId: 42220 });
          return {
            data: { OlsPool: [] },
            error: null,
            isLoading: false,
          } as SWRResponse;
        }
        if (query?.includes("query PoolSnapshotsWindow")) {
          const vars = variables as {
            from: number;
            to: number;
            poolIds: string[];
          };
          expect(vars.poolIds).toEqual(["42220-0xpool"]);
          // Both 24h (86400s) and 7d (604800s) windows hit this branch
          expect([86400, 604800]).toContain(vars.to - vars.from);
          return baseSnapshotResult as SWRResponse;
        }
        if (query?.includes("query RecentSwaps")) {
          expect(variables).toEqual({ chainId: 42220, limit: 25 });
          return baseSwapsResult as SWRResponse;
        }
        return baseSwapsResult as SWRResponse;
      },
    );

    renderToStaticMarkup(<PoolsPage />);
  });

  it("passes volume props to PoolsTable for both 24h and 7d", () => {
    vi.mocked(useGQL).mockImplementation(
      (query: string | null): SWRResponse => {
        if (query?.includes("query AllPoolsWithHealth"))
          return basePoolResult as SWRResponse;
        if (query?.includes("query AllOlsPools"))
          return {
            data: { OlsPool: [] },
            error: null,
            isLoading: false,
          } as SWRResponse;
        if (query?.includes("query PoolSnapshotsWindow"))
          return baseSnapshotResult as SWRResponse;
        return baseSwapsResult as SWRResponse;
      },
    );

    const html = renderToStaticMarkup(<PoolsPage />);
    expect(html).toContain('data-testid="vol24h-loading"');
    expect(html).toContain('data-testid="vol24h-error"');
    expect(html).toContain('data-testid="vol7d-loading"');
    expect(html).toContain('data-testid="vol7d-error"');
  });

  it("forwards snapshot error to PoolsTable as volume24hError and volume7dError", () => {
    vi.mocked(useGQL).mockImplementation(
      (query: string | null): SWRResponse => {
        if (query?.includes("query AllPoolsWithHealth"))
          return basePoolResult as SWRResponse;
        if (query?.includes("query AllOlsPools"))
          return {
            data: { OlsPool: [] },
            error: null,
            isLoading: false,
          } as SWRResponse;
        if (query?.includes("query PoolSnapshotsWindow"))
          return {
            data: undefined,
            error: new Error("snapshot fail"),
            isLoading: false,
          } as SWRResponse;
        return baseSwapsResult as SWRResponse;
      },
    );

    const html = renderToStaticMarkup(<PoolsPage />);
    expect(html).toContain('data-testid="vol24h-error">true</span>');
    expect(html).toContain('data-testid="vol7d-error">true</span>');
  });

  it("blocks foreign-chain namespaced pool filters on the pools page", () => {
    mockSearchParams = new URLSearchParams(
      "pool=143-0xBC69212B8E4D445B2307C9D32Dd68E2A4Df00115",
    );

    vi.mocked(useGQL).mockImplementation(
      (query: string | null, variables?: unknown): SWRResponse => {
        if (query?.includes("query AllPoolsWithHealth")) {
          expect(variables).toEqual({ chainId: 42220 });
          return basePoolResult as SWRResponse;
        }
        if (query?.includes("query AllOlsPools")) {
          expect(variables).toEqual({ chainId: 42220 });
          return {
            data: { OlsPool: [] },
            error: null,
            isLoading: false,
          } as SWRResponse;
        }
        if (query?.includes("query PoolSnapshotsWindow"))
          return baseSnapshotResult as SWRResponse;
        if (
          query?.includes("query RecentSwaps") ||
          query?.includes("query PoolSwaps")
        ) {
          throw new Error(
            "foreign-chain filter should not execute a swaps query",
          );
        }
        return baseSwapsResult as SWRResponse;
      },
    );

    const html = renderToStaticMarkup(<PoolsPage />);
    expect(html).toContain("belongs to chain 143");
    expect(html).toContain("Switch networks to view its swaps");
  });
});
