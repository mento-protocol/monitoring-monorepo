/**
 * Client-side aggregation + flow logic for the /leaderboard page.
 *
 * Data source: pre-rolled `TraderDailySnapshot` / `TraderPoolDailySnapshot`
 * entities from `indexer-envio/schema.graphql`. Hasura row cap = 1000;
 * window aggregation is deliberately lossy (top-1000 by single-day volume
 * within the window, then summed per trader) — see queries/leaderboard.ts
 * for why this still produces a correct top-50 in practice.
 *
 * USD-wei: 18-decimal BigInt fixed-point, mirrored from the indexer's
 * `volumeUsdWei` / `feesPaidUsdWei` columns. Convert to a number ONLY at
 * the display boundary (`weiToUsd`).
 */

import { SECONDS_PER_DAY } from "@/lib/time-series";

/** USD-wei: 18-decimal fixed-point (`indexer-envio/src/usd.ts:USD_WEI_DECIMALS`). */
export const USD_WEI_DECIMALS = 18;

/** Window selection for the leaderboard view. 1W is too short for the
 * per-pool stacked chart to read clearly, and 24h collapses to a single
 * datapoint, so the operator-facing pills are 1M / 3M / All. */
export type LeaderboardRangeKey = "30d" | "90d" | "all";

export const LEADERBOARD_RANGES: ReadonlyArray<{
  key: LeaderboardRangeKey;
  label: string;
}> = [
  { key: "30d", label: "1M" },
  { key: "90d", label: "3M" },
  { key: "all", label: "All" },
];

/** Days in the window. `null` = no cutoff. */
export function rangeDays(range: LeaderboardRangeKey): number | null {
  if (range === "30d") return 30;
  if (range === "90d") return 90;
  return null;
}

/**
 * Cutoff timestamp (seconds) for the `_gte` filter. For "all" we pass 0
 * rather than skipping the filter so the query shape stays uniform.
 *
 * The cutoff aligns to UTC-day boundaries because the snapshot entities
 * bucket on `floor(timestamp / 86400) * 86400`. A naive `now - days * 86400`
 * cutoff drops the previous day's bucket whenever it lands mid-bucket —
 * mid-UTC-day the "24h" window would actually mean "since today's UTC
 * midnight" (≤ 24h of data, sometimes only a few hours). Aligning to the
 * UTC boundary makes the window deterministic against bucket size.
 */
export function rangeCutoffSeconds(range: LeaderboardRangeKey): number {
  const days = rangeDays(range);
  if (days === null) return 0;
  const todayMidnightUtc =
    Math.floor(Date.now() / 1000 / SECONDS_PER_DAY) * SECONDS_PER_DAY;
  return todayMidnightUtc - (days - 1) * SECONDS_PER_DAY;
}

// ─── Wire types — mirror the GraphQL response shape ────────────────────────

export type TraderDailyRow = {
  id: string;
  chainId: number;
  trader: string;
  timestamp: string;
  swapCount: number;
  uniquePools: number;
  volumeUsdWei: string;
  feesPaidUsdWei: string;
  isSystemAddress: boolean;
  lastSeenTimestamp: string;
};

export type TraderPoolDailyRow = {
  id: string;
  chainId: number;
  trader: string;
  poolId: string;
  timestamp: string;
  swapCount: number;
  volumeUsdWei: string;
  inflowToken0UsdWei: string;
  outflowToken0UsdWei: string;
  inflowToken1UsdWei: string;
  outflowToken1UsdWei: string;
  feesPaidUsdWei: string;
};

// ─── Aggregated row types — what the table renders ────────────────────────

/** Aggregated trader-window row. `uniquePoolsApprox` is union-of-day-counts
 * — Hasura can't `count(distinct pool)` for us, and we don't have a
 * trader-window snapshot entity yet, so we use the *max* daily uniquePools
 * as a lower-bound proxy. (PR 4+: pre-roll a TraderWindowSnapshot if the
 * lower-bound is misleading in practice.) */
export type TraderWindowRow = {
  chainId: number;
  trader: string;
  swapCount: number;
  uniquePoolsApprox: number;
  volumeUsdWei: bigint;
  feesPaidUsdWei: bigint;
  isSystemAddress: boolean;
  lastSeenTimestamp: number;
};

/** Aggregated trader-pool-window row (post-summing the per-day rows). */
export type TraderPoolWindowRow = {
  chainId: number;
  trader: string;
  poolId: string;
  swapCount: number;
  volumeUsdWei: bigint;
  inflowToken0UsdWei: bigint;
  outflowToken0UsdWei: bigint;
  inflowToken1UsdWei: bigint;
  outflowToken1UsdWei: bigint;
  feesPaidUsdWei: bigint;
};

// ─── Aggregations ─────────────────────────────────────────────────────────

