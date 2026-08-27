"use client";

import { formatSignedWei, formatTokenAmount } from "../../../../_lib/format";
import type { CdpTrove } from "../../../../_lib/types";
import type { TroveRedemptionLedgerSums } from "../_lib/impact";
import type { TroveRedemptionCumulatives } from "../_lib/ledger";
import type { TroveLedgerState } from "../_lib/use-trove-ledger";
import {
  useTroveRedemptionImpact,
  type TroveRedemptionImpactModel,
} from "../_lib/use-trove-impact";

function isPositiveWei(value: string | null | undefined): boolean {
  if (value == null) return false;
  try {
    return BigInt(value) > BigInt(0);
  } catch {
    return false;
  }
}

/** Whether this trove has any lifetime redemption/liquidation totals to
 *  show. Exported so callers that reference the impact panel's totals (e.g.
 *  `TroveOperationsList`'s partial-view notice) can condition that reference
 *  on the totals actually existing, instead of duplicating this check and
 *  risking drift. (The panel itself always renders — a trove nothing has
 *  touched gets the honest empty line, which IS the support answer.) */
export function hasTroveLifetimeTotals(trove: CdpTrove): boolean {
  const hasRedemptions =
    trove.redemptionCount > 0 ||
    isPositiveWei(trove.redeemedDebt) ||
    isPositiveWei(trove.redeemedColl);
  const hasLiquidation =
    isPositiveWei(trove.liquidatedDebt) || isPositiveWei(trove.liquidatedColl);
  return hasRedemptions || hasLiquidation;
}

function hasRedemptionHistory(c: TroveRedemptionCumulatives): boolean {
  return (
    c.redemptionCount > 0 ||
    isPositiveWei(c.redeemedDebt) ||
    isPositiveWei(c.redeemedColl)
  );
}

function negated(value: string): string {
  return (-BigInt(value)).toString();
}

/** Credits and gains render with an explicit sign either way — a bare
 *  positive figure next to negative deltas would read as ambiguous. Only
 *  used for non-negative-or-signed REAL amounts, so `formatTokenAmount`'s
 *  −1 sentinel rule cannot fire on the positive branch. */
function formatSignedWithPlus(value: string, symbol: string): string {
  return BigInt(value) < BigInt(0)
    ? formatSignedWei(value, symbol)
    : `+${formatTokenAmount(value, symbol)}`;
}

/** The count's split sub-label — "5 · all rebalancing" style. Null (no
 *  claim) outside reconciled mode; inside it, an undiscriminated row makes
 *  the split unavailable rather than guessed: totals are never presented as
 *  user activity. */
function splitCountLabel(sums: TroveRedemptionLedgerSums): string {
  if (sums.undiscriminatedCount > 0) {
    return `split unavailable — ${sums.undiscriminatedCount} undiscriminated hit${sums.undiscriminatedCount === 1 ? "" : "s"}`;
  }
  if (sums.rebalanceCount === sums.count) return "all rebalancing";
  if (sums.rebalanceCount === 0) return "all user-driven";
  return `${sums.rebalanceCount} rebalancing · ${sums.count - sums.rebalanceCount} user-driven`;
}

/** Per-figure user/rebalance amounts, only when the hits genuinely mix —
 *  an all-one-kind history is already told by the count's sub-label, and an
 *  undiscriminated history must not split at all. User-driven = total −
 *  rebalance, per the redemption-attribution invariant. */
function mixedSplitSub(
  total: string,
  rebalance: string,
  sums: TroveRedemptionLedgerSums,
  symbol: string,
): string | null {
  if (sums.undiscriminatedCount > 0) return null;
  if (sums.rebalanceCount === 0 || sums.rebalanceCount === sums.count) {
    return null;
  }
  const user = (BigInt(total) - BigInt(rebalance)).toString();
  return `user ${formatSignedWei(negated(user), symbol)} · rebalance ${formatSignedWei(negated(rebalance), symbol)}`;
}

function ImpactStat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string | null | undefined;
}) {
  return (
    <div>
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-0.5 font-mono text-sm text-slate-200">{value}</p>
      {sub != null && (
        <p className="mt-0.5 text-[10px] text-slate-500">{sub}</p>
      )}
    </div>
  );
}

