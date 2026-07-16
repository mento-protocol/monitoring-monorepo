import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { PoolDetailInitialData } from "@/lib/pool-detail-initial-data";
import type { PoolBreakerConfigResponse } from "@/lib/queries/config";
import {
  BrokerExchangeDailySnapshots24hSchema,
  PoolBreakerConfigSchema,
  PoolV2ExchangeSchema,
} from "@/lib/queries/pool-detail-schemas";
import type { Pool } from "@/lib/types";
import { SNAPSHOT_REFRESH_MS } from "@/lib/volume";

const mockUseGQL = vi.fn();
const mockReplace = vi.fn();
const mockSearchParams = new URLSearchParams("tab=providers");

vi.mock("@/lib/graphql", () => ({
  HASURA_TIMEOUT_MS: 5000,
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

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    Suspense: ({ children }: { children: ReactNode }) => <>{children}</>,
  };
});

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
  // BreakerPanel/MarketHoursPill render this; no error in these fixtures so it
  // returns null, but the named export must exist under the whole-module mock.
  StaleRefreshNotice: () => null,
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

import { PoolDetailPageClient as PoolDetailPage } from "../_components/pool-detail-page-client";

function renderPoolDetailPage(initialData?: PoolDetailInitialData) {
  return renderToStaticMarkup(
    <PoolDetailPage
      initialSearch={mockSearchParams.toString()}
      initialData={initialData}
    />,
  );
}

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
  tokenDecimalsKnown: true,
};

const V2_EXCHANGE_ID =
  "0x1111111111111111111111111111111111111111111111111111111111111111";
const V2_EXCHANGE_RESPONSE = {
  BiPoolExchange: [
    {
      id: `42220-${V2_EXCHANGE_ID}`,
      chainId: 42220,
      exchangeId: V2_EXCHANGE_ID,
      exchangeProvider: "0x22d9db95e6ae61c104a7b6f6c78d7993b94ec901",
      asset0: "0xt0",
      asset1: "0xt1",
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
      wrappedByPoolId: BASE_POOL.id,
    },
  ],
};
const BROKER_EXCHANGE_24H_RESPONSE = {
  BrokerExchangeDailySnapshot: [
    {
      id: "42220-v2-volume-1778457600",
      timestamp: "1778457600",
      volumeUsdWei: "42000000000000000000",
      swapCount: 3,
    },
  ],
};

