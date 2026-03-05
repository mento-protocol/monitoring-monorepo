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

interface SnapshotChartProps {
  snapshots: PoolSnapshot[];
  token0Symbol?: string;
  token1Symbol?: string;
}

export function SnapshotChart({
  snapshots,
  token0Symbol = "Token 0",
  token1Symbol = "Token 1",
}: SnapshotChartProps) {
  if (snapshots.length === 0) return null;

  const timestamps = snapshots.map((s) =>
    new Date(Number(s.timestamp) * 1000).toISOString(),
  );
  // parseWei assumes 18 decimals — valid for all Mento stablecoins
  const volumes0 = snapshots.map((s) => parseWei(s.swapVolume0));
  const volumes1 = snapshots.map((s) => parseWei(s.swapVolume1));
  const cumSwaps = snapshots.map((s) => s.cumulativeSwapCount);

  const volumeTrace0 = {
    x: timestamps,
    y: volumes0,
    type: "bar" as const,
    name: `Vol ${token0Symbol}`,
    marker: { color: "#6366f1" },
    yaxis: "y" as const,
  };

  const volumeTrace1 = {
    x: timestamps,
    y: volumes1,
    type: "bar" as const,
    name: `Vol ${token1Symbol}`,
    marker: { color: "#a78bfa" },
    yaxis: "y" as const,
  };

  const cumSwapTrace = {
    x: timestamps,
    y: cumSwaps,
    type: "scatter" as const,
    mode: "lines+markers" as const,
    name: "Cumulative Swaps",
    line: { color: "#22d3ee", width: 2 },
    marker: { size: 4 },
    yaxis: "y2" as const,
  };

  const layout = {
    ...PLOTLY_BASE_LAYOUT,
    xaxis: makeDateXAxis(RANGE_SELECTOR_BUTTONS_DAILY),
    yaxis: { title: { text: "Swap Volume" }, ...PLOTLY_AXIS_DEFAULTS },
    yaxis2: {
      title: { text: "Cumulative Swaps" },
      overlaying: "y" as const,
      side: "right" as const,
      gridcolor: "transparent",
      linecolor: "#334155",
      tickcolor: "#334155",
    },
    legend: PLOTLY_LEGEND,
    margin: PLOTLY_MARGIN,
    autosize: true,
    dragmode: "pan" as const,
  };

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4 mb-4">
      <h3 className="text-sm font-medium text-slate-400 mb-3">
        Swap Volume &amp; Cumulative Swaps
      </h3>
      <Plot
        data={[volumeTrace0, volumeTrace1, cumSwapTrace]}
        layout={layout}
        config={{ ...PLOTLY_CONFIG, displayModeBar: true }}
        style={{ width: "100%", height: 320 }}
        useResizeHandler
      />
    </div>
  );
}
