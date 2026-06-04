// Pure aggregation helpers for the /stables page. Tested in aggregate.test.ts.
// No SWR, no React, no fetch — just transforms over snapshot/event arrays.

import { parseWei } from "@/lib/format";
import { effectiveOracleRate } from "@/lib/stables";
import type { OracleRateMap } from "@/lib/tokens";
import type {
  RangeKey,
  StableSupplyDailySnapshot,
  StableTokenCustodyDailySnapshot,
  TokenAgg,
} from "./types";

const SECONDS_PER_DAY = BigInt(86_400);
const SECONDS_PER_DAY_NUMBER = 86_400;

/**
 * Group snapshots by `{chainId}|{tokenAddress}|{source}` and pre-compute the per-token
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
  custodySnapshots: ReadonlyArray<StableTokenCustodyDailySnapshot> = [],
): Map<string, TokenAgg> {
  // 7d baseline cutoff: floor `nowSeconds` to its UTC day first, then
  // step back 7 days. Without the floor, mid-day calls land at
  // `dayStart - (now - dayStart) - 7d` which picks the row 8 day-buckets
  // before today (snapshots are day-bucketed) — the 7d KPI tile silently
  // reports an 8-day delta during most of the day. Aligns with the
  // chart's `rangeStartSeconds` math.
  const dayStartNow = (nowSeconds / SECONDS_PER_DAY) * SECONDS_PER_DAY;
  const sevenDayCutoff = dayStartNow - BigInt(7) * SECONDS_PER_DAY;
  const grouped = groupSnapshotsByTokenSource(snapshots);
  const custodyByToken = groupCustodySnapshotsByToken(custodySnapshots);
  const out = new Map<string, TokenAgg>();
  for (const [key, rows] of grouped) {
    const sample = rows[0]!;
    const custodyRows =
      custodyByToken.get(custodyKey(sample.chainId, sample.tokenAddress)) ?? [];
    out.set(key, buildTokenAgg(key, rows, rates, sevenDayCutoff, custodyRows));
  }
  return out;
}

/**
 * Union the paginated daily-snapshot stream with the `latestPerToken`
 * one-row-per-token feed. Tokens whose only known snapshot is older
 * than the retained 1000-row page would otherwise drop out of the
 * stacked total + sparkline grid; this floor keeps them present.
 *
 * De-dupes on `(chainId, tokenAddress, source, timestamp)` with latest-row
 * precedence. Current-state rows must overwrite the sparse daily row for the
 * same token/day so current totals do not lag until the next rollover event.
 * Both `StablesHeroChart` and `StablesSparklineGrid` call this — single source
 * so they can't drift on collision precedence.
 */
export function unionSnapshotsWithLatest(
  snapshots: ReadonlyArray<StableSupplyDailySnapshot>,
  latestPerToken: ReadonlyArray<StableSupplyDailySnapshot>,
): StableSupplyDailySnapshot[] {
  const bySnapshot = new Map<string, StableSupplyDailySnapshot>();
  for (const r of snapshots) bySnapshot.set(supplySnapshotKey(r), r);
  for (const r of latestPerToken) bySnapshot.set(supplySnapshotKey(r), r);
  return Array.from(bySnapshot.values());
}

export function unionCustodySnapshotsWithLatest(
  snapshots: ReadonlyArray<StableTokenCustodyDailySnapshot>,
  latestPerToken: ReadonlyArray<StableTokenCustodyDailySnapshot>,
): StableTokenCustodyDailySnapshot[] {
  const bySnapshot = new Map<string, StableTokenCustodyDailySnapshot>();
  for (const r of snapshots) bySnapshot.set(custodySnapshotKey(r), r);
  for (const r of latestPerToken) bySnapshot.set(custodySnapshotKey(r), r);
  return Array.from(bySnapshot.values());
}

/**
 * Group snapshots by `{chainId}|{tokenAddress}|{source}`. Exported so the
 * hero chart can reuse the same discriminator key — chain-local supplies on
 * Celo and Monad must stay separate before the USD stack sums them.
 */
