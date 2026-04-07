/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  LiquidityEvent,
  OracleSnapshot,
  Pool,
  RebalanceEvent,
  ReserveUpdate,
  SwapEvent,
  TradingLimit,
} from "@/lib/types";
import {
  ORACLE_SNAPSHOTS,
  ORACLE_SNAPSHOTS_CHART,
  ORACLE_SNAPSHOTS_COUNT,
  POOL_DEPLOYMENT,
  POOL_DETAIL_WITH_HEALTH,
  POOL_LIQUIDITY,
  POOL_REBALANCES,
  POOL_RESERVES,
  POOL_SNAPSHOTS,
  POOL_SWAPS,
  TRADING_LIMITS,
} from "@/lib/queries";

const replaceMock = vi.fn();
const useGQLMock = vi.fn();
const getNameMock = vi.fn((address: string | null | undefined) => {
  if (!address) return "";
  const labels: Record<string, string> = {
    "0xsender000000000000000000000000000000000001": "Treasury Wallet",
    "0xrecipient00000000000000000000000000000002": "Wintermute",
    "0xstrategy00000000000000000000000000000003": "Strategy Alpha",
    "0xcaller0000000000000000000000000000000004": "Keeper Bot",
    "0xliquidity00000000000000000000000000000005": "LP Desk",
  };
  return labels[address] ?? address;
});
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const getTagsMock = vi.fn((_address: string | null) => [] as string[]);

vi.mock("next/navigation", () => ({
  useParams: () => ({ poolId: encodeURIComponent("pool-1") }),
  useRouter: () => ({ replace: replaceMock }),
  useSearchParams: () => currentSearchParams,
}));

vi.mock("@/components/network-provider", () => ({
  useNetwork: () => ({
    network: {
      id: "celo-mainnet",
      label: "Celo Mainnet",
      chainId: 42220,
      contractsNamespace: null,
      hasuraUrl: "",
      hasuraSecret: "",
      explorerBaseUrl: "https://celoscan.io",
      tokenSymbols: {
        token0: "USDm",
        token1: "EURm",
      },
      addressLabels: {},
      local: false,
      hasVirtualPools: true,
      testnet: false,
    },
  }),
}));

vi.mock("@/components/address-labels-provider", () => ({
  useAddressLabels: () => ({
    getName: getNameMock,
    getTags: getTagsMock,
    getLabel: getNameMock,
  }),
}));

vi.mock("@/lib/graphql", () => ({
  useGQL: (...args: unknown[]) => useGQLMock(...args),
}));

