import { describe, expect, it } from "vitest";
import {
  buildTokenUsdTimeSeries,
  circulatingSupplyForSnapshot,
  computeChartStartSeconds,
  rangeStartSeconds,
  rollupByToken,
  sumTotalUsdSeries,
  winnersAndLosers7d,
} from "./aggregate";
import type {
  StableSupplyDailySnapshot,
  StableTokenCustodyDailySnapshot,
} from "./types";

// 2024-05-22 00:00:00 UTC. Anchoring tests in the past keeps "7d ago"
// math consistent regardless of when the suite runs.
const NOW_TS = BigInt(1_716_336_000);
const DAY = 86_400;

function snapshot(
  overrides: Partial<StableSupplyDailySnapshot> &
    Pick<StableSupplyDailySnapshot, "timestamp" | "totalSupply">,
): StableSupplyDailySnapshot {
  const chainId = overrides.chainId ?? 42220;
  return {
    id: `${chainId}-${overrides.tokenAddress ?? "0xa"}-${overrides.timestamp}`,
    chainId,
    tokenAddress: overrides.tokenAddress ?? "0xa",
    tokenSymbol: overrides.tokenSymbol ?? "USDm",
    source: overrides.source ?? "V2_RESERVE",
    tokenDecimals: overrides.tokenDecimals ?? 18,
    timestamp: overrides.timestamp,
    totalSupply: overrides.totalSupply,
    dailyMintAmount: overrides.dailyMintAmount ?? "0",
    dailyBurnAmount: overrides.dailyBurnAmount ?? "0",
  };
}

function custodySnapshot(
  overrides: Partial<StableTokenCustodyDailySnapshot> &
    Pick<StableTokenCustodyDailySnapshot, "timestamp" | "lockedSupply">,
): StableTokenCustodyDailySnapshot {
  return {
    id: `42220-${overrides.tokenAddress ?? "0xa"}-${overrides.timestamp}`,
    chainId: overrides.chainId ?? 42220,
    tokenAddress: overrides.tokenAddress ?? "0xa",
    tokenSymbol: overrides.tokenSymbol ?? "USDm",
    source: overrides.source ?? "V2_RESERVE",
    tokenDecimals: overrides.tokenDecimals ?? 18,
    managerAddress:
      overrides.managerAddress ?? "0xbbfbe2791722e93f27c5ce80e3725c8dd8d09697",
    timestamp: overrides.timestamp,
    lockedSupply: overrides.lockedSupply,
    dailyLockedAmount: overrides.dailyLockedAmount ?? "0",
    dailyUnlockedAmount: overrides.dailyUnlockedAmount ?? "0",
  };
}