export function groupSnapshotsByTokenSource(
  snapshots: ReadonlyArray<StableSupplyDailySnapshot>,
): Map<string, StableSupplyDailySnapshot[]> {
  const grouped = new Map<string, StableSupplyDailySnapshot[]>();
  for (const row of snapshots) {
    const key = tokenSourceKey(row);
    let arr = grouped.get(key);
    if (!arr) {
      arr = [];
      grouped.set(key, arr);
    }
    arr.push(row);
  }
  return grouped;
}

export function groupCustodySnapshotsByToken(
  snapshots: ReadonlyArray<StableTokenCustodyDailySnapshot>,
): Map<string, StableTokenCustodyDailySnapshot[]> {
  const grouped = new Map<string, StableTokenCustodyDailySnapshot[]>();
  for (const row of snapshots) {
    const key = custodyKey(row.chainId, row.tokenAddress);
    let arr = grouped.get(key);
    if (!arr) {
      arr = [];
      grouped.set(key, arr);
    }
    arr.push(row);
  }
  for (const arr of grouped.values()) {
    arr.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  }
  return grouped;
}

function tokenSourceKey(row: StableSupplyDailySnapshot): string {
  return `${row.chainId}|${row.tokenAddress.toLowerCase()}|${row.source}`;
}

function custodyKey(chainId: number, tokenAddress: string): string {
  return `${chainId}|${tokenAddress.toLowerCase()}`;
}

function supplySnapshotKey(row: StableSupplyDailySnapshot): string {
  return `${tokenSourceKey(row)}|${row.timestamp}`;
}

function custodySnapshotKey(row: StableTokenCustodyDailySnapshot): string {
  return `${custodyKey(row.chainId, row.tokenAddress)}|${row.source}|${
    row.timestamp
  }`;
}

function lockedSupplyAt(
  custodyRows: ReadonlyArray<StableTokenCustodyDailySnapshot>,
  timestamp: bigint,
): bigint {
  let locked = BigInt(0);
  for (const row of sortCustodyRowsAsc(custodyRows)) {
    if (BigInt(row.timestamp) > timestamp) break;
    locked = BigInt(row.lockedSupply);
  }
  return locked;
}

function latestLockedSupplyForDailyRows(
  custodyRows: ReadonlyArray<StableTokenCustodyDailySnapshot>,
): { lockedSupply: bigint; timestamp: bigint | null } {
  const sorted = sortCustodyRowsAsc(custodyRows);
  const latest = sorted[sorted.length - 1];
  return latest
    ? {
        lockedSupply: BigInt(latest.lockedSupply),
        timestamp: BigInt(latest.timestamp),
      }
    : { lockedSupply: BigInt(0), timestamp: null };
}

function sortCustodyRowsAsc(
  custodyRows: ReadonlyArray<StableTokenCustodyDailySnapshot>,
): StableTokenCustodyDailySnapshot[] {
  return [...custodyRows].sort(
    (a, b) => Number(a.timestamp) - Number(b.timestamp),
  );
}

export function circulatingSupplyForSnapshot(
  row: StableSupplyDailySnapshot,
  custodyRows: ReadonlyArray<StableTokenCustodyDailySnapshot> = [],
): bigint {
  const rawSupply = BigInt(row.totalSupply);
  const locked = lockedSupplyAt(custodyRows, BigInt(row.timestamp));
  return rawSupply >= locked ? rawSupply - locked : BigInt(0);
}

export function latestDailyCirculatingSupply(
  row: StableSupplyDailySnapshot,
  custodyRows: ReadonlyArray<StableTokenCustodyDailySnapshot> = [],
): bigint {
  const rawSupply = BigInt(row.totalSupply);
  const { lockedSupply } = latestLockedSupplyForDailyRows(custodyRows);
  return rawSupply >= lockedSupply ? rawSupply - lockedSupply : BigInt(0);
}

