"use client";

import dynamic from "next/dynamic";
import { PLOTLY_BASE_LAYOUT, PLOTLY_CONFIG } from "@/lib/plot";
import { truncateAddress } from "@/lib/format";
import { USDM_SYMBOLS } from "@/lib/tokens";
import type { Pool } from "@/lib/types";

const Plot = dynamic(() => import("react-plotly.js"), { ssr: false });

interface LpPosition {
  address: string;
  netLiquidity: bigint;
}

interface LpConcentrationChartProps {
  positions: LpPosition[];
  totalLiquidity: bigint;
  getLabel?: (address: string | null) => string;
  pool?: Pool | null;
  sym0?: string;
  sym1?: string;
  reserves0Raw?: number;
  reserves1Raw?: number;
  feedVal?: number | null;
  usdmIsToken0?: boolean;
}

export function resolvePieLabel(
  addr: string,
  getLabel?: ((address: string | null) => string) | ((address: string) => string),
): string {
  const truncated = truncateAddress(addr) ?? addr;
  if (!getLabel) return truncated;
  const resolved = (getLabel as (address: string) => string)(addr);
  return resolved === truncated ? truncated : resolved;
}

export function LpConcentrationChart({
  positions,
  totalLiquidity,
  getLabel,
  pool,
  sym0,
  sym1,
  reserves0Raw = 0,
  reserves1Raw = 0,
  feedVal = null,
  usdmIsToken0 = false,
}: LpConcentrationChartProps) {
  if (positions.length === 0 || totalLiquidity === BigInt(0)) return null;

  const TOP_N = 10;
  const top = positions.slice(0, TOP_N);
  const rest = positions.slice(TOP_N);
  const otherTotal = rest.reduce((acc, p) => acc + p.netLiquidity, BigInt(0));

  const resolveLabel = (addr: string) => resolvePieLabel(addr, getLabel);

  const labels = [
    ...top.map((p) => resolveLabel(p.address)),
    ...(otherTotal > BigInt(0) ? ["Other"] : []),
  ];

  const toRelative = (v: bigint) =>
    Number((v * BigInt(10_000)) / totalLiquidity) / 10000;
  const values = [
    ...top.map((p) => toRelative(p.netLiquidity)),
    ...(otherTotal > BigInt(0) ? [toRelative(otherTotal)] : []),
  ];

  const customdata = [
    ...top.map((p) => resolveLabel(p.address)),
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
    height: 280,
    autosize: true,
  };

  const totalPositions = positions.length;
  const topShare =
    positions.length > 0
      ? (Number((positions[0].netLiquidity * BigInt(10_000)) / totalLiquidity) /
          100).toFixed(1)
      : "0";
  const top3Share =
    positions.length > 0
      ? (
          Number(
            (positions
              .slice(0, 3)
              .reduce((acc, p) => acc + p.netLiquidity, BigInt(0)) *
              BigInt(10_000)) /
              totalLiquidity,
          ) / 100
        ).toFixed(1)
      : "0";

  const hasPoolData = pool && (reserves0Raw > 0 || reserves1Raw > 0);
  const usdmIsToken1 = USDM_SYMBOLS.has(sym1 ?? "");
  const hasUsdmSide = usdmIsToken0 !== usdmIsToken1;
  const totalTvl: number | null =
    hasPoolData && feedVal !== null && hasUsdmSide
      ? usdmIsToken0
        ? reserves0Raw + reserves1Raw * feedVal
        : reserves0Raw * feedVal + reserves1Raw
      : null;

  const fmtUsd = (v: number) =>
    v >= 1_000_000
      ? `$${(v / 1_000_000).toFixed(2)}M`
      : v >= 1_000
        ? `$${(v / 1_000).toFixed(1)}K`
        : `$${v.toFixed(2)}`;

  const fmtReserve = (v: number, sym: string) =>
    v >= 1_000_000
      ? `${(v / 1_000_000).toFixed(2)}M ${sym}`
      : v >= 1_000
        ? `${(v / 1_000).toFixed(1)}K ${sym}`
        : `${v.toFixed(2)} ${sym}`;

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-2 sm:p-4 mb-4 overflow-hidden">
      <h3 className="text-sm font-medium text-slate-400 mb-3">
        LP Concentration
      </h3>
      <div className="flex flex-col lg:flex-row gap-4">
        <div className="flex-1 min-w-0">
          <Plot
            data={[trace]}
            layout={layout}
            config={PLOTLY_CONFIG}
            style={{ width: "100%", height: 280 }}
            useResizeHandler
          />
        </div>

        <div className="lg:w-56 flex flex-col gap-3 justify-center">
          <div className="rounded-md border border-slate-700 bg-slate-800/60 p-3 space-y-2">
            <p className="text-[10px] uppercase tracking-wider text-slate-500 font-medium">
              Providers
            </p>
            <StatRow label="Total LPs" value={String(totalPositions)} />
            <StatRow label="Top holder" value={`${topShare}%`} />
            <StatRow label="Top 3 share" value={`${top3Share}%`} />
          </div>

          {hasPoolData && (
            <div className="rounded-md border border-slate-700 bg-slate-800/60 p-3 space-y-2">
              <p className="text-[10px] uppercase tracking-wider text-slate-500 font-medium">
                Pool Reserves
              </p>
              {sym0 && <StatRow label={sym0} value={fmtReserve(reserves0Raw, sym0)} />}
              {sym1 && <StatRow label={sym1} value={fmtReserve(reserves1Raw, sym1)} />}
              {totalTvl !== null && (
                <StatRow label="Total TVL" value={fmtUsd(totalTvl)} highlight />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatRow({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-slate-400 truncate">{label}</span>
      <span
        className={`text-xs font-mono font-medium tabular-nums ${highlight ? "text-indigo-300" : "text-slate-200"}`}
      >
        {value}
      </span>
    </div>
  );
}
