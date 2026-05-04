"use client";

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { formatUSD, truncateAddress } from "@/lib/format";
import { poolName } from "@/lib/tokens";
import { Table, Row } from "@/components/table";
import { SortableTh } from "@/components/sortable-th";
import { ChainIcon } from "@/components/chain-icon";
import {
  aggregateProtocolFeesByPool,
  PROTOCOL_FEE_QUERY_LIMIT,
  type PoolFeeEntry,
} from "@/lib/protocol-fees";
import { buildPoolDetailHref } from "@/lib/routing";
import type { NetworkData, PoolLabel } from "@/lib/fetch-all-networks";
import type { Network } from "@/lib/networks";
import type { SortDir } from "@/lib/table-sort";

type PoolFeeRow = PoolFeeEntry & {
  network: Network;
  label: PoolLabel | null;
  /**
   * Per-window truncation flags. A window is truncated when the chain hit
   * the row-cap AND the oldest returned transfer's timestamp is more recent
   * than the window's lower bound — i.e. the cap clipped data inside the
   * window, so its total is a lower bound. Rows return newest-first, so
   * shorter windows usually stay clean even when the chain is capped, but
   * this is NOT guaranteed: a chain that crosses the cap inside 30d (or
   * even 7d/24h on extreme volume) flips the corresponding flag.
   */
  truncated24h: boolean;
  truncated7d: boolean;
  truncated30d: boolean;
  truncatedAll: boolean;
};

type SortKey = "pool" | "chain" | "fees24h" | "fees7d" | "fees30d" | "feesAll";

interface RevenueByPoolTableProps {
  networkData: NetworkData[];
  isLoading: boolean;
  hasError: boolean;
}

type FeeColumn = {
  key: Extract<SortKey, "fees24h" | "fees7d" | "fees30d" | "feesAll">;
  label: string;
  field: "fees24hUSD" | "fees7dUSD" | "fees30dUSD" | "totalFeesUSD";
  /** Per-column unpriced flag — scoped so an OLD unpriced transfer doesn't
   *  pollute recent windows. `feesAll` falls back to the all-history flag. */
  unpricedField: "unpriced24h" | "unpriced7d" | "unpriced30d" | "unpriced";
  /** Per-column truncation flag — scoped so a chain capped only on the
   *  All-time column doesn't surface ≈ on its recent-window cells. */
  truncatedField:
    | "truncated24h"
    | "truncated7d"
    | "truncated30d"
    | "truncatedAll";
  className?: string;
};

const FEE_COLUMNS: ReadonlyArray<FeeColumn> = [
  {
    key: "fees24h",
    label: "24h",
    field: "fees24hUSD",
    unpricedField: "unpriced24h",
    truncatedField: "truncated24h",
  },
  {
    key: "fees7d",
    label: "7d",
    field: "fees7dUSD",
    unpricedField: "unpriced7d",
    truncatedField: "truncated7d",
  },
  {
    key: "fees30d",
    label: "30d",
    field: "fees30dUSD",
    unpricedField: "unpriced30d",
    truncatedField: "truncated30d",
    className: "hidden sm:table-cell",
  },
  {
    key: "feesAll",
    label: "All-time",
    field: "totalFeesUSD",
    unpricedField: "unpriced",
    truncatedField: "truncatedAll",
    className: "hidden md:table-cell",
  },
];

