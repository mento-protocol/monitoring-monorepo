// Pure aggregation helpers for the /stables page. Tested in aggregate.test.ts.
// No SWR, no React, no fetch — just transforms over snapshot/event arrays.

import { parseWei } from "@/lib/format";
import type { OracleRateMap } from "@/lib/tokens";
import type { RangeKey, StableSupplyDailySnapshot, TokenAgg } from "./types";

const SECONDS_PER_DAY = BigInt(86_400);
const SECONDS_PER_DAY_NUMBER = 86_400;

/**
 * Group snapshots by `{tokenAddress}|{source}` and pre-compute the per-token
 * aggregates the UI consumes: latest supply, 7d change, USD-normalized
 * snapshot. Returns a Map keyed by the discriminator so the caller can
 * iterate stably for the sparkline grid.
 *
 * `snapshots` is expected sorted ASC by timestamp; we resort defensively
 * because Hasura returns DESC and a forgotten reverse() would silently
 * pick the wrong "latest".
 */
export function rollupByToken(
  snapshots: ReadonlyArray<StableSupplyDailySnapshot>,
  rates: OracleRateMap,
  nowSeconds: bigint = BigInt(Math.floor(Date.now() / 1000)),
): Map<string, TokenAgg> {
  const sevenDayCutoff = nowSeconds - BigInt(7) * SECONDS_PER_DAY;
  const grouped = groupSnapshotsByTokenSource(snapshots);
  const out = new Map<string, TokenAgg>();
  for (const [key, rows] of grouped) {
    out.set(key, buildTokenAgg(key, rows, rates, sevenDayCutoff));
  }
  return out;
}

function groupSnapshotsByTokenSource(
  snapshots: ReadonlyArray<StableSupplyDailySnapshot>,
): Map<string, StableSupplyDailySnapshot[]> {
  const grouped = new Map<string, StableSupplyDailySnapshot[]>();
  for (const row of snapshots) {
    const key = `${row.tokenAddress}|${row.source}`;
    let arr = grouped.get(key);
    if (!arr) {
      arr = [];
      grouped.set(key, arr);
    }
    arr.push(row);
  }
  return grouped;
}

function pickBaselineSupply(
  rows: ReadonlyArray<StableSupplyDailySnapshot>,
  sevenDayCutoff: bigint,
): bigint {
  // Walk sorted-ASC rows; the last one whose timestamp is ≤ cutoff is the
  // 7d baseline. Fall back to the earliest row when everything is recent
  // (so a brand-new token's first observed snapshot stays the baseline).
  let baseline: StableSupplyDailySnapshot | undefined;
  for (const r of rows) {
    if (BigInt(r.timestamp) > sevenDayCutoff) break;
    baseline = r;
  }
  if (baseline) return BigInt(baseline.totalSupply);
  return BigInt(rows[0]?.totalSupply ?? "0");
}

function buildTokenAgg(
  key: string,
  rows: StableSupplyDailySnapshot[],
  rates: OracleRateMap,
  sevenDayCutoff: bigint,
): TokenAgg {
  rows.sort((a, b) => {
    const ta = BigInt(a.timestamp);
    const tb = BigInt(b.timestamp);
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return 0;
  });
  const latest = rows[rows.length - 1];
  const latestSupply = BigInt(latest.totalSupply);
  const baselineSupply = pickBaselineSupply(rows, sevenDayCutoff);
  const netChange7d = latestSupply - baselineSupply;
  const change7dPct =
    baselineSupply === BigInt(0)
      ? null
      : (Number(netChange7d) / Number(baselineSupply)) * 100;

  const rate = rates.get(latest.tokenSymbol);
  const usd = (raw: bigint): number | null =>
    rate == null ? null : parseWei(raw.toString(), latest.tokenDecimals) * rate;

  return {
    key,
    tokenAddress: latest.tokenAddress,
    tokenSymbol: latest.tokenSymbol,
    source: latest.source,
    tokenDecimals: latest.tokenDecimals,
    latestTotalSupply: latestSupply,
    latestTimestamp: BigInt(latest.timestamp),
    totalSupplyUsdLatest: usd(latestSupply),
    change7dPct,
    netChange7d,
    netChange7dUsd: usd(netChange7d),
  };
}

