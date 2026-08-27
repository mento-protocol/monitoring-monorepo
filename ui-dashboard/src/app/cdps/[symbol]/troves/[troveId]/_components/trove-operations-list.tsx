"use client";

import { EmptyBox, ErrorBox, StaleRefreshNotice } from "@/components/feedback";
import { TableSkeleton } from "@/components/skeletons";
import { Row, Table, Td, Th } from "@/components/table";
import { Tooltip } from "@/components/tooltip";
import { TxHashCell } from "@/components/tx-hash-cell";
import { formatTimestamp, relativeTime } from "@/lib/format";
import {
  BADGE_LABELS,
  BADGE_STYLES,
  badgeKindFor,
  type BadgeKind,
} from "../../../../_lib/transactions";
import { formatSignedWei } from "../../../../_lib/format";
import type { CdpTroveOperationEventRow } from "../../../../_lib/types";
import { formatInterestRate } from "../_lib/format";

// Operation codes 3 (adjustInterestRate), 8 (setBatchManager), and 9
// (removeFromBatch) — see CdpTroveOperationEventRow's `operation` doc —
// legitimately have zero debt/collateral change, so the badge alone doesn't
// say what the operation actually did. `annualInterestRate` is already
// fetched for every row; only these two badge kinds show it next to the
// badge.
const RATE_VISIBLE_BADGES = new Set<BadgeKind>([
  "troveInterestRateChange",
  "troveBatch",
]);

// Liquity v2 OP enum values for the two batch-membership operations (see
// CdpTroveOperationEventRow's `operation` doc) — opposite actions that
// `badgeKindFor` both map to the single "troveBatch" kind.
const OP_SET_BATCH_MANAGER = 8;
const OP_REMOVE_FROM_BATCH = 9;

/** `BADGE_LABELS[kind]` is too coarse for `troveBatch`: operations 8
 *  (setBatchManager, joining/switching batch manager) and 9
 *  (removeFromBatch, leaving) are opposite actions that both map to the
 *  same badge kind — showing the shared "Batch Membership" label for both
 *  leaves the direction unrecoverable even with the rate now shown next to
 *  it. */
function operationBadgeLabel(kind: BadgeKind, operation: number): string {
  if (kind === "troveBatch") {
    if (operation === OP_SET_BATCH_MANAGER) return "Joined Batch";
    if (operation === OP_REMOVE_FROM_BATCH) return "Left Batch";
  }
  return BADGE_LABELS[kind];
}

/** The indexer's actual debt-position math is `debtAfter = debtBefore +
 *  debtChange + debtIncreaseFromUpfrontFee + debtFromRedist`
 *  (`indexer-envio/src/handlers/liquity/math.ts`) — `debtChange` alone
 *  excludes the upfront borrowing fee charged on an open or debt-increase
 *  operation, understating the actual position increase whenever that fee
 *  is nonzero. Per-operation redistribution isn't tracked here (same
 *  partial-view limit as the rest of this interim ledger). */
function totalDebtChange(row: CdpTroveOperationEventRow): string {
  return (
    BigInt(row.debtChange) + BigInt(row.debtIncreaseFromUpfrontFee)
  ).toString();
}

/** One operations-table row — split out of {@link TroveOperationsList} to
 *  keep it under the file's max-lines-per-function budget. */
