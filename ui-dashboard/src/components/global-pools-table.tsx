"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { formatUSD } from "@/lib/format";
import {
  poolName,
  poolTvlUSD,
  tokenSymbol,
  type OracleRateMap,
} from "@/lib/tokens";
import type { Network } from "@/lib/networks";
import type { Pool, TradingLimit } from "@/lib/types";
import { Table, Row, Th } from "@/components/table";
import { SortableTh } from "@/components/sortable-th";
import { SourceBadge, HealthBadge } from "@/components/badges";
import { ChainIcon } from "@/components/chain-icon";
import {
  computeHealthStatus,
  computeLimitStatus,
  pressureColorClass,
  worstStatus,
} from "@/lib/health";
import { combinedTooltip } from "@/lib/pool-table-utils";
import { isWeekend } from "@/lib/weekend";
import { poolTotalVolumeUSD } from "@/lib/volume";
import { buildPoolDetailHref } from "@/lib/routing";
import type { SortDir } from "@/lib/table-sort";

/** A pool entry enriched with its originating network and oracle rates. */
export type GlobalPoolEntry = {
  pool: Pool;
  network: Network;
  rates: OracleRateMap;
};

type GlobalSortKey =
  | "pool"
  | "health"
  | "fee"
  | "tvl"
  | "tvlChangeWoW"
  | "volume24h"
  | "volume7d"
  | "totalVolume";

// Higher rank = more severe. "desc" puts highest rank first → CRITICAL first.
const HEALTH_ORDER: Record<string, number> = {
  "N/A": 0,
  OK: 1,
  WARN: 2,
  WEEKEND: 3,
  CRITICAL: 4,
};

/** Build a unique key for a pool entry so pools from different chains with the same ID don't collide. */
export function globalPoolKey(entry: GlobalPoolEntry): string {
  return `${entry.network.id}:${entry.pool.id}`;
}

export interface GlobalSortContext {
  tvlByKey: Map<string, number>;
  totalVolumeByKey: Map<string, number | null>;
  volume24hByKey?: Map<string, number | null | undefined>;
  volume7dByKey?: Map<string, number | null | undefined>;
  tvlChangeWoWByKey?: Map<string, number | null>;
}

export function sortGlobalPools(
  entries: GlobalPoolEntry[],
  sortKey: GlobalSortKey,
  sortDir: SortDir,
  {
    tvlByKey,
    totalVolumeByKey,
    volume24hByKey,
    volume7dByKey,
    tvlChangeWoWByKey,
  }: GlobalSortContext,
): GlobalPoolEntry[] {
  return [...entries].sort((a, b) => {
    const aKey = globalPoolKey(a);
    const bKey = globalPoolKey(b);
    let cmp = 0;
    switch (sortKey) {
      case "pool":
        cmp = poolName(a.network, a.pool.token0, a.pool.token1).localeCompare(
          poolName(b.network, b.pool.token0, b.pool.token1),
        );
        break;
      case "health": {
        const aH = worstStatus(
          computeHealthStatus(a.pool, a.network.chainId),
          a.pool.limitStatus ?? computeLimitStatus(a.pool),
        );
        const bH = worstStatus(
          computeHealthStatus(b.pool, b.network.chainId),
          b.pool.limitStatus ?? computeLimitStatus(b.pool),
        );
        cmp = (HEALTH_ORDER[aH] ?? 99) - (HEALTH_ORDER[bH] ?? 99);
        break;
      }
      case "fee": {
        const aHas = hasFeeData(a.pool);
        const bHas = hasFeeData(b.pool);
        if (!aHas && !bHas) return 0;
        if (!aHas) return 1;
        if (!bHas) return -1;
        const aFee = (a.pool.lpFee ?? 0) + (a.pool.protocolFee ?? 0);
        const bFee = (b.pool.lpFee ?? 0) + (b.pool.protocolFee ?? 0);
        return sortDir === "asc" ? aFee - bFee : bFee - aFee;
      }
      case "tvl":
        cmp = (tvlByKey.get(aKey) ?? 0) - (tvlByKey.get(bKey) ?? 0);
        break;
      case "tvlChangeWoW": {
        // Both error (null) and missing-data (undefined) sink regardless of direction.
        const aW = tvlChangeWoWByKey?.get(aKey);
        const bW = tvlChangeWoWByKey?.get(bKey);
        const aMissing = aW == null;
        const bMissing = bW == null;
        if (aMissing && bMissing) return 0;
        if (aMissing) return 1;
        if (bMissing) return -1;
        return sortDir === "asc" ? aW - bW : bW - aW;
      }
      case "volume24h": {
        const aV = volume24hByKey?.get(aKey);
        const bV = volume24hByKey?.get(bKey);
        if (aV == null && bV == null) return 0;
        if (aV == null) return 1;
        if (bV == null) return -1;
        return sortDir === "asc" ? aV - bV : bV - aV;
      }
      case "volume7d": {
        const aV7 = volume7dByKey?.get(aKey);
        const bV7 = volume7dByKey?.get(bKey);
        if (aV7 == null && bV7 == null) return 0;
        if (aV7 == null) return 1;
        if (bV7 == null) return -1;
        return sortDir === "asc" ? aV7 - bV7 : bV7 - aV7;
      }
      case "totalVolume": {
        const aTV = totalVolumeByKey.get(aKey);
        const bTV = totalVolumeByKey.get(bKey);
        if (aTV == null && bTV == null) return 0;
        if (aTV == null) return 1;
        if (bTV == null) return -1;
        return sortDir === "asc" ? aTV - bTV : bTV - aTV;
      }
    }
    return sortDir === "asc" ? cmp : -cmp;
  });
}

