"use client";

import Link from "next/link";
import { relativeTime, formatTimestamp } from "@/lib/format";
import { poolName } from "@/lib/tokens";
import { useNetwork } from "@/components/network-provider";
import type { Pool } from "@/lib/types";
import { Table, Row, Th, Td } from "@/components/table";
import {
  SourceBadge,
  HealthBadge,
  LimitBadge,
  RebalancerBadge,
} from "@/components/badges";
import { AddressLink } from "@/components/address-link";
import {
  computeHealthStatus,
  computeLimitStatus,
  computeRebalancerLiveness,
} from "@/lib/health";
import type { RebalancerStatus } from "@/lib/health";

function healthTooltip(p: Pool): string {
  const status = p.healthStatus ?? "N/A";
  if (status === "N/A") return "VirtualPool — oracle health not tracked";
  if (status === "CRITICAL" && p.oracleOk === false)
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
  return "VirtualPool — rebalancer not applicable";
}

interface PoolsTableProps {
  pools: Pool[];
}

export function PoolsTable({ pools }: PoolsTableProps) {
  const { network } = useNetwork();
  const nowSeconds = Math.floor(Date.now() / 1000);
  return (
    <Table>
      <thead>
        <tr className="border-b border-slate-800 bg-slate-900/50">
          <Th>Pool</Th>
          <Th>Type</Th>
          <Th>Status</Th>
          <Th>Limit</Th>
          <th
            scope="col"
            className="hidden sm:table-cell px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium text-slate-400"
          >
            Rebalancer
          </th>
          <th
            scope="col"
            className="hidden md:table-cell px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium text-slate-400"
          >
            Address
          </th>
          <th
            scope="col"
            className="hidden lg:table-cell px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium text-slate-400"
          >
            Created
          </th>
          <Th>Updated</Th>
        </tr>
      </thead>
      <tbody>
        {pools.map((p) => {
          const limitStatus = p.limitStatus ?? computeLimitStatus(p);
          const rebalancerStatus = computeRebalancerLiveness(p, nowSeconds);
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
              <td className="px-2 sm:px-4 py-2 sm:py-3">
                <SourceBadge source={p.source} />
              </td>
              <td className="px-2 sm:px-4 py-2 sm:py-3">
                <span title={healthTooltip(p)}>
                  <HealthBadge status={computeHealthStatus(p)} />
                </span>
              </td>
              <td className="px-2 sm:px-4 py-2 sm:py-3">
                <span title={limitTooltip(limitStatus)}>
                  <LimitBadge status={limitStatus} />
                </span>
              </td>
              <td className="hidden sm:table-cell px-2 sm:px-4 py-2 sm:py-3">
                <span title={rebalancerTooltip(rebalancerStatus)}>
                  <RebalancerBadge status={rebalancerStatus} />
                </span>
              </td>
              <td className="hidden md:table-cell px-2 sm:px-4 py-2 sm:py-3 text-[10px] sm:text-xs text-slate-300">
                <AddressLink address={p.id} />
              </td>
              <td
                className="hidden lg:table-cell px-2 sm:px-4 py-2 sm:py-3 text-[10px] sm:text-xs text-slate-400"
                title={formatTimestamp(p.createdAtTimestamp)}
              >
                {relativeTime(p.createdAtTimestamp)}
              </td>
              <Td muted title={formatTimestamp(p.updatedAtTimestamp)}>
                {relativeTime(p.updatedAtTimestamp)}
              </Td>
            </Row>
          );
        })}
      </tbody>
    </Table>
  );
}
