"use client";

import { useMemo, useState, type ComponentProps } from "react";
import { poolName, poolTvlUSD } from "@/lib/tokens";
import { Table } from "@/components/table";
import { useIsWeekend } from "@/hooks/use-is-weekend";
import { useNowSeconds } from "@/hooks/use-now-seconds";
import { poolTotalVolumeUSD } from "@/lib/volume";
import { useTableSort } from "@/lib/use-table-sort";
import { useRovingTabIndex } from "@/lib/use-roving-tab-index";
import {
  GLOBAL_SORT_KEYS,
  globalPoolKey,
  sortGlobalPools,
  type GlobalPoolEntry,
  type GlobalSortContext,
  type GlobalSortKey,
} from "./global-pools-table/sort";
import type { SortDir } from "@/lib/table-sort";
import { PoolRow } from "./global-pools-table/pool-row";
import { PoolTableHeader } from "./global-pools-table/pool-table-header";

export type {
  GlobalPoolEntry,
  GlobalSortContext,
} from "./global-pools-table/sort";
export { globalPoolKey, sortGlobalPools } from "./global-pools-table/sort";

/**
 * Homepage pool filters intentionally operate on the already loaded global
 * entries. They do not alter the page's independently aggregated KPIs or
 * charts, and the table has no pagination window that could hide a match.
 * Filter state is intentionally local: changing it needs no server render,
 * and sharing a temporary filtered table view is outside this slice.
 */
export function filterGlobalPools(
  entries: GlobalPoolEntry[],
  search: string,
  chainId: number | null,
): GlobalPoolEntry[] {
  const normalizedSearch = search.trim().toLocaleLowerCase();
  return entries.filter((entry) => {
    if (chainId !== null && chainId !== entry.network.chainId) {
      return false;
    }
    return (
      normalizedSearch.length === 0 ||
      poolName(entry.network, entry.pool.token0, entry.pool.token1)
        .toLocaleLowerCase()
        .includes(normalizedSearch)
    );
  });
}

function hasAnyVirtualPools(entries: GlobalPoolEntry[]): boolean {
  return entries.some((e) => e.network.hasVirtualPools);
}

interface GlobalPoolsTableProps {
  entries: GlobalPoolEntry[];
  /** Homepage owns the local pool-name and chain controls. */
  showFilters?: boolean;
  initialIsWeekend?: boolean;
  volume24hByKey?: Map<string, number | null | undefined>;
  volume24hLoading?: boolean;
  volume24hError?: boolean;
  volume7dByKey?: Map<string, number | null | undefined>;
  volume7dLoading?: boolean;
  volume7dError?: boolean;
  tvlChangeWoWByKey?: Map<string, number | null>;
  olsPoolKeys?: Set<string>;
  cdpPoolKeys?: Set<string>;
  reservePoolKeys?: Set<string>;
}

export function GlobalPoolsTable({
  entries,
  showFilters = false,
  initialIsWeekend = false,
  volume24hByKey,
  volume24hLoading = false,
  volume24hError = false,
  volume7dByKey,
  volume7dLoading = false,
  volume7dError = false,
  tvlChangeWoWByKey,
  olsPoolKeys,
  cdpPoolKeys,
  reservePoolKeys,
}: GlobalPoolsTableProps) {
  const { sortKey, sortDir, handleSort } = useTableSort<GlobalSortKey>({
    defaultKey: "tvl",
    defaultDir: "desc",
    validKeys: GLOBAL_SORT_KEYS,
    paramPrefix: "pools",
  });
  const liveNowSeconds = useNowSeconds();
  const filters = useGlobalPoolFilters(entries);
  const { tvlByKey, totalVolumeByKey } = useGlobalPoolValues(entries);
  const sortedEntries = useSortedGlobalPools({
    entries: showFilters ? filters.filteredEntries : entries,
    sortKey,
    sortDir,
    tvlByKey,
    totalVolumeByKey,
    nowSeconds: liveNowSeconds ?? 0,
    volume24hByKey,
    volume7dByKey,
    tvlChangeWoWByKey,
  });

  const showVirtualPoolSource = hasAnyVirtualPools(entries);

  return (
    <>
      <WeekendBanner initialIsWeekend={initialIsWeekend} />
      {showFilters && <GlobalPoolFilters filters={filters} />}
      <Table>
        <PoolTableHeader
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={handleSort}
          showVirtualPoolSource={showVirtualPoolSource}
        />
        <GlobalPoolRows
          entries={sortedEntries}
          showEmptyState={showFilters && entries.length > 0}
          showVirtualPoolSource={showVirtualPoolSource}
          tvlByKey={tvlByKey}
          volume24hByKey={volume24hByKey}
          volume24hLoading={volume24hLoading}
          volume24hError={volume24hError}
          volume7dByKey={volume7dByKey}
          volume7dLoading={volume7dLoading}
          volume7dError={volume7dError}
          totalVolumeByKey={totalVolumeByKey}
          tvlChangeWoWByKey={tvlChangeWoWByKey}
          nowSeconds={liveNowSeconds}
          olsPoolKeys={olsPoolKeys}
          cdpPoolKeys={cdpPoolKeys}
          reservePoolKeys={reservePoolKeys}
        />
      </Table>
    </>
  );
}

