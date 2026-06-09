"use client";

import dynamic from "next/dynamic";
import { useMemo, useState, type ReactNode } from "react";
import { formatUSD } from "@/lib/format";
import {
  snapshotWindow7d,
  snapshotWindow30d,
  type TimeRange,
} from "@/lib/volume";
import type { NetworkData } from "@/hooks/use-all-networks-data";
import { buildDailyFeeSeries } from "@/lib/revenue";
import type { CdpBorrowingFeeSeriesPoint } from "@/lib/cdp-borrowing-revenue";
import { weekOverWeekChangePct } from "@/components/volume-over-time-chart";
import { PLOTLY_BASE_LAYOUT, PLOTLY_CONFIG } from "@/lib/plot";
import { RANGES, SECONDS_PER_DAY, type RangeKey } from "@/lib/time-series";

const PlotSkeleton = () => (
  <div className="h-[200px] animate-pulse rounded bg-slate-800/30" />
);

const Plot = dynamic(() => import("react-plotly.js"), {
  ssr: false,
  loading: PlotSkeleton,
});

interface FeeOverTimeChartProps {
  networkData: NetworkData[];
  borrowingFeeSeries: CdpBorrowingFeeSeriesPoint[];
  isLoading: boolean;
  isBorrowingFeesLoading: boolean;
  hasError: boolean;
  hasFeesError: boolean;
  hasBorrowingFeesError: boolean;
  /** True when fee data is approximate (unpriced tokens, truncated query, etc.) */
  isApproximate: boolean;
  isBorrowingFeesApproximate: boolean;
}

type SwapFeeSeriesPoint = ReturnType<typeof buildDailyFeeSeries>[number];

type TotalFeeSeriesPoint = {
  timestamp: number;
  swapFeesUSD: number;
  borrowingFeesUSD: number;
  totalFeesUSD: number;
};

type TotalFeeBucket = {
  swapFeesUSD: number;
  borrowingFeesUSD: number;
};

type FillType =
  | "tozeroy"
  | "tonexty"
  | "none"
  | "tozerox"
  | "tonextx"
  | "toself"
  | "tonext";

type FeeTrace = {
  x: string[];
  y: number[];
  type: "scatter";
  mode: "lines";
  name: string;
  line: { color: string; width: number };
  fill: FillType;
  fillcolor: string;
  stackgroup?: string;
  hovertemplate: string;
};

function pointSwapFeesUSD(point: SwapFeeSeriesPoint): number {
  return point.protocolFeesUSD + point.lpFeesUSD;
}

function dayBucket(timestampSeconds: number): number {
  return Math.floor(timestampSeconds / SECONDS_PER_DAY) * SECONDS_PER_DAY;
}

function dayAlignWindow(window: TimeRange): TimeRange {
  const days = Math.ceil((window.to - window.from) / SECONDS_PER_DAY);
  const lastBucketDayStart = dayBucket(window.to - 1);
  return {
    from: lastBucketDayStart - (days - 1) * SECONDS_PER_DAY,
    to: window.to,
  };
}

function emptyTotalFeeBucket(): TotalFeeBucket {
  return { swapFeesUSD: 0, borrowingFeesUSD: 0 };
}

function isTimestampInWindow(
  timestamp: number,
  alignedWindow: TimeRange | undefined,
): boolean {
  return (
    alignedWindow === undefined ||
    (timestamp >= alignedWindow.from && timestamp < alignedWindow.to)
  );
}

function addTotalFeeBucket(
  buckets: Map<number, TotalFeeBucket>,
  timestamp: number,
  value: Partial<TotalFeeBucket>,
  alignedWindow: TimeRange | undefined,
): void {
  if (!isTimestampInWindow(timestamp, alignedWindow)) return;
  const bucket = buckets.get(timestamp) ?? emptyTotalFeeBucket();
  bucket.swapFeesUSD += value.swapFeesUSD ?? 0;
  bucket.borrowingFeesUSD += value.borrowingFeesUSD ?? 0;
  buckets.set(timestamp, bucket);
}

function addSwapSeriesToBuckets(
  buckets: Map<number, TotalFeeBucket>,
  swapSeries: ReadonlyArray<SwapFeeSeriesPoint>,
  alignedWindow: TimeRange | undefined,
): void {
  for (const point of swapSeries) {
    addTotalFeeBucket(
      buckets,
      point.timestamp,
      { swapFeesUSD: pointSwapFeesUSD(point) },
      alignedWindow,
    );
  }
}

