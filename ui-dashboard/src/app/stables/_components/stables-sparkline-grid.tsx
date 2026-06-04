"use client";

import { useMemo } from "react";
import { formatUSD } from "@/lib/format";
import { displayLabel } from "@/lib/stables";
import type { OracleRateMap } from "@/lib/tokens";
import { tokenColorForSource } from "@/lib/token-colors";
import {
  buildTokenUsdTimeSeries,
  computeChartStartSeconds,
  groupCustodySnapshotsByToken,
  groupSnapshotsByTokenSource,
  rollupByToken,
  unionCustodySnapshotsWithLatest,
  unionSnapshotsWithLatest,
} from "../_lib/aggregate";
import { sparklinePoints } from "../_lib/sparkline";
import type {
  StableSupplyDailySnapshot,
  StableTokenCustodyDailySnapshot,
  TokenAgg,
} from "../_lib/types";

/**
 * Per-token sparkline grid — overview-card layer between the KPI strip
 * and the hero chart. One card per `(tokenAddress, source)` row from
 * `rollupByToken`, showing current USD supply, 7d change, and a small
 * inline SVG sparkline of the last 30 days normalized to USD.
 *
 * Cards render even for tokens without an oracle rate (the sparkline
 * just hides — the USD value tile shows N/A). Sort by latest USD value
 * descending so the biggest stables anchor the top-left.
 */
type Props = {
  snapshots: ReadonlyArray<StableSupplyDailySnapshot>;
  latestPerToken: ReadonlyArray<StableSupplyDailySnapshot>;
  custodySnapshots: ReadonlyArray<StableTokenCustodyDailySnapshot>;
  latestCustodyPerToken: ReadonlyArray<StableTokenCustodyDailySnapshot>;
  rates: OracleRateMap;
  isLoading: boolean;
  hasError: boolean;
};

export function StablesSparklineGrid({
  snapshots,
  latestPerToken,
  custodySnapshots,
  latestCustodyPerToken,
  rates,
  isLoading,
  hasError,
}: Props): React.JSX.Element {
  // Merge snapshots + latestPerToken so tokens whose history is older than
  // the 1000-row page still appear and same-day current state overrides sparse
  // daily rows (same baseline-floor pattern as the hero chart).
  const cards = useMemo(() => {
    if (snapshots.length === 0 && latestPerToken.length === 0) return [];
    const merged = unionSnapshotsWithLatest(snapshots, latestPerToken);
    const mergedCustody = unionCustodySnapshotsWithLatest(
      custodySnapshots,
      latestCustodyPerToken,
    );

    const rollup = rollupByToken(merged, rates, undefined, mergedCustody);
    const grouped = groupSnapshotsByTokenSource(merged);
    const custodyByToken = groupCustodySnapshotsByToken(mergedCustody);
    // Sparkline window: 30 days. Use the same caller-side start helper
    // so the per-card sparkline x-axis aligns with the hero chart's.
    const startTs = computeChartStartSeconds(grouped, "30d");

    const out: Array<{ agg: TokenAgg; sparkline: number[] }> = [];
    for (const agg of rollup.values()) {
      const rows = grouped.get(agg.key) ?? [];
      const custodyRows =
        custodyByToken.get(`${agg.chainId}|${agg.tokenAddress}`) ?? [];
      const series = buildTokenUsdTimeSeries(
        rows,
        rates,
        startTs,
        undefined,
        custodyRows,
      );
      out.push({ agg, sparkline: series.map((p) => p.valueUsd) });
    }
    // Largest USD supply first; tokens without USD (rate=null) sink.
    out.sort((a, b) => {
      const av = a.agg.totalSupplyUsdLatest ?? -1;
      const bv = b.agg.totalSupplyUsdLatest ?? -1;
      return bv - av;
    });
    return out;
  }, [
    snapshots,
    latestPerToken,
    custodySnapshots,
    latestCustodyPerToken,
    rates,
  ]);

  if (isLoading) {
    return (
      <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
        <p className="text-sm text-slate-500" role="status">
          Loading per-token detail…
        </p>
      </section>
    );
  }
  if (hasError) {
    return (
      <section
        className="rounded-lg border border-slate-800 bg-slate-900/60 p-5"
        role="alert"
      >
        <p className="text-sm text-rose-400">Failed to load per-token data.</p>
      </section>
    );
  }
  if (cards.length === 0) {
    return (
      <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
        <p className="text-sm text-slate-500">No per-token data yet.</p>
      </section>
    );
  }

  return (
    <section
      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3"
      aria-label="Per-token supply detail"
    >
      {cards.map(({ agg, sparkline }) => (
        <SparklineCard key={agg.key} agg={agg} sparkline={sparkline} />
      ))}
    </section>
  );
}

