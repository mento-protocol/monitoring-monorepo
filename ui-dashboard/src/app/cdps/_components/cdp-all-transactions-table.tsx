"use client";

import { Fragment, useMemo, useState } from "react";
import { ErrorBox, Skeleton } from "@/components/feedback";
import { Pagination } from "@/components/pagination";
import { Row, Table, Td, Th } from "@/components/table";
import { TxHashCell } from "@/components/tx-hash-cell";
import { formatBlock, formatTimestamp, relativeTime } from "@/lib/format";
import { useGQL } from "@/lib/graphql";
import { hasErrorWithoutData, isLoadingWithoutData } from "@/lib/swr-state";
import {
  ALL_CDP_STABILITY_POOL_EVENTS,
  ALL_CDP_TRANSACTIONS,
  ALL_CDP_TROVE_OP_SNAPSHOTS,
} from "@/lib/queries";
import Link from "next/link";
import { cdpSymbolSlug } from "../_lib/format";
import {
  BADGE_LABELS,
  BADGE_STYLES,
  CDP_OVERVIEW_PER_KIND_FETCH_LIMIT,
  CDP_OVERVIEW_TABLE_PAGE_SIZE,
  type BadgeKind,
  badgeKindFor,
  groupTransactionsByUtcDay,
  indexSnapshotsById,
  mergeTransactionRows,
  positionSnapshotFor,
  transactionAttentionRank,
  type CdpStabilityPoolEventsResponse,
  type CdpTransactionsResponse,
  type CdpTroveOpSnapshotResponse,
} from "../_lib/transactions";
import type { CdpTransactionRow, CdpTroveOpSnapshotRow } from "../_lib/types";
import { CdpTxAmountCell } from "./cdp-tx-amount-cell";
import {
  ADDRESS_FILTER_POOL_EVENT_NOTICE,
  ADDRESS_FILTER_SP_ONLY_NOTICE,
  CdpTxAddressFilter,
  CdpTxMarketFilter,
  CdpTxTypeFilter,
  TX_FILTER_TYPE_ORDER,
  normalizeAddressFilter,
} from "./cdp-tx-filters";
import {
  CdpTransactionsEmptyState,
  StabilityPoolEventsUnavailableNotice,
} from "./cdp-transaction-notices";

interface CollateralSummary {
  id: string;
  symbol: string;
  chainId: number;
}

export function CdpAllTransactionsTable({
  collaterals,
  chainId,
}: {
  collaterals: CollateralSummary[];
  chainId: number;
}) {
  const { data, error, isLoading } = useGQL<CdpTransactionsResponse>(
    ALL_CDP_TRANSACTIONS,
    { chainId, limit: CDP_OVERVIEW_PER_KIND_FETCH_LIMIT },
  );
  const stabilityPoolEvents = useGQL<CdpStabilityPoolEventsResponse>(
    ALL_CDP_STABILITY_POOL_EVENTS,
    { chainId, limit: CDP_OVERVIEW_PER_KIND_FETCH_LIMIT },
  );
  // Isolated query for the schema-lag-fragile fields (owner + before/after).
  // Errors and loading states are tracked independently so the table keeps
  // rendering with flat amounts and a disabled address filter when this
  // query fails during a deploy+resync window.
  const snapshots = useGQL<CdpTroveOpSnapshotResponse>(
    ALL_CDP_TROVE_OP_SNAPSHOTS,
    { chainId, limit: CDP_OVERVIEW_PER_KIND_FETCH_LIMIT },
  );
  const { rows, capped } = useMemo(
    () =>
      mergeTransactionRows(
        data,
        CDP_OVERVIEW_PER_KIND_FETCH_LIMIT,
        stabilityPoolEvents.data,
      ),
    [data, stabilityPoolEvents.data],
  );
  const snapshotById = useMemo(
    () => indexSnapshotsById(snapshots.data),
    [snapshots.data],
  );
  const snapshotsReady = snapshots.data != null && snapshots.error == null;
  const stabilityPoolEventsUnavailable = stabilityPoolEvents.error != null;

  const symbolByInstance = useMemo(() => {
    const m = new Map<string, { symbol: string; chainId: number }>();
    for (const c of collaterals) {
      m.set(c.id, { symbol: c.symbol, chainId: c.chainId });
    }
    return m;
  }, [collaterals]);

  return (
    <section>
      <h2 className="text-lg font-semibold text-white mb-3">
        Recent CDP Transactions
      </h2>
      {hasErrorWithoutData(error, data) ? (
        <ErrorBox
          message={`Failed to load CDP transactions — ${error.message}`}
        />
      ) : isLoadingWithoutData(isLoading, data) ||
        (rows.length === 0 &&
          isLoadingWithoutData(
            stabilityPoolEvents.isLoading,
            stabilityPoolEvents.data,
          )) ? (
        <Skeleton rows={6} />
      ) : rows.length === 0 ? (
        <CdpTransactionsEmptyState
          stabilityPoolEventsUnavailable={stabilityPoolEventsUnavailable}
        />
      ) : (
        <OverviewBody
          rows={rows}
          collaterals={collaterals}
          symbolByInstance={symbolByInstance}
          capped={capped}
          stabilityPoolEventsUnavailable={stabilityPoolEventsUnavailable}
          snapshotById={snapshotById}
          snapshotsReady={snapshotsReady}
        />
      )}
    </section>
  );
}

