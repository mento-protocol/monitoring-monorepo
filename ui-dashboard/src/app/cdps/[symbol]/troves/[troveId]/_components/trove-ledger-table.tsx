"use client";

import { useMemo, useState } from "react";
import { EmptyBox, ErrorBox, StaleRefreshNotice } from "@/components/feedback";
import { TableSkeleton } from "@/components/skeletons";
import { Row, Table, Td, Th } from "@/components/table";
import { Tooltip } from "@/components/tooltip";
import { TxHashCell } from "@/components/tx-hash-cell";
import { formatTimestamp, relativeTime } from "@/lib/format";
import { BADGE_STYLES, type BadgeKind } from "../../../../_lib/transactions";
import { formatSignedWei, formatTokenAmount } from "../../../../_lib/format";
import {
  formatBpsPercent,
  formatInterestRate,
  icrTextClass,
} from "../_lib/format";
import {
  buildTroveLedgerDisplayRows,
  ledgerBadgeKindFor,
  ledgerBadgeLabel,
  totalLedgerCollChange,
  totalLedgerDebtChange,
  troveLedgerStatusFlip,
  type CdpTroveLedgerEventRow,
  type TroveLedgerDisplayRow,
} from "../_lib/ledger";

const BADGE_PILL_CLASSES = "inline-block rounded border px-2 py-0.5 text-xs";

// Ops whose rate annotation carries the row's story (same set as the interim
// list): 3 adjustInterestRate, 7 openAndJoinBatch, 8 setBatchManager,
// 9 removeFromBatch — the batch kinds plus op 7, which shares `troveOpen`'s
// kind with plain opens.
const RATE_VISIBLE_BADGES = new Set<BadgeKind>([
  "troveInterestRateChange",
  "troveBatch",
]);
const OP_OPEN_AND_JOIN_BATCH = 7;

function shouldShowLedgerRate(kind: BadgeKind, operation: number): boolean {
  return RATE_VISIBLE_BADGES.has(kind) || operation === OP_OPEN_AND_JOIN_BATCH;
}

/** The Fees cell is a component breakdown, not an extra delta: the upfront
 *  borrowing fee is already inside the row's Δ debt (and `debtAfter`), and
 *  the credited redemption fee — always positive, it is paid TO the trove —
 *  is already netted inside the collateral identity. `—` means no fee on
 *  this row; a 0-value credited fee (urgent redemption) still renders as a
 *  confirmed `+0.00`, distinct from unknown. */
function feesCellText(row: CdpTroveLedgerEventRow, debtSymbol: string): string {
  const parts: string[] = [];
  if (BigInt(row.debtIncreaseFromUpfrontFee) !== BigInt(0)) {
    parts.push(
      `+${formatTokenAmount(row.debtIncreaseFromUpfrontFee, debtSymbol)} fee`,
    );
  }
  if (row.redemptionFeeCredited != null) {
    parts.push(
      `+${formatTokenAmount(row.redemptionFeeCredited, "USDm")} credited`,
    );
  }
  return parts.length === 0 ? "—" : parts.join(" · ");
}

function TimeCell({ timestamp }: { timestamp: string }) {
  return (
    <Td small muted>
      {/* `Tooltip`, not a plain `title` — a `title` alone on a `<td>` is
          unreachable without a mouse (same fix as the interim list). */}
      <Tooltip content={formatTimestamp(timestamp)}>
        <span>{relativeTime(timestamp)}</span>
      </Tooltip>
    </Td>
  );
}

function LedgerEventRow({
  row,
  chainId,
  debtSymbol,
  mcrBps,
}: {
  row: CdpTroveLedgerEventRow;
  chainId: number;
  debtSymbol: string;
  mcrBps: number;
}) {
  const kind = ledgerBadgeKindFor(row);
  const flip = troveLedgerStatusFlip(row);
  return (
    <Row>
      <TimeCell timestamp={row.timestamp} />
      <TxHashCell txHash={row.txHash} chainId={chainId} />
      <Td>
        <span className={`${BADGE_PILL_CLASSES} ${BADGE_STYLES[kind]}`}>
          {ledgerBadgeLabel(kind, row.operation)}
        </span>
        {shouldShowLedgerRate(kind, row.operation) && (
          <span className="ml-1 text-[10px] text-slate-500">
            → {formatInterestRate(row.annualInterestRate)}
          </span>
        )}
        {flip != null &&
          (flip.kind != null ? (
            <span
              className={`ml-1 ${BADGE_PILL_CLASSES} ${BADGE_STYLES[flip.kind]}`}
            >
              {flip.text}
            </span>
          ) : (
            <span className="ml-1 text-[10px] text-slate-500">{flip.text}</span>
          ))}
      </Td>
      <Td align="right" mono>
        {formatSignedWei(totalLedgerDebtChange(row), debtSymbol)}
      </Td>
      <Td align="right" mono>
        {formatSignedWei(totalLedgerCollChange(row), "USDm")}
      </Td>
      <Td align="right" mono small>
        {feesCellText(row, debtSymbol)}
      </Td>
      <Td align="right" mono>
        {/* Nullable on batch-op rows — `formatTokenAmount` renders null as
            an em dash, never zero. (The unsigned formatter is correct here:
            recorded totals are unsigned; the −1 sentinel cannot occur.) */}
        {formatTokenAmount(row.debtAfter, debtSymbol)}
      </Td>
      <Td align="right" mono>
        {formatTokenAmount(row.collAfter, "USDm")}
      </Td>
      <Td align="right" mono>
        {/* `icrAfterBps` null (no price at this row) → −1 → em dash. */}
        <span className={icrTextClass(row.icrAfterBps ?? -1, mcrBps)}>
          {formatBpsPercent(row.icrAfterBps ?? -1)}
        </span>
      </Td>
    </Row>
  );
}

