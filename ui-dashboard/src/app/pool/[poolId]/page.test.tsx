import { beforeEach, describe, expect, it, vi } from "vitest";
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
const getLabelMock = vi.fn((address: string | null | undefined) => {
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

vi.mock("next/navigation", () => ({
  useParams: () => ({ poolId: encodeURIComponent("pool-1") }),
  useRouter: () => ({ replace: replaceMock }),
  useSearchParams: () => currentSearchParams,
}));

vi.mock("@/components/network-provider", () => ({
  useNetwork: () => ({
    network: {
      id: "celo-mainnet-hosted",
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
  useAddressLabels: () => ({ getLabel: getLabelMock }),
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
    <td>{getLabelMock(address)}</td>
  ),
}));
vi.mock("@/components/table", () => ({
  Row: ({ children }: { children: React.ReactNode }) => <tr>{children}</tr>,
  Table: ({ children }: { children: React.ReactNode }) => (
    <table>{children}</table>
  ),
  Td: ({ children }: { children: React.ReactNode }) => <td>{children}</td>,
  Th: ({ children }: { children: React.ReactNode }) => <th>{children}</th>,
}));
vi.mock("@/components/table-search", () => ({
  TableSearch: ({
    value,
    ariaLabel,
  }: {
    value: string;
    ariaLabel?: string;
  }) => <input aria-label={ariaLabel} value={value} readOnly />,
}));
vi.mock("@/components/tx-hash-cell", () => ({
  TxHashCell: ({ txHash }: { txHash: string }) => <td>{txHash}</td>,
}));

import PoolDetailPage from "./page";

let currentSearchParams = new URLSearchParams();

const basePool: Pool = {
  id: "pool-1",
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
    poolId: "pool-1",
    source: "median-feed",
    oracleOk: true,
    oraclePrice: "1100000000000000000000000",
    priceDifference: "42",
    rebalanceThreshold: 12,
    numReporters: 5,
    blockNumber: "5001",
    timestamp: "1700000600",
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
  replaceMock.mockReset();
  useGQLMock.mockReset();
  getLabelMock.mockClear();

  useGQLMock.mockImplementation((query: unknown) => {
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
      return makeGqlResult({ OracleSnapshot: oracleRows });
    return makeGqlResult({});
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
});