// Cutoff math (per docs/pr-checklists/stateful-data-ui.md §"Day-aligned
// cutoff math"): anchor on `dayStart(now) - (N-1)*86400` so the N-day
// rolling window keeps a fixed bucket count regardless of when the user
// loads the page. The `all` range falls back to "no filter".
export function rangeStartSeconds(
  range: RangeKey,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): number {
  if (range === "all") return 0;
  const dayStart =
    Math.floor(nowSeconds / SECONDS_PER_DAY_NUMBER) * SECONDS_PER_DAY_NUMBER;
  const daysBack = range === "7d" ? 6 : 29;
  return dayStart - daysBack * SECONDS_PER_DAY_NUMBER;
}

// Filter snapshots to the active range, then carry-forward totalSupply for
// days that have no row (sparse-day semantics). Returns one (timestamp,
// usdValue) point per UTC day in the window — feeds the stacked hero chart.
export function buildTokenUsdTimeSeries(
  snapshots: ReadonlyArray<StableSupplyDailySnapshot>,
  rates: OracleRateMap,
  range: RangeKey,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Array<{ timestamp: number; valueUsd: number }> {
  if (snapshots.length === 0) return [];
  const symbol = snapshots[0].tokenSymbol;
  const rate = rates.get(symbol);
  if (rate == null) return [];

  const startTs = rangeStartSeconds(range, nowSeconds);
  // Sort ASC; ignore rows before the window start.
  const inRange = snapshots
    .filter((r) => Number(r.timestamp) >= startTs)
    .sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  if (inRange.length === 0) return [];

  const dayStartNow =
    Math.floor(nowSeconds / SECONDS_PER_DAY_NUMBER) * SECONDS_PER_DAY_NUMBER;
  const decimals = inRange[0].tokenDecimals;
  const out: Array<{ timestamp: number; valueUsd: number }> = [];
  let cursor = 0;
  let lastSupply = BigInt(inRange[0].totalSupply);
  for (
    let d = Math.max(startTs, Number(inRange[0].timestamp));
    d <= dayStartNow;
    d += SECONDS_PER_DAY_NUMBER
  ) {
    while (cursor < inRange.length && Number(inRange[cursor].timestamp) <= d) {
      lastSupply = BigInt(inRange[cursor].totalSupply);
      cursor++;
    }
    out.push({
      timestamp: d,
      valueUsd: parseWei(lastSupply.toString(), decimals) * rate,
    });
  }
  return out;
}

// Sum per-token series into a single "total Mento stable supply" line.
// Tokens without an oracle rate contribute nothing (and the UI shows them
// with a `—` USD value in the sparkline grid). Assumes all series share
// the same timestamp axis — buildTokenUsdTimeSeries enforces this.
export function sumTotalUsdSeries(
  perTokenSeries: ReadonlyArray<
    ReadonlyArray<{ timestamp: number; valueUsd: number }>
  >,
): Array<{ timestamp: number; valueUsd: number }> {
  if (perTokenSeries.length === 0) return [];
  const byTs = new Map<number, number>();
  for (const series of perTokenSeries) {
    for (const pt of series) {
      byTs.set(pt.timestamp, (byTs.get(pt.timestamp) ?? 0) + pt.valueUsd);
    }
  }
  // Sort by timestamp ASC for the chart's x-axis.
  return Array.from(byTs.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([timestamp, valueUsd]) => ({ timestamp, valueUsd }));
}

// Largest expansion + largest contraction across all tokens in the 7d window.
// Returns null when no tokens in the rollup have a 7d change (e.g. fresh
// indexer with no data yet).
export function winnersAndLosers7d(rollup: ReadonlyMap<string, TokenAgg>): {
  biggestExpansion: TokenAgg | null;
  biggestContraction: TokenAgg | null;
} {
  let biggestExpansion: TokenAgg | null = null;
  let biggestContraction: TokenAgg | null = null;
  for (const agg of rollup.values()) {
    if (agg.netChange7dUsd == null) continue;
    if (
      agg.netChange7dUsd > 0 &&
      (biggestExpansion == null ||
        agg.netChange7dUsd > (biggestExpansion.netChange7dUsd ?? 0))
    ) {
      biggestExpansion = agg;
    }
    if (
      agg.netChange7dUsd < 0 &&
      (biggestContraction == null ||
        agg.netChange7dUsd < (biggestContraction.netChange7dUsd ?? 0))
    ) {
      biggestContraction = agg;
    }
  }
  return { biggestExpansion, biggestContraction };
}