/** Filter state for the overview transactions table. Combines:
 *  - validated `marketFilter` (falls back to null if the indexer drops or
 *    renames a market between revalidations, so a stale id can't silently
 *    zero out the result set without a visibly selected pill)
 *  - free-text `addressInput` (normalized to lowercase + trimmed at the
 *    comparison site so the input renders the raw typed value)
 *  No useEffect — the derived `effectiveMarketFilter` / `addressActive`
 *  values absorb stale inputs. */
function useOverviewFilters(
  rows: CdpTransactionRow[],
  collaterals: CollateralSummary[],
  snapshotById: Map<string, CdpTroveOpSnapshotRow>,
  snapshotsReady: boolean,
) {
  const [typeFilter, setTypeFilter] = useState<BadgeKind | null>(null);
  const [marketFilter, setMarketFilter] = useState<string | null>(null);
  const [addressInput, setAddressInput] = useState("");
  const effectiveMarketFilter = useMemo(() => {
    if (marketFilter == null) return null;
    return collaterals.some((c) => c.id === marketFilter) ? marketFilter : null;
  }, [collaterals, marketFilter]);
  const normalizedAddress = normalizeAddressFilter(addressInput);
  const hasStabilityPoolRows = rows.some((row) => row.kind === "spOperation");
  const addressEnabled = snapshotsReady || hasStabilityPoolRows;
  const addressActive = normalizedAddress.length > 0 && addressEnabled;
  const addressFilterNotice =
    addressActive && snapshotsReady
      ? ADDRESS_FILTER_POOL_EVENT_NOTICE
      : addressActive
        ? ADDRESS_FILTER_SP_ONLY_NOTICE
        : null;
  const filteredRows = useMemo(() => {
    return rows.filter((row) => {
      if (addressActive) {
        const matchesAddress =
          row.kind === "spOperation"
            ? row.depositor === normalizedAddress
            : row.kind === "troveOp" &&
              snapshotById.get(row.id)?.owner === normalizedAddress;
        if (!matchesAddress) return false;
      }
      if (typeFilter != null && badgeKindFor(row) !== typeFilter) return false;
      if (
        effectiveMarketFilter != null &&
        row.instanceId !== effectiveMarketFilter
      )
        return false;
      return true;
    });
  }, [
    rows,
    typeFilter,
    effectiveMarketFilter,
    addressActive,
    normalizedAddress,
    snapshotById,
  ]);
  return {
    typeFilter,
    setTypeFilter,
    marketFilter: effectiveMarketFilter,
    setMarketFilter,
    addressInput,
    setAddressInput,
    addressDisabled: !addressEnabled,
    addressFilterNotice,
    filteredRows,
    filtersActive:
      typeFilter != null || effectiveMarketFilter != null || addressActive,
  };
}

/** Filter bar for the overview transactions table — type-pill row,
 *  market-pill row, and free-text owner input. Extracted from
 *  `OverviewBody` to keep that component under the project's
 *  `max-lines-per-function` budget. */
function OverviewFilterBar({
  collaterals,
  typeFilter,
  onTypeFilterChange,
  marketFilter,
  onMarketFilterChange,
  addressInput,
  onAddressInputChange,
  addressDisabled,
  addressFilterNotice,
}: {
  collaterals: CollateralSummary[];
  typeFilter: BadgeKind | null;
  onTypeFilterChange: (next: BadgeKind | null) => void;
  marketFilter: string | null;
  onMarketFilterChange: (next: string | null) => void;
  addressInput: string;
  onAddressInputChange: (next: string) => void;
  addressDisabled: boolean;
  addressFilterNotice: string | null;
}) {
  return (
    <div className="mb-3 space-y-2">
      <CdpTxTypeFilter
        options={TX_FILTER_TYPE_ORDER}
        selected={typeFilter}
        onChange={onTypeFilterChange}
      />
      <CdpTxMarketFilter
        options={collaterals}
        selected={marketFilter}
        onChange={onMarketFilterChange}
      />
      <CdpTxAddressFilter
        value={addressInput}
        onChange={onAddressInputChange}
        disabled={addressDisabled}
        disabledHint={
          addressDisabled ? "(unavailable while indexer syncs)" : undefined
        }
      />
      {addressFilterNotice != null && (
        <p role="status" className="px-1 text-xs text-slate-500">
          {addressFilterNotice}
        </p>
      )}
    </div>
  );
}

