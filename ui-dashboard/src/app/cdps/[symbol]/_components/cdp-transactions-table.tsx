"use client";

import { useMemo, useState } from "react";
import { EmptyBox, ErrorBox, Skeleton } from "@/components/feedback";
import { Pagination } from "@/components/pagination";
import { Row, Table, Td, Th } from "@/components/table";
import { TxHashCell } from "@/components/tx-hash-cell";
import { ENVIO_MAX_ROWS } from "@/lib/constants";
import { formatBlock, formatTimestamp, relativeTime } from "@/lib/format";
import { useGQL } from "@/lib/graphql";
import { CDP_TRANSACTIONS, CDP_TROVE_OP_SNAPSHOTS } from "@/lib/queries";
import { CdpTxAmountCell } from "../../_components/cdp-tx-amount-cell";
import {
  BADGE_LABELS,
  BADGE_STYLES,
  type BadgeKind,
  badgeKindFor,
  indexSnapshotsById,
  mergeTransactionRows,
  troveSnapshotFor,
  type CdpTransactionsResponse,
  type CdpTroveOpSnapshotResponse,
} from "../../_lib/transactions";
import type {
  CdpTransactionRow,
  CdpTroveOpSnapshotRow,
} from "../../_lib/types";
import {
  CdpTxAddressFilter,
  CdpTxTypeFilter,
  TX_FILTER_TYPE_ORDER,
  normalizeAddressFilter,
} from "../../_components/cdp-tx-filters";

const PAGE_SIZE = 20;

export function CdpTransactionsTable({
  instanceId,
  chainId,
  symbol,
}: {
  instanceId: string;
  chainId: number;
  symbol: string;
}) {
  const { data, error, isLoading } = useGQL<CdpTransactionsResponse>(
    CDP_TRANSACTIONS,
    { instanceId, limit: ENVIO_MAX_ROWS },
  );
  // Isolated query for the schema-lag-fragile fields (owner + before/after).
  // Errors and loading states are tracked independently from the primary
  // query so the table keeps rendering when this one fails during a
  // deploy+resync window.
  const snapshots = useGQL<CdpTroveOpSnapshotResponse>(CDP_TROVE_OP_SNAPSHOTS, {
    instanceId,
    limit: ENVIO_MAX_ROWS,
  });
  const { rows, capped } = useMemo(() => mergeTransactionRows(data), [data]);
  const snapshotById = useMemo(
    () => indexSnapshotsById(snapshots.data),
    [snapshots.data],
  );
  const snapshotsReady = snapshots.data != null && snapshots.error == null;

  return (
    <section>
      <h2 className="text-lg font-semibold text-white mb-3">
        CDP Transactions
      </h2>
      {error ? (
        <ErrorBox
          message={`Failed to load CDP transactions — ${error.message}`}
        />
      ) : isLoading ? (
        <Skeleton rows={6} />
      ) : rows.length === 0 ? (
        <EmptyBox message="No CDP transactions indexed yet." />
      ) : (
        <TransactionsBody
          rows={rows}
          chainId={chainId}
          symbol={symbol}
          capped={capped}
          snapshotById={snapshotById}
          snapshotsReady={snapshotsReady}
        />
      )}
    </section>
  );
}

/** Filter state for the per-market table. Same address-filter gating as
 *  the overview's `useOverviewFilters` (no-op while the snapshot query
 *  hasn't resolved) so the table never pretends to match against
 *  missing owner data. */
function usePerMarketFilters(
  rows: CdpTransactionRow[],
  snapshotById: Map<string, CdpTroveOpSnapshotRow>,
  snapshotsReady: boolean,
) {
  const [typeFilter, setTypeFilter] = useState<BadgeKind | null>(null);
  const [addressInput, setAddressInput] = useState("");
  const normalizedAddress = normalizeAddressFilter(addressInput);
  const addressActive = normalizedAddress.length > 0 && snapshotsReady;
  const filteredRows = useMemo(() => {
    return rows.filter((row) => {
      if (addressActive) {
        if (row.kind !== "troveOp") return false;
        const snap = snapshotById.get(row.id);
        if (snap == null || snap.owner !== normalizedAddress) return false;
      }
      if (typeFilter != null && badgeKindFor(row) !== typeFilter) return false;
      return true;
    });
  }, [rows, typeFilter, addressActive, normalizedAddress, snapshotById]);
  return {
    typeFilter,
    setTypeFilter,
    addressInput,
    setAddressInput,
    filteredRows,
  };
}