const FX_FEED = "0xf4f9bbda9cd6841fcb9b1510f9269e2db42a6e3a";
const BREAKER_CONFIG_RESPONSE: PoolBreakerConfigResponse = {
  BreakerConfig: [
    {
      id: "1",
      enabled: true,
      cooldownTime: "0",
      rateChangeThreshold: "0",
      smoothingFactor: "5000000000000000000000",
      medianRatesEMA: "1171560280196965000000000",
      referenceValue: null,
      lastMedianRate: "1175000000000000000000000",
      lastUpdatedAt: "1700000000",
      status: "OK",
      tradingMode: 0,
      lastStatusUpdatedAt: "1700000000",
      cooldownEndsAt: "0",
      lastTripAt: null,
      lastTripTxHash: null,
      lastResetAt: null,
      tripCountLifetime: 0,
      breaker: {
        id: "b",
        address: "0x49349f92d2b17d491e42c8fdb02d19f072f9b5d9",
        kind: "MEDIAN_DELTA",
        activatesTradingMode: 3,
        defaultCooldownTime: "900",
        defaultRateChangeThreshold: "40000000000000000000000",
      },
    },
  ],
  BreakerTripEvent: [],
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

function loadingGqlResult() {
  return {
    data: undefined,
    error: undefined,
    isLoading: true,
    mutate: vi.fn(),
    isValidating: false,
  };
}

function revalidatingGqlResult(data: unknown, error?: Error) {
  return {
    data,
    error,
    isLoading: true,
    mutate: vi.fn(),
    isValidating: true,
  };
}

function findUseGqlCall(operationName: string) {
  return mockUseGQL.mock.calls.find(([query]) => {
    return (
      typeof query === "string" && query.includes(`query ${operationName}`)
    );
  });
}

describe("Pool detail LPs tab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPoolId = "0xpool";
    mockSearchParams.forEach((_, key) => mockSearchParams.delete(key));
    mockSearchParams.set("tab", "providers");
  });

  it("renders a missing pool without tab chrome or tab content queries", () => {
    const seenQueries: string[] = [];
    mockUseGQL.mockImplementation((query: string | null) => {
      if (query) seenQueries.push(query);
      if (!query) return gqlResult(undefined);
      if (query.includes("PoolDetailWithHealth")) {
        return gqlResult({ Pool: [] });
      }
      if (query.includes("TradingLimits"))
        return gqlResult({ TradingLimit: [] });
      if (query.includes("PoolDeployment")) {
        return gqlResult({ FactoryDeployment: [] });
      }
      return gqlResult(undefined);
    });

    const html = renderPoolDetailPage();
    expect(html).toContain("Pool 0xpool not found.");
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain('role="tabpanel"');
    expect(seenQueries.some((query) => query.includes("PoolLpPositions"))).toBe(
      false,
    );
  });

  it("renders a header-card-shaped skeleton (not 4 flat bars) while the pool is still loading", () => {
    // No SSR fallback and PoolDetailWithHealth still in flight — the
    // degraded loading branch must mirror the route skeleton's header-card
    // geometry (title row + 5-col stat grid), not a generic bar stack
    // (issue #1222).
    mockUseGQL.mockImplementation((query: string | null) => {
      if (!query) return gqlResult(undefined);
      if (query.includes("PoolDetailWithHealth")) {
        return loadingGqlResult();
      }
      if (query.includes("TradingLimits"))
        return gqlResult({ TradingLimit: [] });
      if (query.includes("PoolDeployment")) {
        return gqlResult({ FactoryDeployment: [] });
      }
      return gqlResult(undefined);
    });

    const html = renderPoolDetailPage();
    expect(html).toContain('aria-label="Loading pool"');
    const dlOpenTag = html.match(/<div[^>]*lg:grid-cols-5[^>]*>/)?.[0] ?? "";
    expect(dlOpenTag).not.toBe("");
    expect(html).not.toContain("Pool 0xpool not found.");
  });

  it("keeps last-confirmed pool data visible and discloses a refresh failure", () => {
    const initialData: PoolDetailInitialData = {
      pool: {
        Pool: [
          {
            ...BASE_POOL,
            oracleOk: true,
            oracleTimestamp: "1700000090",
            oracleExpiry: "300",
            oracleFreshnessCheckedAt: 1_700_000_100,
          },
        ],
      },
    };
    mockUseGQL.mockImplementation((query: string | null) => {
      if (!query) return gqlResult(undefined);
      if (query.includes("PoolDetailWithHealth")) {
        return revalidatingGqlResult(
          initialData.pool,
          new Error("pool refresh timeout"),
        );
      }
      if (query.includes("TradingLimits"))
        return gqlResult({ TradingLimit: [] });
      if (query.includes("PoolDeployment")) {
        return gqlResult({ FactoryDeployment: [] });
      }
      return gqlResult(undefined);
    });

    const html = renderPoolDetailPage(initialData);

    expect(html).toContain("Pool health inputs refresh failed");
    expect(html).toContain("showing the last confirmed state");
    expect(html).toContain("pool refresh timeout");
    expect(html).toContain("GBPm/USDm");
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

    const html = renderPoolDetailPage();
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

  it("gates token amount tab content when token decimals are unverified", () => {
    mockSearchParams.set("tab", "reserves");

    mockUseGQL.mockImplementation((query: string | null) => {
      if (!query) return gqlResult(undefined);
      if (query.includes("PoolDetailWithHealth")) {
        return gqlResult({ Pool: [BASE_POOL] });
      }
      if (query.includes("PoolThresholdsKnownExt")) {
        return gqlResult({
          Pool: [{ id: BASE_POOL.id, tokenDecimalsKnown: false }],
        });
      }
      if (query.includes("TradingLimits"))
        return gqlResult({ TradingLimit: [] });
      if (query.includes("PoolDeployment")) {
        return gqlResult({ FactoryDeployment: [] });
      }
      if (query.includes("PoolReserves")) {
        return gqlResult({
          ReserveUpdate: [
            {
              id: "reserve-1",
              chainId: 42220,
              poolId: BASE_POOL.id,
              reserve0: "1000000",
              reserve1: "2000000",
              blockTimestampInPool: "1700000000",
              txHash: "0xreserve",
              blockNumber: "123",
              blockTimestamp: "1700000000",
            },
          ],
        });
      }
      return gqlResult(undefined);
    });

    const html = renderPoolDetailPage();
    expect(html).toContain("Token decimals are unverified for this pool");
    expect(html).toContain(
      "Token amount tab data is hidden because token decimals are unverified for this pool.",
    );
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("0xreserve");
    expect(firedOperationNames()).not.toContain("PoolReserves");
  });

  it("gates rebalances tab content when token decimals are unverified", () => {
    mockSearchParams.set("tab", "rebalances");

    mockUseGQL.mockImplementation((query: string | null) => {
      if (!query) return gqlResult(undefined);
      if (query.includes("PoolDetailWithHealth")) {
        return gqlResult({ Pool: [BASE_POOL] });
      }
      if (query.includes("PoolThresholdsKnownExt")) {
        return gqlResult({
          Pool: [{ id: BASE_POOL.id, tokenDecimalsKnown: false }],
        });
      }
      if (query.includes("TradingLimits"))
        return gqlResult({ TradingLimit: [] });
      if (query.includes("PoolDeployment")) {
        return gqlResult({ FactoryDeployment: [] });
      }
      if (query.includes("PoolRebalances")) {
        return gqlResult({
          RebalanceEvent: [
            {
              id: "rebalance-1",
              txHash: "0xrebalance",
              blockNumber: "123",
              blockTimestamp: "1700000000",
            },
          ],
        });
      }
      return gqlResult(undefined);
    });

    const html = renderPoolDetailPage();
    expect(html).toContain("Token decimals are unverified for this pool");
    expect(html).toContain(
      "Token amount tab data is hidden because token decimals are unverified for this pool.",
    );
    expect(html).not.toContain("0xrebalance");
    expect(firedOperationNames()).not.toContain("PoolRebalancesCount");
    expect(firedOperationNames()).not.toContain("PoolRebalancesPage");
  });

  it("shows a loading gate without firing amount tab queries while decimal trust loads", () => {
    mockSearchParams.set("tab", "reserves");

    mockUseGQL.mockImplementation((query: string | null) => {
      if (!query) return gqlResult(undefined);
      if (query.includes("PoolDetailWithHealth")) {
        return gqlResult({ Pool: [BASE_POOL] });
      }
      if (query.includes("PoolThresholdsKnownExt")) {
        return loadingGqlResult();
      }
      if (query.includes("TradingLimits"))
        return gqlResult({ TradingLimit: [] });
      if (query.includes("PoolDeployment")) {
        return gqlResult({ FactoryDeployment: [] });
      }
      if (query.includes("PoolReserves")) {
        return gqlResult({
          ReserveUpdate: [
            {
              id: "reserve-1",
              chainId: 42220,
              poolId: BASE_POOL.id,
              reserve0: "1000000",
              reserve1: "2000000",
              blockTimestampInPool: "1700000000",
              txHash: "0xreserve",
              blockNumber: "123",
              blockTimestamp: "1700000000",
            },
          ],
        });
      }
      return gqlResult(undefined);
    });

    const html = renderPoolDetailPage();
    expect(html).toContain(
      "Checking token decimal metadata before rendering token amount tab data.",
    );
    expect(html).toContain("loading");
    expect(html).not.toContain("0xreserve");
    expect(firedOperationNames()).not.toContain("PoolReserves");
  });

  it("treats SSR threshold fallback data as loaded during mount revalidation errors", () => {
    mockSearchParams.set("tab", "reserves");
    const initialData: PoolDetailInitialData = {
      pool: { Pool: [BASE_POOL] },
      thresholds: {
        Pool: [
          {
            id: BASE_POOL.id,
            rebalanceThresholdsKnown: true,
            tokenDecimalsKnown: true,
          },
        ],
      },
    };

    mockUseGQL.mockImplementation((query: string | null) => {
      if (!query) return gqlResult(undefined);
      if (query.includes("PoolDetailWithHealth")) {
        return revalidatingGqlResult(initialData.pool);
      }
      if (query.includes("PoolThresholdsKnownExt")) {
        return revalidatingGqlResult(
          initialData.thresholds,
          new Error("transient trust query failure"),
        );
      }
      if (query.includes("TradingLimits"))
        return gqlResult({ TradingLimit: [] });
      if (query.includes("PoolDeployment")) {
        return gqlResult({ FactoryDeployment: [] });
      }
      if (query.includes("PoolReserves")) {
        return gqlResult({
          ReserveUpdate: [
            {
              id: "reserve-1",
              chainId: 42220,
              poolId: BASE_POOL.id,
              reserve0: "1000000",
              reserve1: "2000000",
              blockTimestampInPool: "1700000000",
              txHash: "0xreserve",
              blockNumber: "123",
              blockTimestamp: "1700000000",
            },
          ],
        });
      }
      return gqlResult(undefined);
    });

    const html = renderPoolDetailPage(initialData);

    expect(html).not.toContain(
      "Checking token decimal metadata before rendering token amount tab data.",
    );
    expect(html).not.toContain(
      "Token amount tab data is hidden until token decimal metadata can be verified.",
    );
    expect(firedOperationNames()).toContain("PoolReserves");
    expect(findUseGqlCall("PoolDetailWithHealth")?.[3]).toMatchObject({
      fallbackData: initialData.pool,
      timeoutMs: 5000,
    });
    expect(findUseGqlCall("PoolThresholdsKnownExt")?.[3]).toMatchObject({
      timeoutMs: 5000,
      fallbackData: initialData.thresholds,
    });
    expect(html).toContain("Pool health inputs refresh failed");
    expect(html).toContain("transient trust query failure");
  });

  it("paints the exact all-time volume headline from SSR pool counters while snapshot history revalidates", () => {
    const poolWithVolume: Pool = {
      ...BASE_POOL,
      notionalVolume0: "100000000000000000000",
      notionalVolume1: "125000000000000000000",
    };
    const initialData: PoolDetailInitialData = {
      pool: { Pool: [poolWithVolume] },
      thresholds: {
        Pool: [
          {
            id: poolWithVolume.id,
            rebalanceThresholdsKnown: true,
            tokenDecimalsKnown: true,
          },
        ],
      },
    };

    mockUseGQL.mockImplementation((query: string | null) => {
      if (!query) return gqlResult(undefined);
      if (query.includes("PoolDetailWithHealth")) {
        return revalidatingGqlResult(initialData.pool);
      }
      if (query.includes("PoolThresholdsKnownExt")) {
        return revalidatingGqlResult(initialData.thresholds);
      }
      if (query.includes("PoolDailySnapshotsChart")) {
        // This is the real first-paint condition: chart history only starts
        // after hydration, while the exact Pool cumulative counters already
        // arrived in the Server Component fallback.
        return loadingGqlResult();
      }
      if (query.includes("TradingLimits")) {
        return gqlResult({ TradingLimit: [] });
      }
      if (query.includes("PoolDeployment")) {
        return gqlResult({ FactoryDeployment: [] });
      }
      return gqlResult(undefined);
    });

    const html = renderPoolDetailPage(initialData);

    expect(html).toMatch(
      />Volume<\/p><p[^>]*>\$125\.00<\/p>[\s\S]*?animate-pulse/,
    );
    expect(findUseGqlCall("PoolDailySnapshotsChart")?.[2]).toBe(
      SNAPSHOT_REFRESH_MS,
    );
  });

  it("threads SSR fallbacks into VirtualPool header extension queries", () => {
    const virtualPool: Pool = {
      ...BASE_POOL,
      source: "virtual_pool",
      wrappedExchangeId: V2_EXCHANGE_ID,
    };
    const initialData: PoolDetailInitialData = {
      pool: { Pool: [virtualPool] },
      thresholds: {
        Pool: [
          {
            id: virtualPool.id,
            rebalanceThresholdsKnown: true,
            tokenDecimalsKnown: true,
          },
        ],
      },
      v2Exchange: V2_EXCHANGE_RESPONSE,
      brokerExchange24h: BROKER_EXCHANGE_24H_RESPONSE,
    };

    mockUseGQL.mockImplementation((query: string | null) => {
      if (!query) return gqlResult(undefined);
      if (query.includes("PoolDetailWithHealth")) {
        return revalidatingGqlResult(initialData.pool);
      }
      if (query.includes("PoolThresholdsKnownExt")) {
        return revalidatingGqlResult(initialData.thresholds);
      }
      if (query.includes("PoolV2Exchange")) {
        return revalidatingGqlResult(
          initialData.v2Exchange,
          new Error("transient v2 query failure"),
        );
      }
      if (query.includes("BrokerExchangeDailySnapshots24h")) {
        return revalidatingGqlResult(
          initialData.brokerExchange24h,
          new Error("transient exchange volume query failure"),
        );
      }
      if (query.includes("TradingLimits"))
        return gqlResult({ TradingLimit: [] });
      if (query.includes("PoolDeployment")) {
        return gqlResult({ FactoryDeployment: [] });
      }
      return gqlResult(undefined);
    });

    const html = renderPoolDetailPage(initialData);

    expect(findUseGqlCall("PoolV2Exchange")?.[3]).toMatchObject({
      fallbackData: initialData.v2Exchange,
      schema: PoolV2ExchangeSchema,
    });
    expect(
      findUseGqlCall("BrokerExchangeDailySnapshots24h")?.[3],
    ).toMatchObject({
      timeoutMs: 5000,
      fallbackData: initialData.brokerExchange24h,
      schema: BrokerExchangeDailySnapshots24hSchema,
    });
    expect(html).toContain("ConstantSum");
    expect(html).not.toContain("v2 exchange config unavailable");
    expect(html).toContain("$42.00");
    expect(html).toContain("3 swaps since UTC midnight");
  });

  it("threads the SSR breaker-config fallback into BreakerPanel and MarketHoursPill", () => {
    const fxPool: Pool = { ...BASE_POOL, referenceRateFeedID: FX_FEED };
    const initialData: PoolDetailInitialData = {
      pool: { Pool: [fxPool] },
      breakerConfig: BREAKER_CONFIG_RESPONSE,
    };

    mockUseGQL.mockImplementation((query: string | null) => {
      if (!query) return gqlResult(undefined);
      if (query.includes("PoolDetailWithHealth")) {
        return revalidatingGqlResult(initialData.pool);
      }
      if (query.includes("PoolBreakerConfig")) {
        // SWR keeps `isLoading` true while it revalidates the fallback; the
        // panel must still paint the resolved shape from `data`, not a shimmer.
        return revalidatingGqlResult(
          initialData.breakerConfig,
          new Error("transient breaker query failure"),
        );
      }
      if (query.includes("TradingLimits"))
        return gqlResult({ TradingLimit: [] });
      if (query.includes("PoolDeployment")) {
        return gqlResult({ FactoryDeployment: [] });
      }
      return gqlResult(undefined);
    });

    const html = renderPoolDetailPage(initialData);

    // Both consumers of POOL_BREAKER_CONFIG (BreakerPanel + MarketHoursPill)
    // receive the same fallbackData — the options object is the 4th positional
    // useGQL argument (index 3); arg[2] stays `refreshMs` per the repo's
    // useGQL call-shape invariant (use-gql-shape.test.ts).
    const breakerCalls = mockUseGQL.mock.calls.filter(
      ([query]) =>
        typeof query === "string" && query.includes("query PoolBreakerConfig"),
    );
    expect(breakerCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of breakerCalls) {
      expect(call[3]).toMatchObject({
        fallbackData: initialData.breakerConfig,
        schema: PoolBreakerConfigSchema,
      });
    }
    // Resolved shape paints on first render (no `h-[78px]` shimmer cell): the
    // full MedianDelta strip, not the loading skeleton or a null collapse.
    expect(html).toContain("MedianDelta");
    expect(html).toContain("Threshold / Cooldown");
    expect(html).not.toContain("h-[78px]");
  });

  it("does NOT thread the SSR breaker-config fallback when the pool revalidated to a different feed (Codex finding, issue #1257)", () => {
    // The SSR breakerConfig was fetched for feed A, but the pool row revalidates
    // to feed B (self-heal / governance feed update). BreakerPanel and
    // MarketHoursPill key their request off the NEW feed — forwarding the
    // feed-A fallback would present the old feed's breaker/market-hours state as
    // the new feed's "last confirmed state". The fallback must be gated off.
    const FEED_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const feedAPool: Pool = { ...BASE_POOL, referenceRateFeedID: FX_FEED };
    const feedBPool: Pool = { ...BASE_POOL, referenceRateFeedID: FEED_B };
    const initialData: PoolDetailInitialData = {
      pool: { Pool: [feedAPool] }, // SSR row + breakerConfig are for feed A
      breakerConfig: BREAKER_CONFIG_RESPONSE,
    };

    mockUseGQL.mockImplementation((query: string | null) => {
      if (!query) return gqlResult(undefined);
      if (query.includes("PoolDetailWithHealth")) {
        // The live pool row is now feed B, not the SSR feed A.
        return revalidatingGqlResult({ Pool: [feedBPool] });
      }
      if (query.includes("PoolBreakerConfig")) {
        // New-feed request in flight / failing — no data yet.
        return revalidatingGqlResult(undefined, new Error("transient"));
      }
      if (query.includes("TradingLimits"))
        return gqlResult({ TradingLimit: [] });
      if (query.includes("PoolDeployment")) {
        return gqlResult({ FactoryDeployment: [] });
      }
      return gqlResult(undefined);
    });

    renderPoolDetailPage(initialData);

    const breakerCalls = mockUseGQL.mock.calls.filter(
      ([query]) =>
        typeof query === "string" && query.includes("query PoolBreakerConfig"),
    );
    expect(breakerCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of breakerCalls) {
      // The stale feed-A fallback is NOT forwarded to the feed-B request —
      // SWR loads the new feed cleanly instead of showing wrong-feed data.
      expect(call[3]?.fallbackData).toBeUndefined();
    }
  });

  it("gates token amount tab content when the trust query fails", () => {
    mockSearchParams.set("tab", "reserves");

    mockUseGQL.mockImplementation((query: string | null) => {
      if (!query) return gqlResult(undefined);
      if (query.includes("PoolDetailWithHealth")) {
        return gqlResult({ Pool: [BASE_POOL] });
      }
      if (query.includes("PoolThresholdsKnownExt")) {
        return gqlResult(undefined, new Error("field not found"));
      }
      if (query.includes("TradingLimits"))
        return gqlResult({ TradingLimit: [] });
      if (query.includes("PoolDeployment")) {
        return gqlResult({ FactoryDeployment: [] });
      }
      if (query.includes("PoolReserves")) {
        return gqlResult({
          ReserveUpdate: [
            {
              id: "reserve-1",
              chainId: 42220,
              poolId: BASE_POOL.id,
              reserve0: "1000000",
              reserve1: "2000000",
              blockTimestampInPool: "1700000000",
              txHash: "0xreserve",
              blockNumber: "123",
              blockTimestamp: "1700000000",
            },
          ],
        });
      }
      return gqlResult(undefined);
    });

    const html = renderPoolDetailPage();
    expect(html).toContain("Token decimal metadata is unavailable");
    expect(html).toContain(
      "Token amount tab data is hidden until token decimal metadata can be verified.",
    );
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("0xreserve");
    expect(firedOperationNames()).not.toContain("PoolReserves");
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

    const html = renderPoolDetailPage();
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

    const html = renderPoolDetailPage();
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

    const html = renderPoolDetailPage();
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

    const html = renderPoolDetailPage();
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

    const html = renderPoolDetailPage();
    // The explorer link should use the raw hex address, not the namespaced form.
    expect(html).not.toContain("42220-0xd8da6bf2");
    expect(html).toContain("0xd8da6bf2");
  });

  // Extracts the GraphQL operation name (`query FooBar(...)` → "FooBar") from
  // every useGQL call recorded by the mock. Matching on exact operation names
  // avoids substring collisions — e.g. "OracleSnapshots" would otherwise match
  // the header-hook query `OracleSnapshotsWindow` which is not tab-scoped.
  function firedOperationNames(): string[] {
    return mockUseGQL.mock.calls.flatMap((args) => {
      const q = args[0];
      if (typeof q !== "string") return [];
      const m = q.match(/\bquery\s+([A-Za-z_][A-Za-z0-9_]*)/);
      return m && m[1] ? [m[1]] : [];
    });
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
  // Tab-EXCLUSIVE GraphQL operation names — ops listed here only fire when
  // their tab is mounted. Shared ops (e.g. PoolRebalances, fired by both
  // SwapsTab for chart annotations AND RebalancesTab) are deliberately
  // excluded so the lazy-mount loop doesn't false-positive on tabs that
  // legitimately reuse a query.
  const TAB_OPS: Record<TabWithQueries, readonly string[]> = {
    swaps: ["PoolSwapsPage"],
    reserves: ["PoolReserves"],
    rebalances: ["PoolRebalancesPage"],
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

    renderPoolDetailPage();

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

    renderPoolDetailPage();

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

  // Characterization test added before tab-extraction refactor: extend the
  // lazy-mount contract assertion to ALL eight tab-scoped tabs (the existing
  // two `it()` cases above already cover `reserves` and `oracle`; this loop
  // covers the remaining six and re-asserts those two for completeness).
  // Ensures that switching to tab N never mounts tab M's data hooks. The
  // `limits` tab has no tab-local queries and is therefore not in TAB_OPS.
  //
  // The OlsPool mock returns one active row so the OLS tab stays visible —
  // without it, the page filters "ols" out of visibleTabs and falls back to
  // "providers", spuriously mounting LpsTab.
  it.each(Object.keys(TAB_OPS) as (keyof typeof TAB_OPS)[])(
    "lazy-mount: tab=%s does not fire any other tab's queries",
    (activeTab) => {
      mockSearchParams.set("tab", activeTab);

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

      renderPoolDetailPage();

      const fired = new Set(firedOperationNames());
      for (const [tabName, ops] of Object.entries(TAB_OPS)) {
        if (tabName === activeTab) continue;
        for (const op of ops) {
          expect(
            fired.has(op),
            `${op} (${tabName} tab) should not fire on tab=${activeTab}`,
          ).toBe(false);
        }
      }
    },
  );

  it("keeps the OLS search count warning visible during stale event revalidation", () => {
    mockSearchParams.set("tab", "ols");
    mockSearchParams.set("olsQ", "expand");

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
      if (query.includes("OlsLiquidityEventsCount")) {
        return gqlResult(undefined, new Error("count failed"));
      }
      if (query.includes("OlsLiquidityEventsPage")) {
        return gqlResult(
          {
            OlsLiquidityEvent: [
              {
                id: "event-1",
                chainId: 42220,
                poolId: "42220-0xpool",
                olsAddress: "0xols",
                direction: 0,
                caller: "0x0000000000000000000000000000000000000001",
                tokenGivenToPool: "0xt0",
                amountGivenToPool: "1000000000000000000",
                tokenTakenFromPool: "0xt1",
                amountTakenFromPool: "2000000000000000000",
                txHash: "0xexpand",
                blockNumber: "123",
                blockTimestamp: "1700000000",
              },
            ],
          },
          new Error("event poll failed"),
        );
      }
      return gqlResult(undefined);
    });

    const html = renderPoolDetailPage();
    expect(html).toContain("Could not load total count");
    expect(html).toContain("search covers the most recent");
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

    renderPoolDetailPage();
  });
});
