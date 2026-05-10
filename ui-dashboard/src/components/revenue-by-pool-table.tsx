"use client";

import { useMemo, type ReactNode } from "react";
import Link from "next/link";
import { formatUSD, truncateAddress } from "@/lib/format";
import { poolName } from "@/lib/tokens";
import { Table, Row } from "@/components/table";
import { SortableTh } from "@/components/sortable-th";
import { ChainIcon } from "@/components/chain-icon";
import { type PoolFeeEntry } from "@/lib/protocol-fees";
import { aggregateFeeSnapshotsByPool } from "@/lib/protocol-fee-snapshots";
import { buildPoolDetailHref } from "@/lib/routing";
import type { NetworkData, PoolLabel } from "@/lib/fetch-all-networks";
import type { Network } from "@/lib/networks";
import type { SortDir } from "@/lib/table-sort";
import { useTableSort } from "@/lib/use-table-sort";

type PoolFeeRow = PoolFeeEntry & {
  network: Network;
  label: PoolLabel | null;
};

type SortKey = "pool" | "chain" | "fees24h" | "fees7d" | "fees30d" | "feesAll";

const SORT_KEYS: ReadonlySet<SortKey> = new Set([
  "pool",
  "chain",
  "fees24h",
  "fees7d",
  "fees30d",
  "feesAll",
]);

interface RevenueByPoolTableProps {
  networkData: NetworkData[];
  isLoading: boolean;
  hasError: boolean;
}

type FeeColumn = {
  key: Extract<SortKey, "fees24h" | "fees7d" | "fees30d" | "feesAll">;
  label: string;
  field: "fees24hUSD" | "fees7dUSD" | "fees30dUSD" | "totalFeesUSD";
  /** Per-column unpriced flag — scoped so an OLD unpriced snapshot doesn't
   *  pollute recent windows. `feesAll` falls back to the all-history flag. */
  unpricedField: "unpriced24h" | "unpriced7d" | "unpriced30d" | "unpriced";
  className?: string;
};

const FEE_COLUMNS: ReadonlyArray<FeeColumn> = [
  {
    key: "fees24h",
    label: "24h",
    field: "fees24hUSD",
    unpricedField: "unpriced24h",
  },
  {
    key: "fees7d",
    label: "7d",
    field: "fees7dUSD",
    unpricedField: "unpriced7d",
  },
  {
    key: "fees30d",
    label: "30d",
    field: "fees30dUSD",
    unpricedField: "unpriced30d",
    className: "hidden sm:table-cell",
  },
  {
    key: "feesAll",
    label: "All-time",
    field: "totalFeesUSD",
    unpricedField: "unpriced",
    className: "hidden md:table-cell",
  },
];

function buildRows(networkData: NetworkData[]): PoolFeeRow[] {
  const rows: PoolFeeRow[] = [];
  for (const n of networkData) {
    // Skip top-level transport errors, `ratesError` (empty rates map ⇒ FX
    // slots mis-price as unpriced and produce misleading $0 rows), and
    // `feeSnapshotsError` (the snapshot fetch itself failed, no row data).
    // All fee surfaces now read from the same snapshot data and gate on
    // the same two channels — see PR-snapshot-3.
    if (
      n.error !== null ||
      n.ratesError !== null ||
      n.feeSnapshotsError !== null
    )
      continue;
    const entries = aggregateFeeSnapshotsByPool(
      n.feeSnapshots,
      n.rates,
      n.network.chainId,
    );
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
  return rows.toSorted((a, b) => {
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
        "Some transfers from this pool used unknown tokens or tokens with no oracle rate in this window — total is a lower bound.",
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
  const { sortKey, sortDir, handleSort } = useTableSort<SortKey>({
    defaultKey: "fees7d",
    defaultDir: "desc",
    validKeys: SORT_KEYS,
    paramPrefix: "leaderboard",
  });

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
