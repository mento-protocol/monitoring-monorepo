"use client";

import { useMemo, useState } from "react";
import { formatUSD } from "@/lib/format";
import {
  getSnapshotVolumeInUsd,
  snapshotWindow7d,
  snapshotWindow30d,
} from "@/lib/volume";
import type { Network } from "@/lib/networks";
import { canPricePool, type OracleRateMap } from "@/lib/tokens";
import type { Pool, PoolSnapshot } from "@/lib/types";
import { TimeSeriesChartCard } from "@/components/time-series-chart-card";
import { zeroFillSeries } from "@/lib/chart-gap-fill";
import {
  SECONDS_PER_DAY,
  dailyBucket,
  type RangeKey,
  type TimeSeriesPoint,
} from "@/lib/time-series";
import { fxPoolWeekendBandsForSeries } from "@/lib/weekend";

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

  // Day-aligned gap-fill. 1W/1M use the same rolling-hour snapshot windows as
  // homepage volume, while "All" spans every day from the pool's first snapshot
  // to today. Missing daily snapshots — real in this repo for sparse pools —
  // surface as explicit $0 bars rather than dropped points, so Plotly doesn't
  // bridge a line across inactive days and the headline total is the honest sum
  // over the window.
  const visibleSeries = useMemo(() => {
    if (fullSeries.length === 0) return fullSeries;
    const nowMs = Date.now();
    const todayStart = dailyBucket(Math.floor(nowMs / 1000));
    let earliest = todayStart;
    for (const pt of fullSeries) {
      const bucket = dailyBucket(pt.timestamp);
      if (bucket < earliest) earliest = bucket;
    }
    const window =
      range === "7d"
        ? snapshotWindow7d(nowMs)
        : range === "30d"
          ? snapshotWindow30d(nowMs)
          : { from: earliest, to: todayStart + SECONDS_PER_DAY };
    return zeroFillSeries(fullSeries, {
      from: window.from,
      to: window.to,
      bucketSeconds: SECONDS_PER_DAY,
    });
  }, [fullSeries, range]);
  const shapes = useMemo(
    () =>
      fxPoolWeekendBandsForSeries({
        pool,
        network,
        series: visibleSeries,
        endPaddingSeconds: SECONDS_PER_DAY,
      }),
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