/** Whether any network in the entry list has virtual pools (controls Type column visibility). */
function hasAnyVirtualPools(entries: GlobalPoolEntry[]): boolean {
  return entries.some((e) => e.network.hasVirtualPools);
}

// Compact 2×2 limit heatmap

function LimitHeatmap({
  limits,
  network,
  pool,
}: {
  limits: TradingLimit[];
  network: Network;
  pool: Pool;
}) {
  if (limits.length === 0)
    return <span className="text-slate-600 text-xs">—</span>;

  // Order by the pool's token0/token1 so heatmap rows match the displayed pair
  const sorted = [...limits].sort((a, b) => {
    const aIdx = a.token.toLowerCase() === pool.token0?.toLowerCase() ? 0 : 1;
    const bIdx = b.token.toLowerCase() === pool.token0?.toLowerCase() ? 0 : 1;
    return aIdx - bIdx;
  });
  const rows = sorted.map((tl) => {
    const p0 = Number(tl.limitPressure0); // L0 = 5min
    const p1 = Number(tl.limitPressure1); // L1 = 24h
    const sym = tokenSymbol(network, tl.token);
    return { sym, p0, p1 };
  });

  const tooltip = rows
    .map(
      (r) =>
        `${r.sym}: 5m ${(r.p0 * 100).toFixed(1)}% · 24h ${(r.p1 * 100).toFixed(1)}%`,
    )
    .join("\n");

  return (
    /* eslint-disable jsx-a11y/no-noninteractive-tabindex */
    // Focusable for keyboard tooltip access, not an interactive control
    <span
      className="inline-grid grid-cols-2 gap-px rounded focus:outline-none focus:ring-1 focus:ring-indigo-500"
      tabIndex={0}
      role="group"
      aria-label={tooltip.replace(/\n/g, "; ")}
      title={tooltip}
    >
      {/* eslint-enable jsx-a11y/no-noninteractive-tabindex */}
      {rows.map((r) => (
        <span key={r.sym} className="contents">
          <span
            className={`block w-2 h-2 rounded-sm ${pressureColorClass(r.p0)}`}
            aria-hidden="true"
          />
          <span
            className={`block w-2 h-2 rounded-sm ${pressureColorClass(r.p1)}`}
            aria-hidden="true"
          />
        </span>
      ))}
    </span>
  );
}

// Strategy badges

const STRATEGY_STYLES: Record<
  string,
  { bg: string; text: string; ring: string }
> = {
  Open: {
    bg: "bg-purple-900/60",
    text: "text-purple-300",
    ring: "ring-purple-700/50",
  },
  Reserve: {
    bg: "bg-blue-900/60",
    text: "text-blue-300",
    ring: "ring-blue-700/50",
  },
  CDP: {
    bg: "bg-teal-900/60",
    text: "text-teal-300",
    ring: "ring-teal-700/50",
  },
};

