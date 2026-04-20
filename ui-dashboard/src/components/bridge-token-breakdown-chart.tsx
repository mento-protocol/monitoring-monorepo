"use client";

import dynamic from "next/dynamic";
import { useMemo } from "react";
import { formatUSD } from "@/lib/format";
import { PLOTLY_BASE_LAYOUT, PLOTLY_CONFIG } from "@/lib/plot";
import { buildTokenBreakdown } from "@/lib/bridge-flows/snapshots";
import type { OracleRateMap } from "@/lib/tokens";
import type { BridgeDailySnapshot } from "@/lib/types";

// Reuse the pool-concentration palette so color choices stay consistent
// across the dashboard without introducing a parallel color source.
const PIE_COLORS = [
  "#6366f1",
  "#a78bfa",
  "#34d399",
  "#fbbf24",
  "#f87171",
  "#38bdf8",
  "#fb923c",
  "#e879f9",
  "#4ade80",
  "#f472b6",
];

const Plot = dynamic(() => import("react-plotly.js"), {
  ssr: false,
  loading: () => (
    <div className="h-[240px] animate-pulse rounded bg-slate-800/30" />
  ),
});

interface BridgeTokenBreakdownChartProps {
  snapshots: BridgeDailySnapshot[];
  rates: OracleRateMap;
  isLoading: boolean;
  hasError: boolean;
  /** Rolling window in days; defaults to 30. */
  windowDays?: number;
}

export function BridgeTokenBreakdownChart({
  snapshots,
  rates,
  isLoading,
  hasError,
  windowDays = 30,
}: BridgeTokenBreakdownChartProps) {
  const slices = useMemo(
    () => buildTokenBreakdown(snapshots, rates, windowDays),
    [snapshots, rates, windowDays],
  );

  const total = slices.reduce((sum, s) => sum + s.usd, 0);
  const hasData = total > 0;

  const trace = useMemo(
    () => ({
      type: "pie" as const,
      hole: 0.5,
      labels: slices.map((s) => s.symbol),
      values: slices.map((s) => s.usd),
      customdata: slices.map((s) => formatUSD(s.usd)),
      hovertemplate:
        "<b>%{label}</b><br>%{customdata}<br>%{percent}<extra></extra>",
      textinfo: "percent" as const,
      sort: false,
      direction: "clockwise" as const,
      marker: {
        colors: PIE_COLORS.slice(0, slices.length),
        line: { color: "#0f172a", width: 2 },
      },
    }),
    [slices],
  );

  const layout = useMemo(
    () => ({
      ...PLOTLY_BASE_LAYOUT,
      margin: { t: 8, r: 8, b: 8, l: 8 },
      showlegend: false,
      height: 240,
      autosize: true,
    }),
    [],
  );

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-5 sm:p-6">
      <div className="mb-4 flex items-baseline justify-between">
        <h3 className="text-sm text-slate-400">Volume by token</h3>
        <span className="text-[10px] uppercase tracking-wider text-slate-500">
          {windowDays}d
        </span>
      </div>
      {hasError ? (
        <p className="text-sm text-slate-500">
          Unable to load token breakdown.
        </p>
      ) : isLoading ? (
        <div className="h-[240px] animate-pulse rounded bg-slate-800/30" />
      ) : !hasData ? (
        <div className="flex h-[240px] items-center justify-center text-sm text-slate-500">
          No priced volume in the selected window.
        </div>
      ) : (
        <>
          <Plot
            data={[trace]}
            layout={layout}
            config={PLOTLY_CONFIG}
            style={{ width: "100%", height: 240 }}
            useResizeHandler
          />
          <ul className="mt-3 grid gap-1.5 text-xs">
            {slices.map((s, i) => (
              <li
                key={s.symbol}
                className="flex items-center gap-2 text-slate-300"
              >
                <span
                  aria-hidden="true"
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: PIE_COLORS[i % PIE_COLORS.length] }}
                />
                <span className="font-mono">{s.symbol}</span>
                <span className="ml-auto font-mono text-slate-500">
                  {formatUSD(s.usd)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
