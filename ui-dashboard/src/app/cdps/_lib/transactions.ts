import { ENVIO_MAX_ROWS } from "@/lib/constants";
import type {
  CdpLiquidationEventRow,
  CdpRedemptionEventRow,
  CdpSpRebalanceEventRow,
  CdpTransactionRow,
  CdpTroveOperationEventRow,
} from "./types";

export type CdpTransactionsResponse = {
  LiquidationEvent: CdpLiquidationEventRow[];
  RedemptionEvent: CdpRedemptionEventRow[];
  SpRebalanceEvent: CdpSpRebalanceEventRow[];
  TroveOperationEvent: CdpTroveOperationEventRow[];
};

export type BadgeKind =
  | "liquidation"
  | "userRedemption"
  | "rebalanceRedemption"
  | "spRebalance"
  | "troveOpen"
  | "troveClose"
  | "troveAdjust"
  | "troveInterestRateChange"
  | "troveBatch";

export const BADGE_STYLES: Record<BadgeKind, string> = {
  liquidation: "bg-amber-500/10 text-amber-300 border-amber-700/40",
  userRedemption: "bg-indigo-500/10 text-indigo-300 border-indigo-700/40",
  rebalanceRedemption: "bg-slate-500/10 text-slate-300 border-slate-600/40",
  spRebalance: "bg-cyan-500/10 text-cyan-300 border-cyan-700/40",
  troveOpen: "bg-emerald-500/10 text-emerald-300 border-emerald-700/40",
  troveClose: "bg-rose-500/10 text-rose-300 border-rose-700/40",
  troveAdjust: "bg-sky-500/10 text-sky-300 border-sky-700/40",
  troveInterestRateChange:
    "bg-violet-500/10 text-violet-300 border-violet-700/40",
  troveBatch: "bg-zinc-500/10 text-zinc-300 border-zinc-600/40",
};

export const BADGE_LABELS: Record<BadgeKind, string> = {
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

export function badgeKindFor(row: CdpTransactionRow): BadgeKind {
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

export interface AmountSlice {
  debt: string;
  coll: string;
}

export function amountsFor(row: CdpTransactionRow): AmountSlice {
  switch (row.kind) {
    case "liquidation":
      // Full event-total: every BOLD field that left the trove (principal +
      // gas comp) and every coll field seized (principal + gas comp).
      // `collSurplus` is excluded — it returns to the original trove owner
      // and isn't "seized" in the liquidation sense.
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

export type MergedTransactions = {
  rows: CdpTransactionRow[];
  capped: boolean;
};

/** Merge the 4 event arrays into a single timestamp-desc list with an
 *  id-desc tiebreak. `capped` is true when any per-kind array hit
 *  ENVIO_MAX_ROWS — surface as a footnote so older entries aren't
 *  silently dropped. */
export function mergeTransactionRows(
  data: CdpTransactionsResponse | undefined,
): MergedTransactions {
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
