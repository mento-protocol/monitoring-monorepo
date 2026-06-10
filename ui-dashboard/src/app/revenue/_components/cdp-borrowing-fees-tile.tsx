"use client";

import { formatUSD } from "@/lib/format";
import type { CdpBorrowingRevenueSummary } from "@/lib/cdp-borrowing-revenue";

export type CdpBorrowingFeesTileState = {
  summary: CdpBorrowingRevenueSummary | null;
  isLoading: boolean;
  hasError: boolean;
};

// Headline = the protocol's share of borrowing fees ((1 − SP_YIELD_SPLIT) ×
// gross), since this page tracks PROTOCOL revenue. One context row shows the
// gross fee burden and the StabilityPool depositors' slice. Collected /
// receivable stay indexed (LiquityInstance.borrowingFeeCollectedCum +
// snapshot.collected) but are intentionally not rendered here — on Celo the
// rebalancer touches troves constantly, so collected tracks earned within a
// fraction of a percent and the extra figures were noise.
export function CdpBorrowingFeesTile({
  state,
}: {
  state: CdpBorrowingFeesTileState;
}) {
  const { summary, isLoading, hasError } = state;
  const isApproximate =
    (summary?.unpricedSymbols.length ?? 0) > 0 ||
    (summary?.bracketsTruncated ?? false);
  const showData = !isLoading && !hasError && summary !== null;
  const mainValue = isLoading
    ? "—"
    : !showData
      ? "N/A"
      : `${isApproximate ? "≈ " : ""}${formatUSD(summary.protocolShareUSD)}`;
  const subtitle = cdpBorrowingFeesSubtitle(summary, isLoading, hasError);

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 px-5 py-4 flex flex-col justify-between min-h-[88px]">
      <div>
        <p className="text-sm text-slate-400">CDP Borrowing Fees</p>
        <p className="mt-1 text-2xl font-semibold text-white font-mono">
          {mainValue}
          {showData && (
            <span className="ml-1.5 text-sm font-normal text-slate-500">
              earned
            </span>
          )}
        </p>
        {showData && (
          <p className="mt-1.5 text-sm font-mono">
            <span className="text-slate-500">Gross</span>{" "}
            <span className="text-slate-400">
              {formatUSD(summary.totalRevenueUSD)}
            </span>{" "}
            <span className="text-slate-500">
              · of which {formatUSD(summary.spYieldShareUSD)} goes to stability
              pool
            </span>
          </p>
        )}
      </div>
      <p className="mt-2 text-xs text-slate-500 min-h-4">{subtitle}</p>
    </div>
  );
}

function cdpBorrowingFeesSubtitle(
  summary: CdpBorrowingRevenueSummary | null,
  isLoading: boolean,
  hasError: boolean,
): string {
  if (isLoading) return "Loading CDP borrowing fees";
  if (hasError || summary === null) return "Unable to load CDP borrowing fees";
  if (summary.bracketsTruncated) {
    return "Approximate — interest brackets exceed pagination cap";
  }
  if (summary.unpricedSymbols.length > 0) {
    return `Approximate — unpriced debt token${summary.unpricedSymbols.length === 1 ? "" : "s"}: ${summary.unpricedSymbols.join(", ")}`;
  }
  return "Protocol share of borrowing fees";
}
