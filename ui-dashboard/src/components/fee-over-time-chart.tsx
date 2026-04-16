"use client";

import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { formatUSD } from "@/lib/format";
import { snapshotWindow7d, snapshotWindow30d } from "@/lib/volume";
import type { NetworkData } from "@/hooks/use-all-networks-data";
import { buildDailyFeeSeries } from "@/lib/revenue";
import { weekOverWeekChangePct } from "@/components/volume-over-time-chart";
import { PLOTLY_BASE_LAYOUT, PLOTLY_CONFIG } from "@/lib/plot";

type RangeKey = "7d" | "30d" | "all";

const RANGES: ReadonlyArray<{ key: RangeKey; label: string }> = [
  { key: "7d", label: "1W" },
  { key: "30d", label: "1M" },
  { key: "all", label: "All" },
];

const PlotSkeleton = () => (
  <div className="h-[200px] animate-pulse rounded bg-slate-800/30" />
);

const Plot = dynamic(() => import("react-plotly.js"), {
  ssr: false,
  loading: PlotSkeleton,
});

interface FeeOverTimeChartProps {
  networkData: NetworkData[];
  isLoading: boolean;
  hasError: boolean;
  hasFeesError: boolean;
  /** True when fee data is approximate (unpriced tokens, truncated query, etc.) */
  isApproximate: boolean;
}

export function FeeOverTimeChart({
  networkData,
  isLoading,
  hasError,
  hasFeesError,
  isApproximate,
}: FeeOverTimeChartProps) {
  const [range, setRange] = useState<RangeKey>("30d");

  const fullSeries = useMemo(
    () => buildDailyFeeSeries(networkData),
    [networkData],
  );

  const visibleSeries = useMemo(() => {
    if (range === "all") return fullSeries;
    const fetchWindows = networkData[0]?.snapshotWindows;
    const window = fetchWindows
      ? range === "7d"
        ? fetchWindows.w7d
        : fetchWindows.w30d
      : range === "7d"
        ? snapshotWindow7d(Date.now())
        : snapshotWindow30d(Date.now());
    return buildDailyFeeSeries(networkData, window);
  }, [networkData, range, fullSeries]);

  const hasLpFees = useMemo(
    () => fullSeries.some((p) => p.lpFeesUSD > 0),
    [fullSeries],
  );

  const rangeTotal = useMemo(
    () =>
      visibleSeries.reduce(
        (sum, p) => sum + p.protocolFeesUSD + p.lpFeesUSD,
        0,
      ),
    [visibleSeries],
  );

  // Adapt for the weekOverWeekChangePct helper which expects { timestamp, value }
  const fullAsTimeSeries = useMemo(
    () =>
      fullSeries.map((p) => ({
        timestamp: p.timestamp,
        value: p.protocolFeesUSD + p.lpFeesUSD,
      })),
    [fullSeries],
  );

  const approxPrefix = isApproximate ? "≈ " : "";
  const headline = isLoading
    ? "…"
    : hasError || (hasFeesError && fullSeries.length === 0)
      ? "N/A"
      : `${approxPrefix}${formatUSD(rangeTotal)}`;

  const change =
    range === "7d" ? weekOverWeekChangePct(fullAsTimeSeries) : null;

  const { traces, layout } = useMemo(() => {
    const xs = visibleSeries.map((p) =>
      new Date(p.timestamp * 1000).toISOString(),
    );

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
      stackgroup: string | undefined;
      hovertemplate: string;
    };

    const protocolTrace: FeeTrace = {
      x: xs,
      y: visibleSeries.map((p) => p.protocolFeesUSD),
      type: "scatter" as const,
      mode: "lines" as const,
      name: "Protocol Fees",
      line: { color: "#6366f1", width: 2 },
      fill: "tozeroy",
      fillcolor: "rgba(99,102,241,0.15)",
      stackgroup: hasLpFees ? "fees" : undefined,
      hovertemplate:
        "<b>Protocol: $%{y:,.2f}</b><br>%{x|%b %d, %Y}<extra></extra>",
    };

    const chartTraces: FeeTrace[] = [protocolTrace];

    if (hasLpFees) {
      chartTraces.push({
        x: xs,
        y: visibleSeries.map((p) => p.lpFeesUSD),
        type: "scatter" as const,
        mode: "lines" as const,
        name: "LP Fees",
        line: { color: "#818cf8", width: 1.5 },
        fill: "tonexty",
        fillcolor: "rgba(129,140,248,0.10)",
        stackgroup: "fees",
        hovertemplate: "<b>LP: $%{y:,.2f}</b><br>%{x|%b %d, %Y}<extra></extra>",
      });
    }

    const allYs = visibleSeries.map((p) => p.protocolFeesUSD + p.lpFeesUSD);
    const ymin = allYs.length > 0 ? Math.min(...allYs) : 0;
    const ymax = allYs.length > 0 ? Math.max(...allYs) : 1;
    const span = Math.max(ymax - ymin, ymax * 0.02, 1);
    const yRange: [number, number] = [
      Math.max(0, ymin - span * 0.1),
      ymax + span * 0.35,
    ];

    return {
      traces: chartTraces,
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
          range: yRange,
          fixedrange: true,
        },
        showlegend: hasLpFees,
        legend: {
          x: 0,
          y: -0.15,
          orientation: "h" as const,
          font: { color: "#94a3b8", size: 10 },
          bgcolor: "transparent",
        },
        margin: { t: 8, r: 8, b: hasLpFees ? 36 : 24, l: 8 },
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
  }, [visibleSeries, hasLpFees]);

  const deltaPill =
    change === null || isLoading || hasError ? null : (
      <span className={change >= 0 ? "text-emerald-400" : "text-red-400"}>
        {change >= 0 ? "+" : ""}
        {change.toFixed(2)}%
      </span>
    );

  const showEmptyState = !isLoading && visibleSeries.length === 0;

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-slate-400">Swap Fees</p>
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
                {(hasError || hasFeesError) && (
                  <span className="text-xs text-slate-500">· partial data</span>
                )}
                {isApproximate && !hasError && !hasFeesError && (
                  <span className="text-xs text-slate-500">· approximate</span>
                )}
              </>
            )}
          </div>
        </div>

        <div
          role="group"
          aria-label="Fee chart time range"
          className="flex gap-0.5 rounded-md bg-slate-800/50 p-0.5"
        >
          {RANGES.map((item) => {
            const active = range === item.key;
            return (
              <button
                key={item.key}
                type="button"
                aria-pressed={active}
                onClick={() => setRange(item.key)}
                className={
                  "rounded px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 " +
                  (active
                    ? "bg-slate-700 text-white shadow-sm"
                    : "text-slate-400 hover:text-slate-200")
                }
              >
                {item.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-4 -mx-2 sm:-mx-3">
        {isLoading ? (
          <PlotSkeleton />
        ) : showEmptyState ? (
          <div className="flex h-[200px] items-center justify-center text-sm text-slate-500">
            {hasError
              ? "Unable to load fee history"
              : hasFeesError
                ? "Fee data partial — some chains failed to load"
                : "Not enough fee history yet"}
          </div>
        ) : (
          <Plot
            data={traces}
            layout={layout}
            config={{ ...PLOTLY_CONFIG, scrollZoom: false }}
            style={{ width: "100%", height: 200 }}
            useResizeHandler
          />
        )}
      </div>
    </section>
  );
}
