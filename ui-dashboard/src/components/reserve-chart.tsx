"use client";

import dynamic from "next/dynamic";
import type { ReserveUpdate } from "@/lib/types";
import { tokenSymbol } from "@/lib/tokens";
import { useNetwork } from "@/components/network-provider";
import { parseWei } from "@/lib/format";
import {
  PLOTLY_BASE_LAYOUT,
  PLOTLY_AXIS_DEFAULTS,
  PLOTLY_LEGEND,
  PLOTLY_MARGIN,
  PLOTLY_CONFIG,
  RANGE_SELECTOR_BUTTONS_HOURLY,
  makeDateXAxis,
} from "@/lib/plot";

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
    ...PLOTLY_BASE_LAYOUT,
    xaxis: makeDateXAxis(RANGE_SELECTOR_BUTTONS_HOURLY),
    yaxis: { title: { text: sym0 }, ...PLOTLY_AXIS_DEFAULTS },
    yaxis2: {
      title: { text: sym1 },
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
        Reserve History
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
