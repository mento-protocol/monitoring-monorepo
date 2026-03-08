"use client";

import dynamic from "next/dynamic";
import type { Pool, PoolSnapshot } from "@/lib/types";
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

interface LiquidityChartProps {
  snapshots: PoolSnapshot[];
  pool: Pool | null;
  token0Symbol?: string;
  token1Symbol?: string;
}

export function LiquidityChart({
  snapshots,
  pool,
  token0Symbol = "Token 0",
  token1Symbol = "Token 1",
}: LiquidityChartProps) {
  if (snapshots.length === 0) return null;

  // Convert raw token reserves to USD value using the current oracle price as
  // an approximation for all historical data points. This lets both series share
  // a single Y-axis so a balanced pool shows two overlapping lines.
  //
  // Oracle price is stored in feed direction ("feedToken/USD"). One token is always
  // USDm (already USD). The other is priced via the feed:
  //   sym0 === "USDm": reserve0 stays as-is; reserve1 × feedValue
  //   sym1 === "USDm": reserve0 × feedValue; reserve1 stays as-is
  //
  // feedValue = oraclePrice / 1e24 (but parseOraclePriceToNumber inverts for USDm-base)
  // so we get feedValue directly as: oraclePrice / 1e24 without inversion.
  const rawOraclePrice = pool?.oraclePrice ?? "0";
  const rawFeedValue =
    rawOraclePrice !== "0" ? Number(rawOraclePrice) / 10 ** 24 : 0;

  // For USDm-base pools (token0=USDm): reserve0 is USD, reserve1 needs × feedValue
  // For USDm-quote pools (token1=USDm): reserve0 needs × feedValue, reserve1 is USD
  const usdmIsToken0 = token0Symbol === "USDm";

  // Use token amounts as fallback when oracle price is unavailable
  const useUsd = rawFeedValue > 0;

  const toUsd0 = (raw: string) => {
    const amount = parseWei(raw);
    if (!useUsd) return amount;
    return usdmIsToken0 ? amount : amount * rawFeedValue;
  };

  const toUsd1 = (raw: string) => {
    const amount = parseWei(raw);
    if (!useUsd) return amount;
    return usdmIsToken0 ? amount * rawFeedValue : amount;
  };

  const timestamps = snapshots.map((s) =>
    new Date(Number(s.timestamp) * 1000).toISOString(),
  );
  const reserves0Usd = snapshots.map((s) => toUsd0(s.reserves0));
  const reserves1Usd = snapshots.map((s) => toUsd1(s.reserves1));
  const raw0 = snapshots.map((s) => parseWei(s.reserves0));
  const raw1 = snapshots.map((s) => parseWei(s.reserves1));

  const yAxisTitle = useUsd ? "Reserve Value (USD)" : "Reserve Balance";
  const name0 = useUsd ? `${token0Symbol} (USD)` : token0Symbol;
  const name1 = useUsd ? `${token1Symbol} (USD)` : token1Symbol;

  const trace0 = {
    x: timestamps,
    y: reserves0Usd,
    customdata: raw0,
    hovertemplate: useUsd
      ? `<b>%{customdata:,.2f} ${token0Symbol}</b><br>≈ $%{y:,.2f} USD<br>%{x|%b %d, %Y %H:%M}<extra></extra>`
      : `<b>%{customdata:,.2f} ${token0Symbol}</b><br>%{x|%b %d, %Y %H:%M}<extra></extra>`,
    type: "scatter" as const,
    mode: "lines" as const,
    name: name0,
    line: { color: "#6366f1", width: 2 },
    fill: "tozeroy" as const,
    fillcolor: "rgba(99,102,241,0.1)",
    yaxis: "y" as const,
  };

  const trace1 = {
    x: timestamps,
    y: reserves1Usd,
    customdata: raw1,
    hovertemplate: useUsd
      ? `<b>%{customdata:,.2f} ${token1Symbol}</b><br>≈ $%{y:,.2f} USD<br>%{x|%b %d, %Y %H:%M}<extra></extra>`
      : `<b>%{customdata:,.2f} ${token1Symbol}</b><br>%{x|%b %d, %Y %H:%M}<extra></extra>`,
    type: "scatter" as const,
    mode: "lines" as const,
    name: name1,
    line: { color: "#a78bfa", width: 2 },
    fill: "tozeroy" as const,
    fillcolor: "rgba(167,139,250,0.1)",
    yaxis: "y" as const,
  };

  const layout = {
    ...PLOTLY_BASE_LAYOUT,
    font: { ...PLOTLY_BASE_LAYOUT.font, size: 11 },
    xaxis: makeDateXAxis(RANGE_SELECTOR_BUTTONS_DAILY),
    yaxis: {
      title: { text: yAxisTitle },
      ...PLOTLY_AXIS_DEFAULTS,
    },
    legend: {
      ...PLOTLY_LEGEND,
      orientation: "h" as const,
      x: 0.5,
      y: -0.25,
      xanchor: "center" as const,
      yanchor: "top" as const,
    },
    margin: { t: 8, r: 16, b: 8, l: 48 },
    autosize: true,
    dragmode: "pan" as const,
  };

  const subtitle = useUsd
    ? "Estimated using current oracle price — balanced pool = lines overlap"
    : null;

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4 mb-4">
      <div className="flex items-baseline gap-2 mb-3">
        <h3 className="text-sm font-medium text-slate-400">
          Pool Reserves Over Time
        </h3>
        {subtitle && <span className="text-xs text-slate-600">{subtitle}</span>}
      </div>
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