describe("rollupByToken", () => {
  it("groups by (tokenAddress, source) and computes 7d net change", () => {
    const usdm = "0xa";
    const eurm = "0xb";
    const snapshots: StableSupplyDailySnapshot[] = [
      snapshot({
        tokenAddress: usdm,
        timestamp: String(Number(NOW_TS) - 14 * DAY),
        totalSupply: String(BigInt(1_000_000) * BigInt(10) ** BigInt(18)),
      }),
      snapshot({
        tokenAddress: usdm,
        timestamp: String(Number(NOW_TS) - 7 * DAY),
        totalSupply: String(BigInt(900_000) * BigInt(10) ** BigInt(18)),
      }),
      snapshot({
        tokenAddress: usdm,
        timestamp: String(NOW_TS),
        totalSupply: String(BigInt(1_100_000) * BigInt(10) ** BigInt(18)),
      }),
      snapshot({
        tokenAddress: eurm,
        tokenSymbol: "EURm",
        timestamp: String(NOW_TS),
        totalSupply: String(BigInt(500_000) * BigInt(10) ** BigInt(18)),
      }),
    ];
    const rates = new Map([
      ["USDm", 1.0],
      ["EURm", 1.1],
    ]);
    const rollup = rollupByToken(snapshots, rates, NOW_TS);

    expect(rollup.size).toBe(2);
    const usdmAgg = rollup.get(`42220|${usdm}|V2_RESERVE`);
    expect(usdmAgg).toBeDefined();
    // 7d baseline = 900_000 (7d-ago snapshot); now = 1_100_000 → +200_000
    expect(usdmAgg!.netChange7d).toBe(
      BigInt(200_000) * BigInt(10) ** BigInt(18),
    );
    expect(usdmAgg!.netChange7dUsd).toBeCloseTo(200_000, 0);
    expect(usdmAgg!.totalSupplyUsdLatest).toBeCloseTo(1_100_000, 0);
  });

  it("returns null USD fields when no oracle rate is available", () => {
    const snapshots: StableSupplyDailySnapshot[] = [
      snapshot({
        tokenSymbol: "BRLm",
        timestamp: String(NOW_TS),
        totalSupply: String(BigInt(1_000) * BigInt(10) ** BigInt(18)),
      }),
    ];
    const rollup = rollupByToken(snapshots, new Map(), NOW_TS);
    const agg = Array.from(rollup.values())[0]!;
    expect(agg.totalSupplyUsdLatest).toBeNull();
    expect(agg.netChange7dUsd).toBeNull();
  });

  it("keeps V2 cUSD-USDm and V3 hub USDm as separate rows (same symbol, distinct addresses)", () => {
    const snapshots: StableSupplyDailySnapshot[] = [
      snapshot({
        tokenAddress: "0xa",
        source: "V2_RESERVE",
        timestamp: String(NOW_TS),
        totalSupply: String(BigInt(100) * BigInt(10) ** BigInt(18)),
      }),
      snapshot({
        tokenAddress: "0xb",
        source: "V3_HUB_COLLATERAL",
        timestamp: String(NOW_TS),
        totalSupply: String(BigInt(200) * BigInt(10) ** BigInt(18)),
      }),
    ];
    const rollup = rollupByToken(snapshots, new Map([["USDm", 1]]), NOW_TS);
    expect(rollup.size).toBe(2);
    expect(rollup.has("42220|0xa|V2_RESERVE")).toBe(true);
    expect(rollup.has("42220|0xb|V3_HUB_COLLATERAL")).toBe(true);
  });

  it("keeps same token address on Celo and Monad as separate rows", () => {
    const snapshots: StableSupplyDailySnapshot[] = [
      snapshot({
        chainId: 42220,
        tokenAddress: "0xa",
        timestamp: String(NOW_TS),
        totalSupply: String(BigInt(100) * BigInt(10) ** BigInt(18)),
      }),
      snapshot({
        chainId: 143,
        tokenAddress: "0xa",
        timestamp: String(NOW_TS),
        totalSupply: String(BigInt(50) * BigInt(10) ** BigInt(18)),
      }),
    ];
    const rollup = rollupByToken(snapshots, new Map([["USDm", 1]]), NOW_TS);
    expect(rollup.size).toBe(2);
    expect(rollup.get("42220|0xa|V2_RESERVE")?.latestTotalSupply).toBe(
      BigInt(100) * BigInt(10) ** BigInt(18),
    );
    expect(rollup.get("143|0xa|V2_RESERVE")?.latestTotalSupply).toBe(
      BigInt(50) * BigInt(10) ** BigInt(18),
    );
  });

  it("subtracts lock-custody snapshots from Celo circulating supply", () => {
    const rawSupply = String(BigInt(300) * BigInt(10) ** BigInt(18));
    const lockedSupply = String(BigInt(80) * BigInt(10) ** BigInt(18));
    const row = snapshot({
      tokenAddress: "0xc",
      tokenSymbol: "GBPm",
      source: "V3_LIQUITY",
      timestamp: String(NOW_TS),
      totalSupply: rawSupply,
    });
    const custody = [
      custodySnapshot({
        tokenAddress: "0xc",
        tokenSymbol: "GBPm",
        source: "V3_LIQUITY",
        timestamp: String(NOW_TS),
        lockedSupply,
      }),
    ];
    expect(circulatingSupplyForSnapshot(row, custody)).toBe(
      BigInt(220) * BigInt(10) ** BigInt(18),
    );

    const rollup = rollupByToken(
      [row],
      new Map([["GBPm", 1.3]]),
      NOW_TS,
      custody,
    );
    const agg = rollup.get("42220|0xc|V3_LIQUITY");
    expect(agg?.latestTotalSupply).toBe(BigInt(220) * BigInt(10) ** BigInt(18));
    expect(agg?.latestLockedSupply).toBe(BigInt(80) * BigInt(10) ** BigInt(18));
    expect(agg?.totalSupplyUsdLatest).toBeCloseTo(286, 0);
  });
});

describe("rangeStartSeconds", () => {
  it("anchors on dayStart - (N-1)*86400 — keeps the day count fixed under partial-day loads", () => {
    // 2024-05-22 18:00:00 UTC (mid-day)
    const midDay = Number(NOW_TS) + 18 * 3600;
    const start7d = rangeStartSeconds("7d", midDay);
    // dayStart = 2024-05-22 00:00 UTC = NOW_TS; 7d means 6 days back.
    expect(start7d).toBe(Number(NOW_TS) - 6 * DAY);
  });

  it("returns 0 for `all`", () => {
    expect(rangeStartSeconds("all")).toBe(0);
  });
});