function OperationRow({
  row,
  chainId,
  debtSymbol,
}: {
  row: CdpTroveOperationEventRow;
  chainId: number;
  debtSymbol: string;
}) {
  const kind = badgeKindFor({ kind: "troveOp", ...row });
  return (
    <Row>
      <Td>
        <span
          className={`inline-block rounded border px-2 py-0.5 text-xs ${BADGE_STYLES[kind]}`}
        >
          {operationBadgeLabel(kind, row.operation)}
        </span>
        {RATE_VISIBLE_BADGES.has(kind) && (
          <span className="ml-1 text-[10px] text-slate-500">
            → {formatInterestRate(row.annualInterestRate)}
          </span>
        )}
      </Td>
      <Td align="right" mono>
        {formatSignedWei(totalDebtChange(row), debtSymbol)}
      </Td>
      <Td align="right" mono>
        {formatSignedWei(row.collChange, "USDm")}
      </Td>
      <TxHashCell txHash={row.txHash} chainId={chainId} />
      <Td small muted>
        {/* `Tooltip`, not a plain `title` — a `title` alone on a `<td>` is
            unreachable without a mouse; mirrors the header's
            `EventTimeLink` fix for the same gap. */}
        <Tooltip content={formatTimestamp(row.timestamp)}>
          <span>{relativeTime(row.timestamp)}</span>
        </Tooltip>
      </Td>
    </Row>
  );
}

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
  hasLoadedOnce = rows.length > 0,
  hasLifetimeTotals = false,
  chainId,
  debtSymbol,
}: {
  rows: CdpTroveOperationEventRow[];
  truncated: boolean;
  isLoading: boolean;
  error: Error | undefined;
  /** True once the fetch has resolved at least once (`data !== undefined`),
   *  captured by the caller BEFORE any `?? []` fallback collapses "never
   *  loaded" and "loaded, confirmed empty" to the same `rows.length === 0`.
   *  A trove with zero real operations is a legitimate confirmed-empty
   *  state — without this flag, a later poll failure on that trove would
   *  misread as a first-load failure and show the hard ErrorBox instead of
   *  the EmptyBox + stale-refresh notice. Optional: defaults to `rows.length
   *  > 0`, the prior (imprecise) behavior, so callers indifferent to the
   *  loaded-vs-never-loaded distinction — most tests — don't need to pass
   *  it explicitly. */
  hasLoadedOnce?: boolean;
  /** Whether `TroveLifetimeTotals` actually rendered its card for this
   *  trove — that card returns `null` for the normal case of an untouched
   *  active trove (no redemption/liquidation history), so the partial-view
   *  notice below must not unconditionally point to a section that doesn't
   *  exist. Optional/defaults to `false` (omit the reference) so callers
   *  indifferent to it — most tests — don't need to pass it. */
  hasLifetimeTotals?: boolean;
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
        liquidations that touched this trove are not yet attributable here
        {hasLifetimeTotals ? "; see the lifetime totals above." : "."}
      </p>
      {/* Mirrors the parent view's other three notices (markets/trove/batch
          rate): once the fetch has resolved at least once, a later poll
          failure keeps the cached rows (which may legitimately be empty —
          a trove can have zero real operations) on screen — disclose that
          rather than silently continuing as if nothing happened. Gated on
          `hasLoadedOnce`, not `rows.length > 0`: a confirmed-empty trove
          must not be mistaken for "never loaded" the moment a refresh
          fails. A genuine first-load failure is handled by the ErrorBox
          branch below instead. */}
      <StaleRefreshNotice
        subject="Trove operations"
        error={hasLoadedOnce ? error : undefined}
        className="mb-3"
      />
      {error != null && !hasLoadedOnce ? (
        <ErrorBox
          message={`Failed to load trove operations — ${error.message}`}
        />
      ) : isLoading && rows.length === 0 ? (
        // Table-shaped, not the generic bar `Skeleton`: this branch swaps
        // straight into the 5-column table below once `operations` resolves
        // (the trove/markets queries can settle first), so it needs the real
        // header + row rhythm `TableSkeleton` reserves, not an unrelated shape.
        <TableSkeleton rows={4} cols={5} variant="rows" />
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
              {rows.map((row) => (
                <OperationRow
                  key={row.id}
                  row={row}
                  chainId={chainId}
                  debtSymbol={debtSymbol}
                />
              ))}
            </tbody>
          </Table>
          {truncated && (
            <p role="status" className="px-1 pt-1 text-xs text-amber-400">
              Earliest history truncated — this trove has more operations than
              fit in one fetch. The most recent operations are shown.
            </p>
          )}
        </>
      )}
    </section>
  );
}