/**
 * Group `TraderDailyRow`s by `(chainId, trader)` and sum.
 *
 * Same EOA on different chains stays separate because trading on Celo and
 * Monad is genuinely independent — different counterparties, different
 * pools. Merging across chains would imply a "global trader identity" we
 * have no way to verify.
 */
export function aggregateTradersByWindow(
  rows: readonly TraderDailyRow[],
): TraderWindowRow[] {
  const byKey = new Map<string, TraderWindowRow>();
  for (const r of rows) {
    const key = `${r.chainId}-${r.trader}`;
    const existing = byKey.get(key);
    const lastSeen = Number(r.lastSeenTimestamp);
    if (existing) {
      existing.swapCount += r.swapCount;
      existing.uniquePoolsApprox = Math.max(
        existing.uniquePoolsApprox,
        r.uniquePools,
      );
      existing.volumeUsdWei += BigInt(r.volumeUsdWei);
      existing.feesPaidUsdWei += BigInt(r.feesPaidUsdWei);
      existing.isSystemAddress = existing.isSystemAddress || r.isSystemAddress;
      if (lastSeen > existing.lastSeenTimestamp) {
        existing.lastSeenTimestamp = lastSeen;
      }
    } else {
      byKey.set(key, {
        chainId: r.chainId,
        trader: r.trader,
        swapCount: r.swapCount,
        uniquePoolsApprox: r.uniquePools,
        volumeUsdWei: BigInt(r.volumeUsdWei),
        feesPaidUsdWei: BigInt(r.feesPaidUsdWei),
        isSystemAddress: r.isSystemAddress,
        lastSeenTimestamp: lastSeen,
      });
    }
  }
  // Stable secondary order: `(chainId, trader)` lexicographic. Ties on
  // volume otherwise reorder across polls (SWR returns rows in insertion
  // order from a fresh fetch), causing the flow badge to flicker between
  // tied traders' primary pools and the rank column to shift.
  return Array.from(byKey.values()).sort((a, b) => {
    if (b.volumeUsdWei > a.volumeUsdWei) return 1;
    if (b.volumeUsdWei < a.volumeUsdWei) return -1;
    if (a.chainId !== b.chainId) return a.chainId - b.chainId;
    return a.trader.localeCompare(b.trader);
  });
}

/**
 * Group `TraderPoolDailyRow`s by `(chainId, trader, poolId)` and sum the
 * inflow/outflow split. Used by the per-row expand and the flow badge.
 */
