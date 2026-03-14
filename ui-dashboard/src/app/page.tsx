"use client";

import { Suspense, useMemo } from "react";
import { formatUSD } from "@/lib/format";
import { isFpmm, poolTvlUSD } from "@/lib/tokens";
import {
  buildPool24hVolumeMap,
  sumFpmmSwaps24h,
} from "@/lib/volume";
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

  // Aggregate KPIs across all networks
  const aggregated = useMemo(() => {
    let totalPools = 0;
    let totalFpmmPools = 0;
    let totalTvl = 0;
    let totalVolume24h = 0;
    let totalSwaps24hFpmm = 0;
    let totalFeesAllTime = 0;
    let totalFees24h = 0;
    let hasUnknownTokens = false;
    let isTruncated = false;

    for (const nd of networkData) {
      const { network, pools, snapshots, fees } = nd;
      const fpmmPools = pools.filter(isFpmm);
      totalPools += pools.length;
      totalFpmmPools += fpmmPools.length;
      totalTvl += fpmmPools.reduce((sum, p) => sum + poolTvlUSD(p, network), 0);

      const volume24hMap = buildPool24hVolumeMap(snapshots, pools, network);
      totalVolume24h += Array.from(volume24hMap.values()).reduce<number>(
        (sum, v) => (typeof v === "number" ? sum + v : sum),
        0,
      );

      const fpmmPoolIdSet = new Set(fpmmPools.map((p) => p.id));
      totalSwaps24hFpmm += sumFpmmSwaps24h(snapshots, fpmmPoolIdSet);

      if (fees) {
        totalFeesAllTime += fees.totalFeesUSD;
        totalFees24h += fees.fees24hUSD;
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
  }, [networkData]);

  const configuredNetworks = networkData.filter((nd) => nd.pools.length > 0 || nd.error !== null);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white mb-1">Global Overview</h1>
        <p className="text-sm text-slate-400">
          Protocol-wide statistics across all chains
        </p>
      </div>

      {/* Per-network errors */}
      {networkData
        .filter((nd) => nd.error !== null)
        .map((nd) => (
          <ErrorBox
            key={nd.network.id}
            message={`Failed to load ${nd.network.label}: ${nd.error!.message}`}
          />
        ))}

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
                : `${aggregated.hasUnknownTokens || aggregated.isTruncated ? "≈ " : ""}${formatUSD(aggregated.totalFeesAllTime)}`
            }
            subtitle={
              aggregated.isTruncated
                ? "Lower bound — data exceeds query limit"
                : aggregated.hasUnknownTokens
                  ? "Approximate — some tokens unpriced"
                  : "All-time cumulative"
            }
          />
          <Tile
            label="24h Volume"
            value={isLoading ? "…" : formatUSD(aggregated.totalVolume24h)}
          />
          <Tile
            label="24h Swaps (FPMMs)"
            value={isLoading ? "…" : aggregated.totalSwaps24hFpmm.toLocaleString()}
          />
          <Tile
            label="24h Fees Earned"
            value={
              isLoading
                ? "…"
                : `${aggregated.hasUnknownTokens ? "≈ " : ""}${formatUSD(aggregated.totalFees24h)}`
            }
            subtitle={
              aggregated.hasUnknownTokens
                ? "Approximate — some tokens unpriced"
                : undefined
            }
          />
        </div>
      </section>

      {/* Per-chain pool tables */}
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
  const { network, pools, snapshots, error } = networkData;

  const volume24hMap = useMemo(
    () => buildPool24hVolumeMap(snapshots, pools, network),
    [snapshots, pools, network],
  );

  if (error) {
    return (
      <section key={network.id}>
        <h2 className="text-lg font-semibold text-white mb-3">
          {network.label}
        </h2>
        <ErrorBox message={`Failed to load pools: ${error.message}`} />
      </section>
    );
  }

  return (
    <section>
      <h2 className="text-lg font-semibold text-white mb-3">
        {network.label}
      </h2>
      {pools.length === 0 ? (
        <EmptyBox message="No pools found." />
      ) : (
        <StaticNetworkProvider network={network}>
          <PoolsTable
            pools={pools}
            volume24h={volume24hMap}
            volume24hLoading={false}
            volume24hError={false}
          />
        </StaticNetworkProvider>
      )}
    </section>
  );
}
