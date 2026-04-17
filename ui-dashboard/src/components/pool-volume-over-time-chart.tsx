"use client";

import { useMemo, useState } from "react";
import { formatUSD } from "@/lib/format";
import { getSnapshotVolumeInUsd } from "@/lib/volume";
import type { Network } from "@/lib/networks";
import type { OracleRateMap } from "@/lib/tokens";
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

  const fullSeries = useMemo<TimeSeriesPoint[]>(() => {
    if (snapshots.length === 0) return [];
    const sorted = [...snapshots].sort(
      (a, b) => Number(a.timestamp) - Number(b.timestamp),
    );
    return sorted.map((snap) => ({
      timestamp: Number(snap.timestamp),
      value:
        getSnapshotVolumeInUsd(snap, pool, network, rates ?? new Map()) ?? 0,
    }));
  }, [pool, network, snapshots, rates]);

  const visibleSeries = useMemo(
    () => filterSeriesByRange(fullSeries, range),
    [fullSeries, range],
  );

  const rangeTotal = useMemo(
    () => visibleSeries.reduce((sum, pt) => sum + pt.value, 0),
    [visibleSeries],
  );

  // Show a placeholder headline when there's no data to aggregate — either the
  // pool type doesn't expose snapshots (non-FPMM) or the range is empty.
  // Without this, formatUSD(0) renders as a real-looking "$0.00", masking the
  // fact that volume data is unavailable rather than actually zero.
  const headline = isLoading
    ? "…"
    : visibleSeries.length === 0
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
        hasError ? "Unable to load volume history" : "Not enough history yet"
      }
    />
  );
}
