"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { formatUSD } from "@/lib/format";
import { poolName, poolTvlUSD } from "@/lib/tokens";
import type { Network } from "@/lib/networks";
import type { Pool } from "@/lib/types";
import { Table, Row, Th } from "@/components/table";
import { SourceBadge, HealthBadge, RebalancerBadge } from "@/components/badges";
import {
  computeHealthStatus,
  computeLimitStatus,
  computeRebalancerLiveness,
  worstStatus,
} from "@/lib/health";
import { combinedTooltip, rebalancerTooltip } from "@/lib/pool-table-utils";
import { isWeekend } from "@/lib/weekend";
import { poolTotalVolumeUSD } from "@/lib/volume";

/** A pool entry enriched with its originating network. */
export type GlobalPoolEntry = {
  pool: Pool;
  network: Network;
};

export type GlobalSortKey =
  | "pool"
  | "chain"
  | "health"
  | "tvl"
  | "volume24h"
  | "volume7d"
  | "totalVolume"
  | "swaps"
  | "rebalances";

export type SortDir = "asc" | "desc";

// Higher rank = more severe. "desc" puts highest rank first → CRITICAL first.
const HEALTH_ORDER: Record<string, number> = {
  "N/A": 0,
  OK: 1,
  WARN: 2,
  WEEKEND: 3,
  CRITICAL: 4,
};

/** Build a unique key for a pool entry so pools from different chains with the same ID don't collide. */
export function globalPoolKey(entry: GlobalPoolEntry): string {
  return `${entry.network.id}:${entry.pool.id}`;
}

export interface GlobalSortContext {
  tvlByKey: Map<string, number>;
  totalVolumeByKey: Map<string, number | null>;
  volume24hByKey?: Map<string, number | null | undefined>;
  volume7dByKey?: Map<string, number | null | undefined>;
}

export function sortGlobalPools(
  entries: GlobalPoolEntry[],
  sortKey: GlobalSortKey,
  sortDir: SortDir,
  {
    tvlByKey,
    totalVolumeByKey,
    volume24hByKey,
    volume7dByKey,
  }: GlobalSortContext,
): GlobalPoolEntry[] {
  return [...entries].sort((a, b) => {
    const aKey = globalPoolKey(a);
    const bKey = globalPoolKey(b);
    let cmp = 0;
    switch (sortKey) {
      case "pool":
        cmp = poolName(a.network, a.pool.token0, a.pool.token1).localeCompare(
          poolName(b.network, b.pool.token0, b.pool.token1),
        );
        break;
      case "chain":
        cmp = a.network.label.localeCompare(b.network.label);
        break;
      case "health": {
        const aH = worstStatus(
          computeHealthStatus(a.pool, a.network.chainId),
          a.pool.limitStatus ?? computeLimitStatus(a.pool),
        );
        const bH = worstStatus(
          computeHealthStatus(b.pool, b.network.chainId),
          b.pool.limitStatus ?? computeLimitStatus(b.pool),
        );
        cmp = (HEALTH_ORDER[aH] ?? 99) - (HEALTH_ORDER[bH] ?? 99);
        break;
      }
      case "tvl":
        cmp = (tvlByKey.get(aKey) ?? 0) - (tvlByKey.get(bKey) ?? 0);
        break;
      case "volume24h": {
        const aV = volume24hByKey?.get(aKey) ?? 0;
        const bV = volume24hByKey?.get(bKey) ?? 0;
        cmp = aV - bV;
        break;
      }
      case "volume7d": {
        const aV7 = volume7dByKey?.get(aKey) ?? 0;
        const bV7 = volume7dByKey?.get(bKey) ?? 0;
        cmp = aV7 - bV7;
        break;
      }
      case "totalVolume":
        cmp =
          (totalVolumeByKey.get(aKey) ?? 0) - (totalVolumeByKey.get(bKey) ?? 0);
        break;
      case "swaps":
        cmp = (a.pool.swapCount ?? 0) - (b.pool.swapCount ?? 0);
        break;
      case "rebalances":
        cmp = (a.pool.rebalanceCount ?? 0) - (b.pool.rebalanceCount ?? 0);
        break;
    }
    return sortDir === "asc" ? cmp : -cmp;
  });
}

interface SortableThProps {
  sortKey: GlobalSortKey;
  activeSortKey: GlobalSortKey;
  sortDir: SortDir;
  onSort: (key: GlobalSortKey) => void;
  align?: "left" | "right";
  className?: string;
  children: React.ReactNode;
}

function SortableTh({
  sortKey,
  activeSortKey,
  sortDir,
  onSort,
  align = "left",
  className = "",
  children,
}: SortableThProps) {
  const isActive = sortKey === activeSortKey;
  const alignClass = align === "right" ? "text-right" : "text-left";
  return (
    <th
      scope="col"
      aria-sort={
        isActive ? (sortDir === "asc" ? "ascending" : "descending") : "none"
      }
      className={`px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium text-slate-400 ${alignClass} whitespace-nowrap ${className}`}
    >
      <button
        type="button"
        className="flex items-center gap-1 cursor-pointer select-none hover:text-slate-200 bg-transparent border-0 p-0 font-medium text-xs sm:text-sm text-slate-400 hover:text-slate-200"
        onClick={() => onSort(sortKey)}
      >
        {children}
        {isActive ? (
          <span className="text-indigo-400">
            {sortDir === "asc" ? "↑" : "↓"}
          </span>
        ) : (
          <span
            className="text-slate-600 text-[1.1em] leading-none"
            style={{ fontVariantEmoji: "text" }}
          >
            ↕
          </span>
        )}
      </button>
    </th>
  );
}

