"use client";

import dynamic from "next/dynamic";
import type { Pool, ReserveUpdate } from "@/lib/types";
import { tokenSymbol, USDM_SYMBOLS } from "@/lib/tokens";
import { useNetwork } from "@/components/network-provider";
import { parseWei } from "@/lib/format";
import {
  PLOTLY_BASE_LAYOUT,
  PLOTLY_AXIS_DEFAULTS,
  PLOTLY_LEGEND,
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
  pool?: Pool | null;
}

export function ReserveChart({
  rows,
  token0,
  token1,
  pool,
}: ReserveChartProps) {
  const { network } = useNetwork();
  if (rows.length === 0) return null;

  const sym0 = tokenSymbol(network, token0);
  const sym1 = tokenSymbol(network, token1);

  // Convert to USD using current oracle price (same approach as liquidity chart).
  // feedValue = oraclePrice / 1e24 (feed direction = "feedToken/USD", no inversion needed).
  const rawOraclePrice = pool?.oraclePrice ?? "0";
  const feedVal =
    rawOraclePrice && rawOraclePrice !== "0"
      ? Number(rawOraclePrice) / 10 ** 24
      : 0;
  const useUsd = feedVal > 0;
  const usdmIsToken0 = USDM_SYMBOLS.has(sym0);

  const dec0 = pool?.token0Decimals ?? 18;
  const dec1 = pool?.token1Decimals ?? 18;

  const toUsd0 = (raw: string) => {
    const amount = parseWei(raw, dec0);
    if (!useUsd) return amount;
    return usdmIsToken0 ? amount : amount * feedVal;
  };

  const toUsd1 = (raw: string) => {
    const amount = parseWei(raw, dec1);
    if (!useUsd) return amount;
    return usdmIsToken0 ? amount * feedVal : amount;
  };

  // rows come in asc order from the query
  const timestamps = rows.map((r) =>
    new Date(Number(r.blockTimestamp) * 1000).toISOString(),
  );
  const r0 = rows.map((r) => toUsd0(r.reserve0));
  const r1 = rows.map((r) => toUsd1(r.reserve1));
  // Raw token amounts for hover tooltip (always show original, not USD)
  const raw0 = rows.map((r) => parseWei(r.reserve0, dec0));
  const raw1 = rows.map((r) => parseWei(r.reserve1, dec1));

  const name0 = useUsd ? `${sym0} (USD)` : sym0;
  const name1 = useUsd ? `${sym1} (USD)` : sym1;
  const yAxisTitle = useUsd ? "Reserve Value (USD)" : "Reserve Balance";

  const trace0 = {
    x: timestamps,
    y: r0,
    customdata: raw0,
    hovertemplate: useUsd
      ? `<b>%{customdata:,.2f} ${sym0}</b><br>≈ $%{y:,.2f} USD<br>%{x|%b %d, %Y %H:%M}<extra></extra>`
      : `<b>%{customdata:,.2f} ${sym0}</b><br>%{x|%b %d, %Y %H:%M}<extra></extra>`,
    type: "scatter" as const,
    mode: "lines+markers" as const,
    name: name0,
    line: { color: "#6366f1", width: 2 },
    marker: { size: 4 },
    yaxis: "y" as const,
  };

  const trace1 = {
    x: timestamps,
    y: r1,
    customdata: raw1,
    hovertemplate: useUsd
      ? `<b>%{customdata:,.2f} ${sym1}</b><br>≈ $%{y:,.2f} USD<br>%{x|%b %d, %Y %H:%M}<extra></extra>`
      : `<b>%{customdata:,.2f} ${sym1}</b><br>%{x|%b %d, %Y %H:%M}<extra></extra>`,
    type: "scatter" as const,
    mode: "lines+markers" as const,
    name: name1,
    line: { color: "#22d3ee", width: 2 },
    marker: { size: 4 },
    yaxis: "y" as const,
  };

  const layout = {
    ...PLOTLY_BASE_LAYOUT,
    font: { ...PLOTLY_BASE_LAYOUT.font, size: 11 },
    xaxis: makeDateXAxis(RANGE_SELECTOR_BUTTONS_HOURLY),
    yaxis: { title: { text: yAxisTitle }, ...PLOTLY_AXIS_DEFAULTS },
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
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-2 sm:p-4 mb-4 overflow-hidden">
      <div className="flex items-baseline gap-2 mb-3">
        <h3 className="text-sm font-medium text-slate-400">Reserve History</h3>
        {subtitle && <span className="text-xs text-slate-600">{subtitle}</span>}
      </div>
      <Plot
        data={[trace0, trace1]}
        layout={layout}
        config={PLOTLY_CONFIG}
        style={{ width: "100%", height: 320 }}
        useResizeHandler
      />
    </div>
  );
}
