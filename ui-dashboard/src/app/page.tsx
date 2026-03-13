"use client";

import { Suspense, useMemo } from "react";
import { useGQL } from "@/lib/graphql";
import { ALL_POOLS_WITH_HEALTH, POOL_SNAPSHOTS_24H } from "@/lib/queries";
import { formatUSD } from "@/lib/format";
import { isFpmm, poolTvlUSD, tokenSymbol, USDM_SYMBOLS } from "@/lib/tokens";
import {
  buildPool24hVolumeMap,
  shouldQueryPoolSnapshots24h,
  snapshotWindow24h,
  sumFpmmSwaps24h,
} from "@/lib/volume";
import { useNetwork } from "@/components/network-provider";
import { useProtocolFees } from "@/hooks/use-protocol-fees";
import type { Pool, PoolSnapshot24h } from "@/lib/types";
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
  const {
    data: poolsData,
    error: poolsErr,
    isLoading: poolsLoading,
  } = useGQL<{ Pool: Pool[] }>(ALL_POOLS_WITH_HEALTH);
  const { network } = useNetwork();

  const pools = poolsData?.Pool ?? [];
  const fpmmPools = useMemo(() => pools.filter(isFpmm), [pools]);

  const usdConvertiblePoolIds = useMemo(
    () =>
      pools
        .filter((pool) => {
          const sym0 = tokenSymbol(network, pool.token0 ?? null);
          const sym1 = tokenSymbol(network, pool.token1 ?? null);
          return USDM_SYMBOLS.has(sym0) || USDM_SYMBOLS.has(sym1);
        })
        .map((pool) => pool.id),
    [pools, network],
  );

  // Include all FPMM pool IDs in the snapshot query so we can compute 24h swap counts.
  const snapshotPoolIds = useMemo(() => {
    const fpmmIds = fpmmPools.map((p) => p.id);
    return [...new Set([...usdConvertiblePoolIds, ...fpmmIds])];
  }, [usdConvertiblePoolIds, fpmmPools]);

  // Query exactly the previous 24 complete hourly buckets: [from, to).
  const { from, to } = snapshotWindow24h(Date.now());
  const shouldQuerySnapshots = shouldQueryPoolSnapshots24h(snapshotPoolIds);
  const snapshotsVariables = useMemo(
    () =>
      shouldQuerySnapshots ? { from, to, poolIds: snapshotPoolIds } : undefined,
    [from, to, shouldQuerySnapshots, snapshotPoolIds],
  );
  const {
    data: snapshotsData,
    error: snapshotsErr,
    isLoading: snapshotsLoading,
  } = useGQL<{ PoolSnapshot: PoolSnapshot24h[] }>(
    shouldQuerySnapshots ? POOL_SNAPSHOTS_24H : null,
    snapshotsVariables,
    300_000,
  );
  const snapshots24h = snapshotsData?.PoolSnapshot ?? [];

  // TVL for FPMM pools
  const fpmmTvl = fpmmPools.reduce((sum, p) => sum + poolTvlUSD(p, network), 0);

  const volume24hMap = useMemo(
    () => buildPool24hVolumeMap(snapshots24h, pools, network),
    [snapshots24h, pools, network],
  );
  const total24hVolume = useMemo(() => {
    if (snapshotsErr) return null;
    return Array.from(volume24hMap.values()).reduce<number>(
      (sum, v) => (typeof v === "number" ? sum + v : sum),
      0,
    );
  }, [volume24hMap, snapshotsErr]);

  const fpmmPoolIdSet = useMemo(
    () => new Set(fpmmPools.map((p) => p.id)),
    [fpmmPools],
  );
  const swaps24hFpmm = useMemo(
    () => sumFpmmSwaps24h(snapshots24h, fpmmPoolIdSet),
    [snapshots24h, fpmmPoolIdSet],
  );

  const {
    data: fees,
    isLoading: feesLoading,
    error: feesErr,
  } = useProtocolFees();

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white mb-1">Global Overview</h1>
        <p className="text-sm text-slate-400">
          Protocol-wide statistics across all pools
        </p>
      </div>

      {poolsErr && (
        <ErrorBox message={`Failed to load data: ${poolsErr.message}`} />
      )}
      {snapshotsErr && (
        <ErrorBox
          message={`Failed to load 24h snapshots: ${snapshotsErr.message}`}
        />
      )}
      {feesErr && (
        <ErrorBox
          message={`Failed to load protocol fees: ${feesErr.message}`}
        />
      )}

      {/* Summary tiles */}
      <section>
        <h2 className="text-lg font-semibold text-white mb-3">Summary</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <Tile
            label="Pools"
            value={poolsLoading ? "…" : String(pools.length)}
            subtitle={
              poolsLoading || !network.hasVirtualPools
                ? undefined
                : `${fpmmPools.length} FPMMs · ${pools.length - fpmmPools.length} Virtual`
            }
          />
          <Tile
            label="TVL (FPMMs)"
            value={poolsLoading ? "…" : formatUSD(fpmmTvl)}
          />
          <Tile
            label="Total Fees Earned"
            value={
              feesLoading
                ? "…"
                : feesErr
                  ? "N/A"
                  : fees
                    ? `${fees.hasUnknownTokens ? "≈ " : ""}${formatUSD(fees.totalFeesUSD)}`
                    : "N/A"
            }
            subtitle={
              fees?.hasUnknownTokens
                ? "Approximate — some tokens unpriced"
                : "All-time cumulative"
            }
          />
          <Tile
            label="24h Volume"
            value={
              poolsLoading || snapshotsLoading
                ? "…"
                : total24hVolume === null
                  ? "N/A"
                  : formatUSD(total24hVolume)
            }
          />
          <Tile
            label="24h Swaps (FPMMs)"
            value={
              poolsLoading || snapshotsLoading
                ? "…"
                : snapshotsErr
                  ? "N/A"
                  : swaps24hFpmm.toLocaleString()
            }
          />
          <Tile
            label="24h Fees Earned"
            value={
              feesLoading
                ? "…"
                : feesErr
                  ? "N/A"
                  : fees
                    ? formatUSD(fees.fees24hUSD)
                    : "N/A"
            }
          />
        </div>
      </section>

      {/* All pools table */}
      <section>
        <h2 className="text-lg font-semibold text-white mb-3">All Pools</h2>
        {poolsLoading ? (
          <Skeleton rows={5} />
        ) : pools.length === 0 ? (
          <EmptyBox message="No pools found." />
        ) : (
          <PoolsTable
            pools={pools}
            volume24h={volume24hMap}
            volume24hLoading={snapshotsLoading}
            volume24hError={Boolean(snapshotsErr)}
          />
        )}
      </section>
    </div>
  );
}
