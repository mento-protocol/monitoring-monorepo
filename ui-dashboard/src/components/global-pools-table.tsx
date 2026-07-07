"use client";

import { useMemo, useState } from "react";
import { poolTvlUSD } from "@/lib/tokens";
import { isVirtualPool } from "@/lib/types";
import { Table } from "@/components/table";
import { useIsWeekend } from "@/hooks/use-is-weekend";
import { poolTotalVolumeUSD } from "@/lib/volume";
import { useTableSort } from "@/lib/use-table-sort";
import { computeEffectiveStatus } from "@/lib/health";
import {
  GLOBAL_SORT_KEYS,
  globalPoolKey,
  sortGlobalPools,
  type GlobalPoolEntry,
  type GlobalSortKey,
} from "./global-pools-table/sort";
import { PoolRow } from "./global-pools-table/pool-row";
import { PoolTableHeader } from "./global-pools-table/pool-table-header";
import { hasFeeData } from "./global-pools-table/formatting";

export type {
  GlobalPoolEntry,
  GlobalSortContext,
} from "./global-pools-table/sort";
export { globalPoolKey, sortGlobalPools } from "./global-pools-table/sort";

function hasAnyVirtualPools(entries: GlobalPoolEntry[]): boolean {
  return entries.some((e) => e.network.hasVirtualPools);
}

interface GlobalPoolsTableProps {
  entries: GlobalPoolEntry[];
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

  const tvlByKey = useMemo(
    () =>
      new Map(
        entries.map((e) => [
          globalPoolKey(e),
          poolTvlUSD(e.pool, e.network, e.rates),
        ]),
      ),
    [entries],
  );

  const totalVolumeByKey = useMemo(
    () =>
      new Map(
        entries.map((e) => [
          globalPoolKey(e),
          poolTotalVolumeUSD(e.pool, e.network, e.rates),
        ]),
      ),
    [entries],
  );