function buildRows(networkData: NetworkData[]): PoolFeeRow[] {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const cutoff24h = nowSeconds - 86400;
  const cutoff7d = nowSeconds - 7 * 86400;
  const cutoff30d = nowSeconds - 30 * 86400;
  const rows: PoolFeeRow[] = [];
  for (const n of networkData) {
    // Skip both top-level transport errors and `feesError` (rates or fees
    // query rejected). The latter still has raw `feeTransfers` but an empty
    // `rates` map, so `aggregateProtocolFeesByPool` would mark every FX-pool
    // transfer as unpriced and render misleading $0 rows.
    if (n.error !== null || n.feesError !== null) continue;
    const chainTruncated = n.fees?.isTruncated ?? false;
    // `feeTransfers` is `order_by: { blockTimestamp: desc }`, so the last
    // element is the oldest returned. A window is truncated when the chain
    // is capped AND that oldest timestamp is younger than the window's lower
    // bound — i.e. the cap clipped data inside the window.
    const oldest =
      chainTruncated && n.feeTransfers.length > 0
        ? Number(n.feeTransfers[n.feeTransfers.length - 1].blockTimestamp)
        : null;
    const truncated24h =
      chainTruncated && oldest !== null && oldest > cutoff24h;
    const truncated7d = chainTruncated && oldest !== null && oldest > cutoff7d;
    const truncated30d =
      chainTruncated && oldest !== null && oldest > cutoff30d;
    const entries = aggregateProtocolFeesByPool(n.feeTransfers, n.rates);
    for (const e of entries) {
      rows.push({
        ...e,
        network: n.network,
        label: n.poolLabels.get(e.poolAddress) ?? null,
        truncated24h,
        truncated7d,
        truncated30d,
        truncatedAll: chainTruncated,
      });
    }
  }
  return rows;
}

function rowDisplayName(row: PoolFeeRow): string {
  return row.label
    ? poolName(row.network, row.label.token0, row.label.token1)
    : truncateAddress(row.poolAddress);
}

function rowSortValue(row: PoolFeeRow, key: SortKey): number | string | null {
  switch (key) {
    case "pool":
      return rowDisplayName(row);
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

function approxAnnotation(
  row: PoolFeeRow,
  column: FeeColumn,
): { prefix: string; title: string | undefined } {
  if (row[column.unpricedField]) {
    return {
      prefix: "≈ ",
      title:
        "Some transfers from this pool used unpriced/unknown tokens in this window — total is a lower bound.",
    };
  }
  if (row[column.truncatedField]) {
    return {
      prefix: "≈ ",
      title: `Chain hit the ${PROTOCOL_FEE_QUERY_LIMIT.toLocaleString()}-row query cap inside this window — total is a lower bound for this chain.`,
    };
  }
  return { prefix: "", title: undefined };
}

function EmptyShell({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-6 text-sm text-slate-400">
      {children}
    </div>
  );
}

function Heading() {
  return (
    <h2 className="mb-3 text-lg font-semibold text-white">Swap Fees by Pool</h2>
  );
}

export function RevenueByPoolTable({
  networkData,
  isLoading,
  hasError,
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

  // `buildRows` already skips chains with `error !== null`, so we render rows
  // from the chains that did succeed. Only fall back to the empty shell when
  // there's literally nothing to show.
  if (rows.length === 0) {
    if (isLoading) {
      return (
        <section>
          <Heading />
          <EmptyShell>Loading…</EmptyShell>
        </section>
      );
    }
    return (
      <section>
        <Heading />
        <EmptyShell>
          {hasError
            ? "Couldn't load per-pool revenue."
            : "No swap-fee transfers indexed yet."}
        </EmptyShell>
      </section>
    );
  }

  return (
    <section>
      <Heading />
      {hasError ? (
        <p className="mb-3 text-xs text-amber-400/80">
          One or more chains failed to load — showing partial data.
        </p>
      ) : null}
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
            {FEE_COLUMNS.map((c) => (
              <SortableTh
                key={c.key}
                sortKey={c.key}
                activeSortKey={sortKey}
                sortDir={sortDir}
                onSort={handleSort}
                align="right"
                className={c.className}
              >
                {c.label}
              </SortableTh>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const display = rowDisplayName(row);
            const href = buildPoolDetailHref(row.poolId);
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
                {FEE_COLUMNS.map((c) => {
                  const { prefix, title } = approxAnnotation(row, c);
                  return (
                    <td
                      key={c.key}
                      className={`${c.className ?? ""} px-2 sm:px-4 py-1.5 sm:py-2 text-xs sm:text-sm text-slate-300 font-mono text-right`}
                      title={title}
                    >
                      {prefix}
                      {formatUSD(row[c.field])}
                    </td>
                  );
                })}
              </Row>
            );
          })}
        </tbody>
      </Table>
    </section>
  );
}
