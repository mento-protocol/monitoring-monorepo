"use client";

import dynamic from "next/dynamic";
import { truncateAddress } from "@/lib/format";
import { PLOTLY_BASE_LAYOUT, PLOTLY_CONFIG } from "@/lib/plot";
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

const PIE_COLORS = [
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
];

export function resolvePieLabel(
  addr: string,
  getLabel?:
    | ((address: string | null) => string)
    | ((address: string) => string),
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

  // Keep raw addresses as the slice key so Plotly never merges distinct LPs
  // that happen to share the same human-readable label.
  const labels = [
    ...top.map((p) => p.address),
    ...(otherTotal > BigInt(0) ? ["other"] : []),
  ];
  const displayLabels = [
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
    sort: false,
    direction: "clockwise" as const,
    marker: {
      colors: PIE_COLORS,
      line: { color: "#1e293b", width: 2 },
    },
  };

  const layout = {
    ...PLOTLY_BASE_LAYOUT,
    margin: { t: 8, r: 8, b: 8, l: 8 },
    showlegend: false,
    height: 280,
    autosize: true,
  };

  const totalPositions = positions.length;
  const topShare =
    positions.length > 0
      ? (
          Number(
            (positions[0].netLiquidity * BigInt(10_000)) / totalLiquidity,
          ) / 100
        ).toFixed(1)
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

  const hasPoolData = Boolean(pool) && (reserves0Raw > 0 || reserves1Raw > 0);
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
    <div className="mb-4 overflow-hidden rounded-lg border border-slate-800 bg-slate-900/60 p-2 sm:p-4">
      <h3 className="mb-3 text-sm font-medium text-slate-400">
        LP Concentration
      </h3>

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1 lg:max-w-3xl">
          <div className="flex flex-col items-start gap-4 xl:flex-row xl:items-start">
            <div className="w-full max-w-[360px] shrink-0">
              <Plot
                data={[trace]}
                layout={layout}
                config={PLOTLY_CONFIG}
                style={{ width: "100%", height: 280 }}
                useResizeHandler
              />
            </div>

            <div className="min-w-0 flex-1 xl:pt-2">
              <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-slate-500">
                Legend
              </div>
              <ul className="grid gap-2 sm:grid-cols-2">
                {displayLabels.map((label, i) => {
                  const sliceKey = labels[i] ?? `slice-${label}`;
                  return (
                    <li
                      key={sliceKey}
                      className="flex items-center gap-2 text-xs text-slate-300"
                    >
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{
                          backgroundColor: PIE_COLORS[i % PIE_COLORS.length],
                        }}
                      />
                      <span className="truncate">{label}</span>
                      <span className="ml-auto shrink-0 font-mono tabular-nums text-slate-500">
                        {(values[i] * 100).toFixed(1)}%
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        </div>

        <div className="w-full shrink-0 lg:w-64">
          <div className="rounded-md border border-slate-700 bg-slate-800/60 p-3">
            <div className="mb-3 text-[10px] font-medium uppercase tracking-wider text-slate-500">
              Pool at a glance
            </div>

            <div className="space-y-2 border-b border-slate-700/70 pb-3">
              <StatRow label="Total LPs" value={String(totalPositions)} />
              <StatRow label="Top holder" value={`${topShare}%`} />
              <StatRow label="Top 3 share" value={`${top3Share}%`} />
            </div>

            {hasPoolData && (
              <div className="mt-3 space-y-2">
                {sym0 && (
                  <StatRow
                    label={sym0}
                    value={fmtReserve(reserves0Raw, sym0)}
                  />
                )}
                {sym1 && (
                  <StatRow
                    label={sym1}
                    value={fmtReserve(reserves1Raw, sym1)}
                  />
                )}
                {totalTvl !== null && (
                  <StatRow
                    label="Estimated TVL"
                    value={fmtUsd(totalTvl)}
                    highlight
                  />
                )}
              </div>
            )}
          </div>
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
      <span className="truncate text-xs text-slate-400">{label}</span>
      <span
        className={`text-xs font-mono font-medium tabular-nums ${highlight ? "text-indigo-300" : "text-slate-200"}`}
      >
        {value}
      </span>
    </div>
  );
}
