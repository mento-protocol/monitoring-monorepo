import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { Pool, ReserveUpdate } from "@/lib/types";

// Hoist mocks so they're applied before the SUT imports its dependencies.
const mockUseGQL = vi.fn();
let capturedChartRows: ReserveUpdate[] | null = null;

vi.mock("@/lib/graphql", () => ({
  useGQL: (...args: unknown[]) => mockUseGQL(...args),
}));

vi.mock("@/components/network-provider", () => ({
  useNetwork: () => ({
    network: {
      id: "celo-mainnet",
      label: "Celo",
      chainId: 42220,
      contractsNamespace: null,
      hasuraUrl: "https://example.com/v1/graphql",
      hasuraSecret: "",
      explorerBaseUrl: "https://celoscan.io",
      tokenSymbols: { "0xt0": "GBPm", "0xt1": "USDm" },
      addressLabels: {},
      local: false,
      hasVirtualPools: false,
      testnet: false,
    },
  }),
}));

vi.mock("@/components/reserve-chart", () => ({
  ReserveChart: ({ rows }: { rows: ReserveUpdate[] }) => {
    capturedChartRows = rows;
    return <div data-testid="reserve-chart" />;
  },
}));

vi.mock("@/components/feedback", () => ({
  EmptyBox: ({ message }: { message: string }) => <div>{message}</div>,
  ErrorBox: ({ message }: { message: string }) => <div>{message}</div>,
  Skeleton: () => <div>loading</div>,
}));

vi.mock("@/components/table-search", () => ({
  TableSearch: () => <div />,
}));

vi.mock("@/components/tx-hash-cell", () => ({
  TxHashCell: ({ txHash }: { txHash: string }) => <td>{txHash}</td>,
}));

vi.mock("@/components/table", () => ({
  Row: ({ children }: { children: ReactNode }) => <tr>{children}</tr>,
  Table: ({ children }: { children: ReactNode }) => <table>{children}</table>,
  Td: ({ children }: { children: ReactNode }) => <td>{children}</td>,
  Th: ({ children }: { children: ReactNode }) => <th>{children}</th>,
}));

import { ReservesTab } from "../reserves-tab";

const POOL: Pool = {
  id: "42220-0xpool",
  chainId: 42220,
  token0: "0xt0",
  token1: "0xt1",
  source: "fpmm_factory",
  createdAtBlock: "1",
  createdAtTimestamp: "1700000000",
  updatedAtBlock: "1",
  updatedAtTimestamp: "1700000000",
  token0Decimals: 18,
  token1Decimals: 18,
  oraclePrice: "0",
  reserves0: "1",
  reserves1: "1",
};

// Three rows in DESC order — matches what the indexer returns after the fix.
const ROWS_DESC: ReserveUpdate[] = [
  {
    id: "r-30",
    chainId: 42220,
    poolId: "42220-0xpool",
    reserve0: "1000000000000000000",
    reserve1: "1000000000000000000",
    blockTimestampInPool: "3000",
    txHash: "0xtx30",
    blockNumber: "30",
    blockTimestamp: "3000",
  },
  {
    id: "r-20",
    chainId: 42220,
    poolId: "42220-0xpool",
    reserve0: "2000000000000000000",
    reserve1: "2000000000000000000",
    blockTimestampInPool: "2000",
    txHash: "0xtx20",
    blockNumber: "20",
    blockTimestamp: "2000",
  },
  {
    id: "r-10",
    chainId: 42220,
    poolId: "42220-0xpool",
    reserve0: "3000000000000000000",
    reserve1: "3000000000000000000",
    blockTimestampInPool: "1000",
    txHash: "0xtx10",
    blockNumber: "10",
    blockTimestamp: "1000",
  },
];

describe("ReservesTab ordering contract", () => {
  it("feeds the chart chronological (asc) rows and renders the table newest-first (desc)", () => {
    capturedChartRows = null;
    mockUseGQL.mockReturnValue({
      data: { ReserveUpdate: ROWS_DESC },
      error: null,
      isLoading: false,
    });

    const html = renderToStaticMarkup(
      <ReservesTab
        poolId="42220-0xpool"
        limit={25}
        pool={POOL}
        search=""
        onSearchChange={() => {}}
      />,
    );

    // Chart contract: chronological (asc) so plotly's x-axis renders left-to-right in time order.
    expect(capturedChartRows).not.toBeNull();
    expect(capturedChartRows!.map((r) => r.blockNumber)).toEqual([
      "10",
      "20",
      "30",
    ]);

    // Table contract: newest-first (desc). The first txHash in document order
    // is the newest row; the last is the oldest.
    const tx30 = html.indexOf("0xtx30");
    const tx20 = html.indexOf("0xtx20");
    const tx10 = html.indexOf("0xtx10");
    expect(tx30).toBeGreaterThan(-1);
    expect(tx20).toBeGreaterThan(tx30);
    expect(tx10).toBeGreaterThan(tx20);
  });
});