function addBorrowingSeriesToBuckets(
  buckets: Map<number, TotalFeeBucket>,
  borrowingSeries: ReadonlyArray<CdpBorrowingFeeSeriesPoint>,
  alignedWindow: TimeRange | undefined,
): void {
  for (const point of borrowingSeries) {
    addTotalFeeBucket(
      buckets,
      point.timestamp,
      { borrowingFeesUSD: point.totalFeesUSD },
      alignedWindow,
    );
  }
}

function valuedBucketTimestamps(
  buckets: ReadonlyMap<number, TotalFeeBucket>,
): number[] {
  const timestamps: number[] = [];
  for (const [timestamp, bucket] of buckets) {
    if (bucket.swapFeesUSD > 0 || bucket.borrowingFeesUSD > 0) {
      timestamps.push(timestamp);
    }
  }
  return timestamps;
}

function buildTotalSeriesFromBuckets(args: {
  buckets: ReadonlyMap<number, TotalFeeBucket>;
  valuedTimestamps: number[];
  alignedWindow: TimeRange | undefined;
  nowSeconds: number;
}): TotalFeeSeriesPoint[] {
  const startBucket =
    args.alignedWindow?.from ?? Math.min(...args.valuedTimestamps);
  const endRef =
    args.alignedWindow?.to ?? Math.max(0, Math.floor(args.nowSeconds));
  const endBucket = dayBucket(endRef);
  const lastBucket =
    endRef > endBucket ? endBucket : endBucket - SECONDS_PER_DAY;
  if (lastBucket < startBucket) return [];

  const series: TotalFeeSeriesPoint[] = [];
  for (
    let timestamp = startBucket;
    timestamp <= lastBucket;
    timestamp += SECONDS_PER_DAY
  ) {
    const bucket = args.buckets.get(timestamp);
    const swapFeesUSD = bucket?.swapFeesUSD ?? 0;
    const borrowingFeesUSD = bucket?.borrowingFeesUSD ?? 0;
    series.push({
      timestamp,
      swapFeesUSD,
      borrowingFeesUSD,
      totalFeesUSD: swapFeesUSD + borrowingFeesUSD,
    });
  }
  return series;
}

function mergeTotalFeeSeries(
  swapSeries: ReadonlyArray<SwapFeeSeriesPoint>,
  borrowingSeries: ReadonlyArray<CdpBorrowingFeeSeriesPoint>,
  window?: TimeRange,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): TotalFeeSeriesPoint[] {
  const alignedWindow = window ? dayAlignWindow(window) : undefined;
  const buckets = new Map<number, TotalFeeBucket>();
  addSwapSeriesToBuckets(buckets, swapSeries, alignedWindow);
  addBorrowingSeriesToBuckets(buckets, borrowingSeries, alignedWindow);

  const valuedTimestamps = valuedBucketTimestamps(buckets);
  if (valuedTimestamps.length === 0) return [];
  return buildTotalSeriesFromBuckets({
    buckets,
    valuedTimestamps,
    alignedWindow,
    nowSeconds,
  });
}

function selectedRangeWindow(
  range: RangeKey,
  networkData: ReadonlyArray<NetworkData>,
): TimeRange | undefined {
  if (range === "all") return undefined;
  const fetchWindows = networkData[0]?.snapshotWindows;
  if (fetchWindows) {
    return range === "7d" ? fetchWindows.w7d : fetchWindows.w30d;
  }
  return range === "7d"
    ? snapshotWindow7d(Date.now())
    : snapshotWindow30d(Date.now());
}

function buildSwapTrace(
  xs: string[],
  series: ReadonlyArray<TotalFeeSeriesPoint>,
  stacked: boolean,
): FeeTrace {
  return {
    x: xs,
    y: series.map((p) => p.swapFeesUSD),
    type: "scatter" as const,
    mode: "lines" as const,
    name: "Swap Fees",
    line: { color: "#6366f1", width: 2 },
    fill: "tozeroy",
    fillcolor: "rgba(99,102,241,0.15)",
    ...(stacked ? { stackgroup: "fees" } : {}),
    hovertemplate: "<b>Swap: $%{y:,.2f}</b><br>%{x|%b %d, %Y}<extra></extra>",
  };
}

