"use client";

import { useMemo, useState } from "react";
import { formatUSD } from "@/lib/format";
import { canValueTvl, poolTvlUSD, type OracleRateMap } from "@/lib/tokens";
import type { Network } from "@/lib/networks";
import type { Pool, PoolSnapshot } from "@/lib/types";
import { TimeSeriesChartCard } from "@/components/time-series-chart-card";
import {
  filterSeriesByRange,
  stockWoWChangePct,
  type RangeKey,
  type TimeSeriesPoint,
} from "@/lib/time-series";

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
    // Skip points where TVL is unknowable (untrusted decimals → null) so
    // the historical line shows gaps for those windows rather than
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
    const nowSec = Math.floor(Date.now() / 1000);
    const currentTvl = poolTvlUSD(pool, network, rates);
    if (currentTvl !== null) {
      points.push({ timestamp: nowSec, value: currentTvl });
    }
    return points;
  }, [pool, network, snapshots, rates]);

  const visibleSeries = useMemo(
    () => filterSeriesByRange(fullSeries, range),
    [fullSeries, range],
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
