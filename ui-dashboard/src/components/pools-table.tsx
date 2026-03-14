"use client";

import { useMemo, useState } from "react";
import { NetworkAwareLink } from "@/components/network-aware-link";
import { formatUSD } from "@/lib/format";
import { poolName, poolTvlUSD, tokenSymbol } from "@/lib/tokens";
import { useNetwork } from "@/components/network-provider";
import type { Pool } from "@/lib/types";
import { Table, Row, Th } from "@/components/table";
import { SourceBadge, HealthBadge, RebalancerBadge } from "@/components/badges";
import {
  computeHealthStatus,
  computeLimitStatus,
  computeRebalancerLiveness,
  worstStatus,
  ORACLE_STALE_SECONDS_BY_CHAIN,
} from "@/lib/health";
import type { RebalancerStatus } from "@/lib/health";
import { poolTotalVolumeUSD } from "@/lib/volume";

function healthTooltip(status: string, p: Pool, chainId?: number): string {
  if (status === "N/A") return "VirtualPool — oracle health not tracked";
  const oracleTs = Number(p.oracleTimestamp ?? "0");
  // Mirror computeHealthStatus: use the indexed per-feed expiry, falling back to the
  // per-chain default so the tooltip root-cause matches the badge on non-300s networks.
  const chainFallback =
    (chainId !== undefined ? ORACLE_STALE_SECONDS_BY_CHAIN[chainId] : undefined) ?? 300;
  const stalenessThreshold =
    Number(p.oracleExpiry ?? "0") || chainFallback;
  const isOracleStale =
    oracleTs === 0 ||
    Math.floor(Date.now() / 1000) - oracleTs > stalenessThreshold;
  if (status === "CRITICAL" && isOracleStale)
    return "Oracle stale — last update expired";
  if (status === "CRITICAL")
    return "Needs rebalance: price deviation ≥ threshold";
  if (status === "WARN") return "Price deviation ≥ 80% of rebalance threshold";
  return "Oracle healthy";
}

function limitTooltipFragment(
  limitStatus: string,
  p: Pool,
  network: ReturnType<typeof useNetwork>["network"],
): string | null {
  if (limitStatus === "N/A" || limitStatus === "OK") return null;
  const p0 = Number(p.limitPressure0 ?? "0");
  const p1 = Number(p.limitPressure1 ?? "0");
  const sym0 = tokenSymbol(network, p.token0 ?? null);
  const sym1 = tokenSymbol(network, p.token1 ?? null);
  const parts: string[] = [];
  if (p0 > 0) parts.push(`${sym0} at ${(p0 * 100).toFixed(0)}%`);
  if (p1 > 0) parts.push(`${sym1} at ${(p1 * 100).toFixed(0)}%`);
  const detail = parts.length > 0 ? ` (${parts.join(" · ")})` : "";
  if (limitStatus === "CRITICAL") return `Trading limit breached${detail}`;
  return `Trading limit pressure ≥ 80%${detail}`;
}

function combinedTooltip(
  healthStatus: string,
  limitStatus: string,
  p: Pool,
  network: ReturnType<typeof useNetwork>["network"],
): string {
  const hTip = healthTooltip(healthStatus, p, network.chainId);
  const lFrag = limitTooltipFragment(limitStatus, p, network);
  return lFrag ? `${hTip} · ${lFrag}` : hTip;
}

function rebalancerTooltip(status: RebalancerStatus): string {
  if (status === "ACTIVE")
    return "Rebalancer active — last rebalance within 24h";
  if (status === "STALE")
    return "No rebalance in 24h while pool health is not OK";
  if (status === "NO_DATA") return "No rebalance events recorded yet";
  return "VirtualPool — rebalancer not applicable";
}

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
  CRITICAL: 3,
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
}

export function PoolsTable({
  pools,
  volume24h,
  volume24hLoading = false,
  volume24hError = false,
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

  return (
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
                  title={combinedTooltip(healthStatus, limitStatus, p, network)}
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
            </Row>
          );
        })}
      </tbody>
    </Table>
  );
}
