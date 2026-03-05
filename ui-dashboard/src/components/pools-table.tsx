"use client";

import Link from "next/link";
import { relativeTime, formatTimestamp } from "@/lib/format";
import { poolName } from "@/lib/tokens";
import { useNetwork } from "@/components/network-provider";
import type { Pool } from "@/lib/types";
import { Table, Row, Th, Td } from "@/components/table";
import { SourceBadge, HealthBadge, LimitBadge, RebalancerBadge } from "@/components/badges";
import { AddressLink } from "@/components/address-link";
import { computeLimitStatus, computeRebalancerLiveness } from "@/lib/health";

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
          <Th>Rebalancer</Th>
          <Th>Address</Th>
          <Th>Created</Th>
          <Th>Updated</Th>
        </tr>
      </thead>
      <tbody>
        {pools.map((p) => {
          const limitStatus = p.limitStatus ?? computeLimitStatus(p);
          const rebalancerStatus = computeRebalancerLiveness(p, nowSeconds);
          return (
            <Row key={p.id}>
              <td className="px-4 py-3">
                <Link
                  href={`/pool/${encodeURIComponent(p.id)}`}
                  className="font-semibold text-indigo-400 hover:text-indigo-300"
                >
                  {poolName(network, p.token0, p.token1)}
                </Link>
              </td>
              <td className="px-4 py-3">
                <SourceBadge source={p.source} />
              </td>
              <td className="px-4 py-3">
                <HealthBadge status={p.healthStatus ?? "N/A"} />
              </td>
              <td className="px-4 py-3">
                <LimitBadge status={limitStatus} />
              </td>
              <td className="px-4 py-3">
                <RebalancerBadge status={rebalancerStatus} />
              </td>
              <Td small>
                <AddressLink address={p.id} />
              </Td>
              <Td muted title={formatTimestamp(p.createdAtTimestamp)}>
                {relativeTime(p.createdAtTimestamp)}
              </Td>
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
