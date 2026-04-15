"use client";

import { Suspense, useMemo } from "react";
import { formatUSD } from "@/lib/format";
import { isFpmm, poolTvlUSD, type OracleRateMap } from "@/lib/tokens";
import type { Pool, PoolSnapshotWindow } from "@/lib/types";
import type { Network } from "@/lib/networks";
import {
  buildPoolVolumeMap,
  poolTotalVolumeUSD,
  sumVolumeMap,
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

/**
 * For each FPMM pool with a snapshot in the window, returns current TVL (`now`)
 * and historical TVL (`ago`, using today's rates on the earliest in-window
 * reserves). Used for both the aggregate KPI delta and the per-pool WoW column,
 * ensuring both derive from a single scan.
 *
 * Uses today's oracle rate (not the historical rate) so the percentage change
 * isolates reserve-quantity movements from price movements.
 */
function perPoolTvlWindow(
  snapshots: PoolSnapshotWindow[],
  pools: Pool[],
  network: Network,
  rates: OracleRateMap,
): Map<string, { now: number; ago: number }> {
  const fpmmMap = new Map(pools.filter(isFpmm).map((p) => [p.id, p]));
  const earliest = new Map<string, PoolSnapshotWindow>();
  for (const s of snapshots) {
    if (!fpmmMap.has(s.poolId)) continue;
    const existing = earliest.get(s.poolId);
    if (!existing || Number(s.timestamp) < Number(existing.timestamp)) {
      earliest.set(s.poolId, s);
    }
  }
  const result = new Map<string, { now: number; ago: number }>();
  for (const [poolId, snap] of earliest) {
    const pool = fpmmMap.get(poolId)!;
    result.set(poolId, {
      now: poolTvlUSD(pool, network, rates),
      ago: poolTvlUSD(
        { ...pool, reserves0: snap.reserves0, reserves1: snap.reserves1 },
        network,
        rates,
      ),
    });
  }
  return result;
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
  const anySnapshotsAllError = networkData.some(
    (netData) => netData.snapshotsAllError !== null && netData.error === null,
  );
  const anySnapshotsAllTruncated = networkData.some(
    (netData) => netData.snapshotsAllTruncated && netData.error === null,
  );
  const anySnapshotsAllDailyError = networkData.some(
    (netData) =>
      netData.snapshotsAllDailyError !== null && netData.error === null,
  );
  const anySnapshotsAllDailyTruncated = networkData.some(
    (netData) => netData.snapshotsAllDailyTruncated && netData.error === null,
  );
  const anyLpError = networkData.some(
    (netData) => netData.lpError !== null && netData.error === null,
  );

  // Aggregate KPIs and per-pool volume maps in a single pass (no duplicate
  // buildPoolVolumeMap calls).
  const {
    aggregated,
    globalEntries,
    volume24hByKey,
    volume7dByKey,
    tvlChangeWoWByKey,
  } = useMemo(() => {
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
    const allTvlWoW = new Map<string, number | null>();
    let totalVolumeAllTime: number | null = anyNetworkError ? null : 0;
    let totalVolume24h: number | null =
      anySnapshotsError || anyNetworkError ? null : 0;
    let totalVolume7d: number | null =
      anySnapshots7dError || anyNetworkError ? null : 0;
    let totalVolume30d: number | null =
      anySnapshots30dError || anyNetworkError ? null : 0;
    let totalSwapsAllTime: number | null = anyNetworkError ? null : 0;
    let totalFeesAllTime: number | null =
      anyFeesError || anyNetworkError ? null : 0;
    let totalFees24h: number | null =
      anyFeesError || anyNetworkError ? null : 0;
    let totalFees7d: number | null = anyFeesError || anyNetworkError ? null : 0;
    let totalFees30d: number | null =
      anyFeesError || anyNetworkError ? null : 0;
    const uniqueLpSet = new Set<string>();
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

      // 7d-window per-pool TVL — computed once, reused for the aggregate
      // KPI delta and the per-pool WoW column below. Uses the 7d window so
      // weekend FX oracle stalls don't produce Monday spikes.
      const perPool7dTvl =
        netData.snapshots7dError === null && snapshots7d.length > 0
          ? perPoolTvlWindow(snapshots7d, pools, network, rates)
          : null;
      if (perPool7dTvl && perPool7dTvl.size > 0) {
        for (const v of perPool7dTvl.values()) {
          tvlNow7d += v.now;
          tvlAgo7d += v.ago;
        }
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

      // Store per-pool volume for the table columns. WoW uses three states:
      // explicit `null` = backend snapshot query failed (renders "N/A");
      // absent key = no comparable 7d snapshot for this pool (renders "—");
      // number = real WoW %.
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

        if (netData.snapshots7dError !== null) {
          allTvlWoW.set(key, null);
        } else {
          const v = perPool7dTvl?.get(pool.id);
          if (v && v.ago > 0) {
            allTvlWoW.set(key, ((v.now - v.ago) / v.ago) * 100);
          }
        }
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

      // LP addresses — union across successful chains so an address that
      // provides liquidity on multiple chains counts once globally.
      // `.toLowerCase()` defends against any per-chain source returning the
      // same wallet in checksum vs. lowercase; the per-chain hook already
      // lowercases before dedup, but this layer accepts any string input.
      if (netData.uniqueLpAddresses !== null) {
        for (const addr of netData.uniqueLpAddresses)
          uniqueLpSet.add(addr.toLowerCase());
        hasSuccessfulLpResult = true;
      }
    }

    // Show N/A when no chain contributed a successful LP result OR any
    // top-level chain error means we can't claim a complete global count.
    const totalUniqueLps =
      anyNetworkError || (!hasSuccessfulLpResult && anyLpError)
        ? null
        : uniqueLpSet.size;

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
        unpricedSymbols: Array.from(unpricedSymbolSet).sort(),
        totalUnresolvedCount,
        isTruncated,
      },
      globalEntries: allEntries,
      volume24hByKey: allVol24h,
      volume7dByKey: allVol7d,
      tvlChangeWoWByKey: allTvlWoW,
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
          hasSnapshotError={
            anySnapshots7dError ||
            anySnapshotsAllError ||
            anySnapshotsAllTruncated
          }
        />
        <VolumeOverTimeChart
          networkData={networkData}
          isLoading={isLoading}
          hasError={anyNetworkError}
          hasSnapshotError={
            anySnapshotsAllDailyError || anySnapshotsAllDailyTruncated
          }
        />
      </div>

      <section>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
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
            label="LPs"
            value={
              isLoading
                ? "…"
                : aggregated.totalUniqueLps === null
                  ? "N/A"
                  : aggregated.totalUniqueLps.toLocaleString()
            }
            subtitle={
              // totalUniqueLps is forced to null whenever any chain failed at
              // the top level, so the subtitle must degrade for network errors
              // too — not just lpError — otherwise we'd claim a complete
              // global metric while actually showing N/A.
              anyNetworkError || anyLpError
                ? "Partial — some chains failed to load"
                : "Unique LP addresses across all chains"
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
            tvlChangeWoWByKey={tvlChangeWoWByKey}
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
