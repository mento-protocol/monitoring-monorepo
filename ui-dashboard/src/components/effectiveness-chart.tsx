"use client";

import dynamic from "next/dynamic";
import { useMemo } from "react";
import type { RebalanceEvent } from "@/lib/types";
import {
  PLOTLY_BASE_LAYOUT,
  PLOTLY_AXIS_DEFAULTS,
  PLOTLY_CONFIG,
  RANGE_SELECTOR_BUTTONS_DAILY,
  makeDateXAxis,
} from "@/lib/plot";

const Plot = dynamic(() => import("react-plotly.js"), { ssr: false });

interface EffectivenessChartProps {
  events: RebalanceEvent[];
}

// Colour bands for the boundary-relative effectiveness ratio. 80–120% is the
// "landed on or just past the boundary" ideal band; overshoot past 120% burns
// reserves; under 50% is a control-loop failure.
const COLOR_BANDS: ReadonlyArray<{ max: number; color: string }> = [
  { max: 50, color: "#ef4444" }, // red: KPI 4 failure
  { max: 80, color: "#eab308" }, // yellow: under-correcting
  { max: 120, color: "#22c55e" }, // green: ideal
  { max: Infinity, color: "#f97316" }, // orange: overshoot
];

function markerColor(pct: number): string {
  for (const band of COLOR_BANDS) if (pct <= band.max) return band.color;
  return COLOR_BANDS[COLOR_BANDS.length - 1].color;
}

// `autorange: true` on the y-axis lets > 100% render without clipping —
// overshoot is legitimate data under the boundary-relative definition.
const STATIC_LAYOUT = {
  ...PLOTLY_BASE_LAYOUT,
  font: { ...PLOTLY_BASE_LAYOUT.font, size: 11 },
  xaxis: makeDateXAxis(RANGE_SELECTOR_BUTTONS_DAILY),
  yaxis: {
    title: { text: "Effectiveness % (vs boundary)", font: { size: 10 } },
    ...PLOTLY_AXIS_DEFAULTS,
    autorange: true,
  },
  shapes: [
    {
      type: "line" as const,
      xref: "paper" as const,
      yref: "y" as const,
      x0: 0,
      x1: 1,
      y0: 100,
      y1: 100,
      line: { color: "#64748b", width: 1, dash: "dot" as const },
    },
  ],
  annotations: [
    {
      xref: "paper" as const,
      yref: "y" as const,
      x: 1,
      xanchor: "right" as const,
      y: 100,
      yanchor: "bottom" as const,
      text: "100% = on boundary",
      showarrow: false,
      font: { color: "#64748b", size: 10 },
    },
  ],
  margin: { t: 8, l: 48, r: 16, b: 8 },
  autosize: true,
  dragmode: "pan" as const,
};

export function EffectivenessChart({ events }: EffectivenessChartProps) {
  const trace = useMemo(() => {
    const x: string[] = [];
    const y: number[] = [];
    const colors: string[] = [];
    for (const e of events) {
      const pct = Number(e.effectivenessRatio) * 100;
      x.push(new Date(Number(e.blockTimestamp) * 1000).toISOString());
      y.push(pct);
      colors.push(markerColor(pct));
    }
    return {
      x,
      y,
      type: "scatter" as const,
      mode: "lines+markers" as const,
      name: "Effectiveness %",
      line: { color: "#6366f1", width: 2 },
      marker: { size: 5, color: colors },
    };
  }, [events]);

  if (events.length < 2) return null;

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-2 sm:p-4 mb-4 overflow-hidden">
      <h3 className="text-sm font-medium text-slate-400 mb-1">
        Rebalance Effectiveness Trend
      </h3>
      <p className="text-xs text-slate-500 mb-3">
        100% = rebalance landed exactly on the rebalance boundary (ideal). Above
        100% = over-correction past the boundary (e.g. all the way to the
        oracle). Below 100% = control loop under-correcting. Negative =
        rebalance made deviation worse.
      </p>
      <Plot
        data={[trace]}
        layout={STATIC_LAYOUT}
        config={PLOTLY_CONFIG}
        style={{ width: "100%", height: 300 }}
        useResizeHandler
      />
    </div>
  );
}
