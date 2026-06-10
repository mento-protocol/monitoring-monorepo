"use client";

import dynamic from "next/dynamic";
import { useMemo } from "react";
import { formatUSD } from "@/lib/format";
import type { CdpBorrowingFeeSeriesPoint } from "@/lib/cdp-borrowing-revenue";
import { PLOTLY_BASE_LAYOUT, PLOTLY_CONFIG } from "@/lib/plot";

const PlotSkeleton = () => (
  <div className="h-[200px] animate-pulse rounded bg-slate-800/30" />
);

const Plot = dynamic(() => import("react-plotly.js"), {
  ssr: false,
  loading: PlotSkeleton,
});

interface BorrowingEarnedCollectedChartProps {
  series: CdpBorrowingFeeSeriesPoint[];
  isLoading: boolean;
  hasError: boolean;
  isApproximate: boolean;
  /**
   * True when the indexer schema the series came from predates collected
   * tracking (fee-event reconstruction, or legacy snapshots without the
   * `collected` field) — collected mints are unknown there, so only the
   * earned line renders.
   */
  collectedUnavailable: boolean;
}

type CumulativePoint = {
  timestamp: number;
  earnedUSD: number;
  collectedUSD: number;
};

// Accrual basis vs cash basis, both cumulative: "earned" integrates the
// protocol's share of borrowing fees as they accrue; "collected" sums the
// actual treasury mints. The shaded gap between the lines is the
// outstanding receivable — interest earned on troves that have not been
// touched since (Liquity only mints accrued interest on trove operations).
function buildCumulativeSeries(
  series: ReadonlyArray<CdpBorrowingFeeSeriesPoint>,
): CumulativePoint[] {
  const points: CumulativePoint[] = [];
  let earnedUSD = 0;
  let collectedUSD = 0;
  for (const point of series) {
    earnedUSD += point.totalFeesUSD;
    collectedUSD += point.collectedUSD;
    points.push({ timestamp: point.timestamp, earnedUSD, collectedUSD });
  }
  return points;
}

function buildFigure(
  cumulative: ReadonlyArray<CumulativePoint>,
  showCollected: boolean,
) {
  const xs = cumulative.map((p) => new Date(p.timestamp * 1000).toISOString());
  const collectedTrace = {
    x: xs,
    y: cumulative.map((p) => p.collectedUSD),
    type: "scatter" as const,
    mode: "lines" as const,
    name: "Collected (minted to treasury)",
    line: { color: "#10b981", width: 2 },
    fill: "tozeroy" as const,
    fillcolor: "rgba(16,185,129,0.15)",
    hovertemplate:
      "<b>Collected: $%{y:,.2f}</b><br>%{x|%b %d, %Y}<extra></extra>",
  };
  const earnedTrace = {
    x: xs,
    y: cumulative.map((p) => p.earnedUSD),
    type: "scatter" as const,
    mode: "lines" as const,
    name: "Earned (accrual)",
    line: { color: "#f59e0b", width: 2 },
    // Shade against the collected trace so the band between the two lines
    // reads as the outstanding receivable.
    ...(showCollected
      ? { fill: "tonexty" as const, fillcolor: "rgba(245,158,11,0.10)" }
      : {}),
    hovertemplate: "<b>Earned: $%{y:,.2f}</b><br>%{x|%b %d, %Y}<extra></extra>",
  };
  const traces = showCollected ? [collectedTrace, earnedTrace] : [earnedTrace];

  return {
    traces,
    layout: {
      ...PLOTLY_BASE_LAYOUT,
      font: { ...PLOTLY_BASE_LAYOUT.font, size: 11 },
      xaxis: {
        type: "date" as const,
        showgrid: false,
        showline: false,
        zeroline: false,
        linecolor: "transparent",
        tickcolor: "transparent",
        tickfont: { size: 10, color: "#64748b" },
        nticks: 5,
        tickformat: "%b %d",
        fixedrange: true,
      },
      yaxis: {
        showgrid: false,
        showticklabels: false,
        showline: false,
        zeroline: false,
        fixedrange: true,
      },
      showlegend: true,
      legend: {
        x: 0,
        y: -0.15,
        orientation: "h" as const,
        font: { color: "#94a3b8", size: 10 },
        bgcolor: "transparent",
      },
      margin: { t: 8, r: 8, b: 36, l: 8 },
      autosize: true,
      dragmode: false as const,
      hovermode: "x" as const,
      hoverlabel: {
        bgcolor: "#0f172a",
        bordercolor: "#f59e0b",
        font: { color: "#e2e8f0", size: 12, family: "inherit" },
      },
    },
  };
}

function chartSubtitle(args: {
  hasError: boolean;
  collectedUnavailable: boolean;
  isApproximate: boolean;
}): string {
  if (args.hasError) return "Unable to load borrowing revenue history";
  if (args.collectedUnavailable) {
    return "Collected mints unavailable on this indexer schema";
  }
  if (args.isApproximate) {
    return "Approximate — some history is unpriced or exceeds pagination caps";
  }
  return "Protocol share, cumulative. Gap between lines = accrued but not yet minted to the treasury";
}

export function BorrowingEarnedCollectedChart({
  series,
  isLoading,
  hasError,
  isApproximate,
  collectedUnavailable,
}: BorrowingEarnedCollectedChartProps) {
  const cumulative = useMemo(() => buildCumulativeSeries(series), [series]);
  // ES2017-safe (no Array.prototype.at): client-shipped code, see AGENTS.md.
  const last =
    cumulative.length > 0 ? cumulative[cumulative.length - 1] : undefined;
  const showCollected = !collectedUnavailable;
  const figure = useMemo(
    () => buildFigure(cumulative, showCollected),
    [cumulative, showCollected],
  );
  const showEmptyState =
    !isLoading && (hasError || cumulative.length === 0 || !last);

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/60 px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-sm text-slate-400">
            Borrowing Revenue — Earned vs Collected
          </p>
          <p className="mt-1 font-mono text-sm">
            {isLoading ? (
              <span className="inline-block h-4 w-40 animate-pulse rounded bg-slate-800/60 align-middle" />
            ) : last ? (
              <>
                <span className="text-amber-400">
                  {formatUSD(last.earnedUSD)} earned
                </span>
                {showCollected && (
                  <>
                    <span className="text-slate-600"> · </span>
                    <span className="text-emerald-400">
                      {formatUSD(last.collectedUSD)} collected
                    </span>
                  </>
                )}
              </>
            ) : (
              <span className="text-slate-500">—</span>
            )}
          </p>
        </div>
      </div>
      <div className="mt-3">
        {isLoading ? (
          <PlotSkeleton />
        ) : showEmptyState ? (
          <div className="flex h-[200px] items-center justify-center text-sm text-slate-500">
            {hasError
              ? "Unable to load borrowing revenue history"
              : "No borrowing revenue recorded yet"}
          </div>
        ) : (
          <Plot
            data={figure.traces}
            layout={figure.layout}
            config={PLOTLY_CONFIG}
            useResizeHandler
            style={{ width: "100%", height: "200px" }}
          />
        )}
      </div>
      <p className="mt-2 text-xs text-slate-500">
        {chartSubtitle({ hasError, collectedUnavailable, isApproximate })}
      </p>
    </section>
  );
}
