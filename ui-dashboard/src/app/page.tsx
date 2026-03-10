"use client";

import { Suspense, useMemo } from "react";
import Link from "next/link";
import { useGQL } from "@/lib/graphql";
import { ALL_POOLS_WITH_HEALTH, POOL_SNAPSHOTS_24H } from "@/lib/queries";
import { formatWei, formatUSD } from "@/lib/format";
import {
  poolName,
  isFpmm,
  poolTvlUSD,
  tokenSymbol,
  USDM_SYMBOLS,
} from "@/lib/tokens";
import {
  buildPool24hVolumeMap,
  shouldQueryPoolSnapshots24h,
  snapshotWindow24h,
} from "@/lib/volume";
import { useNetwork } from "@/components/network-provider";
import type { Pool, PoolSnapshot24h } from "@/lib/types";
import { Table, Row, Th, Td } from "@/components/table";
import { Skeleton, EmptyBox, ErrorBox, Tile } from "@/components/feedback";
import { SourceBadge } from "@/components/badges";
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

  // Query exactly the previous 24 complete hourly buckets: [from, to).
  const { from, to } = snapshotWindow24h(Date.now());
  const shouldQuerySnapshots = shouldQueryPoolSnapshots24h(
    usdConvertiblePoolIds,
  );
  const snapshotsVariables = useMemo(
    () =>
      shouldQuerySnapshots
        ? { from, to, poolIds: usdConvertiblePoolIds }
        : undefined,
    [from, to, shouldQuerySnapshots, usdConvertiblePoolIds],
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

  const fpmmPools = pools.filter(isFpmm);
  const virtualPools = pools.filter((p) => !isFpmm(p));

  const okCount = pools.filter((p) => p.healthStatus === "OK").length;
  const warnCount = pools.filter((p) => p.healthStatus === "WARN").length;
  const critCount = pools.filter((p) => p.healthStatus === "CRITICAL").length;
  // N/A = VirtualPools (oracle health not applicable) + any pools without health data
  const naCount = pools.filter(
    (p) => !p.healthStatus || p.healthStatus === "N/A",
  ).length;

  // Derive total swaps from pool cumulative counts (avoids a second query)
  const totalSwaps = pools.reduce((sum, p) => sum + (p.swapCount ?? 0), 0);

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

      {/* Summary tiles */}
      <section>
        <h2 className="text-lg font-semibold text-white mb-3">Summary</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div>
            <Tile
              label="Pools"
              value={poolsLoading ? "…" : String(pools.length)}
            />
            {!poolsLoading && (
              <p className="mt-1 text-xs text-slate-500">
                {fpmmPools.length} FPMMs · {virtualPools.length} Virtual
              </p>
            )}
          </div>
          <Tile
            label="TVL (FPMMs)"
            value={poolsLoading ? "…" : formatUSD(fpmmTvl)}
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
            label="Total Swaps"
            value={poolsLoading ? "…" : totalSwaps.toLocaleString()}
          />
        </div>
      </section>

      {/* Health breakdown */}
      <section>
        <h2 className="text-lg font-semibold text-white mb-3">
          Health Status
          <span className="ml-2 text-xs font-normal text-slate-500">
            (N/A = VirtualPools — oracle health not applicable)
          </span>
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Tile label="🟢 OK" value={poolsLoading ? "…" : String(okCount)} />
          <Tile
            label="🟡 WARN"
            value={poolsLoading ? "…" : String(warnCount)}
          />
          <Tile
            label="🔴 CRITICAL"
            value={poolsLoading ? "…" : String(critCount)}
          />
          <Tile label="⚪ N/A" value={poolsLoading ? "…" : String(naCount)} />
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

      {/* Activity summary */}
      <section>
        <h2 className="text-lg font-semibold text-white mb-3">Pool Activity</h2>
        {poolsLoading ? (
          <Skeleton rows={5} />
        ) : pools.length === 0 ? (
          <EmptyBox message="No pools found." />
        ) : (
          <ActivityTable pools={pools} />
        )}
      </section>
    </div>
  );
}

function ActivityTable({ pools }: { pools: Pool[] }) {
  const { network } = useNetwork();
  // Sort by swap count descending
  const sorted = [...pools].sort(
    (a, b) => (b.swapCount ?? 0) - (a.swapCount ?? 0),
  );
  return (
    <Table>
      <thead>
        <tr className="border-b border-slate-800 bg-slate-900/50">
          <Th>Pool</Th>
          <Th>Type</Th>
          <Th align="right">Swaps</Th>
          <Th align="right">Rebalances</Th>
          <Th align="right">Volume (Token 0)</Th>
          <Th align="right">Volume (Token 1)</Th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((p) => (
          <Row key={p.id}>
            <td className="px-4 py-3">
              <Link
                href={`/pool/${encodeURIComponent(p.id)}`}
                className="font-semibold text-indigo-400 hover:text-indigo-300"
              >
                {poolName(network, p.token0, p.token1)}
              </Link>
            </td>
            <td className="px-4 py-3">
              <SourceBadge source={p.source} />
            </td>
            <Td mono small align="right">
              {p.swapCount ?? 0}
            </Td>
            <Td mono small align="right">
              {p.rebalanceCount ?? 0}
            </Td>
            <Td mono small align="right">
              {p.notionalVolume0 ? formatWei(p.notionalVolume0) : "—"}
            </Td>
            <Td mono small align="right">
              {p.notionalVolume1 ? formatWei(p.notionalVolume1) : "—"}
            </Td>
          </Row>
        ))}
      </tbody>
    </Table>
  );
}
