import Link from "next/link";
import type { ReactNode } from "react";
import { formatUSD } from "@/lib/format";
import { poolName } from "@/lib/tokens";
import { type Pool } from "@/lib/types";
import type { Network } from "@/lib/networks";
import { Row } from "@/components/table";
import { SourceBadge, HealthBadge } from "@/components/badges";
import { ChainIcon } from "@/components/chain-icon";
import {
  computeEffectiveStatus,
  computeHealthStatus,
  computePoolUptimePct,
  resolveLimitStatus,
  uptimeColorClass,
} from "@/lib/health";
import { combinedTooltip } from "@/lib/pool-table-utils";
import { buildPoolDetailHref } from "@/lib/routing";
import {
  formatFee,
  poolStrategies,
  type PoolStrategyLabel,
} from "./formatting";
import { globalPoolKey, type GlobalPoolEntry } from "./sort";
import { ReservesCell } from "./reserves-cell";
import { StrategyBadge } from "./strategy-badge";

interface PoolRowProps {
  entry: GlobalPoolEntry;
  showVirtualPoolSource: boolean;
  tvlByKey: Map<string, number | null>;
  volume24hByKey?: Map<string, number | null | undefined> | undefined;
  volume24hLoading: boolean;
  volume24hError: boolean;
  volume7dByKey?: Map<string, number | null | undefined> | undefined;
  volume7dLoading: boolean;
  volume7dError: boolean;
  totalVolumeByKey: Map<string, number | null>;
  tvlChangeWoWByKey?: Map<string, number | null> | undefined;
  olsPoolKeys?: Set<string> | undefined;
  cdpPoolKeys?: Set<string> | undefined;
  reservePoolKeys?: Set<string> | undefined;
}

export function PoolRow({
  entry,
  showVirtualPoolSource,
  tvlByKey,
  volume24hByKey,
  volume24hLoading,
  volume24hError,
  volume7dByKey,
  volume7dLoading,
  volume7dError,
  totalVolumeByKey,
  tvlChangeWoWByKey,
  olsPoolKeys,
  cdpPoolKeys,
  reservePoolKeys,
}: PoolRowProps) {
  const { pool, network } = entry;
  const key = globalPoolKey(entry);
  // Use `computeEffectiveStatus` (not `worstStatus(computeHealthStatus, ...)`
  // directly) so the `hasHealthData=false → "N/A"` half-short-circuit applies
  // here too. Without this, no-data pools paired with healthy limits would
  // resolve to OK via STATUS_RANK (codex P2 PR #370 #3214748745).
  const healthStatus = computeHealthStatus(pool, network.chainId);
  const limitStatus = resolveLimitStatus(pool);
  const effectiveStatus = computeEffectiveStatus(pool, network.chainId);
  const healthDetails = combinedTooltip(
    healthStatus,
    limitStatus,
    pool,
    network,
  );
  const strategies = poolStrategies(
    olsPoolKeys?.has(key) ?? false,
    cdpPoolKeys?.has(key) ?? false,
    reservePoolKeys?.has(key) ?? false,
  );

  return (
    <Row>
      <NameCell pool={pool} network={network} />
      {showVirtualPoolSource && <SourceCell pool={pool} />}
      <HealthCell status={effectiveStatus} details={healthDetails} />
      <UptimeCell pool={pool} />
      <Cell className="hidden sm:table-cell">
        <ReservesCell pool={pool} network={network} rates={entry.rates} />
      </Cell>
      <Cell className="hidden sm:table-cell text-sm text-slate-200 font-mono text-right">
        {formatFee(pool)}
      </Cell>
      <TvlCell
        tvl={tvlByKey.get(key) ?? null}
        wow={tvlChangeWoWByKey?.get(key)}
      />
      <VolumeSummaryCell
        volume24hLoading={volume24hLoading}
        volume24hError={volume24hError}
        volume24h={volume24hByKey?.get(key)}
        volume7dLoading={volume7dLoading}
        volume7dError={volume7dError}
        volume7d={volume7dByKey?.get(key)}
      />
      <Cell className="hidden md:table-cell text-sm text-slate-200 font-mono text-right">
        {(() => {
          const totalVol = totalVolumeByKey.get(key);
          return totalVol == null ? "—" : formatUSD(totalVol);
        })()}
      </Cell>
      <StrategyCell strategies={strategies} />
    </Row>
  );
}

function Cell({
  className,
  children,
}: {
  className: string;
  children: ReactNode;
}) {
  return (
    <td className={`px-2 sm:px-3 py-2 sm:py-3 ${className}`}>{children}</td>
  );
}

