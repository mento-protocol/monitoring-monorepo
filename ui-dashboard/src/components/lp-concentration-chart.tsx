"use client";

import dynamic from "next/dynamic";
import { PLOTLY_BASE_LAYOUT, PLOTLY_CONFIG } from "@/lib/plot";

const Plot = dynamic(() => import("react-plotly.js"), { ssr: false });

interface LpPosition {
  address: string;
  netLiquidity: bigint;
}

interface LpConcentrationChartProps {
  positions: LpPosition[]; // pre-sorted descending by netLiquidity
  totalLiquidity: bigint;
}

export function LpConcentrationChart({
  positions,
  totalLiquidity,
}: LpConcentrationChartProps) {
  if (positions.length === 0 || totalLiquidity === BigInt(0)) return null;

  const TOP_N = 10;
  const top = positions.slice(0, TOP_N);
  const rest = positions.slice(TOP_N);
  const otherTotal = rest.reduce((acc, p) => acc + p.netLiquidity, BigInt(0));

  const fmt = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

  const labels = [
    ...top.map((p) => fmt(p.address)),
    ...(otherTotal > BigInt(0) ? ["Other"] : []),
  ];
  const values = [
    ...top.map((p) => Number(p.netLiquidity)),
    ...(otherTotal > BigInt(0) ? [Number(otherTotal)] : []),
  ];
  const customdata = [
    ...top.map((p) => p.address),
    ...(otherTotal > BigInt(0) ? ["(multiple)"] : []),
  ];

  const hovertemplate =
    "<b>%{customdata}</b><br>%{percent} of pool<br><extra></extra>";

  const trace = {
    type: "pie" as const,
    hole: 0.4,
    labels,
    values,
    customdata,
    hovertemplate,
    textinfo: "percent" as const,
    marker: {
      colors: [
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
        "#64748b",
      ],
      line: { color: "#1e293b", width: 2 },
    },
  };

  const layout = {
    ...PLOTLY_BASE_LAYOUT,
    margin: { t: 8, r: 16, b: 8, l: 16 },
    showlegend: true,
    legend: {
      font: { color: "#94a3b8", size: 11 },
      bgcolor: "transparent",
      orientation: "v" as const,
      x: 1,
      y: 0.5,
    },
    height: 300,
    autosize: true,
  };

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-2 sm:p-4 mb-4 overflow-hidden">
      <h3 className="text-sm font-medium text-slate-400 mb-3">
        LP Concentration
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
