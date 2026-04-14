"use client";

import { useMemo } from "react";
import { formatUSD } from "@/lib/format";
import { isFpmm } from "@/lib/tokens";
import { getSnapshotVolumeInUsd } from "@/lib/volume";
import type { NetworkData } from "@/hooks/use-all-networks-data";
import {
  SECONDS_PER_DAY,
  TimeSeriesChartCard,
  type TimeSeriesPoint,
} from "@/components/time-series-chart-card";

type SeriesPoint = { timestamp: number; volumeUSD: number };

export function buildDailyVolumeSeries(
  networkData: NetworkData[],
): SeriesPoint[] {
  const bucketTotals = new Map<number, number>();
  let earliestBucket = Infinity;

  for (const netData of networkData) {
    if (netData.error !== null || netData.snapshots30dError !== null) continue;
    const fpmmPoolIds = new Set(
      netData.pools.filter(isFpmm).map((pool) => pool.id),
    );
    const poolById = new Map(netData.pools.map((pool) => [pool.id, pool]));
    for (const snapshot of netData.snapshots30d) {
      if (!fpmmPoolIds.has(snapshot.poolId)) continue;
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

interface VolumeOverTimeChartProps {
  networkData: NetworkData[];
  totalVolume7d: number | null;
  change7d: number | null;
  isLoading: boolean;
  hasError: boolean;
  hasSnapshotError: boolean;
}

export function VolumeOverTimeChart({
  networkData,
  totalVolume7d,
  change7d,
  isLoading,
  hasError,
  hasSnapshotError,
}: VolumeOverTimeChartProps) {
  const fullSeries = useMemo<TimeSeriesPoint[]>(
    () =>
      buildDailyVolumeSeries(networkData).map((point) => ({
        timestamp: point.timestamp,
        value: point.volumeUSD,
      })),
    [networkData],
  );

  const headline = isLoading
    ? "…"
    : totalVolume7d === null
      ? "N/A"
      : formatUSD(totalVolume7d);

  const emptyMessage = hasError
    ? "Unable to load volume history"
    : hasSnapshotError
      ? "Historical data partial — some chains failed to load"
      : "Not enough history yet";

  return (
    <TimeSeriesChartCard
      title="Volume (past 7d)"
      rangeAriaLabel="Volume chart time range"
      series={fullSeries}
      headline={headline}
      change={change7d}
      isLoading={isLoading}
      hasError={hasError}
      hasSnapshotError={hasSnapshotError}
      emptyMessage={emptyMessage}
    />
  );
}
