"use client";

import { useMemo } from "react";
import { useGQL } from "@/lib/graphql";
import {
  STABLES_DAILY_SNAPSHOTS,
  STABLES_LATEST_PER_TOKEN,
  STABLES_V2_CHANGES,
} from "@/lib/queries/stables";
import { rangeStartSeconds } from "./aggregate";
import type {
  RangeKey,
  StableSupplyDailySnapshot,
  V2StableSupplyChangeEvent,
} from "./types";

const CELO_CHAIN_ID = 42220;
// Hasura silently caps at 1000; we set explicit limits to be honest.
const SNAPSHOT_PAGE_LIMIT = 1000;
const CHANGES_PAGE_LIMIT = 200;
// Numeric.MAX cursor — `_lt: <this>` returns the first page.
const TS_CURSOR_INITIAL = "9999999999";

type DailySnapshotsResult = {
  StableSupplyDailySnapshot: ReadonlyArray<StableSupplyDailySnapshot>;
};
type LatestPerTokenResult = DailySnapshotsResult;
type V2ChangesResult = {
  V2StableSupplyChangeEvent: ReadonlyArray<V2StableSupplyChangeEvent>;
};

/**
 * Per-token latest supply snapshot (one row per token via distinct_on).
 * Powers the KPI strip "current outstanding" totals + sparkline grid
 * headlines. Lightweight (~16 rows).
 */
export function useStablesLatestPerToken(chainId: number = CELO_CHAIN_ID) {
  const { data, error, isLoading } = useGQL<LatestPerTokenResult>(
    STABLES_LATEST_PER_TOKEN,
    { chainId },
  );
  const snapshots = useMemo(
    () => data?.StableSupplyDailySnapshot ?? [],
    [data],
  );
  return { snapshots, error, isLoading };
}

/**
 * Daily snapshots over the requested range, single-page only for the v1
 * scope. The `1W` / `1M` ranges fit under the 1000-row cap; `All` is
 * deferred to a follow-up that adds keyset pagination via the
 * `beforeTimestamp` cursor below.
 */
export function useStablesDailySnapshots(
  range: RangeKey,
  chainId: number = CELO_CHAIN_ID,
) {
  const sinceSeconds = rangeStartSeconds(range);
  // STABLES_DAILY_SNAPSHOTS takes `beforeTimestamp` as an upper bound (we
  // page newest-first). For a bounded range query, we'd also need a lower
  // bound — for v1 we just fetch the most recent N rows and rely on
  // client-side filtering by the range cutoff.
  const { data, error, isLoading } = useGQL<DailySnapshotsResult>(
    STABLES_DAILY_SNAPSHOTS,
    {
      chainId,
      limit: SNAPSHOT_PAGE_LIMIT,
      beforeTimestamp: TS_CURSOR_INITIAL,
    },
  );
  const snapshots = useMemo(() => {
    const rows = data?.StableSupplyDailySnapshot ?? [];
    if (range === "all") return rows;
    return rows.filter((r) => Number(r.timestamp) >= sinceSeconds);
  }, [data, range, sinceSeconds]);
  return {
    snapshots,
    error,
    isLoading,
    // Flag downstream when the first page is full — the user might be seeing
    // a truncated history. PR2 v1 doesn't paginate; PR2.5 follow-up will.
    capped:
      (data?.StableSupplyDailySnapshot.length ?? 0) === SNAPSHOT_PAGE_LIMIT,
  };
}

/**
 * Per-tx V2 supply changes for the changes table + leaderboard. Filters
 * to the last 7d window (sufficient for the leaderboard; the table can
 * later add date-range pickers via the `sinceTimestamp` arg).
 */
export function useStablesV2Changes(
  range: RangeKey = "7d",
  page: number = 0,
  chainId: number = CELO_CHAIN_ID,
) {
  const sinceTimestamp = rangeStartSeconds(range);
  const { data, error, isLoading } = useGQL<V2ChangesResult>(
    STABLES_V2_CHANGES,
    {
      chainId,
      sinceTimestamp,
      limit: CHANGES_PAGE_LIMIT,
      offset: page * CHANGES_PAGE_LIMIT,
    },
  );
  const events = useMemo(() => data?.V2StableSupplyChangeEvent ?? [], [data]);
  return {
    events,
    error,
    isLoading,
    capped: events.length === CHANGES_PAGE_LIMIT,
  };
}
