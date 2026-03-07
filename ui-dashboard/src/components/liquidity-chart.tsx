"use client";

import dynamic from "next/dynamic";
import type { PoolSnapshot } from "@/lib/types";
import { parseWei } from "@/lib/format";
import {
  PLOTLY_BASE_LAYOUT,
  PLOTLY_AXIS_DEFAULTS,
  PLOTLY_LEGEND,
  PLOTLY_MARGIN,
  PLOTLY_CONFIG,
  RANGE_SELECTOR_BUTTONS_DAILY,
  makeDateXAxis,
} from "@/lib/plot";

const Plot = dynamic(() => import("react-plotly.js"), { ssr: false });

interface LiquidityChartProps {
  snapshots: PoolSnapshot[];
  token0Symbol?: string;
  token1Symbol?: string;
}

export function LiquidityChart({
  snapshots,
  token0Symbol = "Token 0",
  token1Symbol = "Token 1",
}: LiquidityChartProps) {
  if (snapshots.length === 0) return null;

  // Use one data point per hour (raw snapshots) — reserves are a running state,
  // not a delta, so no aggregation needed.
  const timestamps = snapshots.map((s) =>
    new Date(Number(s.timestamp) * 1000).toISOString(),
  );
  // parseWei assumes 18 decimals — valid for all Mento stablecoins
  const reserves0 = snapshots.map((s) => parseWei(s.reserves0));
  const reserves1 = snapshots.map((s) => parseWei(s.reserves1));

  const trace0 = {
    x: timestamps,
    y: reserves0,
    type: "scatter" as const,
    mode: "lines" as const,
    name: token0Symbol,
    line: { color: "#6366f1", width: 2 },
    fill: "tozeroy" as const,
    fillcolor: "rgba(99,102,241,0.1)",
    yaxis: "y" as const,
  };

  const trace1 = {
    x: timestamps,
    y: reserves1,
    type: "scatter" as const,
    mode: "lines" as const,
    name: token1Symbol,
    line: { color: "#a78bfa", width: 2 },
    fill: "tozeroy" as const,
    fillcolor: "rgba(167,139,250,0.1)",
    yaxis: "y" as const,
  };

  const layout = {
    ...PLOTLY_BASE_LAYOUT,
    xaxis: makeDateXAxis(RANGE_SELECTOR_BUTTONS_DAILY),
    yaxis: {
      title: { text: "Reserve Balance" },
      ...PLOTLY_AXIS_DEFAULTS,
    },
    legend: PLOTLY_LEGEND,
    margin: PLOTLY_MARGIN,
    autosize: true,
    dragmode: "pan" as const,
  };

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4 mb-4">
      <h3 className="text-sm font-medium text-slate-400 mb-3">
        Pool Reserves Over Time
      </h3>
      <Plot
        data={[trace0, trace1]}
        layout={layout}
        config={{ ...PLOTLY_CONFIG, displayModeBar: true }}
        style={{ width: "100%", height: 320 }}
        useResizeHandler
      />
    </div>
  );
}
