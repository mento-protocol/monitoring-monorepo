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
    expect(result!.partial).toBe(false);
    expect(result!.offlineChains).toEqual([]);
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

  it("flags partial + names offline chain when one chain's pool query fails", async () => {
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
    // Surviving chain's numbers are still present, but the card is
    // explicitly flagged partial so consumers don't present "Celo + Monad"
    // numbers labeled as protocol-wide.
    expect(result!.partial).toBe(true);
    expect(result!.offlineChains).toEqual(["Celo"]);
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

  it("includes VirtualPool swap volume in protocol totals", async () => {
    // VirtualPools can't contribute TVL (no reserves), but the dashboard's
    // protocol volume total explicitly counts their swaps. The OG card has
    // to match or shared previews disagree with what users see.
    const nowSec = Math.floor(Date.now() / 1000);
    const fpmmPool = makePool(42220, POOL_CELO, ADDR_USDM_CELO, ADDR_CUSD_CELO);
    const VIRTUAL_POOL_ID = `42220-0xaaa0000000000000000000000000000000000009`;
    const virtualPool = makePool(
      42220,
      VIRTUAL_POOL_ID,
      ADDR_USDM_CELO,
      ADDR_CUSD_CELO,
      { source: "virtual_factory", oraclePrice: "0" },
    );
    const recentRow = {
      timestamp: String(nowSec - 86_400),
      reserves0: "0",
      reserves1: "0",
      swapVolume0: "40000000000000000000000", // 40K USDm
      swapVolume1: "40000000000000000000000",
    };
    routeByChain({
      42220: (doc) => {
        if (doc.includes("PoolDailySnapshot")) {
          return {
            PoolDailySnapshot: [
              { poolId: POOL_CELO, ...recentRow },
              { poolId: VIRTUAL_POOL_ID, ...recentRow },
            ],
          };
        }
        return { Pool: [fpmmPool, virtualPool] };
      },
      143: (doc) => {
        if (doc.includes("PoolDailySnapshot")) return { PoolDailySnapshot: [] };
        return { Pool: [] };
      },
    });

    const result = await fetchHomepageOgDataUncached();
    expect(result).not.toBeNull();
    // FPMM 40K + VirtualPool 40K = 80K. If volume filtered by isFpmm we'd
    // only see 40K.
    expect(result!.totalVolume7dUsd).toBeCloseTo(80_000, -2);
  });

  it("truncates attentionPools at MAX_ATTENTION_POOLS + CRITICAL first", async () => {
    // Make 5 attention pools (3 CRITICAL, 2 WARN) split across chains; the
    // card must show at most 3, CRITICAL-first, alphabetical within rank.
    const mkPool = (
      chainId: number,
      suffix: string,
      t0: string,
      t1: string,
      overrides: Record<string, unknown>,
    ) =>
      makePool(
        chainId,
        `${chainId}-0xaaa000000000000000000000000000000000${suffix}`,
        t0,
        t1,
        overrides,
      );
    const CRIT = {
      limitStatus: "CRITICAL",
      limitPressure0: "1.1",
    };
    const WARN = { priceDifference: "8500", rebalanceThreshold: 10000 };
    routeByChain({
      42220: (doc) => {
        if (doc.includes("PoolDailySnapshot")) return { PoolDailySnapshot: [] };
        return {
          Pool: [
            mkPool(42220, "0001", ADDR_USDM_CELO, ADDR_CUSD_CELO, CRIT),
            mkPool(42220, "0002", ADDR_CUSD_CELO, ADDR_USDM_CELO, CRIT),
            mkPool(42220, "0003", ADDR_USDM_CELO, ADDR_CUSD_CELO, WARN),
          ],
        };
      },
      143: (doc) => {
        if (doc.includes("PoolDailySnapshot")) return { PoolDailySnapshot: [] };
        return {
          Pool: [
            mkPool(143, "0004", ADDR_USDM_MONAD, ADDR_GBPM_MONAD, CRIT),
            mkPool(143, "0005", ADDR_USDM_MONAD, ADDR_GBPM_MONAD, WARN),
          ],
        };
      },
    });

    const result = await fetchHomepageOgDataUncached();
    expect(result).not.toBeNull();
    expect(result!.attentionPools).toHaveLength(3);
    // All three shown should be CRITICAL (WARN ones drop off the cap).
    for (const p of result!.attentionPools) {
      expect(p.health).toBe("CRITICAL");
    }
    expect(result!.healthBuckets.CRITICAL).toBe(3);
    expect(result!.healthBuckets.WARN).toBe(2);
  });

  it("includes dormant but funded pools in the TVL series", async () => {
    // Pool has live reserves (contributes to totalTvlUsd) but no snapshots
    // in the 35d window — e.g. a pool that hasn't had activity recently.
    // Without the seed-from-current-reserves fallback, this pool would be
    // dropped from the chart entirely and the line would end below the
    // hero number. Every bucket must include its current TVL.
    const celoPool = makePool(42220, POOL_CELO, ADDR_USDM_CELO, ADDR_CUSD_CELO);
    routeByChain({
      42220: (doc) => {
        if (doc.includes("PoolDailySnapshot")) return { PoolDailySnapshot: [] };
        return { Pool: [celoPool] };
      },
      143: (doc) => {
        if (doc.includes("PoolDailySnapshot")) return { PoolDailySnapshot: [] };
        return { Pool: [] };
      },
    });

    const result = await fetchHomepageOgDataUncached();
    expect(result).not.toBeNull();
    // Pool has 1M USDm + 1M cUSD @ $1 → $2M live TVL.
    expect(result!.totalTvlUsd).toBeCloseTo(2_000_000, -2);
    expect(result!.tvlSeries.length).toBeGreaterThan(0);
    // Every chart bucket should show the same live TVL — a flat line at
    // $2M, matching the hero number. If the seed were missing, bucket
    // values would be 0.
    for (const tvl of result!.tvlSeries) {
      expect(tvl).toBeCloseTo(2_000_000, -2);
    }
  });

  it("paginates daily snapshots past the 1000-row Hasura cap", async () => {
    // Hasura silently caps at 1000 rows. Pagination must walk forward via
    // offset until a short page arrives. Return 1000 rows on page 0 and
    // 1 row on page 1 — the aggregator must see both.
    const nowSec = Math.floor(Date.now() / 1000);
    const celoPool = makePool(42220, POOL_CELO, ADDR_USDM_CELO, ADDR_CUSD_CELO);
    const fullPage = Array.from({ length: 1000 }, (_, i) => ({
      poolId: POOL_CELO,
      timestamp: String(nowSec - i * 3600), // descending, 1h apart — same day-bucketing behavior is fine for test
      reserves0: "1000000000000000000000000",
      reserves1: "1000000000000000000000000",
      swapVolume0: "0",
      swapVolume1: "0",
    }));
    const finalPage = [
      {
        poolId: POOL_CELO,
        timestamp: String(nowSec - 2_000 * 3600),
        reserves0: "500000000000000000000000",
        reserves1: "500000000000000000000000",
        swapVolume0: "0",
        swapVolume1: "0",
      },
    ];
    let celoDailyCallCount = 0;
    routeByChain({
      42220: (doc) => {
        if (doc.includes("PoolDailySnapshot")) {
          celoDailyCallCount++;
          return {
            PoolDailySnapshot: celoDailyCallCount === 1 ? fullPage : finalPage,
          };
        }
        return { Pool: [celoPool] };
      },
      143: (doc) => {
        if (doc.includes("PoolDailySnapshot")) return { PoolDailySnapshot: [] };
        return { Pool: [] };
      },
    });

    const result = await fetchHomepageOgDataUncached();
    expect(result).not.toBeNull();
    // Both pages fetched → not degraded (final page came back short).
    // If pagination were broken (single-page only), we'd expect
    // `volumeSeries === []` via the 1000-cap degraded path.
    expect(celoDailyCallCount).toBeGreaterThan(1);
    expect(result!.volumeSeries.length).toBeGreaterThan(0);
  });

  it("does not flag degraded when pagination exhausts the safety cap with full pages", async () => {
    // Regression guard for PR #165 Codex P1 (comment id 3112391489):
    // The daily query is ordered newest-first with $since: DAILY_SINCE_DAYS,
    // so the first DAILY_MAX_PAGES × DAILY_PAGE_SIZE rows always cover the
    // OG card's read windows (TVL_CHART_DAYS, 14d volume, 7d WoW). Hitting
    // the cap just means the chain has more lifetime history than the
    // window — it is NOT a correctness signal and must NOT null out
    // daily-derived aggregates. Only exceptions should flip dailyDegraded.
    const nowSec = Math.floor(Date.now() / 1000);
    const celoPool = makePool(42220, POOL_CELO, ADDR_USDM_CELO, ADDR_CUSD_CELO);
    // Rows span the last 30 days with a meaningful swap volume so the
    // aggregator's daily-derived fields come back non-null/non-empty on
    // the happy path. If a future change were to re-flip degraded on
    // cap-hit, these assertions would fail.
    const fullPage = Array.from({ length: 1000 }, (_, i) => ({
      poolId: POOL_CELO,
      timestamp: String(nowSec - i * 3600),
      reserves0: "1000000000000000000000000",
      reserves1: "1000000000000000000000000",
      swapVolume0: "10000000000000000000000", // 10K per row
      swapVolume1: "10000000000000000000000",
    }));
    let celoDailyCallCount = 0;
    routeByChain({
      42220: (doc) => {
        if (doc.includes("PoolDailySnapshot")) {
          celoDailyCallCount++;
          // Always return a full page — simulates the chain having more
          // rows than DAILY_MAX_PAGES × DAILY_PAGE_SIZE can cover.
          return { PoolDailySnapshot: fullPage };
        }
        return { Pool: [celoPool] };
      },
      143: (doc) => {
        if (doc.includes("PoolDailySnapshot")) return { PoolDailySnapshot: [] };
        return { Pool: [] };
      },
    });

    const result = await fetchHomepageOgDataUncached();
    expect(result).not.toBeNull();
    // Pagination ran all the way to the cap without breaking early.
    expect(celoDailyCallCount).toBe(5);
    // Non-degraded: daily-derived aggregates come back populated.
    expect(result!.totalVolume7dUsd).not.toBeNull();
    expect(result!.totalVolume7dUsd!).toBeGreaterThan(0);
    expect(result!.volumeSeries.length).toBeGreaterThan(0);
    expect(result!.tvlSeries.length).toBeGreaterThan(0);
    // Live TVL and pool count are reported as usual.
    expect(result!.totalTvlUsd).toBeGreaterThan(0);
    expect(result!.poolCount).toBe(1);
    // Not a chain-offline case either — the pool query succeeded.
    expect(result!.partial).toBe(false);
    expect(result!.offlineChains).toEqual([]);
  });
});
