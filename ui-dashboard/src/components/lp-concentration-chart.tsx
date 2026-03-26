"use client";

import dynamic from "next/dynamic";
import { PLOTLY_BASE_LAYOUT, PLOTLY_CONFIG } from "@/lib/plot";
import { truncateAddress } from "@/lib/format";

const Plot = dynamic(() => import("react-plotly.js"), { ssr: false });

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Returns the human-readable display label for an LP pie chart entry.
 * - If getLabel resolves a named label (different from the truncated address),
 *   that name is returned.
 * - Otherwise the truncated address is returned.
 */
export function resolvePieLabel(
  addr: string,
  getLabel?: (address: string) => string,
): string {
  const truncated = truncateAddress(addr) ?? addr;
  if (!getLabel) return truncated;
  const resolved = getLabel(addr);
  return resolved !== truncated ? resolved : truncated;
}

interface LpPosition {
  address: string;
  netLiquidity: bigint;
}

interface LpConcentrationChartProps {
  positions: LpPosition[]; // pre-sorted descending by netLiquidity
  totalLiquidity: bigint;
  /** Optional resolver: returns a human-readable label for an address */
  getLabel?: (address: string) => string;
}

export function LpConcentrationChart({
  positions,
  totalLiquidity,
  getLabel,
}: LpConcentrationChartProps) {
  if (positions.length === 0 || totalLiquidity === BigInt(0)) return null;

  const TOP_N = 10;
  const top = positions.slice(0, TOP_N);
  const rest = positions.slice(TOP_N);
  const otherTotal = rest.reduce((acc, p) => acc + p.netLiquidity, BigInt(0));

  // Human-readable labels for both legend and hover. If two addresses share the
  // same label they collapse into one slice — accepted trade-off for readability.
  const labels = [
    ...top.map((p) => resolvePieLabel(p.address, getLabel)),
    ...(otherTotal > BigInt(0) ? ["Other"] : []),
  ];

  // Scale to basis points (×10000) before converting to Number so that large
  // bigint values (which can exceed JS safe integer range) don't lose precision
  // in the relative proportions used for pie slice sizes.
  const toRelative = (v: bigint) =>
    Number((v * BigInt(10_000)) / totalLiquidity) / 10000;
  const values = [
    ...top.map((p) => toRelative(p.netLiquidity)),
    ...(otherTotal > BigInt(0) ? [toRelative(otherTotal)] : []),
  ];

  const hovertemplate = "%{label}<br>%{percent} of pool<br><extra></extra>";

  const trace = {
    type: "pie" as const,
    hole: 0.4,
    labels,
    values,
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
