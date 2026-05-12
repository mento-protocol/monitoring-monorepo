"use client";

import { useMemo } from "react";
import Link from "next/link";
import { formatUSD } from "@/lib/format";
import { poolName, poolTvlUSD } from "@/lib/tokens";
import { isVirtualPool, type TradingLimit } from "@/lib/types";
import { Table, Row, Th } from "@/components/table";
import { SortableTh } from "@/components/sortable-th";
import { SourceBadge, HealthBadge } from "@/components/badges";
import { ChainIcon } from "@/components/chain-icon";
import {
  computeEffectiveStatus,
  computeHealthStatus,
  computePoolUptimePct,
  resolveLimitStatus,
  uptimeColorClass,
} from "@/lib/health";
import { combinedTooltip } from "@/lib/pool-table-utils";
import { isWeekend } from "@/lib/weekend";
import { poolTotalVolumeUSD } from "@/lib/volume";
import { buildPoolDetailHref } from "@/lib/routing";
import { useTableSort } from "@/lib/use-table-sort";
import { formatFee, poolStrategies } from "./global-pools-table/formatting";
import { LimitHeatmap } from "./global-pools-table/limit-heatmap";
import {
  GLOBAL_SORT_KEYS,
  globalPoolKey,
  sortGlobalPools,
  type GlobalPoolEntry,
  type GlobalSortKey,
} from "./global-pools-table/sort";
import { StrategyBadge } from "./global-pools-table/strategy-badge";

export type {
  GlobalPoolEntry,
  GlobalSortContext,
} from "./global-pools-table/sort";
export { globalPoolKey, sortGlobalPools } from "./global-pools-table/sort";

/** Whether any network in the entry list has virtual pools (controls Type column visibility). */
function hasAnyVirtualPools(entries: GlobalPoolEntry[]): boolean {
  return entries.some((e) => e.network.hasVirtualPools);
}

// Table component

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

