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

export type PoolSnapshotsMode = "flow" | "stock";

function currentHourBucketMs(): number {
  const hourMs = SECONDS_PER_HOUR * 1000;
  return Math.floor(Date.now() / hourMs) * hourMs;
}

function hourlyWindowFrom(range: RangeKey, nowMs: number): number | null {
  if (range === "7d") return snapshotWindow7d(nowMs).from;
  if (range === "30d") return snapshotWindow30d(nowMs).from;
  return null;
}

function snapshotsAreLoading({
  snapshots,
  hourly,
  useHourlySnapshots,
  hourlyLoading,
  dailyLoading,
}: {
  snapshots: PoolSnapshot[];
  hourly: boolean;
  useHourlySnapshots: boolean;
  hourlyLoading: boolean;
  dailyLoading: boolean;
}) {
  if (snapshots.length > 0) return false;
  if (hourly && !useHourlySnapshots) return hourlyLoading || dailyLoading;
  return dailyLoading;
}

function snapshotsHaveError({
  snapshots,
  dailyError,
}: {
  snapshots: PoolSnapshot[];
  dailyError: boolean;
}) {
  if (snapshots.length > 0) return false;
  return dailyError;
}

function latestSnapshotBefore(
  snapshots: readonly PoolSnapshot[],
  timestamp: number,
): PoolSnapshot | null {
  let latest: PoolSnapshot | null = null;
  let latestTimestamp = -Infinity;
  for (const snapshot of snapshots) {
    const snapshotTimestamp = Number(snapshot.timestamp);
    if (!Number.isFinite(snapshotTimestamp) || snapshotTimestamp >= timestamp) {
      continue;
    }
    if (snapshotTimestamp > latestTimestamp) {
      latest = snapshot;
      latestTimestamp = snapshotTimestamp;
    }
  }
  return latest;
}

function stockSnapshotsWithDailyBaseline({
  hourlySnapshots,
  dailySnapshots,
  hourlyFrom,
}: {
  hourlySnapshots: PoolSnapshot[];
  dailySnapshots: readonly PoolSnapshot[];
  hourlyFrom: number | null;
}): PoolSnapshot[] {
  if (hourlySnapshots.length === 0 || hourlyFrom === null) {
    return hourlySnapshots;
  }
  const baseline = latestSnapshotBefore(dailySnapshots, hourlyFrom);
  if (baseline === null) return hourlySnapshots;
  return [baseline, ...hourlySnapshots];
}

export function usePoolSnapshots(
  poolId: string,
  range: RangeKey,
  historySupported: boolean,
  mode: PoolSnapshotsMode = "flow",
) {
  const hourlyAnchorMs = currentHourBucketMs();
  const hourlyFrom = useMemo(
    () => hourlyWindowFrom(range, hourlyAnchorMs),
    [range, hourlyAnchorMs],
  );
  const hourly = hourlyFrom !== null;
  const hourlyVars = useMemo(
    () => ({ poolId, from: hourlyFrom ?? 0 }),
    [poolId, hourlyFrom],
  );
  const dailyVars = useMemo(() => ({ poolId }), [poolId]);

  const hourlyResult = useGQL<{ PoolSnapshot?: PoolSnapshot[] }>(
    historySupported && hourly ? POOL_HOURLY_SNAPSHOTS_CHART : null,
    hourlyVars,
    SNAPSHOT_REFRESH_MS,
  );
  const dailyResult = useGQL<{ PoolDailySnapshot?: PoolSnapshot[] }>(
    historySupported ? POOL_DAILY_SNAPSHOTS_CHART : null,
    dailyVars,
    SNAPSHOT_REFRESH_MS,
  );

  const hourlySnapshots = hourlyResult.data?.PoolSnapshot ?? [];
  const dailySnapshots = dailyResult.data?.PoolDailySnapshot ?? [];
  const useHourlySnapshots = hourly && hourlySnapshots.length > 0;
  const hourlySnapshotsForMode = useMemo(
    () =>
      mode === "stock"
        ? stockSnapshotsWithDailyBaseline({
            hourlySnapshots,
            dailySnapshots,
            hourlyFrom,
          })
        : hourlySnapshots,
    [dailySnapshots, hourlyFrom, hourlySnapshots, mode],
  );
  const snapshots = useHourlySnapshots
    ? hourlySnapshotsForMode
    : dailySnapshots;

  return {
    snapshots,
    bucketSeconds: useHourlySnapshots ? SECONDS_PER_HOUR : SECONDS_PER_DAY,
    isLoading: snapshotsAreLoading({
      snapshots,
      hourly,
      useHourlySnapshots,
      hourlyLoading: hourlyResult.isLoading,
      dailyLoading: dailyResult.isLoading,
    }),
    hasError: snapshotsHaveError({
      snapshots,
      dailyError: dailyResult.error !== undefined,
    }),
  };
}