vi.mock("@/components/address-link", () => ({
  AddressLink: ({ address }: { address: string | null }) => (
    <span>{address}</span>
  ),
}));
vi.mock("@/components/network-aware-link", () => ({
  NetworkAwareLink: ({
    href,
    children,
  }: {
    href: string;
    children: React.ReactNode;
  }) => <a href={href}>{children}</a>,
}));
vi.mock("@/components/badges", () => ({
  KindBadge: ({ kind }: { kind: string }) => <span>{kind}</span>,
  RebalancerBadge: () => <span>rebalancer-badge</span>,
  SourceBadge: ({ source }: { source: string | null | undefined }) => (
    <span>{source}</span>
  ),
}));
vi.mock("@/components/controls", () => ({
  LimitSelect: ({ value }: { value: number }) => <span>limit:{value}</span>,
}));
vi.mock("@/components/feedback", () => ({
  EmptyBox: ({ message }: { message: string }) => <div>{message}</div>,
  ErrorBox: ({ message }: { message: string }) => <div>{message}</div>,
  Skeleton: () => <div>loading</div>,
}));
vi.mock("@/components/health-panel", () => ({
  HealthPanel: () => <div>health-panel</div>,
}));
vi.mock("@/components/limit-panel", () => ({
  LimitPanel: () => <div>limit-panel</div>,
}));
vi.mock("@/components/reserves-panel", () => ({
  ReservesPanel: () => <div>reserves-panel</div>,
}));
vi.mock("@/components/oracle-chart", () => ({
  OracleChart: () => <div>oracle-chart</div>,
}));
vi.mock("@/components/oracle-price-chart", () => ({
  OraclePriceChart: () => <div>oracle-price-chart</div>,
}));
vi.mock("@/components/reserve-chart", () => ({
  ReserveChart: () => <div>reserve-chart</div>,
}));
vi.mock("@/components/liquidity-chart", () => ({
  LiquidityChart: () => <div>liquidity-chart</div>,
}));
vi.mock("@/components/snapshot-chart", () => ({
  SnapshotChart: () => <div>snapshot-chart</div>,
}));
vi.mock("@/components/sender-cell", () => ({
  SenderCell: ({ address }: { address: string }) => (
    <td>{getNameMock(address)}</td>
  ),
}));
vi.mock("@/components/tags-cell", () => ({
  TagsCell: ({ address }: { address: string }) => (
    <td>{getTagsMock(address).join(", ")}</td>
  ),
}));
vi.mock("@/components/table", () => ({
  Row: ({ children }: { children: React.ReactNode }) => <tr>{children}</tr>,
  Table: ({ children }: { children: React.ReactNode }) => (
    <table>{children}</table>
  ),
  Td: (
    props: React.ComponentPropsWithoutRef<"td"> & {
      small?: boolean;
      mono?: boolean;
      muted?: boolean;
      align?: "left" | "right";
    },
  ) => {
    const { children, small, mono, muted, align, ...domProps } = props;
    void small;
    void mono;
    void muted;
    void align;
    return <td {...domProps}>{children}</td>;
  },
  Th: ({ children, ...props }: React.ComponentPropsWithoutRef<"th">) => (
    <th {...props}>{children}</th>
  ),
}));
vi.mock("@/components/tx-hash-cell", () => ({
  TxHashCell: ({ txHash }: { txHash: string }) => <td>{txHash}</td>,
}));

import PoolDetailPage, { decodePoolId, parseTabLimit } from "./page";

let currentSearchParams = new URLSearchParams();
let interactiveContainer: HTMLDivElement | null = null;
let interactiveRoot: Root | null = null;
let oracleCount = 51;
let oracleCountError = false;

const basePool: Pool = {
  id: "pool-1",
  chainId: 42220,
  token0: "token0",
  token1: "token1",
  source: "fpmm_factory",
  createdAtBlock: "123",
  createdAtTimestamp: "1700000000",
  updatedAtBlock: "456",
  updatedAtTimestamp: "1700000100",
  token0Decimals: 18,
  token1Decimals: 18,
  oraclePrice: "1000000000000000000000000",
  rebalancerAddress: "0xrebalancer",
};

const swaps: SwapEvent[] = [
  {
    id: "swap-1",
    chainId: 42220,
    poolId: "pool-1",
    txHash: "0xabcdeffedcba1234567890abcdeffedcba1234567890abcdeffedcba1234",
    sender: "0xsender000000000000000000000000000000000001",
    recipient: "0xrecipient00000000000000000000000000000002",
    amount0In: "1000000000000000000",
    amount1In: "0",
    amount0Out: "0",
    amount1Out: "2000000000000000000",
    blockNumber: "1001",
    blockTimestamp: "1700000200",
  },
];

const reserves: ReserveUpdate[] = [
  {
    id: "reserve-1",
    chainId: 42220,
    poolId: "pool-1",
    txHash: "0xreservehash",
    reserve0: "1500000000000000000",
    reserve1: "2500000000000000000",
    blockTimestampInPool: "1700000300",
    blockNumber: "2001",
    blockTimestamp: "1700000300",
  },
];