// Component is over the no-giant-component threshold — table sort/filter state,
// row selection, per-row formatting, and shared column helpers move together.
// Split the row component and sort/filter state when adding more behavior.
// react-doctor-disable-next-line react-doctor/no-giant-component
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
  const showWeekendBanner = isWeekend();

  return (
    <>
      {showWeekendBanner && (
        <div className="mb-4 flex items-start gap-3 rounded-lg border border-slate-700 bg-slate-800/60 px-4 py-3 text-sm text-slate-300">
          <span
            className="text-base leading-5 flex-shrink-0"
            aria-hidden="true"
          >
            🌙
          </span>
          <span>
            <span className="font-medium text-slate-200">
              FX markets are closed this weekend.
            </span>{" "}
            Pool trading is paused until markets reopen (~Sunday 23:00 UTC).
            This is expected — oracle data resumes automatically when markets
            open.
          </span>
        </div>
      )}
      <Table>
        <thead>
          <tr className="border-b border-slate-800 bg-slate-900/50">
            <SortableTh
              sortKey="pool"
              activeSortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
            >
              Pool
            </SortableTh>
            {showVirtualPoolSource && <Th>Type</Th>}
            <SortableTh
              sortKey="health"
              activeSortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
            >
              Health
            </SortableTh>
            <SortableTh
              sortKey="uptime"
              activeSortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
              align="right"
              className="hidden sm:table-cell"
            >
              Uptime
            </SortableTh>
            <SortableTh
              sortKey="fee"
              activeSortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
              align="right"
              className="hidden sm:table-cell"
            >
              Fee
            </SortableTh>
            <Th className="hidden sm:table-cell">Limits</Th>
            <SortableTh
              sortKey="tvl"
              activeSortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
              className="hidden sm:table-cell"
            >
              TVL
            </SortableTh>
            <SortableTh
              sortKey="tvlChangeWoW"
              activeSortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
              className="hidden sm:table-cell"
            >
              TVL Δ WoW
            </SortableTh>
            <SortableTh
              sortKey="volume24h"
              activeSortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
              className="hidden md:table-cell"
            >
              24h Vol.{" "}
            </SortableTh>
            <SortableTh
              sortKey="volume7d"
              activeSortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
              className="hidden md:table-cell"
            >
              7d Vol.{" "}
            </SortableTh>
            <SortableTh
              sortKey="totalVolume"
              activeSortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
              className="hidden md:table-cell"
            >
              Total Vol.{" "}
            </SortableTh>
            <Th className="hidden lg:table-cell">Strategy</Th>
          </tr>
        </thead>
        <tbody>
          {sortedEntries.map((e) => {
            const { pool: p, network } = e;
            const key = globalPoolKey(e);
            // Use `computeEffectiveStatus` (not `worstStatus(computeHealthStatus, ...)`
            // directly) so the `hasHealthData=false → "N/A"` half-short-circuit
            // applies here too. Without this, no-data pools paired with
            // healthy limits would resolve to OK via STATUS_RANK (codex P2
            // PR #370 #3214748745).
            const healthStatus = computeHealthStatus(p, network.chainId);
            const limitStatus = resolveLimitStatus(p);
            const effectiveStatus = computeEffectiveStatus(p, network.chainId);
            const tvl = tvlByKey.get(key) ?? null;
            const vol24h = volume24hByKey?.get(key);
            const vol7d = volume7dByKey?.get(key);
            const totalVol = totalVolumeByKey.get(key);
            const wow = tvlChangeWoWByKey?.get(key);
            const wowColor =
              wow === null
                ? "text-slate-400"
                : wow === undefined
                  ? "text-slate-600"
                  : wow > 0
                    ? "text-emerald-400"
                    : wow < 0
                      ? "text-red-400"
                      : "text-slate-400";
            const poolHref = buildPoolDetailHref(p.id);
            const limits = tradingLimitsByKey?.get(key) ?? [];
            const isOls = olsPoolKeys?.has(key) ?? false;
            const isCdp = cdpPoolKeys?.has(key) ?? false;
            const isReserve = reservePoolKeys?.has(key) ?? false;
            const strategies = poolStrategies(isOls, isCdp, isReserve);
            const isVirtual = isVirtualPool(p);
            return (
              <Row key={key}>
                <td className="px-2 sm:px-4 py-2 sm:py-3">
                  <div className="flex items-center gap-2">
                    <ChainIcon network={network} />
                    <Link
                      href={poolHref}
                      className="font-semibold text-sm sm:text-base text-indigo-400 hover:text-indigo-300"
                    >
                      {poolName(network, p.token0, p.token1)}
                    </Link>
                  </div>
                </td>
                {showVirtualPoolSource && (
                  <td className="px-2 sm:px-4 py-2 sm:py-3">
                    {p.source ? (
                      <SourceBadge
                        source={p.source}
                        wrappedExchangeId={p.wrappedExchangeId}
                      />
                    ) : (
                      <span className="text-slate-600 text-xs">—</span>
                    )}
                  </td>
                )}
                <td className="px-2 sm:px-4 py-2 sm:py-3">
                  <button
                    type="button"
                    title={combinedTooltip(
                      healthStatus,
                      limitStatus,
                      p,
                      network,
                    )}
                    className="cursor-default appearance-none bg-transparent border-0 p-0"
                  >
                    <HealthBadge status={effectiveStatus} />
                  </button>
                </td>
                <td className="hidden sm:table-cell px-2 sm:px-4 py-2 sm:py-3 text-sm font-mono text-right">
                  {(() => {
                    const pct = computePoolUptimePct(p);
                    if (pct == null)
                      return <span className="text-slate-600">—</span>;
                    return (
                      <span
                        className={uptimeColorClass(pct)}
                        title={`${pct.toFixed(3)}% uptime (oracle freshness + price within tolerance) · ${p.breachCount ?? 0} lifetime price-deviation ${(p.breachCount ?? 0) === 1 ? "breach" : "breaches"}`}
                      >
                        {pct.toFixed(2)}%
                      </span>
                    );
                  })()}
                </td>
                <td className="hidden sm:table-cell px-2 sm:px-4 py-2 sm:py-3 text-sm text-slate-200 font-mono text-right">
                  {formatFee(p)}
                </td>
                <td className="hidden sm:table-cell px-2 sm:px-4 py-2 sm:py-3">
                  {isVirtual ? (
                    <span className="text-slate-600 text-xs">—</span>
                  ) : (
                    <LimitHeatmap limits={limits} network={network} pool={p} />
                  )}
                </td>
                <td className="hidden sm:table-cell px-2 sm:px-4 py-2 sm:py-3 text-sm text-slate-200 font-mono">
                  {tvl !== null && tvl > 0 ? formatUSD(tvl) : "—"}
                </td>
                <td
                  className={`hidden sm:table-cell px-2 sm:px-4 py-2 sm:py-3 text-sm font-mono ${wowColor}`}
                >
                  {wow === null
                    ? "N/A"
                    : wow === undefined
                      ? "—"
                      : `${wow >= 0 ? "+" : ""}${wow.toFixed(2)}%`}
                </td>
                <td className="hidden md:table-cell px-2 sm:px-4 py-2 sm:py-3 text-sm text-slate-200 font-mono">
                  {volume24hLoading
                    ? "…"
                    : volume24hError
                      ? "N/A"
                      : vol24h === null
                        ? "N/A"
                        : vol24h && vol24h > 0
                          ? formatUSD(vol24h)
                          : "—"}
                </td>
                <td className="hidden md:table-cell px-2 sm:px-4 py-2 sm:py-3 text-sm text-slate-200 font-mono">
                  {volume7dLoading
                    ? "…"
                    : volume7dError
                      ? "N/A"
                      : vol7d === null
                        ? "N/A"
                        : vol7d && vol7d > 0
                          ? formatUSD(vol7d)
                          : "—"}
                </td>
                <td className="hidden md:table-cell px-2 sm:px-4 py-2 sm:py-3 text-sm text-slate-200 font-mono">
                  {totalVol == null ? "—" : formatUSD(totalVol)}
                </td>
                <td className="hidden lg:table-cell px-2 sm:px-4 py-2 sm:py-3">
                  {strategies.length > 0 ? (
                    <div className="flex gap-1">
                      {strategies.map((s) => (
                        <StrategyBadge key={s} label={s} />
                      ))}
                    </div>
                  ) : (
                    <span className="text-slate-600 text-xs">—</span>
                  )}
                </td>
              </Row>
            );
          })}
        </tbody>
      </Table>
    </>
  );
}
