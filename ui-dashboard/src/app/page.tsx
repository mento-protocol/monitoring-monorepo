"use client";

import { Suspense, useMemo } from "react";
import { formatUSD } from "@/lib/format";
import { isFpmm, poolTvlUSD } from "@/lib/tokens";
import { buildPool24hVolumeMap, sumFpmmSwaps24h } from "@/lib/volume";
import { useAllNetworksData } from "@/hooks/use-all-networks-data";
import { Skeleton, EmptyBox, ErrorBox, Tile } from "@/components/feedback";
import {
  GlobalPoolsTable,
  globalPoolKey,
  type GlobalPoolEntry,
} from "@/components/global-pools-table";

export default function GlobalPage() {
  return (
    <Suspense>
      <GlobalContent />
    </Suspense>
  );
}

function GlobalContent() {
  const { networkData, isLoading } = useAllNetworksData();

  // Whether any network has a top-level, fees, or snapshots failure.
  // Used to show N/A / "partial data" in KPI tiles rather than silently under-reporting.
  const anyNetworkError = networkData.some((netData) => netData.error !== null);
  const anyFeesError = networkData.some(
    (netData) => netData.feesError !== null && netData.error === null,
  );
  const anySnapshotsError = networkData.some(
    (netData) => netData.snapshotsError !== null && netData.error === null,
  );

  // Aggregate KPIs across all networks.
  // Pools/TVL include only successfully loaded chains — but we track whether
  // any chain failed so tiles can show N/A / "partial data" subtitles.
  // Fees and volume/swaps go null when *any* relevant sub-query failed so we
  // never mix real values with silently zeroed-out failures.
  const aggregated = useMemo(() => {
    let totalPools = 0;
    let totalFpmmPools = 0;
    let totalTvl = 0;
    let totalVolume24h: number | null =
      anySnapshotsError || anyNetworkError ? null : 0;
    let totalSwaps24hFpmm: number | null =
      anySnapshotsError || anyNetworkError ? null : 0;
    let totalFeesAllTime: number | null =
      anyFeesError || anyNetworkError ? null : 0;
    let totalFees24h: number | null =
      anyFeesError || anyNetworkError ? null : 0;
    const unpricedSymbolSet = new Set<string>();
    const unpricedSymbols24hSet = new Set<string>();
    let isTruncated = false;
    let totalUnresolvedCount = 0;
    let totalUnresolvedCount24h = 0;

    for (const netData of networkData) {
      // Skip whole-network errors (pools = [] anyway, already flagged via anyNetworkError)
      if (netData.error !== null) continue;

      const { network, pools, snapshots, fees } = netData;
      const fpmmPools = pools.filter(isFpmm);
      totalPools += pools.length;
      totalFpmmPools += fpmmPools.length;
      totalTvl += fpmmPools.reduce((sum, p) => sum + poolTvlUSD(p, network), 0);

      // Only add volume/swaps when snapshots succeeded for this network
      if (netData.snapshotsError === null) {
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
      if (netData.feesError === null && fees !== null) {
        if (totalFeesAllTime !== null) totalFeesAllTime += fees.totalFeesUSD;
        if (totalFees24h !== null) totalFees24h += fees.fees24hUSD;
        fees.unpricedSymbols.forEach((s) => unpricedSymbolSet.add(s));
        fees.unpricedSymbols24h.forEach((s) => unpricedSymbols24hSet.add(s));
        totalUnresolvedCount += fees.unresolvedCount;
        totalUnresolvedCount24h += fees.unresolvedCount24h;
        if (fees.isTruncated) isTruncated = true;
      }
    }

    const unpricedSymbols = Array.from(unpricedSymbolSet).sort();
    const unpricedSymbols24h = Array.from(unpricedSymbols24hSet).sort();

    return {
      totalPools,
      totalFpmmPools,
      totalTvl,
      totalVolume24h,
      totalSwaps24hFpmm,
      totalFeesAllTime,
      totalFees24h,
      unpricedSymbols,
      unpricedSymbols24h,
      totalUnresolvedCount,
      totalUnresolvedCount24h,
      isTruncated,
    };
  }, [networkData, anyNetworkError, anySnapshotsError, anyFeesError]);

  // Build a flat list of all pool entries and a merged volume24h map keyed by
  // `${network.id}:${pool.id}` to avoid collisions across chains.
  // Pools from chains with snapshot errors get null in the map → rendered as "N/A" per-row.
  const { globalEntries, volume24hByKey } = useMemo(() => {
    const entries: GlobalPoolEntry[] = [];
    const volMap = new Map<string, number | null>();

    for (const netData of networkData) {
      if (netData.error !== null) continue;
      const { network, pools, snapshots, snapshotsError } = netData;

      const perChainVolMap =
        snapshotsError === null
          ? buildPool24hVolumeMap(snapshots, pools, network)
          : new Map<string, number | null>();

      for (const pool of pools) {
        const entry: GlobalPoolEntry = { pool, network };
        entries.push(entry);
        const key = globalPoolKey(entry);
        if (snapshotsError !== null) {
          volMap.set(key, null);
        } else {
          volMap.set(key, perChainVolMap.get(pool.id) ?? null);
        }
      }
    }

    return {
      globalEntries: entries,
      volume24hByKey: volMap,
    };
  }, [networkData]);

  // Networks that failed at the top level — show an error notice per chain
  const failedNetworks = networkData.filter((net) => net.error !== null);

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
                : anyNetworkError
                  ? `${aggregated.totalFpmmPools} FPMMs · ${aggregated.totalPools - aggregated.totalFpmmPools} Virtual · partial data`
                  : `${aggregated.totalFpmmPools} FPMMs · ${aggregated.totalPools - aggregated.totalFpmmPools} Virtual`
            }
          />
          <Tile
            label="TVL (FPMMs)"
            value={isLoading ? "…" : formatUSD(aggregated.totalTvl)}
            subtitle={
              anyNetworkError ? "Partial data — some chains failed" : undefined
            }
          />
          <Tile
            label="Swap Fees Earned"
            value={
              isLoading
                ? "…"
                : aggregated.totalFeesAllTime === null
                  ? "N/A"
                  : `${aggregated.unpricedSymbols.length > 0 || aggregated.isTruncated || aggregated.totalUnresolvedCount > 0 ? "≈ " : ""}${formatUSD(aggregated.totalFeesAllTime)}`
            }
            href="https://debank.com/profile/0x0dd57f6f181d0469143fe9380762d8a112e96e4a"
            subtitle={
              aggregated.totalFeesAllTime === null
                ? "Some chains failed to load"
                : aggregated.isTruncated
                  ? "Lower bound — data exceeds query limit"
                  : aggregated.unpricedSymbols.length > 0
                    ? `Approximate — unpriced: ${aggregated.unpricedSymbols.join(", ")}`
                    : aggregated.totalUnresolvedCount > 0
                      ? "Approximate — some tokens unresolved"
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
            label="24h Swap Fees"
            value={
              isLoading
                ? "…"
                : aggregated.totalFees24h === null
                  ? "N/A"
                  : `${aggregated.unpricedSymbols24h.length > 0 || aggregated.totalUnresolvedCount24h > 0 ? "≈ " : ""}${formatUSD(aggregated.totalFees24h)}`
            }
            subtitle={
              aggregated.totalFees24h === null
                ? "Some chains failed to load"
                : aggregated.unpricedSymbols24h.length > 0
                  ? `Approximate — unpriced: ${aggregated.unpricedSymbols24h.join(", ")}`
                  : aggregated.totalUnresolvedCount24h > 0
                    ? "Approximate — some tokens unresolved"
                    : undefined
            }
          />
        </div>
      </section>

      {/* Per-chain error notices — shown when a chain fails at the top level */}
      {failedNetworks.map((net) => (
        <ErrorBox
          key={net.network.id}
          message={`${net.network.label}: Failed to load pools — ${net.error?.message}`}
        />
      ))}

      {/* Unified global pool table sorted by TVL descending */}
      <section>
        <h2 className="text-lg font-semibold text-white mb-3">All Pools</h2>
        {isLoading ? (
          <Skeleton rows={5} />
        ) : globalEntries.length === 0 ? (
          <EmptyBox message="No pools found across any chain." />
        ) : (
          <GlobalPoolsTable
            entries={globalEntries}
            volume24hByKey={volume24hByKey}
          />
        )}
      </section>
    </div>
  );
}
