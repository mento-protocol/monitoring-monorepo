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

  // Day-aligned cutoff: "1W" = last 7 UTC days (6 prior full + today), "1M"
  // = last 30. Aligns to the current UTC-day boundary so the window doesn't
  // drift across renders within the same day, and stays in calendar-day
  // terms even when the pool has gaps in its daily snapshots (a slice(-N)
  // over rows would silently widen the window past N days for sparse pools).
  const visibleSeries = useMemo(() => {
    if (range === "all") return fullSeries;
    const days = range === "7d" ? 7 : 30;
    const todayStart =
      Math.floor(Date.now() / 1000 / SECONDS_PER_DAY) * SECONDS_PER_DAY;
    const cutoff = todayStart - (days - 1) * SECONDS_PER_DAY;
    return fullSeries.filter((pt) => pt.timestamp >= cutoff);
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
          : !priceable
            ? "Volume unavailable for this pair"
            : !historySupported
              ? "History unavailable for this pool type"
              : "Not enough history yet"
      }
    />
  );
}