describe("computeChartStartSeconds", () => {
  it("returns rangeStartSeconds for bounded ranges (7d/30d/90d)", () => {
    const grouped = new Map<string, ReadonlyArray<{ timestamp: string }>>();
    const start7d = computeChartStartSeconds(
      grouped as never,
      "7d",
      Number(NOW_TS),
    );
    expect(start7d).toBe(rangeStartSeconds("7d", Number(NOW_TS)));
  });

  it("for `all`, clamps to the earliest observed snapshot day (not epoch)", () => {
    // Critical: rangeStartSeconds("all") returns 0 → naive day-loop
    // would iterate ~20K days and freeze the browser.
    // computeChartStartSeconds clamps to the earliest snapshot day.
    const earliest = Number(NOW_TS) - 30 * DAY;
    const grouped = new Map([
      [
        "42220|0xa|V2_RESERVE",
        [
          { timestamp: String(earliest) },
          { timestamp: String(Number(NOW_TS) - 7 * DAY) },
        ] as ReadonlyArray<{ timestamp: string }>,
      ],
      [
        "42220|0xb|V2_RESERVE",
        [{ timestamp: String(Number(NOW_TS) - 14 * DAY) }] as ReadonlyArray<{
          timestamp: string;
        }>,
      ],
    ]);
    const start = computeChartStartSeconds(
      grouped as never,
      "all",
      Number(NOW_TS),
    );
    // Floors to UTC midnight; the earliest snapshot was already on a
    // day boundary in this test so it stays unchanged.
    expect(start).toBe(earliest);
  });

  it("for `all` with no snapshots, clamps to today (not epoch)", () => {
    const grouped = new Map<string, ReadonlyArray<{ timestamp: string }>>();
    const start = computeChartStartSeconds(
      grouped as never,
      "all",
      Number(NOW_TS),
    );
    expect(start).toBe(Number(NOW_TS));
  });
});

describe("winnersAndLosers7d", () => {
  it("identifies biggest expansion + biggest contraction by USD", () => {
    const snapshots: StableSupplyDailySnapshot[] = [
      // USDm: stable
      snapshot({
        tokenAddress: "0xa",
        timestamp: String(Number(NOW_TS) - 7 * DAY),
        totalSupply: String(BigInt(1_000_000) * BigInt(10) ** BigInt(18)),
      }),
      snapshot({
        tokenAddress: "0xa",
        timestamp: String(NOW_TS),
        totalSupply: String(BigInt(1_010_000) * BigInt(10) ** BigInt(18)),
      }),
      // EURm: contracting
      snapshot({
        tokenAddress: "0xb",
        tokenSymbol: "EURm",
        timestamp: String(Number(NOW_TS) - 7 * DAY),
        totalSupply: String(BigInt(500_000) * BigInt(10) ** BigInt(18)),
      }),
      snapshot({
        tokenAddress: "0xb",
        tokenSymbol: "EURm",
        timestamp: String(NOW_TS),
        totalSupply: String(BigInt(400_000) * BigInt(10) ** BigInt(18)),
      }),
      // GBPm: biggest expansion
      snapshot({
        tokenAddress: "0xc",
        tokenSymbol: "GBPm",
        source: "V3_LIQUITY",
        timestamp: String(Number(NOW_TS) - 7 * DAY),
        totalSupply: String(BigInt(100_000) * BigInt(10) ** BigInt(18)),
      }),
      snapshot({
        tokenAddress: "0xc",
        tokenSymbol: "GBPm",
        source: "V3_LIQUITY",
        timestamp: String(NOW_TS),
        totalSupply: String(BigInt(1_000_000) * BigInt(10) ** BigInt(18)),
      }),
    ];
    const rates = new Map([
      ["USDm", 1],
      ["EURm", 1.1],
      ["GBPm", 1.3],
    ]);
    const rollup = rollupByToken(snapshots, rates, NOW_TS);
    const { biggestExpansion, biggestContraction } = winnersAndLosers7d(rollup);
    expect(biggestExpansion?.tokenSymbol).toBe("GBPm");
    expect(biggestContraction?.tokenSymbol).toBe("EURm");
  });

  it("returns nulls when nothing has 7d change USD", () => {
    const empty = new Map();
    expect(winnersAndLosers7d(empty)).toEqual({
      biggestExpansion: null,
      biggestContraction: null,
    });
  });
});

