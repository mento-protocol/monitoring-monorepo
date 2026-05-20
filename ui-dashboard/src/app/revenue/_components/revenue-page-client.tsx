"use client";

import { Suspense, useMemo } from "react";
import { PROTOCOL_FEE_RECIPIENT_ADDRESS } from "@mento-protocol/monitoring-config/protocol-fee";
import { formatUSD } from "@/lib/format";
import { useProtocolFees } from "@/hooks/use-protocol-fees";
import { BreakdownTile } from "@/components/breakdown-tile";
import { FeeOverTimeChart } from "@/components/fee-over-time-chart";
import { RevenueByPoolTable } from "@/components/revenue-by-pool-table";
import { ComingSoonSection } from "@/components/coming-soon-section";

export function RevenuePageClient() {
  return (
    <Suspense>
      <RevenueContent />
    </Suspense>
  );
}

function RevenueContent() {
  // Slim fees-only fetch. `useAllNetworksData` would pull paginated daily
  // snapshots, trading limits, OLS pools, LP addresses, and a breach rollup
  // per chain — none of which this page consumes. `useProtocolFees` returns
  // the same NetworkData shape with only the fees/rates slices populated.
  const { networkData, isLoading } = useProtocolFees();

  const anyNetworkError = networkData.some((n) => n.error !== null);
  // Tile + chart + leaderboard all read from snapshots since PR-snapshot-3.
  // Either rates or snapshot fetch failure blanks the fee surfaces.
  const anyFeesError = networkData.some(
    (n) =>
      (n.ratesError !== null || n.feeSnapshotsError !== null) &&
      n.error === null,
  );
  // Pagination cap exhausted on at least one chain — totals are a lower
  // bound. Surface as `≈` rather than blanking, since most history is in.
  const anyFeesTruncated = networkData.some(
    (n) => n.feeSnapshotsTruncated && n.error === null,
  );

  const aggregated = useMemo(() => {
    let totalFeesAllTime: number | null =
      anyFeesError || anyNetworkError ? null : 0;
    let totalFees24h: number | null =
      anyFeesError || anyNetworkError ? null : 0;
    let totalFees7d: number | null = anyFeesError || anyNetworkError ? null : 0;
    let totalFees30d: number | null =
      anyFeesError || anyNetworkError ? null : 0;
    const unpricedSymbolSet = new Set<string>();
    let totalUnresolvedCount = 0;

    for (const netData of networkData) {
      if (netData.error !== null) continue;
      const { fees } = netData;
      if (fees === null) continue;

      if (totalFeesAllTime !== null) totalFeesAllTime += fees.totalFeesUSD;
      if (totalFees24h !== null) totalFees24h += fees.fees24hUSD;
      if (totalFees7d !== null) totalFees7d += fees.fees7dUSD;
      if (totalFees30d !== null) totalFees30d += fees.fees30dUSD;
      for (const sym of fees.unpricedSymbols) unpricedSymbolSet.add(sym);
      totalUnresolvedCount += fees.unresolvedCount;
    }

    return {
      totalFeesAllTime,
      totalFees24h,
      totalFees7d,
      totalFees30d,
      // ES2023 `toSorted` requires Safari 16+/Chrome 110+; TS target is
      // ES2017 with no polyfill — keep the spread+sort form (codex P2).
      // react-doctor-disable-next-line react-doctor/js-tosorted-immutable
      unpricedSymbols: [...Array.from(unpricedSymbolSet)].sort(),
      totalUnresolvedCount,
    };
  }, [networkData, anyNetworkError, anyFeesError]);

  const feesApprox =
    aggregated.unpricedSymbols.length > 0 ||
    aggregated.totalUnresolvedCount > 0 ||
    anyFeesTruncated;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white mb-1">Protocol Revenue</h1>
        <p className="text-sm text-slate-400">
          Revenue streams across all chains
        </p>
      </div>

      <section>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <BreakdownTile
            label="Swap Fees"
            total={aggregated.totalFeesAllTime}
            sub24h={aggregated.totalFees24h}
            sub7d={aggregated.totalFees7d}
            sub30d={aggregated.totalFees30d}
            isLoading={isLoading}
            hasError={anyNetworkError || anyFeesError}
            format={formatUSD}
            totalPrefix={feesApprox ? "≈ " : ""}
            href={`https://debank.com/profile/${PROTOCOL_FEE_RECIPIENT_ADDRESS}`}
            subtitle={
              anyFeesTruncated
                ? "Approximate — full history exceeds pagination cap"
                : aggregated.unpricedSymbols.length > 0
                  ? `Approximate — unpriced: ${aggregated.unpricedSymbols.join(", ")}`
                  : aggregated.totalUnresolvedCount > 0
                    ? "Approximate — some tokens unresolved"
                    : "Protocol fee transfers to yield split address"
            }
          />

          <div className="rounded-lg border border-slate-800 bg-slate-900/60 px-5 py-4 flex flex-col justify-between min-h-[88px] opacity-60">
            <div>
              <div className="flex items-center gap-2">
                <p className="text-sm text-slate-400">CDP Borrowing Fees</p>
                <span className="rounded-full bg-slate-700 px-2 py-0.5 text-[9px] font-medium uppercase tracking-wider text-slate-400">
                  Soon
                </span>
              </div>
              <p className="mt-1 text-2xl font-semibold text-slate-600 font-mono">
                —
              </p>
            </div>
            <p className="mt-2 text-xs text-slate-600 min-h-4">
              Requires Liquity v2 indexing
            </p>
          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-900/60 px-5 py-4 flex flex-col justify-between min-h-[88px] opacity-60">
            <div>
              <div className="flex items-center gap-2">
                <p className="text-sm text-slate-400">Reserve Yield</p>
                <span className="rounded-full bg-slate-700 px-2 py-0.5 text-[9px] font-medium uppercase tracking-wider text-slate-400">
                  Soon
                </span>
              </div>
              <p className="mt-1 text-2xl font-semibold text-slate-600 font-mono">
                —
              </p>
            </div>
            <p className="mt-2 text-xs text-slate-600 min-h-4">
              Requires external data integration
            </p>
          </div>
        </div>
      </section>

      <FeeOverTimeChart
        networkData={networkData}
        isLoading={isLoading}
        hasError={anyNetworkError}
        hasFeesError={anyFeesError}
        isApproximate={feesApprox}
      />

      <RevenueByPoolTable
        networkData={networkData}
        isLoading={isLoading}
        hasError={anyNetworkError || anyFeesError}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ComingSoonSection
          title="CDP Borrowing Fees"
          description="Revenue from Mento's Liquity v2 CDP system — borrowing interest (25% protocol share), redemption fees, and liquidation penalties. Requires Liquity v2 indexing."
        />
        <ComingSoonSection
          title="Reserve Yield"
          description="Yield generated on reserve assets (USDS savings rate, etc.). Requires external data source integration."
        />
      </div>
    </div>
  );
}
