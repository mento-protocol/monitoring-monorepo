"use client";

import { useMemo } from "react";
import { useGQL } from "@/lib/graphql";
import {
  STABLES_CURRENT_CUSTODY_PER_TOKEN,
  STABLES_CURRENT_SUPPLY_PER_TOKEN,
  STABLES_CUSTODY_DAILY_SNAPSHOTS,
  STABLES_DAILY_SNAPSHOTS,
  STABLES_LATEST_CUSTODY_PER_TOKEN,
  STABLES_LATEST_PER_TOKEN,
  STABLES_CHANGES,
} from "@/lib/queries/stables";
import { rangeStartSeconds } from "./aggregate";
import type {
  RangeKey,
  StableSupplyDailySnapshot,
  StableTokenCustodyDailySnapshot,
  StableSupplyChangeEvent,
} from "./types";

const STABLES_CHAIN_IDS = [42220, 143] as const;
// Hasura silently caps at 1000; we set explicit limits to be honest.
const SNAPSHOT_PAGE_LIMIT = 1000;
const CHANGES_PAGE_LIMIT = 200;
// Numeric.MAX cursor (~year 2286 in Unix-seconds); `_lt: <this>` returns
// the first page from the top of the desc-ordered snapshot table.
const TS_CURSOR_INITIAL = "9999999999";

type DailySnapshotsResult = {
  StableSupplyDailySnapshot: ReadonlyArray<StableSupplyDailySnapshot>;
};
type CurrentSupplyResult = {
  StableTokenSupply: ReadonlyArray<StableSupplyDailySnapshot>;
};
type LatestPerTokenResult = DailySnapshotsResult;
type CustodyDailySnapshotsResult = {
  StableTokenCustodyDailySnapshot: ReadonlyArray<StableTokenCustodyDailySnapshot>;
};
type CurrentCustodyResult = {
  StableTokenCustodyState: ReadonlyArray<StableTokenCustodyDailySnapshot>;
};
type LatestCustodyPerTokenResult = CustodyDailySnapshotsResult;
type ChangesResult = {
  StableSupplyChangeEvent: ReadonlyArray<StableSupplyChangeEvent>;
};

function tokenKey(row: {
  chainId: number;
  tokenAddress: string;
  source?: string;
}): string {
  return `${row.chainId}|${row.tokenAddress.toLowerCase()}|${row.source ?? ""}`;
}

function normalizeSupplyCurrentRows(
  rows: ReadonlyArray<StableSupplyDailySnapshot>,
): StableSupplyDailySnapshot[] {
  return rows.map((row) => ({
    ...row,
    id: `${row.chainId}-${row.tokenAddress.toLowerCase()}-${row.timestamp}`,
    tokenAddress: row.tokenAddress.toLowerCase(),
  }));
}

function normalizeCustodyCurrentRows(
  rows: ReadonlyArray<StableTokenCustodyDailySnapshot>,
): StableTokenCustodyDailySnapshot[] {
  return rows.map((row) => ({
    ...row,
    id: `${row.chainId}-${row.tokenAddress.toLowerCase()}-${row.timestamp}`,
    tokenAddress: row.tokenAddress.toLowerCase(),
    managerAddress: row.managerAddress.toLowerCase(),
  }));
}

function mergeCurrentRows<T extends { chainId: number; tokenAddress: string }>(
  current: ReadonlyArray<T>,
  fallback: ReadonlyArray<T>,
): T[] {
  const byToken = new Map<string, T>();
  for (const row of fallback) byToken.set(tokenKey(row), row);
  for (const row of current) byToken.set(tokenKey(row), row);
  return Array.from(byToken.values());
}

function firstFeedError(
  currentError: Error | null | undefined,
  fallbackError: Error | null | undefined,
): Error | null | undefined {
  // Consumers only use this as a degraded-state flag. If both feeds fail,
  // showing the current-state error is enough to avoid hiding the failure.
  return currentError ?? fallbackError;
}

/**
 * Per-token current supply rows. Transfer-tracked tokens use
 * StableTokenSupply state so current totals do not wait for sparse daily
 * snapshot rollover. Latest daily snapshots remain as fallback rows for Celo
 * V3_LIQUITY, which is derived from LiquityInstance.systemDebt.
 *
 * /stables is a global supply view, so it queries every chain that can carry
 * Mento stable supply instead of following the currently selected network.
 */
export function useStablesLatestPerToken() {
  const {
    data: currentData,
    error: currentError,
    isLoading: currentLoading,
  } = useGQL<CurrentSupplyResult>(STABLES_CURRENT_SUPPLY_PER_TOKEN, {
    chainIds: STABLES_CHAIN_IDS,
  });
  const {
    data: fallbackData,
    error: fallbackError,
    isLoading: fallbackLoading,
  } = useGQL<LatestPerTokenResult>(STABLES_LATEST_PER_TOKEN, {
    chainIds: STABLES_CHAIN_IDS,
  });
  const snapshots = useMemo(() => {
    const current = normalizeSupplyCurrentRows(
      currentData?.StableTokenSupply ?? [],
    );
    const fallback = fallbackData?.StableSupplyDailySnapshot ?? [];
    return mergeCurrentRows(current, fallback);
  }, [currentData, fallbackData]);
  return {
    snapshots,
    error: firstFeedError(currentError, fallbackError),
    isLoading: currentLoading || fallbackLoading,
  };
}

