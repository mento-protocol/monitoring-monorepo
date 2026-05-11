import { describe, it, expect, afterEach, vi } from "vitest";
import {
  aggregateBrokerAggregatorsByWindow,
  aggregateBrokerTradersByWindow,
  aggregateDailyVolume,
  aggregatePoolDailyVolume,
  aggregateTraderPoolsByWindow,
  aggregateTradersByWindow,
  buildHeroPartialOverlapQueryInput,
  computeFlow,
  mergeHeroSnapshot,
  rangeCutoffSeconds,
  top10Concentration,
  weiToUsd,
  type BrokerAggregatorDailyRow,
  type BrokerTraderDailyRow,
  type LeaderboardPartialOverlapRow,
  type LeaderboardTodayTraderRow,
  type LeaderboardWindowFirstDayRow,
  type LeaderboardWindowRow,
  type TraderDailyRow,
  type TraderPoolDailyRow,
  type TraderPoolWindowRow,
  type TraderWindowRow,
} from "../leaderboard";
import {
  buildCorridorRows,
  buildTraderCohortSummary,
  computeLpFriendliness,
  filterSwapOutliers,
  parseUsdWei,
  previousLeaderboardWindowBounds,
  traderDayKey,
  type SwapOutlierRow,
} from "../leaderboard-insights";

const ZERO_WEI = "0";
const USD = (n: number) =>
  (BigInt(Math.floor(n * 1_000_000)) * BigInt(10) ** BigInt(12)).toString();

function trader(
  partial: Partial<TraderDailyRow> & {
    chainId: number;
    trader: string;
    timestamp: string;
    volumeUsdWei: string;
  },
): TraderDailyRow {
  return {
    id: `${partial.chainId}-${partial.trader}-${partial.timestamp}`,
    swapCount: 1,
    uniquePools: 1,
    feesPaidUsdWei: ZERO_WEI,
    isSystemAddress: false,
    lastSeenTimestamp: partial.timestamp,
    ...partial,
  };
}

function poolDay(
  partial: Partial<TraderPoolDailyRow> & {
    chainId: number;
    trader: string;
    poolId: string;
    timestamp: string;
  },
): TraderPoolDailyRow {
  return {
    id: `${partial.chainId}-${partial.trader}-${partial.poolId}-${partial.timestamp}`,
    swapCount: 1,
    volumeUsdWei: ZERO_WEI,
    inflowToken0UsdWei: ZERO_WEI,
    outflowToken0UsdWei: ZERO_WEI,
    inflowToken1UsdWei: ZERO_WEI,
    outflowToken1UsdWei: ZERO_WEI,
    feesPaidUsdWei: ZERO_WEI,
    ...partial,
  };
}

describe("weiToUsd", () => {
  it("converts whole-USD amounts", () => {
    expect(weiToUsd(BigInt(0))).toBe(0);
    expect(weiToUsd(BigInt(USD(1)))).toBeCloseTo(1, 6);
    expect(weiToUsd(BigInt(USD(1234.56)))).toBeCloseTo(1234.56, 4);
  });

  it("preserves precision past Number's 2^53 ceiling", () => {
    // 10 trillion USD in wei. Number(BigInt) would round; the string-shift
    // path must not.
    const tenTrillion = BigInt(10_000_000_000_000) * BigInt(10) ** BigInt(18);
    expect(weiToUsd(tenTrillion)).toBeCloseTo(1e13, -3);
  });

  it("handles negative values", () => {
    expect(weiToUsd(-BigInt(USD(5)))).toBeCloseTo(-5, 6);
  });

  it("returns 0 for sub-USD-microcent dust", () => {
    // 1 wei is 10^-18 USD — display rounds to 0.
    expect(weiToUsd(BigInt(1))).toBe(0);
  });
});

describe("aggregateTradersByWindow stability", () => {
  it("ties on volume break by (chainId, trader) lexicographic, not insertion order", () => {
    // Same window-volume, different chain/address. The ordering must be
    // deterministic — without a stable secondary key, SWR's row order
    // would dictate the rank column and the flow badge would flicker.
    const equalVolume = USD(100);
    const rows: TraderDailyRow[] = [
      trader({
        chainId: 143,
        trader: "0xff",
        timestamp: "100",
        volumeUsdWei: equalVolume,
      }),
      trader({
        chainId: 42220,
        trader: "0xaa",
        timestamp: "100",
        volumeUsdWei: equalVolume,
      }),
      trader({
        chainId: 42220,
        trader: "0x11",
        timestamp: "100",
        volumeUsdWei: equalVolume,
      }),
    ];
    const a = aggregateTradersByWindow(rows);
    // Reverse the input — should produce the SAME output order.
    const b = aggregateTradersByWindow([...rows].reverse());
    expect(a.map((r) => `${r.chainId}-${r.trader}`)).toEqual(
      b.map((r) => `${r.chainId}-${r.trader}`),
    );
    // Lexicographic order of (chainId, trader): 143 before 42220; within
    // 42220, "0x11" before "0xaa".
    expect(a.map((r) => r.trader)).toEqual(["0xff", "0x11", "0xaa"]);
  });
});

describe("aggregateTradersByWindow", () => {
  it("groups by (chainId, trader) and sums", () => {
    const rows: TraderDailyRow[] = [
      trader({
        chainId: 42220,
        trader: "0xa",
        timestamp: "100",
        volumeUsdWei: USD(100),
        swapCount: 2,
        uniquePools: 1,
      }),
      trader({
        chainId: 42220,
        trader: "0xa",
        timestamp: "200",
        volumeUsdWei: USD(50),
        swapCount: 1,
        uniquePools: 2,
      }),
      trader({
        chainId: 143,
        trader: "0xa",
        timestamp: "100",
        volumeUsdWei: USD(30),
        swapCount: 1,
        uniquePools: 1,
      }),
      trader({
        chainId: 42220,
        trader: "0xb",
        timestamp: "100",
        volumeUsdWei: USD(200),
        swapCount: 5,
        uniquePools: 3,
      }),
    ];
    const result = aggregateTradersByWindow(rows);

    // Same EOA across different chains stays separate.
    expect(result).toHaveLength(3);
    // Sorted by volume desc.
    expect(result[0]!.trader).toBe("0xb");
    expect(weiToUsd(result[0]!.volumeUsdWei)).toBeCloseTo(200, 4);
    expect(result[1]!.trader).toBe("0xa");
    expect(result[1]!.chainId).toBe(42220);
    expect(weiToUsd(result[1]!.volumeUsdWei)).toBeCloseTo(150, 4);
    expect(result[1]!.swapCount).toBe(3);
    // uniquePoolsApprox is the *max* across days, not the sum — it's a
    // lower-bound proxy for the true cardinality.
    expect(result[1]!.uniquePoolsApprox).toBe(2);
  });

  it("propagates isSystemAddress=true if any row is system", () => {
    const rows: TraderDailyRow[] = [
      trader({
        chainId: 42220,
        trader: "0xa",
        timestamp: "100",
        volumeUsdWei: USD(10),
        isSystemAddress: false,
      }),
      trader({
        chainId: 42220,
        trader: "0xa",
        timestamp: "200",
        volumeUsdWei: USD(20),
        isSystemAddress: true,
      }),
    ];
    const result = aggregateTradersByWindow(rows);
    expect(result[0]!.isSystemAddress).toBe(true);
  });

  it("tracks max lastSeenTimestamp across the window", () => {
    const rows: TraderDailyRow[] = [
      trader({
        chainId: 42220,
        trader: "0xa",
        timestamp: "100",
        volumeUsdWei: USD(10),
        lastSeenTimestamp: "150",
      }),
      trader({
        chainId: 42220,
        trader: "0xa",
        timestamp: "200",
        volumeUsdWei: USD(20),
        lastSeenTimestamp: "250",
      }),
    ];
    const result = aggregateTradersByWindow(rows);
    expect(result[0]!.lastSeenTimestamp).toBe(250);
  });
});

describe("aggregateTraderPoolsByWindow", () => {
  it("groups by (chainId, trader, poolId) and sums inflow/outflow", () => {
    const rows: TraderPoolDailyRow[] = [
      poolDay({
        chainId: 42220,
        trader: "0xa",
        poolId: "42220-0xpool1",
        timestamp: "100",
        volumeUsdWei: USD(50),
        inflowToken0UsdWei: USD(50),
        outflowToken1UsdWei: USD(50),
      }),
      poolDay({
        chainId: 42220,
        trader: "0xa",
        poolId: "42220-0xpool1",
        timestamp: "200",
        volumeUsdWei: USD(50),
        outflowToken0UsdWei: USD(50),
        inflowToken1UsdWei: USD(50),
      }),
    ];
    const result = aggregateTraderPoolsByWindow(rows);
    expect(result).toHaveLength(1);
    const p = result[0]!;
    expect(weiToUsd(p.volumeUsdWei)).toBeCloseTo(100, 4);
    expect(weiToUsd(p.inflowToken0UsdWei)).toBeCloseTo(50, 4);
    expect(weiToUsd(p.outflowToken0UsdWei)).toBeCloseTo(50, 4);
  });
});

describe("computeFlow", () => {
  function pool(partial: Partial<TraderPoolWindowRow>): TraderPoolWindowRow {
    return {
      chainId: 42220,
      trader: "0xa",
      poolId: "42220-0xpool",
      swapCount: 1,
      volumeUsdWei: BigInt(0),
      inflowToken0UsdWei: BigInt(0),
      outflowToken0UsdWei: BigInt(0),
      inflowToken1UsdWei: BigInt(0),
      outflowToken1UsdWei: BigInt(0),
      feesPaidUsdWei: BigInt(0),
      ...partial,
    };
  }

  it("classifies pure one-direction flow as one-directional", () => {
    // Trader bought token0 with token1 — no other side touched.
    const r = computeFlow(
      pool({
        inflowToken0UsdWei: BigInt(USD(100)),
        outflowToken1UsdWei: BigInt(USD(100)),
      }),
    );
    expect(r.kind).toBe("one-directional");
    expect(r.imbalance).toBeCloseTo(1, 4);
    expect(r.direction).toBe(0);
  });

  it("classifies near-balanced round-trip as delta-neutral", () => {
    const r = computeFlow(
      pool({
        inflowToken0UsdWei: BigInt(USD(100)),
        outflowToken0UsdWei: BigInt(USD(95)),
        inflowToken1UsdWei: BigInt(USD(95)),
        outflowToken1UsdWei: BigInt(USD(100)),
      }),
    );
    expect(r.kind).toBe("delta-neutral");
    expect(r.imbalance).toBeLessThan(0.2);
  });

  it("classifies intermediate imbalance as mixed", () => {
    // ~50% imbalance — buys 75 of token0, sells 25 worth.
    const r = computeFlow(
      pool({
        inflowToken0UsdWei: BigInt(USD(75)),
        outflowToken0UsdWei: BigInt(USD(25)),
        inflowToken1UsdWei: BigInt(USD(25)),
        outflowToken1UsdWei: BigInt(USD(75)),
      }),
    );
    expect(r.kind).toBe("mixed");
    expect(r.imbalance).toBeGreaterThan(0.2);
    expect(r.imbalance).toBeLessThan(0.7);
  });

  it("returns mixed/null direction when there's no flow", () => {
    const r = computeFlow(pool({}));
    expect(r.kind).toBe("mixed");
    expect(r.direction).toBeNull();
  });

  it("direction tracks the leg the trader net-accumulated", () => {
    // Token1's net move dominates (|+50| > |−10|).
    const r = computeFlow(
      pool({
        inflowToken0UsdWei: BigInt(USD(20)),
        outflowToken0UsdWei: BigInt(USD(30)),
        inflowToken1UsdWei: BigInt(USD(50)),
      }),
    );
    expect(r.direction).toBe(1);
  });

  it("symmetric one-way swap labels the accumulated token, not the larger |net|", () => {
    // Trader sold token0, received token1 — |net0| == |net1| == 100.
    // The naive "larger abs net wins, ties → 0" rule mislabels this as
    // direction=0 (they did NOT accumulate token0; they got rid of it).
    const r = computeFlow(
      pool({
        outflowToken0UsdWei: BigInt(USD(100)),
        inflowToken1UsdWei: BigInt(USD(100)),
      }),
    );
    expect(r.direction).toBe(1);
  });
});

