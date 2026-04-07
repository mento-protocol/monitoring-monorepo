"use client";

import { Suspense, useMemo } from "react";
import { formatUSD } from "@/lib/format";
import { isFpmm, poolTvlUSD } from "@/lib/tokens";
import { buildPoolVolumeMap, sumFpmmSwaps } from "@/lib/volume";
import { useAllNetworksData } from "@/hooks/use-all-networks-data";
import {
  Skeleton,
  EmptyBox,
  ErrorBox,
  Tile,
  MultiPeriodTile,
} from "@/components/feedback";
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
  const anySnapshots7dError = networkData.some(
    (netData) => netData.snapshots7dError !== null && netData.error === null,
  );
  const anySnapshots30dError = networkData.some(
    (netData) => netData.snapshots30dError !== null && netData.error === null,
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
    let totalVolume7d: number | null =
      anySnapshots7dError || anyNetworkError ? null : 0;
    let totalVolume30d: number | null =
      anySnapshots30dError || anyNetworkError ? null : 0;
    let totalSwaps24hFpmm: number | null =
      anySnapshotsError || anyNetworkError ? null : 0;
    let totalSwaps7dFpmm: number | null =
      anySnapshots7dError || anyNetworkError ? null : 0;
    let totalSwaps30dFpmm: number | null =
      anySnapshots30dError || anyNetworkError ? null : 0;
    let totalFeesAllTime: number | null =
      anyFeesError || anyNetworkError ? null : 0;
    let totalFees24h: number | null =
      anyFeesError || anyNetworkError ? null : 0;
    let totalFees7d: number | null = anyFeesError || anyNetworkError ? null : 0;
    let totalFees30d: number | null =
      anyFeesError || anyNetworkError ? null : 0;
    const unpricedSymbolSet = new Set<string>();
    const unpricedSymbols24hSet = new Set<string>();
    const unpricedSymbols7dSet = new Set<string>();
    const unpricedSymbols30dSet = new Set<string>();
    let isTruncated = false;
    let totalUnresolvedCount = 0;
    let totalUnresolvedCount24h = 0;
    let totalUnresolvedCount7d = 0;
    let totalUnresolvedCount30d = 0;

    for (const netData of networkData) {
      // Skip whole-network errors (pools = [] anyway, already flagged via anyNetworkError)
      if (netData.error !== null) continue;

      const { network, pools, snapshots, snapshots7d, snapshots30d, fees } =
        netData;
      const fpmmPools = pools.filter(isFpmm);
      totalPools += pools.length;
      totalFpmmPools += fpmmPools.length;
      totalTvl += fpmmPools.reduce((sum, p) => sum + poolTvlUSD(p, network), 0);
      const fpmmPoolIdSet = new Set(fpmmPools.map((p) => p.id));

      // Only add volume/swaps when snapshots succeeded for this network
      if (netData.snapshotsError === null) {
        const volume24hMap = buildPoolVolumeMap(snapshots, pools, network);
        if (totalVolume24h !== null) {
          totalVolume24h += Array.from(volume24hMap.values()).reduce<number>(
            (sum, v) => (typeof v === "number" ? sum + v : sum),
            0,
          );
        }
        if (totalSwaps24hFpmm !== null) {
          totalSwaps24hFpmm += sumFpmmSwaps(snapshots, fpmmPoolIdSet);
        }
      }
      if (netData.snapshots7dError === null) {
        const volume7dMap = buildPoolVolumeMap(snapshots7d, pools, network);
        if (totalVolume7d !== null) {
          totalVolume7d += Array.from(volume7dMap.values()).reduce<number>(
            (sum, v) => (typeof v === "number" ? sum + v : sum),
            0,
          );
        }
        if (totalSwaps7dFpmm !== null) {
          totalSwaps7dFpmm += sumFpmmSwaps(snapshots7d, fpmmPoolIdSet);
        }
      }
      if (netData.snapshots30dError === null) {
        const volume30dMap = buildPoolVolumeMap(snapshots30d, pools, network);
        if (totalVolume30d !== null) {
          totalVolume30d += Array.from(volume30dMap.values()).reduce<number>(
            (sum, v) => (typeof v === "number" ? sum + v : sum),
            0,
          );
        }
        if (totalSwaps30dFpmm !== null) {
          totalSwaps30dFpmm += sumFpmmSwaps(snapshots30d, fpmmPoolIdSet);
        }
      }

      // Only add fees when fees query succeeded for this network
      if (netData.feesError === null && fees !== null) {
        if (totalFeesAllTime !== null) totalFeesAllTime += fees.totalFeesUSD;
        if (totalFees24h !== null) totalFees24h += fees.fees24hUSD;
        if (totalFees7d !== null) totalFees7d += fees.fees7dUSD;
        if (totalFees30d !== null) totalFees30d += fees.fees30dUSD;
        fees.unpricedSymbols.forEach((s) => unpricedSymbolSet.add(s));
        fees.unpricedSymbols24h.forEach((s) => unpricedSymbols24hSet.add(s));
        fees.unpricedSymbols7d.forEach((s) => unpricedSymbols7dSet.add(s));
        fees.unpricedSymbols30d.forEach((s) => unpricedSymbols30dSet.add(s));
        totalUnresolvedCount += fees.unresolvedCount;
        totalUnresolvedCount24h += fees.unresolvedCount24h;
        totalUnresolvedCount7d += fees.unresolvedCount7d;
        totalUnresolvedCount30d += fees.unresolvedCount30d;
        if (fees.isTruncated) isTruncated = true;
      }
    }

    const unpricedSymbols = Array.from(unpricedSymbolSet).sort();
    const unpricedSymbols24h = Array.from(unpricedSymbols24hSet).sort();
    const unpricedSymbols7d = Array.from(unpricedSymbols7dSet).sort();
    const unpricedSymbols30d = Array.from(unpricedSymbols30dSet).sort();

    return {
      totalPools,
      totalFpmmPools,
      totalTvl,
      totalVolume24h,
      totalVolume7d,
      totalVolume30d,
      totalSwaps24hFpmm,
      totalSwaps7dFpmm,
      totalSwaps30dFpmm,
      totalFeesAllTime,
      totalFees24h,
      totalFees7d,
      totalFees30d,
      unpricedSymbols,
      unpricedSymbols24h,
      unpricedSymbols7d,
      unpricedSymbols30d,
      totalUnresolvedCount,
      totalUnresolvedCount24h,
      totalUnresolvedCount7d,
      totalUnresolvedCount30d,
      isTruncated,
    };
  }, [
    networkData,
    anyNetworkError,
    anySnapshotsError,
    anySnapshots7dError,
    anySnapshots30dError,
    anyFeesError,
  ]);

  // Build a flat list of all pool entries and merged volume maps keyed by
  // `${network.id}:${pool.id}` to avoid collisions across chains.
  // Pools from chains with snapshot errors get null in the map → rendered as "N/A" per-row.
  const { globalEntries, volume24hByKey, volume7dByKey } = useMemo(() => {
    const entries: GlobalPoolEntry[] = [];
    const vol24hMap = new Map<string, number | null | undefined>();
    const vol7dMap = new Map<string, number | null | undefined>();

    for (const netData of networkData) {
      if (netData.error !== null) continue;
      const {
        network,
        pools,
        snapshots,
        snapshots7d,
        snapshotsError,
        snapshots7dError,
      } = netData;

      const perChain24h =
        snapshotsError === null
          ? buildPoolVolumeMap(snapshots, pools, network)
          : null;
      const perChain7d =
        snapshots7dError === null
          ? buildPoolVolumeMap(snapshots7d, pools, network)
          : null;

      for (const pool of pools) {
        const entry: GlobalPoolEntry = { pool, network };
        entries.push(entry);
        const key = globalPoolKey(entry);
        vol24hMap.set(key, perChain24h ? perChain24h.get(pool.id) : null);
        vol7dMap.set(key, perChain7d ? perChain7d.get(pool.id) : null);
      }
    }

    return {
      globalEntries: entries,
      volume24hByKey: vol24hMap,
      volume7dByKey: vol7dMap,
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
          <MultiPeriodTile
            label="Volume"
            periods={[
              {
                label: "24h",
                value: isLoading
                  ? "…"
                  : aggregated.totalVolume24h === null
                    ? "N/A"
                    : formatUSD(aggregated.totalVolume24h),
              },
              {
                label: "7d",
                value: isLoading
                  ? "…"
                  : aggregated.totalVolume7d === null
                    ? "N/A"
                    : formatUSD(aggregated.totalVolume7d),
              },
              {
                label: "30d",
                value: isLoading
                  ? "…"
                  : aggregated.totalVolume30d === null
                    ? "N/A"
                    : formatUSD(aggregated.totalVolume30d),
              },
            ]}
            subtitle={
              aggregated.totalVolume24h === null ||
              aggregated.totalVolume7d === null ||
              aggregated.totalVolume30d === null
                ? "Some chains failed to load"
                : undefined
            }
          />
          <MultiPeriodTile
            label="Swaps (FPMMs)"
            periods={[
              {
                label: "24h",
                value: isLoading
                  ? "…"
                  : aggregated.totalSwaps24hFpmm === null
                    ? "N/A"
                    : aggregated.totalSwaps24hFpmm.toLocaleString(),
              },
              {
                label: "7d",
                value: isLoading
                  ? "…"
                  : aggregated.totalSwaps7dFpmm === null
                    ? "N/A"
                    : aggregated.totalSwaps7dFpmm.toLocaleString(),
              },
              {
                label: "30d",
                value: isLoading
                  ? "…"
                  : aggregated.totalSwaps30dFpmm === null
                    ? "N/A"
                    : aggregated.totalSwaps30dFpmm.toLocaleString(),
              },
            ]}
            subtitle={
              aggregated.totalSwaps24hFpmm === null ||
              aggregated.totalSwaps7dFpmm === null ||
              aggregated.totalSwaps30dFpmm === null
                ? "Some chains failed to load"
                : undefined
            }
          />
          <MultiPeriodTile
            label="Swap Fees"
            periods={[
              {
                label: "24h",
                value: isLoading
                  ? "…"
                  : aggregated.totalFees24h === null
                    ? "N/A"
                    : `${aggregated.unpricedSymbols24h.length > 0 || aggregated.totalUnresolvedCount24h > 0 ? "≈ " : ""}${formatUSD(aggregated.totalFees24h)}`,
              },
              {
                label: "7d",
                value: isLoading
                  ? "…"
                  : aggregated.totalFees7d === null
                    ? "N/A"
                    : `${aggregated.unpricedSymbols7d.length > 0 || aggregated.totalUnresolvedCount7d > 0 ? "≈ " : ""}${formatUSD(aggregated.totalFees7d)}`,
              },
              {
                label: "30d",
                value: isLoading
                  ? "…"
                  : aggregated.totalFees30d === null
                    ? "N/A"
                    : `${aggregated.unpricedSymbols30d.length > 0 || aggregated.totalUnresolvedCount30d > 0 ? "≈ " : ""}${formatUSD(aggregated.totalFees30d)}`,
              },
            ]}
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
        ) : failedNetworks.length === 0 && globalEntries.length === 0 ? (
          <EmptyBox message="No pools found across any chain." />
        ) : (
          <GlobalPoolsTable
            entries={globalEntries}
            volume24hByKey={volume24hByKey}
            volume7dByKey={volume7dByKey}
          />
        )}
      </section>
    </div>
  );
}