function pickBaselineSupply(
  rows: ReadonlyArray<StableSupplyDailySnapshot>,
  sevenDayCutoff: bigint,
  custodyRows: ReadonlyArray<StableTokenCustodyDailySnapshot>,
): bigint {
  // Walk sorted-ASC rows; the last one whose timestamp is ≤ cutoff is the
  // 7d baseline. Fall back to the earliest row when everything is recent
  // (so a brand-new token's first observed snapshot stays the baseline).
  let baseline: StableSupplyDailySnapshot | undefined;
  for (const r of rows) {
    if (BigInt(r.timestamp) > sevenDayCutoff) break;
    baseline = r;
  }
  if (baseline) return circulatingSupplyForSnapshot(baseline, custodyRows);
  const first = rows[0];
  return first ? circulatingSupplyForSnapshot(first, custodyRows) : BigInt(0);
}

function buildTokenAgg(
  key: string,
  rows: StableSupplyDailySnapshot[],
  rates: OracleRateMap,
  sevenDayCutoff: bigint,
  custodyRows: ReadonlyArray<StableTokenCustodyDailySnapshot>,
): TokenAgg {
  rows.sort((a, b) => {
    const ta = BigInt(a.timestamp);
    const tb = BigInt(b.timestamp);
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return 0;
  });
  const latest = rows[rows.length - 1]!;
  const latestTimestamp = BigInt(latest.timestamp);
  const latestCustody = latestLockedSupplyForDailyRows(custodyRows);
  const latestLockedSupply = latestCustody.lockedSupply;
  const latestSupply = latestDailyCirculatingSupply(latest, custodyRows);
  const baselineSupply = pickBaselineSupply(rows, sevenDayCutoff, custodyRows);
  const netChange7d = latestSupply - baselineSupply;
  const change7dPct =
    baselineSupply === BigInt(0)
      ? null
      : (Number(netChange7d) / Number(baselineSupply)) * 100;

  // USD-pegged stables (USDm, cUSD, USDC, ...) default to rate=1 when the
  // oracle map doesn't carry a direct entry — useOracleRates derives
  // non-USDm rates against USDm pairs, so USDm itself never gets an
  // entry. Without the default, USDm tiles and stacked-area slices
  // render null on healthy data.
  const rate = effectiveOracleRate(rates, latest.tokenSymbol, latest.chainId);
  const usd = (raw: bigint): number | null =>
    rate == null ? null : parseWei(raw.toString(), latest.tokenDecimals) * rate;

  return {
    key,
    chainId: latest.chainId,
    tokenAddress: latest.tokenAddress,
    tokenSymbol: latest.tokenSymbol,
    source: latest.source,
    tokenDecimals: latest.tokenDecimals,
    latestTotalSupply: latestSupply,
    latestLockedSupply,
    latestTimestamp:
      latestCustody.timestamp !== null &&
      latestCustody.timestamp > latestTimestamp
        ? latestCustody.timestamp
        : latestTimestamp,
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
  // N-day rolling window keeps a fixed bucket count: dayStart - (N-1)*86400.
  const daysBack = range === "7d" ? 6 : range === "30d" ? 29 : 89;
  return dayStart - daysBack * SECONDS_PER_DAY_NUMBER;
}

// Builds one (timestamp, usdValue) point per UTC day from `effectiveStartTs`
// to today, forward-filling totalSupply across sparse days.
//
// The caller computes `effectiveStartTs` via `computeChartStartSeconds` so
// the stacked hero chart shares a single x-axis across all token series.
// Critical: a naive call with `rangeStartSeconds("all") === 0` (epoch)
// would iterate ~20K days × N tokens and freeze the browser — the
// caller-side helper clamps `"all"` to the earliest observed snapshot.
//
// Pre-`effectiveStartTs` snapshots are used to seed the baseline so a
// token with its only known snapshot 14 days ago still contributes its
// supply across a 7d window. Tokens with no pre-window data start at 0.
export function buildTokenUsdTimeSeries(
  snapshots: ReadonlyArray<StableSupplyDailySnapshot>,
  rates: OracleRateMap,
  effectiveStartTs: number,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  custodySnapshots: ReadonlyArray<StableTokenCustodyDailySnapshot> = [],
): Array<{ timestamp: number; valueUsd: number }> {
  if (snapshots.length === 0) return [];
  const symbol = snapshots[0]!.tokenSymbol;
  const chainId = snapshots[0]!.chainId;
  const rate = effectiveOracleRate(rates, symbol, chainId);
  if (rate == null) return [];

  // Sort ASC over the FULL set (including pre-window). Don't mutate the
  // input — readonly inputs from upstream rollups would surprise-mutate.
  const sorted = [...snapshots].sort(
    (a, b) => Number(a.timestamp) - Number(b.timestamp),
  );
  const sortedCustody = [...custodySnapshots].sort(
    (a, b) => Number(a.timestamp) - Number(b.timestamp),
  );

  const dayStartNow =
    Math.floor(nowSeconds / SECONDS_PER_DAY_NUMBER) * SECONDS_PER_DAY_NUMBER;
  const decimals = sorted[0]!.tokenDecimals;

  // Walk pre-window rows to seed the baseline. The last row at or before
  // effectiveStartTs holds the supply we forward-fill from.
  let cursor = 0;
  let custodyCursor = 0;
  let lastSupply = BigInt(0);
  let lastLockedSupply = BigInt(0);
  while (
    cursor < sorted.length &&
    Number(sorted[cursor]!.timestamp) < effectiveStartTs
  ) {
    lastSupply = BigInt(sorted[cursor]!.totalSupply);
    cursor++;
  }
  while (
    custodyCursor < sortedCustody.length &&
    Number(sortedCustody[custodyCursor]!.timestamp) < effectiveStartTs
  ) {
    lastLockedSupply = BigInt(sortedCustody[custodyCursor]!.lockedSupply);
    custodyCursor++;
  }

  const out: Array<{ timestamp: number; valueUsd: number }> = [];
  for (
    let d = effectiveStartTs;
    d <= dayStartNow;
    d += SECONDS_PER_DAY_NUMBER
  ) {
    while (cursor < sorted.length && Number(sorted[cursor]!.timestamp) <= d) {
      lastSupply = BigInt(sorted[cursor]!.totalSupply);
      cursor++;
    }
    while (
      custodyCursor < sortedCustody.length &&
      Number(sortedCustody[custodyCursor]!.timestamp) <= d
    ) {
      lastLockedSupply = BigInt(sortedCustody[custodyCursor]!.lockedSupply);
      custodyCursor++;
    }
    const circulatingSupply =
      lastSupply >= lastLockedSupply
        ? lastSupply - lastLockedSupply
        : BigInt(0);
    out.push({
      timestamp: d,
      valueUsd: parseWei(circulatingSupply.toString(), decimals) * rate,
    });
  }
  return out;
}

/**
 * Shared x-axis start across all token series in the hero chart. Bounded
 * so `range === "all"` doesn't degenerate into an epoch-to-now iteration
 * (`rangeStartSeconds("all") === 0` would iterate ~20K days × N tokens
 * and freeze the browser). For `"all"`, floors at the earliest observed
 * snapshot across all groups. For bounded ranges, returns the standard
 * `rangeStartSeconds` cutoff as-is.
 */
export function computeChartStartSeconds(
  groupedSnapshots: ReadonlyMap<
    string,
    ReadonlyArray<StableSupplyDailySnapshot>
  >,
  range: RangeKey,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): number {
  if (range !== "all") return rangeStartSeconds(range, nowSeconds);

  let earliest: number | null = null;
  for (const rows of groupedSnapshots.values()) {
    for (const r of rows) {
      const t = Number(r.timestamp);
      if (earliest === null || t < earliest) earliest = t;
    }
  }
  const dayStartNow =
    Math.floor(nowSeconds / SECONDS_PER_DAY_NUMBER) * SECONDS_PER_DAY_NUMBER;
  if (earliest === null) return dayStartNow;
  // Floor to UTC midnight of the earliest snapshot's day.
  return Math.floor(earliest / SECONDS_PER_DAY_NUMBER) * SECONDS_PER_DAY_NUMBER;
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
