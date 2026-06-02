"use client";

import dynamic from "next/dynamic";
import type { Pool, PoolSnapshot } from "@/lib/types";
import { parseWei } from "@/lib/format";
import type { Network } from "@/lib/networks";
import { forwardFillSeries, zeroFillSeries } from "@/lib/chart-gap-fill";
import {
  PLOTLY_BASE_LAYOUT,
  PLOTLY_AXIS_DEFAULTS,
  PLOTLY_LEGEND,
  PLOTLY_CONFIG,
  RANGE_SELECTOR_BUTTONS_DAILY,
  makeDateXAxis,
} from "@/lib/plot";
import { SECONDS_PER_DAY } from "@/lib/time-series";
import { isFpmm, isFxPool } from "@/lib/tokens";
import { fxWeekendBands } from "@/lib/weekend";

const Plot = dynamic(() => import("react-plotly.js"), { ssr: false });

interface SnapshotChartProps {
  snapshots: PoolSnapshot[];
  token0Symbol?: string;
  token1Symbol?: string;
  pool?: Pool | null;
  network?: Network;
  rebalanceTimestamps?: string[];
}

type DailyRange = {
  from: number;
  to: number;
  bucketSeconds: number;
};

type SnapshotChartSeries = {
  days: string[];
  vol0: number[];
  vol1: number[];
  cumSwaps: Array<number | null>;
  range: DailyRange;
};

function makeRebalanceShapes(
  rebalanceTimestamps: string[] | undefined,
): Plotly.Layout["shapes"] {
  return (rebalanceTimestamps ?? []).map((ts) => ({
    type: "line" as const,
    xref: "x" as const,
    yref: "paper" as const,
    x0: new Date(Number(ts) * 1000).toISOString().slice(0, 10),
    x1: new Date(Number(ts) * 1000).toISOString().slice(0, 10),
    y0: 0,
    y1: 1,
    line: { color: "#f59e0b", width: 1, dash: "dot" as const },
    layer: "above" as const,
  }));
}

function dayBucket(timestamp: number): number {
  return Math.floor(timestamp / SECONDS_PER_DAY) * SECONDS_PER_DAY;
}

function currentDayBucket(): number {
  return dayBucket(Math.floor(Date.now() / 1000));
}

function dailyRange(snapshots: PoolSnapshot[]): DailyRange {
  const first = snapshots[0]!;
  const last = snapshots[snapshots.length - 1]!;
  const from = dayBucket(Number(first.timestamp));
  const lastSnapshotEnd = dayBucket(Number(last.timestamp)) + SECONDS_PER_DAY;
  const todayEnd = currentDayBucket() + SECONDS_PER_DAY;
  return {
    from,
    to: Math.max(lastSnapshotEnd, todayEnd),
    bucketSeconds: SECONDS_PER_DAY,
  };
}

function buildSnapshotChartSeries(
  sorted: PoolSnapshot[],
  pool: Pool,
): SnapshotChartSeries {
  const range = dailyRange(sorted);
  const vol0Series = zeroFillSeries(
    sorted.map((s) => ({
      timestamp: Number(s.timestamp),
      value: parseWei(s.swapVolume0, pool.token0Decimals ?? 18),
    })),
    range,
  );
  const vol1Series = zeroFillSeries(
    sorted.map((s) => ({
      timestamp: Number(s.timestamp),
      value: parseWei(s.swapVolume1, pool.token1Decimals ?? 18),
    })),
    range,
  );
  const cumSwapSeries = forwardFillSeries(
    sorted.map((s) => ({
      timestamp: Number(s.timestamp),
      value: s.cumulativeSwapCount,
    })),
    range,
  );

  return {
    days: vol0Series.map((point) =>
      new Date(point.timestamp * 1000).toISOString().slice(0, 10),
    ),
    vol0: vol0Series.map((point) => point.value),
    vol1: vol1Series.map((point) => point.value),
    cumSwaps: cumSwapSeries.map((point) => point.value ?? null),
    range,
  };
}

function makeFxWeekendShapes({
  pool,
  network,
  from,
  to,
}: {
  pool: Pool | null | undefined;
  network: Network | undefined;
  from: number;
  to: number;
}): Plotly.Layout["shapes"] {
  if (!pool || !network || !isFpmm(pool)) return [];
  if (!isFxPool(network, pool.token0 ?? null, pool.token1 ?? null)) return [];
  return fxWeekendBands({ from, to });
}

function makeSnapshotLayout(
  shapes: Plotly.Layout["shapes"],
): Partial<Plotly.Layout> {
  return {
    ...PLOTLY_BASE_LAYOUT,
    shapes,
    font: { ...PLOTLY_BASE_LAYOUT.font, size: 11 },
    barmode: "stack",
    xaxis: makeDateXAxis(RANGE_SELECTOR_BUTTONS_DAILY),
    yaxis: {
      title: { text: "Volume", font: { size: 10 } },
      ...PLOTLY_AXIS_DEFAULTS,
    },
    yaxis2: {
      title: { text: "Swaps", font: { size: 10 } },
      overlaying: "y",
      side: "right",
      gridcolor: "transparent",
      linecolor: "#334155",
      tickcolor: "#334155",
    },
    legend: {
      ...PLOTLY_LEGEND,
      orientation: "h",
      x: 0.5,
      y: -0.45,
      xanchor: "center",
      yanchor: "top",
      font: { size: 10 },
    },
    margin: { t: 8, l: 40, r: 36, b: 8 },
    autosize: true,
    dragmode: "pan",
  };
}

export function SnapshotChart({
  snapshots,
  token0Symbol = "Token 0",
  token1Symbol = "Token 1",
  pool,
  network,
  rebalanceTimestamps,
}: SnapshotChartProps) {
  if (snapshots.length === 0) return null;
  if (pool?.tokenDecimalsKnown !== true) return null;

  // Query returns desc (newest-first) to preserve recent rows when the 1000-row
  // cap truncates old history. Sort here so Plotly receives chronological order.
  const sorted = [...snapshots].sort(
    (a, b) => Number(a.timestamp) - Number(b.timestamp),
  );
  const { days, vol0, vol1, cumSwaps, range } = buildSnapshotChartSeries(
    sorted,
    pool,
  );
  const shapes = [
    ...makeFxWeekendShapes({
      pool,
      network,
      from: range.from,
      to: range.to,
    }),
    ...makeRebalanceShapes(rebalanceTimestamps),
  ];

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

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-2 sm:p-4 mb-4 overflow-hidden">
      <h3 className="text-sm font-medium text-slate-400 mb-3">
        Daily Swap Volume
      </h3>
      <Plot
        data={[volumeTrace0, volumeTrace1, cumSwapTrace]}
        layout={makeSnapshotLayout(shapes)}
        config={PLOTLY_CONFIG}
        style={{ width: "100%", height: 380 }}
        useResizeHandler
      />
    </div>
  );
}
