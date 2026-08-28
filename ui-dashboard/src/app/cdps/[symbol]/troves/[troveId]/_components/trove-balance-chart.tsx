"use client";

import dynamic from "next/dynamic";
import { useMemo, useRef, useState } from "react";
import { StaleRefreshNotice } from "@/components/feedback";
import { useDeferredMount } from "@/components/use-deferred-mount";
import {
  escapePlotText,
  PLOTLY_AXIS_DEFAULTS,
  PLOTLY_BASE_LAYOUT,
  PLOTLY_CONFIG,
} from "@/lib/plot";
import { dateTickFormatForSeries } from "@/lib/time-series";
import { tokenColor } from "@/lib/token-colors";
import {
  buildTroveChartSeries,
  markersInWindow,
  stepSeriesInWindow,
  troveChartRangeCutoff,
  TROVE_CHART_RANGES,
  type TroveChartMarker,
  type TroveChartPoint,
  type TroveChartRangeKey,
  type TroveChartSeries,
} from "../_lib/chart";
import type { CdpTroveLedgerEventRow } from "../_lib/ledger";

/** Plot-area height for BOTH the two- and three-panel layouts: the ICR
 *  panel's presence re-splits the fixed height into domains instead of
 *  growing the card, so a trove without price data renders without a layout
 *  jump. `TroveDetailSkeleton` mirrors this value. */
const TROVE_CHART_HEIGHT_PX = 380;

function ChartShimmer({ announce = false }: { announce?: boolean }) {
  return (
    <div
      className="animate-pulse rounded bg-slate-800/30"
      style={{ height: TROVE_CHART_HEIGHT_PX }}
      {...(announce
        ? {
            role: "status",
            "aria-live": "polite" as const,
            "aria-label": "Loading trove chart",
          }
        : {})}
    />
  );
}

const Plot = dynamic(() => import("@/lib/react-plotly-basic"), {
  ssr: false,
  loading: () => <ChartShimmer />,
});

// Hoisted for a stable identity — react-plotly.js ref-compares config and
// skips Plotly.react when unchanged (same rationale as the chart card's
// CHART_CARD_PLOTLY_CONFIG).
const TROVE_CHART_PLOTLY_CONFIG = {
  ...PLOTLY_CONFIG,
  scrollZoom: false,
} as const;

// Series hues, run through the dataviz palette validator against the
// slate-900 card surface: collateral keeps the USDm entity color and debt
// the market token's (color follows the entity, matching every other token
// chart). The two never share an axis — each series sits alone in its own
// titled panel, and that panel separation is the secondary encoding that
// covers the emerald/red CVD proximity for GBPm.
const COLL_COLOR = tokenColor("USDm");
// A ratio, deliberately outside the token palette (violet-400).
const ICR_COLOR = "#a78bfa";
const MARKER_COLORS = {
  redemption: "#f59e0b", // amber-500 — matches the rebalance markers elsewhere.
  liquidation: "#f43f5e", // rose-500 — matches the liquidation badge accent.
} as const;

const PANEL_AXIS = {
  ...PLOTLY_AXIS_DEFAULTS,
  zeroline: false,
  fixedrange: true,
  tickfont: { size: 10, color: "#64748b" },
  anchor: "x",
} as const;

const PANEL_TITLE_FONT = { size: 10 } as const;

function panelDomains(showIcr: boolean): {
  y: [number, number];
  y2: [number, number];
  y3?: [number, number];
} {
  return showIcr
    ? { y: [0.72, 1], y2: [0.36, 0.64], y3: [0, 0.28] }
    : { y: [0.55, 1], y2: [0, 0.45] };
}

