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
} from "../../_lib/types";

const PAGE_SIZE = 20;

type CdpTransactionsResponse = {
  LiquidationEvent: CdpLiquidationEventRow[];
  RedemptionEvent: CdpRedemptionEventRow[];
  SpRebalanceEvent: CdpSpRebalanceEventRow[];
};

type BadgeKind =
  | "liquidation"
  | "userRedemption"
  | "rebalanceRedemption"
  | "spRebalance";

const BADGE_STYLES: Record<BadgeKind, string> = {
  liquidation: "bg-amber-500/10 text-amber-300 border-amber-700/40",
  userRedemption: "bg-indigo-500/10 text-indigo-300 border-indigo-700/40",
  rebalanceRedemption: "bg-slate-500/10 text-slate-300 border-slate-600/40",
  spRebalance: "bg-cyan-500/10 text-cyan-300 border-cyan-700/40",
};

const BADGE_LABELS: Record<BadgeKind, string> = {
  liquidation: "Liquidation",
  userRedemption: "Redemption",
  rebalanceRedemption: "Rebalance Redemption",
  spRebalance: "SP Rebalance",
};

function badgeKindFor(row: CdpTransactionRow): BadgeKind {
  if (row.kind === "liquidation") return "liquidation";
  if (row.kind === "spRebalance") return "spRebalance";
  return row.isRebalance ? "rebalanceRedemption" : "userRedemption";
}

function sumWei(a: string, b: string): string {
  return (BigInt(a) + BigInt(b)).toString();
}

interface AmountSlice {
  debt: string;
  coll: string;
}

function amountsFor(row: CdpTransactionRow): AmountSlice {
  switch (row.kind) {
    case "liquidation":
      return {
        debt: sumWei(row.debtOffsetBySP, row.debtRedistributed),
        coll: sumWei(
          sumWei(row.collSentToSP, row.collRedistributed),
          row.collSurplus,
        ),
      };
    case "redemption":
      return { debt: row.actualBoldAmount, coll: row.ETHSent };
    case "spRebalance":
      return { debt: row.amountStableOut, coll: row.amountCollIn };
  }
}

function mergeRows(
  data: CdpTransactionsResponse | undefined,
): CdpTransactionRow[] {
  if (!data) return [];
  const liquidations: CdpTransactionRow[] = (data.LiquidationEvent ?? []).map(
    (r) => ({ kind: "liquidation", ...r }),
  );
  const redemptions: CdpTransactionRow[] = (data.RedemptionEvent ?? []).map(
    (r) => ({ kind: "redemption", ...r }),
  );
  const rebalances: CdpTransactionRow[] = (data.SpRebalanceEvent ?? []).map(
    (r) => ({ kind: "spRebalance", ...r }),
  );
  return [...liquidations, ...redemptions, ...rebalances].sort(
    (a, b) => Number(b.timestamp) - Number(a.timestamp),
  );
}

function isAnyKindCapped(data: CdpTransactionsResponse | undefined): boolean {
  if (!data) return false;
  return (
    (data.LiquidationEvent?.length ?? 0) >= ENVIO_MAX_ROWS ||
    (data.RedemptionEvent?.length ?? 0) >= ENVIO_MAX_ROWS ||
    (data.SpRebalanceEvent?.length ?? 0) >= ENVIO_MAX_ROWS
  );
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
  const allRows = useMemo(() => mergeRows(data), [data]);
  const anyKindCapped = isAnyKindCapped(data);

  if (error) {
    return (
      <Section>
        <ErrorBox
          message={`Failed to load CDP transactions — ${error.message}`}
        />
      </Section>
    );
  }
  if (isLoading) {
    return (
      <Section>
        <Skeleton rows={6} />
      </Section>
    );
  }
  if (allRows.length === 0) {
    return (
      <Section>
        <EmptyBox message="No CDP transactions indexed yet." />
      </Section>
    );
  }

  return (
    <Section>
      <TransactionsBody
        rows={allRows}
        chainId={chainId}
        symbol={symbol}
        capped={anyKindCapped}
      />
    </Section>
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

function Section({ children }: { children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-white mb-3">
        CDP Transactions
      </h2>
      {children}
    </section>
  );
}
