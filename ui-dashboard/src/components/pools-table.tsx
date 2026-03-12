"use client";

import { useMemo } from "react";
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
  ORACLE_STALE_SECONDS,
} from "@/lib/health";
import type { RebalancerStatus } from "@/lib/health";
import { poolTotalVolumeUSD } from "@/lib/volume";

// Status severity ordering: N/A < OK < WARN < CRITICAL
const STATUS_RANK: Record<string, number> = {
  "N/A": 0,
  OK: 1,
  WARN: 2,
  CRITICAL: 3,
};

function worstStatus(a: string, b: string): string {
  return (STATUS_RANK[a] ?? 0) >= (STATUS_RANK[b] ?? 0) ? a : b;
}

function healthTooltip(status: string, p: Pool): string {
  if (status === "N/A") return "VirtualPool — oracle health not tracked";
  const oracleTs = Number(p.oracleTimestamp ?? "0");
  const isOracleStale =
    oracleTs === 0 ||
    Math.floor(Date.now() / 1000) - oracleTs > ORACLE_STALE_SECONDS;
  if (status === "CRITICAL" && isOracleStale)
    return "Oracle stale — last update expired";
  if (status === "CRITICAL") return "Price deviation ≥ rebalance threshold";
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
  const hTip = healthTooltip(healthStatus, p);
  const lFrag = limitTooltipFragment(limitStatus, p, network);
  if (lFrag) return `${hTip} · ${lFrag}`;
  return hTip;
}

function rebalancerTooltip(status: RebalancerStatus): string {
  if (status === "ACTIVE")
    return "Rebalancer active — last rebalance within 24h";
  if (status === "STALE")
    return "No rebalance in 24h while pool health is not OK";
  if (status === "NO_DATA") return "No rebalance events recorded yet";
  return "VirtualPool — rebalancer not applicable";
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
  return (
    <Table>
      <thead>
        <tr className="border-b border-slate-800 bg-slate-900/50">
          <Th>Pool</Th>
          {network.hasVirtualPools && <Th>Source</Th>}
          <Th>Health</Th>
          <th
            scope="col"
            className="hidden sm:table-cell px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium text-slate-400 text-left"
          >
            TVL
          </th>
          <th
            scope="col"
            className="hidden md:table-cell px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium text-slate-400 text-left"
          >
            24h Volume
          </th>
          <th
            scope="col"
            className="hidden md:table-cell px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium text-slate-400 text-left"
          >
            Total Volume
          </th>
          <th
            scope="col"
            className="hidden lg:table-cell px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium text-slate-400 text-right"
          >
            Swaps
          </th>
          <th
            scope="col"
            className="hidden lg:table-cell px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium text-slate-400 text-right"
          >
            Rebalances
          </th>
          <th
            scope="col"
            className="hidden sm:table-cell px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium text-slate-400 text-left"
          >
            Rebalancer
          </th>
        </tr>
      </thead>
      <tbody>
        {pools.map((p) => {
          const healthStatus = computeHealthStatus(p);
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
                <span
                  title={combinedTooltip(healthStatus, limitStatus, p, network)}
                >
                  <HealthBadge status={effectiveStatus} />
                </span>
              </td>
              <td className="hidden sm:table-cell px-2 sm:px-4 py-2 sm:py-3 text-xs text-slate-300 font-mono">
                {tvl > 0 ? formatUSD(tvl) : "—"}
              </td>
              <td className="hidden md:table-cell px-2 sm:px-4 py-2 sm:py-3 text-xs text-slate-300 font-mono">
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
              <td className="hidden md:table-cell px-2 sm:px-4 py-2 sm:py-3 text-xs text-slate-300 font-mono">
                {totalVol == null
                  ? "—"
                  : totalVol > 0
                    ? formatUSD(totalVol)
                    : "—"}
              </td>
              <td className="hidden lg:table-cell px-2 sm:px-4 py-2 sm:py-3 text-xs text-slate-300 font-mono text-right">
                {p.swapCount ?? 0}
              </td>
              <td className="hidden lg:table-cell px-2 sm:px-4 py-2 sm:py-3 text-xs text-slate-300 font-mono text-right">
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