/** Synthetic client-side estimate row — labeled as such, no tx, and every
 *  column that would imply recorded data stays an em dash. */
function InterestEstimateRow({
  timestamp,
  amount,
  debtSymbol,
}: {
  timestamp: string;
  amount: string;
  debtSymbol: string;
}) {
  return (
    <Row>
      <TimeCell timestamp={timestamp} />
      <Td small muted>
        —
      </Td>
      <Td>
        <span className={`${BADGE_PILL_CLASSES} ${BADGE_STYLES.interest}`}>
          Interest accrued
        </span>
        <span className="ml-1 text-[10px] text-slate-500">estimate</span>
      </Td>
      <Td align="right" mono muted>
        ≈ +{formatTokenAmount(amount, debtSymbol)}
      </Td>
      <Td align="right" mono muted>
        —
      </Td>
      <Td align="right" mono small muted>
        —
      </Td>
      <Td align="right" mono muted>
        —
      </Td>
      <Td align="right" mono muted>
        —
      </Td>
      <Td align="right" mono muted>
        —
      </Td>
    </Row>
  );
}

function LedgerTableBody({
  displayRows,
  chainId,
  debtSymbol,
  mcrBps,
}: {
  displayRows: TroveLedgerDisplayRow[];
  chainId: number;
  debtSymbol: string;
  mcrBps: number;
}) {
  return (
    <tbody>
      {displayRows.map((entry) =>
        entry.kind === "event" ? (
          <LedgerEventRow
            key={entry.row.id}
            row={entry.row}
            chainId={chainId}
            debtSymbol={debtSymbol}
            mcrBps={mcrBps}
          />
        ) : (
          <InterestEstimateRow
            key={entry.id}
            timestamp={entry.timestamp}
            amount={entry.amount}
            debtSymbol={debtSymbol}
          />
        ),
      )}
    </tbody>
  );
}

function LedgerNotices({
  truncated,
  debtSnapshotsComplete,
  hasInterestEstimates,
}: {
  truncated: boolean;
  debtSnapshotsComplete: boolean;
  hasInterestEstimates: boolean;
}) {
  return (
    <>
      {truncated && (
        <p role="status" className="px-1 pt-1 text-xs text-amber-400">
          Earliest history truncated — this trove has more ledger events than
          fit in one fetch. The most recent events are shown, and interest
          estimates are off for an incomplete history.
        </p>
      )}
      {!debtSnapshotsComplete && (
        <p role="status" className="px-1 pt-1 text-xs text-amber-400">
          Batch data unavailable — batch-managed rows carry no per-trove debt
          snapshots, so their debt column shows — and interest estimates are
          off.
        </p>
      )}
      {hasInterestEstimates && (
        <p className="px-1 pt-1 text-xs text-slate-500">
          “Interest accrued” rows are client-side estimates between recorded
          snapshots — excluded from every total.
        </p>
      )}
    </>
  );
}

/** The sortable Time header plus the static column set — split out of
 *  {@link LedgerLoadedTable} for the lint complexity budget. `aria-sort`
 *  lives on the `<th>`; the toggle is a real button. */
function LedgerHeaderRow({
  newestFirst,
  onToggleOrder,
}: {
  newestFirst: boolean;
  onToggleOrder: () => void;
}) {
  return (
    <Row>
      <Th aria-sort={newestFirst ? "descending" : "ascending"}>
        <button
          type="button"
          onClick={onToggleOrder}
          className="inline-flex items-center gap-1 hover:text-slate-200"
          title={
            newestFirst
              ? "Newest first — click for oldest first"
              : "Oldest first — click for newest first"
          }
        >
          Time
          <span aria-hidden="true">{newestFirst ? "↓" : "↑"}</span>
        </button>
      </Th>
      <Th>Tx</Th>
      <Th>Event</Th>
      <Th align="right">Δ Debt</Th>
      <Th align="right">Δ Coll</Th>
      <Th align="right">Fees</Th>
      <Th align="right">Debt →</Th>
      <Th align="right">Coll →</Th>
      <Th align="right">ICR →</Th>
    </Row>
  );
}