function stepTrace(
  points: readonly TroveChartPoint[],
  options: {
    color: string;
    yaxis: "y" | "y2";
    hovertemplate: string;
    fillcolor?: string;
  },
): Plotly.Data {
  return {
    x: points.map((point) => new Date(point.timestamp * 1000).toISOString()),
    y: points.map((point) => point.value),
    type: "scatter",
    mode: "lines",
    line: { color: options.color, width: 2, shape: "hv" },
    ...(options.fillcolor
      ? { fill: "tozeroy" as const, fillcolor: options.fillcolor }
      : {}),
    xaxis: "x",
    yaxis: options.yaxis,
    hovertemplate: options.hovertemplate,
  };
}

/** Markers only, never a connecting line: ICR is coll×price/debt and the
 *  oracle price moves between events, so a step segment would assert the
 *  value HELD from one observation to the next — a claim the ledger cannot
 *  support. Collateral and debt do hold between events; only they get
 *  `stepTrace`. */
function observationTrace(
  points: readonly TroveChartPoint[],
  options: { color: string; yaxis: "y3"; hovertemplate: string },
): Plotly.Data {
  return {
    x: points.map((point) => new Date(point.timestamp * 1000).toISOString()),
    y: points.map((point) => point.value),
    type: "scatter",
    mode: "markers",
    marker: { color: options.color, size: 5 },
    xaxis: "x",
    yaxis: options.yaxis,
    hovertemplate: options.hovertemplate,
  };
}

function markerShapes(
  markers: readonly TroveChartMarker[],
): Plotly.Layout["shapes"] {
  return markers.map((marker) => {
    const iso = new Date(marker.timestamp * 1000).toISOString();
    return {
      type: "line" as const,
      xref: "x" as const,
      yref: "paper" as const,
      x0: iso,
      x1: iso,
      y0: 0,
      y1: 1,
      line: {
        color: MARKER_COLORS[marker.kind],
        width: 1,
        dash: "dot" as const,
      },
      layer: "above" as const,
    };
  });
}

function buildLayout(options: {
  showIcr: boolean;
  debtNotice: boolean;
  debtSymbol: string;
  tickformat: string;
  shapes: Plotly.Layout["shapes"];
}): Partial<Plotly.Layout> {
  const domains = panelDomains(options.showIcr);
  const debtTitle = {
    text: `Debt · ${escapePlotText(options.debtSymbol)}`,
    font: PANEL_TITLE_FONT,
  };
  return {
    ...PLOTLY_BASE_LAYOUT,
    font: { ...PLOTLY_BASE_LAYOUT.font, size: 11 },
    xaxis: {
      ...PLOTLY_AXIS_DEFAULTS,
      type: "date",
      showgrid: false,
      tickformat: options.tickformat,
      nticks: 6,
      fixedrange: true,
      tickfont: { size: 10, color: "#64748b" },
      // The one shared x-axis draws under the bottom panel.
      anchor: options.showIcr ? "y3" : "y2",
    },
    yaxis: {
      ...PANEL_AXIS,
      domain: domains.y,
      rangemode: "tozero",
      title: { text: "Coll · USDm", font: PANEL_TITLE_FONT },
    },
    // The batch-notice variant keeps the debt panel's frame (title, domain)
    // but empty and unscaled — the in-panel annotation below replaces the
    // series, never a gapped or zero-coerced line.
    yaxis2: options.debtNotice
      ? {
          ...PANEL_AXIS,
          domain: domains.y2,
          range: [0, 1],
          showticklabels: false,
          showgrid: false,
          title: debtTitle,
        }
      : {
          ...PANEL_AXIS,
          domain: domains.y2,
          rangemode: "tozero",
          title: debtTitle,
        },
    ...(options.showIcr && domains.y3
      ? {
          yaxis3: {
            ...PANEL_AXIS,
            domain: domains.y3,
            title: { text: "ICR %", font: PANEL_TITLE_FONT },
          },
        }
      : {}),
    ...(options.debtNotice
      ? {
          annotations: [
            {
              xref: "paper" as const,
              yref: "paper" as const,
              x: 0.5,
              xanchor: "center" as const,
              y: (domains.y2[0] + domains.y2[1]) / 2,
              yanchor: "middle" as const,
              text: "Batch data unavailable — no per-trove debt snapshots",
              showarrow: false,
              font: { color: "#fbbf24", size: 11 },
            },
          ],
        }
      : {}),
    ...(options.shapes && options.shapes.length > 0
      ? { shapes: options.shapes }
      : {}),
    margin: { t: 8, r: 8, b: 28, l: 56 },
    autosize: true,
    showlegend: false,
    dragmode: false,
    hovermode: "x",
    hoverlabel: {
      bgcolor: "#0f172a",
      bordercolor: "#6366f1",
      font: { color: "#e2e8f0", size: 12, family: "inherit" },
    },
  };
}

