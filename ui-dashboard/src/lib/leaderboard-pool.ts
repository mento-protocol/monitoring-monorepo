import { SECONDS_PER_DAY } from "@/lib/time-series";
import { weiToUsd } from "@/lib/leaderboard";

export type PoolDailyVolumeRow = {
  id: string;
  chainId: number;
  poolId: string;
  timestamp: string;
  swapCount: number;
  swapCountIncludingSystem: number;
  volumeUsdWei: string;
  volumeUsdWeiIncludingSystem: string;
};

/** A series ready for `TimeSeriesChartCard` `breakdown`. `key` is the
 * pool id (or "other" for the bucketed remainder); `name` is the
 * human-readable label that ends up in the legend. */
export type PoolBreakdown = {
  key: string;
  name: string;
  color: string;
  series: Array<{ timestamp: number; value: number }>;
};

/** Stable palette for the top-N pools + "Other". Keeps the colors
 * consistent across renders and across windows so users learn which
 * color = which pool by repeated exposure. */
const POOL_PALETTE = [
  "#6366f1", // indigo
  "#22d3ee", // cyan
  "#f59e0b", // amber
  "#ec4899", // pink
  "#10b981", // emerald
  "#a855f7", // purple
  "#f97316", // orange
] as const;
const OTHER_COLOR = "#475569"; // slate-600

const TOP_N_POOLS = 7;
const OTHER_KEY = "__other__";

/**
 * Build a `BreakdownSeries[]`-shaped output from raw trader-pool-day
 * rows: top-N pools by total window-volume keep their own series, the
 * rest collapse into a single "Other" bucket. Every series has a value
 * for every day in the window (zero-fill) so Plotly's `stackgroup`
 * lays out the bars correctly even when a pool was inactive on a day.
 *
 * `poolLabel` resolves a poolId → display name like "USDC/USDm". When a
 * pool isn't in the metadata map (still indexing, removed, etc.) we
 * fall back to a truncated address.
 */
