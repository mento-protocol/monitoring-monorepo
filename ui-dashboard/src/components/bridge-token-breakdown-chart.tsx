"use client";

import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { formatUSD } from "@/lib/format";
import {
  PLOTLY_BASE_LAYOUT,
  PLOTLY_CONFIG,
  ROW_CHART_HEIGHT_PX,
} from "@/lib/plot";
import { buildTokenBreakdown } from "@/lib/bridge-flows/snapshots";
import { RANGES, rangeKeyToDays, type RangeKey } from "@/lib/time-series";
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
    <div
      className="animate-pulse rounded bg-slate-800/30"
      style={{ height: ROW_CHART_HEIGHT_PX }}
    />
  ),
});

interface BridgeTokenBreakdownChartProps {
  snapshots: BridgeDailySnapshot[];
  rates: OracleRateMap;
  isLoading: boolean;
  hasError: boolean;
  /** Initial range tab; defaults to 30d to match the pre-toggle behavior. */
  defaultRange?: RangeKey;
}

export function BridgeTokenBreakdownChart({
  snapshots,
  rates,
  isLoading,
  hasError,
  defaultRange = "30d",
}: BridgeTokenBreakdownChartProps) {
  const [range, setRange] = useState<RangeKey>(defaultRange);
  // Range independent from BridgeVolumeChart — the sibling card uses its own
  // local state. The tile label underneath shows the active window for
  // context; a shared `rangeKeyToDays(range)` keeps the tab widget and the
  // data-layer window definition in lockstep.
  const windowDays = rangeKeyToDays(range);

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
      height: ROW_CHART_HEIGHT_PX,
      autosize: true,
    }),
    [],
  );

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-5 sm:p-6">
      <div className="mb-4 flex items-start justify-between gap-4">
        <h3 className="text-sm text-slate-400">Volume by token</h3>
        <div
          role="group"
          aria-label="Volume by token time range"
          className="flex gap-0.5 rounded-md bg-slate-800/50 p-0.5"
        >
          {RANGES.map((item) => {
            const active = range === item.key;
            return (
              <button
                key={item.key}
                type="button"
                aria-pressed={active}
                onClick={() => setRange(item.key)}
                className={
                  "rounded px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 " +
                  (active
                    ? "bg-slate-700 text-white shadow-sm"
                    : "text-slate-400 hover:text-slate-200")
                }
              >
                {item.label}
              </button>
            );
          })}
        </div>
      </div>
      {hasError ? (
        <p className="text-sm text-slate-500">
          Unable to load token breakdown.
        </p>
      ) : isLoading ? (
        <div
          className="animate-pulse rounded bg-slate-800/30"
          style={{ height: ROW_CHART_HEIGHT_PX }}
        />
      ) : !hasData ? (
        <div
          className="flex items-center justify-center text-sm text-slate-500"
          style={{ height: ROW_CHART_HEIGHT_PX }}
        >
          No priced volume in the selected window.
        </div>
      ) : (
        <>
          <Plot
            data={[trace]}
            layout={layout}
            config={PLOTLY_CONFIG}
            style={{ width: "100%", height: ROW_CHART_HEIGHT_PX }}
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
