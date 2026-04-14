"use client";

import { useMemo, useState } from "react";
import { formatUSD } from "@/lib/format";
import { getSnapshotVolumeInUsd } from "@/lib/volume";
import type { NetworkData } from "@/hooks/use-all-networks-data";
import {
  SECONDS_PER_DAY,
  TimeSeriesChartCard,
  filterSeriesByRange,
  type RangeKey,
  type TimeSeriesPoint,
} from "@/components/time-series-chart-card";

type SeriesPoint = { timestamp: number; volumeUSD: number };

/**
 * Includes swap volume from every pool type (FPMM and virtual), matching the
 * Summary tile's volume totals. Virtual pools also emit hourly PoolSnapshot
 * rows with per-hour swapVolume0/1, so excluding them would silently undercount
 * protocol volume and desync the chart from its Summary-tile counterpart.
 */
export function buildDailyVolumeSeries(
  networkData: NetworkData[],
): SeriesPoint[] {
  const bucketTotals = new Map<number, number>();
  let earliestBucket = Infinity;

  for (const netData of networkData) {
    if (netData.error !== null || netData.snapshotsAllError !== null) continue;
    const poolById = new Map(netData.pools.map((pool) => [pool.id, pool]));
    for (const snapshot of netData.snapshotsAll) {
      const pool = poolById.get(snapshot.poolId);
      const volume = getSnapshotVolumeInUsd(
        snapshot,
        pool,
        netData.network,
        netData.rates,
      );
      if (volume === null) continue;
      const timestamp = Number(snapshot.timestamp);
      const bucket = Math.floor(timestamp / SECONDS_PER_DAY) * SECONDS_PER_DAY;
      earliestBucket = Math.min(earliestBucket, bucket);
      bucketTotals.set(bucket, (bucketTotals.get(bucket) ?? 0) + volume);
    }
  }

  if (!Number.isFinite(earliestBucket)) return [];

  const nowSec = Math.floor(Date.now() / 1000);
  const endBucket = Math.floor(nowSec / SECONDS_PER_DAY) * SECONDS_PER_DAY;

  const series: SeriesPoint[] = [];
  for (
    let timestamp = earliestBucket;
    timestamp <= endBucket;
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

  const fullSeries = useMemo<TimeSeriesPoint[]>(
    () =>
      buildDailyVolumeSeries(networkData).map((point) => ({
        timestamp: point.timestamp,
        value: point.volumeUSD,
      })),
    [networkData],
  );

  const visibleSeries = useMemo(
    () => filterSeriesByRange(fullSeries, range),
    [fullSeries, range],
  );

  // Hero reflects the selected range — sum of the visible bars. Avoids the
  // "title says 7d but chart shows 30d" mismatch flagged in PR review.
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
      series={fullSeries}
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
