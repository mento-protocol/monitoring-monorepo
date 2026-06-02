"use client";

import { useMemo, useState } from "react";
import { formatUSD } from "@/lib/format";
import {
  canValueTvl,
  isFpmm,
  isFxPool,
  poolTvlUSD,
  type OracleRateMap,
} from "@/lib/tokens";
import type { Network } from "@/lib/networks";
import type { Pool, PoolSnapshot } from "@/lib/types";
import { TimeSeriesChartCard } from "@/components/time-series-chart-card";
import { forwardFillSeries } from "@/lib/chart-gap-fill";
import {
  SECONDS_PER_DAY,
  filterSeriesByRange,
  stockWoWChangePct,
  type RangeKey,
  type TimeSeriesPoint,
} from "@/lib/time-series";
import { fxWeekendBands } from "@/lib/weekend";

interface PoolTvlOverTimeChartProps {
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

/**
 * Historical TVL uses each snapshot's reserves with the pool's *current*
 * oracle price (same approximation buildDailySeries makes) — we don't
 * reconstruct historical oracle prices.
 */
export function PoolTvlOverTimeChart({
  pool,
  network,
  snapshots,
  isLoading,
  hasError,
  rates,
  historySupported = true,
}: PoolTvlOverTimeChartProps) {
  const [range, setRange] = useState<RangeKey>("all");

  const fullSeries = useMemo<TimeSeriesPoint[]>(() => {
    if (snapshots.length === 0) return [];
    // ES2023 `toSorted` requires Safari 16+/Chrome 110+; TS target is
    // ES2017 with no polyfill — keep the spread+sort form (codex P2).
    // react-doctor-disable-next-line react-doctor/js-tosorted-immutable
    const sorted = [...snapshots].sort(
      (a, b) => Number(a.timestamp) - Number(b.timestamp),
    );
    // Skip points where TVL is unknowable (untrusted decimals → null) so the
    // fill helper returns undefined before any trusted observation rather than
    // synthesizing $0. See `poolTvlUSD` in `lib/tokens.ts`.
    const points: TimeSeriesPoint[] = [];
    for (const snap of sorted) {
      const value = poolTvlUSD(
        { ...pool, reserves0: snap.reserves0, reserves1: snap.reserves1 },
        network,
        rates,
      );
      if (value !== null) {
        points.push({ timestamp: Number(snap.timestamp), value });
      }
    }
    const range = dailyRange(sorted);
    const filled: TimeSeriesPoint[] = [];
    for (const point of forwardFillSeries(points, range)) {
      if (point.value === undefined) continue;
      filled.push({
        timestamp: point.timestamp,
        value: point.value,
      });
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const currentTvl = poolTvlUSD(pool, network, rates);
    if (currentTvl !== null) {
      filled.push({ timestamp: nowSec, value: currentTvl });
    }
    return filled;
  }, [pool, network, snapshots, rates]);

  const visibleSeries = useMemo(
    () => filterSeriesByRange(fullSeries, range),
    [fullSeries, range],
  );
  const shapes = useMemo(
    () => makeFxWeekendShapes(pool, network, visibleSeries),
    [pool, network, visibleSeries],
  );

  const currentTvl = poolTvlUSD(pool, network, rates);
  const change7d = useMemo(() => stockWoWChangePct(fullSeries), [fullSeries]);
  const priceable = canValueTvl(pool, network, rates ?? new Map());

  // Distinguish "unpriceable" (no USDm leg and no rate for either leg) AND
  // "untrusted decimals" (currentTvl === null) from real zero TVL. Without
  // this, the chart silently renders $0.00 whenever rates haven't arrived
  // yet or the pair is unsupported or decimals aren't yet known.
  const headline = isLoading
    ? "…"
    : !priceable || currentTvl === null
      ? "—"
      : currentTvl === 0 && fullSeries.length === 0
        ? "—"
        : formatUSD(currentTvl);

  return (
    <TimeSeriesChartCard
      title="Pool TVL"
      rangeAriaLabel="Pool TVL chart time range"
      series={priceable ? visibleSeries : []}
      range={range}
      onRangeChange={setRange}
      headline={headline}
      change={priceable ? change7d : null}
      isLoading={isLoading}
      hasError={hasError}
      hasSnapshotError={false}
      shapes={shapes}
      emptyMessage={
        hasError
          ? "Unable to load TVL history"
          : !historySupported
            ? "History unavailable for this pool type"
            : !priceable
              ? "TVL unavailable for this pair"
              : "Not enough history yet"
      }
    />
  );
}

function dayBucket(timestamp: number): number {
  return Math.floor(timestamp / SECONDS_PER_DAY) * SECONDS_PER_DAY;
}

function currentDayBucket(): number {
  return dayBucket(Math.floor(Date.now() / 1000));
}

function dailyRange(snapshots: PoolSnapshot[]): {
  from: number;
  to: number;
  bucketSeconds: number;
} {
  const first = snapshots[0]!;
  const last = snapshots[snapshots.length - 1]!;
  const from = dayBucket(Number(first.timestamp));
  const lastSnapshotEnd = dayBucket(Number(last.timestamp)) + SECONDS_PER_DAY;
  const todayEnd = currentDayBucket() + SECONDS_PER_DAY;
  return {
    from,
    to: Math.max(lastSnapshotEnd, todayEnd),
    bucketSeconds: SECONDS_PER_DAY,
  };
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
  return fxWeekendBands({ from: first.timestamp, to: last.timestamp });
}
