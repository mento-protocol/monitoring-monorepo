"use client";

import { useMemo, useState } from "react";
import { formatUSD } from "@/lib/format";
import { sortedCopy } from "@/lib/immutable-sort";
import { canValueTvl, poolTvlUSD, type OracleRateMap } from "@/lib/tokens";
import type { Network } from "@/lib/networks";
import type { Pool, PoolSnapshot } from "@/lib/types";
import { TimeSeriesChartCard } from "@/components/time-series-chart-card";
import { forwardFillSeries } from "@/lib/chart-gap-fill";
import {
  SECONDS_PER_HOUR,
  filterSeriesByRange,
  snapshotRange,
  stockWoWChangePct,
  type RangeKey,
  type TimeSeriesPoint,
} from "@/lib/time-series";
import { usePoolSnapshots } from "@/lib/use-pool-snapshots";
import { fxPoolWeekendBandsForSeries } from "@/lib/weekend";

interface PoolTvlOverTimeChartProps {
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

function buildTvlSeries({
  snapshots,
  bucketSeconds,
  pool,
  network,
  rates,
}: {
  snapshots: PoolSnapshot[];
  bucketSeconds: number;
  pool: Pool;
  network: Network;
  rates: OracleRateMap | undefined;
}): TimeSeriesPoint[] {
  if (snapshots.length === 0) return [];
  const sorted = sortedCopy(
    snapshots,
    (a, b) => Number(a.timestamp) - Number(b.timestamp),
  );
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

  const filled: TimeSeriesPoint[] = [];
  for (const point of forwardFillSeries(
    points,
    snapshotRange(sorted, bucketSeconds),
  )) {
    if (point.value === undefined) continue;
    filled.push({ timestamp: point.timestamp, value: point.value });
  }

  const currentTvl = poolTvlUSD(pool, network, rates);
  if (currentTvl !== null) {
    filled.push({
      timestamp: Math.floor(Date.now() / 1000),
      value: currentTvl,
    });
  }
  return filled;
}

function tvlHeadline({
  loading,
  priceable,
  currentTvl,
  hasHistory,
}: {
  loading: boolean;
  priceable: boolean;
  currentTvl: number | null;
  hasHistory: boolean;
}): string {
  if (loading) return "…";
  if (!priceable || currentTvl === null) return "—";
  if (currentTvl === 0 && !hasHistory) return "—";
  return formatUSD(currentTvl);
}

function tvlEmptyMessage(
  error: boolean,
  historySupported: boolean,
  priceable: boolean,
): string {
  if (error) return "Unable to load TVL history";
  if (!historySupported) return "History unavailable for this pool type";
  if (!priceable) return "TVL unavailable for this pair";
  return "Not enough history yet";
}

/**
 * Historical TVL uses each snapshot's reserves with the pool's *current*
 * oracle price (same approximation buildDailySeries makes) — we don't
 * reconstruct historical oracle prices.
 */
export function PoolTvlOverTimeChart({
  poolId,
  pool,
  network,
  isLoading,
  hasError,
  rates,
  historySupported = true,
}: PoolTvlOverTimeChartProps) {
  const [range, setRange] = useState<RangeKey>("all");
  const {
    snapshots,
    bucketSeconds,
    isLoading: snapshotsLoading,
    hasError: snapshotsError,
  } = usePoolSnapshots(poolId, range, historySupported);

  const fullSeries = useMemo<TimeSeriesPoint[]>(() => {
    // Skip points where TVL is unknowable (untrusted decimals → null) so the
    // fill helper returns undefined before any trusted observation rather than
    // synthesizing $0. See `poolTvlUSD` in `lib/tokens.ts`.
    return buildTvlSeries({ snapshots, bucketSeconds, pool, network, rates });
  }, [pool, network, snapshots, rates, bucketSeconds]);

  const visibleSeries = useMemo(
    () => filterSeriesByRange(fullSeries, range),
    [fullSeries, range],
  );
  const shapes = useMemo(
    () =>
      fxPoolWeekendBandsForSeries({
        pool,
        network,
        series: visibleSeries,
      }),
    [pool, network, visibleSeries],
  );

  const currentTvl = poolTvlUSD(pool, network, rates);
  const change7d = useMemo(() => stockWoWChangePct(fullSeries), [fullSeries]);
  const priceable = canValueTvl(pool, network, rates ?? new Map());
  const loading = isLoading || snapshotsLoading;
  const error = hasError || snapshotsError;
  const hoverDateFormat =
    bucketSeconds === SECONDS_PER_HOUR ? "%b %d, %H:00 UTC" : "%b %d, %Y";

  // Distinguish "unpriceable" (no USDm leg and no rate for either leg) AND
  // "untrusted decimals" (currentTvl === null) from real zero TVL. Without
  // this, the chart silently renders $0.00 whenever rates haven't arrived
  // yet or the pair is unsupported or decimals aren't yet known.
  const headline = tvlHeadline({
    loading,
    priceable,
    currentTvl,
    hasHistory: fullSeries.length > 0,
  });

  return (
    <TimeSeriesChartCard
      title="Pool TVL"
      rangeAriaLabel="Pool TVL chart time range"
      series={priceable ? visibleSeries : []}
      range={range}
      onRangeChange={setRange}
      headline={headline}
      change={priceable ? change7d : null}
      hoverDateFormat={hoverDateFormat}
      isLoading={loading}
      hasError={error}
      hasSnapshotError={false}
      shapes={shapes}
      emptyMessage={tvlEmptyMessage(error, historySupported, priceable)}
    />
  );
}