export function aggregatePoolDailyVolume(
  rows: readonly PoolDailyVolumeRow[],
  poolLabel: (poolId: string) => string,
  showSystem = false,
  /**
   * UTC-day window the chart covers, as `[cutoffSec, todayMidnightSec]`.
   * When provided, the output series is zero-filled across every UTC
   * day in the window, not just days that had rows. Without this, a
   * day with protocol-wide zero volume disappears from the x-axis and
   * the stacked chart bridges straight from `N` to `N+2` as if
   * activity were continuous.
   */
  windowRange?: { fromSec: number; toSec: number },
): {
  totalSeries: Array<{ timestamp: number; value: number }>;
  breakdown: PoolBreakdown[];
  poolCount: number;
  /** All pools, ranked by total window volume desc. Drives the Top
   * Pools list rendered alongside the chart. The first N entries
   * here line up 1:1 with `breakdown[0..N-1]` (same order, same
   * poolId), so list rows can borrow the chart's color for visual
   * continuity. Entries beyond N are pools that landed in the
   * "Other" bucket on the chart side. */
  poolRanking: Array<{
    poolId: string;
    totalUsdWei: bigint;
    totalUsd: number;
  }>;
  /** Sum of `totalUsdWei` across all pools — denominator for the
   * "share of window volume" % column in the list. */
  windowTotalUsdWei: bigint;
} {
  // Step 1: bucket by (poolId, day) and sum. Track per-day totals
  // alongside so the headline series is O(1)-per-day instead of
  // scanning every entry with `endsWith` (claude/cursor finding).
  const byPoolDay = new Map<string, bigint>();
  const totalsByPool = new Map<string, bigint>();
  const totalsByDay = new Map<number, bigint>();
  const days = new Set<number>();
  let admittedRowCount = 0;
  for (const r of rows) {
    const day = Number(r.timestamp);
    days.add(day);
    const wei = BigInt(
      showSystem ? r.volumeUsdWeiIncludingSystem : r.volumeUsdWei,
    );
    if (wei === BigInt(0)) continue;
    const k = `${r.poolId}|${day}`;
    byPoolDay.set(k, (byPoolDay.get(k) ?? BigInt(0)) + wei);
    totalsByPool.set(r.poolId, (totalsByPool.get(r.poolId) ?? BigInt(0)) + wei);
    totalsByDay.set(day, (totalsByDay.get(day) ?? BigInt(0)) + wei);
    admittedRowCount += 1;
  }

  // Empty-state short-circuit: when no rows survived filtering, return
  // empty series + breakdown so the chart card's `series.length === 0`
  // empty-state check still triggers. Otherwise the windowRange
  // zero-fill below would synthesize one zero-valued point per UTC day,
  // making `series.length` equal the window size and silently hiding
  // the "No pool volume" message (codex finding 3189490296).
  if (admittedRowCount === 0) {
    return {
      totalSeries: [],
      breakdown: [],
      poolCount: 0,
      poolRanking: [],
      windowTotalUsdWei: BigInt(0),
    };
  }

  // sortedDays — when the caller passed a windowRange, walk every UTC
  // day in [from, to] so the x-axis is contiguous even when a day had
  // zero volume protocol-wide. Otherwise fall back to the days that
  // appeared in `rows` (legacy callers / tests).
  const sortedDays: number[] = [];
  if (windowRange !== undefined) {
    for (
      let day = windowRange.fromSec;
      day <= windowRange.toSec;
      day += SECONDS_PER_DAY
    ) {
      sortedDays.push(day);
    }
  } else {
    sortedDays.push(...Array.from(days).sort((a, b) => a - b));
  }

  // Step 2: rank pools by total window volume; top-N stay distinct,
  // rest go into the "Other" bucket. Stable secondary order on `poolId`
  // so equal-volume pools don't shuffle legend colors / top-N boundary
  // across SWR polls (cursor finding 3184647407).
  const rankedPools = Array.from(totalsByPool.entries()).sort(
    ([poolA, a], [poolB, b]) => {
      if (b > a) return 1;
      if (b < a) return -1;
      return poolA.localeCompare(poolB);
    },
  );
  const topPools = rankedPools.slice(0, TOP_N_POOLS).map(([id]) => id);
  const otherPools = new Set(rankedPools.slice(TOP_N_POOLS).map(([id]) => id));

  // Step 3: emit one BreakdownSeries per top pool + one "Other" if needed.
  const breakdown: PoolBreakdown[] = topPools.map((poolId, idx) => ({
    key: poolId,
    name: poolLabel(poolId),
    color: POOL_PALETTE[idx % POOL_PALETTE.length]!,
    series: sortedDays.map((day) => ({
      timestamp: day,
      value: weiToUsd(byPoolDay.get(`${poolId}|${day}`) ?? BigInt(0)),
    })),
  }));
  if (otherPools.size > 0) {
    breakdown.push({
      key: OTHER_KEY,
      name: `Other (${otherPools.size})`,
      color: OTHER_COLOR,
      series: sortedDays.map((day) => {
        let acc = BigInt(0);
        for (const poolId of otherPools) {
          acc += byPoolDay.get(`${poolId}|${day}`) ?? BigInt(0);
        }
        return { timestamp: day, value: weiToUsd(acc) };
      }),
    });
  }

  // Step 4: total-per-day series for the headline number. O(1) per day
  // via the `totalsByDay` map populated in step 1.
  const totalSeries = sortedDays.map((day) => ({
    timestamp: day,
    value: weiToUsd(totalsByDay.get(day) ?? BigInt(0)),
  }));

  // Step 5: full ranked list of pools by total window volume. Drives
  // the Top Pools sidebar list. Order matches `rankedPools` (so list
  // entries 0..TOP_N-1 line up with `breakdown[0..TOP_N-1]`).
  const poolRanking = rankedPools.map(([poolId, totalUsdWei]) => ({
    poolId,
    totalUsdWei,
    totalUsd: weiToUsd(totalUsdWei),
  }));
  let windowTotalUsdWei = BigInt(0);
  for (const v of totalsByPool.values()) windowTotalUsdWei += v;

  return {
    totalSeries,
    breakdown,
    poolCount: totalsByPool.size,
    poolRanking,
    windowTotalUsdWei,
  };
}
