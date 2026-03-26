import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SWRResponse } from "swr";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn() }),
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
        id: "0xpool",
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
});
