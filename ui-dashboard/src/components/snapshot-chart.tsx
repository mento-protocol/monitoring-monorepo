"use client";

import dynamic from "next/dynamic";
import type { PoolSnapshot } from "@/lib/types";
import { parseWei } from "@/lib/format";
import {
  PLOTLY_BASE_LAYOUT,
  PLOTLY_AXIS_DEFAULTS,
  PLOTLY_LEGEND,
  PLOTLY_CONFIG,
  RANGE_SELECTOR_BUTTONS_DAILY,
  makeDateXAxis,
} from "@/lib/plot";

const Plot = dynamic(() => import("react-plotly.js"), { ssr: false });

interface SnapshotChartProps {
  snapshots: PoolSnapshot[];
  token0Symbol?: string;
  token1Symbol?: string;
  rebalanceTimestamps?: string[];
}

export function SnapshotChart({
  snapshots,
  token0Symbol = "Token 0",
  token1Symbol = "Token 1",
  rebalanceTimestamps,
}: SnapshotChartProps) {
  if (snapshots.length === 0) return null;

  // Query returns desc (newest-first) to preserve recent rows when the 1000-row
  // cap truncates old history. Reverse here so Plotly receives chronological order.
  const sorted = [...snapshots].reverse();
  const days = sorted.map((s) =>
    new Date(Number(s.timestamp) * 1000).toISOString().slice(0, 10),
  );
  const vol0 = sorted.map((s) => parseWei(s.swapVolume0));
  const vol1 = sorted.map((s) => parseWei(s.swapVolume1));
  const cumSwaps = sorted.map((s) => s.cumulativeSwapCount);

  const volumeTrace0 = {
    x: days,
    y: vol0,
    type: "bar" as const,
    name: `${token0Symbol} sold`,
    marker: { color: "#6366f1" },
    yaxis: "y" as const,
  };

  const volumeTrace1 = {
    x: days,
    y: vol1,
    type: "bar" as const,
    name: `${token1Symbol} sold`,
    marker: { color: "#a78bfa" },
    yaxis: "y" as const,
  };

  const cumSwapTrace = {
    x: days,
    y: cumSwaps,
    type: "scatter" as const,
    mode: "lines+markers" as const,
    name: "Cumulative Swaps",
    line: { color: "#22d3ee", width: 2 },
    marker: { size: 4 },
    yaxis: "y2" as const,
  };

  const rebalanceShapes: Plotly.Layout["shapes"] = (
    rebalanceTimestamps ?? []
  ).map((ts) => ({
    type: "line" as const,
    xref: "x" as const,
    yref: "paper" as const,
    x0: new Date(Number(ts) * 1000).toISOString().slice(0, 10),
    x1: new Date(Number(ts) * 1000).toISOString().slice(0, 10),
    y0: 0,
    y1: 1,
    line: { color: "#f59e0b", width: 1, dash: "dot" as const },
    layer: "above" as const,
  }));

  const layout = {
    ...PLOTLY_BASE_LAYOUT,
    shapes: rebalanceShapes,
    font: { ...PLOTLY_BASE_LAYOUT.font, size: 11 },
    barmode: "stack" as const,
    xaxis: makeDateXAxis(RANGE_SELECTOR_BUTTONS_DAILY),
    yaxis: {
      title: { text: "Volume", font: { size: 10 } },
      ...PLOTLY_AXIS_DEFAULTS,
    },
    yaxis2: {
      title: { text: "Swaps", font: { size: 10 } },
      overlaying: "y" as const,
      side: "right" as const,
      gridcolor: "transparent",
      linecolor: "#334155",
      tickcolor: "#334155",
    },
    legend: {
      ...PLOTLY_LEGEND,
      orientation: "h" as const,
      x: 0.5,
      y: -0.45,
      xanchor: "center" as const,
      yanchor: "top" as const,
      font: { size: 10 },
    },
    margin: { t: 8, l: 40, r: 36, b: 8 },
    autosize: true,
    dragmode: "pan" as const,
  };

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-2 sm:p-4 mb-4 overflow-hidden">
      <h3 className="text-sm font-medium text-slate-400 mb-3">
        Daily Swap Volume
      </h3>
      <Plot
        data={[volumeTrace0, volumeTrace1, cumSwapTrace]}
        layout={layout}
        config={PLOTLY_CONFIG}
        style={{ width: "100%", height: 380 }}
        useResizeHandler
      />
    </div>
  );
}
