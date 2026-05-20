"use client";

import { useMemo, useState } from "react";
import { EmptyBox, ErrorBox, Skeleton } from "@/components/feedback";
import { Row, Table, Td, Th } from "@/components/table";
import { TxHashCell } from "@/components/tx-hash-cell";
import { formatBlock, formatTimestamp, relativeTime } from "@/lib/format";
import { useGQL } from "@/lib/graphql";
import { ALL_CDP_TRANSACTIONS } from "@/lib/queries";
import Link from "next/link";
import { cdpSymbolSlug, formatTokenAmount } from "../_lib/format";
import {
  BADGE_LABELS,
  BADGE_STYLES,
  CDP_OVERVIEW_PER_KIND_FETCH_LIMIT,
  type BadgeKind,
  amountsFor,
  badgeKindFor,
  mergeTransactionRows,
  type CdpTransactionsResponse,
} from "../_lib/transactions";
import type { CdpTransactionRow } from "../_lib/types";
import {
  CdpTxMarketFilter,
  CdpTxTypeFilter,
  TX_FILTER_TYPE_ORDER,
} from "./cdp-tx-filters";

// 100 across all markets is the user-visible cap. We fetch a larger
// per-kind cap and merge so the latest 100 across kinds is accurate even
// when one kind dominates (e.g. trove ops far outnumber liquidations).
const MAX_ROWS = 100;

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
  const { rows, capped } = useMemo(
    () => mergeTransactionRows(data, CDP_OVERVIEW_PER_KIND_FETCH_LIMIT),
    [data],
  );

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
      {error ? (
        <ErrorBox
          message={`Failed to load CDP transactions — ${error.message}`}
        />
      ) : isLoading ? (
        <Skeleton rows={6} />
      ) : rows.length === 0 ? (
        <EmptyBox message="No CDP transactions indexed yet." />
      ) : (
        <OverviewBody
          rows={rows}
          collaterals={collaterals}
          symbolByInstance={symbolByInstance}
          capped={capped}
        />
      )}
    </section>
  );
}

/** Filter state for the overview transactions table. Validates
 *  `marketFilter` against the current collateral list each render — if
 *  the indexer ever drops/renames a market between revalidations, a
 *  stale id would silently zero out the result set with no visibly
 *  selected pill. Falls back to null in that case (no useEffect). */
function useOverviewFilters(
  rows: CdpTransactionRow[],
  collaterals: CollateralSummary[],
) {
  const [typeFilter, setTypeFilter] = useState<BadgeKind | null>(null);
  const [marketFilter, setMarketFilter] = useState<string | null>(null);
  const effectiveMarketFilter = useMemo(() => {
    if (marketFilter == null) return null;
    return collaterals.some((c) => c.id === marketFilter) ? marketFilter : null;
  }, [collaterals, marketFilter]);
  const filteredRows = useMemo(() => {
    return rows.filter((row) => {
      if (typeFilter != null && badgeKindFor(row) !== typeFilter) return false;
      if (
        effectiveMarketFilter != null &&
        row.instanceId !== effectiveMarketFilter
      )
        return false;
      return true;
    });
  }, [rows, typeFilter, effectiveMarketFilter]);
  return {
    typeFilter,
    setTypeFilter,
    marketFilter: effectiveMarketFilter,
    setMarketFilter,
    filteredRows,
    filtersActive: typeFilter != null || effectiveMarketFilter != null,
  };
}

function OverviewBody({
  rows,
  collaterals,
  symbolByInstance,
  capped,
}: {
  rows: CdpTransactionRow[];
  collaterals: CollateralSummary[];
  symbolByInstance: Map<string, { symbol: string; chainId: number }>;
  capped: boolean;
}) {
  const {
    typeFilter,
    setTypeFilter,
    marketFilter,
    setMarketFilter,
    filteredRows,
    filtersActive,
  } = useOverviewFilters(rows, collaterals);
  const visibleRows = filteredRows.slice(0, MAX_ROWS);

  return (
    <>
      <div className="mb-3 space-y-2">
        <CdpTxTypeFilter
          options={TX_FILTER_TYPE_ORDER}
          selected={typeFilter}
          onChange={setTypeFilter}
        />
        <CdpTxMarketFilter
          options={collaterals}
          selected={marketFilter}
          onChange={setMarketFilter}
        />
      </div>
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
          {visibleRows.length === 0 ? (
            <Row>
              <td
                colSpan={7}
                className="px-2 sm:px-4 py-3 text-center text-xs text-slate-500"
              >
                No transactions match the active filters.
              </td>
            </Row>
          ) : (
            visibleRows.map((row) => (
              <OverviewRow
                key={`${row.kind}-${row.id}`}
                row={row}
                market={
                  row.instanceId
                    ? symbolByInstance.get(row.instanceId)
                    : undefined
                }
              />
            ))
          )}
        </tbody>
      </Table>
      {visibleRows.length > 0 && (
        <p className="px-1 pt-2 text-xs text-slate-500">
          {filtersActive
            ? `Showing ${visibleRows.length.toLocaleString()} of ${filteredRows.length.toLocaleString()} matching transactions.`
            : `Showing the most recent ${visibleRows.length.toLocaleString()} transactions across all CDP markets.`}
        </p>
      )}
      {capped && (
        <p className="px-1 pt-1 text-xs text-amber-400">
          Showing the most recent{" "}
          {CDP_OVERVIEW_PER_KIND_FETCH_LIMIT.toLocaleString()} entries per event
          type — older history may exist beyond this range.
        </p>
      )}
    </>
  );
}

function OverviewRow({
  row,
  market,
}: {
  row: CdpTransactionRow;
  market: { symbol: string; chainId: number } | undefined;
}) {
  const kind = badgeKindFor(row);
  const { debt, coll } = amountsFor(row);
  const symbol = market?.symbol ?? "—";
  return (
    <Row>
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
      <Td mono small align="right">
        {formatTokenAmount(debt, symbol)}
      </Td>
      <Td mono small align="right">
        {formatTokenAmount(coll, "USDm")}
      </Td>
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
