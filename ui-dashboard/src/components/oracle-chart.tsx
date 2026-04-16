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
  breachStartedAt?: string | null;
}

export function OracleChart({
  snapshots,
  token0Symbol = "Token 0",
  token1Symbol = "Token 1",
  breachStartedAt,
}: OracleChartProps) {
  if (snapshots.length === 0) return null;

  const isSparse = snapshots.length < 20;

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
    const d = new Date(Number(s.timestamp) * 1000);
    const ts =
      d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      }) +
      " " +
      d.toLocaleTimeString("en-US", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    const price = prices[i].toFixed(4);
    const dev = deviations[i].toFixed(2);
    return (
      `<b>${ts}</b><br>` +
      `Price: ${price} ${token1Symbol}/${token0Symbol}<br>` +
      `Deviation: ${dev}%`
    );
  });

  const traceMode = isSparse
    ? ("markers" as const)
    : ("lines+markers" as const);

  const priceTrace = {
    x: timestamps,
    y: prices,
    type: "scatter" as const,
    mode: traceMode,
    name: `Price (${token1Symbol}/${token0Symbol})`,
    line: { color: "#6366f1", width: 2 },
    marker: { size: isSparse ? 10 : 6, color: markerColors },
    yaxis: "y" as const,
    hoverinfo: "text" as const,
    text: hoverText,
  };

  const deviationTrace = {
    x: timestamps,
    y: deviations,
    type: "scatter" as const,
    mode: traceMode,
    name: "Deviation %",
    line: { color: "#f59e0b", width: 2, dash: "dot" as const },
    marker: { size: isSparse ? 8 : 4, color: "#f59e0b" },
    yaxis: "y2" as const,
    hoverinfo: "skip" as const,
  };

  // Background health bands on y2 axis
  const shapes: Plotly.Layout["shapes"] = [
    {
      type: "rect",
      xref: "paper",
      yref: "y2",
      x0: 0,
      x1: 1,
      y0: 0,
      y1: 80,
      fillcolor: "#22c55e",
      opacity: 0.07,
      line: { width: 0 },
      layer: "below",
    },
    {
      type: "rect",
      xref: "paper",
      yref: "y2",
      x0: 0,
      x1: 1,
      y0: 80,
      y1: 100,
      fillcolor: "#eab308",
      opacity: 0.1,
      line: { width: 0 },
      layer: "below",
    },
    {
      type: "rect",
      xref: "paper",
      yref: "y2",
      x0: 0,
      x1: 1,
      y0: 100,
      y1: 150,
      fillcolor: "#ef4444",
      opacity: 0.1,
      line: { width: 0 },
      layer: "below",
    },
    // Rebalance trigger threshold line at 100%
    {
      type: "line",
      xref: "paper",
      yref: "y2",
      x0: 0,
      x1: 1,
      y0: 100,
      y1: 100,
      line: { color: "#ef4444", width: 1.5, dash: "dash" },
      layer: "above",
    },
  ];

  // Breach-start vertical marker
  if (breachStartedAt && Number(breachStartedAt) > 0) {
    const breachIso = new Date(Number(breachStartedAt) * 1000).toISOString();
    shapes.push({
      type: "line",
      xref: "x",
      yref: "paper",
      x0: breachIso,
      x1: breachIso,
      y0: 0,
      y1: 1,
      line: { color: "#ef4444", width: 2, dash: "dot" },
      layer: "above",
    });
  }

  // Auto-zoom to data range when sparse — avoids tiny dots in vast empty chart
  const xaxisBase = makeDateXAxis(RANGE_SELECTOR_BUTTONS_DAILY);
  if (isSparse && timestamps.length >= 2) {
    const minTs = new Date(timestamps[0]).getTime();
    const maxTs = new Date(timestamps[timestamps.length - 1]).getTime();
    const pad = Math.max((maxTs - minTs) * 0.1, 3600_000); // 10% or 1h minimum
    xaxisBase.range = [
      new Date(minTs - pad).toISOString(),
      new Date(maxTs + pad).toISOString(),
    ];
    xaxisBase.autorange = false;
  }

  const layout = {
    ...PLOTLY_BASE_LAYOUT,
    shapes,
    xaxis: xaxisBase,
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
        <span className="flex items-center gap-1">
          <span className="inline-block w-4 border-t-2 border-dashed border-red-500" />
          Threshold
        </span>
        {breachStartedAt && Number(breachStartedAt) > 0 && (
          <span className="flex items-center gap-1">
            <span className="inline-block w-4 border-t-2 border-dotted border-red-500" />
            Breach start
          </span>
        )}
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
