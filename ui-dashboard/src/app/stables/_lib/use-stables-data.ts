"use client";

import { useMemo } from "react";
import { useGQL } from "@/lib/graphql";
import type { OracleRateMap } from "@/lib/tokens";
import {
  STABLES_CURRENT_CUSTODY_PER_TOKEN,
  STABLES_CURRENT_SUPPLY_PER_TOKEN,
  STABLES_CUSTODY_DAILY_SNAPSHOTS,
  STABLES_DAILY_SNAPSHOTS,
  STABLES_LATEST_CUSTODY_PER_TOKEN,
  STABLES_LATEST_PER_TOKEN,
  STABLES_CHANGES,
} from "@/lib/queries/stables";
import {
  DEFAULT_SUPPLY_CHANGE_MIN_USD,
  isVisibleSupplyChangeEvent,
  rangeStartSeconds,
  supplyChangeUsdValue,
} from "./aggregate";
import type {
  RangeKey,
  StableSupplyDailySnapshot,
  StableTokenCustodyDailySnapshot,
  StableSupplyChangeEvent,
} from "./types";

const STABLES_CHAIN_IDS = [42220, 143] as const;
// Hasura silently caps at 1000; we set explicit limits to be honest.
const SNAPSHOT_PAGE_LIMIT = 1000;
const CHANGES_QUERY_PAGE_LIMIT = 400;
const CHANGES_DISPLAY_LIMIT = 200;
const CHANGES_MAX_QUERY_PAGES = 3;
const EMPTY_ORACLE_RATES: OracleRateMap = new Map();
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
type ChangePageState = {
  enabled: boolean;
  rawEvents: ReadonlyArray<StableSupplyChangeEvent>;
  visibleEvents: ReadonlyArray<StableSupplyChangeEvent>;
  unpricedVisibleEventIds: ReadonlySet<string>;
  error: unknown;
  isLoading: boolean;
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
    isCurrentState: true,
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

export function mergedFeedError<T>(
  mergedRows: ReadonlyArray<T>,
  currentError: Error | null | undefined,
  fallbackError: Error | null | undefined,
): Error | null | undefined {
  if (fallbackError != null) return fallbackError;
  if (mergedRows.length > 0) return null;
  // Once both feeds produce no usable rows, surfacing the current-state error
  // is enough to avoid hiding the failure while still preserving fallback rows
  // during current-state rollout or schema drift.
  return currentError;
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
    error: mergedFeedError(snapshots, currentError, fallbackError),
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
    error: mergedFeedError(snapshots, currentError, fallbackError),
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
 * later add date-range pickers via the `sinceTimestamp` arg), then hides
 * rows below the user-selected USD-equivalent value threshold. Unpriced
 * rows degrade open and remain visible because missing oracle data must
 * not silently suppress supply events.
 *
 * A single raw page can be dust-heavy, so the hook conditionally fetches
 * additional raw pages until it has enough visible rows, exhausts the current
 * window, or reaches the bounded query budget above.
 */
export function useStablesChanges(
  range: RangeKey = "7d",
  page: number = 0,
  rates: OracleRateMap = EMPTY_ORACLE_RATES,
  minimumUsdValue: number = DEFAULT_SUPPLY_CHANGE_MIN_USD,
) {
  const sinceTimestamp = rangeStartSeconds(range);
  const baseOffset = page * CHANGES_QUERY_PAGE_LIMIT * CHANGES_MAX_QUERY_PAGES;
  const firstPage = useStablesChangesPage(
    sinceTimestamp,
    baseOffset,
    true,
    rates,
    minimumUsdValue,
  );
  const shouldFetchSecondPage = shouldFetchNextChangePage(
    firstPage,
    firstPage.visibleEvents.length,
  );
  const secondPage = useStablesChangesPage(
    sinceTimestamp,
    baseOffset + CHANGES_QUERY_PAGE_LIMIT,
    shouldFetchSecondPage,
    rates,
    minimumUsdValue,
  );
  const visibleEventsAfterSecond =
    firstPage.visibleEvents.length + secondPage.visibleEvents.length;
  const shouldFetchThirdPage = shouldFetchNextChangePage(
    secondPage,
    visibleEventsAfterSecond,
  );
  const thirdPage = useStablesChangesPage(
    sinceTimestamp,
    baseOffset + CHANGES_QUERY_PAGE_LIMIT * 2,
    shouldFetchThirdPage,
    rates,
    minimumUsdValue,
  );
  const pages = [firstPage, secondPage, thirdPage] as const;
  const pageError = firstEnabledPageError(pages);
  const { events, capped, unpricedEventsCount } = buildVisibleChangesResult(
    pages,
    pageError,
  );
  return {
    events,
    error: visibleChangesError(firstPage, events, pageError),
    isLoading: visibleChangesLoading(pages, events),
    capped,
    unpricedEventsCount,
  };
}

function useStablesChangesPage(
  sinceTimestamp: number,
  offset: number,
  enabled: boolean,
  rates: OracleRateMap,
  minimumUsdValue: number,
): ChangePageState {
  const response = useGQL<ChangesResult>(
    enabled ? STABLES_CHANGES : null,
    enabled
      ? {
          chainIds: STABLES_CHAIN_IDS,
          sinceTimestamp,
          limit: CHANGES_QUERY_PAGE_LIMIT,
          offset,
        }
      : undefined,
  );
  const rawEvents = useMemo(
    () => response.data?.StableSupplyChangeEvent ?? [],
    [response.data],
  );
  const visibleEvents = useMemo(
    () =>
      rawEvents.filter((event) =>
        isVisibleSupplyChangeEvent(event, rates, minimumUsdValue),
      ),
    [minimumUsdValue, rates, rawEvents],
  );
  const unpricedVisibleEventIds = useMemo(() => {
    const ids = new Set<string>();
    for (const event of visibleEvents) {
      if (supplyChangeUsdValue(event, rates) == null) ids.add(event.id);
    }
    return ids;
  }, [rates, visibleEvents]);
  return {
    enabled,
    rawEvents,
    visibleEvents,
    unpricedVisibleEventIds,
    error: response.error,
    isLoading: response.isLoading,
  };
}

function shouldFetchNextChangePage(
  page: ChangePageState,
  visibleEventsCount: number,
): boolean {
  return (
    page.enabled &&
    page.rawEvents.length === CHANGES_QUERY_PAGE_LIMIT &&
    visibleEventsCount < CHANGES_DISPLAY_LIMIT
  );
}

function buildVisibleChangesResult(
  pages: ReadonlyArray<ChangePageState>,
  pageError: unknown,
): {
  events: ReadonlyArray<StableSupplyChangeEvent>;
  capped: boolean;
  unpricedEventsCount: number;
} {
  const visibleEvents = pages.flatMap((candidate) => candidate.visibleEvents);
  const lastFetchedRawEvents = lastEnabledPage(pages)?.rawEvents ?? [];
  const events = visibleEvents.slice(0, CHANGES_DISPLAY_LIMIT);
  const unpricedEventsCount = countVisibleUnpricedEvents(pages, events);
  const hasPendingEnabledPage = pages.some(
    (candidate) => candidate.enabled && candidate.isLoading,
  );
  return {
    events,
    capped:
      visibleEvents.length > CHANGES_DISPLAY_LIMIT ||
      lastFetchedRawEvents.length === CHANGES_QUERY_PAGE_LIMIT ||
      (events.length > 0 && hasPendingEnabledPage) ||
      (events.length > 0 && pageError != null),
    unpricedEventsCount,
  };
}

function countVisibleUnpricedEvents(
  pages: ReadonlyArray<ChangePageState>,
  events: ReadonlyArray<StableSupplyChangeEvent>,
): number {
  if (events.length === 0) return 0;
  let remaining = events.length;
  let count = 0;
  for (const page of pages) {
    if (remaining <= 0) break;
    const pageVisibleCount = page.visibleEvents.length;
    const includedFromPage = Math.min(remaining, pageVisibleCount);
    if (includedFromPage === pageVisibleCount) {
      count += page.unpricedVisibleEventIds.size;
    } else {
      count += page.visibleEvents
        .slice(0, includedFromPage)
        .filter((event) => page.unpricedVisibleEventIds.has(event.id)).length;
    }
    remaining -= includedFromPage;
  }
  return count;
}

function lastEnabledPage(
  pages: ReadonlyArray<ChangePageState>,
): ChangePageState | null {
  for (let index = pages.length - 1; index >= 0; index -= 1) {
    const candidate = pages[index];
    if (candidate?.enabled) return candidate;
  }
  return null;
}

function firstEnabledPageError(pages: ReadonlyArray<ChangePageState>): unknown {
  for (const candidate of pages) {
    if (candidate.enabled && candidate.error != null) return candidate.error;
  }
  return null;
}

function visibleChangesError(
  firstPage: ChangePageState,
  events: ReadonlyArray<StableSupplyChangeEvent>,
  pageError: unknown,
): unknown {
  if (firstPage.error != null) return firstPage.error;
  if (events.length > 0) return null;
  return pageError;
}

function visibleChangesLoading(
  pages: ReadonlyArray<ChangePageState>,
  events: ReadonlyArray<StableSupplyChangeEvent>,
): boolean {
  if (events.length > 0) return false;
  return pages.some((candidate) => candidate.enabled && candidate.isLoading);
}