function GlobalPoolFilters({
  filters,
}: {
  filters: ReturnType<typeof useGlobalPoolFilters>;
}) {
  const activeIndex =
    filters.selectedChainId === null
      ? 0
      : Math.max(
          0,
          filters.chainOptions.findIndex(
            (option) => option.chainId === filters.selectedChainId,
          ) + 1,
        );
  const { groupRef, getItemProps, handleKeyDown } = useRovingTabIndex({
    activeIndex,
    itemCount: filters.chainOptions.length + 1,
    activation: "automatic",
    arrowKeys: "all",
    onActivate: (index) =>
      filters.selectChain(
        index === 0 ? null : (filters.chainOptions[index - 1]?.chainId ?? null),
      ),
  });
  const allRovingProps = getItemProps(0);

  return (
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <label className="min-w-48 flex-1 sm:max-w-xs">
        <span className="sr-only">Search pools</span>
        <input
          type="search"
          aria-label="Search pools"
          value={filters.search}
          onChange={(event) => filters.setSearch(event.target.value)}
          placeholder="Filter by pool name"
          className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200 placeholder:text-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
        />
      </label>
      <div
        ref={groupRef}
        role="radiogroup"
        aria-label="Filter pools by chain"
        className="flex flex-wrap items-center gap-1.5"
        onKeyDown={handleKeyDown}
        tabIndex={-1}
      >
        <span className="text-xs text-slate-500 mr-1">Chains:</span>
        <button
          type="button"
          role="radio"
          aria-checked={filters.selectedChainId === null}
          ref={allRovingProps.ref}
          tabIndex={allRovingProps.tabIndex}
          onFocus={allRovingProps.onFocus}
          onClick={() =>
            filters.selectedChainId !== null && filters.selectChain(null)
          }
          className={
            "rounded-full px-2.5 py-0.5 text-[10px] uppercase tracking-wider font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 " +
            (filters.selectedChainId === null
              ? "bg-indigo-900/40 text-indigo-200"
              : "bg-slate-800/60 text-slate-400 hover:text-slate-200")
          }
        >
          All
        </button>
        {filters.chainOptions.map((option, index) => {
          const active = filters.selectedChainId === option.chainId;
          const rovingProps = getItemProps(index + 1);
          return (
            <button
              key={option.chainId}
              type="button"
              role="radio"
              aria-checked={active}
              ref={rovingProps.ref}
              tabIndex={rovingProps.tabIndex}
              onFocus={rovingProps.onFocus}
              onClick={() => !active && filters.selectChain(option.chainId)}
              className={
                "rounded-full px-2.5 py-0.5 text-[10px] uppercase tracking-wider font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 " +
                (active
                  ? "bg-slate-700 text-slate-200"
                  : "bg-slate-800/60 text-slate-400 hover:text-slate-200")
              }
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function useGlobalPoolFilters(entries: GlobalPoolEntry[]) {
  const [search, setSearch] = useState("");
  // `null` represents all chains; otherwise exactly one chain is selected.
  const [selectedChainId, setSelectedChainId] = useState<number | null>(null);
  const chainOptions = useMemo(() => {
    const seen = new Set<number>();
    return entries.flatMap((entry) => {
      if (seen.has(entry.network.chainId)) return [];
      seen.add(entry.network.chainId);
      return [{ chainId: entry.network.chainId, label: entry.network.label }];
    });
  }, [entries]);
  const filteredEntries = useMemo(
    () => filterGlobalPools(entries, search, selectedChainId),
    [entries, search, selectedChainId],
  );
  return {
    search,
    setSearch,
    selectedChainId,
    chainOptions,
    filteredEntries,
    selectChain: setSelectedChainId,
  };
}

function useGlobalPoolValues(entries: GlobalPoolEntry[]) {
  const tvlByKey = useMemo(
    () =>
      new Map(
        entries.map((entry) => [
          globalPoolKey(entry),
          poolTvlUSD(entry.pool, entry.network, entry.rates),
        ]),
      ),
    [entries],
  );
  const totalVolumeByKey = useMemo(
    () =>
      new Map(
        entries.map((entry) => [
          globalPoolKey(entry),
          poolTotalVolumeUSD(entry.pool, entry.network, entry.rates),
        ]),
      ),
    [entries],
  );
  return { tvlByKey, totalVolumeByKey };
}

function useSortedGlobalPools({
  entries,
  sortKey,
  sortDir,
  tvlByKey,
  totalVolumeByKey,
  nowSeconds,
  volume24hByKey,
  volume7dByKey,
  tvlChangeWoWByKey,
}: {
  entries: GlobalPoolEntry[];
  sortKey: GlobalSortKey;
  sortDir: SortDir;
} & GlobalSortContext) {
  return useMemo(
    () =>
      sortGlobalPools(entries, sortKey, sortDir, {
        tvlByKey,
        totalVolumeByKey,
        nowSeconds,
        volume24hByKey,
        volume7dByKey,
        tvlChangeWoWByKey,
      }),
    [
      entries,
      sortKey,
      sortDir,
      tvlByKey,
      totalVolumeByKey,
      nowSeconds,
      volume24hByKey,
      volume7dByKey,
      tvlChangeWoWByKey,
    ],
  );
}

function GlobalPoolRows({
  entries,
  showVirtualPoolSource,
  showEmptyState,
  ...rowProps
}: {
  entries: GlobalPoolEntry[];
  showVirtualPoolSource: boolean;
  showEmptyState: boolean;
} & Omit<ComponentProps<typeof PoolRow>, "entry" | "showVirtualPoolSource">) {
  return (
    <tbody>
      {entries.map((entry) => (
        <PoolRow
          key={globalPoolKey(entry)}
          entry={entry}
          showVirtualPoolSource={showVirtualPoolSource}
          {...rowProps}
        />
      ))}
      {showEmptyState && entries.length === 0 && (
        <tr>
          <td
            colSpan={showVirtualPoolSource ? 11 : 10}
            className="px-3 py-8 text-center text-sm text-slate-400"
          >
            <span role="status" aria-label="Filtered pool results">
              No pools match these filters.
            </span>
          </td>
        </tr>
      )}
    </tbody>
  );
}

function WeekendBanner({ initialIsWeekend }: { initialIsWeekend: boolean }) {
  // Reuse the route's serialized snapshot through hydration, then go live.
  const showWeekendBanner = useIsWeekend(initialIsWeekend);
  if (!showWeekendBanner) return null;

  return (
    <div className="mb-4 flex items-start gap-3 rounded-lg border border-slate-700 bg-slate-800/60 px-4 py-3 text-sm text-slate-300">
      <span className="text-base leading-5 flex-shrink-0" aria-hidden="true">
        🌙
      </span>
      <span>
        <span className="font-medium text-slate-200">
          FX markets are closed this weekend.
        </span>{" "}
        Pool trading is paused until markets reopen (~Sunday 23:00 UTC). This is
        expected — oracle data resumes automatically when markets open.
      </span>
    </div>
  );
}
