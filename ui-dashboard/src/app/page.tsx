"use client";

import { Suspense, useMemo } from "react";
import { formatUSD } from "@/lib/format";
import { isFpmm, poolTvlUSD } from "@/lib/tokens";
import { buildPool24hVolumeMap, sumFpmmSwaps24h } from "@/lib/volume";
import { StaticNetworkProvider } from "@/components/network-provider";
import { useAllNetworksData } from "@/hooks/use-all-networks-data";
import type { NetworkData } from "@/hooks/use-all-networks-data";
import { Skeleton, EmptyBox, ErrorBox, Tile } from "@/components/feedback";
import { PoolsTable } from "@/components/pools-table";

export default function GlobalPage() {
  return (
    <Suspense>
      <GlobalContent />
    </Suspense>
  );
}

function GlobalContent() {
  const { networkData, isLoading } = useAllNetworksData();

  // Whether any network has a fees or snapshots sub-query failure.
  // Used to show N/A in global KPI tiles rather than silently under-reporting.
  const anyFeesError = networkData.some(
    (nd) => nd.feesError !== null && nd.error === null,
  );
  const anySnapshotsError = networkData.some(
    (nd) => nd.snapshotsError !== null && nd.error === null,
  );

  // Aggregate KPIs across all networks.
  // Only include networks where the relevant sub-query succeeded to avoid
  // silently mixing real values with zeroed-out failure results.
  const aggregated = useMemo(() => {
    let totalPools = 0;
    let totalFpmmPools = 0;
    let totalTvl = 0;
    let totalVolume24h: number | null = anySnapshotsError ? null : 0;
    let totalSwaps24hFpmm: number | null = anySnapshotsError ? null : 0;
    let totalFeesAllTime: number | null = anyFeesError ? null : 0;
    let totalFees24h: number | null = anyFeesError ? null : 0;
    let hasUnknownTokens = false;
    let isTruncated = false;

    for (const nd of networkData) {
      // Skip whole-network errors — pools = [] anyway
      if (nd.error !== null) continue;

      const { network, pools, snapshots, fees } = nd;
      const fpmmPools = pools.filter(isFpmm);
      totalPools += pools.length;
      totalFpmmPools += fpmmPools.length;
      totalTvl += fpmmPools.reduce((sum, p) => sum + poolTvlUSD(p, network), 0);

      // Only add volume/swaps when snapshots succeeded for this network
      if (nd.snapshotsError === null) {
        const volume24hMap = buildPool24hVolumeMap(snapshots, pools, network);
        if (totalVolume24h !== null) {
          totalVolume24h += Array.from(volume24hMap.values()).reduce<number>(
            (sum, v) => (typeof v === "number" ? sum + v : sum),
            0,
          );
        }
        if (totalSwaps24hFpmm !== null) {
          const fpmmPoolIdSet = new Set(fpmmPools.map((p) => p.id));
          totalSwaps24hFpmm += sumFpmmSwaps24h(snapshots, fpmmPoolIdSet);
        }
      }

      // Only add fees when fees query succeeded for this network
      if (nd.feesError === null && fees !== null) {
        if (totalFeesAllTime !== null) totalFeesAllTime += fees.totalFeesUSD;
        if (totalFees24h !== null) totalFees24h += fees.fees24hUSD;
        if (fees.hasUnknownTokens) hasUnknownTokens = true;
        if (fees.isTruncated) isTruncated = true;
      }
    }

    return {
      totalPools,
      totalFpmmPools,
      totalTvl,
      totalVolume24h,
      totalSwaps24hFpmm,
      totalFeesAllTime,
      totalFees24h,
      hasUnknownTokens,
      isTruncated,
    };
  }, [networkData, anySnapshotsError, anyFeesError]);

  // Show sections for networks that have pools or encountered an error
  const configuredNetworks = networkData.filter(
    (nd) => nd.pools.length > 0 || nd.error !== null,
  );

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white mb-1">Global Overview</h1>
        <p className="text-sm text-slate-400">
          Protocol-wide statistics across all chains
        </p>
      </div>

      {/* Summary tiles */}
      <section>
        <h2 className="text-lg font-semibold text-white mb-3">Summary</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <Tile
            label="Total Pools"
            value={isLoading ? "…" : String(aggregated.totalPools)}
            subtitle={
              isLoading
                ? undefined
                : `${aggregated.totalFpmmPools} FPMMs · ${aggregated.totalPools - aggregated.totalFpmmPools} Virtual`
            }
          />
          <Tile
            label="TVL (FPMMs)"
            value={isLoading ? "…" : formatUSD(aggregated.totalTvl)}
          />
          <Tile
            label="Total Fees Earned"
            value={
              isLoading
                ? "…"
                : aggregated.totalFeesAllTime === null
                  ? "N/A"
                  : `${aggregated.hasUnknownTokens || aggregated.isTruncated ? "≈ " : ""}${formatUSD(aggregated.totalFeesAllTime)}`
            }
            subtitle={
              aggregated.totalFeesAllTime === null
                ? "Some chains failed to load"
                : aggregated.isTruncated
                  ? "Lower bound — data exceeds query limit"
                  : aggregated.hasUnknownTokens
                    ? "Approximate — some tokens unpriced"
                    : "All-time cumulative"
            }
          />
          <Tile
            label="24h Volume"
            value={
              isLoading
                ? "…"
                : aggregated.totalVolume24h === null
                  ? "N/A"
                  : formatUSD(aggregated.totalVolume24h)
            }
            subtitle={
              aggregated.totalVolume24h === null
                ? "Some chains failed to load"
                : undefined
            }
          />
          <Tile
            label="24h Swaps (FPMMs)"
            value={
              isLoading
                ? "…"
                : aggregated.totalSwaps24hFpmm === null
                  ? "N/A"
                  : aggregated.totalSwaps24hFpmm.toLocaleString()
            }
          />
          <Tile
            label="24h Fees Earned"
            value={
              isLoading
                ? "…"
                : aggregated.totalFees24h === null
                  ? "N/A"
                  : `${aggregated.hasUnknownTokens ? "≈ " : ""}${formatUSD(aggregated.totalFees24h)}`
            }
            subtitle={
              aggregated.totalFees24h === null
                ? "Some chains failed to load"
                : aggregated.hasUnknownTokens
                  ? "Approximate — some tokens unpriced"
                  : undefined
            }
          />
        </div>
      </section>

      {/* Per-chain pool tables — errors shown inline per chain, not duplicated globally */}
      {isLoading ? (
        <section>
          <h2 className="text-lg font-semibold text-white mb-3">All Pools</h2>
          <Skeleton rows={5} />
        </section>
      ) : configuredNetworks.length === 0 ? (
        <section>
          <h2 className="text-lg font-semibold text-white mb-3">All Pools</h2>
          <EmptyBox message="No pools found across any chain." />
        </section>
      ) : (
        configuredNetworks.map((nd) => (
          <ChainPoolsSection key={nd.network.id} networkData={nd} />
        ))
      )}
    </div>
  );
}

function ChainPoolsSection({ networkData }: { networkData: NetworkData }) {
  const { network, pools, snapshots, error, snapshotsError } = networkData;

  const volume24hMap = useMemo(
    () => buildPool24hVolumeMap(snapshots, pools, network),
    [snapshots, pools, network],
  );

  return (
    <section>
      <h2 className="text-lg font-semibold text-white mb-3">
        {network.label}
      </h2>
      {error ? (
        <ErrorBox message={`Failed to load pools: ${error.message}`} />
      ) : pools.length === 0 ? (
        <EmptyBox message="No pools found." />
      ) : (
        <StaticNetworkProvider network={network}>
          <PoolsTable
            pools={pools}
            volume24h={volume24hMap}
            volume24hLoading={false}
            volume24hError={snapshotsError !== null}
          />
        </StaticNetworkProvider>
      )}
    </section>
  );
}