/**
 * Daily snapshots, single-page only for v1. Returns the FULL stream
 * (no client-side range filter) so downstream rollups can pick a
 * pre-window baseline — without one, `rollupByToken`'s 7d delta degrades
 * to "first available row" and `buildTokenUsdTimeSeries` drops tokens
 * whose only snapshot is older than the window. Range filtering happens
 * in the aggregate helpers, which scope output series to the window
 * while keeping the baseline reachable.
 *
 * `range` is accepted as a parameter to gate the `capped` warning: under
 * `7d` / `30d` the 1000-row page comfortably covers the current stable
 * token set. `all` may exceed and surface as `capped: true`; PR2.5 follow-up
 * adds keyset pagination via the `beforeTimestamp` cursor.
 */
export function useStablesDailySnapshots(_range: RangeKey) {
  // `_range` is accepted for API symmetry with `useStablesChanges` and
  // to make it a typed-call-site for future range-aware where-clause
  // filtering. The hook does NOT filter by range today (see header).
  void _range;
  const { data, error, isLoading } = useGQL<DailySnapshotsResult>(
    STABLES_DAILY_SNAPSHOTS,
    {
      chainIds: STABLES_CHAIN_IDS,
      limit: SNAPSHOT_PAGE_LIMIT,
      beforeTimestamp: TS_CURSOR_INITIAL,
    },
  );
  const snapshots = useMemo(
    () => data?.StableSupplyDailySnapshot ?? [],
    [data],
  );
  return {
    snapshots,
    error,
    isLoading,
    // Flag for the chart's truncation chip — the user might be seeing a
    // partial history if `All` range outruns the 1000-row page.
    capped: snapshots.length === SNAPSHOT_PAGE_LIMIT,
  };
}

export function useStablesLatestCustodyPerToken() {
  const {
    data: currentData,
    error: currentError,
    isLoading: currentLoading,
  } = useGQL<CurrentCustodyResult>(STABLES_CURRENT_CUSTODY_PER_TOKEN, {
    chainIds: STABLES_CHAIN_IDS,
  });
  const {
    data: fallbackData,
    error: fallbackError,
    isLoading: fallbackLoading,
  } = useGQL<LatestCustodyPerTokenResult>(STABLES_LATEST_CUSTODY_PER_TOKEN, {
    chainIds: STABLES_CHAIN_IDS,
  });
  const snapshots = useMemo(() => {
    const current = normalizeCustodyCurrentRows(
      currentData?.StableTokenCustodyState ?? [],
    );
    const fallback = fallbackData?.StableTokenCustodyDailySnapshot ?? [];
    return mergeCurrentRows(current, fallback);
  }, [currentData, fallbackData]);
  return {
    snapshots,
    error: firstFeedError(currentError, fallbackError),
    isLoading: currentLoading || fallbackLoading,
  };
}

export function useStablesCustodyDailySnapshots(_range: RangeKey) {
  void _range;
  const { data, error, isLoading } = useGQL<CustodyDailySnapshotsResult>(
    STABLES_CUSTODY_DAILY_SNAPSHOTS,
    {
      chainIds: STABLES_CHAIN_IDS,
      limit: SNAPSHOT_PAGE_LIMIT,
      beforeTimestamp: TS_CURSOR_INITIAL,
    },
  );
  const snapshots = useMemo(
    () => data?.StableTokenCustodyDailySnapshot ?? [],
    [data],
  );
  return {
    snapshots,
    error,
    isLoading,
    capped: snapshots.length === SNAPSHOT_PAGE_LIMIT,
  };
}

/**
 * Per-tx supply changes for the changes table + ranked table. Filters
 * to the last 7d window (sufficient for the ranked table; the table can
 * later add date-range pickers via the `sinceTimestamp` arg).
 */
export function useStablesChanges(range: RangeKey = "7d", page: number = 0) {
  const sinceTimestamp = rangeStartSeconds(range);
  const { data, error, isLoading } = useGQL<ChangesResult>(STABLES_CHANGES, {
    chainIds: STABLES_CHAIN_IDS,
    sinceTimestamp,
    limit: CHANGES_PAGE_LIMIT,
    offset: page * CHANGES_PAGE_LIMIT,
  });
  const events = useMemo(() => data?.StableSupplyChangeEvent ?? [], [data]);
  return {
    events,
    error,
    isLoading,
    capped: events.length === CHANGES_PAGE_LIMIT,
  };
}
