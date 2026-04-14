"use client";

import { useEffect, useMemo, useState } from "react";
import type { OracleSnapshot, Pool } from "@/lib/types";
import {
  computeBinaryHealthWindow,
  normalizeWindowSnapshots,
} from "@/lib/pool-health-score";
import { useGQL } from "@/lib/graphql";
import {
  ORACLE_SNAPSHOT_PREDECESSOR,
  ORACLE_SNAPSHOTS_WINDOW,
} from "@/lib/queries";

const HEALTH_WINDOW_LIMIT = 1000;
/** Fetch one extra so we can detect truncation without a separate count query. */
const HEALTH_WINDOW_QUERY_LIMIT = HEALTH_WINDOW_LIMIT + 1;

export type Health24h = ReturnType<typeof computeBinaryHealthWindow>;

export type HealthScoreResult = {
  /** Rolling 24h window score (fraction 0..1) with observed-hours info. */
  health24h: Health24h;
  /** All-time fraction of healthy time (0..1) or null when never measured. */
  allTimeScore: number | null;
  /** Non-null when either SWR call rejected — the window is partial. */
  error: Error | null;
};

/** Virtual pools short-circuit to null scores — no oracle to measure against. */
export function useHealthScore(pool: Pool): HealthScoreResult {
  // Minute-aligned anchor for refetch-storm avoidance.
  const [windowAnchorMs, setWindowAnchorMs] = useState(
    () => Math.floor(Date.now() / 60_000) * 60_000,
  );
  useEffect(() => {
    const intervalId = setInterval(() => {
      setWindowAnchorMs(Math.floor(Date.now() / 60_000) * 60_000);
    }, 60_000);
    return () => clearInterval(intervalId);
  }, []);

  const windowEnd = Math.floor(windowAnchorMs / 1000);
  const windowStart = windowEnd - 24 * 3600;
  const shouldFetch = !pool.source?.includes("virtual");

  const { data: windowData, error: windowError } = useGQL<{
    OracleSnapshot: OracleSnapshot[];
  }>(
    shouldFetch ? ORACLE_SNAPSHOTS_WINDOW : null,
    {
      poolId: pool.id,
      from: String(windowStart),
      to: String(windowEnd),
      limit: HEALTH_WINDOW_QUERY_LIMIT,
    },
    60_000,
  );
  const { data: predecessorData, error: predecessorError } = useGQL<{
    OracleSnapshot: OracleSnapshot[];
  }>(
    shouldFetch ? ORACLE_SNAPSHOT_PREDECESSOR : null,
    { poolId: pool.id, before: String(windowStart) },
    60_000,
  );

  const { snapshotsAsc, truncated } = useMemo(() => {
    const raw = windowData?.OracleSnapshot ?? [];
    return normalizeWindowSnapshots(raw, HEALTH_WINDOW_LIMIT);
  }, [windowData]);
  const predecessor = predecessorData?.OracleSnapshot?.[0];
  const snapshots = useMemo(() => {
    // .sort() mutates; spread first to preserve memoized inputs.
    const out = predecessor
      ? [predecessor, ...snapshotsAsc]
      : [...snapshotsAsc];
    return out.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  }, [predecessor, snapshotsAsc]);

  // When truncated, narrow the scoring window to the earliest snapshot kept
  // so we don't count uncovered minutes as "healthy by default".
  const effectiveWindowStart = useMemo(() => {
    if (truncated && snapshotsAsc.length > 0) {
      return Math.max(windowStart, Number(snapshotsAsc[0]!.timestamp));
    }
    return windowStart;
  }, [snapshotsAsc, windowStart, truncated]);

  const health24h = useMemo(
    () =>
      computeBinaryHealthWindow(
        snapshots,
        pool,
        effectiveWindowStart,
        windowEnd,
      ),
    [snapshots, pool, windowEnd, effectiveWindowStart],
  );

  const allTimeScore =
    pool.hasHealthData === true && Number(pool.healthTotalSeconds ?? "0") > 0
      ? Number(pool.healthBinarySeconds ?? "0") /
        Number(pool.healthTotalSeconds ?? "1")
      : null;

  return {
    health24h,
    allTimeScore,
    error: windowError ?? predecessorError ?? null,
  };
}
