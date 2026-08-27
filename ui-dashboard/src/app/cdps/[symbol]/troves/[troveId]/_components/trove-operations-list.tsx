"use client";

import {
  EmptyBox,
  ErrorBox,
  Skeleton,
  StaleRefreshNotice,
} from "@/components/feedback";
import { Row, Table, Td, Th } from "@/components/table";
import { TxHashCell } from "@/components/tx-hash-cell";
import { formatTimestamp, relativeTime } from "@/lib/format";
import {
  BADGE_LABELS,
  BADGE_STYLES,
  badgeKindFor,
} from "../../../../_lib/transactions";
import { formatSignedWei } from "../../../../_lib/format";
import type { CdpTroveOperationEventRow } from "../../../../_lib/types";

/** Interim ledger (docs/PLAN-trove-history-page.md, "GraphQL contract →
 *  interim assembly"): user-initiated trove operations only. Protocol rows
 *  (redemptions, liquidation) aren't attributed to a single trove by this
 *  query, so this list is explicitly partial — never used to derive interest
 *  residuals, a chart, net equity, or a cumulatives reconciliation. Those
 *  land with the full `TroveLedgerEvent` ledger (M4 child, #2086). */
export function TroveOperationsList({
  rows,
  truncated,
  isLoading,
  error,
  chainId,
  debtSymbol,
}: {
  rows: CdpTroveOperationEventRow[];
  truncated: boolean;
  isLoading: boolean;
  error: Error | undefined;
  chainId: number;
  debtSymbol: string;
}) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-white mb-1">
        Trove operations
      </h2>
      <p role="status" className="mb-3 text-xs text-amber-400">
        Per-redemption detail pending indexer rollout — this list shows only
        this trove&apos;s own borrow/repay/adjust operations. Redemptions and
        liquidations that touched this trove are not yet attributable here; see
        the lifetime totals above.
      </p>
      {/* Mirrors the parent view's other three notices (markets/trove/batch
          rate): once rows have loaded at least once, a later poll failure
          keeps the cached rows on screen — disclose that rather than
          silently continuing as if nothing happened. A first-load failure
          (rows still empty) is handled by the ErrorBox branch below
          instead, so this stays gated to the "already had data" case. */}
      <StaleRefreshNotice
        subject="Trove operations"
        error={rows.length > 0 ? error : undefined}
        className="mb-3"
      />
      {error != null && rows.length === 0 ? (
        <ErrorBox
          message={`Failed to load trove operations — ${error.message}`}
        />
      ) : isLoading && rows.length === 0 ? (
        <Skeleton rows={4} />
      ) : rows.length === 0 ? (
        <EmptyBox message="No operations indexed for this trove yet." />
      ) : (
        <>
          <Table aria-label="Trove operations">
            <thead>
              <Row>
                <Th>Type</Th>
                <Th align="right">Debt Δ</Th>
                <Th align="right">Collateral Δ</Th>
                <Th>Tx</Th>
                <Th>Time</Th>
              </Row>
            </thead>
            <tbody>
              {rows.map((row) => {
                const kind = badgeKindFor({ kind: "troveOp", ...row });
                return (
                  <Row key={row.id}>
                    <Td>
                      <span
                        className={`inline-block rounded border px-2 py-0.5 text-xs ${BADGE_STYLES[kind]}`}
                      >
                        {BADGE_LABELS[kind]}
                      </span>
                    </Td>
                    <Td align="right" mono>
                      {formatSignedWei(row.debtChange, debtSymbol)}
                    </Td>
                    <Td align="right" mono>
                      {formatSignedWei(row.collChange, "USDm")}
                    </Td>
                    <TxHashCell txHash={row.txHash} chainId={chainId} />
                    <Td small muted title={formatTimestamp(row.timestamp)}>
                      {relativeTime(row.timestamp)}
                    </Td>
                  </Row>
                );
              })}
            </tbody>
          </Table>
          {truncated && (
            <p className="px-1 pt-1 text-xs text-amber-400">
              Earliest history truncated — this trove has more operations than
              fit in one fetch. The most recent operations are shown.
            </p>
          )}
        </>
      )}
    </section>
  );
}
