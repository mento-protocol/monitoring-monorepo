"use client";

import { Suspense, useMemo } from "react";
import { formatUSD } from "@/lib/format";
import { isFpmm, poolTvlUSD, type OracleRateMap } from "@/lib/tokens";
import type { Pool, PoolSnapshotWindow } from "@/lib/types";
import type { Network } from "@/lib/networks";
import {
  buildPoolVolumeMap,
  poolTotalVolumeUSD,
  snapshotWindowPrior7d,
} from "@/lib/volume";
import { useAllNetworksData } from "@/hooks/use-all-networks-data";
import { Skeleton, EmptyBox, ErrorBox, Tile } from "@/components/feedback";
import {
  GlobalPoolsTable,
  globalPoolKey,
  type GlobalPoolEntry,
} from "@/components/global-pools-table";
import { TvlOverTimeChart } from "@/components/tvl-over-time-chart";
import { VolumeOverTimeChart } from "@/components/volume-over-time-chart";

export default function GlobalPage() {
  return (
    <Suspense>
      <GlobalContent />
    </Suspense>
  );
}

function sumVolumeMap(map: Map<string, number | null>): number {
  let total = 0;
  for (const v of map.values()) {
    if (typeof v === "number") total += v;
  }
  return total;
}

/**
 * Returns matched current/historical TVL for pools that have snapshot data.
 * Only pools with a snapshot in the window contribute to both sides, so
 * newly-created pools (no historical snapshot) don't inflate the delta.
 *
 * Uses today's oracle rate (not the historical rate) so the percentage change
 * isolates reserve-quantity movements from price movements.
 */
