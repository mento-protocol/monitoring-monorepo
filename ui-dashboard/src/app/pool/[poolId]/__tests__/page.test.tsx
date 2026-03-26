import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { Pool } from "@/lib/types";

const mockUseGQL = vi.fn();
const mockReplace = vi.fn();
const mockSearchParams = new URLSearchParams("tab=providers");

vi.mock("@/lib/graphql", () => ({
  useGQL: (...args: unknown[]) => mockUseGQL(...args),
}));

vi.mock("@/components/network-provider", () => ({
  useNetwork: () => ({
    network: {
      id: "celo-mainnet-hosted",
      label: "Celo Mainnet",
      chainId: 42220,
      contractsNamespace: null,
      hasuraUrl: "https://example.com/v1/graphql",
      hasuraSecret: "",
      explorerBaseUrl: "https://celoscan.io",
      tokenSymbols: {},
      addressLabels: {},
      local: false,
      hasVirtualPools: false,
      testnet: false,
    },
  }),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ poolId: encodeURIComponent("0xpool") }),
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => mockSearchParams,
}));

vi.mock("@/components/lp-concentration-chart", () => ({
  LpConcentrationChart: () => <div>LP Concentration</div>,
}));

vi.mock("@/components/address-link", () => ({
  AddressLink: ({ address }: { address: string }) => <span>{address}</span>,
}));

vi.mock("@/components/network-aware-link", () => ({
  NetworkAwareLink: ({
    href,
    children,
  }: {
    href: string;
    children: ReactNode;
  }) => <a href={href}>{children}</a>,
}));

vi.mock("@/components/badges", () => ({
  KindBadge: ({ kind }: { kind: string }) => <span>{kind}</span>,
  RebalancerBadge: ({ status }: { status: string }) => <span>{status}</span>,
  SourceBadge: ({ source }: { source: string }) => <span>{source}</span>,
}));

vi.mock("@/components/controls", () => ({
  LimitSelect: () => <div>limit</div>,
}));

vi.mock("@/components/feedback", () => ({
  EmptyBox: ({ message }: { message: string }) => <div>{message}</div>,
  ErrorBox: ({ message }: { message: string }) => <div>{message}</div>,
  Skeleton: () => <div>loading</div>,
}));

vi.mock("@/components/health-panel", () => ({ HealthPanel: () => <div /> }));
vi.mock("@/components/limit-panel", () => ({ LimitPanel: () => <div /> }));
vi.mock("@/components/reserves-panel", () => ({
  ReservesPanel: () => <div />,
}));
vi.mock("@/components/oracle-chart", () => ({ OracleChart: () => <div /> }));
vi.mock("@/components/oracle-price-chart", () => ({
  OraclePriceChart: () => <div />,
}));
vi.mock("@/components/reserve-chart", () => ({ ReserveChart: () => <div /> }));
vi.mock("@/components/sender-cell", () => ({ SenderCell: () => <div /> }));
vi.mock("@/components/liquidity-chart", () => ({
  LiquidityChart: () => <div />,
}));
vi.mock("@/components/snapshot-chart", () => ({
  SnapshotChart: () => <div />,
}));
vi.mock("@/components/tx-hash-cell", () => ({ TxHashCell: () => <div /> }));
vi.mock("@/components/table", () => ({
  Row: ({ children }: { children: ReactNode }) => <tr>{children}</tr>,
  Table: ({ children }: { children: ReactNode }) => <table>{children}</table>,
  Td: ({ children }: { children: ReactNode }) => <td>{children}</td>,
  Th: ({ children }: { children: ReactNode }) => <th>{children}</th>,
}));

import PoolDetailPage from "../page";

const BASE_POOL: Pool = {
  id: "0xpool",
  token0: "0xt0",
  token1: "0xt1",
  source: "fpmm_factory",
  createdAtBlock: "1",
  createdAtTimestamp: "1700000000",
  updatedAtBlock: "1",
  updatedAtTimestamp: "1700000000",
  token0Decimals: 18,
  token1Decimals: 18,
  oraclePrice: "1000000000000000000000000",
  reserves0: "1",
  reserves1: "1",
};

function gqlResult(data: unknown, error?: Error) {
  return {
    data,
    error,
    isLoading: false,
    mutate: vi.fn(),
    isValidating: false,
  };
}

describe("Pool detail LPs tab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders indexed LiquidityPosition data when available", () => {
    mockUseGQL.mockImplementation((query: string | null) => {
      if (!query) return gqlResult(undefined);
      if (query.includes("PoolDetailWithHealth")) {
        return gqlResult({ Pool: [BASE_POOL] });
      }
      if (query.includes("TradingLimits"))
        return gqlResult({ TradingLimit: [] });
      if (query.includes("PoolDeployment")) {
        return gqlResult({ FactoryDeployment: [] });
      }
      if (query.includes("PoolLpPositions")) {
        return gqlResult({
          LiquidityPosition: [
            { id: "1", poolId: "0xpool", address: "0xb", netLiquidity: "100" },
            { id: "2", poolId: "0xpool", address: "0xa", netLiquidity: "200" },
          ],
        });
      }
      return gqlResult(undefined);
    });

    const html = renderToStaticMarkup(<PoolDetailPage />);
    expect(html).toContain("Net LP Tokens");
    expect(html).toContain("0xa");
    expect(html).toContain("0xb");
    expect(html.indexOf("0xa")).toBeLessThan(html.indexOf("0xb"));
    expect(html).not.toContain(
      "LP provider data is unavailable until this environment is reindexed",
    );
  });

  it("shows a migration message when LiquidityPosition schema is unavailable", () => {
    mockUseGQL.mockImplementation((query: string | null) => {
      if (!query) return gqlResult(undefined);
      if (query.includes("PoolDetailWithHealth")) {
        return gqlResult({ Pool: [BASE_POOL] });
      }
      if (query.includes("TradingLimits"))
        return gqlResult({ TradingLimit: [] });
      if (query.includes("PoolDeployment")) {
        return gqlResult({ FactoryDeployment: [] });
      }
      if (query.includes("PoolLpPositions")) {
        return gqlResult(
          undefined,
          new Error(
            'Cannot query field "LiquidityPosition" on type "query_root".',
          ),
        );
      }
      return gqlResult(undefined);
    });

    const html = renderToStaticMarkup(<PoolDetailPage />);
    expect(html).toContain(
      "LP provider data is unavailable until this environment is reindexed with the LiquidityPosition schema.",
    );
    expect(html).not.toContain("0xlp2");
  });

  it("shows the FPMM-only empty state for virtual pools", () => {
    mockUseGQL.mockImplementation((query: string | null) => {
      if (!query) return gqlResult(undefined);
      if (query.includes("PoolDetailWithHealth")) {
        return gqlResult({
          Pool: [
            {
              ...BASE_POOL,
              source: "virtual_pool",
            },
          ],
        });
      }
      if (query.includes("TradingLimits")) {
        return gqlResult({ TradingLimit: [] });
      }
      if (query.includes("PoolDeployment")) {
        return gqlResult({ FactoryDeployment: [] });
      }
      return gqlResult(undefined);
    });

    const html = renderToStaticMarkup(<PoolDetailPage />);
    expect(html).toContain(
      "LP provider data is only available for FPMM pools.",
    );
    expect(html).not.toContain(
      "LP provider data is unavailable until this environment is reindexed",
    );
  });
});
