"use client";

import dynamic from "next/dynamic";
import type { OracleSnapshot } from "@/lib/types";
import { parseOraclePriceToNumber } from "@/lib/format";
import {
  PLOTLY_BASE_LAYOUT,
  PLOTLY_AXIS_DEFAULTS,
  PLOTLY_LEGEND,
  PLOTLY_CONFIG,
  RANGE_SELECTOR_BUTTONS_DAILY,
  makeDateXAxis,
} from "@/lib/plot";

const Plot = dynamic(() => import("react-plotly.js"), { ssr: false });

interface OracleChartProps {
  snapshots: OracleSnapshot[];
  token0Symbol?: string;
  token1Symbol?: string;
}

export function OracleChart({
  snapshots,
  token0Symbol = "Token 0",
  token1Symbol = "Token 1",
}: OracleChartProps) {
  if (snapshots.length === 0) return null;

  const timestamps = snapshots.map((s) =>
    new Date(Number(s.timestamp) * 1000).toISOString(),
  );

  // Normalise oracle price to human-readable float in pool direction (token0→token1)
  const prices = snapshots.map((s) =>
    parseOraclePriceToNumber(s.oraclePrice ?? null, token0Symbol ?? ""),
  );

  // Deviation % of rebalance threshold
  const deviations = snapshots.map((s) => {
    const threshold = Number(s.rebalanceThreshold);
    return threshold > 0 ? (Number(s.priceDifference) / threshold) * 100 : 0;
  });

  // Per-point marker colours based on oracleOk
  const markerColors = snapshots.map((s) =>
    s.oracleOk ? "#22c55e" : "#ef4444",
  );

  const hoverText = snapshots.map((s, i) => {
    const ts = new Date(Number(s.timestamp) * 1000).toLocaleString();
    const price = prices[i].toFixed(4);
    const dev = deviations[i].toFixed(2);
    return (
      `<b>${ts}</b><br>` +
      `Price: ${price} ${token1Symbol}/${token0Symbol}<br>` +
      `Deviation: ${dev}%<br>` +
      `Reporters: ${s.numReporters}<br>` +
      `Source: ${s.source}`
    );
  });

  const priceTrace = {
    x: timestamps,
    y: prices,
    type: "scatter" as const,
    mode: "lines+markers" as const,
    name: `Price (${token1Symbol}/${token0Symbol})`,
    line: { color: "#6366f1", width: 2 },
    marker: { size: 6, color: markerColors },
    yaxis: "y" as const,
    hoverinfo: "text" as const,
    text: hoverText,
  };

  const deviationTrace = {
    x: timestamps,
    y: deviations,
    type: "scatter" as const,
    mode: "lines+markers" as const,
    name: "Deviation %",
    line: { color: "#f59e0b", width: 2, dash: "dot" as const },
    marker: { size: 4, color: "#f59e0b" },
    yaxis: "y2" as const,
    hoverinfo: "skip" as const,
  };

  // Background health bands on y2 axis
  const shapes = [
    {
      type: "rect" as const,
      xref: "paper" as const,
      yref: "y2" as const,
      x0: 0,
      x1: 1,
      y0: 0,
      y1: 80,
      fillcolor: "#22c55e",
      opacity: 0.07,
      line: { width: 0 },
      layer: "below" as const,
    },
    {
      type: "rect" as const,
      xref: "paper" as const,
      yref: "y2" as const,
      x0: 0,
      x1: 1,
      y0: 80,
      y1: 100,
      fillcolor: "#eab308",
      opacity: 0.1,
      line: { width: 0 },
      layer: "below" as const,
    },
    {
      type: "rect" as const,
      xref: "paper" as const,
      yref: "y2" as const,
      x0: 0,
      x1: 1,
      y0: 100,
      y1: 150,
      fillcolor: "#ef4444",
      opacity: 0.1,
      line: { width: 0 },
      layer: "below" as const,
    },
  ];

  const layout = {
    ...PLOTLY_BASE_LAYOUT,
    shapes,
    xaxis: makeDateXAxis(RANGE_SELECTOR_BUTTONS_DAILY),
    yaxis: {
      title: { text: "Price", font: { size: 10 } },
      ...PLOTLY_AXIS_DEFAULTS,
    },
    yaxis2: {
      title: { text: "Dev %", font: { size: 10 } },
      overlaying: "y" as const,
      side: "right" as const,
      gridcolor: "transparent",
      linecolor: "#334155",
      tickcolor: "#334155",
      range: [0, 150],
    },
    legend: {
      ...PLOTLY_LEGEND,
      orientation: "h" as const,
      x: 0.5,
      y: -0.3,
      xanchor: "center" as const,
      yanchor: "top" as const,
    },
    margin: { t: 8, l: 48, r: 48, b: 8 },
    font: { ...PLOTLY_BASE_LAYOUT.font, size: 11 },
    autosize: true,
    dragmode: "pan" as const,
  };

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-2 sm:p-4 mb-4 overflow-hidden">
      <h3 className="text-sm font-medium text-slate-400 mb-3">
        Oracle Price History &amp; Deviation Health
      </h3>
      <div className="flex flex-wrap gap-x-3 gap-y-1 mb-2 text-[10px] sm:text-xs text-slate-500">
        <span className="flex items-center gap-1">
          <span className="inline-block w-2.5 h-2.5 rounded-sm bg-green-500/20 border border-green-500/40" />
          Healthy
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2.5 h-2.5 rounded-sm bg-yellow-500/20 border border-yellow-500/40" />
          Warning
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2.5 h-2.5 rounded-sm bg-red-500/20 border border-red-500/40" />
          Critical
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-full bg-green-500" />
          OK
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-full bg-red-500" />
          Expired
        </span>
      </div>
      <Plot
        data={[priceTrace, deviationTrace]}
        layout={layout}
        config={PLOTLY_CONFIG}
        style={{ width: "100%", height: 420 }}
        useResizeHandler
      />
    </div>
  );
}
