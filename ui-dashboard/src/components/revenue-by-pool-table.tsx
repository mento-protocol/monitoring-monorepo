"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { formatUSD, truncateAddress } from "@/lib/format";
import { poolName } from "@/lib/tokens";
import { Table, Row } from "@/components/table";
import { SortableTh } from "@/components/sortable-th";
import { ChainIcon } from "@/components/chain-icon";
import {
  aggregateProtocolFeesByPool,
  type PoolFeeEntry,
} from "@/lib/protocol-fees";
import { buildPoolDetailHref } from "@/lib/routing";
import type { NetworkData, PoolLabel } from "@/lib/fetch-all-networks";
import type { Network } from "@/lib/networks";
import type { SortDir } from "@/lib/table-sort";

type PoolFeeRow = PoolFeeEntry & {
  network: Network;
  label: PoolLabel | null;
};

type SortKey = "pool" | "chain" | "fees24h" | "fees7d" | "fees30d" | "feesAll";

interface RevenueByPoolTableProps {
  networkData: NetworkData[];
  isLoading: boolean;
  hasError: boolean;
  /** When true, prefix USD values with `≈` (chain-level truncation or unpriced symbols upstream). */
  isApproximate?: boolean;
}

function buildRows(networkData: NetworkData[]): PoolFeeRow[] {
  const rows: PoolFeeRow[] = [];
  for (const n of networkData) {
    if (n.error !== null) continue;
    const entries = aggregateProtocolFeesByPool(n.feeTransfers, n.rates);
    for (const e of entries) {
      rows.push({
        ...e,
        network: n.network,
        label: n.poolLabels.get(e.poolAddress) ?? null,
      });
    }
  }
  return rows;
}

function rowSortValue(row: PoolFeeRow, key: SortKey): number | string | null {
  switch (key) {
    case "pool":
      return row.label
        ? poolName(row.network, row.label.token0, row.label.token1)
        : truncateAddress(row.poolAddress);
    case "chain":
      return row.network.label;
    case "fees24h":
      return row.fees24hUSD;
    case "fees7d":
      return row.fees7dUSD;
    case "fees30d":
      return row.fees30dUSD;
    case "feesAll":
      return row.totalFeesUSD;
  }
}

function sortRows(
  rows: PoolFeeRow[],
  sortKey: SortKey,
  sortDir: SortDir,
): PoolFeeRow[] {
  return [...rows].sort((a, b) => {
    const aV = rowSortValue(a, sortKey);
    const bV = rowSortValue(b, sortKey);
    // Null / missing values sink to the bottom regardless of direction —
    // matches `sortGlobalPools` in `global-pools-table.tsx`.
    if (aV == null && bV == null) return 0;
    if (aV == null) return 1;
    if (bV == null) return -1;

    if (typeof aV === "string" && typeof bV === "string") {
      const cmp = aV.localeCompare(bV);
      return sortDir === "asc" ? cmp : -cmp;
    }
    if (typeof aV === "number" && typeof bV === "number") {
      return sortDir === "asc" ? aV - bV : bV - aV;
    }
    return 0;
  });
}

export function RevenueByPoolTable({
  networkData,
  isLoading,
  hasError,
  isApproximate = false,
}: RevenueByPoolTableProps) {
  const rows = useMemo(() => buildRows(networkData), [networkData]);
  const [sortKey, setSortKey] = useState<SortKey>("fees7d");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const handleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const sorted = useMemo(
    () => sortRows(rows, sortKey, sortDir),
    [rows, sortKey, sortDir],
  );

  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-lg font-semibold text-white">
          Swap Fees by Pool{" "}
          <span className="ml-2 text-xs font-normal text-slate-500">
            Sortable across windows
          </span>
        </h2>
      </div>
      {hasError ? (
        <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-6 text-sm text-slate-400">
          Couldn&apos;t load per-pool revenue.
        </div>
      ) : isLoading ? (
        <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-6 text-sm text-slate-500">
          Loading…
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-6 text-sm text-slate-500">
          No swap-fee transfers indexed yet.
        </div>
      ) : (
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
                className="hidden sm:table-cell"
              >
                Chain
              </SortableTh>
              <SortableTh
                sortKey="fees24h"
                activeSortKey={sortKey}
                sortDir={sortDir}
                onSort={handleSort}
                align="right"
              >
                24h
              </SortableTh>
              <SortableTh
                sortKey="fees7d"
                activeSortKey={sortKey}
                sortDir={sortDir}
                onSort={handleSort}
                align="right"
              >
                7d
              </SortableTh>
              <SortableTh
                sortKey="fees30d"
                activeSortKey={sortKey}
                sortDir={sortDir}
                onSort={handleSort}
                align="right"
                className="hidden sm:table-cell"
              >
                30d
              </SortableTh>
              <SortableTh
                sortKey="feesAll"
                activeSortKey={sortKey}
                sortDir={sortDir}
                onSort={handleSort}
                align="right"
                className="hidden md:table-cell"
              >
                All-time
              </SortableTh>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => {
              const label = row.label;
              const display = label
                ? poolName(row.network, label.token0, label.token1)
                : truncateAddress(row.poolAddress);
              const href = buildPoolDetailHref(row.poolId);
              const prefix = row.unpriced || isApproximate ? "≈ " : "";
              const approxTitle = row.unpriced
                ? "Some transfers from this pool used unpriced/unknown tokens — total is a lower bound."
                : isApproximate
                  ? "Chain-level totals upstream are approximate."
                  : undefined;
              return (
                <Row key={row.poolId}>
                  <td className="px-2 sm:px-4 py-2 sm:py-3">
                    <div className="flex items-center gap-2">
                      <ChainIcon network={row.network} />
                      <Link
                        href={href}
                        className="font-semibold text-sm sm:text-base text-indigo-400 hover:text-indigo-300"
                      >
                        {display}
                      </Link>
                    </div>
                  </td>
                  <td
                    className="hidden sm:table-cell px-2 sm:px-4 py-1.5 sm:py-2 text-xs sm:text-sm text-slate-400"
                    title={row.network.label}
                  >
                    {row.network.label}
                  </td>
                  <td
                    className="px-2 sm:px-4 py-1.5 sm:py-2 text-xs sm:text-sm text-slate-300 font-mono text-right"
                    title={approxTitle}
                  >
                    {prefix}
                    {formatUSD(row.fees24hUSD)}
                  </td>
                  <td
                    className="px-2 sm:px-4 py-1.5 sm:py-2 text-xs sm:text-sm text-slate-300 font-mono text-right"
                    title={approxTitle}
                  >
                    {prefix}
                    {formatUSD(row.fees7dUSD)}
                  </td>
                  <td
                    className="hidden sm:table-cell px-2 sm:px-4 py-1.5 sm:py-2 text-xs sm:text-sm text-slate-300 font-mono text-right"
                    title={approxTitle}
                  >
                    {prefix}
                    {formatUSD(row.fees30dUSD)}
                  </td>
                  <td
                    className="hidden md:table-cell px-2 sm:px-4 py-1.5 sm:py-2 text-xs sm:text-sm text-slate-300 font-mono text-right"
                    title={approxTitle}
                  >
                    {prefix}
                    {formatUSD(row.totalFeesUSD)}
                  </td>
                </Row>
              );
            })}
          </tbody>
        </Table>
      )}
    </section>
  );
}
