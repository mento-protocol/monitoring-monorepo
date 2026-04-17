"use client";

import { useMemo, useState } from "react";
import { formatUSD } from "@/lib/format";
import { getSnapshotVolumeInUsd } from "@/lib/volume";
import type { Network } from "@/lib/networks";
import { canPricePool, type OracleRateMap } from "@/lib/tokens";
import type { Pool, PoolSnapshot } from "@/lib/types";
import { TimeSeriesChartCard } from "@/components/time-series-chart-card";
import {
  filterSeriesByRange,
  type RangeKey,
  type TimeSeriesPoint,
} from "@/lib/time-series";

interface PoolVolumeOverTimeChartProps {
  pool: Pool;
  network: Network;
  snapshots: PoolSnapshot[];
  isLoading: boolean;
  hasError: boolean;
  rates?: OracleRateMap;
}

export function PoolVolumeOverTimeChart({
  pool,
  network,
  snapshots,
  isLoading,
  hasError,
  rates,
}: PoolVolumeOverTimeChartProps) {
  const [range, setRange] = useState<RangeKey>("all");

  const priceable = canPricePool(pool, network, rates ?? new Map());

  // Drop snapshots that can't be priced instead of coercing null → 0. Keeping
  // them as zeros would plot a fake "no-volume" bar and poison the range sum,
  // which the headline would then render as a real-looking "$0.00".
  const fullSeries = useMemo<TimeSeriesPoint[]>(() => {
    if (!priceable || snapshots.length === 0) return [];
    const sorted = [...snapshots].sort(
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
  }, [priceable, pool, network, snapshots, rates]);

  const visibleSeries = useMemo(
    () => filterSeriesByRange(fullSeries, range),
    [fullSeries, range],
  );

  const rangeTotal = useMemo(
    () => visibleSeries.reduce((sum, pt) => sum + pt.value, 0),
    [visibleSeries],
  );

  const headline = isLoading
    ? "…"
    : !priceable || visibleSeries.length === 0
      ? "—"
      : formatUSD(rangeTotal);

  return (
    <TimeSeriesChartCard
      title="Volume"
      rangeAriaLabel="Pool volume chart time range"
      series={visibleSeries}
      range={range}
      onRangeChange={setRange}
      headline={headline}
      change={null}
      isLoading={isLoading}
      hasError={hasError}
      hasSnapshotError={false}
      emptyMessage={
        hasError
          ? "Unable to load volume history"
          : !priceable
            ? "Volume unavailable for this pair"
            : "Not enough history yet"
      }
    />
  );
}
