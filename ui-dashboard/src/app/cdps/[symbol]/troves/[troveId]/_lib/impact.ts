// Redemption-impact domain logic for the trove history page
// (docs/PLAN-trove-history-page.md, "UI design → Redemption impact" and
// invariant 2): per-redemption ledger sums, the user-vs-rebalance split, the
// net-equity-at-oracle-prices figure, and the cumulatives reconciliation
// that decides whether any of it may render. Pure functions only — the
// refetch-once state machine lives in `use-trove-impact.ts`.

import {
  ledgerWatermarkMatchesNewestRow,
  type CdpTroveLedgerEventRow,
  type TroveLedgerWatermark,
  type TroveRedemptionCumulatives,
} from "./ledger";

const D18 = BigInt(10) ** BigInt(18);
// Mirrors `OP.REDEEM_COLLATERAL` in indexer-envio (cross-package imports are
// off-limits; renumbering must update both).
const OP_REDEEM_COLLATERAL = 6;

/** Sums over the ledger's op-6 rows. `debt`/`coll` accumulate the RAW event
 *  deltas (|debtChange| / |collChange|, redist terms excluded) because that
 *  is exactly what the indexer's cumulative counters accumulate
 *  (`troveManagerTransitions.ts`) — the reconciliation compares like with
 *  like, to the wei. The credited fee is already netted inside `collChange`
 *  by the writer's collateral identity, so "collateral taken" is net of the
 *  fee the trove kept. */
export type TroveRedemptionLedgerSums = {
  count: number;
  /** Positive Σ|debtChange| over op-6 rows, wei string. */
  debt: string;
  /** Positive Σ|collChange| over op-6 rows, wei string. */
  coll: string;
  /** Positive Σ redemptionFeeCredited, wei string. A null fee on a drifted
   *  row counts as 0 — the reconciliation then fails loudly instead of the
   *  sum guessing. */
  fees: string;
  rebalanceCount: number;
  rebalanceDebt: string;
  rebalanceColl: string;
  /** Op-6 rows with `isRebalance` null — undiscriminated. Any such row
   *  makes the user-vs-rebalance split unavailable: totals must never be
   *  presented as user activity, and user-driven = total − rebalance only
   *  holds when every row is discriminated. */
  undiscriminatedCount: number;
  /** Op-6 rows with no usable `redemptionPrice`. Any such hit suppresses
   *  the net-equity figure — substituting the current FX rate would
   *  fabricate the core support answer. */
  missingPriceCount: number;
  /** Signed wei string: Σ over hits of (collateral change) − (debt change
   *  valued at THAT hit's oracle `redemptionPrice`). Collateral is the USDm
   *  unit itself; debt converts via debtChange·1e18/price (price is the
   *  D18 debt-per-collateral rate the indexer's ICR math uses). Because
   *  `collChange` is net of the credited fee, the fee is inside this figure
   *  — the deleverage-at-par lesson in one number. Null when any hit is
   *  unpriced or there are no hits. */
  netEquity: string | null;
};

export function sumTroveRedemptionRows(
  rows: readonly CdpTroveLedgerEventRow[],
): TroveRedemptionLedgerSums {
  let count = 0;
  let rebalanceCount = 0;
  let undiscriminatedCount = 0;
  let missingPriceCount = 0;
  let debt = BigInt(0);
  let coll = BigInt(0);
  let fees = BigInt(0);
  let rebalanceDebt = BigInt(0);
  let rebalanceColl = BigInt(0);
  let equity = BigInt(0);
  for (const row of rows) {
    if (row.operation !== OP_REDEEM_COLLATERAL) continue;
    count += 1;
    const debtChange = BigInt(row.debtChange);
    const collChange = BigInt(row.collChange);
    const rowDebt = debtChange < BigInt(0) ? -debtChange : debtChange;
    const rowColl = collChange < BigInt(0) ? -collChange : collChange;
    debt += rowDebt;
    coll += rowColl;
    fees += BigInt(row.redemptionFeeCredited ?? "0");
    if (row.isRebalance === true) {
      rebalanceCount += 1;
      rebalanceDebt += rowDebt;
      rebalanceColl += rowColl;
    } else if (row.isRebalance == null) {
      undiscriminatedCount += 1;
    }
    const price =
      row.redemptionPrice == null ? null : BigInt(row.redemptionPrice);
    if (price == null || price <= BigInt(0)) {
      missingPriceCount += 1;
    } else {
      equity += collChange - (debtChange * D18) / price;
    }
  }
  return {
    count,
    debt: debt.toString(),
    coll: coll.toString(),
    fees: fees.toString(),
    rebalanceCount,
    rebalanceDebt: rebalanceDebt.toString(),
    rebalanceColl: rebalanceColl.toString(),
    undiscriminatedCount,
    missingPriceCount,
    netEquity: count > 0 && missingPriceCount === 0 ? equity.toString() : null,
  };
}

