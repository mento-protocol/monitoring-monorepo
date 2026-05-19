"use client";

import { useMemo } from "react";
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
  amountsFor,
  badgeKindFor,
  mergeTransactionRows,
  type CdpTransactionsResponse,
} from "../_lib/transactions";
import type { CdpTransactionRow } from "../_lib/types";

// 100 across all markets is the user-visible cap. We fetch a larger
// per-kind cap and merge so the latest 100 across kinds is accurate even
// when one kind dominates (e.g. trove ops far outnumber liquidations).
const MAX_ROWS = 100;
const PER_KIND_FETCH_LIMIT = 250;

interface CollateralSummary {
  id: string;
  symbol: string;
  chainId: number;
}

export function CdpAllTransactionsTable({
  collaterals,
}: {
  collaterals: CollateralSummary[];
}) {
  const { data, error, isLoading } = useGQL<CdpTransactionsResponse>(
    ALL_CDP_TRANSACTIONS,
    { limit: PER_KIND_FETCH_LIMIT },
  );
  const { rows } = useMemo(() => mergeTransactionRows(data), [data]);
  const visibleRows = rows.slice(0, MAX_ROWS);

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
      ) : visibleRows.length === 0 ? (
        <EmptyBox message="No CDP transactions indexed yet." />
      ) : (
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
              {visibleRows.map((row) => (
                <OverviewRow
                  key={`${row.kind}-${row.id}`}
                  row={row}
                  market={
                    row.instanceId
                      ? symbolByInstance.get(row.instanceId)
                      : undefined
                  }
                />
              ))}
            </tbody>
          </Table>
          <p className="px-1 pt-2 text-xs text-slate-500">
            Showing the most recent {visibleRows.length.toLocaleString()}{" "}
            transactions across all CDP markets.
          </p>
        </>
      )}
    </section>
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