function OverviewBody({
  rows,
  collaterals,
  symbolByInstance,
  capped,
  stabilityPoolEventsUnavailable,
  snapshotById,
  snapshotsReady,
}: {
  rows: CdpTransactionRow[];
  collaterals: CollateralSummary[];
  symbolByInstance: Map<string, { symbol: string; chainId: number }>;
  capped: boolean;
  stabilityPoolEventsUnavailable: boolean;
  snapshotById: Map<string, CdpTroveOpSnapshotRow>;
  snapshotsReady: boolean;
}) {
  const {
    typeFilter,
    setTypeFilter,
    marketFilter,
    setMarketFilter,
    addressInput,
    setAddressInput,
    addressDisabled,
    addressFilterNotice,
    filteredRows,
    filtersActive,
  } = useOverviewFilters(rows, collaterals, snapshotById, snapshotsReady);
  const tableKey = [
    typeFilter ?? "all-types",
    marketFilter ?? "all-markets",
    normalizeAddressFilter(addressInput),
  ].join(":");

  return (
    <>
      <OverviewFilterBar
        collaterals={collaterals}
        typeFilter={typeFilter}
        onTypeFilterChange={setTypeFilter}
        marketFilter={marketFilter}
        onMarketFilterChange={setMarketFilter}
        addressInput={addressInput}
        onAddressInputChange={setAddressInput}
        addressDisabled={addressDisabled}
        addressFilterNotice={addressFilterNotice}
      />
      <PaginatedOverviewTable
        key={tableKey}
        rows={filteredRows}
        symbolByInstance={symbolByInstance}
        snapshotById={snapshotById}
        filtersActive={filtersActive}
        capped={capped}
        stabilityPoolEventsUnavailable={stabilityPoolEventsUnavailable}
      />
    </>
  );
}

function PaginatedOverviewTable({
  rows,
  symbolByInstance,
  snapshotById,
  filtersActive,
  capped,
  stabilityPoolEventsUnavailable,
}: {
  rows: CdpTransactionRow[];
  symbolByInstance: Map<string, { symbol: string; chainId: number }>;
  snapshotById: Map<string, CdpTroveOpSnapshotRow>;
  filtersActive: boolean;
  capped: boolean;
  stabilityPoolEventsUnavailable: boolean;
}) {
  const [page, setPage] = useState(1);
  const pageCount = Math.max(
    1,
    Math.ceil(rows.length / CDP_OVERVIEW_TABLE_PAGE_SIZE),
  );
  const currentPage = Math.min(page, pageCount);
  const pageStart = (currentPage - 1) * CDP_OVERVIEW_TABLE_PAGE_SIZE;
  const pageRows = rows.slice(
    pageStart,
    pageStart + CDP_OVERVIEW_TABLE_PAGE_SIZE,
  );
  const dayGroups = useMemo(
    () => groupTransactionsByUtcDay(pageRows),
    [pageRows],
  );

  return (
    <>
      <Table>
        <thead>
          <Row>
            <Th>Type</Th>
            <Th>Market</Th>
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
          <OverviewTableRows
            pageRows={pageRows}
            dayGroups={dayGroups}
            symbolByInstance={symbolByInstance}
            snapshotById={snapshotById}
          />
        </tbody>
      </Table>
      <OverviewFootnotes
        pageStart={pageStart}
        visibleCount={pageRows.length}
        filteredCount={rows.length}
        filtersActive={filtersActive}
        capped={capped}
        stabilityPoolEventsUnavailable={stabilityPoolEventsUnavailable}
      />
      <Pagination
        page={currentPage}
        pageSize={CDP_OVERVIEW_TABLE_PAGE_SIZE}
        total={rows.length}
        onPageChange={setPage}
      />
    </>
  );
}

