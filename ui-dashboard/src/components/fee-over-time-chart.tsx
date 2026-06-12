"use client";

import dynamic from "next/dynamic";
import { useMemo, useState, type ReactNode } from "react";
import { formatUSD } from "@/lib/format";
import { PLOTLY_BASE_LAYOUT, PLOTLY_CONFIG } from "@/lib/plot";
import {
  RANGES,
  SECONDS_PER_DAY,
  dailyBucket as dayBucket,
  type RangeKey,
} from "@/lib/time-series";
import { weekOverWeekChangePct } from "@/components/volume-over-time-chart";
import type { CanonicalRevenueDailyPoint } from "@/lib/canonical-revenue";

const PlotSkeleton = () => (
  <div className="h-[220px] animate-pulse rounded bg-slate-800/30" />
);

const Plot = dynamic(() => import("react-plotly.js"), {
  ssr: false,
  loading: PlotSkeleton,
});

type TotalRevenueChartProps = {
  series: CanonicalRevenueDailyPoint[];
  isLoading: boolean;
  partialReasons: string[];
};

type FillType =
  | "tozeroy"
  | "tonexty"
  | "none"
  | "tozerox"
  | "tonextx"
  | "toself"
  | "tonext";

type RevenueTrace = {
  x: string[];
  y: Array<number | null>;
  type: "scatter";
  mode: "lines";
  name: string;
  line: { color: string; width: number };
  fill: FillType;
  fillcolor: string;
  stackgroup: string;
  hovertemplate: string;
};

function currentDayBucket(): number {
  return dayBucket(Math.floor(Date.now() / 1000));
}

function filterSeriesByRevenueRange(
  series: ReadonlyArray<CanonicalRevenueDailyPoint>,
  range: RangeKey,
): CanonicalRevenueDailyPoint[] {
  if (range === "all") return [...series];
  const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
  const today = currentDayBucket();
  const from = today - (days - 1) * SECONDS_PER_DAY;
  return series.filter((point) => point.timestamp >= from);
}

export function revenueWeekOverWeekChangePct(
  series: ReadonlyArray<CanonicalRevenueDailyPoint>,
  range: RangeKey,
  partialReasons: readonly string[],
): number | null {
  if (range !== "7d" || partialReasons.length > 0) return null;
  return weekOverWeekChangePct(
    series.map((p) => ({
      timestamp: p.timestamp,
      value: p.totalRevenueUsd ?? 0,
    })),
  );
}

export function revenueChartEmptyMessage(
  partialReasons: readonly string[],
): string {
  return partialReasons.length > 0
    ? "Revenue history is partial because some inputs failed to load"
    : "No revenue history indexed yet";
}

function buildTrace(args: {
  xs: string[];
  y: Array<number | null>;
  name: string;
  color: string;
  fillcolor: string;
  fill: FillType;
  hoverLabel: string;
}): RevenueTrace {
  return {
    x: args.xs,
    y: args.y,
    type: "scatter",
    mode: "lines",
    name: args.name,
    line: { color: args.color, width: 1.6 },
    fill: args.fill,
    fillcolor: args.fillcolor,
    stackgroup: "revenue",
    hovertemplate: `<b>${args.hoverLabel}: $%{y:,.2f}</b><br>%{x|%b %d, %Y}<extra></extra>`,
  };
}

export function revenueChartYAxisRange(
  series: ReadonlyArray<CanonicalRevenueDailyPoint>,
): [number, number] {
  const yValues: number[] = [];
  for (const point of series) {
    const values = [
      point.swapFeesUsd,
      point.cdpBorrowingUsd,
      point.reserveYieldUsd,
      point.availableRevenueUsd,
      point.totalRevenueUsd,
    ];
    for (const value of values) {
      if (value !== null) yValues.push(value);
    }
  }
  const ymax = Math.max(0, ...yValues);
  const ymin = Math.min(0, ...yValues);
  if (ymax === 0 && ymin === 0) return [0, 1];
  const span = Math.max(ymax - ymin, Math.abs(ymax || ymin) * 0.04, 1);
  const padding = Math.max(span * 0.08, 1);
  return [ymin < 0 ? ymin - padding : 0, ymax > 0 ? ymax + padding : padding];
}

function buildRevenueChartFigure(
  series: ReadonlyArray<CanonicalRevenueDailyPoint>,
) {
  const xs = series.map((p) => new Date(p.timestamp * 1000).toISOString());
  const traces = [
    buildTrace({
      xs,
      y: series.map((p) => p.swapFeesUsd),
      name: "Swap",
      color: "#38bdf8",
      fillcolor: "rgba(56,189,248,0.15)",
      fill: "tozeroy",
      hoverLabel: "Swap",
    }),
    buildTrace({
      xs,
      y: series.map((p) => p.cdpBorrowingUsd),
      name: "CDP",
      color: "#34d399",
      fillcolor: "rgba(52,211,153,0.13)",
      fill: "tonexty",
      hoverLabel: "CDP",
    }),
    buildTrace({
      xs,
      y: series.map((p) => p.reserveYieldUsd),
      name: "Reserve",
      color: "#a78bfa",
      fillcolor: "rgba(167,139,250,0.16)",
      fill: "tonexty",
      hoverLabel: "Reserve",
    }),
  ];

  return {
    traces,
    layout: {
      ...PLOTLY_BASE_LAYOUT,
      font: { ...PLOTLY_BASE_LAYOUT.font, size: 11 },
      xaxis: {
        type: "date" as const,
        showgrid: false,
        showline: false,
        zeroline: false,
        linecolor: "transparent",
        tickcolor: "transparent",
        tickfont: { size: 10, color: "#64748b" },
        nticks: 5,
        tickformat: "%b %d",
        fixedrange: true,
      },
      yaxis: {
        showgrid: false,
        showticklabels: false,
        showline: false,
        zeroline: false,
        range: revenueChartYAxisRange(series),
        fixedrange: true,
      },
      showlegend: true,
      legend: {
        x: 0,
        y: -0.17,
        orientation: "h" as const,
        font: { color: "#94a3b8", size: 10 },
        bgcolor: "transparent",
      },
      margin: { t: 8, r: 8, b: 38, l: 8 },
      autosize: true,
      dragmode: false as const,
      hovermode: "x" as const,
      hoverlabel: {
        bgcolor: "#0f172a",
        bordercolor: "#38bdf8",
        font: { color: "#e2e8f0", size: 12, family: "inherit" },
      },
    },
  };
}