const FIGURE_GRID_CLASSES =
  "mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4";

/** The four cumulative figures every mode can show. Fees are credited TO
 *  the trove and always render positive. */
function CumulativeFigures({
  cumulatives,
  debtSymbol,
  countSub,
  debtSub,
  collSub,
}: {
  cumulatives: TroveRedemptionCumulatives;
  debtSymbol: string;
  countSub?: string | null;
  debtSub?: string | null;
  collSub?: string | null;
}) {
  return (
    <>
      <ImpactStat
        label="Redemptions"
        value={cumulatives.redemptionCount.toLocaleString()}
        sub={countSub}
      />
      <ImpactStat
        label="Debt repaid"
        value={formatSignedWei(negated(cumulatives.redeemedDebt), debtSymbol)}
        sub={debtSub}
      />
      <ImpactStat
        label="Collateral taken"
        value={formatSignedWei(negated(cumulatives.redeemedColl), "USDm")}
        sub={collSub}
      />
      <ImpactStat
        label="Fees kept"
        value={formatSignedWithPlus(cumulatives.redemptionFeePaidCum, "USDm")}
      />
    </>
  );
}

/** Reconciled mode adds the split sub-labels and the net-equity figure —
 *  the sums ARE the cumulatives here (reconciliation proved it), so the
 *  cumulative cells and the per-hit annotations cannot disagree. A hit with
 *  no oracle price suppresses the equity figure entirely: valuing it at the
 *  current FX rate would fabricate the core support answer. */
function ReconciledFigures({
  sums,
  cumulatives,
  debtSymbol,
}: {
  sums: TroveRedemptionLedgerSums;
  cumulatives: TroveRedemptionCumulatives;
  debtSymbol: string;
}) {
  return (
    <div className={FIGURE_GRID_CLASSES}>
      <CumulativeFigures
        cumulatives={cumulatives}
        debtSymbol={debtSymbol}
        countSub={splitCountLabel(sums)}
        debtSub={mixedSplitSub(sums.debt, sums.rebalanceDebt, sums, debtSymbol)}
        collSub={mixedSplitSub(sums.coll, sums.rebalanceColl, sums, "USDm")}
      />
      <ImpactStat
        label="Net equity at oracle prices"
        value={
          sums.netEquity == null
            ? "—"
            : formatSignedWithPlus(sums.netEquity, "USDm")
        }
        sub={
          sums.missingPriceCount > 0
            ? `no oracle price on ${sums.missingPriceCount} hit${sums.missingPriceCount === 1 ? "" : "s"}`
            : "collateral-value change vs debt repaid, each hit at its own redemption price"
        }
      />
    </div>
  );
}

function impactDescription(model: TroveRedemptionImpactModel): string {
  if (model.kind === "reconciled") {
    return "Per-redemption ledger figures, reconciled to the trove's recorded cumulatives at the same indexed position.";
  }
  const base = "Lifetime totals from the trove's recorded cumulatives.";
  if (model.kind === "mismatch") return base;
  switch (model.reason) {
    case "partial":
      // Wording deliberately avoids naming the suppressed figures — the
      // interim view must never surface even the phrase "net equity" next
      // to a number.
      return `${base} Per-hit detail — the user vs rebalance split and the oracle-price valuation — is pending indexer rollout.`;
    case "pending":
      return `${base} Per-hit detail loads with the ledger below.`;
    case "unverified":
      return `${base} Per-hit detail resumes once the ledger and the trove's recorded position agree.`;
    case "truncated":
    case "batch":
      // These carry their own role="status" notice below.
      return base;
  }
}

/** The suppression states that need a live status region, not just muted
 *  prose: they can persist (truncation, batch rows) or demand attention (a
 *  reconciliation mismatch that survived its one refetch — a bug surface,
 *  per the plan's invariant, not a rendering choice). */
