"use client";

import { useMemo } from "react";
import { useGQL } from "@/lib/graphql";
import {
  STABLES_CUSTODY_DAILY_SNAPSHOTS,
  STABLES_DAILY_SNAPSHOTS,
  STABLES_LATEST_CUSTODY_PER_TOKEN,
  STABLES_LATEST_PER_TOKEN,
  STABLES_CHANGES,
} from "@/lib/queries/stables";
import { isVisibleSupplyChangeEvent, rangeStartSeconds } from "./aggregate";
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
// Numeric.MAX cursor (~year 2286 in Unix-seconds); `_lt: <this>` returns
// the first page from the top of the desc-ordered snapshot table.
const TS_CURSOR_INITIAL = "9999999999";

type DailySnapshotsResult = {
  StableSupplyDailySnapshot: ReadonlyArray<StableSupplyDailySnapshot>;
};
type LatestPerTokenResult = DailySnapshotsResult;
type CustodyDailySnapshotsResult = {
  StableTokenCustodyDailySnapshot: ReadonlyArray<StableTokenCustodyDailySnapshot>;
};
type LatestCustodyPerTokenResult = CustodyDailySnapshotsResult;
type ChangesResult = {
  StableSupplyChangeEvent: ReadonlyArray<StableSupplyChangeEvent>;
};
type ChangePageState = {
  enabled: boolean;
  rawEvents: ReadonlyArray<StableSupplyChangeEvent>;
  visibleEvents: ReadonlyArray<StableSupplyChangeEvent>;
  error: unknown;
  isLoading: boolean;
};

/**
 * Per-token latest supply snapshot (one row per token via distinct_on).
 * Powers the KPI strip current totals + sparkline grid headlines.
 *
 * /stables is a global supply view, so it queries every chain that can carry
 * Mento stable supply instead of following the currently selected network.
 */
export function useStablesLatestPerToken() {
  const { data, error, isLoading } = useGQL<LatestPerTokenResult>(
    STABLES_LATEST_PER_TOKEN,
    { chainIds: STABLES_CHAIN_IDS },
  );
  const snapshots = useMemo(
    () => data?.StableSupplyDailySnapshot ?? [],
    [data],
  );
  return { snapshots, error, isLoading };
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
  const { data, error, isLoading } = useGQL<LatestCustodyPerTokenResult>(
    STABLES_LATEST_CUSTODY_PER_TOKEN,
    { chainIds: STABLES_CHAIN_IDS },
  );
  // Keep this daily-snapshot anchored. The aggregate helpers can forward-fill
  // daily supply and custody independently, but they must not mix live custody
  // state with a daily supply feed.
  const snapshots = useMemo(
    () => data?.StableTokenCustodyDailySnapshot ?? [],
    [data],
  );
  return { snapshots, error, isLoading };
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
 * sub-display dust rows that would render as 0.00 at table precision.
 *
 * A single raw page can be dust-heavy, so the hook conditionally fetches
 * additional raw pages until it has enough visible rows, exhausts the current
 * window, or reaches the bounded query budget above.
 */
export function useStablesChanges(range: RangeKey = "7d", page: number = 0) {
  const sinceTimestamp = rangeStartSeconds(range);
  const baseOffset = page * CHANGES_QUERY_PAGE_LIMIT * CHANGES_MAX_QUERY_PAGES;
  const firstPage = useStablesChangesPage(sinceTimestamp, baseOffset, true);
  const shouldFetchSecondPage = shouldFetchNextChangePage(
    firstPage,
    firstPage.visibleEvents.length,
  );
  const secondPage = useStablesChangesPage(
    sinceTimestamp,
    baseOffset + CHANGES_QUERY_PAGE_LIMIT,
    shouldFetchSecondPage,
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
  );
  const pages = [firstPage, secondPage, thirdPage] as const;
  const pageError = firstEnabledPageError(pages);
  const { events, capped } = buildVisibleChangesResult(pages, pageError);
  return {
    events,
    error: visibleChangesError(firstPage, events, pageError),
    isLoading: pages.some(
      (candidate) => candidate.enabled && candidate.isLoading,
    ),
    capped,
  };
}

function useStablesChangesPage(
  sinceTimestamp: number,
  offset: number,
  enabled: boolean,
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
    () => rawEvents.filter(isVisibleSupplyChangeEvent),
    [rawEvents],
  );
  return {
    enabled,
    rawEvents,
    visibleEvents,
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
} {
  const visibleEvents = pages.flatMap((candidate) => candidate.visibleEvents);
  const lastFetchedRawEvents = lastEnabledPage(pages)?.rawEvents ?? [];
  const events = visibleEvents.slice(0, CHANGES_DISPLAY_LIMIT);
  return {
    events,
    capped:
      visibleEvents.length > CHANGES_DISPLAY_LIMIT ||
      lastFetchedRawEvents.length === CHANGES_QUERY_PAGE_LIMIT ||
      (events.length > 0 && pageError != null),
  };
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