describe("leaderboard insights", () => {
  function windowRow(
    partial: Partial<TraderWindowRow> & {
      chainId: number;
      trader: string;
      volumeUsdWei: bigint;
    },
  ): TraderWindowRow {
    return {
      swapCount: 1,
      uniquePoolsApprox: 1,
      feesPaidUsdWei: BigInt(0),
      isSystemAddress: false,
      lastSeenTimestamp: 1,
      ...partial,
    };
  }

  function swap(partial: Partial<SwapOutlierRow>): SwapOutlierRow {
    return {
      id: "swap-1",
      chainId: 42220,
      poolId: "42220-0xpool",
      caller: "0xa",
      txTo: "0xrouter",
      recipient: "0xa",
      volumeUsdWei: USD(100),
      txHash: "0xhash",
      blockTimestamp: "1000",
      ...partial,
    };
  }

  it("splits current traders into new, returning, and dormant cohorts", () => {
    const current = [
      windowRow({
        chainId: 42220,
        trader: "0xnew",
        volumeUsdWei: BigInt(USD(300)),
      }),
      windowRow({
        chainId: 42220,
        trader: "0xkeep",
        volumeUsdWei: BigInt(USD(200)),
      }),
    ];
    const previous = [
      windowRow({
        chainId: 42220,
        trader: "0xkeep",
        volumeUsdWei: BigInt(USD(150)),
      }),
      windowRow({
        chainId: 42220,
        trader: "0xdormant",
        volumeUsdWei: BigInt(USD(120)),
      }),
    ];
    const summary = buildTraderCohortSummary({ current, previous });
    expect(summary.newCount).toBe(1);
    expect(summary.returningCount).toBe(1);
    expect(summary.dormantCount).toBe(1);
    expect(summary.topNewTrader?.trader).toBe("0xnew");
    expect(summary.topReturningTrader?.trader).toBe("0xkeep");
    expect(summary.topDormantTrader?.trader).toBe("0xdormant");
  });

  it("scores LP friendliness from low imbalance plus fee revenue", () => {
    const friendly = {
      chainId: 42220,
      trader: "0xa",
      poolId: "42220-0xpool",
      swapCount: 2,
      volumeUsdWei: BigInt(USD(100)),
      inflowToken0UsdWei: BigInt(USD(50)),
      outflowToken0UsdWei: BigInt(USD(49)),
      inflowToken1UsdWei: BigInt(USD(49)),
      outflowToken1UsdWei: BigInt(USD(50)),
      feesPaidUsdWei: BigInt(USD(0.1)),
    } satisfies TraderPoolWindowRow;
    const extractive = {
      ...friendly,
      inflowToken0UsdWei: BigInt(USD(100)),
      outflowToken0UsdWei: BigInt(0),
      inflowToken1UsdWei: BigInt(0),
      outflowToken1UsdWei: BigInt(USD(100)),
      feesPaidUsdWei: BigInt(0),
    } satisfies TraderPoolWindowRow;

    expect(computeLpFriendliness(friendly).band).toBe("friendly");
    expect(computeLpFriendliness(friendly).ratio).toBeCloseTo(0.1, 4);
    expect(computeLpFriendliness(extractive).band).toBe("extractive");
    expect(computeLpFriendliness(friendly).score).toBeGreaterThan(
      computeLpFriendliness(extractive).score,
    );
  });

  it("handles zero-volume and zero-pressure LP score edges", () => {
    const zeroVolume = {
      chainId: 42220,
      trader: "0xa",
      poolId: "42220-0xpool",
      swapCount: 0,
      volumeUsdWei: BigInt(0),
      inflowToken0UsdWei: BigInt(0),
      outflowToken0UsdWei: BigInt(0),
      inflowToken1UsdWei: BigInt(0),
      outflowToken1UsdWei: BigInt(0),
      feesPaidUsdWei: BigInt(USD(1)),
    } satisfies TraderPoolWindowRow;
    const zeroPressure = {
      ...zeroVolume,
      swapCount: 2,
      volumeUsdWei: BigInt(USD(100)),
      inflowToken0UsdWei: BigInt(USD(50)),
      outflowToken0UsdWei: BigInt(USD(50)),
      inflowToken1UsdWei: BigInt(USD(50)),
      outflowToken1UsdWei: BigInt(USD(50)),
    } satisfies TraderPoolWindowRow;

    expect(computeLpFriendliness(zeroVolume)).toMatchObject({
      score: 0,
      ratio: 0,
      band: "extractive",
    });
    expect(computeLpFriendliness(zeroPressure)).toMatchObject({
      score: 100,
      ratio: 1,
      band: "friendly",
    });
  });

  it("parses USD-wei strings defensively", () => {
    expect(parseUsdWei("123")).toBe(BigInt(123));
    expect(parseUsdWei("123.4")).toBe(BigInt(123));
    expect(parseUsdWei("123.5")).toBe(BigInt(124));
    expect(parseUsdWei("")).toBeNull();
    expect(parseUsdWei("not-a-number")).toBeNull();
  });

  it("computes the previous bounded leaderboard window", () => {
    const cutoff = 3_000_000;
    expect(previousLeaderboardWindowBounds("all", cutoff)).toBeNull();
    expect(previousLeaderboardWindowBounds("30d", 0)).toBeNull();
    expect(previousLeaderboardWindowBounds("30d", cutoff)).toEqual({
      afterTimestamp: cutoff - 30 * 86_400,
      beforeTimestamp: cutoff,
    });
  });

  it("builds directional corridors and filters to allowed traders", () => {
    const rows = [
      poolDay({
        chainId: 42220,
        trader: "0xa",
        poolId: "42220-0xpool",
        timestamp: "100",
        volumeUsdWei: USD(100),
        inflowToken0UsdWei: USD(100),
        outflowToken1UsdWei: USD(100),
      }),
      poolDay({
        chainId: 42220,
        trader: "0xb",
        poolId: "42220-0xpool",
        timestamp: "100",
        volumeUsdWei: USD(80),
        outflowToken0UsdWei: USD(80),
        inflowToken1UsdWei: USD(80),
      }),
    ];
    const corridors = buildCorridorRows({
      rows,
      allowedTraderDayKeys: new Set([traderDayKey(42220, "0xa", "100")!]),
    });

    expect(corridors).toHaveLength(1);
    expect(corridors[0]!.direction).toBe(0);
    expect(corridors[0]!.traderCount).toBe(1);
    expect(weiToUsd(corridors[0]!.netPressureUsdWei)).toBeCloseTo(100, 4);
  });

  it("filters swap outliers through the current trader set", () => {
    const rows = [
      swap({ id: "keep", caller: "0xabc" }),
      swap({ id: "drop", caller: "0xdef" }),
    ];
    const outliers = filterSwapOutliers({
      rows,
      allowedTraderDayKeys: new Set([traderDayKey(42220, "0xabc", "1000")!]),
    });
    expect(outliers.map((r) => r.id)).toEqual(["keep"]);
  });

  it("keeps corridor filtering scoped to the trader day", () => {
    const rows = [
      poolDay({
        id: "visible-day",
        chainId: 42220,
        trader: "0xa",
        poolId: "42220-0xpool",
        timestamp: "100",
        volumeUsdWei: USD(100),
        inflowToken0UsdWei: USD(100),
      }),
      poolDay({
        id: "hidden-day",
        chainId: 42220,
        trader: "0xa",
        poolId: "42220-0xpool",
        timestamp: "86400",
        volumeUsdWei: USD(500),
        outflowToken0UsdWei: USD(500),
      }),
    ];

    const corridors = buildCorridorRows({
      rows,
      allowedTraderDayKeys: new Set([traderDayKey(42220, "0xa", "100")!]),
    });

    expect(corridors).toHaveLength(1);
    expect(corridors[0]!.direction).toBe(0);
    expect(weiToUsd(corridors[0]!.volumeUsdWei)).toBeCloseTo(100, 4);
  });

  it("keeps outlier filtering scoped to the trader day", () => {
    const rows = [
      swap({ id: "visible-day", caller: "0xabc", blockTimestamp: "1000" }),
      swap({ id: "hidden-day", caller: "0xabc", blockTimestamp: "86400" }),
    ];

    const outliers = filterSwapOutliers({
      rows,
      allowedTraderDayKeys: new Set([traderDayKey(42220, "0xabc", "1000")!]),
    });

    expect(outliers.map((r) => r.id)).toEqual(["visible-day"]);
  });
});

describe("rangeCutoffSeconds", () => {
  const SECONDS_PER_DAY = 86_400;
  // Pin "now" mid-day UTC so we can prove the cutoff aligns to UTC midnight.
  // 2026-05-04 14:30:00 UTC.
  const FIXED_NOW_MS = Date.UTC(2026, 4, 4, 14, 30, 0);
  const TODAY_MIDNIGHT_UTC =
    Math.floor(FIXED_NOW_MS / 1000 / SECONDS_PER_DAY) * SECONDS_PER_DAY;

  afterEach(() => {
    vi.useRealTimers();
  });

  it("30d covers today + previous 29 UTC buckets", () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW_MS);
    expect(rangeCutoffSeconds("30d")).toBe(
      TODAY_MIDNIGHT_UTC - 29 * SECONDS_PER_DAY,
    );
  });

  it("90d covers today + previous 89 UTC buckets", () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW_MS);
    expect(rangeCutoffSeconds("90d")).toBe(
      TODAY_MIDNIGHT_UTC - 89 * SECONDS_PER_DAY,
    );
  });

  it("all returns 0 (no cutoff)", () => {
    expect(rangeCutoffSeconds("all")).toBe(0);
  });

  it("cutoff is independent of intra-day clock drift", () => {
    // Two probes at 09:00 UTC and 23:59 UTC of the same UTC day must
    // produce identical cutoffs — the `Date.now() / 86400` floor masks
    // sub-day drift, so the SWR cache key stays stable across re-renders.
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 4, 4, 9, 0, 0));
    const morning = rangeCutoffSeconds("30d");
    vi.setSystemTime(Date.UTC(2026, 4, 4, 23, 59, 0));
    const evening = rangeCutoffSeconds("30d");
    expect(morning).toBe(evening);
  });
});

