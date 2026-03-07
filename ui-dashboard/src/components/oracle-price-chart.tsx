"use client";

import dynamic from "next/dynamic";
import type { OracleSnapshot } from "@/lib/types";
import { tokenSymbol } from "@/lib/tokens";
import { parseOraclePriceToNumber } from "@/lib/format";
import { useNetwork } from "@/components/network-provider";
import {
  PLOTLY_AXIS_DEFAULTS,
  PLOTLY_RANGE_SELECTOR_STYLE,
  PLOTLY_RANGE_SLIDER_STYLE,
  RANGE_SELECTOR_BUTTONS_DAILY,
} from "@/lib/plot";

// Plotly must be loaded client-side only (no SSR)
const Plot = dynamic(() => import("react-plotly.js"), { ssr: false });

interface OraclePriceChartProps {
  snapshots: OracleSnapshot[];
  token0: string | null;
  token1: string | null;
}

export function OraclePriceChart({
  snapshots,
  token0,
  token1,
}: OraclePriceChartProps) {
  const { network } = useNetwork();
  if (snapshots.length === 0) return null;

  const sym0 = tokenSymbol(network, token0);
  const sym1 = tokenSymbol(network, token1);

  const timestamps = snapshots.map((s) =>
    new Date(Number(s.timestamp) * 1000).toISOString(),
  );
  const prices = snapshots.map((s) =>
    parseOraclePriceToNumber(s.oraclePrice, sym0),
  );
  const deviations = snapshots.map((s) => {
    if (!s.rebalanceThreshold || s.rebalanceThreshold === 0) return 0;
    return (Number(s.priceDifference) / s.rebalanceThreshold) * 100;
  });

  const priceTrace = {
    x: timestamps,
    y: prices,
    type: "scatter" as const,
    mode: "lines+markers" as const,
    name: `Oracle Price (${sym0}/${sym1})`,
    line: { color: "#a78bfa", width: 2 },
    marker: { size: 4 },
  };

  const deviationTrace = {
    x: timestamps,
    y: deviations,
    type: "scatter" as const,
    mode: "lines+markers" as const,
    name: "Deviation % of threshold",
    line: { color: "#f59e0b", width: 1.5, dash: "dot" as const },
    marker: { size: 3 },
    yaxis: "y2" as const,
  };

  const layout = {
    paper_bgcolor: "transparent",
    plot_bgcolor: "transparent",
    font: { color: "#94a3b8", size: 12 },
    margin: { t: 20, r: 60, b: 50, l: 60 },
    xaxis: {
      ...PLOTLY_AXIS_DEFAULTS,
      type: "date" as const,
      rangeslider: PLOTLY_RANGE_SLIDER_STYLE,
      rangeselector: {
        ...PLOTLY_RANGE_SELECTOR_STYLE,
        buttons: RANGE_SELECTOR_BUTTONS_DAILY,
      },
    },
    yaxis: {
      title: { text: `Oracle Price`, font: { size: 11 } },
      gridcolor: "#1e293b",
      linecolor: "#334155",
      tickcolor: "#475569",
    },
    yaxis2: {
      title: { text: "Deviation (% threshold)", font: { size: 11 } },
      overlaying: "y" as const,
      side: "right" as const,
      gridcolor: "transparent",
      linecolor: "#334155",
      tickcolor: "#475569",
      tickformat: ".0f",
    },
    legend: {
      bgcolor: "transparent",
      x: 0,
      y: 1.05,
      orientation: "h" as const,
    },
    height: 260,
  };

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
      <h3 className="mb-3 text-sm font-semibold text-slate-200">
        Oracle Price History
      </h3>
      <Plot
        data={[priceTrace, deviationTrace]}
        layout={layout}
        config={{ displayModeBar: false, responsive: true }}
        style={{ width: "100%", height: "260px" }}
      />
    </div>
  );
}
