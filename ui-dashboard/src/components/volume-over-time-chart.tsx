"use client";

import { useMemo, useState } from "react";
import { formatUSD } from "@/lib/format";
import {
  getSnapshotVolumeInUsd,
  snapshotWindow7d,
  snapshotWindow30d,
  type TimeRange,
} from "@/lib/volume";
import type { NetworkData } from "@/hooks/use-all-networks-data";
import type { Network } from "@/lib/networks";
import {
  TimeSeriesChartCard,
  type BreakdownSeries,
} from "@/components/time-series-chart-card";
import {
  SECONDS_PER_DAY,
  type RangeKey,
  type TimeSeriesPoint,
} from "@/lib/time-series";

type SeriesPoint = { timestamp: number; volumeUSD: number };

export type ChainVolumeSeries = {
  network: Network;
  series: SeriesPoint[];
};

// Mento-protocol indigo for v3 (Router-driven) and a teal contrast for v2
// (legacy Broker → BiPoolManager). v3 dominates today, so it sits at the
// bottom of the stack and uses the brand color; v2 stacks on top in a
// distinct teal so the gap reads at a glance even when small.
const V3_COLOR = "#6366f1"; // indigo-500
const V2_COLOR = "#14b8a6"; // teal-500

/**
 * Includes swap volume from every pool type (FPMM and virtual), matching the
 * Summary tile's volume totals. Virtual pools also emit PoolDailySnapshot
 * rows with per-day swapVolume0/1, so excluding them would silently undercount
 * protocol volume and desync the chart from its Summary-tile counterpart.
 *
 * Input is the indexer's PoolDailySnapshot rollup (one row per pool per UTC
 * day). Each row's `timestamp` is the start of its UTC-day bucket and its
 * volume is the total for the full day.
 *
 * When `window` is provided only buckets whose timestamp falls strictly inside
 * the half-open window `[window.from, window.to)` are included. Because
 * `window.from` is an hour boundary (not midnight), the first UTC-day bucket
 * is included only when it starts at or after `window.from`, which means a
 * refresh at 10:00 UTC on day D shows the last 7 full days starting from day
 * D-7 (midnight). The chart's headline total therefore matches the exact
 * rolling-window period implied by the selected range tab.
 */