function LedgerLoadedTable({
  displayRows,
  newestFirst,
  onToggleOrder,
  truncated,
  debtSnapshotsComplete,
  chainId,
  debtSymbol,
  mcrBps,
}: {
  displayRows: TroveLedgerDisplayRow[];
  newestFirst: boolean;
  onToggleOrder: () => void;
  truncated: boolean;
  debtSnapshotsComplete: boolean;
  chainId: number;
  debtSymbol: string;
  mcrBps: number;
}) {
  return (
    <>
      <Table aria-label="Trove ledger">
        <thead>
          <LedgerHeaderRow
            newestFirst={newestFirst}
            onToggleOrder={onToggleOrder}
          />
        </thead>
        <LedgerTableBody
          displayRows={displayRows}
          chainId={chainId}
          debtSymbol={debtSymbol}
          mcrBps={mcrBps}
        />
      </Table>
      <LedgerNotices
        truncated={truncated}
        debtSnapshotsComplete={debtSnapshotsComplete}
        hasInterestEstimates={displayRows.some(
          (entry) => entry.kind === "interest",
        )}
      />
    </>
  );
}

/** Complete per-trove ledger (docs/PLAN-trove-history-page.md, "UI design →
 *  Ledger table"): all ten operation ordinals, rendered only when the
 *  introspection gate confirms the live schema serves `TroveLedgerEvent` —
 *  the interim `TroveOperationsList` covers the unsupported case. Default
 *  order is chronological ascending with the (timestamp, blockNumber,
 *  logIndex) tiebreaks; the newest-first toggle is LOCAL state by intent —
 *  one bounded dataset, no URL pagination to keep in sync. */
export function TroveLedgerTable({
  rows,
  truncated,
  complete,
  anchored,
  debtSnapshotsComplete,
  isLoading,
  error,
  hasLoadedOnce,
  chainId,
  debtSymbol,
  mcrBps,
}: {
  /** Chronological (oldest-first), already capped at the render limit. */
  rows: CdpTroveLedgerEventRow[];
  truncated: boolean;
  /** Derivation gate: loaded and not truncated. Interest estimates render
   *  only when this AND `anchored` AND `debtSnapshotsComplete` hold. */
  complete: boolean;
  /** The trove's ledger watermark equals the newest row's (blockNumber,
   *  logIndex) pair — same gate the impact panel's reconciliation uses
   *  (#2088). An un-anchored response may be a mid-write read whose
   *  snapshots aren't yet finalized, so even the row-only interest residual
   *  stays off; the next poll re-anchors, so no notice — unlike truncation
   *  and batch rows, this state cannot persist on a healthy indexer. */
  anchored: boolean;
  debtSnapshotsComplete: boolean;
  isLoading: boolean;
  error: Error | undefined;
  /** Same loaded-vs-never-loaded contract as `TroveOperationsList`: comes
   *  from `data != null`, not `rows.length > 0`, so a confirmed-empty
   *  ledger survives a later poll failure as a stale-refresh notice, not a
   *  hard first-load error. */
  hasLoadedOnce: boolean;
  chainId: number;
  debtSymbol: string;
  /** From the market's `LiquityCollateral` row — params never come from
   *  constants. */
  mcrBps: number;
}) {
  const [newestFirst, setNewestFirst] = useState(false);
  const displayRows = useMemo(() => {
    const ascending = buildTroveLedgerDisplayRows(rows, {
      synthesizeInterest: complete && anchored && debtSnapshotsComplete,
    });
    return newestFirst ? [...ascending].reverse() : ascending;
  }, [rows, complete, anchored, debtSnapshotsComplete, newestFirst]);

  return (
    <section>
      <h2 className="text-lg font-semibold text-white mb-1">Trove ledger</h2>
      <p className="mb-3 text-xs text-slate-500">
        Complete event history for this trove — every operation, redemption, and
        liquidation, oldest first.
      </p>
      <StaleRefreshNotice
        subject="Trove ledger"
        error={hasLoadedOnce ? error : undefined}
        className="mb-3"
      />
      {error != null && !hasLoadedOnce ? (
        // First-load failure: the header cards above keep rendering; this
        // section degrades alone. Retry is automatic — the shared SWR retry
        // policy and the 30s poll keep re-attempting.
        <ErrorBox
          message={`Failed to load the trove ledger — ${error.message}. Retrying automatically.`}
        />
      ) : isLoading && rows.length === 0 ? (
        <TableSkeleton rows={4} cols={9} variant="rows" />
      ) : rows.length === 0 ? (
        <EmptyBox message="No ledger events indexed for this trove yet." />
      ) : (
        <LedgerLoadedTable
          displayRows={displayRows}
          newestFirst={newestFirst}
          onToggleOrder={() => setNewestFirst((value) => !value)}
          truncated={truncated}
          debtSnapshotsComplete={debtSnapshotsComplete}
          chainId={chainId}
          debtSymbol={debtSymbol}
          mcrBps={mcrBps}
        />
      )}
    </section>
  );
}
