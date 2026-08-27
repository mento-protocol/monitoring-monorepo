import { formatTokenAmount } from "../../../../_lib/format";
import type { CdpTrove } from "../../../../_lib/types";

function isPositiveWei(value: string | null | undefined): boolean {
  if (value == null) return false;
  try {
    return BigInt(value) > BigInt(0);
  } catch {
    return false;
  }
}

/** Whether {@link TroveLifetimeTotals} renders its card for this trove — the
 *  normal case for an untouched active trove is `false` (no redemption or
 *  liquidation history yet). Exported so callers that reference "the
 *  lifetime totals above" (e.g. `TroveOperationsList`'s partial-view notice)
 *  can condition that reference on the card actually existing, instead of
 *  duplicating this check and risking drift. */
export function hasTroveLifetimeTotals(trove: CdpTrove): boolean {
  const hasRedemptions =
    trove.redemptionCount > 0 ||
    isPositiveWei(trove.redeemedDebt) ||
    isPositiveWei(trove.redeemedColl);
  const hasLiquidation =
    isPositiveWei(trove.liquidatedDebt) || isPositiveWei(trove.liquidatedColl);
  return hasRedemptions || hasLiquidation;
}

/** Raw `Trove` lifetime cumulatives — the only redemption/liquidation figures
 *  available before the full ledger ships (docs/PLAN-trove-history-page.md,
 *  "GraphQL contract → interim assembly"). These are TOTALS, not a derived
 *  "impact" figure: no net-equity line, because a trove redeemed at
 *  different FX prices can't be valued from lifetime sums without the
 *  per-hit `redemptionPrice` the full ledger carries. */
export function TroveLifetimeTotals({
  trove,
  debtSymbol,
}: {
  trove: CdpTrove;
  debtSymbol: string;
}) {
  if (!hasTroveLifetimeTotals(trove)) return null;

  const hasRedemptions =
    trove.redemptionCount > 0 ||
    isPositiveWei(trove.redeemedDebt) ||
    isPositiveWei(trove.redeemedColl);
  const hasLiquidation =
    isPositiveWei(trove.liquidatedDebt) || isPositiveWei(trove.liquidatedColl);

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
      <h2 className="text-sm font-semibold text-white">
        Redemption &amp; liquidation totals (lifetime)
      </h2>
      <p className="mt-1 text-xs text-slate-500">
        Raw cumulatives from the trove&apos;s indexed lifetime — not a per-event
        breakdown, and not a net-equity calculation. A trove redeemed at
        different FX prices can&apos;t be valued from these sums alone; that
        needs the full per-redemption ledger.
      </p>
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        {hasRedemptions && (
          <>
            <div>
              <p className="text-xs text-slate-500">Redemptions</p>
              <p className="mt-0.5 font-mono text-sm text-slate-200">
                {trove.redemptionCount.toLocaleString()}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Redeemed debt</p>
              <p className="mt-0.5 font-mono text-sm text-slate-200">
                {formatTokenAmount(trove.redeemedDebt, debtSymbol)}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Redeemed collateral</p>
              <p className="mt-0.5 font-mono text-sm text-slate-200">
                {formatTokenAmount(trove.redeemedColl, "USDm")}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Redemption fee kept</p>
              <p className="mt-0.5 font-mono text-sm text-slate-200">
                {formatTokenAmount(trove.redemptionFeePaidCum, "USDm")}
              </p>
            </div>
          </>
        )}
        {hasLiquidation && (
          <>
            <div>
              <p className="text-xs text-slate-500">Liquidated debt</p>
              <p className="mt-0.5 font-mono text-sm text-slate-200">
                {formatTokenAmount(trove.liquidatedDebt, debtSymbol)}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Liquidated collateral</p>
              <p className="mt-0.5 font-mono text-sm text-slate-200">
                {formatTokenAmount(trove.liquidatedColl, "USDm")}
              </p>
            </div>
            {isPositiveWei(trove.collSurplus) && (
              <div>
                <p className="text-xs text-slate-500">Collateral surplus</p>
                <p className="mt-0.5 font-mono text-sm text-slate-200">
                  {formatTokenAmount(trove.collSurplus, "USDm")}
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