function ImpactNotice({ model }: { model: TroveRedemptionImpactModel }) {
  if (model.kind === "mismatch") {
    return (
      <p role="status" className="mt-3 text-xs text-amber-400">
        Ledger reconciliation failed — the per-redemption ledger rows do not sum
        to the trove&apos;s recorded cumulatives at the same indexed position,
        and a refetch did not resolve it. Per-hit figures are withheld; this is
        an indexer bug surface worth reporting.
      </p>
    );
  }
  if (model.kind !== "totals") return null;
  if (model.reason === "truncated") {
    return (
      <p role="status" className="mt-3 text-xs text-amber-400">
        Earliest ledger history truncated — per-hit figures are off for an
        incomplete history.
      </p>
    );
  }
  if (model.reason === "batch") {
    return (
      <p role="status" className="mt-3 text-xs text-amber-400">
        Batch data unavailable — batch-managed rows carry no per-trove debt
        snapshots, so the reconciliation and per-hit figures are off.
      </p>
    );
  }
  return null;
}

/** Liquidation lifetime totals — cumulative-only context carried over from
 *  the previous lifetime-totals card; per-trove SP-vs-redistribution split
 *  inside a liquidation stays a non-goal. */
function LiquidationTotals({
  trove,
  debtSymbol,
}: {
  trove: CdpTrove;
  debtSymbol: string;
}) {
  const hasLiquidation =
    isPositiveWei(trove.liquidatedDebt) || isPositiveWei(trove.liquidatedColl);
  if (!hasLiquidation) return null;
  return (
    <>
      <p className="mt-4 text-xs font-semibold text-slate-300">
        Liquidation totals (lifetime)
      </p>
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <ImpactStat
          label="Liquidated debt"
          value={formatTokenAmount(trove.liquidatedDebt, debtSymbol)}
        />
        <ImpactStat
          label="Liquidated collateral"
          value={formatTokenAmount(trove.liquidatedColl, "USDm")}
        />
        {isPositiveWei(trove.collSurplus) && (
          <ImpactStat
            label="Collateral surplus"
            value={formatTokenAmount(trove.collSurplus, "USDm")}
          />
        )}
      </div>
    </>
  );
}

function ImpactBody({
  model,
  debtSymbol,
}: {
  model: TroveRedemptionImpactModel;
  debtSymbol: string;
}) {
  if (!hasRedemptionHistory(model.cumulatives)) {
    return (
      <p className="mt-3 text-xs text-slate-500">
        No redemptions have touched this trove.
      </p>
    );
  }
  return (
    <>
      {model.kind === "reconciled" ? (
        <ReconciledFigures
          sums={model.sums}
          cumulatives={model.cumulatives}
          debtSymbol={debtSymbol}
        />
      ) : (
        <div className={FIGURE_GRID_CLASSES}>
          <CumulativeFigures
            cumulatives={model.cumulatives}
            debtSymbol={debtSymbol}
          />
        </div>
      )}
      {/* The ticket's core lesson (docs/PLAN-trove-history-page.md, "UI
          design → Redemption impact"), verbatim. */}
      <p className="mt-3 text-xs text-slate-400">
        Collateral was exchanged for debt at the oracle rate — a deleverage, not
        a liquidation — and the redemption fee is credited to the trove.
      </p>
    </>
  );
}

/** "What did the redemptions cost me?" (docs/PLAN-trove-history-page.md,
 *  "UI design → Redemption impact"): hit count, debt repaid, collateral
 *  taken, fees credited, and — only from complete, watermark-anchored,
 *  reconciled ledger rows — the user-vs-rebalance split and net equity at
 *  each hit's own oracle price. Totals compute from `Trove` cumulatives so
 *  they work even in the partial view, labeled as totals there. */
export function TroveRedemptionImpact({
  trove,
  debtSymbol,
  ledger,
}: {
  trove: CdpTrove;
  debtSymbol: string;
  ledger: TroveLedgerState;
}) {
  const model = useTroveRedemptionImpact(trove, ledger);
  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
      <h2 className="text-sm font-semibold text-white">Redemption impact</h2>
      <p className="mt-1 text-xs text-slate-500">{impactDescription(model)}</p>
      <ImpactNotice model={model} />
      <ImpactBody model={model} debtSymbol={debtSymbol} />
      <LiquidationTotals trove={trove} debtSymbol={debtSymbol} />
    </section>
  );
}
