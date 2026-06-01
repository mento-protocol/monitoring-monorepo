/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, isValidElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  LiquidityEvent,
  OracleSnapshot,
  Pool,
  PoolSnapshot,
  RebalanceEvent,
  ReserveUpdate,
  SwapEvent,
  TradingLimit,
} from "@/lib/types";
import {
  BROKER_EXCHANGE_DAILY_SNAPSHOTS_24H,
  ORACLE_SNAPSHOTS,
  ORACLE_SNAPSHOTS_CHART,
  ORACLE_SNAPSHOTS_COUNT_PAGE,
  POOL_DAILY_SNAPSHOTS_CHART,
  POOL_DEPLOYMENT,
  POOL_DETAIL_WITH_HEALTH,
  POOL_LIQUIDITY,
  POOL_LIQUIDITY_COUNT,
  POOL_LIQUIDITY_PAGE,
  POOL_REBALANCES,
  POOL_REBALANCES_COUNT,
  POOL_REBALANCES_PAGE,
  POOL_REBALANCES_USD_EXT,
  POOL_RESERVES,
  POOL_SNAPSHOTS_CHART,
  POOL_SWAPS,
  POOL_SWAPS_COUNT,
  POOL_SWAPS_PAGE,
  POOL_THRESHOLDS_KNOWN_EXT,
  POOL_V2_EXCHANGE,
  TRADING_LIMITS,
  VIRTUAL_POOL_LIFECYCLE,
} from "@/lib/queries";
import { SNAPSHOT_REFRESH_MS } from "@/lib/volume";
import { HASURA_TIMEOUT_MS } from "@/lib/hasura-timeout";

const redirectMock = vi.fn();
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

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    Suspense: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

vi.mock("next/navigation", () => ({
  redirect: (href: string) => redirectMock(href),
  useParams: () => ({ poolId: encodeURIComponent("pool-1") }),
}));

