"use client";

import { useMemo, useState } from "react";
import { formatUSD } from "@/lib/format";
import { isFpmm, poolTvlUSD } from "@/lib/tokens";
import type { NetworkData } from "@/hooks/use-all-networks-data";
import type { Network } from "@/lib/networks";
import type { Pool, PoolSnapshotWindow } from "@/lib/types";
import type { OracleRateMap } from "@/lib/tokens";
import { TimeSeriesChartCard } from "@/components/time-series-chart-card";
import {
  SECONDS_PER_DAY,
  filterSeriesByRange,
  type RangeKey,
  type TimeSeriesPoint,
} from "@/lib/time-series";

const SECONDS_PER_HOUR = 3600;

type SeriesPoint = { timestamp: number; tvlUSD: number };

type PoolHistory = {
  pool: Pool;
  network: Network;
  rates: OracleRateMap;
  points: Array<{ ts: number; r0: string; r1: string }>;
};

/**
 * Builds a forward-filled TVL time series. `bucketSeconds` selects the
 * granularity — default is UTC-day (SECONDS_PER_DAY). The 1W range passes
 * SECONDS_PER_HOUR for an hour-level cursor; since the source data is now
 * the daily rollup, reserves step at day boundaries but the higher cadence
 * still produces a smoother line (and lets the hover tooltip show hour-level
 * timestamps).
 *
 * `fromTimestamp` clamps the emitted series to `[fromTimestamp, now]` —
 * callers that only need a recent window (e.g. 1W hourly = 168 buckets)
 * should pass this to avoid materializing buckets they'll immediately
 * discard. Forward-fill still works correctly: older snapshots are used to
 * seed each pool's cursor before the clamped window begins.
 */
export function buildDailySeries(
  networkData: NetworkData[],
  bucketSeconds: number = SECONDS_PER_DAY,
  fromTimestamp?: number,
): {
  series: SeriesPoint[];
  nowTvl: number;
} {
  const histories: PoolHistory[] = [];
  let earliestTs = Infinity;

  for (const netData of networkData) {
    // Only skip on top-level failure. `snapshotsAllDailyError` may be set
    // while `snapshotsAllDaily` still carries preserved recent rows
    // (fail-open path); forward-fill from what we have and let the caller
    // partial-badge.
    if (netData.error !== null) continue;
    const fpmmPools = netData.pools.filter(isFpmm);
    const snapsByPool = new Map<string, PoolSnapshotWindow[]>();
    for (const snap of netData.snapshotsAllDaily) {
      const list = snapsByPool.get(snap.poolId);
      if (list) list.push(snap);
      else snapsByPool.set(snap.poolId, [snap]);
    }
    for (const pool of fpmmPools) {
      const raw = snapsByPool.get(pool.id);
      if (!raw || raw.length === 0) continue;
      const points = raw
        .map((snapshot) => ({
          ts: Number(snapshot.timestamp),
          r0: snapshot.reserves0,
          r1: snapshot.reserves1,
        }))
        .sort((a, b) => a.ts - b.ts);
      earliestTs = Math.min(earliestTs, points[0].ts);
      histories.push({
        pool,
        network: netData.network,
        rates: netData.rates,
        points,
      });
    }
  }

  if (histories.length === 0) return { series: [], nowTvl: 0 };

  const nowSec = Math.floor(Date.now() / 1000);
  const dataStartBucket =
    Math.floor(earliestTs / bucketSeconds) * bucketSeconds;
  // When a window clamp is requested, start emission at the later of the
  // window's bucket and the earliest snapshot's bucket. Earlier iterations
  // are skipped entirely (not materialized), but the per-pool cursor fast-
  // forwards naturally on the first emitted iteration, so forward-fill
  // still uses the correct reserves from before the window start.
  const windowStartBucket =
    fromTimestamp !== undefined
      ? Math.max(
          dataStartBucket,
          Math.floor(fromTimestamp / bucketSeconds) * bucketSeconds,
        )
      : dataStartBucket;
  const endBucket = Math.floor(nowSec / bucketSeconds) * bucketSeconds;

  const cursors = new Array<number>(histories.length).fill(-1);
  const series: SeriesPoint[] = [];

  for (
    let timestamp = windowStartBucket;
    timestamp <= endBucket;
    timestamp += bucketSeconds
  ) {
    let tvl = 0;
    for (let i = 0; i < histories.length; i++) {
      const history = histories[i];
      while (
        cursors[i] + 1 < history.points.length &&
        history.points[cursors[i] + 1].ts < timestamp + bucketSeconds
      ) {
        cursors[i]++;
      }
      if (cursors[i] < 0) continue;
      const point = history.points[cursors[i]];
      tvl += poolTvlUSD(
        { ...history.pool, reserves0: point.r0, reserves1: point.r1 },
        history.network,
        history.rates,
      );
    }
    series.push({ timestamp, tvlUSD: tvl });
  }

  let nowTvl = 0;
  for (const history of histories) {
    nowTvl += poolTvlUSD(history.pool, history.network, history.rates);
  }

  return { series, nowTvl };
}

