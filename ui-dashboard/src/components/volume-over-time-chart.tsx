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
import {
  SECONDS_PER_DAY,
  TimeSeriesChartCard,
  type RangeKey,
  type TimeSeriesPoint,
} from "@/components/time-series-chart-card";

type SeriesPoint = { timestamp: number; volumeUSD: number };

/**
 * Includes swap volume from every pool type (FPMM and virtual), matching the
 * Summary tile's volume totals. Virtual pools also emit hourly PoolSnapshot
 * rows with per-hour swapVolume0/1, so excluding them would silently undercount
 * protocol volume and desync the chart from its Summary-tile counterpart.
 *
 * When `window` is provided, snapshots are filtered to `[window.from, window.to)`
 * *before* bucketing. This keeps the chart's range totals consistent with the
 * Summary tile's rolling-window subtotals — the edge buckets may be partial
 * (e.g. 1W's leftmost bucket covers the last N hours of a UTC day instead of
 * the full 24h) but the sum over all buckets equals the sum of snapshots in
 * that exact rolling window.
 */
export function buildDailyVolumeSeries(
  networkData: NetworkData[],
  window?: TimeRange,
): SeriesPoint[] {
  const bucketTotals = new Map<number, number>();
  let minSnapshotBucket = Infinity;

  for (const netData of networkData) {
    if (netData.error !== null || netData.snapshotsAllError !== null) continue;
    const poolById = new Map(netData.pools.map((pool) => [pool.id, pool]));
    for (const snapshot of netData.snapshotsAll) {
      const timestamp = Number(snapshot.timestamp);
      if (window && (timestamp < window.from || timestamp >= window.to))
        continue;
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
      bucketTotals.set(bucket, (bucketTotals.get(bucket) ?? 0) + volume);
    }
  }

  if (!Number.isFinite(minSnapshotBucket)) return [];

  const startBucket = window
    ? Math.floor(window.from / SECONDS_PER_DAY) * SECONDS_PER_DAY
    : minSnapshotBucket;
  const endRef = window?.to ?? Math.floor(Date.now() / 1000);
  const endBucket = Math.floor(endRef / SECONDS_PER_DAY) * SECONDS_PER_DAY;
  // When endRef lands exactly on a UTC-day boundary (e.g. the user loads at
  // midnight UTC, or window.to = hourBucket(midnight)), the bucket at
  // endBucket covers [endBucket, endBucket + SECONDS_PER_DAY) — entirely
  // outside the half-open filter range [window.from, window.to). Skip it or
  // we'd emit a synthetic zero bar at the right edge.
  const lastBucket =
    endRef > endBucket ? endBucket : endBucket - SECONDS_PER_DAY;

  const series: SeriesPoint[] = [];
  for (
    let timestamp = startBucket;
    timestamp <= lastBucket;
    timestamp += SECONDS_PER_DAY
  ) {
    series.push({ timestamp, volumeUSD: bucketTotals.get(timestamp) ?? 0 });
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

  // Full-history series kept for the WoW delta (which needs ≥15 UTC-day
  // buckets). The chart's visible series for 7d/30d uses a different,
  // rolling-window bucketing path so the range total matches the Summary
  // tile's rolling-window subtotals exactly.
  const fullSeries = useMemo<TimeSeriesPoint[]>(
    () =>
      buildDailyVolumeSeries(networkData).map((point) => ({
        timestamp: point.timestamp,
        value: point.volumeUSD,
      })),
    [networkData],
  );

  const visibleSeries = useMemo<TimeSeriesPoint[]>(() => {
    if (range === "all") return fullSeries;
    // Use the fetch-anchored snapshot window (captured once by the hook
    // during fetchAllNetworks) rather than a fresh `Date.now()` window at
    // render time. The Summary tile's 7d/30d subtotals are derived from
    // those fetch-time windows; using a render-time window drifts by up
    // to the SWR refresh interval around hour boundaries.
    const fetchWindows = networkData[0]?.snapshotWindows;
    const window = fetchWindows
      ? range === "7d"
        ? fetchWindows.w7d
        : fetchWindows.w30d
      : range === "7d"
        ? snapshotWindow7d(Date.now())
        : snapshotWindow30d(Date.now());
    return buildDailyVolumeSeries(networkData, window).map((point) => ({
      timestamp: point.timestamp,
      value: point.volumeUSD,
    }));
  }, [networkData, range, fullSeries]);

  // Hero = sum of visible bars. With rolling-window bucketing on 7d/30d this
  // exactly equals the Summary tile's subtotal for the same window.
  const rangeTotal = useMemo(
    () => visibleSeries.reduce((sum, point) => sum + point.value, 0),
    [visibleSeries],
  );

  // Show "N/A" only on explicit failure. An empty series without errors
  // legitimately sums to $0 (no volume yet) — flagging that as N/A would
  // incorrectly conflate "no activity" with "data missing".
  const headline = isLoading
    ? "…"
    : hasError || (hasSnapshotError && fullSeries.length === 0)
      ? "N/A"
      : formatUSD(rangeTotal);

  // Only show a delta when the comparison basis matches the visible range.
  // At 30d range we'd need 60d of data for a month-over-month comparison,
  // which we don't have — suppress rather than mislabel.
  const change = range === "7d" ? weekOverWeekChangePct(fullSeries) : null;

  const emptyMessage = hasError
    ? "Unable to load volume history"
    : hasSnapshotError
      ? "Historical data partial — some chains failed to load"
      : "Not enough history yet";

  return (
    <TimeSeriesChartCard
      title="Volume"
      rangeAriaLabel="Volume chart time range"
      series={visibleSeries}
      range={range}
      onRangeChange={setRange}
      headline={headline}
      change={change}
      isLoading={isLoading}
      hasError={hasError}
      hasSnapshotError={hasSnapshotError}
      emptyMessage={emptyMessage}
    />
  );
}
