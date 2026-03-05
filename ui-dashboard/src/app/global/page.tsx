"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useGQL } from "@/lib/graphql";
import { ALL_POOLS_WITH_HEALTH, GLOBAL_AGGREGATES } from "@/lib/queries";
import {
  truncateAddress,
  relativeTime,
  formatTimestamp,
  formatWei,
} from "@/lib/format";
import { poolName } from "@/lib/tokens";
import { useNetwork } from "@/components/network-provider";
import type { Pool } from "@/lib/types";
import { Table, Row, Th, Td } from "@/components/table";
import { Skeleton, EmptyBox, ErrorBox, Tile } from "@/components/feedback";
import { SourceBadge, HealthBadge } from "@/components/badges";

export default function GlobalPage() {
  return (
    <Suspense>
      <GlobalContent />
    </Suspense>
  );
}

type AggregateResponse = {
  Pool_aggregate: { aggregate: { count: number } };
  SwapEvent_aggregate: { aggregate: { count: number } };
};

function GlobalContent() {
  const { network } = useNetwork();

  const {
    data: poolsData,
    error: poolsErr,
    isLoading: poolsLoading,
  } = useGQL<{ Pool: Pool[] }>(ALL_POOLS_WITH_HEALTH);

  const {
    data: aggData,
    error: aggErr,
    isLoading: aggLoading,
  } = useGQL<AggregateResponse>(GLOBAL_AGGREGATES);

  const pools = poolsData?.Pool ?? [];
  const totalSwaps = aggData?.SwapEvent_aggregate?.aggregate?.count ?? 0;

  const fpmmPools = pools.filter((p) => p.source.includes("fpmm"));
  const virtualPools = pools.filter((p) => !p.source.includes("fpmm"));

  const okCount = pools.filter((p) => p.healthStatus === "OK").length;
  const warnCount = pools.filter((p) => p.healthStatus === "WARN").length;
  const critCount = pools.filter((p) => p.healthStatus === "CRITICAL").length;
  const naCount = pools.filter(
    (p) => !p.healthStatus || p.healthStatus === "N/A",
  ).length;

  const loading = poolsLoading || aggLoading;
  const error = poolsErr || aggErr;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white mb-1">Global Overview</h1>
        <p className="text-sm text-slate-400">
          Protocol-wide statistics across all pools
        </p>
      </div>

      {error && (
        <ErrorBox message={`Failed to load data: ${error.message}`} />
      )}

      {/* Summary tiles */}
      <section>
        <h2 className="text-lg font-semibold text-white mb-3">Summary</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Tile
            label="Total Pools"
            value={loading ? "…" : String(pools.length)}
          />
          <Tile
            label="FPMM Pools"
            value={loading ? "…" : String(fpmmPools.length)}
          />
          <Tile
            label="Virtual Pools"
            value={loading ? "…" : String(virtualPools.length)}
          />
          <Tile
            label="Total Swaps"
            value={loading ? "…" : totalSwaps.toLocaleString()}
          />
        </div>
      </section>

      {/* Health breakdown */}
      <section>
        <h2 className="text-lg font-semibold text-white mb-3">
          Health Status
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Tile label="🟢 OK" value={loading ? "…" : String(okCount)} />
          <Tile label="🟡 WARN" value={loading ? "…" : String(warnCount)} />
          <Tile
            label="🔴 CRITICAL"
            value={loading ? "…" : String(critCount)}
          />
          <Tile label="⚪ N/A" value={loading ? "…" : String(naCount)} />
        </div>
      </section>

      {/* All pools table */}
      <section>
        <h2 className="text-lg font-semibold text-white mb-3">All Pools</h2>
        {poolsLoading ? (
          <Skeleton rows={5} />
        ) : pools.length === 0 ? (
          <EmptyBox message="No pools found." />
        ) : (
          <AllPoolsTable pools={pools} />
        )}
      </section>

      {/* Activity summary */}
      <section>
        <h2 className="text-lg font-semibold text-white mb-3">
          Pool Activity
        </h2>
        {poolsLoading ? (
          <Skeleton rows={5} />
        ) : pools.length === 0 ? (
          <EmptyBox message="No pools found." />
        ) : (
          <ActivityTable pools={pools} />
        )}
      </section>
    </div>
  );
}

function AllPoolsTable({ pools }: { pools: Pool[] }) {
  const { network } = useNetwork();
  return (
    <Table>
      <thead>
        <tr className="border-b border-slate-800 bg-slate-900/50">
          <Th>Pool</Th>
          <Th>Type</Th>
          <Th>Status</Th>
          <Th>Address</Th>
          <Th>Created</Th>
          <Th>Updated</Th>
        </tr>
      </thead>
      <tbody>
        {pools.map((p) => (
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
            <Td mono muted small title={p.id}>
              {truncateAddress(p.id)}
            </Td>
            <Td muted title={formatTimestamp(p.createdAtTimestamp)}>
              {relativeTime(p.createdAtTimestamp)}
            </Td>
            <Td muted title={formatTimestamp(p.updatedAtTimestamp)}>
              {relativeTime(p.updatedAtTimestamp)}
            </Td>
          </Row>
        ))}
      </tbody>
    </Table>
  );
}

function ActivityTable({ pools }: { pools: Pool[] }) {
  const { network } = useNetwork();
  // Sort by swap count descending
  const sorted = [...pools].sort(
    (a, b) => (b.swapCount ?? 0) - (a.swapCount ?? 0),
  );
  return (
    <Table>
      <thead>
        <tr className="border-b border-slate-800 bg-slate-900/50">
          <Th>Pool</Th>
          <Th>Type</Th>
          <Th align="right">Swaps</Th>
          <Th align="right">Rebalances</Th>
          <Th align="right">Volume (Token 0)</Th>
          <Th align="right">Volume (Token 1)</Th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((p) => (
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
            <Td mono small align="right">
              {p.swapCount ?? 0}
            </Td>
            <Td mono small align="right">
              {p.rebalanceCount ?? 0}
            </Td>
            <Td mono small align="right">
              {p.notionalVolume0 ? formatWei(p.notionalVolume0) : "—"}
            </Td>
            <Td mono small align="right">
              {p.notionalVolume1 ? formatWei(p.notionalVolume1) : "—"}
            </Td>
          </Row>
        ))}
      </tbody>
    </Table>
  );
}