/** Whether any network in the entry list has virtual pools (controls Source column visibility). */
function hasAnyVirtualPools(entries: GlobalPoolEntry[]): boolean {
  return entries.some((e) => e.network.hasVirtualPools);
}

interface GlobalPoolsTableProps {
  entries: GlobalPoolEntry[];
  /**
   * Volume map keyed by `${network.id}:${pool.id}`.
   * Use `globalPoolKey()` to build keys when constructing this map.
   */
  volume24hByKey?: Map<string, number | null | undefined>;
  volume24hLoading?: boolean;
  volume24hError?: boolean;
  volume7dByKey?: Map<string, number | null | undefined>;
  volume7dLoading?: boolean;
  volume7dError?: boolean;
}

export function GlobalPoolsTable({
  entries,
  volume24hByKey,
  volume24hLoading = false,
  volume24hError = false,
  volume7dByKey,
  volume7dLoading = false,
  volume7dError = false,
}: GlobalPoolsTableProps) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const [sortKey, setSortKey] = useState<GlobalSortKey>("tvl");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const tvlByKey = useMemo(
    () =>
      new Map(
        entries.map((e) => [globalPoolKey(e), poolTvlUSD(e.pool, e.network)]),
      ),
    [entries],
  );

  const totalVolumeByKey = useMemo(
    () =>
      new Map(
        entries.map((e) => [
          globalPoolKey(e),
          poolTotalVolumeUSD(e.pool, e.network),
        ]),
      ),
    [entries],
  );

  const handleSort = (key: GlobalSortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const sortedEntries = useMemo(
    () =>
      sortGlobalPools(entries, sortKey, sortDir, {
        tvlByKey,
        totalVolumeByKey,
        volume24hByKey,
        volume7dByKey,
      }),
    [
      entries,
      sortKey,
      sortDir,
      tvlByKey,
      totalVolumeByKey,
      volume24hByKey,
      volume7dByKey,
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
            <SortableTh
              sortKey="chain"
              activeSortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
            >
              Chain
            </SortableTh>
            {showVirtualPoolSource && <Th>Source</Th>}
            <SortableTh
              sortKey="health"
              activeSortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
            >
              Health
            </SortableTh>
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
              sortKey="volume24h"
              activeSortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
              className="hidden md:table-cell"
            >
              24h Volume
            </SortableTh>
            <SortableTh
              sortKey="volume7d"
              activeSortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
              className="hidden md:table-cell"
            >
              7d Volume
            </SortableTh>
            <SortableTh
              sortKey="totalVolume"
              activeSortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
              className="hidden md:table-cell"
            >
              Total Volume
            </SortableTh>
            <SortableTh
              sortKey="swaps"
              activeSortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
              align="right"
              className="hidden lg:table-cell"
            >
              Swaps
            </SortableTh>
            <SortableTh
              sortKey="rebalances"
              activeSortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
              align="right"
              className="hidden lg:table-cell"
            >
              Rebalances
            </SortableTh>
            <th
              scope="col"
              className="hidden sm:table-cell px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium text-slate-400 text-left"
            >
              Rebalancer
            </th>
          </tr>
        </thead>
        <tbody>
          {sortedEntries.map((e) => {
            const { pool: p, network } = e;
            const key = globalPoolKey(e);
            const healthStatus = computeHealthStatus(p, network.chainId);
            const limitStatus = p.limitStatus ?? computeLimitStatus(p);
            const effectiveStatus = worstStatus(healthStatus, limitStatus);
            const rebalancerStatus = computeRebalancerLiveness(
              { ...p, healthStatus },
              nowSeconds,
            );
            const tvl = tvlByKey.get(key) ?? 0;
            const vol24h = volume24hByKey?.get(key);
            const vol7d = volume7dByKey?.get(key);
            const totalVol = totalVolumeByKey.get(key);
            // Build pool detail link preserving network param when non-default
            const poolHref = `/pool/${encodeURIComponent(p.id)}?network=${network.id}`;
            return (
              <Row key={key}>
                <td className="px-2 sm:px-4 py-2 sm:py-3">
                  <Link
                    href={poolHref}
                    className="font-semibold text-sm sm:text-base text-indigo-400 hover:text-indigo-300"
                  >
                    {poolName(network, p.token0, p.token1)}
                  </Link>
                </td>
                <td className="px-2 sm:px-4 py-2 sm:py-3 text-sm text-slate-400 whitespace-nowrap">
                  {network.label}
                </td>
                {showVirtualPoolSource && (
                  <td className="px-2 sm:px-4 py-2 sm:py-3">
                    {network.hasVirtualPools ? (
                      <SourceBadge source={p.source} />
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
                <td className="hidden sm:table-cell px-2 sm:px-4 py-2 sm:py-3 text-sm text-slate-200 font-mono">
                  {tvl > 0 ? formatUSD(tvl) : "—"}
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
                <td className="hidden lg:table-cell px-2 sm:px-4 py-2 sm:py-3 text-sm text-slate-200 font-mono text-right">
                  {p.swapCount ?? 0}
                </td>
                <td className="hidden lg:table-cell px-2 sm:px-4 py-2 sm:py-3 text-sm text-slate-200 font-mono text-right">
                  {p.rebalanceCount ?? 0}
                </td>
                <td className="hidden sm:table-cell px-2 sm:px-4 py-2 sm:py-3">
                  <span title={rebalancerTooltip(rebalancerStatus)}>
                    <RebalancerBadge status={rebalancerStatus} />
                  </span>
                </td>
              </Row>
            );
          })}
        </tbody>
      </Table>
    </>
  );
}
