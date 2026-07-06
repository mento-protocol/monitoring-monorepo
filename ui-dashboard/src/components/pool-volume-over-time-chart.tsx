"use client";

import { useMemo, useState } from "react";
import { formatUSD } from "@/lib/format";
import {
  getSnapshotVolumeInUsd,
  snapshotWindow7d,
  snapshotWindow30d,
} from "@/lib/volume";
import { sortedCopy } from "@/lib/immutable-sort";
import type { Network } from "@/lib/networks";
import { canPricePool, type OracleRateMap } from "@/lib/tokens";
import type { Pool, PoolSnapshot } from "@/lib/types";
import { TimeSeriesChartCard } from "@/components/time-series-chart-card";
import { zeroFillSeries } from "@/lib/chart-gap-fill";
import {
  SECONDS_PER_DAY,
  SECONDS_PER_HOUR,
  VOLUME_CHART_RANGES,
  dailyBucket,
  rangeKeyToDays,
  type RangeKey,
  type TimeSeriesPoint,
} from "@/lib/time-series";
import { usePoolSnapshots } from "@/lib/use-pool-snapshots";
import { fxPoolWeekendBandsForSeries } from "@/lib/weekend";

interface PoolVolumeOverTimeChartProps {
  poolId: string;
  pool: Pool;
  network: Network;
  isLoading: boolean;
  hasError: boolean;
  rates?: OracleRateMap;
  /**
   * False when the pool type doesn't expose a snapshot history (non-FPMM).
   * Changes the empty-state copy from "not enough history yet" to
   * "history unavailable for this pool type".
   */
  historySupported?: boolean;
}

function buildVolumeSeries({
  snapshots,
  pool,
  network,
  rates,
}: {
  snapshots: PoolSnapshot[];
  pool: Pool;
  network: Network;
  rates: OracleRateMap | undefined;
}): TimeSeriesPoint[] {
  const sorted = sortedCopy(
    snapshots,
    (a, b) => Number(a.timestamp) - Number(b.timestamp),
  );
  const points: TimeSeriesPoint[] = [];
  for (const snap of sorted) {
    const value = getSnapshotVolumeInUsd(
      snap,
      pool,
      network,
      rates ?? new Map(),
    );
    if (value === null) continue;
    points.push({ timestamp: Number(snap.timestamp), value });
  }
  return points;
}

function volumeWindow({
  series,
  range,
  bucketSeconds,
}: {
  series: TimeSeriesPoint[];
  range: RangeKey;
  bucketSeconds: number;
}): { from: number; to: number } {
  const nowMs = Date.now();
  if (bucketSeconds === SECONDS_PER_HOUR) {
    return range === "7d" ? snapshotWindow7d(nowMs) : snapshotWindow30d(nowMs);
  }

  const todayStart = dailyBucket(Math.floor(nowMs / 1000));
  const days = rangeKeyToDays(range);
  if (days !== null) {
    return {
      from: todayStart - (days - 1) * SECONDS_PER_DAY,
      to: todayStart + SECONDS_PER_DAY,
    };
  }
  return {
    from: Math.min(
      todayStart,
      ...series.map((pt) => dailyBucket(pt.timestamp)),
    ),
    to: todayStart + SECONDS_PER_DAY,
  };
}

function volumeHeadline({
  loading,
  priceable,
  visibleSeries,
  rangeTotal,
}: {
  loading: boolean;
  priceable: boolean;
  visibleSeries: TimeSeriesPoint[];
  rangeTotal: number;
}): string {
  if (loading) return "…";
  if (!priceable || visibleSeries.length === 0) return "—";
  return formatUSD(rangeTotal);
}

function volumeEmptyMessage(
  error: boolean,
  historySupported: boolean,
  priceable: boolean,
): string {
  if (error) return "Unable to load volume history";
  if (!historySupported) return "History unavailable for this pool type";
  if (!priceable) return "Volume unavailable for this pair";
  return "Not enough history yet";
}

export function PoolVolumeOverTimeChart({
  poolId,
  pool,
  network,
  isLoading,
  hasError,
  rates,
  historySupported = true,
}: PoolVolumeOverTimeChartProps) {
  const [range, setRange] = useState<RangeKey>("all");
  const {
    snapshots,
    bucketSeconds,
    isLoading: snapshotsLoading,
    hasError: snapshotsError,
  } = usePoolSnapshots(poolId, range, historySupported);

  const priceable = canPricePool(pool, network, rates ?? new Map());

  // Drop snapshots that can't be priced instead of coercing null → 0. Keeping
  // them as zeros would plot a fake "no-volume" bar and poison the range sum,
  // which the headline would then render as a real-looking "$0.00".
  const fullSeries = useMemo<TimeSeriesPoint[]>(() => {
    if (!priceable || snapshots.length === 0) return [];
    return buildVolumeSeries({ snapshots, pool, network, rates });
  }, [priceable, pool, network, snapshots, rates]);

  // Bucket-aligned gap-fill. 1M uses hourly PoolSnapshot rows; 3M/All use the
  // daily rollup so the query remains under hosted Hasura's 1000-row cap.
  const visibleSeries = useMemo(() => {
    if (fullSeries.length === 0) return fullSeries;
    const window = volumeWindow({
      series: fullSeries,
      range,
      bucketSeconds,
    });
    return zeroFillSeries(fullSeries, {
      from: window.from,
      to: window.to,
      bucketSeconds,
    });
  }, [fullSeries, range, bucketSeconds]);
  const shapes = useMemo(
    () =>
      fxPoolWeekendBandsForSeries({
        pool,
        network,
        series: visibleSeries,
        endPaddingSeconds: bucketSeconds,
      }),
    [pool, network, visibleSeries, bucketSeconds],
  );

  const rangeTotal = useMemo(
    () => visibleSeries.reduce((sum, pt) => sum + pt.value, 0),
    [visibleSeries],
  );
  const loading = isLoading || snapshotsLoading;
  const error = hasError || snapshotsError;
  const hoverDateFormat =
    bucketSeconds === SECONDS_PER_HOUR ? "%b %d, %H:00 UTC" : "%b %d, %Y";

  const headline = volumeHeadline({
    loading,
    priceable,
    visibleSeries,
    rangeTotal,
  });

  return (
    <TimeSeriesChartCard
      title="Volume"
      rangeAriaLabel="Pool volume chart time range"
      series={visibleSeries}
      range={range}
      onRangeChange={setRange}
      headline={headline}
      change={null}
      hoverDateFormat={hoverDateFormat}
      isLoading={loading}
      hasError={error}
      hasSnapshotError={false}
      ranges={VOLUME_CHART_RANGES}
      shapes={shapes}
      emptyMessage={volumeEmptyMessage(error, historySupported, priceable)}
    />
  );
}