function TransactionsBody({
  rows,
  chainId,
  symbol,
  capped,
  snapshotById,
  snapshotsReady,
}: {
  rows: CdpTransactionRow[];
  chainId: number;
  symbol: string;
  capped: boolean;
  snapshotById: Map<string, CdpTroveOpSnapshotRow>;
  snapshotsReady: boolean;
}) {
  const [page, setPage] = useState(1);
  const {
    typeFilter,
    setTypeFilter,
    addressInput,
    setAddressInput,
    filteredRows,
  } = usePerMarketFilters(rows, snapshotById, snapshotsReady);

  // When a filter narrows the result set, clamp the requested page down
  // to the last valid page so users don't land on an empty page N. No
  // useEffect needed — the derived clamp absorbs the stale `page`.
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const clampedPage = Math.max(1, Math.min(page, totalPages));
  const start = (clampedPage - 1) * PAGE_SIZE;
  const visibleRows = filteredRows.slice(start, start + PAGE_SIZE);

  return (
    <>
      <div className="mb-3 space-y-2">
        <CdpTxTypeFilter
          options={TX_FILTER_TYPE_ORDER}
          selected={typeFilter}
          onChange={setTypeFilter}
        />
        <CdpTxAddressFilter
          value={addressInput}
          onChange={setAddressInput}
          disabled={!snapshotsReady}
          disabledHint={
            snapshotsReady ? undefined : "(unavailable while indexer syncs)"
          }
        />
      </div>
      <Table>
        <thead>
          <Row>
            <Th>Type</Th>
            <Th align="right">Debt</Th>
            <Th align="right">Collateral</Th>
            <Th>Tx</Th>
            <th
              scope="col"
              className="hidden md:table-cell px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium text-slate-400 text-right"
            >
              Block
            </th>
            <Th>Time</Th>
          </Row>
        </thead>
        <tbody>
          {visibleRows.length === 0 ? (
            <Row>
              <td
                colSpan={6}
                className="px-2 sm:px-4 py-3 text-center text-xs text-slate-500"
              >
                No transactions match the active filter.
              </td>
            </Row>
          ) : (
            visibleRows.map((row) => (
              <TransactionRow
                key={`${row.kind}-${row.id}`}
                row={row}
                chainId={chainId}
                symbol={symbol}
                snapshot={
                  row.kind === "troveOp" ? snapshotById.get(row.id) : undefined
                }
              />
            ))
          )}
        </tbody>
      </Table>
      <Pagination
        page={clampedPage}
        pageSize={PAGE_SIZE}
        total={filteredRows.length}
        onPageChange={setPage}
      />
      {capped && (
        <p className="px-1 pt-1 text-xs text-amber-400">
          Showing the most recent {ENVIO_MAX_ROWS.toLocaleString()} entries per
          event type — older history may exist beyond this range.
        </p>
      )}
    </>
  );
}

function TransactionRow({
  row,
  chainId,
  symbol,
  snapshot,
}: {
  row: CdpTransactionRow;
  chainId: number;
  symbol: string;
  snapshot: CdpTroveOpSnapshotRow | undefined;
}) {
  const kind = badgeKindFor(row);
  const resolvedSnapshot = troveSnapshotFor(row, snapshot);
  return (
    <Row>
      <Td>
        <span
          className={`inline-block rounded border px-2 py-0.5 text-xs ${BADGE_STYLES[kind]}`}
        >
          {BADGE_LABELS[kind]}
        </span>
      </Td>
      <CdpTxAmountCell
        row={row}
        symbol={symbol}
        leg="debt"
        snapshot={resolvedSnapshot}
      />
      <CdpTxAmountCell
        row={row}
        symbol="USDm"
        leg="coll"
        snapshot={resolvedSnapshot}
      />
      <TxHashCell txHash={row.txHash} chainId={chainId} />
      <td className="hidden md:table-cell px-2 sm:px-4 py-1.5 sm:py-2 font-mono text-[10px] sm:text-xs text-slate-400 text-right">
        {formatBlock(row.blockNumber)}
      </td>
      <Td small muted title={formatTimestamp(row.timestamp)}>
        {relativeTime(row.timestamp)}
      </Td>
    </Row>
  );
}