type TroveChartModel = {
  data: Plotly.Data[];
  layout: Partial<Plotly.Layout>;
};

function buildTroveChartModel(
  series: TroveChartSeries,
  range: TroveChartRangeKey,
  debtSymbol: string,
  nowSeconds: number,
): TroveChartModel {
  const cutoff = troveChartRangeCutoff(range, nowSeconds);
  const coll = stepSeriesInWindow(series.coll, cutoff, nowSeconds, {
    extendToNow: true,
  });
  const debt =
    series.debt == null
      ? null
      : stepSeriesInWindow(series.debt, cutoff, nowSeconds, {
          extendToNow: true,
        });
  // No anchor carry or now-extension for ICR — a synthetic vertex would
  // read as a recorded price observation. In-window points only, drawn
  // with dots so a lone observation still shows.
  const icr = series.icr.filter(
    (point) => cutoff == null || point.timestamp >= cutoff,
  );
  const showIcr = series.icrCoverage !== "none";
  const hoverDate = "%{x|%b %d, %Y %H:%M}";
  const data: Plotly.Data[] = [
    stepTrace(coll, {
      color: COLL_COLOR,
      fillcolor: `${COLL_COLOR}14`,
      yaxis: "y",
      hovertemplate: `%{y:,.2f} USDm<br>${hoverDate}<extra>Collateral</extra>`,
    }),
  ];
  if (debt != null) {
    const debtColor = tokenColor(debtSymbol);
    data.push(
      stepTrace(debt, {
        color: debtColor,
        fillcolor: `${debtColor}14`,
        yaxis: "y2",
        // Debt is denominated in the market token — never dollar-prefixed.
        hovertemplate: `%{y:,.2f} ${escapePlotText(debtSymbol)}<br>${hoverDate}<extra>Debt</extra>`,
      }),
    );
  }
  if (showIcr) {
    data.push(
      observationTrace(icr, {
        color: ICR_COLOR,
        yaxis: "y3",
        // A lone % renders literally in a Plotly hovertemplate: only %{...}
        // sequences are substituted (TEMPLATE_STRING_REGEX), so %% would
        // display two percent signs.
        hovertemplate: `%{y:,.1f}%<br>${hoverDate}<extra>ICR</extra>`,
      }),
    );
  }
  return {
    data,
    layout: buildLayout({
      showIcr,
      debtNotice: debt == null,
      debtSymbol,
      // Tick density must match the PLOTTED window, not the full history —
      // a years-old trove viewed at 7d would otherwise get month/year ticks.
      tickformat: range === "1d" ? "%H:%M" : dateTickFormatForSeries(coll),
      shapes: markerShapes(markersInWindow(series.markers, cutoff)),
    }),
  };
}

function CenteredNote({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex items-center justify-center px-4 text-center text-sm text-slate-500"
      style={{ height: TROVE_CHART_HEIGHT_PX }}
    >
      {children}
    </div>
  );
}

