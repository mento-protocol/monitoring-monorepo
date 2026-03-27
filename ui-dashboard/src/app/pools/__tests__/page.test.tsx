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
  PoolsTable: ({ olsPoolIds }: { olsPoolIds: Set<string> }) => (
    <div data-testid="pools-table">ols:{Array.from(olsPoolIds).join(",")}</div>
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
        if (query?.includes("query RecentSwaps")) {
          expect(variables).toEqual({ chainId: 42220, limit: 25 });
          return baseSwapsResult as SWRResponse;
        }
        return baseSwapsResult as SWRResponse;
      },
    );

    renderToStaticMarkup(<PoolsPage />);
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
