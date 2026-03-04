"use client";

import dynamic from "next/dynamic";
import type { ReserveUpdate } from "@/lib/types";
import { tokenSymbol } from "@/lib/tokens";
import { useNetwork } from "@/components/network-provider";
import { parseWei } from "@/lib/format";

// Plotly must be loaded client-side only (no SSR)
const Plot = dynamic(() => import("react-plotly.js"), { ssr: false });

interface ReserveChartProps {
  rows: ReserveUpdate[];
  token0: string | null;
  token1: string | null;
}

export function ReserveChart({ rows, token0, token1 }: ReserveChartProps) {
  const { network } = useNetwork();
  if (rows.length === 0) return null;

  const sym0 = tokenSymbol(network, token0);
  const sym1 = tokenSymbol(network, token1);

  // rows come in asc order from the query
  const timestamps = rows.map((r) =>
    new Date(Number(r.blockTimestamp) * 1000).toISOString(),
  );
  const r0 = rows.map((r) => parseWei(r.reserve0));
  const r1 = rows.map((r) => parseWei(r.reserve1));

  const trace0 = {
    x: timestamps,
    y: r0,
    type: "scatter" as const,
    mode: "lines+markers" as const,
    name: sym0,
    line: { color: "#6366f1", width: 2 },
    marker: { size: 4 },
  };

  const trace1 = {
    x: timestamps,
    y: r1,
    type: "scatter" as const,
    mode: "lines+markers" as const,
    name: sym1,
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
            label: "1h",
            step: "hour" as const,
            stepmode: "backward" as const,
          },
          {
            count: 6,
            label: "6h",
            step: "hour" as const,
            stepmode: "backward" as const,
          },
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
          { step: "all" as const, label: "All" },
        ],
      },
    },
    yaxis: {
      title: { text: sym0 },
      gridcolor: "#1e293b",
      linecolor: "#334155",
      tickcolor: "#334155",
    },
    yaxis2: {
      title: { text: sym1 },
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
        Reserve History
      </h3>
      <Plot
        data={[trace0, trace1]}
        layout={layout}
        config={{ responsive: true, displayModeBar: true, scrollZoom: true }}
        style={{ width: "100%", height: 320 }}
        useResizeHandler
      />
    </div>
  );
}
