"use client";

import { useMemo, useState } from "react";
import { formatUSD } from "@/lib/format";
import { canPricePool, poolTvlUSD, type OracleRateMap } from "@/lib/tokens";
import type { Network } from "@/lib/networks";
import type { Pool, PoolSnapshot } from "@/lib/types";
import { TimeSeriesChartCard } from "@/components/time-series-chart-card";
import {
  SECONDS_PER_DAY,
  filterSeriesByRange,
  type RangeKey,
  type TimeSeriesPoint,
} from "@/lib/time-series";

// TVL is a stock, not a flow — compare current value to the value 7 days
// ago (point-to-point), not a sum over two 7-day windows like volume.
function tvlWoWChangePct(series: TimeSeriesPoint[]): number | null {
  if (series.length < 2) return null;
  const now = series[series.length - 1];
  const cutoff = now.timestamp - 7 * SECONDS_PER_DAY;
  let ago: TimeSeriesPoint | null = null;
  for (let i = series.length - 2; i >= 0; i--) {
    if (series[i].timestamp <= cutoff) {
      ago = series[i];
      break;
    }
  }
  if (!ago || ago.value <= 0) return null;
  return ((now.value - ago.value) / ago.value) * 100;
}

interface PoolTvlOverTimeChartProps {
  pool: Pool;
  network: Network;
  snapshots: PoolSnapshot[];
  isLoading: boolean;
  hasError: boolean;
  rates?: OracleRateMap;
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
}: PoolTvlOverTimeChartProps) {
  const [range, setRange] = useState<RangeKey>("all");

  const fullSeries = useMemo<TimeSeriesPoint[]>(() => {
    if (snapshots.length === 0) return [];
    const sorted = [...snapshots].sort(
      (a, b) => Number(a.timestamp) - Number(b.timestamp),
    );
    const points: TimeSeriesPoint[] = sorted.map((snap) => ({
      timestamp: Number(snap.timestamp),
      value: poolTvlUSD(
        { ...pool, reserves0: snap.reserves0, reserves1: snap.reserves1 },
        network,
        rates,
      ),
    }));
    const nowSec = Math.floor(Date.now() / 1000);
    const currentTvl = poolTvlUSD(pool, network, rates);
    return [...points, { timestamp: nowSec, value: currentTvl }];
  }, [pool, network, snapshots, rates]);

  const visibleSeries = useMemo(
    () => filterSeriesByRange(fullSeries, range),
    [fullSeries, range],
  );

  const currentTvl = poolTvlUSD(pool, network, rates);
  const change7d = useMemo(() => tvlWoWChangePct(fullSeries), [fullSeries]);
  const priceable = canPricePool(pool, network, rates ?? new Map());

  // Distinguish "unpriceable" (no USDm leg and no rate for either leg) from
  // real zero TVL. Without this, the chart silently renders $0.00 whenever
  // rates haven't arrived yet or the pair is unsupported.
  const headline = isLoading
    ? "…"
    : !priceable
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
      emptyMessage={
        hasError
          ? "Unable to load TVL history"
          : !priceable
            ? "TVL unavailable for this pair"
            : "Not enough history yet"
      }
    />
  );
}
