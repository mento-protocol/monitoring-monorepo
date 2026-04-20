import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/networks", () => {
  const network = {
    id: "celo-mainnet" as const,
    label: "Celo",
    chainId: 42220,
    contractsNamespace: "mainnet" as string | null,
    hasuraUrl: "https://hasura.example.com/v1/graphql",
    hasuraSecret: "",
    explorerBaseUrl: "https://celoscan.io",
    tokenSymbols: {
      "0xaaa0000000000000000000000000000000000001": "cUSD",
      "0xaaa0000000000000000000000000000000000002": "USDm",
    },
    addressLabels: {},
    local: false,
    testnet: false,
    hasVirtualPools: true,
  };
  return {
    NETWORKS: { "celo-mainnet": network },
    NETWORK_IDS: ["celo-mainnet"],
    networkIdForChainId: (chainId: number) =>
      chainId === 42220 ? "celo-mainnet" : null,
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
import { fetchPoolOgDataUncached } from "../pool-og";

const ADDR_CUSD = "0xaaa0000000000000000000000000000000000001";
const ADDR_USDM = "0xaaa0000000000000000000000000000000000002";
const POOL_ID = `42220-${ADDR_CUSD}`;

function mockRequest(impl: (query: string) => unknown) {
  // pool-og.ts uses the object-form `client.request({ document, variables,
  // signal })` so we can wire AbortSignal.timeout per call.
  (
    GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
  ).mockImplementation(async (arg: string | { document: string }) =>
    impl(typeof arg === "string" ? arg : arg.document),
  );
}

function makeDetailPool(overrides: Record<string, unknown> = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    id: POOL_ID,
    chainId: 42220,
    token0: ADDR_USDM,
    token1: ADDR_CUSD,
    token0Decimals: 18,
    token1Decimals: 18,
    source: "FPMM",
    createdAtBlock: "1",
    createdAtTimestamp: "1000",
    updatedAtBlock: "2",
    updatedAtTimestamp: "2000",
    oraclePrice: "1000000000000000000000000",
    oracleOk: true,
    oracleTimestamp: String(nowSec),
    oracleExpiry: "300",
    reserves0: "1000000000000000000000000",
    reserves1: "1000000000000000000000000",
    priceDifference: "0",
    rebalanceThreshold: 10000,
    limitStatus: "OK",
    limitPressure0: "0",
    limitPressure1: "0",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("fetchPoolOgDataUncached", () => {
  it("returns null for garbage or empty input", async () => {
    expect(await fetchPoolOgDataUncached("garbage")).toBeNull();
    expect(await fetchPoolOgDataUncached("")).toBeNull();
  });

  it("returns null for unknown chain prefix", async () => {
    expect(await fetchPoolOgDataUncached(`9999-${ADDR_CUSD}`)).toBeNull();
  });

  it("returns null when the detail query yields no Pool row", async () => {
    mockRequest((q) => {
      if (q.includes("PoolDailySnapshot")) return { PoolDailySnapshot: [] };
      return { Pool: [] };
    });
    expect(await fetchPoolOgDataUncached(POOL_ID)).toBeNull();
  });

  it("returns null only when the detail query fails", async () => {
    // Every request rejects → no detail → null (pool unknowable).
    (
      GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error("hasura down"));
    expect(await fetchPoolOgDataUncached(POOL_ID)).toBeNull();
  });

  it("degrades gracefully when daily snapshots query fails", async () => {
    const detailPool = makeDetailPool();
    mockRequest((q) => {
      if (q.includes("PoolDailySnapshot")) throw new Error("daily down");
      return { Pool: [detailPool] };
    });
    const result = await fetchPoolOgDataUncached(POOL_ID);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("cUSD/USDm");
    expect(result!.chainLabel).toBe("Celo");
    expect(result!.tvlUsd).toBeGreaterThan(0);
    expect(result!.volume7dUsd).toBeNull();
    expect(result!.tvlWoWPct).toBeNull();
    expect(result!.tvlSeries).toEqual([]);
    expect(result!.volumeSeries).toEqual([]);
  });

  it("degrades gracefully when all-pools rate-map query fails", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const detailPool = makeDetailPool();
    mockRequest((q) => {
      if (q.includes("AllPoolsWithHealth")) throw new Error("allpools down");
      if (q.includes("PoolDailySnapshot")) {
        return {
          PoolDailySnapshot: [
            {
              poolId: POOL_ID,
              timestamp: String(nowSec - 86_400),
              reserves0: "900000000000000000000000",
              reserves1: "900000000000000000000000",
              swapVolume0: "10000000000000000000000",
              swapVolume1: "10000000000000000000000",
            },
          ],
        };
      }
      return { Pool: [detailPool] };
    });
    const result = await fetchPoolOgDataUncached(POOL_ID);
    expect(result).not.toBeNull();
    // USDm leg → poolTvlUSD / volume math don't need the rate map
    expect(result!.name).toBe("cUSD/USDm");
    expect(result!.tvlUsd).toBeGreaterThan(0);
    expect(result!.volume7dUsd).toBeGreaterThan(0);
  });

  it("returns null WoW when the only baseline row is older than 14 days", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const detailPool = makeDetailPool();
    mockRequest((q) => {
      if (q.includes("PoolDailySnapshot")) {
        return {
          PoolDailySnapshot: [
            {
              poolId: POOL_ID,
              timestamp: String(nowSec - 86_400),
              reserves0: "1000000000000000000000000",
              reserves1: "1000000000000000000000000",
              swapVolume0: "0",
              swapVolume1: "0",
            },
            {
              // 20 days ago — outside the [now-14d, now-7d] WoW window.
              poolId: POOL_ID,
              timestamp: String(nowSec - 20 * 86_400),
              reserves0: "500000000000000000000000",
              reserves1: "500000000000000000000000",
              swapVolume0: "0",
              swapVolume1: "0",
            },
          ],
        };
      }
      return { Pool: [detailPool] };
    });
    const result = await fetchPoolOgDataUncached(POOL_ID);
    expect(result).not.toBeNull();
    expect(result!.tvlWoWPct).toBeNull();
  });

  it("rejects bare-address URLs — OG must not resolve differently from page", async () => {
    // Bare 0x addresses would need cross-chain probing, but the pool page
    // uses DEFAULT_NETWORK only. Accepting them here would produce OG
    // previews for a chain the page can't load.
    expect(await fetchPoolOgDataUncached(ADDR_CUSD)).toBeNull();
  });

  it("derives full payload for a USDm/cUSD pool", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const detailPool = makeDetailPool();
    mockRequest((q) => {
      if (q.includes("PoolDailySnapshot")) {
        return {
          PoolDailySnapshot: [
            {
              poolId: POOL_ID,
              timestamp: String(nowSec - 86_400),
              reserves0: "900000000000000000000000",
              reserves1: "900000000000000000000000",
              swapVolume0: "100000000000000000000000",
              swapVolume1: "100000000000000000000000",
            },
            {
              poolId: POOL_ID,
              timestamp: String(nowSec - 7 * 86_400 - 100),
              reserves0: "800000000000000000000000",
              reserves1: "800000000000000000000000",
              swapVolume0: "50000000000000000000000",
              swapVolume1: "50000000000000000000000",
            },
          ],
        };
      }
      return { Pool: [detailPool] };
    });

    const result = await fetchPoolOgDataUncached(POOL_ID);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("cUSD/USDm");
    expect(result!.chainLabel).toBe("Celo");
    expect(result!.tokenSymbols).toEqual(["USDm", "cUSD"]);
    expect(result!.tvlUsd).toBeCloseTo(2_000_000, -2);
    // Current 7d window captures row 1 only (100K USDm volume); row 2 falls
    // in the prior-7d window (50K). WoW = (100K - 50K) / 50K * 100 = 100%.
    expect(result!.volume7dUsd).toBeCloseTo(100_000, -2);
    expect(result!.volume7dWoWPct).toBeCloseTo(100, 0);
    expect(result!.tvlWoWPct).toBeCloseTo(25, 0);
    expect(result!.health).toBe("OK");
    expect(result!.healthReasons).toEqual([]);
    // Sparkline: newest-first rows reversed → oldest→newest TVL values.
    // Snapshot 2 (7d-ago) reserves 800K+800K = 1.6M, snapshot 1 (1d-ago) 900K+900K = 1.8M.
    expect(result!.tvlSeries).toHaveLength(2);
    expect(result!.tvlSeries[0]).toBeCloseTo(1_600_000, -2);
    expect(result!.tvlSeries[1]).toBeCloseTo(1_800_000, -2);
    // Volume series is per-day USDm-leg value, oldest→newest: 50K (7d-ago), 100K (1d-ago).
    expect(result!.volumeSeries).toHaveLength(2);
    expect(result!.volumeSeries[0]).toBeCloseTo(50_000, -2);
    expect(result!.volumeSeries[1]).toBeCloseTo(100_000, -2);
    expect(result!.oracleFresh).toBe(true);
    expect(result!.oracleAgeSeconds).toBeGreaterThanOrEqual(0);
    expect(result!.oracleAgeSeconds).toBeLessThan(60);
  });

  it("marks oracle stale when past the expiry window", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const detailPool = makeDetailPool({
      oracleTimestamp: String(nowSec - 3600),
      oracleExpiry: "300",
    });
    mockRequest((q) => {
      if (q.includes("PoolDailySnapshot")) return { PoolDailySnapshot: [] };
      return { Pool: [detailPool] };
    });
    const result = await fetchPoolOgDataUncached(POOL_ID);
    expect(result).not.toBeNull();
    expect(result!.oracleFresh).toBe(false);
    expect(result!.oracleAgeSeconds).toBeGreaterThanOrEqual(3600);
  });

  it("preserves volume7dUsd=0 as a real state (not collapsed with null)", async () => {
    // Pool exists and had daily snapshots, but zero swaps — valid signal
    // ("inactive pool"), must not be hidden as "unavailable".
    const nowSec = Math.floor(Date.now() / 1000);
    const detailPool = makeDetailPool();
    mockRequest((q) => {
      if (q.includes("PoolDailySnapshot")) {
        return {
          PoolDailySnapshot: [
            {
              poolId: POOL_ID,
              timestamp: String(nowSec - 86_400),
              reserves0: "1000000000000000000000000",
              reserves1: "1000000000000000000000000",
              swapVolume0: "0",
              swapVolume1: "0",
            },
          ],
        };
      }
      return { Pool: [detailPool] };
    });
    const result = await fetchPoolOgDataUncached(POOL_ID);
    expect(result).not.toBeNull();
    expect(result!.volume7dUsd).toBe(0);
    expect(result!.volume7dUsd).not.toBeNull();
  });

  it("surfaces limit-breach via effective health (oracle OK, limit CRITICAL)", async () => {
    const detailPool = makeDetailPool({
      limitStatus: "CRITICAL",
      limitPressure0: "1.1",
      limitPressure1: "0",
    });
    mockRequest((q) => {
      if (q.includes("PoolDailySnapshot")) return { PoolDailySnapshot: [] };
      return { Pool: [detailPool] };
    });
    const result = await fetchPoolOgDataUncached(POOL_ID);
    expect(result).not.toBeNull();
    // `health` is effective-status (worst of oracle + limit), so a limit
    // breach surfaces here. Label in UI reads "Health" (not "Rebalance") —
    // see buildDescription/buildAlt/Tile label="Health".
    expect(result!.health).toBe("CRITICAL");
    expect(result!.healthReasons).toContain("trading limits breached");
  });

  it("uses 'rebalance in flight' (not 'breach') when grace window applies", async () => {
    // A deviation breach that was very recently rebalanced is transient —
    // computeHealthStatus softens the *status* to WARN, so the *reason*
    // must match or the tile contradicts itself.
    const nowSec = Math.floor(Date.now() / 1000);
    const detailPool = makeDetailPool({
      priceDifference: "15000", // 1.5x threshold → > 1.0
      rebalanceThreshold: 10000,
      lastRebalancedAt: String(nowSec - 1800), // 30m ago → within 1h grace
    });
    mockRequest((q) => {
      if (q.includes("PoolDailySnapshot")) return { PoolDailySnapshot: [] };
      return { Pool: [detailPool] };
    });
    const result = await fetchPoolOgDataUncached(POOL_ID);
    expect(result).not.toBeNull();
    expect(result!.health).toBe("WARN");
    expect(result!.healthReasons).toContain("rebalance in flight");
    expect(result!.healthReasons).not.toContain("price deviation breach");
  });

  it("orders healthReasons by severity (worst first)", async () => {
    // Limit CRITICAL + deviation WARN: the subline pulls reasons[0], so
    // highest-severity reason must be first or it will misstate the pool.
    const detailPool = makeDetailPool({
      priceDifference: "8500", // 0.85x threshold → WARN
      rebalanceThreshold: 10000,
      limitStatus: "CRITICAL",
      limitPressure0: "1.1", // ≥ 1.0 → CRITICAL
    });
    mockRequest((q) => {
      if (q.includes("PoolDailySnapshot")) return { PoolDailySnapshot: [] };
      return { Pool: [detailPool] };
    });
    const result = await fetchPoolOgDataUncached(POOL_ID);
    expect(result).not.toBeNull();
    expect(result!.health).toBe("CRITICAL");
    expect(result!.healthReasons[0]).toBe("trading limits breached");
    expect(result!.healthReasons).toContain("price deviation rising");
  });

  it("explains a WARN health as 'price deviation rising' when applicable", async () => {
    // Oracle fresh, deviation at 85% of threshold — healthy oracle, rising
    // price. computeHealthStatus → WARN; reason should surface via
    // healthReasons so the card explains *why* attention is needed.
    const detailPool = makeDetailPool({
      priceDifference: "8500",
      rebalanceThreshold: 10000,
    });
    mockRequest((q) => {
      if (q.includes("PoolDailySnapshot")) return { PoolDailySnapshot: [] };
      return { Pool: [detailPool] };
    });
    const result = await fetchPoolOgDataUncached(POOL_ID);
    expect(result).not.toBeNull();
    expect(result!.health).toBe("WARN");
    expect(result!.healthReasons).toContain("price deviation rising");
  });

  it("suppresses TVL-derived fields for unpriceable FX/FX pool when rate map unavailable", async () => {
    // FX/FX pool (no USDm leg) needs ALL_POOLS_WITH_HEALTH to build the
    // rate map. If that query fails, poolTvlUSD silently returns 0 — we
    // must not ship fake $0 TVL / flat sparkline / "TVL $0.00" alt text.
    const ADDR_EURM = "0xbbb0000000000000000000000000000000000003";
    const ADDR_GBPM = "0xbbb0000000000000000000000000000000000004";
    const fxPool = makeDetailPool({
      token0: ADDR_EURM,
      token1: ADDR_GBPM,
    });
    mockRequest((q) => {
      if (q.includes("AllPoolsWithHealth")) throw new Error("allpools down");
      if (q.includes("PoolDailySnapshot")) {
        const nowSec = Math.floor(Date.now() / 1000);
        return {
          PoolDailySnapshot: [
            {
              poolId: POOL_ID,
              timestamp: String(nowSec - 86_400),
              reserves0: "1000000000000000000000000",
              reserves1: "1000000000000000000000000",
              swapVolume0: "0",
              swapVolume1: "0",
            },
          ],
        };
      }
      return { Pool: [fxPool] };
    });
    const result = await fetchPoolOgDataUncached(POOL_ID);
    expect(result).not.toBeNull();
    // `null` = unpriceable, NOT `0`. `0` would falsely suggest an empty pool.
    expect(result!.tvlUsd).toBeNull();
    expect(result!.volume7dUsd).toBeNull();
    expect(result!.volume7dWoWPct).toBeNull();
    expect(result!.tvlWoWPct).toBeNull();
    expect(result!.tvlSeries).toEqual([]);
    expect(result!.volumeSeries).toEqual([]);
  });
});
