"use client";

import { useMemo, useState } from "react";
import { chainColor } from "@/lib/chain-colors";
import { formatUSD } from "@/lib/format";
import { isFpmm, poolTvlUSD } from "@/lib/tokens";
import type { NetworkData } from "@/hooks/use-all-networks-data";
import type { Network } from "@/lib/networks";
import type { Pool, PoolSnapshotWindow } from "@/lib/types";
import type { OracleRateMap } from "@/lib/tokens";
import {
  TimeSeriesChartCard,
  type BreakdownSeries,
} from "@/components/time-series-chart-card";
import { forwardFillSeries } from "@/lib/chart-gap-fill";
import {
  SECONDS_PER_DAY,
  filterSeriesByRange,
  type RangeKey,
  type TimeSeriesPoint,
} from "@/lib/time-series";

type SeriesPoint = { timestamp: number; tvlUSD: number };

type PoolHistory = {
  pool: Pool;
  network: Network;
  rates: OracleRateMap;
  points: Array<{ ts: number; r0: string; r1: string }>;
};

type CurrentPool = {
  pool: Pool;
  network: Network;
  rates: OracleRateMap;
};

type TvlInputs = {
  histories: PoolHistory[];
  currentPools: CurrentPool[];
  chainsSeen: Network[];
  earliestTs: number;
};

type HistoricalSeries = {
  series: SeriesPoint[];
  perChainSeries: Map<string, SeriesPoint[]>;
};

type HistoricalSeriesInput = {
  histories: PoolHistory[];
  chainsSeen: Network[];
  bucketSeconds: number;
  windowStartBucket: number;
  endBucket: number;
};

type TvlBucket = {
  tvl: number;
  anyContributed: boolean;
  perChainTvl: Map<string, number>;
};

type BucketAccumulationInput = {
  history: PoolHistory;
  buckets: Map<number, TvlBucket>;
  firstChainBucket: Map<string, number>;
  bucketSeconds: number;
  windowStartBucket: number;
  endBucket: number;
};

export type ChainTvlSeries = {
  network: Network;
  series: SeriesPoint[];
  nowTvl: number;
};

/**
 * Builds a forward-filled TVL time series. `bucketSeconds` selects the
 * granularity — default is UTC-day (SECONDS_PER_DAY). The 1W range passes
 * SECONDS_PER_HOUR for more cursor steps (useful for tooltip granularity);
 * since the source is the daily rollup, reserves only step at day boundaries
 * regardless of bucket size.
 *
 * `fromTimestamp` clamps the emitted series to `[fromTimestamp, now]` —
 * callers that only need a recent window (e.g. 1W hourly = 168 buckets)
 * should pass this to avoid materializing buckets they'll immediately
 * discard. Forward-fill still works correctly: older snapshots are used to
 * seed each pool's cursor before the clamped window begins.
 *
 * Per-chain `byChain` is keyed by `Network.id` (not `chainId`) so distinct
 * configured networks that share a chainId — e.g. `celo-mainnet` +
 * `celo-mainnet-local` when local networks are toggled on — stay separate
 * in the breakdown rather than silently collapsing.
 */
export function buildDailySeries(
  networkData: NetworkData[],
  bucketSeconds: number = SECONDS_PER_DAY,
  fromTimestamp?: number,
): {
  series: SeriesPoint[];
  nowTvl: number;
  byChain: ChainTvlSeries[];
} {
  const { histories, currentPools, chainsSeen, earliestTs } =
    collectTvlInputs(networkData);
  const { nowTvl, perChainNowTvl } = computeCurrentTvl(currentPools);
  if (histories.length === 0) {
    return {
      series: [],
      nowTvl,
      byChain: chainsSeen.map((network) => ({
        network,
        series: [],
        nowTvl: perChainNowTvl.get(network.id) ?? 0,
      })),
    };
  }

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
  const { series, perChainSeries } = buildHistoricalSeries({
    histories,
    chainsSeen,
    bucketSeconds,
    windowStartBucket,
    endBucket,
  });

  const byChain: ChainTvlSeries[] = chainsSeen.map((network) => ({
    network,
    series: perChainSeries.get(network.id)!,
    nowTvl: perChainNowTvl.get(network.id) ?? 0,
  }));

  return { series, nowTvl, byChain };
}