function matchedTvl(
  snapshots: PoolSnapshotWindow[],
  pools: Pool[],
  network: Network,
  rates: OracleRateMap,
): { now: number; ago: number } {
  const fpmmMap = new Map(pools.filter(isFpmm).map((p) => [p.id, p]));
  const earliest = new Map<string, PoolSnapshotWindow>();
  for (const s of snapshots) {
    if (!fpmmMap.has(s.poolId)) continue;
    const existing = earliest.get(s.poolId);
    if (!existing || Number(s.timestamp) < Number(existing.timestamp)) {
      earliest.set(s.poolId, s);
    }
  }
  let now = 0;
  let ago = 0;
  for (const [poolId, snap] of earliest) {
    const pool = fpmmMap.get(poolId)!;
    now += poolTvlUSD(pool, network, rates);
    ago += poolTvlUSD(
      { ...pool, reserves0: snap.reserves0, reserves1: snap.reserves1 },
      network,
      rates,
    );
  }
  return { now, ago };
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
  const anyLpError = networkData.some(
    (netData) => netData.lpError !== null && netData.error === null,
  );

  // Aggregate KPIs and per-pool volume maps in a single pass (no duplicate
  // buildPoolVolumeMap calls).
  const { aggregated, globalEntries, volume24hByKey, volume7dByKey } =
    useMemo(() => {
      let totalPools = 0;
      let totalFpmmPools = 0;
      let totalTvl = 0;
      // Track current + historical TVL only for chains that contributed
      // snapshot data, so numerator and denominator always match. Uses the 7d
      // window so weekend oracle stalls in FX pools don't distort the delta.
      let tvlNow7d = 0;
      let tvlAgo7d = 0;
      let hasTvlSnapshots7d = false;
      const allEntries: GlobalPoolEntry[] = [];
      const allVol24h = new Map<string, number | null | undefined>();
      const allVol7d = new Map<string, number | null | undefined>();
      let totalVolumeAllTime: number | null = anyNetworkError ? null : 0;
      let totalVolume24h: number | null =
        anySnapshotsError || anyNetworkError ? null : 0;
      let totalVolume7d: number | null =
        anySnapshots7dError || anyNetworkError ? null : 0;
      let totalVolume30d: number | null =
        anySnapshots30dError || anyNetworkError ? null : 0;
      // Prior 7d window [-14d, -7d], filtered from snapshots30d. Used only for
      // the volume chart's week-over-week delta — no extra network request.
      let totalVolumePrior7d: number | null =
        anySnapshots30dError || anyNetworkError ? null : 0;
      const priorWindow = snapshotWindowPrior7d(Date.now());
      let totalSwapsAllTime: number | null = anyNetworkError ? null : 0;
      let totalFeesAllTime: number | null =
        anyFeesError || anyNetworkError ? null : 0;
      let totalFees24h: number | null =
        anyFeesError || anyNetworkError ? null : 0;
      let totalFees7d: number | null =
        anyFeesError || anyNetworkError ? null : 0;
      let totalFees30d: number | null =
        anyFeesError || anyNetworkError ? null : 0;
      let totalUniqueLps: number | null = anyNetworkError ? null : 0;
      let hasSuccessfulLpResult = false;
      const unpricedSymbolSet = new Set<string>();
      let isTruncated = false;
      let totalUnresolvedCount = 0;

      for (const netData of networkData) {
        if (netData.error !== null) continue;

        const {
          network,
          pools,
          snapshots,
          snapshots7d,
          snapshots30d,
          fees,
          rates,
        } = netData;
        const fpmmPools = pools.filter(isFpmm);
        totalPools += pools.length;
        totalFpmmPools += fpmmPools.length;
        const chainTvlNow = fpmmPools.reduce(
          (sum, p) => sum + poolTvlUSD(p, network, rates),
          0,
        );
        totalTvl += chainTvlNow;

        // Historical TVL — only pools with snapshot data contribute to both
        // sides of the delta, so new pools don't inflate the percentage. Uses
        // the 7d window (not 24h) so weekend oracle stalls don't produce
        // Monday spikes in the delta.
        if (netData.snapshots7dError === null && snapshots7d.length > 0) {
          const m = matchedTvl(snapshots7d, pools, network, rates);
          tvlNow7d += m.now;
          tvlAgo7d += m.ago;
          hasTvlSnapshots7d = true;
        }

        // All-time volume & swaps from pool-level counters
        if (totalVolumeAllTime !== null) {
          for (const pool of pools) {
            const v = poolTotalVolumeUSD(pool, network, netData.rates);
            if (typeof v === "number") totalVolumeAllTime += v;
          }
        }
        if (totalSwapsAllTime !== null) {
          totalSwapsAllTime += pools.reduce(
            (sum, p) => sum + (p.swapCount ?? 0),
            0,
          );
        }

        // Windowed volume from snapshots — maps built once, reused for
        // both KPI totals and per-pool table columns below.
        const vol24hMap =
          netData.snapshotsError === null
            ? buildPoolVolumeMap(snapshots, pools, network, netData.rates)
            : null;
        const vol7dMap =
          netData.snapshots7dError === null
            ? buildPoolVolumeMap(snapshots7d, pools, network, netData.rates)
            : null;
        const vol30dMap =
          netData.snapshots30dError === null
            ? buildPoolVolumeMap(snapshots30d, pools, network, netData.rates)
            : null;

        if (vol24hMap && totalVolume24h !== null) {
          totalVolume24h += sumVolumeMap(vol24hMap);
        }
        if (vol7dMap && totalVolume7d !== null) {
          totalVolume7d += sumVolumeMap(vol7dMap);
        }
        if (vol30dMap && totalVolume30d !== null) {
          totalVolume30d += sumVolumeMap(vol30dMap);
        }

        // Prior-7d volume (WoW denominator) — reuses snapshots30d by filtering.
        if (netData.snapshots30dError === null && totalVolumePrior7d !== null) {
          const priorSnaps = snapshots30d.filter((s) => {
            const t = Number(s.timestamp);
            return t >= priorWindow.from && t < priorWindow.to;
          });
          const priorMap = buildPoolVolumeMap(
            priorSnaps,
            pools,
            network,
            netData.rates,
          );
          totalVolumePrior7d += sumVolumeMap(priorMap);
        }

        // Store per-pool volume for the table columns
        for (const pool of pools) {
          const entry: GlobalPoolEntry = {
            pool,
            network,
            rates: netData.rates,
          };
          allEntries.push(entry);
          const key = globalPoolKey(entry);
          allVol24h.set(key, vol24hMap ? vol24hMap.get(pool.id) : null);
          allVol7d.set(key, vol7dMap ? vol7dMap.get(pool.id) : null);
        }

        // Fees
        if (netData.feesError === null && fees !== null) {
          if (totalFeesAllTime !== null) totalFeesAllTime += fees.totalFeesUSD;
          if (totalFees24h !== null) totalFees24h += fees.fees24hUSD;
          if (totalFees7d !== null) totalFees7d += fees.fees7dUSD;
          if (totalFees30d !== null) totalFees30d += fees.fees30dUSD;
          fees.unpricedSymbols.forEach((s) => unpricedSymbolSet.add(s));
          totalUnresolvedCount += fees.unresolvedCount;
          if (fees.isTruncated) isTruncated = true;
        }

        // LP count — accumulate from successful chains
        if (netData.uniqueLpCount !== null && totalUniqueLps !== null) {
          totalUniqueLps += netData.uniqueLpCount;
          hasSuccessfulLpResult = true;
        }
      }

      // Show N/A only when no chain contributed a successful LP result
      if (!hasSuccessfulLpResult && anyLpError) {
        totalUniqueLps = null;
      }

      return {
        aggregated: {
          totalPools,
          totalFpmmPools,
          totalTvl,
          totalVolumeAllTime,
          totalVolume24h,
          totalVolume7d,
          totalVolume30d,
          totalSwapsAllTime,
          totalFeesAllTime,
          totalFees24h,
          totalFees7d,
          totalFees30d,
          totalUniqueLps,
          tvlChange7d:
            hasTvlSnapshots7d && tvlAgo7d > 0
              ? ((tvlNow7d - tvlAgo7d) / tvlAgo7d) * 100
              : null,
          volumeChange7d:
            totalVolume7d !== null &&
            totalVolumePrior7d !== null &&
            totalVolumePrior7d > 0
              ? ((totalVolume7d - totalVolumePrior7d) / totalVolumePrior7d) *
                100
              : null,
          unpricedSymbols: Array.from(unpricedSymbolSet).sort(),
          totalUnresolvedCount,
          isTruncated,
        },
        globalEntries: allEntries,
        volume24hByKey: allVol24h,
        volume7dByKey: allVol7d,
      };
    }, [
      networkData,
      anyNetworkError,
      anySnapshotsError,
      anySnapshots7dError,
      anySnapshots30dError,
      anyFeesError,
      anyLpError,
    ]);

  // Networks that failed at the top level — show an error notice per chain
  const failedNetworks = networkData.filter((net) => net.error !== null);

  const feesApprox =
    aggregated.unpricedSymbols.length > 0 ||
    aggregated.isTruncated ||
    aggregated.totalUnresolvedCount > 0;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white mb-1">Global Overview</h1>
        <p className="text-sm text-slate-400">
          Protocol-wide statistics across all chains
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <TvlOverTimeChart
          networkData={networkData}
          totalTvl={aggregated.totalTvl}
          change7d={aggregated.tvlChange7d}
          isLoading={isLoading}
          hasError={anyNetworkError}
          hasSnapshotError={anySnapshots7dError || anySnapshots30dError}
        />
        <VolumeOverTimeChart
          networkData={networkData}
          totalVolume7d={aggregated.totalVolume7d}
          change7d={aggregated.volumeChange7d}
          isLoading={isLoading}
          hasError={anyNetworkError}
          hasSnapshotError={anySnapshots7dError || anySnapshots30dError}
        />
      </div>

      {/* Summary tiles */}
      <section>
        <h2 className="text-lg font-semibold text-white mb-3">Summary</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <BreakdownTile
            label="Volume"
            total={aggregated.totalVolumeAllTime}
            sub24h={aggregated.totalVolume24h}
            sub7d={aggregated.totalVolume7d}
            sub30d={aggregated.totalVolume30d}
            isLoading={isLoading}
            hasError={
              anyNetworkError ||
              anySnapshotsError ||
              anySnapshots7dError ||
              anySnapshots30dError
            }
            format={formatUSD}
          />

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
            href="https://debank.com/profile/0x0dd57f6f181d0469143fe9380762d8a112e96e4a"
            subtitle={
              aggregated.isTruncated
                ? "Lower bound — data exceeds query limit"
                : aggregated.unpricedSymbols.length > 0
                  ? `Approximate — unpriced: ${aggregated.unpricedSymbols.join(", ")}`
                  : aggregated.totalUnresolvedCount > 0
                    ? "Approximate — some tokens unresolved"
                    : undefined
            }
          />

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
            label="LPs"
            value={
              isLoading
                ? "…"
                : aggregated.totalUniqueLps === null
                  ? "N/A"
                  : aggregated.totalUniqueLps.toLocaleString()
            }
            subtitle={
              anyLpError
                ? "Partial — some chains failed to load"
                : "Unique FPMM LP addresses (per-chain)"
            }
          />

          <Tile
            label="Swaps"
            value={
              isLoading
                ? "…"
                : aggregated.totalSwapsAllTime === null
                  ? "N/A"
                  : aggregated.totalSwapsAllTime.toLocaleString()
            }
            subtitle="All-time across all pools"
          />
        </div>
      </section>

      {failedNetworks.map((net) => (
        <ErrorBox
          key={net.network.id}
          message={`${net.network.label}: Failed to load pools — ${net.error?.message}`}
        />
      ))}

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

// ---------------------------------------------------------------------------
// BreakdownTile — shows a "Total" headline value with 24h / 7d / 30d below
// ---------------------------------------------------------------------------

function BreakdownTile({
  label,
  total,
  sub24h,
  sub7d,
  sub30d,
  isLoading,
  hasError,
  format,
  totalPrefix = "",
  href,
  subtitle,
}: {
  label: string;
  total: number | null;
  sub24h: number | null;
  sub7d: number | null;
  sub30d: number | null;
  isLoading: boolean;
  hasError: boolean;
  format: (v: number) => string;
  /** Prefix for the headline value only (e.g. "≈ "), not applied to sub-values */
  totalPrefix?: string;
  href?: string;
  subtitle?: string;
}) {
  const mainValue = isLoading
    ? "…"
    : total === null
      ? "N/A"
      : `${totalPrefix}${format(total)}`;

  const subItems =
    !isLoading && !hasError && total !== null
      ? [
          { label: "24h", value: sub24h },
          { label: "7d", value: sub7d },
          { label: "30d", value: sub30d },
        ]
      : null;

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 px-5 py-4 flex flex-col justify-between min-h-[88px]">
      <div>
        <p className="text-sm text-slate-400">{label}</p>
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`${label}: ${mainValue}`}
            className="mt-1 block text-2xl font-semibold text-white font-mono hover:text-indigo-400 transition-colors"
          >
            {mainValue}
          </a>
        ) : (
          <p className="mt-1 text-2xl font-semibold text-white font-mono">
            {mainValue}
          </p>
        )}
        {subItems && (
          <div className="mt-1.5 flex gap-3 text-sm font-mono">
            {subItems.map((s) => (
              <span key={s.label}>
                <span className="text-slate-500">{s.label}</span>{" "}
                <span className="text-slate-400">
                  {s.value === null ? "N/A" : format(s.value)}
                </span>
              </span>
            ))}
          </div>
        )}
      </div>
      <p
        className="mt-2 text-xs text-slate-500 min-h-4"
        aria-hidden={!subtitle && !hasError}
      >
        {hasError ? "Some chains failed to load" : subtitle}
      </p>
    </div>
  );
}
