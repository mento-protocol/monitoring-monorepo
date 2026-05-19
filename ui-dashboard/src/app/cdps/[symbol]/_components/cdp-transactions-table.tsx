"use client";

import { useMemo, useState } from "react";
import { EmptyBox, ErrorBox, Skeleton } from "@/components/feedback";
import { Pagination } from "@/components/pagination";
import { Row, Table, Td, Th } from "@/components/table";
import { TxHashCell } from "@/components/tx-hash-cell";
import { ENVIO_MAX_ROWS } from "@/lib/constants";
import { formatBlock, formatTimestamp, relativeTime } from "@/lib/format";
import { useGQL } from "@/lib/graphql";
import { CDP_TRANSACTIONS } from "@/lib/queries";
import { formatTokenAmount } from "../../_lib/format";
import type {
  CdpLiquidationEventRow,
  CdpRedemptionEventRow,
  CdpSpRebalanceEventRow,
  CdpTransactionRow,
  CdpTroveOperationEventRow,
} from "../../_lib/types";

const PAGE_SIZE = 20;

type CdpTransactionsResponse = {
  LiquidationEvent: CdpLiquidationEventRow[];
  RedemptionEvent: CdpRedemptionEventRow[];
  SpRebalanceEvent: CdpSpRebalanceEventRow[];
  TroveOperationEvent: CdpTroveOperationEventRow[];
};

type BadgeKind =
  | "liquidation"
  | "userRedemption"
  | "rebalanceRedemption"
  | "spRebalance"
  | "troveOpen"
  | "troveClose"
  | "troveAdjust"
  | "troveInterestRateChange"
  | "troveBatch";

const BADGE_STYLES: Record<BadgeKind, string> = {
  liquidation: "bg-amber-500/10 text-amber-300 border-amber-700/40",
  userRedemption: "bg-indigo-500/10 text-indigo-300 border-indigo-700/40",
  rebalanceRedemption: "bg-slate-500/10 text-slate-300 border-slate-600/40",
  spRebalance: "bg-cyan-500/10 text-cyan-300 border-cyan-700/40",
  troveOpen: "bg-emerald-500/10 text-emerald-300 border-emerald-700/40",
  troveClose: "bg-rose-500/10 text-rose-300 border-rose-700/40",
  troveAdjust: "bg-sky-500/10 text-sky-300 border-sky-700/40",
  troveInterestRateChange:
    "bg-violet-500/10 text-violet-300 border-violet-700/40",
  troveBatch: "bg-slate-500/10 text-slate-400 border-slate-600/40",
};

const BADGE_LABELS: Record<BadgeKind, string> = {
  liquidation: "Liquidation",
  userRedemption: "Redemption",
  rebalanceRedemption: "Rebalance Redemption",
  spRebalance: "SP Rebalance",
  troveOpen: "Open Trove",
  troveClose: "Close Trove",
  troveAdjust: "Adjust Trove",
  troveInterestRateChange: "Change Interest Rate",
  troveBatch: "Batch Membership",
};

// Mirrors `OP` in indexer-envio/src/handlers/liquity/operations.ts. Kept
// inline here so the UI doesn't reach across the package boundary; if the
// indexer ever renumbers these, both files must move together.
const TROVE_OP_BADGE: Record<number, BadgeKind> = {
  0: "troveOpen",
  1: "troveClose",
  2: "troveAdjust",
  3: "troveInterestRateChange",
  7: "troveOpen",
  8: "troveBatch",
  9: "troveBatch",
};

function badgeKindFor(row: CdpTransactionRow): BadgeKind {
  switch (row.kind) {
    case "liquidation":
      return "liquidation";
    case "spRebalance":
      return "spRebalance";
    case "redemption":
      return row.isRebalance ? "rebalanceRedemption" : "userRedemption";
    case "troveOp":
      return TROVE_OP_BADGE[row.operation] ?? "troveAdjust";
  }
}

function sumWei(...parts: string[]): string {
  return parts.reduce((acc, x) => acc + BigInt(x), BigInt(0)).toString();
}

