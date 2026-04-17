"use client";

import { useMemo, useState } from "react";
import { formatUSD } from "@/lib/format";
import { getSnapshotVolumeInUsd } from "@/lib/volume";
import type { Network } from "@/lib/networks";
import { canPricePool, type OracleRateMap } from "@/lib/tokens";
import type { Pool, PoolSnapshot } from "@/lib/types";
import { TimeSeriesChartCard } from "@/components/time-series-chart-card";
import {
  SECONDS_PER_DAY,
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
  /**
   * False when the pool type doesn't expose a snapshot history (non-FPMM).
   * Changes the empty-state copy from "not enough history yet" to
   * "history unavailable for this pool type".
   */
  historySupported?: boolean;
}

export function PoolVolumeOverTimeChart({
  pool,
  network,
  snapshots,
  isLoading,
  hasError,
  rates,
  historySupported = true,
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

  // Day-aligned cutoff with gap-fill: "1W" renders exactly 7 UTC-day buckets
  // (6 prior full + today), "1M" renders 30. Missing daily snapshots — real
  // in this repo for sparse pools — surface as explicit $0 bars rather than
  // dropped points, so Plotly doesn't bridge a line across absent days and
  // the headline total is the honest sum over the full calendar window.
  const visibleSeries = useMemo(() => {
    if (range === "all" || fullSeries.length === 0) return fullSeries;
    const days = range === "7d" ? 7 : 30;
    const todayStart =
      Math.floor(Date.now() / 1000 / SECONDS_PER_DAY) * SECONDS_PER_DAY;
    const byBucket = new Map<number, number>();
    for (const pt of fullSeries) {
      const bucket =
        Math.floor(pt.timestamp / SECONDS_PER_DAY) * SECONDS_PER_DAY;
      byBucket.set(bucket, pt.value);
    }
    const points: TimeSeriesPoint[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const ts = todayStart - i * SECONDS_PER_DAY;
      points.push({ timestamp: ts, value: byBucket.get(ts) ?? 0 });
    }
    return points;
  }, [fullSeries, range]);

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
          : !historySupported
            ? "History unavailable for this pool type"
            : !priceable
              ? "Volume unavailable for this pair"
              : "Not enough history yet"
      }
    />
  );
}
