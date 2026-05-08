import { describe, it, expect, afterEach, vi } from "vitest";
import {
  aggregateBrokerAggregatorsByWindow,
  aggregateBrokerTradersByWindow,
  aggregateDailyVolume,
  aggregatePoolDailyVolume,
  aggregateTraderPoolsByWindow,
  aggregateTradersByWindow,
  computeFlow,
  mergeHeroSnapshot,
  rangeCutoffSeconds,
  weiToUsd,
  type BrokerAggregatorDailyRow,
  type BrokerTraderDailyRow,
  type LeaderboardTodayTraderRow,
  type LeaderboardWindowRow,
  type TraderDailyRow,
  type TraderPoolDailyRow,
  type TraderPoolWindowRow,
} from "../leaderboard";

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
    trader = "0x0",
  ) {
    return {
      id: `${chainId}-${trader}-${poolId}-${timestamp}`,
      chainId,
      trader,
      poolId,
      timestamp,
      volumeUsdWei: usd(volumeUsd),
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

  it("filters by traderAllowList when provided (system-toggle parity)", () => {
    // Two traders contributing to the same pool, but only `0xUser` is in
    // the allowlist — system trader's volume must NOT contribute to
    // the chart.
    const rows = [
      row(42220, "0xA", day(1), 100, "0xUser"),
      row(42220, "0xA", day(1), 50, "0xSystem"),
    ];
    // Day-scoped allowlist: `${chainId}-${trader}-${day}`.
    const allowList = new Set([`42220-0xUser-${day(1)}`]);
    const r = aggregatePoolDailyVolume(rows, noLabel, allowList);
    expect(r.totalSeries[0]!.value).toBeCloseTo(100, 4);
    // Without the allowlist, the same input includes both traders.
    const rUnfiltered = aggregatePoolDailyVolume(rows, noLabel);
    expect(rUnfiltered.totalSeries[0]!.value).toBeCloseTo(150, 4);
  });

  it("allowlist is day-scoped — same trader can have system + non-system days", () => {
    // Trader 0xFlip flipped from system to non-system between day 1 and
    // day 2. System volume must NOT leak from day 1 even though the
    // trader is admitted on day 2.
    const rows = [
      row(42220, "0xA", day(1), 100, "0xFlip"), // system day → excluded
      row(42220, "0xA", day(2), 80, "0xFlip"), // non-system day → admitted
    ];
    const allowList = new Set([`42220-0xFlip-${day(2)}`]);
    const r = aggregatePoolDailyVolume(rows, noLabel, allowList);
    // Only day 2's 80 contributes; day 1's 100 is dropped.
    const day2 = r.totalSeries.find((p) => p.timestamp === Number(day(2)))!;
    expect(day2.value).toBeCloseTo(80, 4);
    const day1 = r.totalSeries.find((p) => p.timestamp === Number(day(1)));
    if (day1) expect(day1.value).toBe(0);
  });

  it("zero-fills every day in windowRange even when no row touched it", () => {
    // Only day 2 has any activity; days 1 and 3 must still appear in the
    // series with value=0 so the stacked area's x-axis stays contiguous.
    const SECONDS_PER_DAY = 86_400;
    const rows = [row(42220, "0xA", day(2), 100, "0xUser")];
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

  it("returns empty series when allowlist excludes every row", () => {
    // Same short-circuit when an allowlist filters everything out.
    const rows = [row(42220, "0xA", day(1), 100, "0xUser")];
    const allowList = new Set<string>(); // empty allowlist
    const r = aggregatePoolDailyVolume(rows, noLabel, allowList, {
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
  const TWO_DAYS_AGO_MIDNIGHT = TODAY_MIDNIGHT - 2 * SECONDS_PER_DAY;

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

  it("returns zeros (and empty staleChains) when both inputs are empty/undefined", () => {
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

  it("excludes a stale snapshot (snapshotDay = today - 2 days) and reports the chainId", () => {
    const out = mergeHeroSnapshot({
      snapshotRows: [
        snap({
          chainId: 10143, // Monad — silent for ≥1 UTC day
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
          snapshotDay: String(TWO_DAYS_AGO_MIDNIGHT),
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

  it("today's partial still contributes when the chain's snapshot is stale", () => {
    // A chain might have a stale snapshot AND today's swap — the stale
    // snapshot drops out of totals, but today's volume still counts.
    // (The chain's day-N-1 volume is the lost data; day-N is fine.)
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
    // Snapshot's $500 is dropped; today's $50 remains.
    expect(out.totalVolumeUsdWei).toBe(BigInt(USD(50)));
    expect(out.totalSwapCount).toBe(2);
    expect(out.uniqueTraders).toBe(1);
    expect(out.staleChains).toEqual([10143]);
  });
});