const rebalances: RebalanceEvent[] = [
  {
    id: "rebalance-1",
    chainId: 42220,
    poolId: "pool-1",
    txHash: "0xrebalancehash",
    sender: "0xstrategy00000000000000000000000000000003",
    caller: "0xcaller0000000000000000000000000000000004",
    priceDifferenceBefore: "123",
    priceDifferenceAfter: "7",
    effectivenessRatio: "0.943",
    blockNumber: "3001",
    blockTimestamp: "1700000400",
  },
];

const liquidity: LiquidityEvent[] = [
  {
    id: "liq-1",
    chainId: 42220,
    poolId: "pool-1",
    txHash: "0xliquidityhash",
    kind: "mint",
    sender: "0xliquidity00000000000000000000000000000005",
    recipient: "0xrecipient00000000000000000000000000000002",
    amount0: "5000000000000000000",
    amount1: "7000000000000000000",
    liquidity: "9000000000000000000",
    blockNumber: "4001",
    blockTimestamp: "1700000500",
  },
];

const oracleRows: OracleSnapshot[] = [
  {
    id: "oracle-1",
    chainId: 42220,
    poolId: "pool-1",
    source: "median-feed",
    oracleOk: true,
    oraclePrice: "1100000000000000000000000",
    priceDifference: "42",
    rebalanceThreshold: 12,
    numReporters: 5,
    blockNumber: "5001",
    timestamp: "1700000600",
    txHash: "0xabc123def456",
  },
];

function makeGqlResult(data: unknown) {
  return { data, error: null, isLoading: false };
}

function renderWithParams(params: Record<string, string> = {}) {
  currentSearchParams = new URLSearchParams(params);
  return renderToStaticMarkup(<PoolDetailPage />);
}

beforeEach(() => {
  vi.useFakeTimers();
  replaceMock.mockReset();
  useGQLMock.mockReset();
  getNameMock.mockClear();
  getTagsMock.mockClear();
  currentSearchParams = new URLSearchParams();
  oracleCount = 51;
  oracleCountError = false;
  window.history.replaceState({}, "", "/pool/pool-1");

  useGQLMock.mockImplementation(
    (query: unknown, variables?: { offset?: number; limit?: number }) => {
      if (query === POOL_DETAIL_WITH_HEALTH)
        return makeGqlResult({ Pool: [basePool] });
      if (query === TRADING_LIMITS)
        return makeGqlResult({ TradingLimit: [] satisfies TradingLimit[] });
      if (query === POOL_DEPLOYMENT)
        return makeGqlResult({ FactoryDeployment: [{ txHash: "0xdeploy" }] });
      if (query === POOL_SWAPS) return makeGqlResult({ SwapEvent: swaps });
      if (query === POOL_SNAPSHOTS) return makeGqlResult({ PoolSnapshot: [] });
      if (query === POOL_RESERVES)
        return makeGqlResult({ ReserveUpdate: reserves });
      if (query === POOL_REBALANCES)
        return makeGqlResult({ RebalanceEvent: rebalances });
      if (query === POOL_LIQUIDITY)
        return makeGqlResult({ LiquidityEvent: liquidity });
      if (query === ORACLE_SNAPSHOTS)
        return makeGqlResult({
          OracleSnapshot: oracleRows.map((row, index) => ({
            ...row,
            id: `oracle-${(variables?.offset ?? 0) + index + 1}`,
          })),
        });
      if (query === ORACLE_SNAPSHOTS_CHART)
        return makeGqlResult({ OracleSnapshot: oracleRows });
      if (query === ORACLE_SNAPSHOTS_COUNT)
        return oracleCountError
          ? { data: null, error: new Error("count failed"), isLoading: false }
          : makeGqlResult({
              OracleSnapshot_aggregate: { aggregate: { count: oracleCount } },
            });
      return makeGqlResult({});
    },
  );
});

afterEach(() => {
  if (interactiveRoot) {
    act(() => {
      interactiveRoot?.unmount();
    });
    interactiveRoot = null;
  }
  interactiveContainer?.remove();
  interactiveContainer = null;
  vi.useRealTimers();
});

