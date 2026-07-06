"use client";

import { useMemo } from "react";
import { useGQL } from "@/lib/graphql";
import {
  POOL_DAILY_SNAPSHOTS_CHART,
  POOL_HOURLY_SNAPSHOTS_CHART,
} from "@/lib/queries";
import {
  SECONDS_PER_DAY,
  SECONDS_PER_HOUR,
  type RangeKey,
} from "@/lib/time-series";
import type { PoolSnapshot } from "@/lib/types";
import {
  SNAPSHOT_REFRESH_MS,
  snapshotWindow7d,
  snapshotWindow30d,
} from "@/lib/volume";

function hourlyWindowFrom(range: RangeKey): number | null {
  if (range === "7d") return snapshotWindow7d(Date.now()).from;
  if (range === "30d") return snapshotWindow30d(Date.now()).from;
  return null;
}

export function usePoolSnapshots(
  poolId: string,
  range: RangeKey,
  historySupported: boolean,
) {
  const hourlyFrom = useMemo(() => hourlyWindowFrom(range), [range]);
  const hourly = hourlyFrom !== null;
  const hourlyVars = useMemo(
    () => ({ poolId, from: hourlyFrom ?? 0 }),
    [poolId, hourlyFrom],
  );
  const dailyVars = useMemo(() => ({ poolId }), [poolId]);

  const { data, error, isLoading } = useGQL<{
    PoolSnapshot?: PoolSnapshot[];
    PoolDailySnapshot?: PoolSnapshot[];
  }>(
    historySupported
      ? hourly
        ? POOL_HOURLY_SNAPSHOTS_CHART
        : POOL_DAILY_SNAPSHOTS_CHART
      : null,
    hourly ? hourlyVars : dailyVars,
    SNAPSHOT_REFRESH_MS,
  );

  return {
    snapshots:
      (hourly ? data?.PoolSnapshot : data?.PoolDailySnapshot) ??
      ([] as PoolSnapshot[]),
    bucketSeconds: hourly ? SECONDS_PER_HOUR : SECONDS_PER_DAY,
    isLoading,
    hasError: error !== undefined,
  };
}
