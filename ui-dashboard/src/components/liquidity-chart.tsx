"use client";

import dynamic from "next/dynamic";
import type { Pool, PoolSnapshot } from "@/lib/types";
import { parseOraclePriceToNumber, parseWei } from "@/lib/format";
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

type LiquiditySeries = {
  useUsd: boolean;
  timestamps: string[];
  reserves0Usd: number[];
  reserves1Usd: number[];
  raw0: number[];
  raw1: number[];
};

function buildLiquiditySeries({
  snapshots,
  pool,
  token0Symbol,
}: Required<LiquidityChartProps>): LiquiditySeries {
  const nonUsdmUsdPrice = parseOraclePriceToNumber(
    pool?.oraclePrice ?? "0",
    token0Symbol,
  );
  const usdmIsToken0 = token0Symbol === "USDm";
  const useUsd = nonUsdmUsdPrice > 0;
  const dec0 = pool?.token0Decimals ?? 18;
  const dec1 = pool?.token1Decimals ?? 18;
  const toUsd0 = (raw: string) => {
    const amount = parseWei(raw, dec0);
    return useUsd && !usdmIsToken0 ? amount * nonUsdmUsdPrice : amount;
  };
  const toUsd1 = (raw: string) => {
    const amount = parseWei(raw, dec1);
    return useUsd && usdmIsToken0 ? amount * nonUsdmUsdPrice : amount;
  };

  return {
    useUsd,
    timestamps: snapshots.map((s) =>
      new Date(Number(s.timestamp) * 1000).toISOString(),
    ),
    reserves0Usd: snapshots.map((s) => toUsd0(s.reserves0)),
    reserves1Usd: snapshots.map((s) => toUsd1(s.reserves1)),
    raw0: snapshots.map((s) => parseWei(s.reserves0, dec0)),
    raw1: snapshots.map((s) => parseWei(s.reserves1, dec1)),
  };
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
  // Oracle prices must go through the canonical parser so USDm-base pools
  // use the same inversion as the oracle chart.
  const { useUsd, timestamps, reserves0Usd, reserves1Usd, raw0, raw1 } =
    buildLiquiditySeries({ snapshots, pool, token0Symbol, token1Symbol });
  const trace0 = makeReserveTrace({
    timestamps,
    values: reserves0Usd,
    raw: raw0,
    tokenSymbol: token0Symbol,
    useUsd,
    color: "#6366f1",
    fillcolor: "rgba(99,102,241,0.1)",
  });
  const trace1 = makeReserveTrace({
    timestamps,
    values: reserves1Usd,
    raw: raw1,
    tokenSymbol: token1Symbol,
    useUsd,
    color: "#a78bfa",
    fillcolor: "rgba(167,139,250,0.1)",
  });

  const subtitle = useUsd
    ? "Estimated using current oracle price — balanced pool = lines overlap"
    : null;

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-2 sm:p-4 mb-4 overflow-hidden">
      <div className="flex items-baseline gap-2 mb-3">
        <h3 className="text-sm font-medium text-slate-400">
          Pool Reserves Over Time
        </h3>
        {subtitle && <span className="text-xs text-slate-600">{subtitle}</span>}
      </div>
      <Plot
        data={[trace0, trace1]}
        layout={makeLayout(useUsd)}
        config={PLOTLY_CONFIG}
        style={{ width: "100%", height: 320 }}
        useResizeHandler
      />
    </div>
  );
}

function makeReserveTrace({
  timestamps,
  values,
  raw,
  tokenSymbol,
  useUsd,
  color,
  fillcolor,
}: {
  timestamps: string[];
  values: number[];
  raw: number[];
  tokenSymbol: string;
  useUsd: boolean;
  color: string;
  fillcolor: string;
}) {
  const name = useUsd ? `${tokenSymbol} (USD)` : tokenSymbol;
  return {
    x: timestamps,
    y: values,
    customdata: raw,
    hovertemplate: useUsd
      ? `<b>%{customdata:,.2f} ${tokenSymbol}</b><br>≈ $%{y:,.2f} USD<br>%{x|%b %d, %Y %H:%M}<extra></extra>`
      : `<b>%{customdata:,.2f} ${tokenSymbol}</b><br>%{x|%b %d, %Y %H:%M}<extra></extra>`,
    type: "scatter" as const,
    mode: "lines" as const,
    name,
    line: { color, width: 2 },
    fill: "tozeroy" as const,
    fillcolor,
    yaxis: "y" as const,
  };
}

function makeLayout(useUsd: boolean) {
  return {
    ...PLOTLY_BASE_LAYOUT,
    font: { ...PLOTLY_BASE_LAYOUT.font, size: 11 },
    xaxis: makeDateXAxis(RANGE_SELECTOR_BUTTONS_DAILY),
    yaxis: {
      title: { text: useUsd ? "Reserve Value (USD)" : "Reserve Balance" },
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
}
