import Link from "next/link";
import type { ReactNode } from "react";
import { formatUSD } from "@/lib/format";
import { poolName } from "@/lib/tokens";
import { type Pool } from "@/lib/types";
import { type Network } from "@/lib/networks";
import { preloadPoolDetail } from "@/lib/pool-detail-preload";
import { Row } from "@/components/table";
import { SourceBadge, HealthBadge } from "@/components/badges";
import { ChainIcon } from "@/components/chain-icon";
import {
  computeEffectiveStatus,
  computeHealthStatus,
  computePoolUptimePct,
  oracleFreshnessTimestamp,
  resolveLimitStatus,
  uptimeColorClass,
  uptimeTierGlyph,
} from "@/lib/health";
import { combinedTooltip } from "@/lib/pool-table-utils";
import { Tooltip } from "@/components/tooltip";
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
  nowSeconds: number | null;
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
  nowSeconds,
  olsPoolKeys,
  cdpPoolKeys,
  reservePoolKeys,
}: PoolRowProps) {
  const { pool, network } = entry;
  const key = globalPoolKey(entry);
  const statusNowSeconds = nowSeconds ?? oracleFreshnessTimestamp(pool);
  // Use `computeEffectiveStatus` (not `worstStatus(computeHealthStatus, ...)`
  // directly) so the `hasHealthData=false → "N/A"` half-short-circuit applies
  // here too. Without this, no-data pools paired with healthy limits would
  // resolve to OK via STATUS_RANK (codex P2 PR #370 #3214748745).
  const healthStatus = computeHealthStatus(
    pool,
    network.chainId,
    statusNowSeconds,
  );
  const limitStatus = resolveLimitStatus(pool);
  const effectiveStatus = computeEffectiveStatus(
    pool,
    network.chainId,
    statusNowSeconds,
  );
  // Badges need a stable non-null clock during SSR to avoid oracle-staleness
  // hydration flips; tooltips receive raw null so they omit wall-clock durations.
  const healthDetails = combinedTooltip(
    healthStatus,
    limitStatus,
    pool,
    network,
    nowSeconds,
  );
  const strategies = poolStrategies(
    olsPoolKeys?.has(key) ?? false,
    cdpPoolKeys?.has(key) ?? false,
    reservePoolKeys?.has(key) ?? false,
  );

  return (
    <Row>
      <NameCell
        pool={pool}
        network={network}
        onPrefetch={() => preloadPoolDetail(network, pool.id)}
      />
      {showVirtualPoolSource && <SourceCell pool={pool} />}
      <HealthCell status={effectiveStatus} details={healthDetails} />
      <UptimeCell pool={pool} nowSeconds={statusNowSeconds} />
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
      <VolumeCell
        className="hidden md:table-cell text-sm text-slate-200 font-mono text-right"
        loading={volume7dLoading}
        error={volume7dError}
        value={volume7dByKey?.get(key)}
      />
      <VolumeCell
        className="hidden xl:table-cell text-sm text-slate-200 font-mono text-right"
        loading={volume24hLoading}
        error={volume24hError}
        value={volume24hByKey?.get(key)}
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

function NameCell({
  pool,
  network,
  onPrefetch,
}: {
  pool: Pool;
  network: Network;
  onPrefetch: () => void;
}) {
  return (
    <Cell className="">
      <div className="flex items-center gap-2">
        <ChainIcon network={network} />
        <Link
          href={buildPoolDetailHref(pool.id)}
          className="font-semibold text-sm sm:text-base text-indigo-400 hover:text-indigo-300"
          onFocus={onPrefetch}
          onMouseEnter={onPrefetch}
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
      <Tooltip content={details} label={`Pool health ${status}: ${details}`}>
        <HealthBadge status={status} />
      </Tooltip>
    </Cell>
  );
}

function UptimeCell({ pool, nowSeconds }: { pool: Pool; nowSeconds: number }) {
  const pct = computePoolUptimePct(pool, nowSeconds);
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
  const tier = uptimeTierGlyph(pct);
  const diagnostic = `${pct.toFixed(3)}% uptime (oracle freshness + price within tolerance) · ${breachCount} lifetime price-deviation ${breachLabel}`;
  return (
    <Cell className={className}>
      {/* Diagnostic moved off the native `title` into the accessible Tooltip
          (keyboard- + tap-reachable). Severity is encoded by a shape-distinct
          glyph (grayscale/deuteranopia safe) with an sr-only tier label; the
          number stays a neutral non-alarm color so it can't contradict the
          row's Health badge. */}
      <Tooltip content={diagnostic} align="right">
        <span className="inline-flex items-center gap-1">
          {tier && (
            <span aria-hidden="true" className="text-[10px] text-slate-400">
              {tier.glyph}
            </span>
          )}
          <span className={uptimeColorClass(pct)}>{pct.toFixed(2)}%</span>
          {tier && <span className="sr-only">{tier.label}</span>}
        </span>
      </Tooltip>
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

function VolumeCell({
  className,
  loading,
  error,
  value,
}: {
  className: string;
  loading: boolean;
  error: boolean;
  value: number | null | undefined;
}) {
  return (
    <Cell className={className}>{volumeLabel({ loading, error, value })}</Cell>
  );
}

function StrategyCell({ strategies }: { strategies: PoolStrategyLabel[] }) {
  return (
    <Cell className="hidden 2xl:table-cell">
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