function buildBorrowingTrace(
  xs: string[],
  series: ReadonlyArray<TotalFeeSeriesPoint>,
): FeeTrace {
  return {
    x: xs,
    y: series.map((p) => p.borrowingFeesUSD),
    type: "scatter" as const,
    mode: "lines" as const,
    name: "Borrowing Fees",
    line: { color: "#34d399", width: 1.5 },
    fill: "tonexty",
    fillcolor: "rgba(52,211,153,0.12)",
    stackgroup: "fees",
    hovertemplate:
      "<b>Borrowing: $%{y:,.2f}</b><br>%{x|%b %d, %Y}<extra></extra>",
  };
}

function yAxisRange(
  series: ReadonlyArray<TotalFeeSeriesPoint>,
): [number, number] {
  const allYs = series.map((p) => p.totalFeesUSD);
  const ymin = allYs.length > 0 ? Math.min(...allYs) : 0;
  const ymax = allYs.length > 0 ? Math.max(...allYs) : 1;
  const span = Math.max(ymax - ymin, ymax * 0.02, 1);
  return [Math.max(0, ymin - span * 0.1), ymax + span * 0.35];
}

function buildFeeChartFigure(
  series: ReadonlyArray<TotalFeeSeriesPoint>,
  hasBorrowingFees: boolean,
) {
  const xs = series.map((p) => new Date(p.timestamp * 1000).toISOString());
  const traces = [buildSwapTrace(xs, series, hasBorrowingFees)];
  if (hasBorrowingFees) traces.push(buildBorrowingTrace(xs, series));

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
        range: yAxisRange(series),
        fixedrange: true,
      },
      showlegend: hasBorrowingFees,
      legend: {
        x: 0,
        y: -0.15,
        orientation: "h" as const,
        font: { color: "#94a3b8", size: 10 },
        bgcolor: "transparent",
      },
      margin: { t: 8, r: 8, b: hasBorrowingFees ? 36 : 24, l: 8 },
      autosize: true,
      dragmode: false as const,
      hovermode: "x" as const,
      hoverlabel: {
        bgcolor: "#0f172a",
        bordercolor: "#6366f1",
        font: { color: "#e2e8f0", size: 12, family: "inherit" },
      },
    },
  };
}

type FeeChartFigure = ReturnType<typeof buildFeeChartFigure>;