export function buildDailyVolumeSeries(
  networkData: NetworkData[],
  window?: TimeRange,
): { series: SeriesPoint[]; byChain: ChainVolumeSeries[] } {
  type PerChain = {
    network: Network;
    bucketTotals: Map<number, number>;
  };
  // Keyed by Network.id so distinct configured networks that share a chainId
  // (e.g. celo-mainnet vs celo-mainnet-local) stay separate in the breakdown.
  const perChain = new Map<string, PerChain>();
  const totalBuckets = new Map<number, number>();
  let minSnapshotBucket = Infinity;

  for (const netData of networkData) {
    // Only skip on top-level failure. `snapshotsAllDailyError` may be set
    // while `snapshotsAllDaily` still carries preserved recent rows (fail-open
    // path for mid-loop pagination failure) — use those rows, the caller
    // shows a partial-data badge separately.
    if (netData.error !== null) continue;
    const poolById = new Map(netData.pools.map((pool) => [pool.id, pool]));
    for (const snapshot of netData.snapshotsAllDaily) {
      const timestamp = Number(snapshot.timestamp);
      if (window) {
        if (timestamp < window.from || timestamp >= window.to) continue;
      }
      const pool = poolById.get(snapshot.poolId);
      const volume = getSnapshotVolumeInUsd(
        snapshot,
        pool,
        netData.network,
        netData.rates,
      );
      if (volume === null) continue;
      const bucket = Math.floor(timestamp / SECONDS_PER_DAY) * SECONDS_PER_DAY;
      minSnapshotBucket = Math.min(minSnapshotBucket, bucket);
      totalBuckets.set(bucket, (totalBuckets.get(bucket) ?? 0) + volume);
      let entry = perChain.get(netData.network.id);
      if (!entry) {
        entry = { network: netData.network, bucketTotals: new Map() };
        perChain.set(netData.network.id, entry);
      }
      entry.bucketTotals.set(
        bucket,
        (entry.bucketTotals.get(bucket) ?? 0) + volume,
      );
    }
  }

  if (!Number.isFinite(minSnapshotBucket)) return { series: [], byChain: [] };

  // Use ceil so the emission range starts at the first full UTC day that begins
  // at or after window.from — prevents a synthetic zero bar for any partial day
  // whose bucket starts before window.from but was excluded by the strict filter.
  const startBucket = window
    ? Math.ceil(window.from / SECONDS_PER_DAY) * SECONDS_PER_DAY
    : minSnapshotBucket;
  const endRef = window?.to ?? Math.floor(Date.now() / 1000);
  const endBucket = Math.floor(endRef / SECONDS_PER_DAY) * SECONDS_PER_DAY;
  // When window.to lands exactly on a UTC-day boundary the bucket at endBucket
  // starts at window.to and is excluded by the strict filter (timestamp >=
  // window.to), so we clamp the loop to avoid an empty bar there. When window.to
  // is mid-day (the production case from hourBucket(Date.now())) endRef >
  // endBucket and we emit today's bucket — PoolDailySnapshot is incremental, so
  // today's row contains only swaps seen so far today, which is valid in-window data.
  const lastBucket =
    endRef > endBucket ? endBucket : endBucket - SECONDS_PER_DAY;

  const series: SeriesPoint[] = [];
  const byChain: ChainVolumeSeries[] = Array.from(perChain.values()).map(
    (entry) => ({ network: entry.network, series: [] }),
  );
  for (
    let timestamp = startBucket;
    timestamp <= lastBucket;
    timestamp += SECONDS_PER_DAY
  ) {
    series.push({ timestamp, volumeUSD: totalBuckets.get(timestamp) ?? 0 });
    let i = 0;
    for (const entry of perChain.values()) {
      byChain[i].series.push({
        timestamp,
        volumeUSD: entry.bucketTotals.get(timestamp) ?? 0,
      });
      i++;
    }
  }
  return { series, byChain };
}

/**
 * Aggregate per-chain `brokerSnapshotsAllDaily` rows into a single daily
 * USD-volume series for legacy v2 traffic (Broker → BiPoolManager). Rows are
 * already filtered server-side to `routedViaV3Router=false`, so summing them
 * directly gives the v2 number without re-checking the v3-Router siblings.
 *
 * Same windowing semantics as `buildDailyVolumeSeries`: a `window` filters
 * rows to `[window.from, window.to)` and the emitted series zero-fills any
 * empty UTC-day bucket inside the window so the stack alignment with the v3
 * series stays correct.
 */
export function buildBrokerDailyV2Series(
  networkData: NetworkData[],
  window?: TimeRange,
): SeriesPoint[] {
  const totalBuckets = new Map<number, number>();
  let minBucket = Infinity;
  for (const netData of networkData) {
    if (netData.error !== null) continue;
    for (const row of netData.brokerSnapshotsAllDaily) {
      const timestamp = Number(row.timestamp);
      if (window && (timestamp < window.from || timestamp >= window.to))
        continue;
      // 18-decimal "USD-wei" → JS number USD. BigInt() handles the string;
      // dividing by 1e18 in floating-point loses sub-cent precision, which
      // is fine for chart rendering (we don't display sub-cent on a chart
      // measured in $K/$M).
      const usd = Number(BigInt(row.volumeUsdWei)) / 1e18;
      const bucket = Math.floor(timestamp / SECONDS_PER_DAY) * SECONDS_PER_DAY;
      minBucket = Math.min(minBucket, bucket);
      totalBuckets.set(bucket, (totalBuckets.get(bucket) ?? 0) + usd);
    }
  }
  if (!Number.isFinite(minBucket)) return [];

  const startBucket = window
    ? Math.ceil(window.from / SECONDS_PER_DAY) * SECONDS_PER_DAY
    : minBucket;
  const endRef = window?.to ?? Math.floor(Date.now() / 1000);
  const endBucket = Math.floor(endRef / SECONDS_PER_DAY) * SECONDS_PER_DAY;
  const lastBucket =
    endRef > endBucket ? endBucket : endBucket - SECONDS_PER_DAY;

  const series: SeriesPoint[] = [];
  for (
    let timestamp = startBucket;
    timestamp <= lastBucket;
    timestamp += SECONDS_PER_DAY
  ) {
    series.push({ timestamp, volumeUSD: totalBuckets.get(timestamp) ?? 0 });
  }
  return series;
}

