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
      id: "celo-mainnet",
      label: "Celo",
      chainId: 42220,
      contractsNamespace: null,
      hasuraUrl: "https://example.com/v1/graphql",
      hasuraSecret: "",
      explorerBaseUrl: "https://celoscan.io",
      tokenSymbols: {
        "0xt0": "GBPm",
        "0xt1": "USDm",
        "0xgbp": "GBPm",
        "0xusd": "USDm",
        "0xeur": "EURm",
      },
      addressLabels: {},
      local: false,
      hasVirtualPools: false,
      testnet: false,
    },
  }),
}));

let mockPoolId = "0xpool";

vi.mock("next/navigation", () => ({
  useParams: () => ({ poolId: encodeURIComponent(mockPoolId) }),
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
vi.mock("@/components/reserve-chart", () => ({ ReserveChart: () => <div /> }));
vi.mock("@/components/sender-cell", () => ({ SenderCell: () => <div /> }));
vi.mock("@/components/tags-cell", () => ({ TagsCell: () => <div /> }));
vi.mock("@/components/liquidity-chart", () => ({
  LiquidityChart: () => <div />,
}));
vi.mock("@/components/snapshot-chart", () => ({
  SnapshotChart: () => <div />,
}));
vi.mock("@/components/tx-hash-cell", () => ({ TxHashCell: () => <div /> }));
vi.mock("@/components/address-labels-provider", () => ({
  useAddressLabels: () => ({
    getName: (address: string | null) => address ?? "—",
    getTags: () => [] as string[],
    getLabel: (address: string | null) => address ?? "—",
  }),
}));
vi.mock("@/components/table", () => ({
  Row: ({ children }: { children: ReactNode }) => <tr>{children}</tr>,
  Table: ({ children }: { children: ReactNode }) => <table>{children}</table>,
  Td: ({ children }: { children: ReactNode }) => <td>{children}</td>,
  Th: ({ children }: { children: ReactNode }) => <th>{children}</th>,
}));

import PoolDetailPage from "../page";

const BASE_POOL: Pool = {
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
    mockPoolId = "0xpool";
    mockSearchParams.forEach((_, key) => mockSearchParams.delete(key));
    mockSearchParams.set("tab", "providers");
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
    expect(html).toContain("GBPm");
    expect(html).toContain("USDm");
    expect(html).toContain("Total Value");
    expect(html).toContain("Share");
    expect(html).toContain("0.00 GBPm");
    expect(html).toContain("0.00 USDm");
    expect(html).toContain("$0.00");
    expect(html).toContain("0xa");
    expect(html).toContain("0xb");
    expect(html.indexOf("0xa")).toBeLessThan(html.indexOf("0xb"));
    expect(html).not.toContain(
      "LP provider data is unavailable until this environment is reindexed",
    );
  });

  it("hides USD-specific columns when the pool has no USDm side", () => {
    mockUseGQL.mockImplementation((query: string | null) => {
      if (!query) return gqlResult(undefined);
      if (query.includes("PoolDetailWithHealth")) {
        return gqlResult({
          Pool: [
            {
              ...BASE_POOL,
              token0: "0xgbp",
              token1: "0xeur",
            },
          ],
        });
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
          ],
        });
      }
      return gqlResult(undefined);
    });

    const html = renderToStaticMarkup(<PoolDetailPage />);
    expect(html).not.toContain("Total Value");
    expect(html).not.toContain("≈ $");
  });

  it("hides USD-specific columns when oracle price is missing", () => {
    mockUseGQL.mockImplementation((query: string | null) => {
      if (!query) return gqlResult(undefined);
      if (query.includes("PoolDetailWithHealth")) {
        return gqlResult({
          Pool: [
            {
              ...BASE_POOL,
              token0: "0xgbp",
              token1: "0xusd",
              oraclePrice: "0",
            },
          ],
        });
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
          ],
        });
      }
      return gqlResult(undefined);
    });

    const html = renderToStaticMarkup(<PoolDetailPage />);
    expect(html).not.toContain("Total Value");
    expect(html).not.toContain("≈ $");
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

  it("renders pool header address link with raw hex address, not namespaced id", () => {
    // Regression test: pool.id is now the namespaced ID ("42220-0x…") but
    // AddressLink in PoolHeader must receive the raw hex address only.
    // This test uses a full 40-char hex address so isNamespacedPoolId fires.
    const namespacedPool: Pool = {
      ...BASE_POOL,
      id: "42220-0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
      chainId: 42220,
    };
    mockPoolId = "42220-0xd8da6bf26964af9d7eed9e03e53415d37aa96045";

    mockUseGQL.mockImplementation((query: string | null) => {
      if (!query) return gqlResult(undefined);
      if (query.includes("PoolDetailWithHealth"))
        return gqlResult({ Pool: [namespacedPool] });
      if (query.includes("TradingLimits"))
        return gqlResult({ TradingLimit: [] });
      return gqlResult(undefined);
    });

    const html = renderToStaticMarkup(<PoolDetailPage />);
    // The explorer link should use the raw hex address, not the namespaced form.
    expect(html).not.toContain("42220-0xd8da6bf2");
    expect(html).toContain("0xd8da6bf2");
  });

  // Extracts the GraphQL operation name (`query FooBar(...)` → "FooBar") from
  // every useGQL call recorded by the mock. Matching on exact operation names
  // avoids substring collisions — e.g. "OracleSnapshots" would otherwise match
  // the header-hook query `OracleSnapshotsWindow` which is not tab-scoped.
  function firedOperationNames(): string[] {
    return mockUseGQL.mock.calls
      .map((args) => args[0])
      .filter((q): q is string => typeof q === "string")
      .map((q) => {
        const m = q.match(/\bquery\s+([A-Za-z_][A-Za-z0-9_]*)/);
        return m ? m[1] : "";
      })
      .filter(Boolean);
  }

  // Operation names for each tab's tab-scoped queries. Header/panel queries
  // that run regardless of active tab (e.g. use-health-score's
  // OracleSnapshotsWindow) are deliberately excluded. The `limits` tab has no
  // tab-local queries — it reads trading-limit data from the parent component.
  type TabWithQueries =
    | "swaps"
    | "reserves"
    | "rebalances"
    | "liquidity"
    | "oracle"
    | "providers"
    | "ols"
    | "breaches";
  const TAB_OPS: Record<TabWithQueries, readonly string[]> = {
    swaps: ["PoolSwapsCount", "PoolSwapsPage"],
    reserves: ["PoolReserves"],
    rebalances: ["PoolRebalancesCount", "PoolRebalancesPage", "PoolRebalances"],
    liquidity: ["PoolLiquidityCount", "PoolLiquidityPage"],
    oracle: [
      "OracleSnapshots",
      "OracleSnapshotsChart",
      "OracleSnapshotsCountPage",
    ],
    providers: ["PoolLpPositions"],
    ols: ["OlsLiquidityEventsCount", "OlsLiquidityEventsPage"],
    breaches: [
      "PoolDeviationBreachesPage",
      "PoolDeviationBreachesCount",
      "PoolDeviationBreachesAll",
    ],
  };

  it("does not fire tab-scoped queries for inactive tabs (reserves)", () => {
    // Pins the lazy-mount contract: inactive tab panels must be unmounted so
    // their useGQL hooks don't poll the hosted indexer. Refactoring the pool
    // page to render all tab panels at once (e.g. CSS display:none) would
    // silently regress the 429 mitigation — this test fails loud if that
    // happens.
    mockSearchParams.set("tab", "reserves");

    mockUseGQL.mockImplementation((query: string | null) => {
      if (!query) return gqlResult(undefined);
      if (query.includes("PoolDetailWithHealth"))
        return gqlResult({ Pool: [BASE_POOL] });
      if (query.includes("TradingLimits"))
        return gqlResult({ TradingLimit: [] });
      if (query.includes("PoolDeployment"))
        return gqlResult({ FactoryDeployment: [] });
      return gqlResult(undefined);
    });

    renderToStaticMarkup(<PoolDetailPage />);

    const fired = new Set(firedOperationNames());
    for (const [tabName, ops] of Object.entries(TAB_OPS)) {
      if (tabName === "reserves") continue;
      for (const op of ops) {
        expect(
          fired.has(op),
          `${op} (${tabName} tab) should not fire on tab=reserves`,
        ).toBe(false);
      }
    }
  });

  it("does not fire tab-scoped queries for inactive tabs (oracle)", () => {
    mockSearchParams.set("tab", "oracle");

    mockUseGQL.mockImplementation((query: string | null) => {
      if (!query) return gqlResult(undefined);
      if (query.includes("PoolDetailWithHealth"))
        return gqlResult({ Pool: [BASE_POOL] });
      if (query.includes("TradingLimits"))
        return gqlResult({ TradingLimit: [] });
      if (query.includes("PoolDeployment"))
        return gqlResult({ FactoryDeployment: [] });
      return gqlResult(undefined);
    });

    renderToStaticMarkup(<PoolDetailPage />);

    const fired = new Set(firedOperationNames());
    for (const [tabName, ops] of Object.entries(TAB_OPS)) {
      if (tabName === "oracle") continue;
      for (const op of ops) {
        expect(
          fired.has(op),
          `${op} (${tabName} tab) should not fire on tab=oracle`,
        ).toBe(false);
      }
    }
  });

  it("queries pool detail with both the namespaced id and active chainId", () => {
    // expect.assertions ensures the expects inside mockImplementation actually
    // run — without this the test would pass vacuously if the mock were never
    // called (PoolDetailWithHealth + TradingLimits + PoolDeployment = 3 expects).
    //
    // Note: we use a full valid 40-char hex address here. "0xpool" is NOT a
    // valid address so normalizePoolIdForChain would return it unchanged
    // (passthrough), breaking the namespaced-variable assertion.
    expect.assertions(3);
    mockPoolId = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
    const namespacedId = "42220-0xd8da6bf26964af9d7eed9e03e53415d37aa96045";

    mockUseGQL.mockImplementation(
      (query: string | null, variables?: unknown) => {
        if (!query) return gqlResult(undefined);
        if (query.includes("PoolDetailWithHealth")) {
          expect(variables).toEqual({
            id: namespacedId,
            chainId: 42220,
          });
          return gqlResult({ Pool: [{ ...BASE_POOL, id: namespacedId }] });
        }
        if (query.includes("TradingLimits")) {
          expect(variables).toEqual({ poolId: namespacedId });
          return gqlResult({ TradingLimit: [] });
        }
        if (query.includes("PoolDeployment")) {
          expect(variables).toEqual({ poolId: namespacedId });
          return gqlResult({ FactoryDeployment: [] });
        }
        return gqlResult(undefined);
      },
    );

    renderToStaticMarkup(<PoolDetailPage />);
  });
});