function OverviewTableRows({
  pageRows,
  dayGroups,
  symbolByInstance,
  snapshotById,
}: {
  pageRows: CdpTransactionRow[];
  dayGroups: ReturnType<typeof groupTransactionsByUtcDay>;
  symbolByInstance: Map<string, { symbol: string; chainId: number }>;
  snapshotById: Map<string, CdpTroveOpSnapshotRow>;
}) {
  if (pageRows.length === 0) {
    return (
      <Row>
        <td
          colSpan={7}
          className="px-2 sm:px-4 py-3 text-center text-xs text-slate-500"
        >
          No transactions match the active filters.
        </td>
      </Row>
    );
  }

  return dayGroups.map((group) => (
    <Fragment key={group.key}>
      <tr className="border-y border-slate-800 bg-slate-900/50">
        <td
          colSpan={7}
          className="px-2 py-2 text-xs font-medium uppercase tracking-wide text-slate-400 sm:px-4"
        >
          {group.label}
        </td>
      </tr>
      {group.rows.map((row) => (
        <OverviewRow
          key={`${row.kind}-${row.id}`}
          row={row}
          market={
            row.instanceId ? symbolByInstance.get(row.instanceId) : undefined
          }
          snapshot={
            row.kind === "troveOp" ? snapshotById.get(row.id) : undefined
          }
        />
      ))}
    </Fragment>
  ));
}

function OverviewFootnotes({
  pageStart,
  visibleCount,
  filteredCount,
  filtersActive,
  capped,
  stabilityPoolEventsUnavailable,
}: {
  pageStart: number;
  visibleCount: number;
  filteredCount: number;
  filtersActive: boolean;
  capped: boolean;
  stabilityPoolEventsUnavailable: boolean;
}) {
  return (
    <>
      {visibleCount > 0 && (
        <p className="px-1 pt-2 text-xs text-slate-500">
          {filtersActive
            ? `Showing ${(pageStart + 1).toLocaleString()}-${(pageStart + visibleCount).toLocaleString()} of ${filteredCount.toLocaleString()} matching transactions.`
            : `Showing ${(pageStart + 1).toLocaleString()}-${(pageStart + visibleCount).toLocaleString()} of ${filteredCount.toLocaleString()} fetched transactions across all CDP markets.`}
        </p>
      )}
      {capped && (
        <p className="px-1 pt-1 text-xs text-amber-400">
          Showing the most recent{" "}
          {CDP_OVERVIEW_PER_KIND_FETCH_LIMIT.toLocaleString()} entries per event
          type — older history may exist beyond this range.
        </p>
      )}
      {stabilityPoolEventsUnavailable && (
        <StabilityPoolEventsUnavailableNotice />
      )}
    </>
  );
}

function OverviewRow({
  row,
  market,
  snapshot,
}: {
  row: CdpTransactionRow;
  market: { symbol: string; chainId: number } | undefined;
  snapshot: CdpTroveOpSnapshotRow | undefined;
}) {
  const kind = badgeKindFor(row);
  const symbol = market?.symbol ?? "—";
  const resolvedSnapshot = positionSnapshotFor(row, snapshot);
  return (
    <Row className={overviewRowClass(row)}>
      <Td>
        <span
          className={`inline-block rounded border px-2 py-0.5 text-xs ${BADGE_STYLES[kind]}`}
        >
          {BADGE_LABELS[kind]}
        </span>
      </Td>
      <Td>
        {market ? (
          <Link
            href={`/cdps/${cdpSymbolSlug(market.symbol)}`}
            className="text-indigo-400 hover:text-indigo-300"
          >
            {market.symbol}
          </Link>
        ) : (
          <span className="text-slate-500">{symbol}</span>
        )}
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
      <TxHashCell txHash={row.txHash} chainId={market?.chainId} />
      <td className="hidden md:table-cell px-2 sm:px-4 py-1.5 sm:py-2 font-mono text-[10px] sm:text-xs text-slate-400 text-right">
        {formatBlock(row.blockNumber)}
      </td>
      <Td small muted title={formatTimestamp(row.timestamp)}>
        {relativeTime(row.timestamp)}
      </Td>
    </Row>
  );
}

function overviewRowClass(row: CdpTransactionRow): string {
  const rank = transactionAttentionRank(row);
  if (rank >= 3) {
    return "border-l-2 border-l-amber-500/60 bg-amber-950/10 hover:bg-amber-950/20";
  }
  if (rank === 2) {
    return "border-l-2 border-l-cyan-500/50 bg-cyan-950/10 hover:bg-cyan-950/20";
  }
  if (rank === 1) {
    return "border-l-2 border-l-indigo-500/40";
  }
  return "";
}
