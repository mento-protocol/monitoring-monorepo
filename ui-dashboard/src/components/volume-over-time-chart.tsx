"use client";

import { useMemo, useState } from "react";
import { chainColor } from "@/lib/chain-colors";
import { formatUSD } from "@/lib/format";
import {
  getSnapshotVolumeInUsd,
  snapshotWindow7d,
  snapshotWindow30d,
  type TimeRange,
} from "@/lib/volume";
import type { NetworkData } from "@/hooks/use-all-networks-data";
import type { Network } from "@/lib/networks";
import {
  TimeSeriesChartCard,
  type BreakdownSeries,
} from "@/components/time-series-chart-card";
import {
  SECONDS_PER_DAY,
  type RangeKey,
  type TimeSeriesPoint,
} from "@/lib/time-series";

type SeriesPoint = { timestamp: number; volumeUSD: number };

export type ChainVolumeSeries = {
  network: Network;
  series: SeriesPoint[];
};

/**
 * Includes swap volume from every pool type (FPMM and virtual), matching the
 * Summary tile's volume totals. Virtual pools also emit PoolDailySnapshot
 * rows with per-day swapVolume0/1, so excluding them would silently undercount
 * protocol volume and desync the chart from its Summary-tile counterpart.
 *
 * Input is the indexer's PoolDailySnapshot rollup (one row per pool per UTC
 * day). Each row's `timestamp` is the start of its UTC-day bucket and its
 * volume is the total for the full day.
 *
 * When `window` is provided only buckets whose timestamp falls strictly inside
 * the half-open window `[window.from, window.to)` are included. Because
 * `window.from` is an hour boundary (not midnight), the first UTC-day bucket
 * is included only when it starts at or after `window.from`, which means a
 * refresh at 10:00 UTC on day D shows the last 7 full days starting from day
 * D-7 (midnight). The chart's headline total therefore matches the exact
 * rolling-window period implied by the selected range tab.
 */
export function buildDailyVolumeSeries(
  networkData: NetworkData[],
  window?: TimeRange,
): { series: SeriesPoint[]; byChain: ChainVolumeSeries[] } {
  type PerChain = {
    network: Network;
    bucketTotals: Map<number, number>;
  };
  // Keyed by Network.id so distinct configured networks that share a chainId
  // (e.g. celo-mainnet vs celo-mainnet-local) stay separate in the breakdown.
  const perChain = new Map<string, PerChain>();
  const totalBuckets = new Map<number, number>();
  let minSnapshotBucket = Infinity;

  for (const netData of networkData) {
    // Only skip on top-level failure. `snapshotsAllDailyError` may be set
    // while `snapshotsAllDaily` still carries preserved recent rows (fail-open
    // path for mid-loop pagination failure) — use those rows, the caller
    // shows a partial-data badge separately.
    if (netData.error !== null) continue;
    const poolById = new Map(netData.pools.map((pool) => [pool.id, pool]));
    for (const snapshot of netData.snapshotsAllDaily) {
      const timestamp = Number(snapshot.timestamp);
      if (window) {
        if (timestamp < window.from || timestamp >= window.to) continue;
      }
      const pool = poolById.get(snapshot.poolId);
      const volume = getSnapshotVolumeInUsd(
        snapshot,
        pool,
        netData.network,
        netData.rates,
      );
      if (volume === null) continue;
      const bucket = Math.floor(timestamp / SECONDS_PER_DAY) * SECONDS_PER_DAY;
      minSnapshotBucket = Math.min(minSnapshotBucket, bucket);
      totalBuckets.set(bucket, (totalBuckets.get(bucket) ?? 0) + volume);
      let entry = perChain.get(netData.network.id);
      if (!entry) {
        entry = { network: netData.network, bucketTotals: new Map() };
        perChain.set(netData.network.id, entry);
      }
      entry.bucketTotals.set(
        bucket,
        (entry.bucketTotals.get(bucket) ?? 0) + volume,
      );
    }
  }

  if (!Number.isFinite(minSnapshotBucket)) return { series: [], byChain: [] };

  // Use ceil so the emission range starts at the first full UTC day that begins
  // at or after window.from — prevents a synthetic zero bar for any partial day
  // whose bucket starts before window.from but was excluded by the strict filter.
  const startBucket = window
    ? Math.ceil(window.from / SECONDS_PER_DAY) * SECONDS_PER_DAY
    : minSnapshotBucket;
  const endRef = window?.to ?? Math.floor(Date.now() / 1000);
  const endBucket = Math.floor(endRef / SECONDS_PER_DAY) * SECONDS_PER_DAY;
  // When window.to lands exactly on a UTC-day boundary the bucket at endBucket
  // starts at window.to and is excluded by the strict filter (timestamp >=
  // window.to), so we clamp the loop to avoid an empty bar there. When window.to
  // is mid-day (the production case from hourBucket(Date.now())) endRef >
  // endBucket and we emit today's bucket — PoolDailySnapshot is incremental, so
  // today's row contains only swaps seen so far today, which is valid in-window data.
  const lastBucket =
    endRef > endBucket ? endBucket : endBucket - SECONDS_PER_DAY;

  const series: SeriesPoint[] = [];
  const byChain: ChainVolumeSeries[] = Array.from(perChain.values()).map(
    (entry) => ({ network: entry.network, series: [] }),
  );
  for (
    let timestamp = startBucket;
    timestamp <= lastBucket;
    timestamp += SECONDS_PER_DAY
  ) {
    series.push({ timestamp, volumeUSD: totalBuckets.get(timestamp) ?? 0 });
    let i = 0;
    for (const entry of perChain.values()) {
      byChain[i].series.push({
        timestamp,
        volumeUSD: entry.bucketTotals.get(timestamp) ?? 0,
      });
      i++;
    }
  }
  return { series, byChain };
}