/**
 * Week-over-week % change: sum of the last 7 completed UTC days vs the 7 days
 * before that. The final bucket in `fullSeries` is usually the partial current
 * UTC day (still filling up), so the comparison excludes it and uses the
 * trailing [-8, -1] vs [-15, -8] windows. Returns null when history is too
 * short or the prior window was zero.
 */
export function weekOverWeekChangePct(
  series: TimeSeriesPoint[],
): number | null {
  if (series.length < 15) return null;
  const last7 = series.slice(-8, -1);
  const prior7 = series.slice(-15, -8);
  const sum = (arr: TimeSeriesPoint[]) =>
    arr.reduce((total, point) => total + point.value, 0);
  const prior = sum(prior7);
  if (prior <= 0) return null;
  return ((sum(last7) - prior) / prior) * 100;
}

// Show "N/A" only on explicit failure. An empty series without errors
// legitimately sums to $0 (no volume yet) — flagging it N/A would conflate
// "no activity" with "data missing".
function computeHeadline(
  isLoading: boolean,
  hasError: boolean,
  hasSnapshotError: boolean,
  v3Points: SeriesPoint[],
  v2Points: SeriesPoint[],
  v3Total: number,
  v2Total: number,
): string {
  if (isLoading) return "…";
  if (hasError) return "N/A";
  if (hasSnapshotError && v3Points.length === 0 && v2Points.length === 0)
    return "N/A";
  return `${formatUSD(v3Total)} v3 · ${formatUSD(v2Total)} v2`;
}

interface VolumeOverTimeChartProps {
  networkData: NetworkData[];
  isLoading: boolean;
  hasError: boolean;
  hasSnapshotError: boolean;
}

