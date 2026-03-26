"use client";

import { useMemo, useState } from "react";
import { NetworkAwareLink } from "@/components/network-aware-link";
import { formatUSD } from "@/lib/format";
import { poolName, poolTvlUSD } from "@/lib/tokens";
import { useNetwork } from "@/components/network-provider";
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

export type SortKey =
  | "pool"
  | "health"
  | "tvl"
  | "volume24h"
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

export interface SortContext {
  network: ReturnType<typeof useNetwork>["network"];
  tvlByPoolId: Map<string, number>;
  totalVolumeByPoolId: Map<string, number | null>;
  volume24h?: Map<string, number | null>;
}

export function sortPools(
  pools: Pool[],
  sortKey: SortKey,
  sortDir: SortDir,
  { network, tvlByPoolId, totalVolumeByPoolId, volume24h }: SortContext,
): Pool[] {
  return [...pools].sort((a, b) => {
    let cmp = 0;
    switch (sortKey) {
      case "pool":
        cmp = poolName(network, a.token0, a.token1).localeCompare(
          poolName(network, b.token0, b.token1),
        );
        break;
      case "health": {
        const aH = worstStatus(
          computeHealthStatus(a, network.chainId),
          a.limitStatus ?? computeLimitStatus(a),
        );
        const bH = worstStatus(
          computeHealthStatus(b, network.chainId),
          b.limitStatus ?? computeLimitStatus(b),
        );
        cmp = (HEALTH_ORDER[aH] ?? 99) - (HEALTH_ORDER[bH] ?? 99);
        break;
      }
      case "tvl":
        cmp = (tvlByPoolId.get(a.id) ?? 0) - (tvlByPoolId.get(b.id) ?? 0);
        break;
      case "volume24h": {
        const aV = volume24h?.get(a.id) ?? 0;
        const bV = volume24h?.get(b.id) ?? 0;
        cmp = (aV ?? 0) - (bV ?? 0);
        break;
      }
      case "totalVolume":
        cmp =
          (totalVolumeByPoolId.get(a.id) ?? 0) -
          (totalVolumeByPoolId.get(b.id) ?? 0);
        break;
      case "swaps":
        cmp = (a.swapCount ?? 0) - (b.swapCount ?? 0);
        break;
      case "rebalances":
        cmp = (a.rebalanceCount ?? 0) - (b.rebalanceCount ?? 0);
        break;
    }
    return sortDir === "asc" ? cmp : -cmp;
  });
}

interface SortableThProps {
  sortKey: SortKey;
  activeSortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
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
          <span className="text-slate-600">↕</span>
        )}
      </button>
    </th>
  );
}

interface PoolsTableProps {
  pools: Pool[];
  volume24h?: Map<string, number | null>;
  volume24hLoading?: boolean;
  volume24hError?: boolean;
  olsPoolIds?: Set<string>;
}

export function PoolsTable({
  pools,
  volume24h,
  volume24hLoading = false,
  volume24hError = false,
  olsPoolIds,
}: PoolsTableProps) {
  const { network } = useNetwork();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const [sortKey, setSortKey] = useState<SortKey>("totalVolume");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const tvlByPoolId = useMemo(
    () => new Map(pools.map((pool) => [pool.id, poolTvlUSD(pool, network)])),
    [pools, network],
  );
  const totalVolumeByPoolId = useMemo(
    () =>
      new Map(
        pools.map((pool) => [pool.id, poolTotalVolumeUSD(pool, network)]),
      ),
    [pools, network],
  );

  const handleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const sortedPools = useMemo(
    () =>
      sortPools(pools, sortKey, sortDir, {
        network,
        tvlByPoolId,
        totalVolumeByPoolId,
        volume24h,
      }),
    [
      pools,
      sortKey,
      sortDir,
      tvlByPoolId,
      totalVolumeByPoolId,
      volume24h,
      network,
    ],
  );

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
            {network.hasVirtualPools && <Th>Source</Th>}
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
            {olsPoolIds && (
              <th
                scope="col"
                className="hidden sm:table-cell px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium text-slate-400 text-left"
              >
                OLS
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {sortedPools.map((p) => {
            const healthStatus = computeHealthStatus(p, network.chainId);
            const limitStatus = p.limitStatus ?? computeLimitStatus(p);
            const effectiveStatus = worstStatus(healthStatus, limitStatus);
            const rebalancerStatus = computeRebalancerLiveness(
              { ...p, healthStatus },
              nowSeconds,
            );
            const tvl = tvlByPoolId.get(p.id) ?? 0;
            const vol24h = volume24h?.get(p.id);
            const totalVol = totalVolumeByPoolId.get(p.id);
            return (
              <Row key={p.id}>
                <td className="px-2 sm:px-4 py-2 sm:py-3">
                  <NetworkAwareLink
                    href={`/pool/${encodeURIComponent(p.id)}`}
                    className="font-semibold text-sm sm:text-base text-indigo-400 hover:text-indigo-300"
                  >
                    {poolName(network, p.token0, p.token1)}
                  </NetworkAwareLink>
                </td>
                {network.hasVirtualPools && (
                  <td className="px-2 sm:px-4 py-2 sm:py-3">
                    <SourceBadge source={p.source} />
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
                {olsPoolIds && (
                  <td className="hidden sm:table-cell px-2 sm:px-4 py-2 sm:py-3">
                    {olsPoolIds.has(p.id) && (
                      <span className="inline-flex items-center rounded-full bg-purple-900/60 px-2 py-0.5 text-xs font-medium text-purple-300 ring-1 ring-purple-700/50">
                        OLS
                      </span>
                    )}
                  </td>
                )}
              </Row>
            );
          })}
        </tbody>
      </Table>
    </>
  );
}