describe("aggregatePoolDailyVolume", () => {
  const day = (n: number) => String(n * 86400);
  const usd = (n: number) =>
    (BigInt(Math.floor(n * 1_000_000)) * BigInt(10) ** BigInt(12)).toString();
  const noLabel = (poolId: string) => poolId;

  function row(
    chainId: number,
    poolId: string,
    timestamp: string,
    volumeUsd: number,
    volumeUsdIncludingSystem = volumeUsd,
  ) {
    return {
      id: `${chainId}-${poolId}-${timestamp}`,
      chainId,
      poolId,
      timestamp,
      swapCount: volumeUsd > 0 ? 1 : 0,
      swapCountIncludingSystem: volumeUsdIncludingSystem > 0 ? 1 : 0,
      volumeUsdWei: usd(volumeUsd),
      volumeUsdWeiIncludingSystem: usd(volumeUsdIncludingSystem),
    };
  }

  it("buckets by (poolId, day) and ranks pools by total window volume", () => {
    // pool A: 100 + 50 = 150 over 2 days; pool B: 200 once; pool C: 30 once.
    const rows = [
      row(42220, "0xA", day(1), 100),
      row(42220, "0xA", day(2), 50),
      row(42220, "0xB", day(1), 200),
      row(42220, "0xC", day(2), 30),
    ];
    const r = aggregatePoolDailyVolume(rows, noLabel);
    expect(r.poolCount).toBe(3);
    // Top 5 cap not hit — all 3 pools should be in the breakdown,
    // ordered by window volume desc.
    expect(r.breakdown.map((b) => b.key)).toEqual(["0xB", "0xA", "0xC"]);
    // Total per day = sum across all pools.
    expect(r.totalSeries.map((p) => p.timestamp)).toEqual([
      Number(day(1)),
      Number(day(2)),
    ]);
    expect(r.totalSeries[0]!.value).toBeCloseTo(300, 4); // 100 + 200
    expect(r.totalSeries[1]!.value).toBeCloseTo(80, 4); // 50 + 30
  });

  it("buckets pools beyond top-7 into a single 'Other' series", () => {
    // 9 pools, ranks 1-7 stay, 8+9 collapse into "Other".
    const rows: Array<ReturnType<typeof row>> = [];
    const volumes = [100, 90, 80, 70, 60, 50, 40, 10, 5];
    for (let i = 0; i < volumes.length; i += 1) {
      rows.push(row(42220, `0xP${i}`, day(1), volumes[i]!));
    }
    const r = aggregatePoolDailyVolume(rows, noLabel);
    expect(r.poolCount).toBe(9);
    expect(r.breakdown).toHaveLength(8); // 7 pools + 1 "Other"
    expect(r.breakdown.slice(0, 7).map((b) => b.key)).toEqual([
      "0xP0",
      "0xP1",
      "0xP2",
      "0xP3",
      "0xP4",
      "0xP5",
      "0xP6",
    ]);
    const other = r.breakdown[7]!;
    expect(other.key).toBe("__other__");
    expect(other.name).toContain("Other");
    expect(other.series[0]!.value).toBeCloseTo(15, 4); // 10 + 5
  });

  it("zero-fills inactive days per pool so stack alignment is correct", () => {
    // pool A active days 1+3, pool B active day 2 only. The series for
    // each pool must have entries for days 1, 2, AND 3 (with value=0
    // where inactive) so the stacked chart's x-axis aligns.
    const rows = [
      row(42220, "0xA", day(1), 50),
      row(42220, "0xA", day(3), 70),
      row(42220, "0xB", day(2), 30),
    ];
    const r = aggregatePoolDailyVolume(rows, noLabel);
    expect(r.breakdown).toHaveLength(2);
    const poolA = r.breakdown.find((b) => b.key === "0xA")!;
    expect(poolA.series.map((p) => p.timestamp)).toEqual([
      Number(day(1)),
      Number(day(2)),
      Number(day(3)),
    ]);
    expect(poolA.series.map((p) => p.value)).toEqual([50, 0, 70]);
    const poolB = r.breakdown.find((b) => b.key === "0xB")!;
    expect(poolB.series.map((p) => p.value)).toEqual([0, 30, 0]);
  });

  it("uses the supplied poolLabel callback for legend names", () => {
    const rows = [row(42220, "0xpool1", day(1), 100)];
    const r = aggregatePoolDailyVolume(rows, () => "USDC/USDm");
    expect(r.breakdown[0]!.name).toBe("USDC/USDm");
  });

  it("uses primary volume by default and *IncludingSystem volume when toggled on", () => {
    // The pool-day rollup carries both branches. System-off reads the
    // primary field; system-on reads the including-system sibling.
    const rows = [
      row(42220, "0xA", day(1), 100, 150),
      row(42220, "0xB", day(1), 0, 50),
    ];
    const r = aggregatePoolDailyVolume(rows, noLabel);
    expect(r.totalSeries[0]!.value).toBeCloseTo(100, 4);
    const withSystem = aggregatePoolDailyVolume(rows, noLabel, true);
    expect(withSystem.totalSeries[0]!.value).toBeCloseTo(200, 4);
  });

  it("zero-fills every day in windowRange even when no row touched it", () => {
    // Only day 2 has any activity; days 1 and 3 must still appear in the
    // series with value=0 so the stacked area's x-axis stays contiguous.
    const SECONDS_PER_DAY = 86_400;
    const rows = [row(42220, "0xA", day(2), 100)];
    const r = aggregatePoolDailyVolume(rows, noLabel, undefined, {
      fromSec: Number(day(1)),
      toSec: Number(day(3)),
    });
    expect(r.totalSeries.map((p) => p.timestamp)).toEqual([
      Number(day(1)),
      Number(day(1)) + SECONDS_PER_DAY,
      Number(day(3)),
    ]);
    expect(r.totalSeries.map((p) => p.value)).toEqual([0, 100, 0]);
  });

  it("returns empty series even with windowRange when no rows survive filtering", () => {
    // Empty input + windowRange must NOT zero-fill — the chart card's
    // `series.length === 0` empty-state check would otherwise be hidden
    // behind a synthetic all-zero series (codex finding).
    const r = aggregatePoolDailyVolume([], noLabel, undefined, {
      fromSec: Number(day(1)),
      toSec: Number(day(7)),
    });
    expect(r.totalSeries).toEqual([]);
    expect(r.breakdown).toEqual([]);
    expect(r.poolCount).toBe(0);
  });

  it("emits poolRanking sorted desc with windowTotalUsdWei", () => {
    // Drives the Top Pools sidebar list. Ranking must match the chart's
    // breakdown order (so list rows can borrow chart colors via
    // poolId), and `windowTotalUsdWei` is the denominator for the % share.
    const rows = [
      row(42220, "0xA", day(1), 100),
      row(42220, "0xB", day(1), 80),
      row(42220, "0xC", day(1), 60),
      row(42220, "0xC", day(2), 5), // bumps C to 65 total — still rank 3
    ];
    const r = aggregatePoolDailyVolume(rows, noLabel);
    expect(r.poolRanking.map((p) => p.poolId)).toEqual(["0xA", "0xB", "0xC"]);
    expect(r.poolRanking[0]!.totalUsd).toBeCloseTo(100, 4);
    expect(r.poolRanking[2]!.totalUsd).toBeCloseTo(65, 4);
    expect(weiToUsd(r.windowTotalUsdWei)).toBeCloseTo(245, 4);
    // Chart's `breakdown[i].key` lines up with `poolRanking[i].poolId`
    // for i in [0, TOP_N_POOLS).
    expect(r.breakdown[0]!.key).toBe(r.poolRanking[0]!.poolId);
    expect(r.breakdown[1]!.key).toBe(r.poolRanking[1]!.poolId);
  });

  it("returns empty series when system-off volume is zero for every row", () => {
    const rows = [row(42220, "0xA", day(1), 0, 100)];
    const r = aggregatePoolDailyVolume(rows, noLabel, false, {
      fromSec: Number(day(1)),
      toSec: Number(day(7)),
    });
    expect(r.totalSeries).toEqual([]);
    expect(r.breakdown).toEqual([]);
    expect(r.poolCount).toBe(0);
  });
});

// ─── V2 (legacy-Broker) aggregations ─────────────────────────────────────

function brokerTrader(
  partial: Partial<BrokerTraderDailyRow> & {
    chainId: number;
    trader: string;
    timestamp: string;
    volumeUsdWei: string;
  },
): BrokerTraderDailyRow {
  return {
    id: `${partial.chainId}-${partial.trader}-${partial.timestamp}`,
    swapCount: 1,
    isSystemAddress: false,
    lastSeenTimestamp: partial.timestamp,
    ...partial,
  };
}

function brokerAggregator(
  partial: Partial<BrokerAggregatorDailyRow> & {
    chainId: number;
    aggregator: string;
    timestamp: string;
    volumeUsdWei: string;
  },
): BrokerAggregatorDailyRow {
  return {
    id: `${partial.chainId}-${partial.aggregator}-${partial.timestamp}`,
    lastSeenAggregatorAddress: "0x0000000000000000000000000000000000000000",
    swapCount: 1,
    uniqueTraders: 1,
    ...partial,
  };
}

describe("aggregateBrokerTradersByWindow", () => {
  it("sums same trader's daily rows and tracks the latest lastSeenTimestamp", () => {
    const rows = [
      brokerTrader({
        chainId: 42220,
        trader: "0xa",
        timestamp: "1000",
        volumeUsdWei: USD(100),
        swapCount: 3,
        lastSeenTimestamp: "1500",
      }),
      brokerTrader({
        chainId: 42220,
        trader: "0xa",
        timestamp: "2000",
        volumeUsdWei: USD(50),
        swapCount: 2,
        lastSeenTimestamp: "2500",
      }),
    ];
    const out = aggregateBrokerTradersByWindow(rows);
    expect(out).toHaveLength(1);
    expect(out[0]!.swapCount).toBe(5);
    expect(weiToUsd(out[0]!.volumeUsdWei)).toBeCloseTo(150, 4);
    expect(out[0]!.lastSeenTimestamp).toBe(2500);
  });

  it("keeps same EOA on different chains separate", () => {
    const rows = [
      brokerTrader({
        chainId: 42220,
        trader: "0xa",
        timestamp: "1000",
        volumeUsdWei: USD(100),
      }),
      brokerTrader({
        chainId: 10143,
        trader: "0xa",
        timestamp: "1000",
        volumeUsdWei: USD(50),
      }),
    ];
    const out = aggregateBrokerTradersByWindow(rows);
    expect(out).toHaveLength(2);
  });

  it("sticky-true: a trader flagged isSystem on any day stays system in the window", () => {
    const rows = [
      brokerTrader({
        chainId: 42220,
        trader: "0xa",
        timestamp: "1000",
        volumeUsdWei: USD(100),
        isSystemAddress: false,
      }),
      brokerTrader({
        chainId: 42220,
        trader: "0xa",
        timestamp: "2000",
        volumeUsdWei: USD(100),
        isSystemAddress: true,
      }),
    ];
    expect(aggregateBrokerTradersByWindow(rows)[0]!.isSystemAddress).toBe(true);
  });

  it("sorts by volume desc with stable (chainId, trader) tiebreaker", () => {
    const rows = [
      brokerTrader({
        chainId: 42220,
        trader: "0xb",
        timestamp: "1000",
        volumeUsdWei: USD(100),
      }),
      brokerTrader({
        chainId: 42220,
        trader: "0xa",
        timestamp: "1000",
        volumeUsdWei: USD(100),
      }),
    ];
    const out = aggregateBrokerTradersByWindow(rows);
    // Same volume → secondary sort on `trader` ascending puts 0xa first.
    expect(out[0]!.trader).toBe("0xa");
    expect(out[1]!.trader).toBe("0xb");
  });
});

