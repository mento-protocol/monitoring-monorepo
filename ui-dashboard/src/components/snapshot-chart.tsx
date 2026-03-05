"use client";

import dynamic from "next/dynamic";
import type { PoolSnapshot } from "@/lib/types";
import { parseWei } from "@/lib/format";

const Plot = dynamic(() => import("react-plotly.js"), { ssr: false });

interface SnapshotChartProps {
  snapshots: PoolSnapshot[];
}

export function SnapshotChart({ snapshots }: SnapshotChartProps) {
  if (snapshots.length === 0) return null;

  const timestamps = snapshots.map((s) =>
    new Date(Number(s.timestamp) * 1000).toISOString(),
  );
  const volumes = snapshots.map((s) => parseWei(s.swapVolume0));
  const cumSwaps = snapshots.map((s) => s.cumulativeSwapCount);

  const volumeTrace = {
    x: timestamps,
    y: volumes,
    type: "bar" as const,
    name: "Swap Volume (Token 0)",
    marker: { color: "#6366f1" },
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
    paper_bgcolor: "transparent",
    plot_bgcolor: "transparent",
    font: { color: "#94a3b8", size: 12 },
    xaxis: {
      gridcolor: "#1e293b",
      linecolor: "#334155",
      tickcolor: "#334155",
      type: "date" as const,
      rangeslider: {
        bgcolor: "#1e293b",
        bordercolor: "#334155",
        thickness: 0.08,
      },
      rangeselector: {
        bgcolor: "#1e293b",
        activecolor: "#334155",
        bordercolor: "#475569",
        borderwidth: 1,
        font: { color: "#94a3b8" },
        buttons: [
          {
            count: 1,
            label: "1d",
            step: "day" as const,
            stepmode: "backward" as const,
          },
          {
            count: 7,
            label: "7d",
            step: "day" as const,
            stepmode: "backward" as const,
          },
          {
            count: 30,
            label: "30d",
            step: "day" as const,
            stepmode: "backward" as const,
          },
          { step: "all" as const, label: "All" },
        ],
      },
    },
    yaxis: {
      title: { text: "Swap Volume" },
      gridcolor: "#1e293b",
      linecolor: "#334155",
      tickcolor: "#334155",
    },
    yaxis2: {
      title: { text: "Cumulative Swaps" },
      overlaying: "y" as const,
      side: "right" as const,
      gridcolor: "transparent",
      linecolor: "#334155",
      tickcolor: "#334155",
    },
    legend: {
      bgcolor: "transparent",
      bordercolor: "#334155",
      borderwidth: 1,
    },
    margin: { t: 16, r: 60, b: 8, l: 60 },
    autosize: true,
    dragmode: "pan" as const,
  };

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4 mb-4">
      <h3 className="text-sm font-medium text-slate-400 mb-3">
        Swap Volume &amp; Cumulative Swaps
      </h3>
      <Plot
        data={[volumeTrace, cumSwapTrace]}
        layout={layout}
        config={{ responsive: true, displayModeBar: true, scrollZoom: true }}
        style={{ width: "100%", height: 320 }}
        useResizeHandler
      />
    </div>
  );
}
