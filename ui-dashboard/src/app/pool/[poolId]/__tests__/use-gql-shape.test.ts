import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React, { type ReactNode } from "react";
import type { Pool } from "@/lib/types";

// Characterization test for the upcoming pool-page extraction refactor.
//
// The `useGQL` wrapper at `@/lib/graphql.ts` is the canonical SWR
// fix-point. Its signature is:
//   useGQL(query, variables?, refreshInterval = 30_000, swrOptions?)
//
// This test pins the *call shape* every tab uses: every useGQL call
// passes a string-or-null query, and `refreshInterval` (3rd arg) is
// either undefined (defaults to 30_000) or a positive number — never
// `0`, which would silently disable polling per `AGENTS.md`.
//
// Refactoring the page into per-tab files cannot drop options or pass
// `refreshInterval: 0` without this test failing.

const mockUseGQL = vi.fn();
const mockReplace = vi.fn();
const mockSearchParams = new URLSearchParams("tab=swaps");
let mockPoolId = "0xpool";

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

vi.mock("next/navigation", () => ({
  useParams: () => ({ poolId: encodeURIComponent(mockPoolId) }),
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => mockSearchParams,
}));

// Stub out heavy components so renderToStaticMarkup doesn't blow up.
vi.mock("@/components/lp-concentration-chart", () => ({
  LpConcentrationChart: () => React.createElement("div"),
}));
vi.mock("@/components/address-link", () => ({
  AddressLink: ({ address }: { address: string }) =>
    React.createElement("span", null, address),
}));
vi.mock("@/components/network-aware-link", () => ({
  NetworkAwareLink: ({
    href,
    children,
  }: {
    href: string;
    children: ReactNode;
  }) => React.createElement("a", { href }, children),
}));
vi.mock("@/components/badges", () => ({
  KindBadge: ({ kind }: { kind: string }) =>
    React.createElement("span", null, kind),
  SourceBadge: ({ source }: { source: string }) =>
    React.createElement("span", null, source),
}));
vi.mock("@/components/controls", () => ({
  LimitSelect: () => React.createElement("div"),
}));
vi.mock("@/components/feedback", () => ({
  EmptyBox: ({ message }: { message: string }) =>
    React.createElement("div", null, message),
  ErrorBox: ({ message }: { message: string }) =>
    React.createElement("div", null, message),
  Skeleton: () => React.createElement("div"),
}));
vi.mock("@/components/health-panel", () => ({
  HealthPanel: () => React.createElement("div"),
}));
vi.mock("@/components/limit-panel", () => ({
  LimitPanel: () => React.createElement("div"),
}));
vi.mock("@/components/reserves-panel", () => ({
  ReservesPanel: () => React.createElement("div"),
}));
vi.mock("@/components/oracle-chart", () => ({
  OracleChart: () => React.createElement("div"),
}));
vi.mock("@/components/reserve-chart", () => ({
  ReserveChart: () => React.createElement("div"),
}));
vi.mock("@/components/sender-cell", () => ({
  SenderCell: () => React.createElement("div"),
}));
vi.mock("@/components/tags-cell", () => ({
  TagsCell: () => React.createElement("div"),
}));
vi.mock("@/components/liquidity-chart", () => ({
  LiquidityChart: () => React.createElement("div"),
}));
vi.mock("@/components/snapshot-chart", () => ({
  SnapshotChart: () => React.createElement("div"),
}));
vi.mock("@/components/tx-hash-cell", () => ({
  TxHashCell: () => React.createElement("div"),
}));
vi.mock("@/components/address-labels-provider", () => ({
  useAddressLabels: () => ({
    getName: (a: string | null) => a ?? "—",
    getTags: () => [] as string[],
    getLabel: (a: string | null) => a ?? "—",
  }),
}));
vi.mock("@/components/table", () => ({
  Row: ({ children }: { children: ReactNode }) =>
    React.createElement("tr", null, children),
  Table: ({ children }: { children: ReactNode }) =>
    React.createElement("table", null, children),
  Td: ({ children }: { children: ReactNode }) =>
    React.createElement("td", null, children),
  Th: ({ children }: { children: ReactNode }) =>
    React.createElement("th", null, children),
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

const TABS = [
  "providers",
  "swaps",
  "reserves",
  "rebalances",
  "liquidity",
  "oracle",
  "limits",
  "breaches",
  "ols",
] as const;

describe("useGQL call shape across pool detail tabs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPoolId = "0xpool";
    mockSearchParams.forEach((_, key) => mockSearchParams.delete(key));
  });

  it.each(TABS)(
    "tab=%s: every useGQL call has a valid (query, vars?, refreshMs?) shape",
    (tab) => {
      mockSearchParams.set("tab", tab);

      // Returning an active OlsPool row is what keeps the OLS tab visible
      // (visibleTabs filters out "ols" unless `selectActiveOlsPool` returns
      // a row OR the OLS_POOL query is still loading). Without this, the
      // tab=ols case falls back to "providers" and `OlsTab`/`OlsLiquidityEvents`
      // are never mounted — the test would silently miss any
      // `refreshInterval: 0` or call-shape regression in the OLS subtree.
      mockUseGQL.mockImplementation((query: string | null) => {
        if (!query) return gqlResult(undefined);
        if (query.includes("PoolDetailWithHealth"))
          return gqlResult({ Pool: [BASE_POOL] });
        if (query.includes("TradingLimits"))
          return gqlResult({ TradingLimit: [] });
        if (query.includes("PoolDeployment"))
          return gqlResult({ FactoryDeployment: [] });
        if (query.includes("OlsPool")) {
          return gqlResult({
            OlsPool: [
              {
                id: "ols-1",
                poolId: "42220-0xpool",
                olsAddress: "0xols",
                debtToken: "0xt0",
                isActive: true,
                lastRebalance: "0",
                rebalanceCooldown: "0",
                olsRebalanceCount: "0",
                liquiditySourceIncentiveExpansion: "0",
                liquiditySourceIncentiveContraction: "0",
                protocolIncentiveExpansion: "0",
                protocolIncentiveContraction: "0",
                protocolFeeRecipient: null,
                updatedAtTimestamp: "1",
              },
            ],
          });
        }
        return gqlResult(undefined);
      });

      renderToStaticMarkup(React.createElement(PoolDetailPage));

      // Assert at least one useGQL call fired (page-level queries always run)
      expect(mockUseGQL.mock.calls.length).toBeGreaterThan(0);

      for (const call of mockUseGQL.mock.calls) {
        const [query, variables, refreshMs] = call;
        // Arg 0: query is string or null (skip-key)
        expect(
          query === null || typeof query === "string",
          `tab=${tab}: useGQL arg[0] must be string|null, got ${typeof query}`,
        ).toBe(true);
        // Arg 1: variables is undefined or an object
        if (variables !== undefined) {
          expect(
            typeof variables,
            `tab=${tab}: useGQL arg[1] (variables) must be object|undefined`,
          ).toBe("object");
        }
        // Arg 2: refreshMs is undefined or a positive number — never 0,
        // which would silently disable polling (`AGENTS.md` SWR rule).
        if (refreshMs !== undefined) {
          expect(
            typeof refreshMs,
            `tab=${tab}: useGQL arg[2] (refreshMs) must be number|undefined`,
          ).toBe("number");
          expect(
            refreshMs,
            `tab=${tab}: useGQL arg[2]=0 silently disables SWR polling — never pass 0`,
          ).toBeGreaterThan(0);
        }
      }
    },
  );
});