describe("aggregateBrokerAggregatorsByWindow", () => {
  it("uniqueTradersApprox is max-of-day-counts (lower bound)", () => {
    // Two days for the same aggregator: 5 unique traders one day, 3 the next.
    // The window's true unique count is somewhere in [5, 8] — we surface 5
    // as a documented lower bound rather than 8 (which would over-count
    // returning traders).
    const rows = [
      brokerAggregator({
        chainId: 42220,
        aggregator: "squid",
        timestamp: "1000",
        volumeUsdWei: USD(1_000),
        uniqueTraders: 5,
      }),
      brokerAggregator({
        chainId: 42220,
        aggregator: "squid",
        timestamp: "2000",
        volumeUsdWei: USD(2_000),
        uniqueTraders: 3,
      }),
    ];
    const out = aggregateBrokerAggregatorsByWindow(rows);
    expect(out).toHaveLength(1);
    expect(out[0]!.uniqueTradersApprox).toBe(5);
    expect(weiToUsd(out[0]!.volumeUsdWei)).toBeCloseTo(3_000, 4);
  });

  it("picks lastSeenAggregatorAddress by latest timestamp, not iteration order", () => {
    // BROKER_AGGREGATOR_DAILY_TOP orders by `volumeUsdWei desc`, so the
    // newer day can come AFTER the older day in iteration when the older
    // day has more volume. The aggregator is expected to compare timestamps
    // — picking by iteration would surface the older router for clusters
    // that rotated their entry-point.
    const rows = [
      // Older day, but bigger volume → comes first in the volume-desc query.
      brokerAggregator({
        chainId: 42220,
        aggregator: "cluster-deadbeef",
        timestamp: "1000",
        lastSeenAggregatorAddress: "0xrouter1",
        volumeUsdWei: USD(100),
      }),
      // Newer day, smaller volume → comes second in iteration.
      brokerAggregator({
        chainId: 42220,
        aggregator: "cluster-deadbeef",
        timestamp: "2000",
        lastSeenAggregatorAddress: "0xrouter2",
        volumeUsdWei: USD(10),
      }),
    ];
    const [row] = aggregateBrokerAggregatorsByWindow(rows);
    expect(row!.lastSeenAggregatorAddress).toBe("0xrouter2");

    // Reverse the iteration order — newer day comes first. The result
    // must be identical: the timestamp-comparison guard prevents a later
    // older-day row from clobbering it.
    const reversed = [...rows].reverse();
    const [row2] = aggregateBrokerAggregatorsByWindow(reversed);
    expect(row2!.lastSeenAggregatorAddress).toBe("0xrouter2");
  });
});

describe("aggregateDailyVolume (BrokerTraderDailyRow)", () => {
  it("accepts the skinnier v2 row shape and sums by day key", () => {
    const rows = [
      brokerTrader({
        chainId: 42220,
        trader: "0xa",
        timestamp: "86400",
        volumeUsdWei: USD(100),
      }),
      brokerTrader({
        chainId: 42220,
        trader: "0xb",
        timestamp: "86400",
        volumeUsdWei: USD(50),
      }),
      brokerTrader({
        chainId: 42220,
        trader: "0xa",
        timestamp: "172800",
        volumeUsdWei: USD(25),
      }),
    ];
    const out = aggregateDailyVolume(rows);
    expect(out).toHaveLength(2);
    expect(out[0]!.timestamp).toBe(86400);
    expect(out[0]!.value).toBeCloseTo(150, 4);
    expect(out[1]!.timestamp).toBe(172800);
    expect(out[1]!.value).toBeCloseTo(25, 4);
  });
});