vi.mock("@/components/network-provider", () => ({
  useNetwork: () => ({
    network: {
      id: "celo-mainnet",
      label: "Celo",
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

vi.mock("@/lib/networks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/networks")>();
  return {
    ...actual,
    isConfiguredNetworkId: (networkId: string) =>
      networkId === "celo-mainnet" || networkId === "monad-mainnet",
    networkIdForChainId: (chainId: number) =>
      chainId === 42220
        ? "celo-mainnet"
        : chainId === 143
          ? "monad-mainnet"
          : null,
  };
});

vi.mock("@/components/address-labels-provider", () => ({
  useAddressLabels: () => ({
    getName: getNameMock,
    getTags: getTagsMock,
    getLabel: getNameMock,
  }),
}));

vi.mock("@/lib/graphql", () => ({
  HASURA_TIMEOUT_MS: 5000,
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
import { PoolHeader } from "./_components/pool-header";
import { POOL_NOT_FOUND_DEST } from "@/lib/routing";

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
let poolForTest: Pool = basePool;

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
    // Boundary-relative effectiveness: before=123, boundary=50, gap=73,
    // improvement=116, 116/73 ≈ 1.5890 (legitimate overshoot). The old
    // "0.943" value was `(123-7)/123` — toward-midpoint, now deprecated.
    rebalanceThreshold: 50,
    effectivenessRatio: "1.589",
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
    numReporters: 5,
    blockNumber: "5001",
    timestamp: "1700000600",
    txHash: "0xabc123def456",
  },
];
let oracleRowsForTest: OracleSnapshot[] = oracleRows;

const poolSnapshots: PoolSnapshot[] = [
  {
    id: "snap-1",
    poolId: "pool-1",
    timestamp: "1700000000",
    reserves0: "1000000000000000000",
    reserves1: "2000000000000000000",
    swapCount: 5,
    swapVolume0: "500000000000000000",
    swapVolume1: "900000000000000000",
    rebalanceCount: 1,
    cumulativeSwapCount: 10,
    cumulativeVolume0: "5000000000000000000",
    cumulativeVolume1: "9000000000000000000",
    blockNumber: "100",
  },
  {
    id: "snap-2",
    poolId: "pool-1",
    timestamp: "1700003600",
    reserves0: "1100000000000000000",
    reserves1: "2100000000000000000",
    swapCount: 3,
    swapVolume0: "300000000000000000",
    swapVolume1: "600000000000000000",
    rebalanceCount: 0,
    cumulativeSwapCount: 13,
    cumulativeVolume0: "5300000000000000000",
    cumulativeVolume1: "9600000000000000000",
    blockNumber: "200",
  },
];

const exchangeId =
  "0x1111111111111111111111111111111111111111111111111111111111111111";
const v2ExchangeRow = {
  id: `42220-${exchangeId}`,
  chainId: 42220,
  exchangeId,
  exchangeProvider: "0x22d9db95e6ae61c104a7b6f6c78d7993b94ec901",
  asset0: "token0",
  asset1: "token1",
  pricingModule: "0xpricingmodule",
  pricingModuleName: "ConstantSum",
  spread: "5000000000000000000000",
  referenceRateFeedID: "0xfeed000000000000000000000000000000000000",
  referenceRateResetFrequency: "300",
  minimumReports: "1",
  stablePoolResetSize: "1000000000000000000000",
  bucket0: "1000000000000000000000",
  bucket1: "2000000000000000000000",
  lastBucketUpdate: "1700000000",
  isDeprecated: false,
  wrappedByPoolId: "pool-1",
};

function makeGqlResult(data: unknown) {
  return { data, error: null, isLoading: false };
}

function makeTrustFlagsResult(pool: Pool = basePool) {
  return makeGqlResult({
    Pool: [
      {
        id: pool.id,
        rebalanceThresholdsKnown: true,
        tokenDecimalsKnown: true,
      },
    ],
  });
}

function renderWithParams(params: Record<string, string> = {}) {
  const qs = new URLSearchParams(params).toString();
  window.history.replaceState({}, "", `/pool/pool-1${qs ? `?${qs}` : ""}`);
  return renderToStaticMarkup(<PoolDetailPage />);
}

type ServerSearchParams = Record<string, string | string[] | undefined>;
type CanonicalPoolPageElement = ReactElement<{
  params: Promise<{ poolId: string }>;
  searchParams: Promise<ServerSearchParams>;
}>;

async function renderServerPoolPage(
  poolId: string,
  searchParams: ServerSearchParams = {},
) {
  const element = PoolDetailPage({
    params: Promise.resolve({ poolId: encodeURIComponent(poolId) }),
    searchParams: Promise.resolve(searchParams),
  });

  expect(isValidElement(element)).toBe(true);
  const canonicalElement = element as CanonicalPoolPageElement;
  const renderCanonical = canonicalElement.type as (
    props: CanonicalPoolPageElement["props"],
  ) => Promise<unknown>;
  return renderCanonical(canonicalElement.props);
}

beforeEach(() => {
  vi.useFakeTimers();
  redirectMock.mockReset();
  redirectMock.mockImplementation((href: string) => {
    throw new Error(`NEXT_REDIRECT:${href}`);
  });
  useGQLMock.mockReset();
  getNameMock.mockClear();
  getTagsMock.mockClear();
  oracleCount = 51;
  oracleCountError = false;
  oracleRowsForTest = oracleRows;
  poolForTest = basePool;
  window.history.replaceState({}, "", "/pool/pool-1");

  useGQLMock.mockImplementation(
    (query: unknown, variables?: { offset?: number; limit?: number }) => {
      if (query === POOL_DETAIL_WITH_HEALTH)
        return makeGqlResult({ Pool: [poolForTest] });
      if (query === POOL_THRESHOLDS_KNOWN_EXT) return makeTrustFlagsResult();
      if (query === TRADING_LIMITS)
        return makeGqlResult({ TradingLimit: [] satisfies TradingLimit[] });
      if (query === POOL_DEPLOYMENT)
        return makeGqlResult({ FactoryDeployment: [{ txHash: "0xdeploy" }] });
      if (query === POOL_SWAPS || query === POOL_SWAPS_PAGE)
        return makeGqlResult({ SwapEvent: swaps });
      if (query === POOL_SWAPS_COUNT)
        return makeGqlResult({ SwapEvent: swaps.map((s) => ({ id: s.id })) });
      if (query === POOL_SNAPSHOTS_CHART)
        return makeGqlResult({ PoolSnapshot: poolSnapshots });
      if (query === POOL_DAILY_SNAPSHOTS_CHART)
        return makeGqlResult({ PoolDailySnapshot: poolSnapshots });
      if (query === POOL_RESERVES)
        return makeGqlResult({ ReserveUpdate: reserves });
      if (query === POOL_REBALANCES || query === POOL_REBALANCES_PAGE)
        return makeGqlResult({ RebalanceEvent: rebalances });
      if (query === POOL_REBALANCES_COUNT)
        return makeGqlResult({
          RebalanceEvent: rebalances.map((r) => ({ id: r.id })),
        });
      if (query === POOL_LIQUIDITY || query === POOL_LIQUIDITY_PAGE)
        return makeGqlResult({ LiquidityEvent: liquidity });
      if (query === POOL_LIQUIDITY_COUNT)
        return makeGqlResult({
          LiquidityEvent: liquidity.map((l) => ({ id: l.id })),
        });
      if (query === ORACLE_SNAPSHOTS)
        return makeGqlResult({
          OracleSnapshot: oracleRowsForTest.map((row, index) => ({
            ...row,
            id: `oracle-${(variables?.offset ?? 0) + index + 1}`,
          })),
        });
      if (query === ORACLE_SNAPSHOTS_CHART)
        return makeGqlResult({ OracleSnapshot: oracleRowsForTest });
      if (query === ORACLE_SNAPSHOTS_COUNT_PAGE)
        return oracleCountError
          ? { data: null, error: new Error("count failed"), isLoading: false }
          : makeGqlResult({
              OracleSnapshot: Array.from({ length: oracleCount }, (_, i) => ({
                id: `snap-${i}`,
              })),
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
  const qs = new URLSearchParams(params).toString();
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

describe("pool detail route redirects", () => {
  const rawPoolId = "0xaaa0000000000000000000000000000000000001";

  it("redirects raw addresses with explicit chain context to namespaced routes", async () => {
    await expect(
      renderServerPoolPage(rawPoolId, { chainId: "143", tab: "swaps" }),
    ).rejects.toThrow(
      "NEXT_REDIRECT:/pool/143-0xaaa0000000000000000000000000000000000001?tab=swaps",
    );

    expect(redirectMock).toHaveBeenCalledWith(
      "/pool/143-0xaaa0000000000000000000000000000000000001?tab=swaps",
    );
  });

  it("rejects raw addresses without explicit chain context", async () => {
    await expect(renderServerPoolPage(rawPoolId)).rejects.toThrow(
      `NEXT_REDIRECT:${POOL_NOT_FOUND_DEST}`,
    );

    expect(redirectMock).toHaveBeenCalledWith(POOL_NOT_FOUND_DEST);
  });

  it("rejects namespaced routes for unsupported chains", async () => {
    await expect(renderServerPoolPage(`10143-${rawPoolId}`)).rejects.toThrow(
      `NEXT_REDIRECT:${POOL_NOT_FOUND_DEST}`,
    );

    expect(redirectMock).toHaveBeenCalledWith(POOL_NOT_FOUND_DEST);
  });

  it("redirects leading-zero namespaced routes to the canonical prefix", async () => {
    await expect(
      renderServerPoolPage(`00143-${rawPoolId}`, { tab: "reserves" }),
    ).rejects.toThrow(
      "NEXT_REDIRECT:/pool/143-0xaaa0000000000000000000000000000000000001?tab=reserves",
    );

    expect(redirectMock).toHaveBeenCalledWith(
      "/pool/143-0xaaa0000000000000000000000000000000000001?tab=reserves",
    );
  });

  it("renders supported namespaced routes without redirecting", async () => {
    const rendered = await renderServerPoolPage(`143-${rawPoolId}`);

    expect(isValidElement(rendered)).toBe(true);
    expect(redirectMock).not.toHaveBeenCalled();
  });
});

describe("Pool detail tab search", () => {
  it("hydrates swaps search from URL and matches full addresses via labels/raw values", () => {
    const html = renderWithParams({
      tab: "swaps",
      swapsQ: "0xsender000000000000000000000000000000000001",
    });
    expect(html).toContain(
      'value="0xsender000000000000000000000000000000000001"',
    );
    expect(html).toContain("Treasury Wallet");
    expect(html).not.toContain("No swaps match your search.");
  });

  it("shows swaps no-match state from URL-backed search", () => {
    const html = renderWithParams({ tab: "swaps", swapsQ: "not-found" });
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

  it("does not render pool deviation breach status on the oracle tab", () => {
    poolForTest = {
      ...basePool,
      deviationBreachStartedAt: "1700000000",
    };
    const html = renderWithParams({ tab: "oracle" });
    expect(html).not.toContain("Deviation breach started");
    expect(html).not.toContain("Rebalance breach start");
  });

  it("omits pool deviation fields from oracle rows", () => {
    const html = renderWithParams({ tab: "oracle" });
    expect(html).not.toContain("Price Diff");
    expect(html).not.toContain("one-sided");
    expect(html).not.toContain("73,000,000,000 bps");
  });

  it("loads chart and count oracle queries and renders pagination metadata", () => {
    const html = renderWithParams({ tab: "oracle" });
    expect(useGQLMock).toHaveBeenCalledWith(
      ORACLE_SNAPSHOTS_COUNT_PAGE,
      expect.objectContaining({ poolId: "pool-1" }),
    );
    expect(useGQLMock).toHaveBeenCalledWith(
      ORACLE_SNAPSHOTS_CHART,
      expect.objectContaining({ poolId: "pool-1", limit: 1000 }),
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
    const oracleOkButton = Array.from(
      container.querySelectorAll("button"),
    ).find((button) => button.textContent?.includes("Oracle OK")) as
      | HTMLButtonElement
      | undefined;

    expect(oracleOkButton).toBeTruthy();

    act(() => {
      oracleOkButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const ascendingHeaders = Array.from(
      container.querySelectorAll("th"),
    ).filter((th) => th.getAttribute("aria-sort") === "ascending");
    expect(
      ascendingHeaders.some((th) => th.textContent?.includes("Oracle OK")),
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

  it("calls POOL_DAILY_SNAPSHOTS_CHART with poolId only on swaps tab", () => {
    // Swaps tab consumes the daily rollup (server-side day bucketing) to keep
    // full-history charts inside Envio's 1000-row per-query cap.
    renderWithParams({ tab: "swaps" });
    expect(useGQLMock).toHaveBeenCalledWith(
      POOL_DAILY_SNAPSHOTS_CHART,
      { poolId: "pool-1" },
      SNAPSHOT_REFRESH_MS,
    );
  });

  it("renders snapshot chart when snapshots are available on swaps tab", () => {
    const html = renderWithParams({ tab: "swaps" });
    expect(html).toContain("snapshot-chart");
  });

  it("surfaces an inline error on the swaps tab when the daily chart query fails", () => {
    // The rollup entity may be missing during indexer rollout or return a
    // transient failure. The swaps tab must not silently drop the chart —
    // it should render an explicit error so the absence is visible.
    useGQLMock.mockImplementation((query: unknown) => {
      if (query === POOL_DETAIL_WITH_HEALTH)
        return makeGqlResult({ Pool: [basePool] });
      if (query === POOL_THRESHOLDS_KNOWN_EXT) return makeTrustFlagsResult();
      if (query === TRADING_LIMITS)
        return makeGqlResult({ TradingLimit: [] satisfies TradingLimit[] });
      if (query === POOL_DEPLOYMENT)
        return makeGqlResult({ FactoryDeployment: [{ txHash: "0xdeploy" }] });
      if (query === POOL_SWAPS) return makeGqlResult({ SwapEvent: swaps });
      if (query === POOL_DAILY_SNAPSHOTS_CHART)
        return {
          data: null,
          error: new Error("field PoolDailySnapshot not found"),
          isLoading: false,
        };
      return makeGqlResult({});
    });
    const html = renderWithParams({ tab: "swaps" });
    expect(html).toContain("Daily volume chart unavailable");
    expect(html).toContain("field PoolDailySnapshot not found");
    expect(html).not.toContain("snapshot-chart");
  });

  it("calls POOL_DAILY_SNAPSHOTS_CHART on liquidity tab and renders chart", () => {
    const html = renderWithParams({ tab: "liquidity" });
    expect(useGQLMock).toHaveBeenCalledWith(
      POOL_DAILY_SNAPSHOTS_CHART,
      { poolId: "pool-1" },
      SNAPSHOT_REFRESH_MS,
    );
    expect(html).toContain("liquidity-chart");
  });

  it("renders virtual pool current UTC-day exchange volume from the broker exchange rollup", () => {
    vi.setSystemTime(new Date("2026-05-11T12:34:00Z"));
    useGQLMock.mockImplementation((query: unknown) => {
      if (query === POOL_V2_EXCHANGE)
        return {
          data: { BiPoolExchange: [v2ExchangeRow] },
          error: undefined,
          isLoading: false,
        };
      if (query === VIRTUAL_POOL_LIFECYCLE)
        return { data: { VirtualPoolLifecycle: [] }, isLoading: false };
      if (query === BROKER_EXCHANGE_DAILY_SNAPSHOTS_24H)
        return {
          data: {
            BrokerExchangeDailySnapshot: [
              {
                id: `42220-${exchangeId}-1778457600`,
                timestamp: "1778457600",
                volumeUsdWei: "42000000000000000000",
                swapCount: 3,
              },
            ],
          },
          error: undefined,
          isLoading: false,
        };
      return makeGqlResult({});
    });

    const html = renderToStaticMarkup(
      <PoolHeader
        pool={{
          ...basePool,
          source: "virtual_pool",
          wrappedExchangeId: exchangeId,
        }}
        tradingLimits={[]}
      />,
    );
    expect(html).toContain("24h Volume");
    expect(html).toContain("$42.00");
    expect(html).toContain("3 swaps since UTC midnight");
    expect(useGQLMock).toHaveBeenCalledWith(
      BROKER_EXCHANGE_DAILY_SNAPSHOTS_24H,
      {
        chainId: 42220,
        exchangeProvider: v2ExchangeRow.exchangeProvider,
        exchangeId,
        since: Date.UTC(2026, 4, 11) / 1000,
      },
      SNAPSHOT_REFRESH_MS,
      { timeoutMs: HASURA_TIMEOUT_MS },
    );
  });

  it("refreshes the virtual pool volume query when the UTC day changes", () => {
    vi.setSystemTime(new Date("2026-05-11T23:59:59.500Z"));
    const seenSince: number[] = [];
    useGQLMock.mockImplementation(
      (query: unknown, variables?: { since?: number }) => {
        if (query === POOL_V2_EXCHANGE)
          return {
            data: { BiPoolExchange: [v2ExchangeRow] },
            error: undefined,
            isLoading: false,
          };
        if (query === VIRTUAL_POOL_LIFECYCLE)
          return { data: { VirtualPoolLifecycle: [] }, isLoading: false };
        if (query === BROKER_EXCHANGE_DAILY_SNAPSHOTS_24H) {
          if (variables?.since !== undefined) seenSince.push(variables.since);
          return {
            data: { BrokerExchangeDailySnapshot: [] },
            error: undefined,
            isLoading: false,
          };
        }
        return makeGqlResult({});
      },
    );

    interactiveContainer = document.createElement("div");
    document.body.appendChild(interactiveContainer);
    interactiveRoot = createRoot(interactiveContainer);
    act(() => {
      interactiveRoot?.render(
        <PoolHeader
          pool={{
            ...basePool,
            source: "virtual_pool",
            wrappedExchangeId: exchangeId,
          }}
          tradingLimits={[]}
        />,
      );
    });

    expect(seenSince.at(-1)).toBe(Date.UTC(2026, 4, 11) / 1000);

    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(seenSince.at(-1)).toBe(Date.UTC(2026, 4, 12) / 1000);
  });

  it("degrades the virtual pool exchange volume tile visibly when the rollup query fails", () => {
    useGQLMock.mockImplementation((query: unknown) => {
      if (query === POOL_V2_EXCHANGE)
        return {
          data: { BiPoolExchange: [v2ExchangeRow] },
          error: undefined,
          isLoading: false,
        };
      if (query === VIRTUAL_POOL_LIFECYCLE)
        return { data: { VirtualPoolLifecycle: [] }, isLoading: false };
      if (query === BROKER_EXCHANGE_DAILY_SNAPSHOTS_24H) {
        return {
          data: null,
          error: new Error("field BrokerExchangeDailySnapshot not found"),
          isLoading: false,
        };
      }
      return makeGqlResult({});
    });

    const html = renderToStaticMarkup(
      <PoolHeader
        pool={{
          ...basePool,
          source: "virtual_pool",
          wrappedExchangeId: exchangeId,
        }}
        tradingLimits={[]}
      />,
    );
    expect(html).toContain("24h Volume");
    expect(html).toContain("Failed to load exchange volume");
    expect(html).not.toContain("$42.00");
  });

  it("skips snapshot chart query for virtual pools", () => {
    useGQLMock.mockImplementation(
      (query: unknown, variables?: { offset?: number; limit?: number }) => {
        if (query === POOL_DETAIL_WITH_HEALTH)
          return makeGqlResult({
            Pool: [{ ...basePool, source: "virtual_pool" }],
          });
        if (query === POOL_THRESHOLDS_KNOWN_EXT) {
          return makeTrustFlagsResult({ ...basePool, source: "virtual_pool" });
        }
        if (query === TRADING_LIMITS)
          return makeGqlResult({ TradingLimit: [] satisfies TradingLimit[] });
        if (query === POOL_DEPLOYMENT)
          return makeGqlResult({
            FactoryDeployment: [{ txHash: "0xdeploy" }],
          });
        if (query === POOL_SWAPS || query === POOL_SWAPS_PAGE)
          return makeGqlResult({ SwapEvent: swaps });
        if (query === POOL_SWAPS_COUNT)
          return makeGqlResult({ SwapEvent: swaps.map((s) => ({ id: s.id })) });
        if (query === POOL_SNAPSHOTS_CHART)
          return makeGqlResult({ PoolSnapshot: poolSnapshots });
        if (query === POOL_DAILY_SNAPSHOTS_CHART)
          return makeGqlResult({ PoolDailySnapshot: poolSnapshots });
        if (query === POOL_RESERVES)
          return makeGqlResult({ ReserveUpdate: reserves });
        if (query === POOL_REBALANCES || query === POOL_REBALANCES_PAGE)
          return makeGqlResult({ RebalanceEvent: rebalances });
        if (query === POOL_REBALANCES_COUNT)
          return makeGqlResult({
            RebalanceEvent: rebalances.map((r) => ({ id: r.id })),
          });
        if (query === POOL_LIQUIDITY || query === POOL_LIQUIDITY_PAGE)
          return makeGqlResult({ LiquidityEvent: liquidity });
        if (query === POOL_LIQUIDITY_COUNT)
          return makeGqlResult({
            LiquidityEvent: liquidity.map((l) => ({ id: l.id })),
          });
        if (query === ORACLE_SNAPSHOTS)
          return makeGqlResult({
            OracleSnapshot: oracleRows.map((row, index) => ({
              ...row,
              id: `oracle-${(variables?.offset ?? 0) + index + 1}`,
            })),
          });
        if (query === ORACLE_SNAPSHOTS_CHART)
          return makeGqlResult({ OracleSnapshot: oracleRows });
        if (query === ORACLE_SNAPSHOTS_COUNT_PAGE)
          return makeGqlResult({
            OracleSnapshot: Array.from({ length: oracleCount }, (_, i) => ({
              id: `snap-${i}`,
            })),
          });
        return makeGqlResult({});
      },
    );
    const html = renderWithParams({});
    const chartCalls = useGQLMock.mock.calls.filter(
      (args: unknown[]) =>
        args[0] === POOL_SNAPSHOTS_CHART ||
        args[0] === POOL_DAILY_SNAPSHOTS_CHART,
    );
    expect(chartCalls).toHaveLength(0);
    expect(html).not.toContain("snapshot-chart");
  });

  it("preserves newer url params when a debounced search commit fires later", () => {
    const container = renderInteractive({ tab: "swaps" });
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
    expect(window.location.search).toBe("?tab=swaps");

    act(() => {
      window.history.replaceState({}, "", "/pool/pool-1?limit=50");
    });

    act(() => {
      vi.advanceTimersByTime(150);
    });

    const nextParams = new URLSearchParams(window.location.search);
    expect(nextParams.get("limit")).toBe("50");
    expect(nextParams.get("swapsQ")).toBe("0xabc");
  });
});

describe("Pool detail Rebalances tab — degraded rebalanceThreshold rendering", () => {
  // All three fixtures below exercise the `"" sentinel` contract introduced
  // when the boundary-relative effectiveness formula landed: the indexer
  // stamps empty string when `computeEffectivenessRatio` returns null, so
  // the UI must render `—` (not `0.0%`) for those rows — otherwise pre-
  // backfill / VirtualPool / already-in-band rebalances look like KPI-4
  // failures.
  const BOUNDARY_CELL_INDEX = 7;
  const EFFECTIVENESS_CELL_INDEX = 8;

  function overrideRebalances(rows: RebalanceEvent[]) {
    useGQLMock.mockImplementation((query: unknown) => {
      if (query === POOL_DETAIL_WITH_HEALTH)
        return makeGqlResult({ Pool: [basePool] });
      if (query === POOL_THRESHOLDS_KNOWN_EXT) return makeTrustFlagsResult();
      if (query === POOL_REBALANCES || query === POOL_REBALANCES_PAGE)
        return makeGqlResult({ RebalanceEvent: rows });
      if (query === POOL_REBALANCES_COUNT)
        return makeGqlResult({
          RebalanceEvent: rows.map((r) => ({ id: r.id })),
        });
      return makeGqlResult({});
    });
  }

  function renderRebalanceCells(rows: RebalanceEvent[]) {
    overrideRebalances(rows);
    const html = renderWithParams({ tab: "rebalances" });
    const doc = new DOMParser().parseFromString(html, "text/html");
    return Array.from(doc.querySelectorAll("tbody tr td")).map(
      (cell) => cell.textContent?.trim() ?? "",
    );
  }

  it("renders em-dash when rebalanceThreshold is 0 (indexer sentinel)", () => {
    const cells = renderRebalanceCells([
      {
        ...rebalances[0]!,
        id: "rebalance-zero-threshold",
        rebalanceThreshold: 0,
        effectivenessRatio: "",
      },
    ]);
    expect(cells[BOUNDARY_CELL_INDEX]).toBe("—");
    expect(cells[EFFECTIVENESS_CELL_INDEX]).toBe("—");
  });

  it("renders em-dash when rebalanceThreshold is missing (pre-schema-bump row)", () => {
    const cells = renderRebalanceCells([
      {
        ...rebalances[0]!,
        id: "rebalance-null-threshold",
        // rebalanceThreshold omitted (legacy row) — types.ts makes it optional
        rebalanceThreshold: undefined as unknown as number,
        effectivenessRatio: "",
      },
    ]);
    expect(cells[BOUNDARY_CELL_INDEX]).toBe("—");
    expect(cells[EFFECTIVENESS_CELL_INDEX]).toBe("—");
  });

  it("renders a genuine 0.0% rebalance (before == after above threshold) as real signal, not '—'", () => {
    // A non-degenerate no-op rebalance IS a KPI-4 miss and must surface.
    // Distinct from the empty-string degenerate sentinel.
    const cells = renderRebalanceCells([
      {
        ...rebalances[0]!,
        id: "rebalance-genuine-zero",
        rebalanceThreshold: 50,
        effectivenessRatio: "0.0000",
      },
    ]);
    expect(cells[BOUNDARY_CELL_INDEX]).toBe("50");
    expect(cells[EFFECTIVENESS_CELL_INDEX]).toBe("0.0%");
  });

  // POOL_REBALANCES_USD_EXT runs as a separate query keyed by row id (see
  // queries.ts). On Hasura schema lag during deploy the EXT query errors
  // and the Reward column degrades to "—" without breaking the tab.
  const REWARD_CELL_INDEX = 9;

  function overrideRebalancesWithUsdExt(
    rows: RebalanceEvent[],
    extResult: "match" | "empty" | "error",
  ) {
    useGQLMock.mockImplementation((query: unknown) => {
      if (query === POOL_DETAIL_WITH_HEALTH)
        return makeGqlResult({ Pool: [basePool] });
      if (query === POOL_THRESHOLDS_KNOWN_EXT) return makeTrustFlagsResult();
      if (query === POOL_REBALANCES || query === POOL_REBALANCES_PAGE)
        return makeGqlResult({ RebalanceEvent: rows });
      if (query === POOL_REBALANCES_COUNT)
        return makeGqlResult({
          RebalanceEvent: rows.map((r) => ({ id: r.id })),
        });
      if (query === POOL_REBALANCES_USD_EXT) {
        if (extResult === "error")
          return {
            data: null,
            error: new Error("field 'rewardUsd' not found in type"),
            isLoading: false,
          };
        return makeGqlResult({
          RebalanceEvent: extResult === "match" ? rows : [],
        });
      }
      return makeGqlResult({});
    });
  }

  it("renders formatted USD when POOL_REBALANCES_USD_EXT succeeds", () => {
    overrideRebalancesWithUsdExt(
      [
        {
          ...rebalances[0]!,
          id: "rebalance-with-reward",
          amount0Delta: "1000000000000000000000",
          amount1Delta: "-500000000000000000000",
          rewardBps: 25,
          notionalUsd: "1000.0000",
          rewardUsd: "2.5000",
        },
      ],
      "match",
    );
    const html = renderWithParams({ tab: "rebalances" });
    const doc = new DOMParser().parseFromString(html, "text/html");
    const cells = Array.from(doc.querySelectorAll("tbody tr td")).map(
      (cell) => cell.textContent?.trim() ?? "",
    );
    expect(cells[REWARD_CELL_INDEX]).toBe("$2.50");
  });

  it("renders em-dash when EXT query errors (Hasura schema lag)", () => {
    overrideRebalancesWithUsdExt(
      [{ ...rebalances[0]!, id: "rebalance-ext-failed" }],
      "error",
    );
    const html = renderWithParams({ tab: "rebalances" });
    const doc = new DOMParser().parseFromString(html, "text/html");
    const cells = Array.from(doc.querySelectorAll("tbody tr td")).map(
      (cell) => cell.textContent?.trim() ?? "",
    );
    // Tab still renders (main query succeeded); only Reward degrades.
    expect(cells.length).toBeGreaterThan(REWARD_CELL_INDEX);
    expect(cells[REWARD_CELL_INDEX]).toBe("—");
  });

  it("renders em-dash when rewardUsd is empty sentinel ('' = uncomputable)", () => {
    overrideRebalancesWithUsdExt(
      [
        {
          ...rebalances[0]!,
          id: "rebalance-empty-reward",
          rewardUsd: "",
          notionalUsd: "",
        },
      ],
      "match",
    );
    const html = renderWithParams({ tab: "rebalances" });
    const doc = new DOMParser().parseFromString(html, "text/html");
    const cells = Array.from(doc.querySelectorAll("tbody tr td")).map(
      (cell) => cell.textContent?.trim() ?? "",
    );
    expect(cells[REWARD_CELL_INDEX]).toBe("—");
  });
});