function collectTvlInputs(networkData: NetworkData[]): TvlInputs {
  const histories: PoolHistory[] = [];
  const currentPools: CurrentPool[] = [];
  const chainsSeen: Network[] = [];
  const chainsSeenIds = new Set<string>();
  let earliestTs = Infinity;

  function rememberChain(network: Network): void {
    if (!chainsSeenIds.has(network.id)) {
      chainsSeenIds.add(network.id);
      chainsSeen.push(network);
    }
  }

  for (const netData of networkData) {
    // Only skip on top-level failure. `snapshotsAllDailyError` may be set
    // while `snapshotsAllDaily` still carries preserved recent rows
    // (fail-open path); forward-fill from what we have and let the caller
    // partial-badge.
    if (netData.error !== null) continue;
    const fpmmPools = netData.pools.filter(isFpmm);
    for (const pool of fpmmPools) {
      rememberChain(netData.network);
      currentPools.push({
        pool,
        network: netData.network,
        rates: netData.rates,
      });
    }
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
      earliestTs = Math.min(earliestTs, points[0]!.ts);
      histories.push({
        pool,
        network: netData.network,
        rates: netData.rates,
        points,
      });
    }
  }

  return {
    histories,
    currentPools,
    chainsSeen,
    earliestTs,
  };
}

function buildHistoricalSeries({
  histories,
  chainsSeen,
  bucketSeconds,
  windowStartBucket,
  endBucket,
}: HistoricalSeriesInput): HistoricalSeries {
  const buckets = new Map<number, TvlBucket>();
  const bucketTimestamps: number[] = [];
  for (
    let timestamp = windowStartBucket;
    timestamp <= endBucket;
    timestamp += bucketSeconds
  ) {
    bucketTimestamps.push(timestamp);
  }
  const firstChainBucket = new Map<string, number>();

  // Fill each pool independently before summing buckets. A pool whose first
  // snapshot starts later contributes `undefined` before that point rather
  // than a synthetic zero TVL, while already-observed pools continue forward.
  for (const history of histories) {
    accumulatePoolHistory({
      history,
      buckets,
      firstChainBucket,
      bucketSeconds,
      windowStartBucket,
      endBucket,
    });
  }

  const series: SeriesPoint[] = [];
  const perChainSeries = new Map<string, SeriesPoint[]>();
  for (const c of chainsSeen) perChainSeries.set(c.id, []);

  for (const timestamp of bucketTimestamps) {
    const bucket = buckets.get(timestamp) ?? {
      tvl: 0,
      anyContributed: false,
      perChainTvl: new Map<string, number>(),
    };
    appendAggregateBucket(series, bucket, timestamp);
    appendPerChainBucket(
      perChainSeries,
      chainsSeen,
      firstChainBucket,
      bucket.perChainTvl,
      timestamp,
    );
  }
  return { series, perChainSeries };
}

function accumulatePoolHistory({
  history,
  buckets,
  firstChainBucket,
  bucketSeconds,
  windowStartBucket,
  endBucket,
}: BucketAccumulationInput): void {
  const points: TimeSeriesPoint[] = [];
  for (const point of history.points) {
    const poolTvl = poolTvlUSD(
      { ...history.pool, reserves0: point.r0, reserves1: point.r1 },
      history.network,
      history.rates,
    );
    // Skip pools whose TVL is unknowable (untrusted decimals → null). Summing
    // null as 0 would understate aggregate / per-chain TVL.
    if (poolTvl === null) continue;
    points.push({ timestamp: point.ts, value: poolTvl });
  }

  const filled = forwardFillSeries(points, {
    from: windowStartBucket,
    to: endBucket + bucketSeconds,
    bucketSeconds,
  });
  for (const point of filled) {
    if (point.value === undefined) continue;
    const bucket = getOrCreateTvlBucket(buckets, point.timestamp);
    bucket.tvl += point.value;
    bucket.anyContributed = true;
    const id = history.network.id;
    rememberFirstChainBucket(firstChainBucket, id, point.timestamp);
    bucket.perChainTvl.set(id, (bucket.perChainTvl.get(id) ?? 0) + point.value);
  }
}

function rememberFirstChainBucket(
  firstChainBucket: Map<string, number>,
  chainId: string,
  timestamp: number,
): void {
  const previous = firstChainBucket.get(chainId);
  if (previous === undefined || timestamp < previous) {
    firstChainBucket.set(chainId, timestamp);
  }
}

function getOrCreateTvlBucket(
  buckets: Map<number, TvlBucket>,
  timestamp: number,
): TvlBucket {
  let bucket = buckets.get(timestamp);
  if (!bucket) {
    bucket = { tvl: 0, anyContributed: false, perChainTvl: new Map() };
    buckets.set(timestamp, bucket);
  }
  return bucket;
}

function appendAggregateBucket(
  series: SeriesPoint[],
  bucket: { tvl: number; anyContributed: boolean },
  timestamp: number,
): void {
  // Aggregate: skip the bucket entirely when no pool contributed.
  // Emitting `tvlUSD: 0` would render as "$0 TVL" in the historical
  // line, presenting unknown data as a real zero (codex P2 PR #372).
  if (bucket.anyContributed) {
    series.push({ timestamp, tvlUSD: bucket.tvl });
  }
}