function FeeChartHeader({
  headline,
  isLoading,
  change,
  hasAnyFeeError,
  isChartApproximate,
}: {
  headline: string;
  isLoading: boolean;
  change: number | null;
  hasAnyFeeError: boolean;
  isChartApproximate: boolean;
}) {
  const deltaPill =
    change === null || isLoading || hasAnyFeeError ? null : (
      <span className={change >= 0 ? "text-emerald-400" : "text-red-400"}>
        {change >= 0 ? "+" : ""}
        {change.toFixed(2)}%
      </span>
    );

  return (
    <div>
      <p className="text-sm text-slate-400">Total Fees</p>
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
            {deltaPill}
            {deltaPill && (
              <span className="text-slate-500">week-over-week</span>
            )}
            {hasAnyFeeError && (
              <span className="text-xs text-slate-500">· partial data</span>
            )}
            {isChartApproximate && !hasAnyFeeError && (
              <span className="text-xs text-slate-500">· approximate</span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function FeeRangeSelector({
  range,
  onRangeChange,
}: {
  range: RangeKey;
  onRangeChange: (range: RangeKey) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Fee chart time range"
      className="flex gap-0.5 rounded-md bg-slate-800/50 p-0.5"
    >
      {RANGES.map((item) => (
        <button
          key={item.key}
          type="button"
          aria-pressed={range === item.key}
          onClick={() => onRangeChange(item.key)}
          className={
            "rounded px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 " +
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

function FeeChartBody({
  isLoading,
  showEmptyState,
  emptyMessage,
  figure,
}: {
  isLoading: boolean;
  showEmptyState: boolean;
  emptyMessage: ReactNode;
  figure: FeeChartFigure;
}) {
  return (
    <div className="mt-4 -mx-2 sm:-mx-3">
      {isLoading ? (
        <PlotSkeleton />
      ) : showEmptyState ? (
        <div className="flex h-[200px] items-center justify-center text-sm text-slate-500">
          {emptyMessage}
        </div>
      ) : (
        <Plot
          data={figure.traces}
          layout={figure.layout}
          config={{ ...PLOTLY_CONFIG, scrollZoom: false }}
          style={{ width: "100%", height: 200 }}
          useResizeHandler
        />
      )}
    </div>
  );
}

// The four flags above are genuinely independent — a chart can be
// simultaneously loading, have a partial fees error, and an
// approximate-data warning. Compound-component variants would force
// a Cartesian product (`Chart.Loading.WithError.Approximate`) without
// removing any meaningful state.
// react-doctor-disable-next-line react-doctor/no-many-boolean-props
export function FeeOverTimeChart({
  networkData,
  borrowingFeeSeries,
  isLoading,
  isBorrowingFeesLoading,
  hasError,
  hasFeesError,
  hasBorrowingFeesError,
  isApproximate,
  isBorrowingFeesApproximate,
}: FeeOverTimeChartProps) {
  const [range, setRange] = useState<RangeKey>("30d");

  const fullSwapSeries = useMemo(
    () => buildDailyFeeSeries(networkData),
    [networkData],
  );

  const selectedWindow = useMemo(
    () => selectedRangeWindow(range, networkData),
    [networkData, range],
  );

  const visibleSwapSeries = useMemo(
    () =>
      selectedWindow
        ? buildDailyFeeSeries(networkData, selectedWindow)
        : fullSwapSeries,
    [networkData, selectedWindow, fullSwapSeries],
  );

  const fullSeries = useMemo(
    () => mergeTotalFeeSeries(fullSwapSeries, borrowingFeeSeries),
    [fullSwapSeries, borrowingFeeSeries],
  );

  const visibleSeries = useMemo(
    () =>
      mergeTotalFeeSeries(
        visibleSwapSeries,
        borrowingFeeSeries,
        selectedWindow,
      ),
    [visibleSwapSeries, borrowingFeeSeries, selectedWindow],
  );

  const hasBorrowingFees = useMemo(
    () => fullSeries.some((p) => p.borrowingFeesUSD > 0),
    [fullSeries],
  );

  const rangeTotal = useMemo(
    () => visibleSeries.reduce((sum, p) => sum + p.totalFeesUSD, 0),
    [visibleSeries],
  );

  // Adapt for the weekOverWeekChangePct helper which expects { timestamp, value }
  const fullAsTimeSeries = useMemo(
    () =>
      fullSeries.map((p) => ({
        timestamp: p.timestamp,
        value: p.totalFeesUSD,
      })),
    [fullSeries],
  );

  const isChartLoading = isLoading || isBorrowingFeesLoading;
  const hasAnyFeeError = hasError || hasFeesError || hasBorrowingFeesError;
  const isChartApproximate = isApproximate || isBorrowingFeesApproximate;
  // Fail closed: match the tile's behavior — show N/A when any chain's
  // fee fetch failed, not just when the series is empty. This prevents the
  // chart from showing a partial cross-stream total as if it were complete.
  const headline = isChartLoading
    ? "…"
    : hasAnyFeeError
      ? "N/A"
      : `${isChartApproximate ? "≈ " : ""}${formatUSD(rangeTotal)}`;

  // Suppress WoW delta when data is incomplete — a partial-chain
  // comparison is misleading.
  const change =
    range === "7d" && !hasAnyFeeError
      ? weekOverWeekChangePct(fullAsTimeSeries)
      : null;

  const figure = useMemo(
    () => buildFeeChartFigure(visibleSeries, hasBorrowingFees),
    [visibleSeries, hasBorrowingFees],
  );
  const showEmptyState =
    !isChartLoading && (visibleSeries.length === 0 || hasAnyFeeError);
  const emptyMessage = hasError
    ? "Unable to load fee history"
    : hasFeesError || hasBorrowingFeesError
      ? "Fee data partial — some fee streams failed to load"
      : "Not enough fee history yet";

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <FeeChartHeader
          headline={headline}
          isLoading={isChartLoading}
          change={change}
          hasAnyFeeError={hasAnyFeeError}
          isChartApproximate={isChartApproximate}
        />
        <FeeRangeSelector range={range} onRangeChange={setRange} />
      </div>

      <FeeChartBody
        isLoading={isChartLoading}
        showEmptyState={showEmptyState}
        emptyMessage={emptyMessage}
        figure={figure}
      />
    </section>
  );
}
