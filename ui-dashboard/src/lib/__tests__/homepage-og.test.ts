import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted above `const` declarations, so defining the test
// fixtures inside vi.hoisted keeps the mock factory + the test bodies
// referencing the same values without ReferenceError.
const fixtures = vi.hoisted(() => ({
  ADDR_USDM_CELO: "0xaaa0000000000000000000000000000000000001",
  ADDR_CUSD_CELO: "0xaaa0000000000000000000000000000000000002",
  ADDR_USDM_MONAD: "0xbbb0000000000000000000000000000000000001",
  ADDR_GBPM_MONAD: "0xbbb0000000000000000000000000000000000002",
}));
const { ADDR_USDM_CELO, ADDR_CUSD_CELO, ADDR_USDM_MONAD, ADDR_GBPM_MONAD } =
  fixtures;

const POOL_CELO = `42220-${ADDR_CUSD_CELO}`;
const POOL_MONAD = `143-${ADDR_GBPM_MONAD}`;

vi.mock("@/lib/networks", () => {
  const celo = {
    id: "celo-mainnet" as const,
    label: "Celo",
    chainId: 42220,
    contractsNamespace: "mainnet" as string | null,
    hasuraUrl: "https://hasura-celo.example/v1/graphql",
    hasuraSecret: "",
    explorerBaseUrl: "https://celoscan.io",
    tokenSymbols: {
      [fixtures.ADDR_USDM_CELO]: "USDm",
      [fixtures.ADDR_CUSD_CELO]: "cUSD",
    },
    addressLabels: {},
    local: false,
    testnet: false,
    hasVirtualPools: true,
  };
  const monad = {
    id: "monad-mainnet" as const,
    label: "Monad",
    chainId: 143,
    contractsNamespace: null as string | null,
    hasuraUrl: "https://hasura-monad.example/v1/graphql",
    hasuraSecret: "",
    explorerBaseUrl: "https://monadscan.com",
    tokenSymbols: {
      [fixtures.ADDR_USDM_MONAD]: "USDm",
      [fixtures.ADDR_GBPM_MONAD]: "GBPm",
    },
    addressLabels: {},
    local: false,
    testnet: false,
    hasVirtualPools: false,
  };
  return {
    NETWORKS: { "celo-mainnet": celo, "monad-mainnet": monad },
    NETWORK_IDS: ["celo-mainnet", "monad-mainnet"],
    networkIdForChainId: (c: number) =>
      c === 42220 ? "celo-mainnet" : c === 143 ? "monad-mainnet" : null,
    isCanonicalNetwork: () => true,
    isNetworkId: () => true,
    isConfiguredNetworkId: () => true,
  };
});

vi.mock("graphql-request", () => {
  const MockGraphQLClient = vi.fn();
  MockGraphQLClient.prototype.request = vi.fn();
  return { GraphQLClient: MockGraphQLClient };
});

import { GraphQLClient } from "graphql-request";
import { fetchHomepageOgDataUncached } from "../homepage-og";

function makePool(
  chainId: number,
  poolId: string,
  token0: string,
  token1: string,
  overrides: Record<string, unknown> = {},
) {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    id: poolId,
    chainId,
    token0,
    token1,
    token0Decimals: 18,
    token1Decimals: 18,
    source: "FPMM",
    createdAtBlock: "1",
    createdAtTimestamp: "1000",
    updatedAtBlock: "2",
    updatedAtTimestamp: "2000",
    oraclePrice: "1000000000000000000000000", // 1.0 at 24dp
    oracleOk: true,
    oracleTimestamp: String(nowSec),
    oracleExpiry: "300",
    reserves0: "1000000000000000000000000", // 1M
    reserves1: "1000000000000000000000000", // 1M
    priceDifference: "0",
    rebalanceThreshold: 10000,
    limitStatus: "OK",
    limitPressure0: "0",
    limitPressure1: "0",
    ...overrides,
  };
}