function SparklineCard({
  agg,
  sparkline,
}: {
  agg: TokenAgg;
  sparkline: number[];
}): React.JSX.Element {
  const label = `${displayLabel(agg.tokenSymbol, agg.source)} on ${chainLabel(agg.chainId)}`;
  const color = tokenColorForSource(agg.tokenSymbol, agg.source);
  const usd =
    agg.totalSupplyUsdLatest != null
      ? formatUSD(agg.totalSupplyUsdLatest)
      : "—";
  const change7d = agg.change7dPct;
  const changeText =
    change7d == null
      ? "—"
      : `${change7d >= 0 ? "+" : ""}${change7d.toFixed(2)}%`;
  const changeColor =
    change7d == null
      ? "text-slate-500"
      : change7d >= 0
        ? "text-emerald-400"
        : "text-rose-400";
  // Differentiate the two empty-sparkline cases for the visible
  // placeholder + the SVG accessible name:
  // - `totalSupplyUsdLatest == null` → no oracle rate (USD-priced
  //   sparkline can't be drawn even with full history)
  // - else `sparkline.length < 2` → not enough snapshots yet
  // Operator triage needs to see WHICH signal is missing, not a
  // generic "no data" placeholder.
  const sparklineMissingReason: "no-rate" | "short-history" | null =
    sparkline.length >= 2
      ? null
      : agg.totalSupplyUsdLatest == null
        ? "no-rate"
        : "short-history";

  return (
    <article className="rounded-lg border border-slate-800 bg-slate-900/60 p-4 flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-slate-100">{label}</span>
        <span className={`text-xs font-mono ${changeColor}`}>{changeText}</span>
      </div>
      <div className="text-xl font-semibold text-slate-100 font-mono">
        {usd}
      </div>
      <div className="mt-1">
        <MiniSparkline
          series={sparkline}
          color={color}
          label={label}
          missingReason={sparklineMissingReason}
        />
      </div>
    </article>
  );
}

function chainLabel(chainId: number): string {
  if (chainId === 143) return "Monad";
  if (chainId === 42220) return "Celo";
  return `Chain ${chainId}`;
}

function MiniSparkline({
  series,
  color,
  label,
  missingReason,
}: {
  series: ReadonlyArray<number>;
  color: string;
  label: string;
  missingReason: "no-rate" | "short-history" | null;
}): React.JSX.Element {
  if (series.length < 2) {
    // Visible text labels the empty placeholder. Screen readers get
    // the same string via the actual text content — `aria-label` on a
    // plain `<div>` is a naming-prohibited pattern that NVDA and
    // VoiceOver may drop silently.
    const message =
      missingReason === "no-rate" ? "No USD rate" : "Building history…";
    return (
      <div className="h-[40px] w-full rounded bg-slate-800/40 flex items-center justify-center">
        <span className="text-[10px] text-slate-500">{message}</span>
      </div>
    );
  }
  const w = 240;
  const h = 40;
  const pad = 2;
  const points = sparklinePoints(series, w, h, pad);
  return (
    <svg
      width="100%"
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${label} 30-day supply sparkline`}
    >
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
