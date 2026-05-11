"use client";

import { Suspense, useMemo } from "react";
import { formatUSD } from "@/lib/format";
import { isFpmm, poolTvlUSD, type OracleRateMap } from "@/lib/tokens";
import type { Pool, PoolSnapshotWindow } from "@/lib/types";
import type { Network } from "@/lib/networks";
import {
  useAllNetworksData,
  type NetworkData,
} from "@/hooks/use-all-networks-data";
import { Skeleton, EmptyBox, ErrorBox, Tile } from "@/components/feedback";
import { GlobalPoolsTable } from "@/components/global-pools-table";
import { buildGlobalPoolEntries } from "@/lib/global-pool-entries";
import { TvlOverTimeChart } from "@/components/tvl-over-time-chart";
import { VolumeOverTimeChart } from "@/components/volume-over-time-chart";
import { BreakdownTile } from "@/components/breakdown-tile";

export default function GlobalPage({
  initialNetworkData,
}: {
  initialNetworkData?: NetworkData[];
}) {
  // First paint uses `initialNetworkData` via SWR's `fallbackData`; on
  // back-navigation the populated SWR cache wins, which is the right call —
  // cache may hold fresher data from another page's polling cycle (e.g.
  // /pools also calls useAllNetworksData under the same key). If no other
  // page has polled, the worst case is the cache matches the SSR payload
  // anyway, and the next `refreshInterval` tick will refresh either way.
  return (
    <Suspense>
      <GlobalContent initialNetworkData={initialNetworkData} />
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
): Map<string, { now: number | null; ago: number | null }> {
  const fpmmMap = new Map(
    pools.flatMap((p) => (isFpmm(p) ? [[p.id, p] as const] : [])),
  );
  const earliest = new Map<string, PoolSnapshotWindow>();
  for (const s of snapshots) {
    if (!fpmmMap.has(s.poolId)) continue;
    const existing = earliest.get(s.poolId);
    if (!existing || Number(s.timestamp) < Number(existing.timestamp)) {
      earliest.set(s.poolId, s);
    }
  }
  // `null` propagates "TVL unknowable for this pool" (untrusted decimals)
  // up to consumers — see `poolTvlUSD` in `lib/tokens.ts` for the rationale.
  const result = new Map<string, { now: number | null; ago: number | null }>();
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

// Intentional react-doctor suppression: global hero + multi-section trend
// layout share the same cross-network aggregation state. Revisit only with a
// focused split that keeps those derived values centralized.
// react-doctor-disable-next-line react-doctor/no-giant-component
function GlobalContent({
  initialNetworkData,
}: {
  initialNetworkData?: NetworkData[];
}) {
  const { networkData, isLoading } = useAllNetworksData(initialNetworkData);

  // Whether any network has a top-level, rates, snapshot, or pagination
  // failure. Used to show N/A / "partial data" in KPI tiles rather than
  // silently under-reporting. Fee data flows from `PoolDailyFeeSnapshot`
  // since PR-snapshot-3, so any failure that affects the snapshot path
  // (rates rejection ⇒ FX mis-pricing; snapshot pagination rejection ⇒
  // no data) blanks the chain-level Swap Fees tile.
  const anyNetworkError = networkData.some((netData) => netData.error !== null);
  const anyFeesError = networkData.some(
    (netData) =>
      (netData.ratesError !== null || netData.feeSnapshotsError !== null) &&
      netData.error === null,
  );
  const anyFeesTruncated = networkData.some(
    (netData) => netData.feeSnapshotsTruncated && netData.error === null,
  );
  const anySnapshots7dError = networkData.some(
    (netData) => netData.snapshots7dError !== null && netData.error === null,
  );
  const anySnapshotsAllDailyError = networkData.some(
    (netData) =>
      netData.snapshotsAllDailyError !== null && netData.error === null,
  );
  const anySnapshotsAllDailyTruncated = networkData.some(
    (netData) => netData.snapshotsAllDailyTruncated && netData.error === null,
  );
  const anyBrokerSnapshotsAllDailyError = networkData.some(
    (netData) =>
      netData.brokerSnapshotsAllDailyError !== null && netData.error === null,
  );
  const anyBrokerSnapshotsAllDailyTruncated = networkData.some(
    (netData) =>
      netData.brokerSnapshotsAllDailyTruncated && netData.error === null,
  );
  const anyLpError = networkData.some(
    (netData) => netData.lpError !== null && netData.error === null,
  );

  // Per-pool entries, volume, WoW, trading limits, OLS — shared with pools page
  const {
    entries: globalEntries,
    volume24hByKey,
    volume7dByKey,
    tvlChangeWoWByKey,
    tradingLimitsByKey,
    olsPoolKeys,
    cdpPoolKeys,
    reservePoolKeys,
  } = useMemo(() => buildGlobalPoolEntries(networkData), [networkData]);

  // Aggregate KPIs across all chains for the summary tiles.
  const aggregated = useMemo(() => {
    let totalPools = 0;
    let totalFpmmPools = 0;
    let totalTvl = 0;
    // Count of pools whose TVL was unknowable (untrusted decimals → null).
    // Drives the headline's `(partial)` qualifier so the user can see when
    // the sum is provisional. Mirrors the OG path's null aggregate behavior.
    let unknownTvlPools = 0;
    let priceableTvlPools = 0;
    // Track current + historical TVL only for chains that contributed
    // snapshot data, so numerator and denominator always match. Uses the 7d
    // window so weekend oracle stalls in FX pools don't distort the delta.
    let tvlNow7d = 0;
    let tvlAgo7d = 0;
    let hasTvlSnapshots7d = false;
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
    let totalUnresolvedCount = 0;

    for (const netData of networkData) {
      if (netData.error !== null) continue;

      const { network, pools, snapshots7d, fees, rates } = netData;
      const fpmmPools = pools.filter(isFpmm);
      totalPools += pools.length;
      totalFpmmPools += fpmmPools.length;
      // Skip pools whose TVL is unknowable (untrusted decimals → null) AND
      // count them — the summed total is `formatUSD(totalTvl)` in the
      // headline, which would otherwise misrepresent partial-trust state
      // as complete. See `poolTvlUSD` in `lib/tokens.ts` and the
      // `tvlPartial` flag plumbed into `TvlOverTimeChart` below.
      let chainTvlNow = 0;
      for (const p of fpmmPools) {
        const v = poolTvlUSD(p, network, rates);
        if (v === null) {
          unknownTvlPools += 1;
        } else {
          chainTvlNow += v;
          priceableTvlPools += 1;
        }
      }
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
          // Skip pools whose TVL is unknowable (untrusted decimals → null).
          // Including null on either side would either NaN-poison the sum or
          // misrepresent a missing-data pool as $0 — both wrong for the WoW
          // KPI. See `poolTvlUSD` in `lib/tokens.ts`.
          if (v.now === null || v.ago === null) continue;
          tvlNow7d += v.now;
          tvlAgo7d += v.ago;
        }
        hasTvlSnapshots7d = true;
      }

      if (totalSwapsAllTime !== null) {
        totalSwapsAllTime += pools.reduce(
          (sum, p) => sum + (p.swapCount ?? 0),
          0,
        );
      }

      // Fees — `fees` is null when ratesError or feeSnapshotsError fired
      // for this network, so the null check is sufficient to gate the add.
      if (fees !== null) {
        if (totalFeesAllTime !== null) totalFeesAllTime += fees.totalFeesUSD;
        if (totalFees24h !== null) totalFees24h += fees.fees24hUSD;
        if (totalFees7d !== null) totalFees7d += fees.fees7dUSD;
        if (totalFees30d !== null) totalFees30d += fees.fees30dUSD;
        fees.unpricedSymbols.forEach((s) => unpricedSymbolSet.add(s));
        totalUnresolvedCount += fees.unresolvedCount;
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
      totalPools,
      totalFpmmPools,
      totalTvl,
      // `tvlPartial` semantics:
      //   - `null` (no priceable pools) → headline renders "—"
      //   - `false` (every priceable pool had a value) → headline = USD total
      //   - `true` (≥1 priceable pool returned null) → headline = USD total + "(partial)"
      tvlPartial: priceableTvlPools === 0 ? null : unknownTvlPools > 0,
      unknownTvlPools,
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
    };
  }, [
    networkData,
    anyNetworkError,
    anySnapshots7dError,
    anyFeesError,
    anyLpError,
  ]);

  // Networks that failed at the top level — show an error notice per chain
  const failedNetworks = networkData.filter((net) => net.error !== null);

  const feesApprox =
    aggregated.unpricedSymbols.length > 0 ||
    aggregated.totalUnresolvedCount > 0 ||
    anyFeesTruncated;

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
          tvlPartial={aggregated.tvlPartial}
          change7d={aggregated.tvlChange7d}
          isLoading={isLoading}
          hasError={anyNetworkError}
          hasSnapshotError={
            anySnapshots7dError ||
            anySnapshotsAllDailyError ||
            anySnapshotsAllDailyTruncated
          }
        />
        <VolumeOverTimeChart
          networkData={networkData}
          isLoading={isLoading}
          hasError={anyNetworkError}
          hasSnapshotError={
            anySnapshotsAllDailyError || anySnapshotsAllDailyTruncated
          }
          hasBrokerSnapshotError={
            anyBrokerSnapshotsAllDailyError ||
            anyBrokerSnapshotsAllDailyTruncated
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
              anyFeesTruncated
                ? "Approximate — full history exceeds pagination cap"
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
            tradingLimitsByKey={tradingLimitsByKey}
            olsPoolKeys={olsPoolKeys}
            cdpPoolKeys={cdpPoolKeys}
            reservePoolKeys={reservePoolKeys}
          />
        )}
      </section>
    </div>
  );
}