type QueryHandler = (doc: string) => unknown;

// Dispatch per-chain by reading the chainId embedded in each query's
// variables: ALL_POOLS_WITH_HEALTH passes chainId directly; daily-snapshot
// queries carry a poolIds array, each prefixed with `<chainId>-`.
function routeByChain(handlers: Record<number, QueryHandler>) {
  (
    GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
  ).mockImplementation(async (arg: unknown) => {
    const vars = (
      arg as { variables?: { chainId?: number; poolIds?: string[] } }
    ).variables;
    const doc = (arg as { document: string }).document;
    let chainId = vars?.chainId;
    if (chainId == null && vars?.poolIds?.[0]) {
      chainId = Number(vars.poolIds[0].split("-")[0]);
    }
    if (chainId == null || !handlers[chainId]) {
      throw new Error(`no mock handler for chainId ${chainId}`);
    }
    return handlers[chainId](doc);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("fetchHomepageOgDataUncached", () => {
  it("aggregates TVL and pool count across chains", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const celoPool = makePool(42220, POOL_CELO, ADDR_USDM_CELO, ADDR_CUSD_CELO);
    const monadPool = makePool(
      143,
      POOL_MONAD,
      ADDR_USDM_MONAD,
      ADDR_GBPM_MONAD,
    );
    const stableSnapshot = {
      timestamp: String(nowSec - 86_400),
      reserves0: "1000000000000000000000000",
      reserves1: "1000000000000000000000000",
      swapVolume0: "100000000000000000000000", // 100K
      swapVolume1: "100000000000000000000000",
    };
    const priorSnapshot = {
      timestamp: String(nowSec - 8 * 86_400),
      reserves0: "900000000000000000000000",
      reserves1: "900000000000000000000000",
      swapVolume0: "50000000000000000000000", // 50K
      swapVolume1: "50000000000000000000000",
    };
    routeByChain({
      42220: (doc) => {
        if (doc.includes("PoolDailySnapshot"))
          return {
            PoolDailySnapshot: [
              { poolId: POOL_CELO, ...stableSnapshot },
              { poolId: POOL_CELO, ...priorSnapshot },
            ],
          };
        return { Pool: [celoPool] };
      },
      143: (doc) => {
        if (doc.includes("PoolDailySnapshot"))
          return {
            PoolDailySnapshot: [
              { poolId: POOL_MONAD, ...stableSnapshot },
              { poolId: POOL_MONAD, ...priorSnapshot },
            ],
          };
        return { Pool: [monadPool] };
      },
    });

    const result = await fetchHomepageOgDataUncached();
    expect(result).not.toBeNull();
    // 2M per pool × 2 pools = 4M total TVL
    expect(result!.totalTvlUsd).toBeCloseTo(4_000_000, -2);
    expect(result!.poolCount).toBe(2);
    expect(result!.chainCount).toBe(2);
    expect(result!.chains).toEqual(["Celo", "Monad"]);
    // Current 7d window captures 1d-ago snapshot for each pool → 100K USDm × 2 = 200K
    expect(result!.totalVolume7dUsd).toBeCloseTo(200_000, -2);
    // Prior 7d window captures 8d-ago snapshot → 50K × 2 = 100K.
    // WoW = (200K - 100K) / 100K = 100%.
    expect(result!.volume7dWoWPct).toBeCloseTo(100, 0);
    // Both pools healthy (priceDifference=0, limits OK) → OK bucket = 2.
    expect(result!.healthBuckets.OK).toBe(2);
    expect(result!.healthBuckets.WARN).toBe(0);
    expect(result!.healthBuckets.CRITICAL).toBe(0);
    expect(result!.attentionPools).toEqual([]);
    // Forward-filled TVL series: 30 UTC-day buckets ending today (matches
    // the dashboard's default "1M" range). Latest bucket uses the most
    // recent snapshot (1d-ago, 1M+1M=2M per pool × 2 pools = 4M). Middle
    // buckets forward-fill from the 8d-ago snapshot (0.9M+0.9M=1.8M ×
    // 2 = 3.6M). Early buckets before the 8d snapshot contribute 0.
    expect(result!.tvlSeries).toHaveLength(30);
    expect(result!.tvlSeries[29]).toBeCloseTo(4_000_000, -2);
    // Forward-fill must carry the prior snapshot across gap days — so the
    // middle of the series sees the 3.6M sum.
    expect(result!.tvlSeries.some((v) => Math.abs(v - 3_600_000) < 1000)).toBe(
      true,
    );
  });

  it("surfaces attention pools ordered CRITICAL first", async () => {
    const criticalPool = makePool(
      42220,
      POOL_CELO,
      ADDR_USDM_CELO,
      ADDR_CUSD_CELO,
      {
        limitStatus: "CRITICAL",
        limitPressure0: "1.1",
      },
    );
    const warnPool = makePool(
      143,
      POOL_MONAD,
      ADDR_USDM_MONAD,
      ADDR_GBPM_MONAD,
      {
        priceDifference: "8500", // devRatio 0.85 → WARN
      },
    );
    routeByChain({
      42220: (doc) => {
        if (doc.includes("PoolDailySnapshot")) return { PoolDailySnapshot: [] };
        return { Pool: [criticalPool] };
      },
      143: (doc) => {
        if (doc.includes("PoolDailySnapshot")) return { PoolDailySnapshot: [] };
        return { Pool: [warnPool] };
      },
    });

    const result = await fetchHomepageOgDataUncached();
    expect(result).not.toBeNull();
    expect(result!.healthBuckets.CRITICAL).toBe(1);
    expect(result!.healthBuckets.WARN).toBe(1);
    expect(result!.attentionPools).toHaveLength(2);
    expect(result!.attentionPools[0].health).toBe("CRITICAL");
    expect(result!.attentionPools[0].chainLabel).toBe("Celo");
    expect(result!.attentionPools[1].health).toBe("WARN");
  });

  it("degrades gracefully when a chain's pool query fails", async () => {
    const monadPool = makePool(
      143,
      POOL_MONAD,
      ADDR_USDM_MONAD,
      ADDR_GBPM_MONAD,
    );
    routeByChain({
      42220: () => {
        throw new Error("celo down");
      },
      143: (doc) => {
        if (doc.includes("PoolDailySnapshot")) return { PoolDailySnapshot: [] };
        return { Pool: [monadPool] };
      },
    });

    const result = await fetchHomepageOgDataUncached();
    expect(result).not.toBeNull();
    expect(result!.poolCount).toBe(1);
    expect(result!.chainCount).toBe(1);
    expect(result!.chains).toEqual(["Monad"]);
  });

  it("returns null when every chain fails", async () => {
    routeByChain({
      42220: () => {
        throw new Error("down");
      },
      143: () => {
        throw new Error("down");
      },
    });
    expect(await fetchHomepageOgDataUncached()).toBeNull();
  });

  it("returns null volume fields when daily queries fail but pools succeed", async () => {
    const celoPool = makePool(42220, POOL_CELO, ADDR_USDM_CELO, ADDR_CUSD_CELO);
    routeByChain({
      42220: (doc) => {
        if (doc.includes("PoolDailySnapshot")) throw new Error("daily down");
        return { Pool: [celoPool] };
      },
      143: (doc) => {
        if (doc.includes("PoolDailySnapshot")) throw new Error("daily down");
        return { Pool: [] };
      },
    });

    const result = await fetchHomepageOgDataUncached();
    expect(result).not.toBeNull();
    expect(result!.totalTvlUsd).toBeGreaterThan(0);
    expect(result!.totalVolume7dUsd).toBeNull();
    expect(result!.volume7dWoWPct).toBeNull();
    expect(result!.volumeSeries).toEqual([]);
    expect(result!.tvlSeries).toEqual([]);
  });
});
