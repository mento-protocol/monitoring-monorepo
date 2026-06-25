"use client";

import { Td } from "@/components/table";
import { formatSignedWei, formatTokenAmount } from "../_lib/format";
import { amountsFor, type PositionSnapshot } from "../_lib/transactions";
import type { CdpTransactionRow } from "../_lib/types";

function claimedAmountFor(
  row: CdpTransactionRow,
  leg: "debt" | "coll",
): string | null {
  if (row.kind !== "spOperation") return null;
  const value = leg === "debt" ? row.yieldGainClaimed : row.ethGainClaimed;
  return BigInt(value) === BigInt(0) ? null : value;
}

/** Renders one of the two amount columns (debt or collateral) on a CDP
 *  transactions row. For rows with a resolved position snapshot it shows
 *  `before → after` with the signed delta below; for pool-level events
 *  (liquidation / redemption / SP rebalance) or trove-ops whose isolated
 *  snapshot hasn't resolved yet (deploy+resync window / backfill catching up) it
 *  falls back to the existing flat amount so the table keeps rendering.
 *
 *  Shared between the per-market table (`/cdps/[symbol]`) and the
 *  cross-market overview (`/cdps`) so the rendering policy lives in one
 *  place. */
export function CdpTxAmountCell({
  row,
  symbol,
  leg,
  snapshot,
}: {
  row: CdpTransactionRow;
  symbol: string;
  leg: "debt" | "coll";
  /** Resolved snapshot from the transaction helpers. `null` triggers the flat
   *  fallback rendering — see comment on the function for the cases. */
  snapshot: PositionSnapshot | null;
}) {
  if (snapshot == null) {
    // troveOp rows carry signed int256 deltas (collChange/debtChange); the
    // other event kinds (liquidation/redemption/spRebalance) project
    // unsigned event-totals. Route signed values through formatSignedWei so
    // a hypothetical -1 wei delta doesn't collapse to the unknown sentinel.
    const { debt, coll } = amountsFor(row);
    const value = leg === "debt" ? debt : coll;
    return (
      <Td mono small align="right">
        {row.kind === "troveOp"
          ? formatSignedWei(value, symbol)
          : formatTokenAmount(value, symbol)}
      </Td>
    );
  }
  const slice = snapshot[leg];
  const claimedAmount = claimedAmountFor(row, leg);
  // ES2017 target prohibits 0n literals — coerce via BigInt(0) to stay
  // consistent with the rest of the cdps lib.
  const ZERO = BigInt(0);
  const deltaBig = BigInt(slice.delta);
  return (
    <Td mono small align="right">
      <div className="flex flex-col items-end leading-tight">
        <span>
          <span className="text-slate-400">
            {formatTokenAmount(slice.before, symbol)}
          </span>
          <span className="mx-1 text-slate-500">→</span>
          <span>{formatTokenAmount(slice.after, symbol)}</span>
        </span>
        {deltaBig !== ZERO && (
          <span
            className={`text-[10px] ${
              deltaBig > ZERO ? "text-emerald-400" : "text-rose-400"
            }`}
          >
            ({deltaBig > ZERO ? "+" : "−"}
            {formatTokenAmount(
              deltaBig < ZERO ? (-deltaBig).toString() : slice.delta,
              symbol,
            )}
            )
          </span>
        )}
        {claimedAmount != null && (
          <span className="text-[10px] text-lime-300">
            claimed {formatTokenAmount(claimedAmount, symbol)}
          </span>
        )}
      </div>
    </Td>
  );
}
