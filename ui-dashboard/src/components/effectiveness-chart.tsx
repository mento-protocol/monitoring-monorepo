"use client";

import dynamic from "next/dynamic";
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

export function EffectivenessChart({ events }: EffectivenessChartProps) {
  if (events.length < 2) return null;

  const timestamps = events.map((e) =>
    new Date(Number(e.blockTimestamp) * 1000).toISOString(),
  );
  const effectiveness = events.map((e) => Number(e.effectivenessRatio) * 100);

  const trace = {
    x: timestamps,
    y: effectiveness,
    type: "scatter" as const,
    mode: "lines+markers" as const,
    name: "Effectiveness %",
    line: { color: "#6366f1", width: 2 },
    marker: {
      size: 5,
      color: effectiveness.map((v) =>
        v >= 80 ? "#22c55e" : v >= 50 ? "#eab308" : "#ef4444",
      ),
    },
  };

  const layout = {
    ...PLOTLY_BASE_LAYOUT,
    font: { ...PLOTLY_BASE_LAYOUT.font, size: 11 },
    xaxis: makeDateXAxis(RANGE_SELECTOR_BUTTONS_DAILY),
    yaxis: {
      title: { text: "Effectiveness %", font: { size: 10 } },
      ...PLOTLY_AXIS_DEFAULTS,
      range: [0, 105],
    },
    margin: { t: 8, l: 48, r: 16, b: 8 },
    autosize: true,
    dragmode: "pan" as const,
  };

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-2 sm:p-4 mb-4 overflow-hidden">
      <h3 className="text-sm font-medium text-slate-400 mb-3">
        Rebalance Effectiveness Trend
      </h3>
      <Plot
        data={[trace]}
        layout={layout}
        config={PLOTLY_CONFIG}
        style={{ width: "100%", height: 300 }}
        useResizeHandler
      />
    </div>
  );
}
