"use client";

import dynamic from "next/dynamic";
import type { PoolSnapshot } from "@/lib/types";
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

interface SnapshotChartProps {
  snapshots: PoolSnapshot[];
  token0Symbol?: string;
  token1Symbol?: string;
}

/** Groups hourly snapshots into UTC day buckets.
 * Sums volume/swapCount per day; uses last cumulativeSwapCount in each day. */
function aggregateByDay(snapshots: PoolSnapshot[]): {
  days: string[];
  vol0: number[];
  vol1: number[];
  cumSwaps: number[];
} {
  const buckets = new Map<
    string,
    { vol0: number; vol1: number; cumSwaps: number }
  >();

  for (const s of snapshots) {
    const day = new Date(Number(s.timestamp) * 1000).toISOString().slice(0, 10); // "YYYY-MM-DD"
    const existing = buckets.get(day) ?? { vol0: 0, vol1: 0, cumSwaps: 0 };
    buckets.set(day, {
      vol0: existing.vol0 + parseWei(s.swapVolume0),
      vol1: existing.vol1 + parseWei(s.swapVolume1),
      // Last snapshot in the day has the highest cumulative count
      cumSwaps: Math.max(existing.cumSwaps, s.cumulativeSwapCount),
    });
  }

  const days = [...buckets.keys()].sort();
  return {
    days,
    vol0: days.map((d) => buckets.get(d)!.vol0),
    vol1: days.map((d) => buckets.get(d)!.vol1),
    cumSwaps: days.map((d) => buckets.get(d)!.cumSwaps),
  };
}

export function SnapshotChart({
  snapshots,
  token0Symbol = "Token 0",
  token1Symbol = "Token 1",
}: SnapshotChartProps) {
  if (snapshots.length === 0) return null;

  const { days, vol0, vol1, cumSwaps } = aggregateByDay(snapshots);

  const volumeTrace0 = {
    x: days,
    y: vol0,
    type: "bar" as const,
    name: `${token0Symbol} sold`,
    marker: { color: "#6366f1" },
    yaxis: "y" as const,
  };

  const volumeTrace1 = {
    x: days,
    y: vol1,
    type: "bar" as const,
    name: `${token1Symbol} sold`,
    marker: { color: "#a78bfa" },
    yaxis: "y" as const,
  };

  const cumSwapTrace = {
    x: days,
    y: cumSwaps,
    type: "scatter" as const,
    mode: "lines+markers" as const,
    name: "Cumulative Swaps",
    line: { color: "#22d3ee", width: 2 },
    marker: { size: 4 },
    yaxis: "y2" as const,
  };

  const layout = {
    ...PLOTLY_BASE_LAYOUT,
    font: { ...PLOTLY_BASE_LAYOUT.font, size: 11 },
    barmode: "stack" as const,
    xaxis: makeDateXAxis(RANGE_SELECTOR_BUTTONS_DAILY),
    yaxis: {
      title: { text: "Volume", font: { size: 10 } },
      ...PLOTLY_AXIS_DEFAULTS,
    },
    yaxis2: {
      title: { text: "Swaps", font: { size: 10 } },
      overlaying: "y" as const,
      side: "right" as const,
      gridcolor: "transparent",
      linecolor: "#334155",
      tickcolor: "#334155",
    },
    legend: {
      ...PLOTLY_LEGEND,
      orientation: "h" as const,
      x: 0.5,
      y: -0.45,
      xanchor: "center" as const,
      yanchor: "top" as const,
      font: { size: 10 },
    },
    margin: { t: 8, l: 40, r: 36, b: 8 },
    autosize: true,
    dragmode: "pan" as const,
  };

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-2 sm:p-4 mb-4 overflow-hidden">
      <h3 className="text-sm font-medium text-slate-400 mb-3">
        Daily Swap Volume
      </h3>
      <Plot
        data={[volumeTrace0, volumeTrace1, cumSwapTrace]}
        layout={layout}
        config={PLOTLY_CONFIG}
        style={{ width: "100%", height: 380 }}
        useResizeHandler
      />
    </div>
  );
}
