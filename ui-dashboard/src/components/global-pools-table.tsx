"use client";

import { useMemo, useState, type ComponentProps } from "react";
import { poolName, poolTvlUSD } from "@/lib/tokens";
import { Table } from "@/components/table";
import { useIsWeekend } from "@/hooks/use-is-weekend";
import { useNowSeconds } from "@/hooks/use-now-seconds";
import { poolTotalVolumeUSD } from "@/lib/volume";
import { useTableSort } from "@/lib/use-table-sort";
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
  chainIds: readonly number[] | null,
): GlobalPoolEntry[] {
  const normalizedSearch = search.trim().toLocaleLowerCase();
  return entries.filter((entry) => {
    if (chainIds !== null && !chainIds.includes(entry.network.chainId)) {
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
    entries: filters.filteredEntries,
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
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-medium text-slate-400 sm:max-w-sm">
          Search pools
          <input
            type="search"
            value={filters.search}
            onChange={(event) => filters.setSearch(event.target.value)}
            placeholder="Filter by pool name"
            className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
          />
        </label>
        <div
          role="group"
          aria-label="Filter pools by chain"
          className="flex flex-wrap gap-1"
        >
          <ChainFilterButton
            label="All chains"
            active={filters.selectedChainIds === null}
            onClick={filters.clearChains}
          />
          {filters.chainOptions.map((option) => (
            <ChainFilterButton
              key={option.chainId}
              label={option.label}
              active={
                filters.selectedChainIds === null ||
                filters.selectedChainIds.includes(option.chainId)
              }
              onClick={() => filters.toggleChain(option.chainId)}
            />
          ))}
        </div>
      </div>
      <Table>
        <PoolTableHeader
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={handleSort}
          showVirtualPoolSource={showVirtualPoolSource}
        />
        <GlobalPoolRows
          entries={sortedEntries}
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

function useGlobalPoolFilters(entries: GlobalPoolEntry[]) {
  const [search, setSearch] = useState("");
  // `null` represents all chains; an empty array is the intentional
  // zero-chain state after the user deselects every option.
  const [selectedChainIds, setSelectedChainIds] = useState<number[] | null>(
    null,
  );
  const chainOptions = useMemo(() => {
    const seen = new Set<number>();
    return entries.flatMap((entry) => {
      if (seen.has(entry.network.chainId)) return [];
      seen.add(entry.network.chainId);
      return [{ chainId: entry.network.chainId, label: entry.network.label }];
    });
  }, [entries]);
  const filteredEntries = useMemo(
    () => filterGlobalPools(entries, search, selectedChainIds),
    [entries, search, selectedChainIds],
  );
  const toggleChain = (chainId: number) => {
    setSelectedChainIds((current) => {
      const active =
        current === null
          ? chainOptions.map((option) => option.chainId)
          : current;
      const next = active.includes(chainId)
        ? active.filter((id) => id !== chainId)
        : [...active, chainId];
      return next.length === chainOptions.length ? null : next;
    });
  };
  return {
    search,
    setSearch,
    selectedChainIds,
    chainOptions,
    filteredEntries,
    toggleChain,
    clearChains: () => setSelectedChainIds(null),
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
  ...rowProps
}: {
  entries: GlobalPoolEntry[];
  showVirtualPoolSource: boolean;
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
      {entries.length === 0 && (
        <tr>
          <td
            colSpan={showVirtualPoolSource ? 11 : 10}
            className="px-3 py-8 text-center text-sm text-slate-400"
          >
            No pools match these filters.
          </td>
        </tr>
      )}
    </tbody>
  );
}

function ChainFilterButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={
        "rounded-md border px-3 py-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 " +
        (active
          ? "border-indigo-400/70 bg-indigo-400/15 text-indigo-100"
          : "border-slate-700 bg-slate-900 text-slate-400 hover:border-slate-600 hover:text-slate-200")
      }
    >
      {label}
    </button>
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
