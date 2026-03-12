"use client";

import { useMemo } from "react";
import Link from "next/link";
import { relativeTime, formatTimestamp, formatUSD } from "@/lib/format";
import { poolName, poolTvlUSD } from "@/lib/tokens";
import { useNetwork } from "@/components/network-provider";
import type { Pool } from "@/lib/types";
import { Table, Row, Th } from "@/components/table";
import {
  SourceBadge,
  HealthBadge,
  LimitBadge,
  RebalancerBadge,
} from "@/components/badges";
import {
  computeHealthStatus,
  computeLimitStatus,
  computeRebalancerLiveness,
  ORACLE_STALE_SECONDS,
} from "@/lib/health";
import type { RebalancerStatus } from "@/lib/health";

function healthTooltip(status: string, p: Pool): string {
  if (status === "N/A") return "VirtualPool — oracle health not tracked";
  // Determine whether CRITICAL is oracle-driven or deviation-driven using
  // wall-clock oracle age (same logic as computeHealthStatus).
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

function limitTooltip(status: string): string {
  if (status === "CRITICAL") return "Trading limit breached (≥100% pressure)";
  if (status === "WARN") return "Trading limit pressure ≥ 80%";
  if (status === "OK") return "Trading limits within bounds";
  return "VirtualPool — trading limits not tracked";
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
  return (
    <Table>
      <thead>
        <tr className="border-b border-slate-800 bg-slate-900/50">
          <Th>Pool</Th>
          {network.hasVirtualPools && <Th>Source</Th>}
          <Th>Health</Th>
          <Th>Limit</Th>
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
            24h Vol
          </th>
          <th
            scope="col"
            className="hidden sm:table-cell px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium text-slate-400 text-left"
          >
            Rebalancer
          </th>
          <th
            scope="col"
            className="hidden lg:table-cell px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium text-slate-400 text-left"
          >
            Created
          </th>
        </tr>
      </thead>
      <tbody>
        {pools.map((p) => {
          const healthStatus = computeHealthStatus(p);
          const limitStatus = p.limitStatus ?? computeLimitStatus(p);
          const rebalancerStatus = computeRebalancerLiveness(
            { ...p, healthStatus },
            nowSeconds,
          );
          const tvl = tvlByPoolId.get(p.id) ?? 0;
          const vol = volume24h?.get(p.id);
          return (
            <Row key={p.id}>
              <td className="px-2 sm:px-4 py-2 sm:py-3">
                <Link
                  href={`/pool/${encodeURIComponent(p.id)}`}
                  className="font-semibold text-sm sm:text-base text-indigo-400 hover:text-indigo-300"
                >
                  {poolName(network, p.token0, p.token1)}
                </Link>
              </td>
              {network.hasVirtualPools && (
                <td className="px-2 sm:px-4 py-2 sm:py-3">
                  <SourceBadge source={p.source} />
                </td>
              )}
              <td className="px-2 sm:px-4 py-2 sm:py-3">
                <span title={healthTooltip(healthStatus, p)}>
                  <HealthBadge status={healthStatus} />
                </span>
              </td>
              <td className="px-2 sm:px-4 py-2 sm:py-3">
                <span title={limitTooltip(limitStatus)}>
                  <LimitBadge status={limitStatus} />
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
                    : vol === null
                      ? "N/A"
                      : vol && vol > 0
                        ? formatUSD(vol)
                        : "—"}
              </td>
              <td className="hidden sm:table-cell px-2 sm:px-4 py-2 sm:py-3">
                <span title={rebalancerTooltip(rebalancerStatus)}>
                  <RebalancerBadge status={rebalancerStatus} />
                </span>
              </td>
              <td
                className="hidden lg:table-cell px-2 sm:px-4 py-2 sm:py-3 text-[10px] sm:text-xs text-slate-400"
                title={formatTimestamp(p.createdAtTimestamp)}
              >
                {relativeTime(p.createdAtTimestamp)}
              </td>
            </Row>
          );
        })}
      </tbody>
    </Table>
  );
}
