"use client";

import { useMemo, useState } from "react";
import { formatUSD } from "@/lib/format";
import { getSnapshotVolumeInUsd } from "@/lib/volume";
import type { Network } from "@/lib/networks";
import {
  canPricePool,
  isFpmm,
  isFxPool,
  type OracleRateMap,
} from "@/lib/tokens";
import type { Pool, PoolSnapshot } from "@/lib/types";
import { TimeSeriesChartCard } from "@/components/time-series-chart-card";
import { zeroFillSeries } from "@/lib/chart-gap-fill";
import {
  SECONDS_PER_DAY,
  type RangeKey,
  type TimeSeriesPoint,
} from "@/lib/time-series";
import { fxWeekendBands } from "@/lib/weekend";

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
    // ES2023 `toSorted` requires Safari 16+/Chrome 110+; TS target is
    // ES2017 with no polyfill — keep the spread+sort form (codex P2).
    // react-doctor-disable-next-line react-doctor/js-tosorted-immutable
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

  // Day-aligned gap-fill. "1W" renders exactly 7 UTC-day buckets (6 prior
  // full + today), "1M" renders 30, and "All" spans every day from the
  // pool's first snapshot to today. Missing daily snapshots — real in this
  // repo for sparse pools — surface as explicit $0 bars rather than
  // dropped points, so Plotly doesn't bridge a line across inactive days
  // and the headline total is the honest sum over the window.
  const visibleSeries = useMemo(() => {
    if (fullSeries.length === 0) return fullSeries;
    const todayStart =
      Math.floor(Date.now() / 1000 / SECONDS_PER_DAY) * SECONDS_PER_DAY;
    let earliest = todayStart;
    for (const pt of fullSeries) {
      const bucket =
        Math.floor(pt.timestamp / SECONDS_PER_DAY) * SECONDS_PER_DAY;
      if (bucket < earliest) earliest = bucket;
    }
    const windowStart =
      range === "7d"
        ? todayStart - 6 * SECONDS_PER_DAY
        : range === "30d"
          ? todayStart - 29 * SECONDS_PER_DAY
          : earliest;
    return zeroFillSeries(fullSeries, {
      from: windowStart,
      to: todayStart + SECONDS_PER_DAY,
      bucketSeconds: SECONDS_PER_DAY,
    });
  }, [fullSeries, range]);
  const shapes = useMemo(
    () => makeFxWeekendShapes(pool, network, visibleSeries),
    [pool, network, visibleSeries],
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
      shapes={shapes}
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

function makeFxWeekendShapes(
  pool: Pool,
  network: Network,
  series: TimeSeriesPoint[],
): Plotly.Layout["shapes"] {
  if (!isFpmm(pool) || !isFxPool(network, pool.token0, pool.token1)) return [];
  const first = series[0];
  const last = series[series.length - 1];
  if (!first || !last) return [];
  return fxWeekendBands({
    from: first.timestamp,
    to: last.timestamp + SECONDS_PER_DAY,
  });
}