describe("buildTokenUsdTimeSeries + sumTotalUsdSeries", () => {
  it("forward-fills supply across days with no events (sparse-day semantics)", () => {
    const usdm = "0xa";
    const snapshots: StableSupplyDailySnapshot[] = [
      snapshot({
        tokenAddress: usdm,
        timestamp: String(Number(NOW_TS) - 3 * DAY),
        totalSupply: String(BigInt(100) * BigInt(10) ** BigInt(18)),
      }),
      // No event for the next 3 days — forward-fill should hold at 100.
      snapshot({
        tokenAddress: usdm,
        timestamp: String(NOW_TS),
        totalSupply: String(BigInt(150) * BigInt(10) ** BigInt(18)),
      }),
    ];
    const rates = new Map([["USDm", 1]]);
    const series = buildTokenUsdTimeSeries(
      snapshots,
      rates,
      rangeStartSeconds("7d", Number(NOW_TS)),
      Number(NOW_TS),
    );
    // Window is 7 days; we should get one entry per day from window start.
    expect(series.length).toBeGreaterThan(0);
    // The day before NOW_TS should still see the older supply (100, not 150).
    const yesterday = series.find((p) => p.timestamp === Number(NOW_TS) - DAY);
    expect(yesterday?.valueUsd).toBeCloseTo(100, 0);
    // The NOW_TS day should reflect the new supply (150).
    const today = series.find((p) => p.timestamp === Number(NOW_TS));
    expect(today?.valueUsd).toBeCloseTo(150, 0);
  });

  it("forward-fills locked custody independently before subtracting from supply", () => {
    const gbpm = "0xc";
    const snapshots: StableSupplyDailySnapshot[] = [
      snapshot({
        tokenAddress: gbpm,
        tokenSymbol: "GBPm",
        source: "V3_LIQUITY",
        timestamp: String(Number(NOW_TS) - 3 * DAY),
        totalSupply: String(BigInt(300) * BigInt(10) ** BigInt(18)),
      }),
      snapshot({
        tokenAddress: gbpm,
        tokenSymbol: "GBPm",
        source: "V3_LIQUITY",
        timestamp: String(NOW_TS),
        totalSupply: String(BigInt(350) * BigInt(10) ** BigInt(18)),
      }),
    ];
    const custody = [
      custodySnapshot({
        tokenAddress: gbpm,
        tokenSymbol: "GBPm",
        source: "V3_LIQUITY",
        timestamp: String(Number(NOW_TS) - 2 * DAY),
        lockedSupply: String(BigInt(80) * BigInt(10) ** BigInt(18)),
      }),
    ];
    const series = buildTokenUsdTimeSeries(
      snapshots,
      new Map([["GBPm", 1]]),
      rangeStartSeconds("7d", Number(NOW_TS)),
      Number(NOW_TS),
      custody,
    );
    const beforeLock = series.find(
      (p) => p.timestamp === Number(NOW_TS) - 3 * DAY,
    );
    const afterLock = series.find((p) => p.timestamp === Number(NOW_TS) - DAY);
    const today = series.find((p) => p.timestamp === Number(NOW_TS));
    expect(beforeLock?.valueUsd).toBeCloseTo(300, 0);
    expect(afterLock?.valueUsd).toBeCloseTo(220, 0);
    expect(today?.valueUsd).toBeCloseTo(270, 0);
  });

  it("sums per-token series into a total — timestamps align across tokens", () => {
    const seriesA = [
      { timestamp: 1, valueUsd: 100 },
      { timestamp: 2, valueUsd: 110 },
    ];
    const seriesB = [
      { timestamp: 1, valueUsd: 50 },
      { timestamp: 2, valueUsd: 55 },
    ];
    const total = sumTotalUsdSeries([seriesA, seriesB]);
    expect(total).toEqual([
      { timestamp: 1, valueUsd: 150 },
      { timestamp: 2, valueUsd: 165 },
    ]);
  });

  it("returns empty for non-USD-pegged token without an oracle rate", () => {
    // USDm + other USD-pegged stables default to rate=1 via
    // `effectiveOracleRate`; this test uses BRLm to actually exercise
    // the "no rate" path.
    const series = buildTokenUsdTimeSeries(
      [
        snapshot({
          tokenSymbol: "BRLm",
          timestamp: String(NOW_TS),
          totalSupply: "100",
        }),
      ],
      new Map(),
      rangeStartSeconds("7d", Number(NOW_TS)),
      Number(NOW_TS),
    );
    expect(series).toEqual([]);
  });

  it("defaults USDm to rate=1 when oracle map is empty", () => {
    const series = buildTokenUsdTimeSeries(
      [
        snapshot({
          tokenSymbol: "USDm",
          timestamp: String(NOW_TS),
          totalSupply: String(BigInt(1_000_000) * BigInt(10) ** BigInt(18)),
        }),
      ],
      new Map(),
      rangeStartSeconds("7d", Number(NOW_TS)),
      Number(NOW_TS),
    );
    expect(series.length).toBeGreaterThan(0);
    // The NOW_TS day should reflect 1M USDm at rate=1 = $1M.
    const today = series.find((p) => p.timestamp === Number(NOW_TS));
    expect(today?.valueUsd).toBeCloseTo(1_000_000, 0);
  });
});