describe("mergeHeroSnapshot", () => {
  // Anchored at a real recent UTC midnight so unit semantics match the
  // live wire format: `snapshotDay` is Unix-seconds at UTC midnight. Day
  // arithmetic uses 86400-second steps. The exact anchor date doesn't
  // matter — only the relative-to-`TODAY_MIDNIGHT` deltas do.
  const SECONDS_PER_DAY = 86400;
  const TODAY_MIDNIGHT = 1778198400; // 2026-05-08 00:00:00 UTC
  const YESTERDAY_MIDNIGHT = TODAY_MIDNIGHT - SECONDS_PER_DAY;
  // `today - 2 days`: the canonical pre-first-swap-of-day state. The
  // indexer flushes on the first swap of a new UTC day, so before
  // today's first swap the latest snapshotDay is naturally this value.
  // Must NOT be flagged stale — that's the entire point of the
  // 2-day cutoff.
  const TWO_DAYS_AGO_MIDNIGHT = TODAY_MIDNIGHT - 2 * SECONDS_PER_DAY;
  // `today - 3 days`: snapshot is at least one full UTC day older
  // than the pre-heartbeat baseline, so staleness can be confidently
  // attributed to silence rather than to the heartbeat lag.
  const THREE_DAYS_AGO_MIDNIGHT = TODAY_MIDNIGHT - 3 * SECONDS_PER_DAY;

  function snap(
    overrides: Partial<LeaderboardWindowRow> & {
      chainId: number;
      totalVolumeUsdWei: string;
    },
  ): LeaderboardWindowRow {
    // Default `snapshotDay` to YESTERDAY — that's the heartbeat-cadence
    // freshness boundary (the indexer flushes the prior closed UTC day).
    // Tests that exercise staleness override `snapshotDay` explicitly.
    const snapshotDay = overrides.snapshotDay ?? String(YESTERDAY_MIDNIGHT);
    return {
      id: `${overrides.chainId}-7d-${snapshotDay}`,
      windowKey: "7d",
      snapshotDay,
      windowStartDay: String(Number(snapshotDay) - 6 * SECONDS_PER_DAY),
      // Default the *IncludingSystem siblings to match the primary fields
      // — most tests don't exercise the toggle, so picking either branch
      // yields the same numbers.
      totalVolumeUsdWeiIncludingSystem:
        overrides.totalVolumeUsdWeiIncludingSystem ??
        overrides.totalVolumeUsdWei,
      totalSwapCount: 0,
      totalSwapCountIncludingSystem: overrides.totalSwapCount ?? 0,
      uniqueTraders: 0,
      uniqueTradersIncludingSystem: overrides.uniqueTraders ?? 0,
      ...overrides,
    };
  }

  /** Factory for the isolated first-day slice row — auto-pairs with a
   *  `snap()` row by chainId/snapshotDay so tests pass them together. */
  function firstDay(
    overrides: Partial<LeaderboardWindowFirstDayRow> & { chainId: number },
  ): LeaderboardWindowFirstDayRow {
    const snapshotDay = overrides.snapshotDay ?? String(YESTERDAY_MIDNIGHT);
    return {
      snapshotDay,
      firstDayVolumeUsdWei: "0",
      firstDayVolumeUsdWeiIncludingSystem:
        overrides.firstDayVolumeUsdWeiIncludingSystem ??
        overrides.firstDayVolumeUsdWei ??
        "0",
      firstDaySwapCount: 0,
      firstDaySwapCountIncludingSystem:
        overrides.firstDaySwapCountIncludingSystem ??
        overrides.firstDaySwapCount ??
        0,
      firstDayExclusiveUniqueTraders: 0,
      firstDayExclusiveUniqueTradersIncludingSystem:
        overrides.firstDayExclusiveUniqueTradersIncludingSystem ??
        overrides.firstDayExclusiveUniqueTraders ??
        0,
      ...overrides,
    };
  }
  function overlap(
    overrides: Partial<LeaderboardPartialOverlapRow> & {
      chainId: number;
      trader: string;
    },
  ): LeaderboardPartialOverlapRow {
    return {
      timestamp: String(YESTERDAY_MIDNIGHT),
      isSystemAddress: false,
      ...overrides,
    };
  }
  function today(
    overrides: Partial<LeaderboardTodayTraderRow> & {
      chainId: number;
      trader: string;
      volumeUsdWei: string;
    },
  ): LeaderboardTodayTraderRow {
    return {
      swapCount: 1,
      isSystemAddress: false,
      ...overrides,
    };
  }

  it("returns zeros (and empty staleChains/degradedChains) when both inputs are empty/undefined", () => {
    expect(
      mergeHeroSnapshot({
        snapshotRows: undefined,
        todayRows: undefined,
        showSystem: false,
        todayMidnightSeconds: TODAY_MIDNIGHT,
      }),
    ).toEqual({
      totalVolumeUsdWei: BigInt(0),
      totalSwapCount: 0,
      uniqueTraders: 0,
      staleChains: [],
      degradedChains: [],
    });
  });

  it("snapshot-only: passes through totals", () => {
    const out = mergeHeroSnapshot({
      snapshotRows: [
        snap({
          chainId: 42220,
          totalVolumeUsdWei: USD(1000),
          totalSwapCount: 50,
          uniqueTraders: 10,
        }),
      ],
      todayRows: [],
      showSystem: false,
      todayMidnightSeconds: TODAY_MIDNIGHT,
    });
    expect(out.totalVolumeUsdWei).toBe(BigInt(USD(1000)));
    expect(out.totalSwapCount).toBe(50);
    expect(out.uniqueTraders).toBe(10);
    expect(out.staleChains).toEqual([]);
  });

  it("uses bounded overlap rows to de-dupe snapshot and today's partial rows", () => {
    const out = mergeHeroSnapshot({
      snapshotRows: [
        snap({
          chainId: 42220,
          totalVolumeUsdWei: USD(1000),
          totalSwapCount: 50,
          uniqueTraders: 2,
        }),
      ],
      todayRows: [
        today({ chainId: 42220, trader: "0xa", volumeUsdWei: USD(10) }),
        today({ chainId: 42220, trader: "0xc", volumeUsdWei: USD(10) }),
      ],
      partialOverlapRows: [overlap({ chainId: 42220, trader: "0xa" })],
      showSystem: false,
      todayMidnightSeconds: TODAY_MIDNIGHT,
    });
    expect(out.uniqueTraders).toBe(3);
  });

  it("does not de-dupe hidden-system partial traders excluded from snapshot unique count", () => {
    const out = mergeHeroSnapshot({
      snapshotRows: [
        snap({
          chainId: 42220,
          totalVolumeUsdWei: USD(1000),
          totalSwapCount: 50,
          uniqueTraders: 2,
        }),
      ],
      todayRows: [
        today({ chainId: 42220, trader: "0xsticky", volumeUsdWei: USD(10) }),
      ],
      partialOverlapRows: [
        overlap({ chainId: 42220, trader: "0xsticky" }),
        overlap({
          chainId: 42220,
          trader: "0xsticky",
          isSystemAddress: true,
        }),
      ],
      showSystem: false,
      todayMidnightSeconds: TODAY_MIDNIGHT,
    });

    expect(out.uniqueTraders).toBe(3);
  });

  it("falls back to legacy approximate unique counts when overlap rows are missing", () => {
    const out = mergeHeroSnapshot({
      snapshotRows: [
        snap({
          chainId: 42220,
          totalVolumeUsdWei: USD(1000),
          totalSwapCount: 50,
          uniqueTraders: 2,
        }),
      ],
      todayRows: [
        today({ chainId: 42220, trader: "0xa", volumeUsdWei: USD(10) }),
        today({ chainId: 42220, trader: "0xc", volumeUsdWei: USD(10) }),
      ],
      showSystem: false,
      todayMidnightSeconds: TODAY_MIDNIGHT,
    });
    expect(out.uniqueTraders).toBe(4);
  });

  it("treats partial traders as new when the bounded overlap query returns empty", () => {
    const out = mergeHeroSnapshot({
      snapshotRows: [
        snap({
          chainId: 42220,
          totalVolumeUsdWei: USD(1000),
          totalSwapCount: 50,
          uniqueTraders: 2,
        }),
      ],
      todayRows: [
        today({ chainId: 42220, trader: "0xc", volumeUsdWei: USD(10) }),
      ],
      partialOverlapRows: [],
      showSystem: false,
      todayMidnightSeconds: TODAY_MIDNIGHT,
    });
    expect(out.uniqueTraders).toBe(3);
  });

  it("uses bounded overlap rows through degraded-chain slice subtraction", () => {
    const out = mergeHeroSnapshot({
      snapshotRows: [
        snap({
          chainId: 42220,
          snapshotDay: String(TWO_DAYS_AGO_MIDNIGHT),
          totalVolumeUsdWei: USD(1000),
          totalSwapCount: 50,
          uniqueTraders: 3,
        }),
      ],
      firstDayRows: [
        firstDay({
          chainId: 42220,
          snapshotDay: String(TWO_DAYS_AGO_MIDNIGHT),
          firstDayVolumeUsdWei: USD(100),
          firstDaySwapCount: 5,
          firstDayExclusiveUniqueTraders: 1,
        }),
      ],
      yesterdayRows: [
        today({ chainId: 42220, trader: "0xb", volumeUsdWei: USD(10) }),
        today({ chainId: 42220, trader: "0xd", volumeUsdWei: USD(10) }),
      ],
      todayRows: [
        today({ chainId: 42220, trader: "0xc", volumeUsdWei: USD(10) }),
        today({ chainId: 42220, trader: "0xe", volumeUsdWei: USD(10) }),
      ],
      partialOverlapRows: [
        overlap({ chainId: 42220, trader: "0xb" }),
        overlap({ chainId: 42220, trader: "0xc" }),
      ],
      showSystem: false,
      todayMidnightSeconds: TODAY_MIDNIGHT,
    });
    expect(out.uniqueTraders).toBe(4);
    expect(out.degradedChains).toEqual([]);
  });

  it("preserves a first-day-exclusive trader who also appears in today's partial", () => {
    const out = mergeHeroSnapshot({
      snapshotRows: [
        snap({
          chainId: 42220,
          snapshotDay: String(TWO_DAYS_AGO_MIDNIGHT),
          totalVolumeUsdWei: USD(1000),
          totalSwapCount: 50,
          uniqueTraders: 2,
        }),
      ],
      firstDayRows: [
        firstDay({
          chainId: 42220,
          snapshotDay: String(TWO_DAYS_AGO_MIDNIGHT),
          firstDayVolumeUsdWei: USD(100),
          firstDaySwapCount: 5,
          firstDayExclusiveUniqueTraders: 1,
        }),
      ],
      yesterdayRows: [],
      todayRows: [
        today({ chainId: 42220, trader: "0xa", volumeUsdWei: USD(10) }),
      ],
      partialOverlapRows: [],
      showSystem: false,
      todayMidnightSeconds: TODAY_MIDNIGHT,
    });

    expect(out.uniqueTraders).toBe(2);
    expect(out.degradedChains).toEqual([]);
  });

  it("builds bounded overlap query input for retained snapshot ranges", () => {
    const snapshot = snap({
      chainId: 42220,
      snapshotDay: String(TWO_DAYS_AGO_MIDNIGHT),
      totalVolumeUsdWei: USD(1000),
      uniqueTraders: 2,
    });
    const input = buildHeroPartialOverlapQueryInput({
      snapshotRows: [snapshot],
      firstDayRows: [
        firstDay({
          chainId: 42220,
          snapshotDay: String(TWO_DAYS_AGO_MIDNIGHT),
          firstDayExclusiveUniqueTraders: 1,
        }),
      ],
      yesterdayRows: [
        today({ chainId: 42220, trader: "0xb", volumeUsdWei: USD(10) }),
      ],
      todayRows: [
        today({ chainId: 42220, trader: "0xa", volumeUsdWei: USD(10) }),
        today({
          chainId: 42220,
          trader: "0xsys",
          volumeUsdWei: USD(10),
          isSystemAddress: true,
        }),
      ],
      showSystem: false,
      todayMidnightSeconds: TODAY_MIDNIGHT,
    });

    expect(input).toEqual({
      limit: 4,
      where: {
        _or: [
          {
            chainId: { _eq: 42220 },
            trader: { _in: ["0xa", "0xb"] },
            timestamp: {
              _gte: Number(snapshot.windowStartDay) + SECONDS_PER_DAY,
              _lte: Number(snapshot.snapshotDay),
            },
          },
        ],
      },
    });
  });

  it("disables exact overlap when active partial traders exceed the query cap", () => {
    const snapshot = snap({
      chainId: 42220,
      totalVolumeUsdWei: USD(1000),
      uniqueTraders: 2,
    });
    const input = buildHeroPartialOverlapQueryInput({
      snapshotRows: [snapshot],
      todayRows: Array.from({ length: 1001 }, (_, i) =>
        today({
          chainId: 42220,
          trader: `0x${i.toString(16).padStart(40, "0")}`,
          volumeUsdWei: USD(1),
        }),
      ),
      showSystem: false,
      todayMidnightSeconds: TODAY_MIDNIGHT,
    });

    expect(input).toBeUndefined();
  });

  it("builds broker overlap query input with caller field", () => {
    const snapshot = snap({
      chainId: 42220,
      snapshotDay: String(TWO_DAYS_AGO_MIDNIGHT),
      totalVolumeUsdWei: USD(1000),
      uniqueTraders: 2,
    });
    const input = buildHeroPartialOverlapQueryInput({
      snapshotRows: [snapshot],
      todayRows: [
        today({ chainId: 42220, trader: "0xa", volumeUsdWei: USD(10) }),
      ],
      showSystem: false,
      todayMidnightSeconds: TODAY_MIDNIGHT,
      traderField: "caller",
    });

    expect(input).toEqual({
      limit: 2,
      where: {
        _or: [
          {
            chainId: { _eq: 42220 },
            caller: { _in: ["0xa"] },
            timestamp: {
              _gte: Number(snapshot.windowStartDay),
              _lte: Number(snapshot.snapshotDay),
            },
          },
        ],
      },
    });
  });

  it("today-only (cold start): returns today's totals", () => {
    const out = mergeHeroSnapshot({
      snapshotRows: undefined,
      todayRows: [
        today({
          chainId: 42220,
          trader: "0xa",
          volumeUsdWei: USD(50),
          swapCount: 2,
        }),
        today({
          chainId: 42220,
          trader: "0xb",
          volumeUsdWei: USD(100),
          swapCount: 3,
        }),
      ],
      showSystem: false,
      todayMidnightSeconds: TODAY_MIDNIGHT,
    });
    expect(out.totalVolumeUsdWei).toBe(BigInt(USD(150)));
    expect(out.totalSwapCount).toBe(5);
    expect(out.uniqueTraders).toBe(2);
    expect(out.staleChains).toEqual([]);
  });

  it("snapshot + today: sums totals; counts today's distinct traders separately", () => {
    const out = mergeHeroSnapshot({
      snapshotRows: [
        snap({
          chainId: 42220,
          totalVolumeUsdWei: USD(1000),
          totalSwapCount: 50,
          uniqueTraders: 10,
        }),
      ],
      todayRows: [
        today({
          chainId: 42220,
          trader: "0xa",
          volumeUsdWei: USD(50),
          swapCount: 2,
        }),
      ],
      showSystem: false,
      todayMidnightSeconds: TODAY_MIDNIGHT,
    });
    expect(out.totalVolumeUsdWei).toBe(BigInt(USD(1050)));
    expect(out.totalSwapCount).toBe(52);
    // Snapshot's 10 + today's 1 = 11 (no dedup; documented overcount)
    expect(out.uniqueTraders).toBe(11);
  });

  it("showSystem=true uses *IncludingSystem fields from snapshot", () => {
    const row = snap({
      chainId: 42220,
      totalVolumeUsdWei: USD(100),
      totalVolumeUsdWeiIncludingSystem: USD(150),
      totalSwapCount: 5,
      totalSwapCountIncludingSystem: 8,
      uniqueTraders: 5,
      uniqueTradersIncludingSystem: 12,
    });
    const off = mergeHeroSnapshot({
      snapshotRows: [row],
      todayRows: [],
      showSystem: false,
      todayMidnightSeconds: TODAY_MIDNIGHT,
    });
    const on = mergeHeroSnapshot({
      snapshotRows: [row],
      todayRows: [],
      showSystem: true,
      todayMidnightSeconds: TODAY_MIDNIGHT,
    });
    expect(off.totalVolumeUsdWei).toBe(BigInt(USD(100)));
    expect(off.totalSwapCount).toBe(5);
    expect(off.uniqueTraders).toBe(5);
    expect(on.totalVolumeUsdWei).toBe(BigInt(USD(150)));
    expect(on.totalSwapCount).toBe(8);
    expect(on.uniqueTraders).toBe(12);
  });

  it("showSystem=false filters system traders out of today's partial", () => {
    const out = mergeHeroSnapshot({
      snapshotRows: [],
      todayRows: [
        today({
          chainId: 42220,
          trader: "0xa",
          volumeUsdWei: USD(100),
          isSystemAddress: false,
        }),
        today({
          chainId: 42220,
          trader: "0xb",
          volumeUsdWei: USD(999),
          isSystemAddress: true,
        }),
      ],
      showSystem: false,
      todayMidnightSeconds: TODAY_MIDNIGHT,
    });
    expect(out.totalVolumeUsdWei).toBe(BigInt(USD(100)));
    expect(out.uniqueTraders).toBe(1);
  });

  it("sums across chains (Celo + Monad rows on the same window)", () => {
    const out = mergeHeroSnapshot({
      snapshotRows: [
        snap({
          chainId: 42220,
          totalVolumeUsdWei: USD(1000),
          totalSwapCount: 50,
          uniqueTraders: 10,
        }),
        snap({
          chainId: 10143,
          totalVolumeUsdWei: USD(500),
          totalSwapCount: 20,
          uniqueTraders: 4,
        }),
      ],
      todayRows: [],
      showSystem: false,
      todayMidnightSeconds: TODAY_MIDNIGHT,
    });
    expect(out.totalVolumeUsdWei).toBe(BigInt(USD(1500)));
    expect(out.totalSwapCount).toBe(70);
    expect(out.uniqueTraders).toBe(14);
    expect(out.staleChains).toEqual([]);
  });

  // ─── Stale-snapshot detection ───────────────────────────────────────
  // The heartbeat-driven flush only fires on the first swap of a new
  // UTC day. If a chain is silent through day N, no snapshot is written
  // for day N-1 until the next swap arrives. The `distinct_on: [chainId]`
  // hosted query returns the latest snapshot regardless of staleness, so
  // we filter client-side in `mergeHeroSnapshot`.

  it("includes today's snapshot in totals (boundary: snapshotDay === today)", () => {
    // Edge case: the indexer doesn't normally write today's snapshot
    // (it flushes the prior closed day), but a test-data injection or
    // a re-sync could produce one. It must be treated as fresh.
    const out = mergeHeroSnapshot({
      snapshotRows: [
        snap({
          chainId: 42220,
          snapshotDay: String(TODAY_MIDNIGHT),
          totalVolumeUsdWei: USD(1000),
          totalSwapCount: 50,
          uniqueTraders: 10,
        }),
      ],
      todayRows: [],
      showSystem: false,
      todayMidnightSeconds: TODAY_MIDNIGHT,
    });
    expect(out.totalVolumeUsdWei).toBe(BigInt(USD(1000)));
    expect(out.totalSwapCount).toBe(50);
    expect(out.uniqueTraders).toBe(10);
    expect(out.staleChains).toEqual([]);
  });

  it("includes yesterday's snapshot in totals (boundary: heartbeat cadence is fresh)", () => {
    // Yesterday is the normal heartbeat cadence — the indexer flushes
    // the prior closed UTC day at the first swap of today. This is
    // the canonical fresh case and must NOT be flagged stale.
    const out = mergeHeroSnapshot({
      snapshotRows: [
        snap({
          chainId: 42220,
          snapshotDay: String(YESTERDAY_MIDNIGHT),
          totalVolumeUsdWei: USD(1000),
          totalSwapCount: 50,
          uniqueTraders: 10,
        }),
      ],
      todayRows: [],
      showSystem: false,
      todayMidnightSeconds: TODAY_MIDNIGHT,
    });
    expect(out.totalVolumeUsdWei).toBe(BigInt(USD(1000)));
    expect(out.staleChains).toEqual([]);
  });

  it("excludes a stale snapshot (snapshotDay = today - 3 days) and reports the chainId", () => {
    const out = mergeHeroSnapshot({
      snapshotRows: [
        snap({
          chainId: 10143, // Monad — silent past the heartbeat lag
          snapshotDay: String(THREE_DAYS_AGO_MIDNIGHT),
          totalVolumeUsdWei: USD(500),
          totalSwapCount: 20,
          uniqueTraders: 4,
        }),
      ],
      todayRows: [],
      showSystem: false,
      todayMidnightSeconds: TODAY_MIDNIGHT,
    });
    // Stale row's totals must not contribute to hero numbers.
    expect(out.totalVolumeUsdWei).toBe(BigInt(0));
    expect(out.totalSwapCount).toBe(0);
    expect(out.uniqueTraders).toBe(0);
    expect(out.staleChains).toEqual([10143]);
  });

  it("mixed staleness: drops stale chain, keeps fresh chain, populates staleChains", () => {
    const out = mergeHeroSnapshot({
      snapshotRows: [
        snap({
          chainId: 42220, // Celo — fresh
          snapshotDay: String(YESTERDAY_MIDNIGHT),
          totalVolumeUsdWei: USD(1000),
          totalSwapCount: 50,
          uniqueTraders: 10,
        }),
        snap({
          chainId: 10143, // Monad — stale
          snapshotDay: String(THREE_DAYS_AGO_MIDNIGHT),
          totalVolumeUsdWei: USD(500),
          totalSwapCount: 20,
          uniqueTraders: 4,
        }),
      ],
      todayRows: [],
      showSystem: false,
      todayMidnightSeconds: TODAY_MIDNIGHT,
    });
    expect(out.totalVolumeUsdWei).toBe(BigInt(USD(1000)));
    expect(out.totalSwapCount).toBe(50);
    expect(out.uniqueTraders).toBe(10);
    expect(out.staleChains).toEqual([10143]);
  });

  it("staleness filter applies under showSystem=true (uses *IncludingSystem fields, still skips stale)", () => {
    const out = mergeHeroSnapshot({
      snapshotRows: [
        snap({
          chainId: 10143,
          snapshotDay: String(THREE_DAYS_AGO_MIDNIGHT),
          totalVolumeUsdWei: USD(500),
          totalVolumeUsdWeiIncludingSystem: USD(800),
          totalSwapCount: 20,
          totalSwapCountIncludingSystem: 35,
          uniqueTraders: 4,
          uniqueTradersIncludingSystem: 8,
        }),
      ],
      todayRows: [],
      showSystem: true,
      todayMidnightSeconds: TODAY_MIDNIGHT,
    });
    expect(out.totalVolumeUsdWei).toBe(BigInt(0));
    expect(out.totalSwapCount).toBe(0);
    expect(out.uniqueTraders).toBe(0);
    expect(out.staleChains).toEqual([10143]);
  });

  it("includes today - 2 days snapshot (boundary: pre-first-swap-of-day is fresh)", () => {
    // Before today's first swap fires the heartbeat, the latest
    // snapshotDay is naturally `today - 2 days` (yesterday's first
    // swap flushed the day before). Treating that as stale would
    // generate a false banner on every chain shortly after UTC
    // midnight. The 2-day cutoff (vs. a 1-day cutoff) prevents this.
    const out = mergeHeroSnapshot({
      snapshotRows: [
        snap({
          chainId: 42220,
          snapshotDay: String(TWO_DAYS_AGO_MIDNIGHT),
          totalVolumeUsdWei: USD(750),
          totalSwapCount: 30,
          uniqueTraders: 8,
        }),
      ],
      todayRows: [],
      showSystem: false,
      todayMidnightSeconds: TODAY_MIDNIGHT,
    });
    expect(out.totalVolumeUsdWei).toBe(BigInt(USD(750)));
    expect(out.totalSwapCount).toBe(30);
    expect(out.uniqueTraders).toBe(8);
    expect(out.staleChains).toEqual([]);
  });

  it("never marks `all` rows stale, even with very old snapshotDay", () => {
    // The all-time window is cumulative from epoch; intervening empty
    // days don't invalidate the total. Old snapshotDay just means the
    // chain has been quiet — total volume since launch is still right.
    const veryOldSnapshotDay = TODAY_MIDNIGHT - 365 * SECONDS_PER_DAY;
    const out = mergeHeroSnapshot({
      snapshotRows: [
        snap({
          chainId: 10143,
          windowKey: "all",
          snapshotDay: String(veryOldSnapshotDay),
          windowStartDay: "0",
          totalVolumeUsdWei: USD(2000),
          totalSwapCount: 100,
          uniqueTraders: 25,
        }),
      ],
      todayRows: [],
      showSystem: false,
      todayMidnightSeconds: TODAY_MIDNIGHT,
    });
    expect(out.totalVolumeUsdWei).toBe(BigInt(USD(2000)));
    expect(out.totalSwapCount).toBe(100);
    expect(out.uniqueTraders).toBe(25);
    expect(out.staleChains).toEqual([]);
  });

  it("never marks `24h` rows stale (snapshot is intentionally empty; todayRows covers it)", () => {
    // The indexer writes 24h snapshots as an empty inclusive range
    // (`[snapshotDay+1, snapshotDay]`), so the dashboard's 24h KPI is
    // always supplied by `todayRows`. A stale `24h` snapshotDay
    // therefore carries no missing-data signal — flagging it would
    // generate a false banner.
    const out = mergeHeroSnapshot({
      snapshotRows: [
        snap({
          chainId: 10143,
          windowKey: "24h",
          snapshotDay: String(THREE_DAYS_AGO_MIDNIGHT),
          totalVolumeUsdWei: USD(0),
          totalSwapCount: 0,
          uniqueTraders: 0,
        }),
      ],
      todayRows: [
        today({
          chainId: 10143,
          trader: "0xa",
          volumeUsdWei: USD(40),
          swapCount: 1,
        }),
      ],
      showSystem: false,
      todayMidnightSeconds: TODAY_MIDNIGHT,
    });
    expect(out.totalVolumeUsdWei).toBe(BigInt(USD(40)));
    expect(out.totalSwapCount).toBe(1);
    expect(out.uniqueTraders).toBe(1);
    expect(out.staleChains).toEqual([]);
  });

  it("marks `30d` and `90d` rows stale on the same cutoff as `7d`", () => {
    // Same staleness rule applies to all rolling windows.
    const out = mergeHeroSnapshot({
      snapshotRows: [
        snap({
          chainId: 42220,
          windowKey: "30d",
          snapshotDay: String(THREE_DAYS_AGO_MIDNIGHT),
          totalVolumeUsdWei: USD(500),
        }),
        snap({
          chainId: 10143,
          windowKey: "90d",
          snapshotDay: String(THREE_DAYS_AGO_MIDNIGHT),
          totalVolumeUsdWei: USD(700),
        }),
      ],
      todayRows: [],
      showSystem: false,
      todayMidnightSeconds: TODAY_MIDNIGHT,
    });
    expect(out.totalVolumeUsdWei).toBe(BigInt(0));
    expect(out.staleChains).toEqual([42220, 10143]);
  });

  it("stale chain: today's partial is also dropped (concentration-mask consistency)", () => {
    // Both halves of a stale chain are excluded from the rollup so
    // top10Concentration's same-mask invariant holds: a stale chain
    // whose today's partial leaked into `totalVolumeUsdWei` would put
    // volume in the denominator while the numerator (built from
    // top-50 trader rows) skips that chainId, distorting the ratio.
    // The banner naming the chain still surfaces the data gap to the
    // user.
    const out = mergeHeroSnapshot({
      snapshotRows: [
        snap({
          chainId: 10143,
          snapshotDay: String(THREE_DAYS_AGO_MIDNIGHT),
          totalVolumeUsdWei: USD(500),
        }),
      ],
      todayRows: [
        today({
          chainId: 10143,
          trader: "0xa",
          volumeUsdWei: USD(50),
          swapCount: 2,
        }),
      ],
      showSystem: false,
      todayMidnightSeconds: TODAY_MIDNIGHT,
    });
    expect(out.totalVolumeUsdWei).toBe(BigInt(0));
    expect(out.totalSwapCount).toBe(0);
    expect(out.uniqueTraders).toBe(0);
    expect(out.staleChains).toEqual([10143]);
    expect(out.degradedChains).toEqual([]);
  });

  it("degraded chain: snapshotDay = today - 2 days marks chain degraded but keeps it in totals", () => {
    // The canonical pre-first-swap-of-day state for an active chain.
    // Yesterday's data isn't in the snapshot (it ends at T-2) and
    // isn't in todayRows (no swap today yet), so hero KPIs are
    // recent-incomplete — but the snapshot's cumulative volume up to
    // T-2 is still useful and should not be dropped. Caller surfaces
    // a lighter banner.
    const out = mergeHeroSnapshot({
      snapshotRows: [
        snap({
          chainId: 10143,
          snapshotDay: String(TWO_DAYS_AGO_MIDNIGHT),
          totalVolumeUsdWei: USD(500),
          totalSwapCount: 20,
          uniqueTraders: 4,
        }),
      ],
      todayRows: [],
      showSystem: false,
      todayMidnightSeconds: TODAY_MIDNIGHT,
    });
    expect(out.totalVolumeUsdWei).toBe(BigInt(USD(500)));
    expect(out.totalSwapCount).toBe(20);
    expect(out.uniqueTraders).toBe(4);
    expect(out.staleChains).toEqual([]);
    expect(out.degradedChains).toEqual([10143]);
  });

  it("degraded chain: today's partial is included (only stale chains drop today's rows)", () => {
    // A chain may briefly be in the degraded state (snapshotDay =
    // T-2) yet still have a today's-partial row if the heartbeat read
    // raced the today's-partial read. Today's volume should be
    // included in the rollup; only `staleChains` triggers today-row
    // exclusion.
    const out = mergeHeroSnapshot({
      snapshotRows: [
        snap({
          chainId: 10143,
          snapshotDay: String(TWO_DAYS_AGO_MIDNIGHT),
          totalVolumeUsdWei: USD(500),
        }),
      ],
      todayRows: [
        today({
          chainId: 10143,
          trader: "0xa",
          volumeUsdWei: USD(50),
          swapCount: 2,
        }),
      ],
      showSystem: false,
      todayMidnightSeconds: TODAY_MIDNIGHT,
    });
    expect(out.totalVolumeUsdWei).toBe(BigInt(USD(550)));
    expect(out.totalSwapCount).toBe(2);
    expect(out.uniqueTraders).toBe(1);
    expect(out.staleChains).toEqual([]);
    expect(out.degradedChains).toEqual([10143]);
  });

  it("mixed: fresh + degraded + stale chains populate the right lists with correct totals", () => {
    const out = mergeHeroSnapshot({
      snapshotRows: [
        snap({
          chainId: 42220, // Celo — fresh (yesterday)
          snapshotDay: String(YESTERDAY_MIDNIGHT),
          totalVolumeUsdWei: USD(1000),
          totalSwapCount: 50,
          uniqueTraders: 10,
        }),
        snap({
          chainId: 10143, // Monad — degraded (T-2)
          snapshotDay: String(TWO_DAYS_AGO_MIDNIGHT),
          totalVolumeUsdWei: USD(300),
          totalSwapCount: 12,
          uniqueTraders: 3,
        }),
        snap({
          chainId: 11155111, // Sepolia — stale (T-3)
          snapshotDay: String(THREE_DAYS_AGO_MIDNIGHT),
          totalVolumeUsdWei: USD(700),
          totalSwapCount: 30,
          uniqueTraders: 5,
        }),
      ],
      todayRows: [],
      showSystem: false,
      todayMidnightSeconds: TODAY_MIDNIGHT,
    });
    // Fresh + degraded snapshot volumes contribute; stale dropped.
    expect(out.totalVolumeUsdWei).toBe(BigInt(USD(1300)));
    expect(out.totalSwapCount).toBe(62);
    expect(out.uniqueTraders).toBe(13);
    expect(out.staleChains).toEqual([11155111]);
    expect(out.degradedChains).toEqual([10143]);
  });

  // ─── Degraded-chain catch-up via slice subtraction ───────────────
  // PR #339 shipped the DEGRADED banner; this PR ships the catch-up.
  // For a `7d` snapshot anchored at `T-2`, the snapshot covers
  // `[T-7, T-2]` (6 closed days). Naively adding yesterday + today
  // on top yields 8 days because the boundary day `T-7` is still in
  // the count. Slice subtraction drops the snapshot's first-day
  // contribution and replaces with yesterday + today, yielding the
  // correct 7-day rolling window.

  it("degraded chain + yesterday rows: slice subtraction supplements totals; chain drops from degradedChains", () => {
    const out = mergeHeroSnapshot({
      snapshotRows: [
        snap({
          chainId: 10143,
          snapshotDay: String(TWO_DAYS_AGO_MIDNIGHT),
          totalVolumeUsdWei: USD(700),
          totalSwapCount: 35,
          uniqueTraders: 7,
        }),
      ],
      // First-day slice from the isolated query — paired by
      // (chainId, snapshotDay).
      firstDayRows: [
        firstDay({
          chainId: 10143,
          snapshotDay: String(TWO_DAYS_AGO_MIDNIGHT),
          firstDayVolumeUsdWei: USD(120),
          firstDaySwapCount: 6,
          firstDayExclusiveUniqueTraders: 2,
        }),
      ],
      todayRows: [],
      yesterdayRows: [
        today({
          chainId: 10143,
          trader: "0xa",
          volumeUsdWei: USD(80),
          swapCount: 4,
        }),
        today({
          chainId: 10143,
          trader: "0xb",
          volumeUsdWei: USD(40),
          swapCount: 2,
        }),
      ],
      showSystem: false,
      todayMidnightSeconds: TODAY_MIDNIGHT,
    });
    // Volume: snapshot 700 - firstDay 120 + yesterday (80+40) = 700.
    expect(out.totalVolumeUsdWei).toBe(BigInt(USD(700)));
    // Swaps: 35 - 6 + (4+2) = 35.
    expect(out.totalSwapCount).toBe(35);
    // Unique traders: 7 - 2 (exclusive) + 2 (yesterday distinct).
    expect(out.uniqueTraders).toBe(7);
    // Chain has been supplemented → no longer degraded.
    expect(out.degradedChains).toEqual([]);
    expect(out.staleChains).toEqual([]);
  });

  it("degraded chain + EMPTY yesterday rows: slice still subtracts (zero yesterday is authoritative, not 'data missing')", () => {
    // `yesterdayRows: []` means the query completed and reported zero
    // activity yesterday. The window must still slide forward by
    // subtracting the first-day slice — without subtraction, hero
    // KPIs would keep an extra closed day and overstate totals.
    const out = mergeHeroSnapshot({
      snapshotRows: [
        snap({
          chainId: 10143,
          snapshotDay: String(TWO_DAYS_AGO_MIDNIGHT),
          totalVolumeUsdWei: USD(500),
          totalSwapCount: 20,
          uniqueTraders: 4,
        }),
      ],
      firstDayRows: [
        firstDay({
          chainId: 10143,
          snapshotDay: String(TWO_DAYS_AGO_MIDNIGHT),
          firstDayVolumeUsdWei: USD(100),
          firstDaySwapCount: 5,
          firstDayExclusiveUniqueTraders: 1,
        }),
      ],
      todayRows: [],
      yesterdayRows: [],
      showSystem: false,
      todayMidnightSeconds: TODAY_MIDNIGHT,
    });
    // Volume: 500 - 100 (first-day) + 0 (no yesterday) = 400.
    expect(out.totalVolumeUsdWei).toBe(BigInt(USD(400)));
    // Swaps: 20 - 5 + 0 = 15.
    expect(out.totalSwapCount).toBe(15);
    // Unique: 4 - 1 + 0 = 3.
    expect(out.uniqueTraders).toBe(3);
    // Chain has been supplemented authoritatively → no longer degraded.
    expect(out.degradedChains).toEqual([]);
  });

  it("degraded chain + yesterday rows only for a DIFFERENT chain: this chain still gets slice subtraction (zero yesterday rows for it)", () => {
    // `yesterdayRows` carries rows for chain 42220 (not degraded) but
    // none for 10143 (degraded). Per the authoritative-empty semantics,
    // 10143 still gets its first-day slice subtracted with a zero
    // yesterday contribution — sliding the window forward by one
    // day. Rows for non-degraded chains are ignored (the rollup
    // already covered them via snapshot + today).
    const out = mergeHeroSnapshot({
      snapshotRows: [
        snap({
          chainId: 10143,
          snapshotDay: String(TWO_DAYS_AGO_MIDNIGHT),
          totalVolumeUsdWei: USD(500),
          totalSwapCount: 20,
          uniqueTraders: 4,
        }),
      ],
      firstDayRows: [
        firstDay({
          chainId: 10143,
          snapshotDay: String(TWO_DAYS_AGO_MIDNIGHT),
          firstDayVolumeUsdWei: USD(100),
          firstDaySwapCount: 5,
          firstDayExclusiveUniqueTraders: 1,
        }),
      ],
      todayRows: [],
      yesterdayRows: [
        today({
          chainId: 42220, // not the degraded chain
          trader: "0xz",
          volumeUsdWei: USD(50),
          swapCount: 1,
        }),
      ],
      showSystem: false,
      todayMidnightSeconds: TODAY_MIDNIGHT,
    });
    // 10143 supplemented with empty per-chain rows: 500 - 100 = 400.
    expect(out.totalVolumeUsdWei).toBe(BigInt(USD(400)));
    expect(out.totalSwapCount).toBe(15);
    expect(out.uniqueTraders).toBe(3);
    // No longer degraded.
    expect(out.degradedChains).toEqual([]);
  });

  it("mixed: one degraded chain has yesterday rows, another doesn't — both supplemented; only stale stays banner-worthy", () => {
    // Authoritative-yesterday semantics: every degraded chain gets
    // its first-day slice subtracted, regardless of whether the
    // chain itself shows up in `yesterdayRows`. Chains without rows
    // get a zero yesterday contribution. The `degradedChains` return
    // value is empty after catch-up because all sliced.
    const out = mergeHeroSnapshot({
      snapshotRows: [
        snap({
          chainId: 42220, // fresh — yesterday cadence
          snapshotDay: String(YESTERDAY_MIDNIGHT),
          totalVolumeUsdWei: USD(800),
          totalSwapCount: 40,
          uniqueTraders: 8,
        }),
        snap({
          chainId: 10143, // degraded — yesterday rows present → supplement w/ rows
          snapshotDay: String(TWO_DAYS_AGO_MIDNIGHT),
          totalVolumeUsdWei: USD(300),
          totalSwapCount: 15,
          uniqueTraders: 3,
        }),
        snap({
          chainId: 8453, // degraded — no yesterday rows → supplement w/ zero
          snapshotDay: String(TWO_DAYS_AGO_MIDNIGHT),
          totalVolumeUsdWei: USD(200),
          totalSwapCount: 8,
          uniqueTraders: 2,
        }),
      ],
      firstDayRows: [
        firstDay({
          chainId: 10143,
          snapshotDay: String(TWO_DAYS_AGO_MIDNIGHT),
          firstDayVolumeUsdWei: USD(50),
          firstDaySwapCount: 3,
          firstDayExclusiveUniqueTraders: 1,
        }),
        firstDay({
          chainId: 8453,
          snapshotDay: String(TWO_DAYS_AGO_MIDNIGHT),
          firstDayVolumeUsdWei: USD(40),
          firstDaySwapCount: 2,
          firstDayExclusiveUniqueTraders: 1,
        }),
      ],
      todayRows: [],
      yesterdayRows: [
        today({
          chainId: 10143,
          trader: "0xa",
          volumeUsdWei: USD(70),
          swapCount: 4,
        }),
      ],
      showSystem: false,
      todayMidnightSeconds: TODAY_MIDNIGHT,
    });
    // Fresh: 800. 10143 sliced: 300 - 50 + 70 = 320.
    // 8453 sliced: 200 - 40 + 0 = 160. Total = 1280.
    expect(out.totalVolumeUsdWei).toBe(BigInt(USD(1280)));
    // Swaps: 40 + (15 - 3 + 4) + (8 - 2 + 0) = 62.
    expect(out.totalSwapCount).toBe(62);
    // Unique traders: 8 + (3 - 1 + 1) + (2 - 1 + 0) = 12.
    expect(out.uniqueTraders).toBe(12);
    expect(out.degradedChains).toEqual([]);
    expect(out.staleChains).toEqual([]);
  });

  it("slice subtraction uses *IncludingSystem fields when showSystem=true", () => {
    // showSystem=true reads the *IncludingSystem totals; the
    // first-day subtraction MUST also use the *IncludingSystem
    // first-day fields, otherwise the units diverge.
    const out = mergeHeroSnapshot({
      snapshotRows: [
        snap({
          chainId: 10143,
          snapshotDay: String(TWO_DAYS_AGO_MIDNIGHT),
          totalVolumeUsdWei: USD(500),
          totalVolumeUsdWeiIncludingSystem: USD(900),
          totalSwapCount: 20,
          totalSwapCountIncludingSystem: 50,
          uniqueTraders: 4,
          uniqueTradersIncludingSystem: 9,
        }),
      ],
      firstDayRows: [
        firstDay({
          chainId: 10143,
          snapshotDay: String(TWO_DAYS_AGO_MIDNIGHT),
          firstDayVolumeUsdWei: USD(80),
          firstDayVolumeUsdWeiIncludingSystem: USD(150),
          firstDaySwapCount: 4,
          firstDaySwapCountIncludingSystem: 10,
          firstDayExclusiveUniqueTraders: 1,
          firstDayExclusiveUniqueTradersIncludingSystem: 3,
        }),
      ],
      todayRows: [],
      yesterdayRows: [
        today({
          chainId: 10143,
          trader: "0xa",
          volumeUsdWei: USD(100),
          swapCount: 5,
          isSystemAddress: false,
        }),
        today({
          chainId: 10143,
          trader: "0xsys",
          volumeUsdWei: USD(40),
          swapCount: 3,
          isSystemAddress: true,
        }),
      ],
      showSystem: true,
      todayMidnightSeconds: TODAY_MIDNIGHT,
    });
    // *IncludingSystem branch: 900 - 150 + (100 + 40) = 890.
    expect(out.totalVolumeUsdWei).toBe(BigInt(USD(890)));
    // Swaps: 50 - 10 + (5+3) = 48.
    expect(out.totalSwapCount).toBe(48);
    // Unique: 9 - 3 + 2 = 8.
    expect(out.uniqueTraders).toBe(8);
    expect(out.degradedChains).toEqual([]);
  });

  it("slice subtraction uses primary fields when showSystem=false; system rows in yesterday filtered out", () => {
    const out = mergeHeroSnapshot({
      snapshotRows: [
        snap({
          chainId: 10143,
          snapshotDay: String(TWO_DAYS_AGO_MIDNIGHT),
          totalVolumeUsdWei: USD(500),
          totalVolumeUsdWeiIncludingSystem: USD(900),
          totalSwapCount: 20,
          totalSwapCountIncludingSystem: 50,
          uniqueTraders: 4,
          uniqueTradersIncludingSystem: 9,
        }),
      ],
      firstDayRows: [
        firstDay({
          chainId: 10143,
          snapshotDay: String(TWO_DAYS_AGO_MIDNIGHT),
          firstDayVolumeUsdWei: USD(80),
          firstDayVolumeUsdWeiIncludingSystem: USD(150),
          firstDaySwapCount: 4,
          firstDaySwapCountIncludingSystem: 10,
          firstDayExclusiveUniqueTraders: 1,
          firstDayExclusiveUniqueTradersIncludingSystem: 3,
        }),
      ],
      todayRows: [],
      yesterdayRows: [
        today({
          chainId: 10143,
          trader: "0xa",
          volumeUsdWei: USD(100),
          swapCount: 5,
          isSystemAddress: false,
        }),
        today({
          chainId: 10143,
          trader: "0xsys",
          volumeUsdWei: USD(40),
          swapCount: 3,
          isSystemAddress: true,
        }),
      ],
      showSystem: false,
      todayMidnightSeconds: TODAY_MIDNIGHT,
    });
    // Primary branch: 500 - 80 + 100 (system row filtered) = 520.
    expect(out.totalVolumeUsdWei).toBe(BigInt(USD(520)));
    // Swaps: 20 - 4 + 5 = 21.
    expect(out.totalSwapCount).toBe(21);
    // Unique: 4 - 1 + 1 = 4.
    expect(out.uniqueTraders).toBe(4);
    expect(out.degradedChains).toEqual([]);
  });

  it("yesterdayRows undefined: degraded chain stays in list (caller didn't fire the query)", () => {
    // Caller's first-pass merge returned non-empty degradedChains,
    // but the gated query hasn't completed yet (or errored). The
    // merge must behave the same as before slice-subtraction
    // existed: snapshot kept, banner shown.
    const out = mergeHeroSnapshot({
      snapshotRows: [
        snap({
          chainId: 10143,
          snapshotDay: String(TWO_DAYS_AGO_MIDNIGHT),
          totalVolumeUsdWei: USD(500),
          totalSwapCount: 20,
          uniqueTraders: 4,
        }),
      ],
      firstDayRows: [
        firstDay({
          chainId: 10143,
          snapshotDay: String(TWO_DAYS_AGO_MIDNIGHT),
          firstDayVolumeUsdWei: USD(80),
          firstDaySwapCount: 4,
          firstDayExclusiveUniqueTraders: 1,
        }),
      ],
      todayRows: [],
      // yesterdayRows omitted entirely.
      showSystem: false,
      todayMidnightSeconds: TODAY_MIDNIGHT,
    });
    expect(out.totalVolumeUsdWei).toBe(BigInt(USD(500)));
    expect(out.degradedChains).toEqual([10143]);
  });

  it("firstDayRows undefined (isolated query hasn't completed): degraded chain stays in list even if yesterdayRows present", () => {
    // Catch-up requires BOTH the firstDay slice AND yesterday rows.
    // If only one has landed, the chain stays degraded — fall back to
    // the pre-catch-up behavior rather than risk an inconsistent
    // partial subtraction.
    const out = mergeHeroSnapshot({
      snapshotRows: [
        snap({
          chainId: 10143,
          snapshotDay: String(TWO_DAYS_AGO_MIDNIGHT),
          totalVolumeUsdWei: USD(500),
          totalSwapCount: 20,
          uniqueTraders: 4,
        }),
      ],
      // firstDayRows omitted — isolated query lagging.
      todayRows: [],
      yesterdayRows: [
        today({
          chainId: 10143,
          trader: "0xa",
          volumeUsdWei: USD(50),
          swapCount: 2,
        }),
      ],
      showSystem: false,
      todayMidnightSeconds: TODAY_MIDNIGHT,
    });
    // Snapshot untouched, chain still degraded.
    expect(out.totalVolumeUsdWei).toBe(BigInt(USD(500)));
    expect(out.degradedChains).toEqual([10143]);
  });

  it("undefined vs [] semantics: undefined keeps degraded; [] slides the window", () => {
    // Pin the distinction. Same snapshot, two passes, only the
    // yesterdayRows arg differs. firstDayRows is present in both.
    const baseArgs = {
      snapshotRows: [
        snap({
          chainId: 10143,
          snapshotDay: String(TWO_DAYS_AGO_MIDNIGHT),
          totalVolumeUsdWei: USD(500),
          totalSwapCount: 20,
          uniqueTraders: 4,
        }),
      ],
      firstDayRows: [
        firstDay({
          chainId: 10143,
          snapshotDay: String(TWO_DAYS_AGO_MIDNIGHT),
          firstDayVolumeUsdWei: USD(100),
          firstDaySwapCount: 5,
          firstDayExclusiveUniqueTraders: 1,
        }),
      ],
      todayRows: [],
      showSystem: false,
      todayMidnightSeconds: TODAY_MIDNIGHT,
    };
    const undefinedPass = mergeHeroSnapshot(baseArgs);
    const emptyPass = mergeHeroSnapshot({ ...baseArgs, yesterdayRows: [] });
    // undefined: snapshot untouched, chain stays degraded.
    expect(undefinedPass.totalVolumeUsdWei).toBe(BigInt(USD(500)));
    expect(undefinedPass.degradedChains).toEqual([10143]);
    // []: slice subtraction runs, chain drops out of degraded.
    expect(emptyPass.totalVolumeUsdWei).toBe(BigInt(USD(400)));
    expect(emptyPass.degradedChains).toEqual([]);
  });

  it("showSystem=false + only-system yesterday rows: filtered out, but slice still subtracts (zero non-system contribution)", () => {
    // The only yesterday rows are system-address; with
    // `showSystem=false` they're filtered before the per-chain
    // bucket. The first-day slice still subtracts (authoritative
    // empty) and the chain drops from degraded.
    const out = mergeHeroSnapshot({
      snapshotRows: [
        snap({
          chainId: 10143,
          snapshotDay: String(TWO_DAYS_AGO_MIDNIGHT),
          totalVolumeUsdWei: USD(500),
          totalSwapCount: 20,
          uniqueTraders: 4,
        }),
      ],
      firstDayRows: [
        firstDay({
          chainId: 10143,
          snapshotDay: String(TWO_DAYS_AGO_MIDNIGHT),
          firstDayVolumeUsdWei: USD(80),
          firstDaySwapCount: 4,
          firstDayExclusiveUniqueTraders: 1,
        }),
      ],
      todayRows: [],
      yesterdayRows: [
        today({
          chainId: 10143,
          trader: "0xsys",
          volumeUsdWei: USD(40),
          swapCount: 3,
          isSystemAddress: true,
        }),
      ],
      showSystem: false,
      todayMidnightSeconds: TODAY_MIDNIGHT,
    });
    // 500 - 80 (first-day primary) + 0 (system row filtered out) = 420.
    expect(out.totalVolumeUsdWei).toBe(BigInt(USD(420)));
    expect(out.totalSwapCount).toBe(16);
    expect(out.uniqueTraders).toBe(3);
    expect(out.degradedChains).toEqual([]);
  });
});