function NameCell({ pool, network }: { pool: Pool; network: Network }) {
  return (
    <Cell className="">
      <div className="flex items-center gap-2">
        <ChainIcon network={network} />
        <Link
          href={buildPoolDetailHref(pool.id)}
          className="font-semibold text-sm sm:text-base text-indigo-400 hover:text-indigo-300"
        >
          {poolName(network, pool.token0, pool.token1)}
        </Link>
      </div>
    </Cell>
  );
}

function SourceCell({ pool }: { pool: Pool }) {
  if (!pool.source) {
    return (
      <Cell className="">
        <span className="text-slate-600 text-xs">—</span>
      </Cell>
    );
  }
  return (
    <Cell className="">
      <SourceBadge
        source={pool.source}
        wrappedExchangeId={pool.wrappedExchangeId}
      />
    </Cell>
  );
}

function HealthCell({ status, details }: { status: string; details: string }) {
  return (
    <Cell className="">
      <span title={details} className="inline-flex cursor-help">
        <HealthBadge status={status} />
        <span className="sr-only">{details}</span>
      </span>
    </Cell>
  );
}

function UptimeCell({ pool }: { pool: Pool }) {
  const pct = computePoolUptimePct(pool);
  const className = "hidden sm:table-cell text-sm font-mono text-right";
  if (pct == null) {
    return (
      <Cell className={className}>
        <span className="text-slate-600">—</span>
      </Cell>
    );
  }
  const breachCount = pool.breachCount ?? 0;
  const breachLabel = breachCount === 1 ? "breach" : "breaches";
  return (
    <Cell className={className}>
      <span
        className={uptimeColorClass(pct)}
        title={`${pct.toFixed(3)}% uptime (oracle freshness + price within tolerance) · ${breachCount} lifetime price-deviation ${breachLabel}`}
      >
        {pct.toFixed(2)}%
      </span>
    </Cell>
  );
}

function TvlCell({
  tvl,
  wow,
}: {
  tvl: number | null;
  wow: number | null | undefined;
}) {
  const color =
    wow === null
      ? "text-slate-400"
      : wow === undefined
        ? "text-slate-600"
        : wow > 0
          ? "text-emerald-400"
          : wow < 0
            ? "text-red-400"
            : "text-slate-400";
  const label =
    wow === null
      ? "N/A"
      : wow === undefined
        ? "—"
        : `${wow >= 0 ? "+" : ""}${wow.toFixed(2)}%`;
  return (
    <Cell className="hidden sm:table-cell text-sm font-mono text-right">
      <div className="flex flex-col items-end leading-tight">
        <span className="text-slate-200">
          {tvl !== null && tvl > 0 ? formatUSD(tvl) : "—"}
        </span>
        <span className={`mt-0.5 text-[11px] ${color}`} title="TVL Δ WoW">
          <span className="sr-only">Week-over-week TVL change: </span>
          {label}
        </span>
      </div>
    </Cell>
  );
}

function volumeLabel({
  loading,
  error,
  value,
}: {
  loading: boolean;
  error: boolean;
  value: number | null | undefined;
}): string {
  let label: string;
  if (loading) label = "…";
  else if (error) label = "N/A";
  else if (value === null) label = "N/A";
  else if (value && value > 0) label = formatUSD(value);
  else label = "—";
  return label;
}

function VolumeSummaryCell({
  volume24hLoading,
  volume24hError,
  volume24h,
  volume7dLoading,
  volume7dError,
  volume7d,
}: {
  volume24hLoading: boolean;
  volume24hError: boolean;
  volume24h: number | null | undefined;
  volume7dLoading: boolean;
  volume7dError: boolean;
  volume7d: number | null | undefined;
}) {
  const volume24hLabel = volumeLabel({
    loading: volume24hLoading,
    error: volume24hError,
    value: volume24h,
  });
  const volume7dLabel = volumeLabel({
    loading: volume7dLoading,
    error: volume7dError,
    value: volume7d,
  });

  return (
    <Cell className="hidden md:table-cell text-sm font-mono text-right">
      <div
        className="flex flex-col items-end leading-tight"
        title={`7d volume: ${volume7dLabel}\n24h volume: ${volume24hLabel}`}
      >
        <span className="text-slate-200">
          <span className="sr-only">7-day volume: </span>
          {volume7dLabel}
        </span>
        <span className="mt-0.5 text-[11px] text-slate-500">
          <span className="sr-only">24-hour volume: </span>
          24h {volume24hLabel}
        </span>
      </div>
    </Cell>
  );
}

function StrategyCell({ strategies }: { strategies: PoolStrategyLabel[] }) {
  return (
    <Cell className="hidden xl:table-cell">
      {strategies.length > 0 ? (
        <div className="flex gap-1">
          {strategies.map((s) => (
            <StrategyBadge key={s} label={s} />
          ))}
        </div>
      ) : (
        <span className="text-slate-600 text-xs">—</span>
      )}
    </Cell>
  );
}
