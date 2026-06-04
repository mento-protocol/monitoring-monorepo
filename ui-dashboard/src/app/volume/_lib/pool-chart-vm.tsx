"use client";

import { useMemo } from "react";
import { networkForChainId } from "@/lib/networks";
import { poolName } from "@/lib/tokens";
import { SECONDS_PER_DAY } from "@/lib/time-series";
import { aggregatePoolDailyVolume } from "@/lib/volume-pool";
import type { PoolDailyVolumeRow } from "@/lib/volume-pool";
import type { ReactNode } from "react";

type PoolMetaEntry = {
  token0: string | null;
  token1: string | null;
};

type ChartBreakdownEntry = {
  id: string;
  name: string;
  color: string;
  series: Array<{ timestamp: number; value: number }>;
  legendIcon: ReactNode;
};

type TopPoolsListEntry = {
  poolId: string;
  name: string;
  chainBadge: ReactNode;
  totalUsd: number;
  share: number;
  color: string | null;
};

function poolDisplayName(
  poolId: string,
  poolMeta: ReadonlyMap<string, PoolMetaEntry>,
): string {
  const meta = poolMeta.get(poolId.toLowerCase());
  const [chainIdPart, addr] = poolId.split("-", 2);
  const network = chainIdPart ? networkForChainId(Number(chainIdPart)) : null;
  if (network && meta) return poolName(network, meta.token0, meta.token1);
  const a = addr ?? poolId;
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/**
 * View-model for the per-pool stacked chart + Top Pools sidebar.
 * Bundles the full derivation chain so `VolumeClient` doesn't
 * carry it inline.
 */
export function usePoolChartViewModel(args: {
  includeProtocolActors: boolean;
  poolVolumeRows: readonly PoolDailyVolumeRow[];
  poolMeta: ReadonlyMap<string, PoolMetaEntry>;
  cutoff: number;
  utcDayKey: number;
}): {
  poolVolumeBreakdown: ReturnType<typeof aggregatePoolDailyVolume>;
  chartBreakdown: ChartBreakdownEntry[];
  topPoolsListEntries: TopPoolsListEntry[];
} {
  const { includeProtocolActors, poolVolumeRows, poolMeta, cutoff, utcDayKey } =
    args;

  // UTC-day window so the chart's x-axis stays contiguous when a day had
  // zero volume protocol-wide. `cutoff` is already aligned to UTC midnight.
  // `utcDayKey` is in deps so the memo flushes at midnight along with `cutoff`.
  const windowRange = useMemo(() => {
    const todayMidnightUtc =
      Math.floor(Date.now() / 1000 / SECONDS_PER_DAY) * SECONDS_PER_DAY;
    return cutoff > 0
      ? { fromSec: cutoff, toSec: todayMidnightUtc }
      : undefined;
  }, [cutoff, utcDayKey]);

  const poolVolumeBreakdown = useMemo(() => {
    return aggregatePoolDailyVolume(
      poolVolumeRows,
      (poolId) => poolDisplayName(poolId, poolMeta),
      includeProtocolActors,
      windowRange,
    );
  }, [poolVolumeRows, poolMeta, includeProtocolActors, windowRange]);

  // Decorate breakdown with chain text labels for the legend / tooltip.
  // Chain icons were dropped — at 12px they conflated cross-chain pairs
  // (USDC/USDm Celo vs Monad). Plain text is unambiguous.
  const chartBreakdown = useMemo<ChartBreakdownEntry[]>(() => {
    return poolVolumeBreakdown.breakdown.map((b) => {
      const [chainIdPart] = b.key.split("-", 2);
      const network = chainIdPart
        ? networkForChainId(Number(chainIdPart))
        : null;
      return {
        // Stable identity for legend visibility tracking — survives
        // rank-based color reshuffles and cross-chain name collisions.
        // For "Other" the key is the constant `__other__`, also stable.
        id: b.key,
        name: b.name,
        color: b.color,
        series: b.series,
        legendIcon: network ? (
          <span className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
            {network.label}
          </span>
        ) : null,
      };
    });
  }, [poolVolumeBreakdown]);

  // Top 10 pools by total window volume. Top-N (where N = TOP_N_POOLS in
  // aggregatePoolDailyVolume) borrow the chart color; entries beyond that
  // get null (rendered muted in <TopPoolsList>).
  const topPoolsListEntries = useMemo<TopPoolsListEntry[]>(() => {
    const total = poolVolumeBreakdown.windowTotalUsdWei;
    const colorByPoolId = new Map<string, string>();
    for (const b of poolVolumeBreakdown.breakdown) {
      if (b.key !== "__other__") colorByPoolId.set(b.key, b.color);
    }
    return poolVolumeBreakdown.poolRanking.slice(0, 10).map((p) => {
      const [chainIdPart] = p.poolId.split("-", 2);
      const network = chainIdPart
        ? networkForChainId(Number(chainIdPart))
        : null;
      const share =
        total === BigInt(0)
          ? 0
          : // (totalUsdWei * 10000n) / total — keeps 4 decimals of
            // precision via BigInt before converting.
            Number((p.totalUsdWei * BigInt(10000)) / total) / 10000;
      return {
        poolId: p.poolId,
        name: poolDisplayName(p.poolId, poolMeta),
        chainBadge: network ? (
          <span className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
            {network.label}
          </span>
        ) : null,
        totalUsd: p.totalUsd,
        share,
        color: colorByPoolId.get(p.poolId) ?? null,
      };
    });
  }, [poolVolumeBreakdown, poolMeta]);

  return { poolVolumeBreakdown, chartBreakdown, topPoolsListEntries };
}
