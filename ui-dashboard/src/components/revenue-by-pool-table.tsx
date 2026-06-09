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
import { stripChainIdFromPoolId } from "@/lib/pool-id";
import type { SortDir } from "@/lib/table-sort";
import { useTableSort } from "@/lib/use-table-sort";

type PoolFeeRow = PoolFeeEntry & {
  network: Network;
  label: PoolLabel | null;
};

type SortKey = "pool" | "fees24h" | "fees7d" | "fees30d" | "feesAll";

const SORT_KEYS: ReadonlySet<SortKey> = new Set([
  "pool",
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
    const feeRowsByAddress = new Map(entries.map((e) => [e.poolAddress, e]));
    const labelsByAddress = new Map<string, PoolLabel>(n.poolLabels);
    for (const p of n.pools) {
      labelsByAddress.set(stripChainIdFromPoolId(p.id).toLowerCase(), p);
    }

    for (const [poolAddress, label] of labelsByAddress) {
      const feeRow = feeRowsByAddress.get(poolAddress);
      rows.push({
        ...(feeRow ?? zeroFeeEntry(label, poolAddress, n.network.chainId)),
        network: n.network,
        label,
      });
      feeRowsByAddress.delete(poolAddress);
    }

    for (const feeRow of feeRowsByAddress.values()) {
      rows.push({
        ...feeRow,
        network: n.network,
        label: null,
      });
    }
  }
  return rows;
}

function zeroFeeEntry(
  label: PoolLabel,
  poolAddress: string,
  chainId: number,
): PoolFeeEntry {
  return {
    poolId: label.id,
    chainId,
    poolAddress,
    totalFeesUSD: 0,
    fees24hUSD: 0,
    fees7dUSD: 0,
    fees30dUSD: 0,
    unpriced: false,
    unpriced24h: false,
    unpriced7d: false,
    unpriced30d: false,
  };
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
  // ES2023 `toSorted` requires Safari 16+/Chrome 110+; TS target is
  // ES2017 with no polyfill — keep the spread+sort form (codex P2).
  // react-doctor-disable-next-line react-doctor/js-tosorted-immutable
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

function RevenueTableHeader({
  sortKey,
  sortDir,
  onSort,
}: {
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
}) {
  return (
    <thead>
      <tr className="border-b border-slate-800 bg-slate-900/50">
        <SortableTh
          sortKey="pool"
          activeSortKey={sortKey}
          sortDir={sortDir}
          onSort={onSort}
        >
          Pool
        </SortableTh>
        {FEE_COLUMNS.map((c) => (
          <SortableTh
            key={c.key}
            sortKey={c.key}
            activeSortKey={sortKey}
            sortDir={sortDir}
            onSort={onSort}
            align="right"
            className={c.className}
          >
            {c.label}
          </SortableTh>
        ))}
      </tr>
    </thead>
  );
}

function FeeCell({ row, column }: { row: PoolFeeRow; column: FeeColumn }) {
  const { prefix, title } = approxAnnotation(row, column);
  return (
    <td
      className={`${column.className ?? ""} px-2 sm:px-4 py-1.5 sm:py-2 text-xs sm:text-sm text-slate-300 font-mono text-right`}
      title={title}
    >
      {prefix}
      {formatUSD(row[column.field])}
    </td>
  );
}

function RevenueTableRow({ row }: { row: PoolFeeRow }) {
  const display = rowDisplayName(row);
  const href = buildPoolDetailHref(row.poolId);
  return (
    <Row>
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
      {FEE_COLUMNS.map((column) => (
        <FeeCell key={column.key} row={row} column={column} />
      ))}
    </Row>
  );
}

function RevenueTableBody({ rows }: { rows: PoolFeeRow[] }) {
  return (
    <tbody>
      {rows.map((row) => (
        <RevenueTableRow key={row.poolId} row={row} />
      ))}
    </tbody>
  );
}

export function RevenueByPoolTable({
  networkData,
  isLoading,
  hasError,
}: RevenueByPoolTableProps) {
  const rows = useMemo(() => buildRows(networkData), [networkData]);
  const { sortKey, sortDir, handleSort } = useTableSort<SortKey>({
    defaultKey: "feesAll",
    defaultDir: "desc",
    validKeys: SORT_KEYS,
    paramPrefix: "revenue",
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
        <RevenueTableHeader
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={handleSort}
        />
        <RevenueTableBody rows={sorted} />
      </Table>
    </section>
  );
}