describe("top10Concentration", () => {
  // Use the same kpiSource shape as the page passes — only the two
  // fields the helper reads matter (`chainId`, `volumeUsdWei`).
  const row = (chainId: number, usd: number) => ({
    chainId,
    volumeUsdWei: BigInt(USD(usd)),
  });

  it("returns 0 when there are no rows", () => {
    expect(
      top10Concentration({
        rowsByVolumeDesc: [],
        totalVolumeUsdWei: BigInt(USD(1000)),
        staleChains: [],
      }),
    ).toBe(0);
  });

  it("returns 0 when the denominator is zero (avoids divide-by-zero)", () => {
    expect(
      top10Concentration({
        rowsByVolumeDesc: [row(42220, 100)],
        totalVolumeUsdWei: BigInt(0),
        staleChains: [],
      }),
    ).toBe(0);
  });

  it("sums top-10 by volume descending when no chain is stale", () => {
    // 12 rows; only the first 10 contribute to the numerator.
    const rows = Array.from({ length: 12 }, (_, i) => row(42220, 100 - i));
    // Top 10 = 100 + 99 + 98 + ... + 91 = 955
    // Denominator (set to top-10 sum + tail) = 955 + 90 + 89 = 1134
    const total = BigInt(USD(1134));
    const out = top10Concentration({
      rowsByVolumeDesc: rows,
      totalVolumeUsdWei: total,
      staleChains: [],
    });
    expect(out).toBeCloseTo((955 / 1134) * 100, 1);
  });

  it("excludes stale-chain rows from the numerator (matches denominator scope)", () => {
    // Mixed-chain population: Celo (fresh) and Monad (stale). The
    // denominator already excludes Monad's snapshot via mergeHeroSnapshot;
    // the numerator must also drop Monad's per-trader rows or the ratio
    // becomes incoherent (can exceed 100% or hide concentration).
    const out = top10Concentration({
      rowsByVolumeDesc: [
        row(10143, 800), // Monad — stale, must be skipped
        row(42220, 600), // Celo — counted
        row(42220, 300), // Celo — counted
      ],
      // Denominator excludes Monad's $800 (consistent with the new
      // mergeHeroSnapshot behavior): only Celo's $900 contributes.
      totalVolumeUsdWei: BigInt(USD(900)),
      staleChains: [10143],
    });
    // Celo top-2 = $900; ratio = 900 / 900 = 100%.
    expect(out).toBeCloseTo(100, 1);
  });

  it("never exceeds 100% when a stale chain dominates the numerator pool", () => {
    // Pre-fix repro: stale chain contributes $800 to the unfiltered
    // numerator, denominator drops to $300. Without filtering: 800/300 =
    // 266%. With filtering: 200/300 = 66.7%.
    const out = top10Concentration({
      rowsByVolumeDesc: [row(10143, 800), row(42220, 200)],
      totalVolumeUsdWei: BigInt(USD(300)), // denominator after stale-chain drop
      staleChains: [10143],
    });
    expect(out).toBeLessThanOrEqual(100);
    // Sanity: only Celo's $200 contributes to numerator.
    expect(out).toBeCloseTo((200 / 300) * 100, 1);
  });

  it("walks past stale-chain rows to fill the top-10 with fresh-chain entries", () => {
    // 15-row source with stale-chain rows interleaved at positions 0–4
    // (highest volumes). Without `consumed` tracking, the early-skips
    // would prematurely close the top-10 window and undercount.
    const rows = [
      row(10143, 1000), // skip
      row(10143, 990), // skip
      row(10143, 980), // skip
      row(10143, 970), // skip
      row(10143, 960), // skip
      ...Array.from({ length: 10 }, (_, i) => row(42220, 100 - i)), // 10 fresh rows
    ];
    // Numerator = 100 + 99 + 98 + ... + 91 = 955
    const out = top10Concentration({
      rowsByVolumeDesc: rows,
      totalVolumeUsdWei: BigInt(USD(955)),
      staleChains: [10143],
    });
    expect(out).toBeCloseTo(100, 1);
  });

  it("returns 0 when EVERY row is on a stale chain (all-stale cold path)", () => {
    // If the only data is from stale chains, the denominator is 0 (no
    // fresh-chain volume) and the helper should short-circuit cleanly
    // rather than dividing by an empty population.
    const out = top10Concentration({
      rowsByVolumeDesc: [row(10143, 500), row(10143, 300)],
      totalVolumeUsdWei: BigInt(0), // mergeHeroSnapshot returns 0 when all stale
      staleChains: [10143],
    });
    expect(out).toBe(0);
  });
});
