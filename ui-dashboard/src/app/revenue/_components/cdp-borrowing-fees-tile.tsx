"use client";

import { formatUSD } from "@/lib/format";
import type { CdpBorrowingRevenueSummary } from "@/lib/cdp-borrowing-revenue";

export type CdpBorrowingFeesTileState = {
  summary: CdpBorrowingRevenueSummary | null;
  isLoading: boolean;
  hasError: boolean;
};

// Headline = the protocol's share of borrowing fees ((1 − SP_YIELD_SPLIT) ×
// gross), since this page tracks PROTOCOL revenue. The gross fee burden and
// the StabilityPool depositors' yield share render as context rows, and the
// progress bar shows how much of the protocol share has actually been minted
// to the treasury Safe (cash basis) vs still accruing on untouched troves.
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
        {showData && <SplitBreakdownRows summary={summary} />}
        {showData && <CollectedProgress summary={summary} />}
      </div>
      <p className="mt-2 text-xs text-slate-500 min-h-4">{subtitle}</p>
    </div>
  );
}

function SplitBreakdownRows({
  summary,
}: {
  summary: CdpBorrowingRevenueSummary;
}) {
  const spSharePct =
    summary.totalRevenueUSD > 0
      ? Math.round((summary.spYieldShareUSD / summary.totalRevenueUSD) * 100)
      : null;
  return (
    <div className="mt-1.5 flex gap-3 text-sm font-mono">
      <span>
        <span className="text-slate-500">Gross</span>{" "}
        <span className="text-slate-400">
          {formatUSD(summary.totalRevenueUSD)}
        </span>
      </span>
      <span>
        <span className="text-slate-500">
          To SP yield{spSharePct !== null ? ` (${spSharePct}%)` : ""}
        </span>{" "}
        <span className="text-slate-400">
          {formatUSD(summary.spYieldShareUSD)}
        </span>
      </span>
    </div>
  );
}

function CollectedProgress({
  summary,
}: {
  summary: CdpBorrowingRevenueSummary;
}) {
  const collectedPct =
    summary.protocolShareUSD > 0
      ? Math.min(
          100,
          Math.round((summary.collectedUSD / summary.protocolShareUSD) * 100),
        )
      : 0;
  return (
    <div className="mt-2">
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={collectedPct}
        aria-label="Share of protocol borrowing revenue collected to treasury"
        className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800"
      >
        <div
          className="h-full rounded-full bg-emerald-500/80"
          style={{ width: `${collectedPct}%` }}
        />
      </div>
      <div className="mt-1.5 flex gap-3 text-xs font-mono">
        <span>
          <span className="text-slate-500">Collected</span>{" "}
          <span className="text-emerald-400">
            {formatUSD(summary.collectedUSD)}
          </span>
        </span>
        <span>
          <span className="text-slate-500">Accruing</span>{" "}
          <span className="text-slate-400">
            {formatUSD(summary.receivableUSD)}
          </span>
        </span>
      </div>
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
  const marketLabel =
    summary.marketCount === 1
      ? "1 Celo CDP market"
      : `${summary.marketCount} Celo CDP markets`;
  return `Protocol share of upfront fees + interest across ${marketLabel}`;
}