interface AmountSlice {
  debt: string;
  coll: string;
}

function amountsFor(row: CdpTransactionRow): AmountSlice {
  switch (row.kind) {
    case "liquidation":
      return {
        debt: sumWei(
          row.debtOffsetBySP,
          row.debtRedistributed,
          row.boldGasCompensation,
        ),
        coll: sumWei(
          row.collSentToSP,
          row.collRedistributed,
          row.collGasCompensation,
        ),
      };
    case "redemption":
      return { debt: row.actualBoldAmount, coll: row.ETHSent };
    case "spRebalance":
      return { debt: row.amountStableOut, coll: row.amountCollIn };
    case "troveOp":
      // Signed deltas from the ABI — positive = added to trove, negative =
      // removed. Rendered with leading minus for withdrawals/repayments.
      return { debt: row.debtChange, coll: row.collChange };
  }
}

function mergeRows(data: CdpTransactionsResponse | undefined): {
  rows: CdpTransactionRow[];
  capped: boolean;
} {
  if (!data) return { rows: [], capped: false };
  const liquidations: CdpTransactionRow[] = (data.LiquidationEvent ?? []).map(
    (r) => ({ kind: "liquidation", ...r }),
  );
  const redemptions: CdpTransactionRow[] = (data.RedemptionEvent ?? []).map(
    (r) => ({ kind: "redemption", ...r }),
  );
  const rebalances: CdpTransactionRow[] = (data.SpRebalanceEvent ?? []).map(
    (r) => ({ kind: "spRebalance", ...r }),
  );
  const troveOps: CdpTransactionRow[] = (data.TroveOperationEvent ?? []).map(
    (r) => ({ kind: "troveOp", ...r }),
  );
  // Tiebreak on id desc so same-timestamp events (common when multiple
  // ops land in the same block) sort deterministically across event kinds
  // instead of falling back to the array concat order.
  const rows = [
    ...liquidations,
    ...redemptions,
    ...rebalances,
    ...troveOps,
  ].sort((a, b) => {
    const ts = Number(b.timestamp) - Number(a.timestamp);
    if (ts !== 0) return ts;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
  const capped =
    liquidations.length >= ENVIO_MAX_ROWS ||
    redemptions.length >= ENVIO_MAX_ROWS ||
    rebalances.length >= ENVIO_MAX_ROWS ||
    troveOps.length >= ENVIO_MAX_ROWS;
  return { rows, capped };
}

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
  const { rows, capped } = useMemo(() => mergeRows(data), [data]);

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
        />
      )}
    </section>
  );
}

function TransactionsBody({
  rows,
  chainId,
  symbol,
  capped,
}: {
  rows: CdpTransactionRow[];
  chainId: number;
  symbol: string;
  capped: boolean;
}) {
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const clampedPage = Math.max(1, Math.min(page, totalPages));
  const start = (clampedPage - 1) * PAGE_SIZE;
  const visibleRows = rows.slice(start, start + PAGE_SIZE);

  return (
    <>
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
          {visibleRows.map((row) => (
            <TransactionRow
              key={`${row.kind}-${row.id}`}
              row={row}
              chainId={chainId}
              symbol={symbol}
            />
          ))}
        </tbody>
      </Table>
      <Pagination
        page={clampedPage}
        pageSize={PAGE_SIZE}
        total={rows.length}
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
}: {
  row: CdpTransactionRow;
  chainId: number;
  symbol: string;
}) {
  const kind = badgeKindFor(row);
  const { debt, coll } = amountsFor(row);
  return (
    <Row>
      <Td>
        <span
          className={`inline-block rounded border px-2 py-0.5 text-xs ${BADGE_STYLES[kind]}`}
        >
          {BADGE_LABELS[kind]}
        </span>
      </Td>
      <Td mono small align="right">
        {formatTokenAmount(debt, symbol)}
      </Td>
      <Td mono small align="right">
        {formatTokenAmount(coll, "USDm")}
      </Td>
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