function TroveChartBody({
  rows,
  truncated,
  anchored,
  isLoading,
  error,
  hasLoadedOnce,
  shouldMountPlot,
  model,
  chartAriaLabel,
  chartSummary,
}: {
  rows: CdpTroveLedgerEventRow[];
  truncated: boolean;
  anchored: boolean;
  isLoading: boolean;
  error: Error | undefined;
  hasLoadedOnce: boolean;
  shouldMountPlot: boolean;
  model: TroveChartModel;
  chartAriaLabel: string;
  chartSummary: string;
}) {
  if (error != null && !hasLoadedOnce) {
    // The ledger table below owns the role="alert" for this same failed
    // query — a second alert here would double-announce one failure.
    return (
      <CenteredNote>
        Chart unavailable — the trove ledger failed to load.
      </CenteredNote>
    );
  }
  if (isLoading && rows.length === 0) {
    return <ChartShimmer announce />;
  }
  if (rows.length === 0) {
    return (
      <CenteredNote>No ledger events indexed for this trove yet.</CenteredNote>
    );
  }
  if (truncated) {
    // Suppressed ENTIRELY: a windowed chart of a history missing its oldest
    // rows would plot a fabricated opening state. Same partial-view gate as
    // the interest estimates (docs/PLAN-trove-history-page.md, "Degraded
    // modes").
    return (
      <p
        role="status"
        className="flex items-center justify-center px-4 text-center text-xs text-amber-400"
        style={{ height: TROVE_CHART_HEIGHT_PX }}
      >
        Chart suppressed — earliest history truncated, so a complete series
        cannot be drawn. The ledger below shows the most recent events.
      </p>
    );
  }
  if (!anchored) {
    // The response caught the indexer between writing ledger rows and
    // stamping the watermark: the snapshot may be missing (or prematurely
    // carrying) the newest operation. Drawing it as a complete history
    // would misstate the tail for one poll cycle; the next poll re-anchors.
    return (
      <p
        role="status"
        className="flex items-center justify-center px-4 text-center text-xs text-amber-400"
        style={{ height: TROVE_CHART_HEIGHT_PX }}
      >
        Chart paused — the ledger snapshot is mid-update and refreshes with the
        next poll.
      </p>
    );
  }
  if (!shouldMountPlot) {
    return <ChartShimmer />;
  }
  return (
    <Plot
      ariaLabel={chartAriaLabel}
      textAlternative={chartSummary}
      data={model.data}
      layout={model.layout}
      config={TROVE_CHART_PLOTLY_CONFIG}
      style={{ width: "100%", height: TROVE_CHART_HEIGHT_PX }}
      useResizeHandler
    />
  );
}

function TroveChartFootnotes({ series }: { series: TroveChartSeries }) {
  return (
    <div className="mt-2 space-y-1">
      {series.debt == null && (
        <p role="status" className="text-xs text-amber-400">
          Batch data unavailable — batch-managed rows carry no per-trove debt
          snapshots, so the debt panel shows no series.
        </p>
      )}
      {series.icrCoverage === "none" && (
        <p role="status" className="text-xs text-slate-500">
          ICR panel unavailable — no ledger event for this trove carries price
          data (historical rows persist none by design).
        </p>
      )}
      {series.icrCoverage === "partial" && (
        <p className="text-xs text-slate-500">
          ICR is plotted only at events that carry price data.
        </p>
      )}
      {series.markers.length > 0 && (
        <p className="text-xs text-slate-500">
          Dotted vertical lines mark redemptions (amber) and liquidations
          (rose).
        </p>
      )}
      <p className="text-xs text-slate-500">
        Values are recorded as of each ledger event; interest accrued since the
        last event is not shown.
      </p>
    </div>
  );
}

