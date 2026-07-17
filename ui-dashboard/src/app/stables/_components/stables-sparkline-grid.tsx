"use client";

import { useMemo } from "react";
import { formatUSD } from "@/lib/format";
import { displayLabel } from "@/lib/stables";
import type { OracleRateMap } from "@/lib/tokens";
import { tokenColorForSource } from "@/lib/token-colors";
import {
  buildTokenUsdTimeSeries,
  computeChartStartSeconds,
  custodySnapshotsAlignedToSupplyRows,
  custodyTokenKey,
  groupCustodySnapshotsByToken,
  groupSnapshotsByTokenSource,
  rollupByToken,
  unionSnapshotsWithLatest,
} from "../_lib/aggregate";
import { sparklinePoints } from "../_lib/sparkline";
import type {
  StableSupplyDailySnapshot,
  StableTokenCustodyDailySnapshot,
  TokenAgg,
} from "../_lib/types";

// Real `SparklineCard` geometry, shared with its skeleton below so the two
// can't silently drift apart (~142px: p-4 padding + gap-2 + label row +
// value row + 40px sparkline block).
const SPARKLINE_CARD_CLASS =
  "rounded-lg border border-slate-800 bg-slate-900/60 p-4 flex flex-col gap-2";
const SPARKLINE_CARD_HEIGHT_PX = 142;
const SPARKLINE_GRID_GAP_PX = 12; // gap-3
const SPARKLINE_GRID_COLS = 4; // xl:grid-cols-4 — the audited 1440px viewport

// One skeleton card per rendered `(chainId, tokenAddress, source)` supply
// row. That count is runtime-determined (`rollupByToken` over live snapshot
// data) and NOT statically derivable in this package: the authoritative
// registry is the indexer's STABLES set
// (indexer-envio/src/handlers/stables/config.ts), a separate deploy artifact
// the dashboard has no dependency edge to, and `@mento-protocol/config` only
// exposes pool contracts, not per-source stable-supply rows. 22 matches the
// configured post-Polygon card count (16 RESERVE + 6 V3_LIQUITY, verified
// 2026-07-17 against the indexer registry); the registry's V3 hub USDm carries
// no supply rows yet. A ±1-row drift as tokens launch is acceptable
// (it beats the ~700px jump this skeleton removes) — re-count and bump when a
// launch changes the row total.
const SPARKLINE_SKELETON_CARDS = 22;
const SPARKLINE_GRID_ROWS = Math.ceil(
  SPARKLINE_SKELETON_CARDS / SPARKLINE_GRID_COLS,
);
// Reserved height for the 4-col desktop layout. Narrower breakpoints need
// MORE height for the same card count, so this floor never clips content —
// it only stops the loading ↔ empty/error/loaded-with-data swap from
// visibly resizing at the audited (1440×900) viewport.
const SPARKLINE_GRID_RESERVED_HEIGHT_PX =
  SPARKLINE_GRID_ROWS * SPARKLINE_CARD_HEIGHT_PX +
  (SPARKLINE_GRID_ROWS - 1) * SPARKLINE_GRID_GAP_PX;

/**
 * Per-token sparkline grid — overview-card layer below the aggregate
 * supply chart. One card per `(tokenAddress, source)` row from
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
    const mergedCustody = custodySnapshotsAlignedToSupplyRows(
      merged,
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
        custodyByToken.get(custodyTokenKey(agg.chainId, agg.tokenAddress)) ??
        [];
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
      <section
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3"
        style={{ minHeight: SPARKLINE_GRID_RESERVED_HEIGHT_PX }}
        role="status"
        aria-live="polite"
        aria-label="Loading per-token detail"
      >
        {Array.from({ length: SPARKLINE_SKELETON_CARDS }, (_, i) => (
          // react-doctor-disable-next-line react-doctor/no-array-index-as-key
          <SparklineCardSkeleton key={`sparkline-skel-${i}`} />
        ))}
        <span className="sr-only">Loading per-token detail…</span>
      </section>
    );
  }
  if (hasError) {
    return (
      <div style={{ minHeight: SPARKLINE_GRID_RESERVED_HEIGHT_PX }}>
        <section
          className="rounded-lg border border-slate-800 bg-slate-900/60 p-5"
          role="alert"
        >
          <p className="text-sm text-rose-400">
            Failed to load per-token data.
          </p>
        </section>
      </div>
    );
  }
  if (cards.length === 0) {
    return (
      <div style={{ minHeight: SPARKLINE_GRID_RESERVED_HEIGHT_PX }}>
        <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
          <p className="text-sm text-slate-500">No per-token data yet.</p>
        </section>
      </div>
    );
  }

  return (
    <section
      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3"
      style={{ minHeight: SPARKLINE_GRID_RESERVED_HEIGHT_PX }}
      aria-label="Per-token supply detail"
    >
      {cards.map(({ agg, sparkline }) => (
        <SparklineCard key={agg.key} agg={agg} sparkline={sparkline} />
      ))}
    </section>
  );
}

function SparklineCardSkeleton(): React.JSX.Element {
  return (
    <article className={SPARKLINE_CARD_CLASS} aria-hidden="true">
      <div className="flex items-baseline justify-between gap-2">
        <div className="h-5 w-28 animate-pulse rounded bg-slate-800/50" />
        <div className="h-4 w-10 animate-pulse rounded bg-slate-800/50" />
      </div>
      <div className="h-7 w-24 animate-pulse rounded bg-slate-800/50" />
      <div className="mt-1 h-[40px] w-full animate-pulse rounded bg-slate-800/50" />
    </article>
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
    <article className={SPARKLINE_CARD_CLASS}>
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