interface TvlOverTimeChartProps {
  networkData: NetworkData[];
  totalTvl: number;
  change7d: number | null;
  isLoading: boolean;
  hasError: boolean;
  hasSnapshotError: boolean;
}

export function TvlOverTimeChart({
  networkData,
  totalTvl,
  change7d,
  isLoading,
  hasError,
  hasSnapshotError,
}: TvlOverTimeChartProps) {
  const [range, setRange] = useState<RangeKey>("30d");

  // 1W range uses hour-level buckets for higher fidelity (168 points across
  // the week); 1M and All stay daily so the longer views don't get sluggish.
  const bucketSeconds = range === "7d" ? SECONDS_PER_HOUR : SECONDS_PER_DAY;

  const fullSeries = useMemo<TimeSeriesPoint[]>(() => {
    // 1W hourly only needs the last ~168 buckets — clamping the build
    // horizon avoids materializing full-history hourly buckets we'd
    // immediately discard. 1M/All keep the default (full history).
    const fromTimestamp =
      range === "7d"
        ? Math.floor(Date.now() / 1000) - 7 * SECONDS_PER_DAY
        : undefined;
    const { series: base, nowTvl } = buildDailySeries(
      networkData,
      bucketSeconds,
      fromTimestamp,
    );
    if (base.length === 0) return [];

    const nowSec = Math.floor(Date.now() / 1000);
    return [
      ...base.map((point) => ({
        timestamp: point.timestamp,
        value: point.tvlUSD,
      })),
      { timestamp: nowSec, value: nowTvl },
    ];
  }, [networkData, bucketSeconds, range]);

  // TVL is a stock — cutoff-based range filtering on UTC-day-stamped buckets
  // is fine: the headline shows current TVL (not a bar-sum), so no invariant
  // to preserve against a rolling-hour summary window.
  const visibleSeries = useMemo(
    () => filterSeriesByRange(fullSeries, range),
    [fullSeries, range],
  );

  const headline = isLoading ? "…" : formatUSD(totalTvl);
  const emptyMessage = hasError
    ? "Unable to load TVL history"
    : hasSnapshotError
      ? "Historical data partial — some chains failed to load"
      : "Not enough history yet";

  return (
    <TimeSeriesChartCard
      title="Total Value Locked"
      rangeAriaLabel="TVL chart time range"
      series={visibleSeries}
      range={range}
      onRangeChange={setRange}
      headline={headline}
      change={change7d}
      hoverDateFormat={
        bucketSeconds === SECONDS_PER_HOUR ? "%b %d, %H:00 UTC" : "%b %d, %Y"
      }
      isLoading={isLoading}
      hasError={hasError}
      hasSnapshotError={hasSnapshotError}
      emptyMessage={emptyMessage}
    />
  );
}
