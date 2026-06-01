"use client";

import { useMemo } from "react";
import { poolTvlUSD } from "@/lib/tokens";
import { type TradingLimit } from "@/lib/types";
import { Table } from "@/components/table";
import { useIsWeekend } from "@/hooks/use-is-weekend";
import { poolTotalVolumeUSD } from "@/lib/volume";
import { useTableSort } from "@/lib/use-table-sort";
import {
  GLOBAL_SORT_KEYS,
  globalPoolKey,
  sortGlobalPools,
  type GlobalPoolEntry,
  type GlobalSortKey,
} from "./global-pools-table/sort";
import { PoolRow } from "./global-pools-table/pool-row";
import { PoolTableHeader } from "./global-pools-table/pool-table-header";

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
  tradingLimitsByKey?: Map<string, TradingLimit[]>;
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
  tradingLimitsByKey,
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
        <tbody>
          {sortedEntries.map((e) => (
            <PoolRow
              key={globalPoolKey(e)}
              entry={e}
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
              tradingLimitsByKey={tradingLimitsByKey}
              olsPoolKeys={olsPoolKeys}
              cdpPoolKeys={cdpPoolKeys}
              reservePoolKeys={reservePoolKeys}
            />
          ))}
        </tbody>
      </Table>
    </>
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
