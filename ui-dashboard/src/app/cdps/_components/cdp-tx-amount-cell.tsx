"use client";

import { Td } from "@/components/table";
import { formatTokenAmount } from "../_lib/format";
import { amountsFor, type TroveSnapshot } from "../_lib/transactions";
import type { CdpTransactionRow } from "../_lib/types";

/** Renders one of the two amount columns (debt or collateral) on a CDP
 *  transactions row. For trove-op rows with a resolved snapshot it shows
 *  `before → after` with the signed delta below; for pool-level events
 *  (liquidation / redemption / SP rebalance) or trove-ops whose snapshot
 *  hasn't resolved yet (deploy+resync window / backfill catching up) it
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
  /** Resolved snapshot from `troveSnapshotFor`. `null` triggers the flat
   *  fallback rendering — see comment on the function for the cases. */
  snapshot: TroveSnapshot | null;
}) {
  if (snapshot == null) {
    const { debt, coll } = amountsFor(row);
    return (
      <Td mono small align="right">
        {formatTokenAmount(leg === "debt" ? debt : coll, symbol)}
      </Td>
    );
  }
  const slice = snapshot[leg];
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
      </div>
    </Td>
  );
}