type RevenueChartFigure = ReturnType<typeof buildRevenueChartFigure>;

function RangeSelector({
  range,
  onRangeChange,
}: {
  range: RangeKey;
  onRangeChange: (range: RangeKey) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Revenue chart time range"
      className="flex gap-0.5 rounded-md bg-slate-800/50 p-0.5"
    >
      {RANGES.map((item) => (
        <button
          key={item.key}
          type="button"
          aria-pressed={range === item.key}
          onClick={() => onRangeChange(item.key)}
          className={
            "rounded px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 " +
            (range === item.key
              ? "bg-slate-700 text-white shadow-sm"
              : "text-slate-400 hover:text-slate-200")
          }
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function RevenueChartHeader({
  headline,
  change,
  isLoading,
  partialReasons,
}: {
  headline: string;
  change: number | null;
  isLoading: boolean;
  partialReasons: string[];
}) {
  const isPartial = partialReasons.length > 0;
  return (
    <div>
      <p className="text-sm text-slate-400">Total Revenue</p>
      <p className="mt-1 font-mono text-3xl font-semibold tracking-tight text-white sm:text-4xl">
        {isLoading ? (
          <span className="inline-block h-[1em] w-36 animate-pulse rounded bg-slate-800/60 align-middle" />
        ) : (
          headline
        )}
      </p>
      <div className="mt-1 flex h-5 items-center gap-1.5 font-mono text-sm">
        {isLoading ? (
          <span className="h-3 w-24 animate-pulse rounded bg-slate-800/40" />
        ) : (
          <>
            {change !== null ? (
              <span
                className={change >= 0 ? "text-emerald-400" : "text-red-400"}
              >
                {change >= 0 ? "+" : ""}
                {change.toFixed(2)}%
              </span>
            ) : null}
            {change !== null ? (
              <span className="text-slate-500">week-over-week</span>
            ) : null}
            {isPartial ? (
              <span className="text-xs text-slate-500">partial data</span>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function RevenueChartBody({
  isLoading,
  showEmptyState,
  emptyMessage,
  figure,
}: {
  isLoading: boolean;
  showEmptyState: boolean;
  emptyMessage: ReactNode;
  figure: RevenueChartFigure;
}) {
  return (
    <div className="mt-4 -mx-2 sm:-mx-3">
      {isLoading ? (
        <PlotSkeleton />
      ) : showEmptyState ? (
        <div className="flex h-[220px] items-center justify-center text-sm text-slate-500">
          {emptyMessage}
        </div>
      ) : (
        <Plot
          data={figure.traces}
          layout={figure.layout}
          config={{ ...PLOTLY_CONFIG, scrollZoom: false }}
          style={{ width: "100%", height: 220 }}
          useResizeHandler
        />
      )}
    </div>
  );
}

export function TotalRevenueChart({
  series,
  isLoading,
  partialReasons,
}: TotalRevenueChartProps) {
  const [range, setRange] = useState<RangeKey>("all");
  const visibleSeries = useMemo(
    () => filterSeriesByRevenueRange(series, range),
    [series, range],
  );
  const rangeTotal = useMemo(() => {
    const availableTotal = visibleSeries.reduce(
      (sum, p) => sum + p.availableRevenueUsd,
      0,
    );
    const exactTotal = visibleSeries.every((p) => p.totalRevenueUsd !== null)
      ? visibleSeries.reduce((sum, p) => sum + (p.totalRevenueUsd ?? 0), 0)
      : null;
    return { availableTotal, exactTotal };
  }, [visibleSeries]);
  const change = revenueWeekOverWeekChangePct(series, range, partialReasons);
  const headline =
    rangeTotal.exactTotal === null
      ? `≈ ${formatUSD(rangeTotal.availableTotal)}`
      : `${partialReasons.length > 0 ? "≈ " : ""}${formatUSD(rangeTotal.exactTotal)}`;
  const figure = useMemo(
    () => buildRevenueChartFigure(visibleSeries),
    [visibleSeries],
  );
  const hasAnyRevenue = series.some((point) => point.availableRevenueUsd !== 0);
  const showEmptyState = !isLoading && !hasAnyRevenue;

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <RevenueChartHeader
          headline={headline}
          isLoading={isLoading}
          change={change}
          partialReasons={partialReasons}
        />
        <RangeSelector range={range} onRangeChange={setRange} />
      </div>
      {partialReasons.length > 0 ? (
        <p className="mt-3 text-xs text-slate-500">
          {partialReasons.join(" ")}
        </p>
      ) : null}
      <RevenueChartBody
        isLoading={isLoading}
        showEmptyState={showEmptyState}
        emptyMessage={revenueChartEmptyMessage(partialReasons)}
        figure={figure}
      />
    </section>
  );
}