  const sortedEntries = useMemo(
    () =>
      sortGlobalPools(entries, sortKey, sortDir, {
        tvlByKey,
        totalVolumeByKey,
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
      volume24hByKey,
      volume7dByKey,
      tvlChangeWoWByKey,
    ],
  );

  const showVirtualPoolSource = hasAnyVirtualPools(entries);
  // SSR-safe: only show the weekend banner after mount. The server's
  // wall-clock day can differ from the viewer's (and a cached SSR payload can
  // outlive the weekend), so gating on isWeekend() during render would emit
  // server HTML the client discards as a hydration mismatch. See useIsWeekend.
  const showWeekendBanner = useIsWeekend();

  return (
    <>
      {showWeekendBanner && <WeekendBanner />}
      <Table>
        <PoolTableHeader
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={handleSort}
          showVirtualPoolSource={showVirtualPoolSource}
        />
        <GlobalPoolsTableBody
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
          olsPoolKeys={olsPoolKeys}
          cdpPoolKeys={cdpPoolKeys}
          reservePoolKeys={reservePoolKeys}
        />
      </Table>
    </>
  );
}

type PoolRowsProps = {
  entries: GlobalPoolEntry[];
  showVirtualPoolSource: boolean;
  tvlByKey: Map<string, number | null>;
  volume24hByKey?: Map<string, number | null | undefined> | undefined;
  volume24hLoading: boolean;
  volume24hError: boolean;
  volume7dByKey?: Map<string, number | null | undefined> | undefined;
  volume7dLoading: boolean;
  volume7dError: boolean;
  totalVolumeByKey: Map<string, number | null>;
  tvlChangeWoWByKey?: Map<string, number | null> | undefined;
  olsPoolKeys?: Set<string> | undefined;
  cdpPoolKeys?: Set<string> | undefined;
  reservePoolKeys?: Set<string> | undefined;
};

function GlobalPoolsTableBody({
  entries,
  showVirtualPoolSource,
  tvlByKey,
  volume24hByKey,
  volume24hLoading,
  volume24hError,
  volume7dByKey,
  volume7dLoading,
  volume7dError,
  totalVolumeByKey,
  tvlChangeWoWByKey,
  olsPoolKeys,
  cdpPoolKeys,
  reservePoolKeys,
}: PoolRowsProps) {
  const [showInactiveVirtualPools, setShowInactiveVirtualPools] =
    useState(false);
  const { activeEntries, inactiveVirtualEntries } = useMemo(
    () =>
      partitionInactiveVirtualEntries(entries, {
        tvlByKey,
        totalVolumeByKey,
        volume24hByKey,
        volume7dByKey,
      }),
    [entries, tvlByKey, totalVolumeByKey, volume24hByKey, volume7dByKey],
  );
  const rowProps = {
    showVirtualPoolSource,
    tvlByKey,
    volume24hByKey,
    volume24hLoading,
    volume24hError,
    volume7dByKey,
    volume7dLoading,
    volume7dError,
    totalVolumeByKey,
    tvlChangeWoWByKey,
    olsPoolKeys,
    cdpPoolKeys,
    reservePoolKeys,
  };
  return (
    <tbody>
      <PoolRows entries={activeEntries} {...rowProps} />
      {inactiveVirtualEntries.length > 0 && (
        <InactiveVirtualPoolsRow
          count={inactiveVirtualEntries.length}
          expanded={showInactiveVirtualPools}
          colSpan={showVirtualPoolSource ? 11 : 10}
          onToggle={() => setShowInactiveVirtualPools((expanded) => !expanded)}
        />
      )}
      {showInactiveVirtualPools && (
        <PoolRows entries={inactiveVirtualEntries} {...rowProps} />
      )}
    </tbody>
  );
}

function PoolRows({
  entries,
  showVirtualPoolSource,
  tvlByKey,
  volume24hByKey,
  volume24hLoading,
  volume24hError,
  volume7dByKey,
  volume7dLoading,
  volume7dError,
  totalVolumeByKey,
  tvlChangeWoWByKey,
  olsPoolKeys,
  cdpPoolKeys,
  reservePoolKeys,
}: PoolRowsProps) {
  return entries.map((entry) => (
    <PoolRow
      key={globalPoolKey(entry)}
      entry={entry}
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
      olsPoolKeys={olsPoolKeys}
      cdpPoolKeys={cdpPoolKeys}
      reservePoolKeys={reservePoolKeys}
    />
  ));
}

function partitionInactiveVirtualEntries(
  entries: GlobalPoolEntry[],
  maps: {
    tvlByKey: Map<string, number | null>;
    totalVolumeByKey: Map<string, number | null>;
    volume24hByKey?: Map<string, number | null | undefined> | undefined;
    volume7dByKey?: Map<string, number | null | undefined> | undefined;
  },
): {
  activeEntries: GlobalPoolEntry[];
  inactiveVirtualEntries: GlobalPoolEntry[];
} {
  const activeEntries: GlobalPoolEntry[] = [];
  const inactiveVirtualEntries: GlobalPoolEntry[] = [];
  for (const entry of entries) {
    if (isInactiveVirtualEntry(entry, maps)) {
      inactiveVirtualEntries.push(entry);
    } else {
      activeEntries.push(entry);
    }
  }
  return { activeEntries, inactiveVirtualEntries };
}

function isInactiveVirtualEntry(
  entry: GlobalPoolEntry,
  {
    tvlByKey,
    totalVolumeByKey,
    volume24hByKey,
    volume7dByKey,
  }: {
    tvlByKey: Map<string, number | null>;
    totalVolumeByKey: Map<string, number | null>;
    volume24hByKey?: Map<string, number | null | undefined> | undefined;
    volume7dByKey?: Map<string, number | null | undefined> | undefined;
  },
): boolean {
  if (!isVirtualPool(entry.pool)) return false;
  if (computeEffectiveStatus(entry.pool, entry.network.chainId) !== "N/A") {
    return false;
  }
  if ((entry.pool.swapCount ?? 0) > 0 || (entry.pool.rebalanceCount ?? 0) > 0) {
    return false;
  }
  if (hasFeeData(entry.pool) || hasReserveSignal(entry.pool)) return false;

  const key = globalPoolKey(entry);
  return (
    !hasPositiveNumber(tvlByKey.get(key)) &&
    !hasPositiveNumber(totalVolumeByKey.get(key)) &&
    !hasPositiveNumber(volume24hByKey?.get(key)) &&
    !hasPositiveNumber(volume7dByKey?.get(key))
  );
}

function hasReserveSignal(pool: GlobalPoolEntry["pool"]): boolean {
  return (
    hasPositiveDecimalString(pool.reserves0) ||
    hasPositiveDecimalString(pool.reserves1)
  );
}

function hasPositiveDecimalString(value: string | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  return /^[0-9]+$/.test(trimmed) && /[1-9]/.test(trimmed);
}

function hasPositiveNumber(value: number | null | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function InactiveVirtualPoolsRow({
  count,
  expanded,
  colSpan,
  onToggle,
}: {
  count: number;
  expanded: boolean;
  colSpan: number;
  onToggle: () => void;
}) {
  const poolLabel = count === 1 ? "pool" : "pools";
  return (
    <tr className="border-b border-slate-800/50 bg-slate-900/40">
      <td colSpan={colSpan} className="px-2 py-3 sm:px-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-slate-300">
              {count} inactive Virtual {poolLabel}
            </p>
            <p className="mt-0.5 text-xs text-slate-500">
              No reserves, volume, swaps, fees, or uptime signal.
            </p>
          </div>
          <button
            type="button"
            className="w-fit rounded border border-slate-700 px-3 py-1.5 text-xs text-slate-300 transition-colors hover:border-slate-500 hover:text-white"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-label={`${expanded ? "Hide" : "Show"} ${count} inactive Virtual ${poolLabel}`}
          >
            {expanded ? "Hide" : "Show"}
          </button>
        </div>
      </td>
    </tr>
  );
}

function WeekendBanner() {
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
