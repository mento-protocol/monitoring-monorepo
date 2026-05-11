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
import { weiToUsd as formatWeiToUsd } from "@/lib/format";
import {
  aggregateAggregatorsByWindow,
  type AggregatorDailyRow,
  type AggregatorWindowRow,
} from "@/lib/leaderboard-aggregators";

export { formatWeiToUsd as weiToUsd };

/** Window selection for the leaderboard view. The full range set covers
 * both v3 and v2 venues; the per-pool chart is hidden for `<30d` windows
 * where there are too few datapoints to read a stacked breakdown
 * meaningfully (see `page-client.tsx`). */
export type LeaderboardRangeKey = "24h" | "7d" | "30d" | "90d" | "all";

export const LEADERBOARD_RANGES: ReadonlyArray<{
  key: LeaderboardRangeKey;
  label: string;
}> = [
  { key: "24h", label: "24h" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "1M" },
  { key: "90d", label: "3M" },
  { key: "all", label: "All" },
];

/** Days in the window. `null` = no cutoff. */
export function rangeDays(range: LeaderboardRangeKey): number | null {
  if (range === "24h") return 1;
  if (range === "7d") return 7;
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
 * as a lower-bound proxy. Pre-roll a TraderWindowSnapshot if the lower-bound
 * is misleading in practice. */
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

// ─── V2 (legacy-Broker) wire + window types ───────────────────────────────
// Mirror of TraderDailyRow / TraderWindowRow but skinnier: BrokerSwapEvent
// doesn't carry fee bps or pool metadata, so the v2 entity drops fees and
// per-pool-uniques. See indexer-envio/schema.graphql BrokerTraderDailySnapshot.
//
// Note: the underlying entity field is `caller` (tx.from / signer EOA), but
// the GraphQL queries alias it to `trader` so v2 and v3 row shapes stay
// uniform — `aggregateBrokerTradersByWindow` / `aggregateDailyVolume` /
// `mergeHeroSnapshot` can read `row.trader` regardless of venue.

export type BrokerTraderDailyRow = {
  id: string;
  chainId: number;
  /** Aliased from `caller` in the GraphQL query — semantically the signer
   *  EOA (tx.from). Keeping the field name `trader` here so this row shape
   *  stays interchangeable with `TraderDailyRow` for `aggregateDailyVolume`. */
  trader: string;
  timestamp: string;
  swapCount: number;
  volumeUsdWei: string;
  isSystemAddress: boolean;
  lastSeenTimestamp: string;
};

export type BrokerTraderWindowRow = {
  chainId: number;
  /** Signer EOA (tx.from) — see `BrokerTraderDailyRow.trader`. */
  trader: string;
  swapCount: number;
  volumeUsdWei: bigint;
  isSystemAddress: boolean;
  lastSeenTimestamp: number;
};

export type BrokerAggregatorDailyRow = AggregatorDailyRow;
export type BrokerAggregatorWindowRow = AggregatorWindowRow;

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

/**
 * v2 sibling of `aggregateTradersByWindow`. Skinnier shape (no fees,
 * no uniquePools) since BrokerTraderDailySnapshot doesn't carry them.
 */
export function aggregateBrokerTradersByWindow(
  rows: readonly BrokerTraderDailyRow[],
): BrokerTraderWindowRow[] {
  const byKey = new Map<string, BrokerTraderWindowRow>();
  for (const r of rows) {
    const key = `${r.chainId}-${r.trader}`;
    const lastSeen = Number(r.lastSeenTimestamp);
    const existing = byKey.get(key);
    if (existing) {
      existing.swapCount += r.swapCount;
      existing.volumeUsdWei += BigInt(r.volumeUsdWei);
      existing.isSystemAddress = existing.isSystemAddress || r.isSystemAddress;
      if (lastSeen > existing.lastSeenTimestamp) {
        existing.lastSeenTimestamp = lastSeen;
      }
    } else {
      byKey.set(key, {
        chainId: r.chainId,
        trader: r.trader,
        swapCount: r.swapCount,
        volumeUsdWei: BigInt(r.volumeUsdWei),
        isSystemAddress: r.isSystemAddress,
        lastSeenTimestamp: lastSeen,
      });
    }
  }
  return Array.from(byKey.values()).sort((a, b) => {
    if (b.volumeUsdWei > a.volumeUsdWei) return 1;
    if (b.volumeUsdWei < a.volumeUsdWei) return -1;
    if (a.chainId !== b.chainId) return a.chainId - b.chainId;
    return a.trader.localeCompare(b.trader);
  });
}

export const aggregateBrokerAggregatorsByWindow = aggregateAggregatorsByWindow;

/**
 * Day-keyed totals across all traders in the window. Drives the volume
 * hero chart's daily series. Day key = floor(timestamp / 86400) * 86400
 * which already matches the indexer's UTC-midnight bucket. Accepts both
 * v3 (`TraderDailyRow`) and v2 (`BrokerTraderDailyRow`) shapes — only
 * `timestamp` and `volumeUsdWei` are read.
 */
export function aggregateDailyVolume(
  rows: readonly { timestamp: string; volumeUsdWei: string }[],
): Array<{ timestamp: number; value: number }> {
  const byDay = new Map<number, bigint>();
  for (const r of rows) {
    const day = Number(r.timestamp);
    byDay.set(day, (byDay.get(day) ?? BigInt(0)) + BigInt(r.volumeUsdWei));
  }
  return Array.from(byDay.entries())
    .sort(([a], [b]) => a - b)
    .map(([timestamp, wei]) => ({ timestamp, value: formatWeiToUsd(wei) }));
}

/** Three-way comparator for BigInts. Used by table sort handlers that need
 * an ascending base ordering and apply their own `sign` to flip direction. */
export function cmpBigInt(a: bigint, b: bigint): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// ─── Flow imbalance (drives the FlowBadge) ────────────────────────────────

type FlowKind = "one-directional" | "delta-neutral" | "mixed";

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
 * imbalance. Threshold rationale from the leaderboard MVP:
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
// Moved to `lib/leaderboard-pool.ts` to keep this file under the AGENTS.md
// 600-line soft cap. Re-exported below so existing imports keep working.
export { aggregatePoolDailyVolume } from "@/lib/leaderboard-pool";

// Hero KPI rollup (mergeHeroSnapshot, top10Concentration, related types)
// is in `lib/leaderboard-hero.ts` to keep this file under the 600-line
// soft cap. Re-exported below so existing imports keep working.
export {
  mergeHeroSnapshot,
  top10Concentration,
  type LeaderboardTodayTraderRow,
  type LeaderboardWindowFirstDayRow,
  type LeaderboardWindowRow,
} from "@/lib/leaderboard-hero";