/** Exact equality on all four redemption figures — the ledger and the
 *  cumulatives are two writers over the same events, so anything but
 *  to-the-wei agreement is a bug surface, not rounding. */
export function reconcileTroveRedemptions(
  sums: TroveRedemptionLedgerSums,
  cumulatives: TroveRedemptionCumulatives,
): boolean {
  return (
    sums.count === cumulatives.redemptionCount &&
    BigInt(sums.debt) === BigInt(cumulatives.redeemedDebt) &&
    BigInt(sums.coll) === BigInt(cumulatives.redeemedColl) &&
    BigInt(sums.fees) === BigInt(cumulatives.redemptionFeePaidCum)
  );
}

export function troveRedemptionCumulatives(trove: {
  redemptionCount: number;
  redeemedDebt: string;
  redeemedColl: string;
  redemptionFeePaidCum: string;
}): TroveRedemptionCumulatives {
  return {
    redemptionCount: trove.redemptionCount,
    redeemedDebt: trove.redeemedDebt,
    redeemedColl: trove.redeemedColl,
    redemptionFeePaidCum: trove.redemptionFeePaidCum,
  };
}

function isZeroCumulatives(cumulatives: TroveRedemptionCumulatives): boolean {
  return (
    cumulatives.redemptionCount === 0 &&
    BigInt(cumulatives.redeemedDebt) === BigInt(0) &&
    BigInt(cumulatives.redeemedColl) === BigInt(0) &&
    BigInt(cumulatives.redemptionFeePaidCum) === BigInt(0)
  );
}

/** Why per-hit figures are withheld and only cumulative totals render:
 *  - `partial`: interim view — the schema gate is closed, no ledger exists.
 *  - `pending`: gate open but the ledger has not loaded once.
 *  - `truncated`: capped history counts as partial for every derivation —
 *    a dropped early row would misattribute its deltas.
 *  - `batch`: a null batch debt snapshot switches reconciliation (and the
 *    interest residual) to the explicit batch notice.
 *  - `unverified`: the watermark does not equal the newest row's pair (or
 *    the response is missing its anchor row) — the check is SKIPPED, never
 *    run against skewed reads; the next poll re-anchors. */
export type TroveRedemptionTotalsReason =
  | "partial"
  | "pending"
  | "truncated"
  | "batch"
  | "unverified";

export type TroveRedemptionImpactStatus =
  | { kind: "totals"; reason: TroveRedemptionTotalsReason }
  | { kind: "reconciled"; sums: TroveRedemptionLedgerSums }
  /** Watermark matched, sums did not: the caller refetches once; only a
   *  persistent mismatch surfaces as the warning state. */
  | { kind: "mismatch" };

/** The derivation gate ladder (docs/PLAN-trove-history-page.md, invariant 2
 *  plus the degraded-modes section), in precedence order. The reconciliation
 *  runs ONLY when the watermark pair equals the newest ledger row's
 *  (blockNumber, logIndex) — with no rows there is no newest row, so the
 *  check is skipped, except the vacuous case: a `(0, 0)` watermark says "no
 *  ledger row was ever written", and all-zero cumulatives agree with zero
 *  rows exactly, so a fresh trove verifies trivially instead of sitting in
 *  "unverified" forever. */
export function classifyTroveRedemptionImpact(ledger: {
  supported: boolean;
  hasLoadedOnce: boolean;
  truncated: boolean;
  debtSnapshotsComplete: boolean;
  rows: readonly CdpTroveLedgerEventRow[];
  watermark: TroveLedgerWatermark | null;
  cumulatives: TroveRedemptionCumulatives | null;
}): TroveRedemptionImpactStatus {
  if (!ledger.supported) return { kind: "totals", reason: "partial" };
  if (!ledger.hasLoadedOnce) return { kind: "totals", reason: "pending" };
  if (ledger.truncated) return { kind: "totals", reason: "truncated" };
  if (!ledger.debtSnapshotsComplete) return { kind: "totals", reason: "batch" };
  const cumulatives = ledger.cumulatives;
  if (cumulatives == null) return { kind: "totals", reason: "unverified" };
  if (ledger.rows.length === 0) {
    const neverWroteARow =
      ledger.watermark != null &&
      BigInt(ledger.watermark.lastLedgerBlock) === BigInt(0) &&
      ledger.watermark.lastLedgerLogIndex === 0;
    return neverWroteARow && isZeroCumulatives(cumulatives)
      ? { kind: "reconciled", sums: sumTroveRedemptionRows([]) }
      : { kind: "totals", reason: "unverified" };
  }
  if (!ledgerWatermarkMatchesNewestRow(ledger.watermark, ledger.rows)) {
    return { kind: "totals", reason: "unverified" };
  }
  const sums = sumTroveRedemptionRows(ledger.rows);
  return reconcileTroveRedemptions(sums, cumulatives)
    ? { kind: "reconciled", sums }
    : { kind: "mismatch" };
}