export function aggregateTraderPoolsByWindow(
  rows: readonly TraderPoolDailyRow[],
): TraderPoolWindowRow[] {
  const byKey = new Map<string, TraderPoolWindowRow>();
  for (const r of rows) {
    const key = `${r.chainId}-${r.trader}-${r.poolId}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.swapCount += r.swapCount;
      existing.volumeUsdWei += BigInt(r.volumeUsdWei);
      existing.inflowToken0UsdWei += BigInt(r.inflowToken0UsdWei);
      existing.outflowToken0UsdWei += BigInt(r.outflowToken0UsdWei);
      existing.inflowToken1UsdWei += BigInt(r.inflowToken1UsdWei);
      existing.outflowToken1UsdWei += BigInt(r.outflowToken1UsdWei);
      existing.feesPaidUsdWei += BigInt(r.feesPaidUsdWei);
    } else {
      byKey.set(key, {
        chainId: r.chainId,
        trader: r.trader,
        poolId: r.poolId,
        swapCount: r.swapCount,
        volumeUsdWei: BigInt(r.volumeUsdWei),
        inflowToken0UsdWei: BigInt(r.inflowToken0UsdWei),
        outflowToken0UsdWei: BigInt(r.outflowToken0UsdWei),
        inflowToken1UsdWei: BigInt(r.inflowToken1UsdWei),
        outflowToken1UsdWei: BigInt(r.outflowToken1UsdWei),
        feesPaidUsdWei: BigInt(r.feesPaidUsdWei),
      });
    }
  }
  // Stable secondary order on poolId: ties on volume would otherwise
  // reorder `breakdownRows[0]` (the trader's "primary pool") across polls,
  // making the flow badge flicker.
  return Array.from(byKey.values()).sort((a, b) => {
    if (b.volumeUsdWei > a.volumeUsdWei) return 1;
    if (b.volumeUsdWei < a.volumeUsdWei) return -1;
    return a.poolId.localeCompare(b.poolId);
  });
}

// ─── Display conversions ──────────────────────────────────────────────────

/** USD-wei BigInt → number. Loses precision past ~$9 quadrillion (Number's
 * 2^53 cap). Acceptable for display; never use for further accumulation. */
export function weiToUsd(wei: bigint): number {
  // Convert via decimal-shift through string to keep precision under Number's
  // 2^53 ceiling (`Number(wei)` rounds large BigInts).
  const s = wei.toString();
  if (s === "0") return 0;
  const negative = s.startsWith("-");
  const digits = negative ? s.slice(1) : s;
  if (digits.length <= USD_WEI_DECIMALS) {
    const padded = digits.padStart(USD_WEI_DECIMALS + 1, "0");
    const whole = padded.slice(0, -USD_WEI_DECIMALS);
    const frac = padded.slice(-USD_WEI_DECIMALS).slice(0, 6);
    const n = Number(`${whole}.${frac}`);
    return negative ? -n : n;
  }
  const whole = digits.slice(0, -USD_WEI_DECIMALS);
  const frac = digits.slice(-USD_WEI_DECIMALS).slice(0, 6);
  const n = Number(`${whole}.${frac}`);
  return negative ? -n : n;
}

// ─── Flow imbalance (drives the FlowBadge) ────────────────────────────────

export type FlowKind = "one-directional" | "delta-neutral" | "mixed";

export type FlowResult = {
  kind: FlowKind;
  /** Imbalance score in [0, 1]. 0 = perfectly round-tripped; 1 = pure
   * one-direction. */
  imbalance: number;
  /** 0 = trader net-accumulated token0; 1 = net-accumulated token1; null
   * when imbalance is too small to assign a direction (delta-neutral) or
   * when both legs net to zero. */
  direction: 0 | 1 | null;
};

/**
 * Score a trader's flow in their primary pool by the absolute net-flow
 * imbalance. Threshold rationale (BACKLOG.md PR 3 spec):
 *   imbalance > 0.7  → one-directional (extractive arb / corridor flow)
 *   imbalance < 0.2  → delta-neutral (round-tripper, MM-like)
 *   else             → mixed
 *
 * "Net flow" per token = inflow − outflow. The total denominator is the
 * sum of absolute gross flows across both tokens — using the gross sum
 * keeps the metric in [0, 1] regardless of pool depth or USD scale.
 */
export function computeFlow(pool: TraderPoolWindowRow): FlowResult {
  const net0 = pool.inflowToken0UsdWei - pool.outflowToken0UsdWei;
  const net1 = pool.inflowToken1UsdWei - pool.outflowToken1UsdWei;
  const gross =
    pool.inflowToken0UsdWei +
    pool.outflowToken0UsdWei +
    pool.inflowToken1UsdWei +
    pool.outflowToken1UsdWei;
  const ZERO = BigInt(0);
  if (gross === ZERO) {
    return { kind: "mixed", imbalance: 0, direction: null };
  }
  const abs0 = net0 < ZERO ? -net0 : net0;
  const abs1 = net1 < ZERO ? -net1 : net1;
  const absNet = abs0 + abs1;
  // BigInt division would truncate to 0 — multiply through to keep two
  // decimals of precision.
  const imbalance = Number((absNet * BigInt(10000)) / gross) / 10000;
  // Direction = the leg the trader net-accumulated (net > 0). For a real
  // swap net0 and net1 have opposite signs (one in, one out), so the
  // positive-net leg is unambiguous. Picking by `|net|` magnitude alone
  // mislabels the symmetric tie case (`outflow0=100, inflow1=100` →
  // |net0|==|net1|==100 but the trader accumulated token1).
  const direction: 0 | 1 | null =
    imbalance < 0.05 ? null : net0 > ZERO ? 0 : net1 > ZERO ? 1 : null;
  const kind: FlowKind =
    imbalance >= 0.7
      ? "one-directional"
      : imbalance <= 0.2
        ? "delta-neutral"
        : "mixed";
  return { kind, imbalance, direction };
}

// ─── Per-pool stacked chart aggregation ───────────────────────────────────

export type PoolDailyVolumeRow = {
  id: string;
  chainId: number;
  trader: string;
  poolId: string;
  timestamp: string;
  volumeUsdWei: string;
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
  /**
   * Optional set of `${chainId}-${trader}-${day}` keys that are allowed
   * to contribute. When provided, rows whose `(chainId, trader, day)`
   * is NOT in the set are dropped. Used to keep the chart consistent
   * with the trader-keyed headline when the system-address toggle is
   * off: `TraderPoolDailySnapshot` doesn't carry an `isSystemAddress`
   * column, so Hasura can't filter at query time. Day-scoped because
   * `TraderDailySnapshot.isSystemAddress` is itself day-scoped — a
   * trader can flip system-flag mid-window if the indexer's classifier
   * config changes.
   */
  traderAllowList?: ReadonlySet<string>,
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
    if (
      traderAllowList !== undefined &&
      !traderAllowList.has(`${r.chainId}-${r.trader}-${r.timestamp}`)
    ) {
      continue;
    }
    const day = Number(r.timestamp);
    days.add(day);
    const wei = BigInt(r.volumeUsdWei);
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
    return { totalSeries: [], breakdown: [], poolCount: 0 };
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

  return { totalSeries, breakdown, poolCount: totalsByPool.size };
}