function appendPerChainBucket(
  perChainSeries: Map<string, SeriesPoint[]>,
  chainsSeen: Network[],
  firstChainBucket: Map<string, number>,
  perChainTvl: Map<string, number>,
  timestamp: number,
): void {
  // Per-chain breakdown emits 0 after a chain's first observed bucket when it
  // does not contribute on a later bucket, but it does not invent pre-history
  // zeroes before that chain had any observed TVL.
  for (const c of chainsSeen) {
    const firstObserved = firstChainBucket.get(c.id);
    if (firstObserved === undefined || timestamp < firstObserved) continue;
    perChainSeries.get(c.id)!.push({
      timestamp,
      tvlUSD: perChainTvl.get(c.id) ?? 0,
    });
  }
}

function computeCurrentTvl(currentPools: CurrentPool[]): {
  nowTvl: number;
  perChainNowTvl: Map<string, number>;
} {
  let nowTvl = 0;
  const perChainNowTvl = new Map<string, number>();
  for (const current of currentPools) {
    const poolTvl = poolTvlUSD(current.pool, current.network, current.rates);
    if (poolTvl === null) continue;
    nowTvl += poolTvl;
    const id = current.network.id;
    perChainNowTvl.set(id, (perChainNowTvl.get(id) ?? 0) + poolTvl);
  }
  return { nowTvl, perChainNowTvl };
}

interface TvlOverTimeChartProps {
  networkData: NetworkData[];
  totalTvl: number;
  /**
   * Trust-state of `totalTvl`:
   * - `null` — no priceable pools contributed (render headline as "—")
   * - `false` — every priceable pool returned a value (render USD total)
   * - `true` — at least one pool's TVL was unknowable (render USD total
   *   with a "(partial)" qualifier so the user can see the sum is provisional)
   */
  tvlPartial: boolean | null;
  change7d: number | null;
  isLoading: boolean;
  hasError: boolean;
  hasSnapshotError: boolean;
}

export function TvlOverTimeChart({
  networkData,
  totalTvl,
  tvlPartial,
  change7d,
  isLoading,
  hasError,
  hasSnapshotError,
}: TvlOverTimeChartProps) {
  const [range, setRange] = useState<RangeKey>("30d");

  const { fullSeries, fullBreakdown } = useMemo<{
    fullSeries: TimeSeriesPoint[];
    fullBreakdown: BreakdownSeries[];
  }>(() => {
    // Always use UTC-day buckets. PoolDailySnapshot is a running aggregate
    // updated throughout the day — forward-filling a midnight-stamped row into
    // hourly sub-buckets would show today's current reserves for all past hours
    // of the same day, distorting the intra-day trend.
    const { series: base, nowTvl, byChain } = buildDailySeries(networkData);
    if (base.length === 0 && nowTvl === 0) {
      return { fullSeries: [], fullBreakdown: [] };
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const total = [
      ...base.map((point) => ({
        timestamp: point.timestamp,
        value: point.tvlUSD,
      })),
      { timestamp: nowSec, value: nowTvl },
    ];

    const breakdown: BreakdownSeries[] = byChain.map((entry) => ({
      name: entry.network.label,
      color: chainColor(entry.network.chainId),
      series: [
        ...entry.series.map((p) => ({
          timestamp: p.timestamp,
          value: p.tvlUSD,
        })),
        { timestamp: nowSec, value: entry.nowTvl },
      ],
    }));

    return { fullSeries: total, fullBreakdown: breakdown };
  }, [networkData]);

  // TVL is a stock — cutoff-based range filtering on UTC-day-stamped buckets
  // is fine: the headline shows current TVL (not a bar-sum), so no invariant
  // to preserve against a rolling-hour summary window.
  const visibleSeries = useMemo(
    () => filterSeriesByRange(fullSeries, range),
    [fullSeries, range],
  );
  const visibleBreakdown = useMemo<BreakdownSeries[]>(
    () =>
      fullBreakdown.map((b) => ({
        ...b,
        series: filterSeriesByRange(b.series, range),
      })),
    [fullBreakdown, range],
  );

  const headline = isLoading
    ? "…"
    : tvlPartial === null
      ? "—"
      : tvlPartial
        ? `${formatUSD(totalTvl)} (partial)`
        : formatUSD(totalTvl);
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
      breakdown={visibleBreakdown}
      range={range}
      onRangeChange={setRange}
      headline={headline}
      change={change7d}
      hoverDateFormat="%b %d, %Y"
      isLoading={isLoading}
      hasError={hasError}
      hasSnapshotError={hasSnapshotError}
      emptyMessage={emptyMessage}
    />
  );
}
