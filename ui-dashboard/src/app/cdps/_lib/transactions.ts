import { ENVIO_MAX_ROWS } from "@/lib/constants";
import type {
  CdpLiquidationEventRow,
  CdpRedemptionEventRow,
  CdpSpRebalanceEventRow,
  CdpTransactionRow,
  CdpTroveOperationEventRow,
} from "./types";

/** Per-kind fetch cap for the cross-CDP transactions query. Shared between
 *  the overview table and the page-level fetch that derives per-market
 *  24h activity counts for the market cards. */
export const CDP_OVERVIEW_PER_KIND_FETCH_LIMIT = 250;

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
  spRebalance: "Rebalance",
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

/** Per-leg before/after/delta snapshot used by the trove-op row renderer.
 *  `delta` is signed (positive = increase, negative = decrease) and is
 *  derived as `after - before` so the rendered delta is internally
 *  consistent even if the underlying ABI ever exposed extra redist terms
 *  the indexer didn't fold in. */
export interface TroveSnapshotLeg {
  before: string;
  after: string;
  delta: string;
}

export interface TroveSnapshot {
  debt: TroveSnapshotLeg;
  coll: TroveSnapshotLeg;
}

/** Returns null for non-troveOp rows — keeps the discriminated-union
 *  branching at the call site explicit rather than forcing every caller
 *  to switch on `row.kind` twice. */
export function troveSnapshotFor(row: CdpTransactionRow): TroveSnapshot | null {
  if (row.kind !== "troveOp") return null;
  const debtBefore = BigInt(row.debtBefore);
  const debtAfter = BigInt(row.debtAfter);
  const collBefore = BigInt(row.collBefore);
  const collAfter = BigInt(row.collAfter);
  return {
    debt: {
      before: row.debtBefore,
      after: row.debtAfter,
      delta: (debtAfter - debtBefore).toString(),
    },
    coll: {
      before: row.collBefore,
      after: row.collAfter,
      delta: (collAfter - collBefore).toString(),
    },
  };
}

export type MergedTransactions = {
  rows: CdpTransactionRow[];
  capped: boolean;
};

/** Merge the 4 event arrays into a single timestamp-desc list with an
 *  id-desc tiebreak. `capped` is true when any per-kind array hit
 *  `limit` — surface as a footnote so older entries aren't silently
 *  dropped. `limit` defaults to ENVIO_MAX_ROWS for the per-market table
 *  which fetches the full Hasura cap; the overview table passes its
 *  smaller per-kind fetch limit so the cap is detected accurately. */
export function mergeTransactionRows(
  data: CdpTransactionsResponse | undefined,
  limit: number = ENVIO_MAX_ROWS,
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
    liquidations.length >= limit ||
    redemptions.length >= limit ||
    rebalances.length >= limit ||
    troveOps.length >= limit;
  return { rows, capped };
}