function StrategyBadge({ label }: { label: string }) {
  const style = STRATEGY_STYLES[label] ?? STRATEGY_STYLES.Reserve;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${style.bg} ${style.text} ${style.ring}`}
    >
      {label}
    </span>
  );
}

function poolStrategies(pool: Pool, isOls: boolean): string[] {
  const strategies: string[] = [];
  if (isOls) strategies.push("Open");
  if (pool.rebalancerAddress && pool.rebalancerAddress !== "" && !isOls) {
    strategies.push("Reserve");
  }
  return strategies;
}

// Fee display

function hasFeeData(pool: Pool): boolean {
  if (pool.source?.includes("virtual")) return false;
  if (pool.lpFee == null && pool.protocolFee == null) return false;
  // Sentinel -1 means fees were never successfully fetched
  if ((pool.lpFee ?? -1) < 0 || (pool.protocolFee ?? -1) < 0) return false;
  return true;
}

function formatFee(pool: Pool): string {
  if (!hasFeeData(pool)) return "—";
  const total = (pool.lpFee ?? 0) + (pool.protocolFee ?? 0);
  return `${(total / 100).toFixed(2)}%`;
}

// Table component

interface GlobalPoolsTableProps {
  entries: GlobalPoolEntry[];
  volume24hByKey?: Map<string, number | null | undefined>;
  volume24hLoading?: boolean;
  volume24hError?: boolean;
  volume7dByKey?: Map<string, number | null | undefined>;
  volume7dLoading?: boolean;
  volume7dError?: boolean;
  tvlChangeWoWByKey?: Map<string, number | null>;
  tradingLimitsByKey?: Map<string, TradingLimit[]>;
  olsPoolKeys?: Set<string>;
}

export function GlobalPoolsTable({
  entries,
  volume24hByKey,
  volume24hLoading = false,
  volume24hError = false,
  volume7dByKey,
  volume7dLoading = false,
  volume7dError = false,
  tvlChangeWoWByKey,
  tradingLimitsByKey,
  olsPoolKeys,
}: GlobalPoolsTableProps) {
  const [sortKey, setSortKey] = useState<GlobalSortKey>("tvl");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const tvlByKey = useMemo(
    () =>
      new Map(
        entries.map((e) => [
          globalPoolKey(e),
          poolTvlUSD(e.pool, e.network, e.rates),
        ]),
      ),
    [entries],
  );

  const totalVolumeByKey = useMemo(
    () =>
      new Map(
        entries.map((e) => [
          globalPoolKey(e),
          poolTotalVolumeUSD(e.pool, e.network, e.rates),
        ]),
      ),
    [entries],
  );

  const handleSort = (key: GlobalSortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const sortedEntries = useMemo(
    () =>
      sortGlobalPools(entries, sortKey, sortDir, {
        tvlByKey,
        totalVolumeByKey,
        volume24hByKey,
        volume7dByKey,
        tvlChangeWoWByKey,
      }),
    [
      entries,
      sortKey,
      sortDir,
      tvlByKey,
      totalVolumeByKey,
      volume24hByKey,
      volume7dByKey,
      tvlChangeWoWByKey,
    ],
  );

  const showVirtualPoolSource = hasAnyVirtualPools(entries);
  const showWeekendBanner = isWeekend();

  return (
    <>
      {showWeekendBanner && (
        <div className="mb-4 flex items-start gap-3 rounded-lg border border-slate-700 bg-slate-800/60 px-4 py-3 text-sm text-slate-300">
          <span
            className="text-base leading-5 flex-shrink-0"
            aria-hidden="true"
          >
            🌙
          </span>
          <span>
            <span className="font-medium text-slate-200">
              FX markets are closed this weekend.
            </span>{" "}
            Pool trading is paused until markets reopen (~Sunday 23:00 UTC).
            This is expected — oracle data resumes automatically when markets
            open.
          </span>
        </div>
      )}
      <Table>
        <thead>
          <tr className="border-b border-slate-800 bg-slate-900/50">
            <SortableTh
              sortKey="pool"
              activeSortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
            >
              Pool
            </SortableTh>
            {showVirtualPoolSource && <Th>Type</Th>}
            <SortableTh
              sortKey="health"
              activeSortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
            >
              Health
            </SortableTh>
            <SortableTh
              sortKey="fee"
              activeSortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
              align="right"
              className="hidden sm:table-cell"
            >
              Fee
            </SortableTh>
            <Th className="hidden sm:table-cell">Limits</Th>
            <SortableTh
              sortKey="tvl"
              activeSortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
              className="hidden sm:table-cell"
            >
              TVL
            </SortableTh>
            <SortableTh
              sortKey="tvlChangeWoW"
              activeSortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
              className="hidden sm:table-cell"
            >
              TVL Δ WoW
            </SortableTh>
            <SortableTh
              sortKey="volume24h"
              activeSortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
              className="hidden md:table-cell"
            >
              24h Vol.{" "}
            </SortableTh>
            <SortableTh
              sortKey="volume7d"
              activeSortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
              className="hidden md:table-cell"
            >
              7d Vol.{" "}
            </SortableTh>
            <SortableTh
              sortKey="totalVolume"
              activeSortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
              className="hidden md:table-cell"
            >
              Total Vol.{" "}
            </SortableTh>
            <Th className="hidden lg:table-cell">Strategy</Th>
          </tr>
        </thead>
        <tbody>
          {sortedEntries.map((e) => {
            const { pool: p, network } = e;
            const key = globalPoolKey(e);
            const healthStatus = computeHealthStatus(p, network.chainId);
            const limitStatus = p.limitStatus ?? computeLimitStatus(p);
            const effectiveStatus = worstStatus(healthStatus, limitStatus);
            const tvl = tvlByKey.get(key) ?? 0;
            const vol24h = volume24hByKey?.get(key);
            const vol7d = volume7dByKey?.get(key);
            const totalVol = totalVolumeByKey.get(key);
            const wow = tvlChangeWoWByKey?.get(key);
            const wowColor =
              wow === null
                ? "text-slate-400"
                : wow === undefined
                  ? "text-slate-600"
                  : wow > 0
                    ? "text-emerald-400"
                    : wow < 0
                      ? "text-red-400"
                      : "text-slate-400";
            const poolHref = buildPoolDetailHref(p.id);
            const limits = tradingLimitsByKey?.get(key) ?? [];
            const isOls = olsPoolKeys?.has(key) ?? false;
            const strategies = poolStrategies(p, isOls);
            const isVirtual = p.source?.includes("virtual");
            return (
              <Row key={key}>
                <td className="px-2 sm:px-4 py-2 sm:py-3">
                  <div className="flex items-center gap-2">
                    <ChainIcon network={network} />
                    <Link
                      href={poolHref}
                      className="font-semibold text-sm sm:text-base text-indigo-400 hover:text-indigo-300"
                    >
                      {poolName(network, p.token0, p.token1)}
                    </Link>
                  </div>
                </td>
                {showVirtualPoolSource && (
                  <td className="px-2 sm:px-4 py-2 sm:py-3">
                    {p.source ? (
                      <SourceBadge source={p.source} />
                    ) : (
                      <span className="text-slate-600 text-xs">—</span>
                    )}
                  </td>
                )}
                <td className="px-2 sm:px-4 py-2 sm:py-3">
                  <button
                    type="button"
                    title={combinedTooltip(
                      healthStatus,
                      limitStatus,
                      p,
                      network,
                    )}
                    className="cursor-default appearance-none bg-transparent border-0 p-0"
                  >
                    <HealthBadge status={effectiveStatus} />
                  </button>
                </td>
                <td className="hidden sm:table-cell px-2 sm:px-4 py-2 sm:py-3 text-sm text-slate-200 font-mono text-right">
                  {formatFee(p)}
                </td>
                <td className="hidden sm:table-cell px-2 sm:px-4 py-2 sm:py-3">
                  {isVirtual ? (
                    <span className="text-slate-600 text-xs">—</span>
                  ) : (
                    <LimitHeatmap limits={limits} network={network} pool={p} />
                  )}
                </td>
                <td className="hidden sm:table-cell px-2 sm:px-4 py-2 sm:py-3 text-sm text-slate-200 font-mono">
                  {tvl > 0 ? formatUSD(tvl) : "—"}
                </td>
                <td
                  className={`hidden sm:table-cell px-2 sm:px-4 py-2 sm:py-3 text-sm font-mono ${wowColor}`}
                >
                  {wow === null
                    ? "N/A"
                    : wow === undefined
                      ? "—"
                      : `${wow >= 0 ? "+" : ""}${wow.toFixed(2)}%`}
                </td>
                <td className="hidden md:table-cell px-2 sm:px-4 py-2 sm:py-3 text-sm text-slate-200 font-mono">
                  {volume24hLoading
                    ? "…"
                    : volume24hError
                      ? "N/A"
                      : vol24h === null
                        ? "N/A"
                        : vol24h && vol24h > 0
                          ? formatUSD(vol24h)
                          : "—"}
                </td>
                <td className="hidden md:table-cell px-2 sm:px-4 py-2 sm:py-3 text-sm text-slate-200 font-mono">
                  {volume7dLoading
                    ? "…"
                    : volume7dError
                      ? "N/A"
                      : vol7d === null
                        ? "N/A"
                        : vol7d && vol7d > 0
                          ? formatUSD(vol7d)
                          : "—"}
                </td>
                <td className="hidden md:table-cell px-2 sm:px-4 py-2 sm:py-3 text-sm text-slate-200 font-mono">
                  {totalVol == null ? "—" : formatUSD(totalVol)}
                </td>
                <td className="hidden lg:table-cell px-2 sm:px-4 py-2 sm:py-3">
                  {strategies.length > 0 ? (
                    <div className="flex gap-1">
                      {strategies.map((s) => (
                        <StrategyBadge key={s} label={s} />
                      ))}
                    </div>
                  ) : (
                    <span className="text-slate-600 text-xs">—</span>
                  )}
                </td>
              </Row>
            );
          })}
        </tbody>
      </Table>
    </>
  );
}