function TroveChartRangePills({
  range,
  onRangeChange,
}: {
  range: TroveChartRangeKey;
  onRangeChange: (range: TroveChartRangeKey) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Trove chart time range"
      className="flex gap-0.5 self-start rounded-md bg-slate-800/50 p-0.5"
    >
      {TROVE_CHART_RANGES.map((item) => {
        const active = range === item.key;
        return (
          <button
            key={item.key}
            type="button"
            aria-pressed={active}
            onClick={() => onRangeChange(item.key)}
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
  );
}

/** Collateral and debt over time (docs/PLAN-trove-history-page.md,
 *  "UI design → Chart"): two stacked single-unit step panels — collateral in
 *  USDm, debt in the market token — never one dual-axis plot, plus a third
 *  percentage panel for ICR only where price data exists. Renders only in
 *  complete-ledger mode from the same bounded `useTroveLedger` read as the
 *  ledger table; the interim view and a truncated history suppress it
 *  entirely. Built as a sibling of `TimeSeriesChartCard` on the same chrome:
 *  that card exposes one y-axis and hardcodes dollar-prefixed hover text,
 *  which would mislabel GBPm/CHFm/JPYm debt as dollars. */
export function TroveBalanceChart({
  rows,
  truncated,
  anchored,
  debtSnapshotsComplete,
  isLoading,
  error,
  hasLoadedOnce,
  debtSymbol,
}: {
  /** Chronological (oldest-first) complete-ledger rows, already capped. */
  rows: CdpTroveLedgerEventRow[];
  truncated: boolean;
  /** False when the response caught the indexer between writing ledger rows
   *  and stamping the watermark — the snapshot may misstate the newest
   *  operation, so the chart pauses until the next poll re-anchors (same
   *  gate the interest estimates apply). */
  anchored: boolean;
  debtSnapshotsComplete: boolean;
  isLoading: boolean;
  error: Error | undefined;
  /** Same `data != null` contract as the ledger table. */
  hasLoadedOnce: boolean;
  debtSymbol: string;
}) {
  const [range, setRange] = useState<TroveChartRangeKey>("all");
  const containerRef = useRef<HTMLDivElement>(null);
  const series = useMemo(
    () => buildTroveChartSeries(rows, { debtSnapshotsComplete }),
    [rows, debtSnapshotsComplete],
  );
  const model = useMemo(
    () =>
      buildTroveChartModel(
        series,
        range,
        debtSymbol,
        Math.floor(Date.now() / 1000),
      ),
    [series, range, debtSymbol],
  );
  const shouldRenderPlot = rows.length > 0 && !truncated && anchored;
  const shouldMountPlot = useDeferredMount(
    "visible",
    containerRef,
    shouldRenderPlot,
  );

  const activeRangeLabel =
    TROVE_CHART_RANGES.find((item) => item.key === range)?.label ?? range;
  const chartAriaLabel = `Collateral and debt over time chart, ${activeRangeLabel} range`;
  const chartSummary =
    rows.length === 0
      ? "Collateral and debt chart: no ledger events indexed for this trove yet."
      : truncated
        ? "Collateral and debt chart suppressed: earliest history truncated."
        : !anchored
          ? "Collateral and debt chart paused: the ledger snapshot is mid-update."
          : `Collateral and debt recorded over ${rows.length} ledger events, ${activeRangeLabel} range.`;

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-white">
            Collateral &amp; debt over time
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            Recorded balances after each ledger event — step lines hold between
            events.
          </p>
        </div>
        <TroveChartRangePills range={range} onRangeChange={setRange} />
      </div>
      <StaleRefreshNotice
        subject="Balance chart"
        error={hasLoadedOnce ? error : undefined}
        className="mt-3"
      />
      <div
        ref={containerRef}
        role="figure"
        aria-label={chartAriaLabel}
        className="relative mt-4"
        style={{ minHeight: TROVE_CHART_HEIGHT_PX }}
      >
        <TroveChartBody
          rows={rows}
          truncated={truncated}
          anchored={anchored}
          isLoading={isLoading}
          error={error}
          hasLoadedOnce={hasLoadedOnce}
          shouldMountPlot={shouldMountPlot}
          model={model}
          chartAriaLabel={chartAriaLabel}
          chartSummary={chartSummary}
        />
      </div>
      {/* Non-visual summary outside the figure, per the chart-card pattern. */}
      <p className="sr-only">{chartSummary}</p>
      {shouldRenderPlot && <TroveChartFootnotes series={series} />}
    </section>
  );
}