/**
 * Week-over-week % change: sum of the last 7 completed UTC days vs the 7 days
 * before that. The final bucket in `fullSeries` is usually the partial current
 * UTC day (still filling up), so the comparison excludes it and uses the
 * trailing [-8, -1] vs [-15, -8] windows. Returns null when history is too
 * short or the prior window was zero.
 */
export function weekOverWeekChangePct(
  series: TimeSeriesPoint[],
): number | null {
  if (series.length < 15) return null;
  const last7 = series.slice(-8, -1);
  const prior7 = series.slice(-15, -8);
  const sum = (arr: TimeSeriesPoint[]) =>
    arr.reduce((total, point) => total + point.value, 0);
  const prior = sum(prior7);
  if (prior <= 0) return null;
  return ((sum(last7) - prior) / prior) * 100;
}

interface VolumeOverTimeChartProps {
  networkData: NetworkData[];
  isLoading: boolean;
  hasError: boolean;
  hasSnapshotError: boolean;
}

export function VolumeOverTimeChart({
  networkData,
  isLoading,
  hasError,
  hasSnapshotError,
}: VolumeOverTimeChartProps) {
  const [range, setRange] = useState<RangeKey>("30d");

  // Full-history pass kept for the WoW delta (≥15 UTC-day buckets) and for
  // the "all" range tab.
  const fullResult = useMemo(
    () => buildDailyVolumeSeries(networkData),
    [networkData],
  );

  const fullSeries = useMemo<TimeSeriesPoint[]>(
    () =>
      fullResult.series.map((p) => ({
        timestamp: p.timestamp,
        value: p.volumeUSD,
      })),
    [fullResult],
  );

  const activeWindow = useMemo<TimeRange | undefined>(() => {
    if (range === "all") return undefined;
    const fetchWindows = networkData[0]?.snapshotWindows;
    return fetchWindows
      ? range === "7d"
        ? fetchWindows.w7d
        : fetchWindows.w30d
      : range === "7d"
        ? snapshotWindow7d(Date.now())
        : snapshotWindow30d(Date.now());
  }, [networkData, range]);

  // The "all" tab reuses `fullResult` since its window matches.
  const { visibleSeries, visibleBreakdown } = useMemo<{
    visibleSeries: TimeSeriesPoint[];
    visibleBreakdown: BreakdownSeries[];
  }>(() => {
    const { series, byChain } =
      range === "all"
        ? fullResult
        : buildDailyVolumeSeries(networkData, activeWindow);
    return {
      visibleSeries: series.map((p) => ({
        timestamp: p.timestamp,
        value: p.volumeUSD,
      })),
      visibleBreakdown: byChain.map((entry) => ({
        name: entry.network.label,
        color: chainColor(entry.network.chainId),
        series: entry.series.map((p) => ({
          timestamp: p.timestamp,
          value: p.volumeUSD,
        })),
      })),
    };
  }, [networkData, range, activeWindow, fullResult]);

  // Hero = sum of visible bars. With rolling-window bucketing on 7d/30d this
  // exactly equals the Summary tile's subtotal for the same window.
  const rangeTotal = useMemo(
    () => visibleSeries.reduce((sum, point) => sum + point.value, 0),
    [visibleSeries],
  );

  // Show "N/A" only on explicit failure. An empty series without errors
  // legitimately sums to $0 (no volume yet) — flagging that as N/A would
  // incorrectly conflate "no activity" with "data missing".
  const headline = isLoading
    ? "…"
    : hasError || (hasSnapshotError && fullSeries.length === 0)
      ? "N/A"
      : formatUSD(rangeTotal);

  const change = weekOverWeekChangePct(fullSeries);

  const emptyMessage = hasError
    ? "Unable to load volume history"
    : hasSnapshotError
      ? "Historical data partial — some chains failed to load"
      : "Not enough history yet";

  return (
    <TimeSeriesChartCard
      title="Volume"
      rangeAriaLabel="Volume chart time range"
      series={visibleSeries}
      breakdown={visibleBreakdown}
      breakdownMode="stacked"
      range={range}
      onRangeChange={setRange}
      headline={headline}
      change={change}
      isLoading={isLoading}
      hasError={hasError}
      hasSnapshotError={hasSnapshotError}
      emptyMessage={emptyMessage}
    />
  );
}