export function VolumeOverTimeChart({
  networkData,
  isLoading,
  hasError,
  hasSnapshotError,
}: VolumeOverTimeChartProps) {
  const [range, setRange] = useState<RangeKey>("30d");

  // Full-history v3 pass kept for the WoW delta (≥15 UTC-day buckets) and the
  // "all" range tab. v3 = Router-driven volume, sourced from PoolDailySnapshot
  // (FPMM + VirtualPool, summed since both are downstream of the v3 Router).
  const fullV3Result = useMemo(
    () => buildDailyVolumeSeries(networkData),
    [networkData],
  );

  // v3 WoW pill — v2 has a separate trajectory but is much smaller today, so
  // tracking the dominant-side delta keeps the headline meaningful. v2 WoW
  // can be added once v2 volumes are large enough to read at chart scale.
  const fullV3Series = useMemo<TimeSeriesPoint[]>(
    () =>
      fullV3Result.series.map((p) => ({
        timestamp: p.timestamp,
        value: p.volumeUSD,
      })),
    [fullV3Result],
  );

  const activeWindow = useMemo<TimeRange | undefined>(() => {
    if (range === "all") return undefined;
    // All networks are fetched together by `fetchAllNetworks`, so their
    // `snapshotWindows` are anchored at the same hour boundary — taking
    // index 0 is representative. Falls back to a fresh `Date.now()` window
    // only on cold-start before the first SWR fetch resolves.
    const fetchWindows = networkData[0]?.snapshotWindows;
    return fetchWindows
      ? range === "7d"
        ? fetchWindows.w7d
        : fetchWindows.w30d
      : range === "7d"
        ? snapshotWindow7d(Date.now())
        : snapshotWindow30d(Date.now());
  }, [networkData, range]);

  // v3 series for the active window — reuses fullV3Result on the "all" tab
  // since the window matches.
  const visibleV3Points = useMemo<SeriesPoint[]>(
    () =>
      range === "all"
        ? fullV3Result.series
        : buildDailyVolumeSeries(networkData, activeWindow).series,
    [networkData, range, activeWindow, fullV3Result],
  );

  // v2 series for the active window — sourced from BrokerDailySnapshot
  // (already filtered to routedViaV3Router=false server-side). Empty until
  // the indexer's Broker handler is deployed and resyncs.
  const visibleV2Points = useMemo<SeriesPoint[]>(
    () => buildBrokerDailyV2Series(networkData, activeWindow),
    [networkData, activeWindow],
  );

  // Stack v3 (bottom) + v2 (top). Distinct, named legend entries; the chart
  // card suppresses its own total trace in `stacked` mode so the breakdown
  // areas read directly.
  const visibleBreakdown = useMemo<BreakdownSeries[]>(() => {
    const toPoints = (xs: SeriesPoint[]) =>
      xs.map((p) => ({ timestamp: p.timestamp, value: p.volumeUSD }));
    return [
      {
        name: "v3 (Router)",
        color: V3_COLOR,
        series: toPoints(visibleV3Points),
      },
      {
        name: "v2 (Legacy)",
        color: V2_COLOR,
        series: toPoints(visibleV2Points),
      },
    ];
  }, [visibleV3Points, visibleV2Points]);

  // Per-version range totals — rolling-window bucketing means each side's
  // sum equals that version's volume for the visible range.
  const v3RangeTotal = useMemo(
    () => visibleV3Points.reduce((sum, p) => sum + p.volumeUSD, 0),
    [visibleV3Points],
  );
  const v2RangeTotal = useMemo(
    () => visibleV2Points.reduce((sum, p) => sum + p.volumeUSD, 0),
    [visibleV2Points],
  );

  // The chart card reads `series` for the x-axis timestamps and the
  // empty-state gate (`!isLoading && series.length === 0`). The y-axis range
  // in stacked mode comes from the breakdown traces, so we don't need a
  // summed-Y series here — the v3 points are already day-aligned with v2,
  // already sorted, and non-empty whenever either side has data.
  const visibleSeriesForCard = useMemo<TimeSeriesPoint[]>(
    () =>
      (visibleV3Points.length >= visibleV2Points.length
        ? visibleV3Points
        : visibleV2Points
      ).map((p) => ({ timestamp: p.timestamp, value: p.volumeUSD })),
    [visibleV3Points, visibleV2Points],
  );

  const headline = computeHeadline(
    isLoading,
    hasError,
    hasSnapshotError,
    visibleV3Points,
    visibleV2Points,
    v3RangeTotal,
    v2RangeTotal,
  );

  const change = weekOverWeekChangePct(fullV3Series);

  const emptyMessage = hasError
    ? "Unable to load volume history"
    : hasSnapshotError
      ? "Historical data partial — some chains failed to load"
      : "Not enough history yet";

  return (
    <TimeSeriesChartCard
      title="Volume"
      rangeAriaLabel="Volume chart time range"
      series={visibleSeriesForCard}
      breakdown={visibleBreakdown}
      breakdownMode="stacked"
      range={range}
      onRangeChange={setRange}
      headline={headline}
      change={change}
      changeLabel="v3 week-over-week"
      isLoading={isLoading}
      hasError={hasError}
      hasSnapshotError={hasSnapshotError}
      emptyMessage={emptyMessage}
    />
  );
}