function renderInteractive(params: Record<string, string> = {}) {
  currentSearchParams = new URLSearchParams(params);
  const qs = currentSearchParams.toString();
  window.history.replaceState({}, "", `/pool/pool-1${qs ? `?${qs}` : ""}`);
  interactiveContainer = document.createElement("div");
  document.body.appendChild(interactiveContainer);
  interactiveRoot = createRoot(interactiveContainer);
  act(() => {
    interactiveRoot?.render(<PoolDetailPage />);
  });
  return interactiveContainer;
}

describe("pool detail helpers", () => {
  it("falls back to the raw pool id when decodeURIComponent would throw", () => {
    expect(decodePoolId("%E0%A4%A")).toBe("%E0%A4%A");
  });

  it("sanitises invalid tab limits back to the default page size", () => {
    expect(parseTabLimit(null)).toBe(25);
    expect(parseTabLimit("0")).toBe(25);
    expect(parseTabLimit("-5")).toBe(25);
    expect(parseTabLimit("NaN")).toBe(25);
    expect(parseTabLimit("50")).toBe(50);
    expect(parseTabLimit("9999")).toBe(200); // capped at MAX_TAB_LIMIT
  });
});

describe("Pool detail tab search", () => {
  it("hydrates swaps search from URL and matches full addresses via labels/raw values", () => {
    const html = renderWithParams({
      swapsQ: "0xsender000000000000000000000000000000000001",
    });
    expect(html).toContain(
      'value="0xsender000000000000000000000000000000000001"',
    );
    expect(html).toContain("Treasury Wallet");
    expect(html).not.toContain("No swaps match your search.");
  });

  it("shows swaps no-match state from URL-backed search", () => {
    const html = renderWithParams({ swapsQ: "not-found" });
    expect(html).toContain("No swaps match your search.");
  });

  it("matches reserves rows by token/amount search from URL", () => {
    const html = renderWithParams({ tab: "reserves", reservesQ: "2.50" });
    expect(html).toContain('value="2.50"');
    expect(html).toContain("0xreservehash");
    expect(html).not.toContain("No reserve updates match your search.");
  });

  it("shows reserves no-match state", () => {
    const html = renderWithParams({ tab: "reserves", reservesQ: "kraken" });
    expect(html).toContain("No reserve updates match your search.");
  });

  it("matches rebalances rows by resolved label", () => {
    const html = renderWithParams({ tab: "rebalances", rebalancesQ: "keeper" });
    expect(html).toContain('value="keeper"');
    expect(html).toContain("Keeper Bot");
    expect(html).not.toContain("No rebalances match your search.");
  });

  it("shows rebalances no-match state", () => {
    const html = renderWithParams({
      tab: "rebalances",
      rebalancesQ: "missing-bot",
    });
    expect(html).toContain("No rebalances match your search.");
  });

  it("matches liquidity rows by kind or sender label", () => {
    const html = renderWithParams({ tab: "liquidity", liquidityQ: "lp desk" });
    expect(html).toContain('value="lp desk"');
    expect(html).toContain("LP Desk");
    expect(html).not.toContain("No liquidity events match your search.");
  });

  it("shows liquidity no-match state", () => {
    const html = renderWithParams({
      tab: "liquidity",
      liquidityQ: "burn-only",
    });
    expect(html).toContain("No liquidity events match your search.");
  });

  it("matches oracle rows by source or status aliases", () => {
    const html = renderWithParams({ tab: "oracle", oracleQ: "healthy" });
    expect(html).toContain('value="healthy"');
    expect(html).toContain("median-feed");
    expect(html).not.toContain("No oracle snapshots match your search.");
  });

  it("shows oracle no-match state", () => {
    const html = renderWithParams({ tab: "oracle", oracleQ: "chainlink" });
    expect(html).toContain("No oracle snapshots match your search.");
  });

  it("links oracle source and time to the transaction explorer URL", () => {
    const html = renderWithParams({ tab: "oracle" });
    expect(html).toContain('href="https://celoscan.io/tx/0xabc123def456"');
    expect(html).toContain(">median-feed</a>");
  });

  it("loads chart and count oracle queries and renders pagination metadata", () => {
    const html = renderWithParams({ tab: "oracle" });
    expect(useGQLMock).toHaveBeenCalledWith(
      ORACLE_SNAPSHOTS_COUNT,
      expect.objectContaining({ poolId: "pool-1" }),
    );
    expect(useGQLMock).toHaveBeenCalledWith(
      ORACLE_SNAPSHOTS_CHART,
      expect.objectContaining({ poolId: "pool-1", limit: 200 }),
    );
    expect(html).toContain("51 total");
    expect(html).toContain("page 1 of 3");
  });

  it("exposes aria-sort on sortable oracle headers", () => {
    const html = renderWithParams({ tab: "oracle" });
    expect(html).toContain('aria-sort="descending"');
    expect(html).toContain("Time ↓");
    expect(html).toContain('aria-label="First page"');
  });

  it("updates aria-sort when oracle sort changes", () => {
    const container = renderInteractive({ tab: "oracle" });
    const priceDiffButton = Array.from(
      container.querySelectorAll("button"),
    ).find((button) => button.textContent?.includes("Price Diff")) as
      | HTMLButtonElement
      | undefined;

    expect(priceDiffButton).toBeTruthy();

    act(() => {
      priceDiffButton?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });

    const ascendingHeaders = Array.from(
      container.querySelectorAll("th"),
    ).filter((th) => th.getAttribute("aria-sort") === "ascending");
    expect(ascendingHeaders).toHaveLength(0);
    const descendingHeaders = Array.from(
      container.querySelectorAll("th"),
    ).filter((th) => th.getAttribute("aria-sort") === "descending");
    expect(
      descendingHeaders.some((th) => th.textContent?.includes("Price Diff")),
    ).toBe(true);
  });

  it("updates oracle query offset when pagination changes page", () => {
    const container = renderInteractive({ tab: "oracle" });
    const nextButton = container.querySelector(
      'button[aria-label="Next page"]',
    ) as HTMLButtonElement;

    expect(nextButton).toBeTruthy();
    expect(useGQLMock).toHaveBeenCalledWith(
      ORACLE_SNAPSHOTS,
      expect.objectContaining({ offset: 0, limit: 25 }),
    );

    act(() => {
      nextButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(useGQLMock).toHaveBeenCalledWith(
      ORACLE_SNAPSHOTS,
      expect.objectContaining({ offset: 25, limit: 25 }),
    );
    expect(container.textContent).toContain("page 2 of 3");
  });

  it("preserves pagination metadata when the count query later fails", () => {
    const container = renderInteractive({ tab: "oracle" });
    expect(container.textContent).toContain("51 total · page 1 of 3");

    oracleCountError = true;
    act(() => {
      interactiveRoot?.render(<PoolDetailPage />);
    });

    expect(container.textContent).toContain("51 total · page 1 of 3");
    expect(container.textContent).toContain(
      "Could not load total count — pagination may be incomplete.",
    );
  });

  it("shows degraded search warning when count fails before first success", () => {
    oracleCountError = true;
    const html = renderWithParams({ tab: "oracle", oracleQ: "median" });
    expect(html).toContain(
      "Could not load total count — search covers the most recent 500 snapshots only.",
    );
  });

  it("caps oracle search fetch size and shows a warning for large result sets", () => {
    oracleCount = 5000;
    const html = renderWithParams({ tab: "oracle", oracleQ: "median" });

    expect(useGQLMock).toHaveBeenCalledWith(
      ORACLE_SNAPSHOTS,
      expect.objectContaining({ offset: 0, limit: 2000 }),
    );
    expect(html).toContain(
      "Search is limited to the most recent 2,000 snapshots.",
    );
  });

  it("clamps oracle fetch offset when total count shrinks below current page", () => {
    // Start on page 3 of 3 with count=51
    const container = renderInteractive({ tab: "oracle" });
    const nextButton = container.querySelector(
      'button[aria-label="Next page"]',
    ) as HTMLButtonElement;
    act(() => {
      nextButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    act(() => {
      nextButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).toContain("page 3 of 3");
    // On page 3, offset should be 50
    expect(useGQLMock).toHaveBeenCalledWith(
      ORACLE_SNAPSHOTS,
      expect.objectContaining({ offset: 50 }),
    );

    // Count shrinks — only 1 page now
    oracleCount = 20;
    useGQLMock.mockClear();
    act(() => {
      interactiveRoot?.render(<PoolDetailPage />);
    });

    // rawPage is still 3, but totalPages is now 1 — clamped page = 1 → offset = 0.
    // Pagination hides when there's only 1 page, so we assert on the query offset.
    expect(useGQLMock).toHaveBeenCalledWith(
      ORACLE_SNAPSHOTS,
      expect.objectContaining({ offset: 0 }),
    );
    // Pagination is hidden (single page)
    expect(container.textContent).not.toContain("page 3");
  });

  it("aria-sort is none for all headers while search is active", () => {
    // Default sort is timestamp desc — aria-sort should be hidden during search
    const html = renderWithParams({ tab: "oracle", oracleQ: "median" });
    // No header should advertise a sort while search overrides it
    expect(html).not.toContain('aria-sort="descending"');
    expect(html).not.toContain('aria-sort="ascending"');
    // All should be none
    const noneMatches = (html.match(/aria-sort="none"/g) ?? []).length;
    expect(noneMatches).toBeGreaterThan(0);
  });

  it("oracle search always uses timestamp desc order regardless of active table sort", () => {
    // With a non-default sort active, a search must still fetch the most recent
    // window (timestamp desc) so the "most recent N" warning text is accurate.
    // We test this by rendering with oracleQ already set AND checking what
    // orderBy was passed to ORACLE_SNAPSHOTS when search is active.
    const html = renderWithParams({ tab: "oracle", oracleQ: "median" });
    expect(html).toContain("median-feed"); // search found a result

    // All ORACLE_SNAPSHOTS calls while searching must use timestamp desc
    const oracleCalls = useGQLMock.mock.calls.filter(
      (call) => call[0] === ORACLE_SNAPSHOTS,
    );
    expect(oracleCalls.length).toBeGreaterThan(0);
    for (const [, vars] of oracleCalls) {
      const orderJson = JSON.stringify(vars?.orderBy ?? []);
      expect(orderJson).toContain("timestamp");
      expect(orderJson).not.toContain("priceDifference");
      expect(orderJson).not.toContain("oracleOk");
      expect(orderJson).not.toContain("oraclePrice");
    }
  });

  it("preserves newer url params when a debounced search commit fires later", () => {
    const container = renderInteractive();
    const input = container.querySelector(
      'input[aria-label="Search swaps"]',
    ) as HTMLInputElement;

    expect(input).toBeTruthy();

    act(() => {
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, "0xabc");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(document.activeElement).toBe(input);
    expect(replaceMock).not.toHaveBeenCalled();

    act(() => {
      currentSearchParams = new URLSearchParams({ limit: "50" });
      window.history.replaceState({}, "", "/pool/pool-1?limit=50");
    });

    act(() => {
      vi.advanceTimersByTime(150);
    });

    const lastCall = replaceMock.mock.calls.at(-1)?.[0] as string | undefined;
    expect(lastCall).toBeTruthy();
    expect(lastCall).toContain("limit=50");
    expect(lastCall).toContain("swapsQ=0xabc");
    expect(document.activeElement).toBe(input);
  });
});
