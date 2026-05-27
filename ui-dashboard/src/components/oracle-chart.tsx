"use client";

import dynamic from "next/dynamic";
import type { OracleSnapshot } from "@/lib/types";
import { parseOraclePriceToNumber } from "@/lib/format";
import {
  PLOTLY_BASE_LAYOUT,
  PLOTLY_AXIS_DEFAULTS,
  PLOTLY_LEGEND,
  PLOTLY_CONFIG,
  RANGE_SELECTOR_BUTTONS_DAILY,
  makeDateXAxis,
} from "@/lib/plot";

const Plot = dynamic(() => import("react-plotly.js"), { ssr: false });

// Per-chart Plotly config — we wire a custom wheel handler below so we can
// suppress Y-axis changes on plot-area scrolls (Plotly's built-in scrollZoom
// always zooms both axes simultaneously, which is jarring on a trackpad).
// Scrolling over the plot area zooms X around the cursor (matching the
// pre-existing dashboard feel); scrolling over the y-axis tick column zooms
// Y around the cursor.
const ORACLE_CHART_CONFIG = {
  ...PLOTLY_CONFIG,
  scrollZoom: false,
} as const;

function attachOracleWheelHandler(graphDiv: HTMLElement): () => void {
  const onWheel = (e: WheelEvent) => {
    const Plotly = (window as unknown as { Plotly?: PlotlyAPI }).Plotly;
    if (!Plotly) return;
    const layout = (graphDiv as unknown as { _fullLayout?: PlotlyFullLayout })
      ._fullLayout;
    if (!layout?.xaxis || !layout.yaxis) return;
    const rect = graphDiv.getBoundingClientRect();
    const xPos = e.clientX - rect.left;
    const yPos = e.clientY - rect.top;
    const ml = layout.margin?.l ?? 0;
    const mr = layout.margin?.r ?? 0;
    const mt = layout.margin?.t ?? 0;
    const mb = layout.margin?.b ?? 0;
    const plotL = ml;
    const plotR = rect.width - mr;
    const plotT = mt;
    // Plot bottom = container bottom minus margin minus rangeslider strip.
    const sliderThickness = rect.height * 0.08;
    const plotB = rect.height - mb - sliderThickness;
    const overYAxis = xPos < plotL && yPos > plotT && yPos < plotB;
    const overPlot =
      xPos >= plotL && xPos <= plotR && yPos >= plotT && yPos <= plotB;
    if (!overYAxis && !overPlot) return;

    e.preventDefault();
    const delta = e.deltaY + e.deltaX;
    if (Math.abs(delta) < 1) return;

    if (overYAxis) {
      const [yMin, yMax] = layout.yaxis.range as [number, number];
      if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) return;
      const span = yMax - yMin;
      const yPosFraction = (plotB - yPos) / (plotB - plotT);
      const yCursor = yMin + span * yPosFraction;
      const factor = delta > 0 ? 1.1 : 1 / 1.1;
      const newSpan = span * factor;
      Plotly.relayout(graphDiv, {
        "yaxis.range": [
          yCursor - newSpan * yPosFraction,
          yCursor + newSpan * (1 - yPosFraction),
        ],
      });
    } else {
      // Zoom X around the cursor — matches Plotly's default scrollZoom for X
      // but leaves Y untouched so a plot-area scroll never accidentally
      // rescales the price axis.
      const xRange = layout.xaxis.range as [string | number, string | number];
      const xMin = new Date(xRange[0]).getTime();
      const xMax = new Date(xRange[1]).getTime();
      if (!Number.isFinite(xMin) || !Number.isFinite(xMax)) return;
      const span = xMax - xMin;
      const xPosFraction = (xPos - plotL) / (plotR - plotL);
      const xCursorMs = xMin + span * xPosFraction;
      const factor = delta > 0 ? 1.1 : 1 / 1.1;
      const newSpan = span * factor;
      Plotly.relayout(graphDiv, {
        "xaxis.range": [
          new Date(xCursorMs - newSpan * xPosFraction).toISOString(),
          new Date(xCursorMs + newSpan * (1 - xPosFraction)).toISOString(),
        ],
      });
    }
  };
  graphDiv.addEventListener("wheel", onWheel, { passive: false });
  return () => graphDiv.removeEventListener("wheel", onWheel);
}

interface PlotlyFullLayout {
  xaxis?: { range?: [string | number, string | number] };
  yaxis?: { range?: [number, number] };
  margin?: { l?: number; r?: number; t?: number; b?: number };
}

interface PlotlyAPI {
  relayout: (
    div: HTMLElement,
    update: Record<string, unknown>,
  ) => Promise<unknown>;
}

export interface BreakerConfigForChart {
  breakerKind: "MEDIAN_DELTA" | "VALUE_DELTA" | "MARKET_HOURS";
  // All numeric fields are Fixidity 1e24 strings — divide by FIXIDITY_ONE.
  rateChangeThreshold: string;
  referenceValue: string | null;
  medianRatesEMA: string | null;
  status: "OK" | "TRIPPED";
  lastTripAt: string | null;
}

const FIXIDITY_ONE = 1e24;
const fixidityToFloat = (v: string | null | undefined): number | null => {
  if (v == null) return null;
  const n = Number(v) / FIXIDITY_ONE;
  return Number.isFinite(n) ? n : null;
};

interface OracleChartProps {
  snapshots: OracleSnapshot[];
  token0Symbol?: string;
  token1Symbol?: string;
  breachStartedAt?: string | null;
  breakerConfig?: BreakerConfigForChart | null;
}

export function OracleChart({
  snapshots,
  token0Symbol = "Token 0",
  token1Symbol = "Token 1",
  breachStartedAt,
  breakerConfig,
}: OracleChartProps) {
  if (snapshots.length === 0) return null;

  const baseline = breakerConfig
    ? breakerConfig.breakerKind === "VALUE_DELTA"
      ? fixidityToFloat(breakerConfig.referenceValue)
      : fixidityToFloat(breakerConfig.medianRatesEMA)
    : null;
  const thresholdRatio = breakerConfig
    ? fixidityToFloat(breakerConfig.rateChangeThreshold)
    : null;

  const plotData = buildOraclePlotData({
    snapshots,
    token0Symbol,
    token1Symbol,
    baseline,
    thresholdRatio,
  });
  const shapes = buildOracleShapes(
    breachStartedAt,
    plotData.yMax,
    baseline,
    thresholdRatio,
  );
  const layout = buildOracleLayout({
    shapes,
    xaxis: buildOracleXaxis(plotData.timestamps, plotData.isSparse),
    yMin: plotData.yMin,
    yMax: plotData.yMax,
    baseline,
    thresholdRatio,
  });

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-2 sm:p-4 mb-4 overflow-hidden">
      <h3 className="text-sm font-medium text-slate-400 mb-3">
        Oracle Price vs Breaker Band
      </h3>
      <OracleChartLegend
        breachStartedAt={breachStartedAt}
        breakerConfig={breakerConfig}
      />
      <Plot
        data={[plotData.deviationTrace]}
        layout={layout}
        config={ORACLE_CHART_CONFIG}
        style={{ width: "100%", height: 420 }}
        useResizeHandler
        onInitialized={(_figure, graphDiv) => {
          attachOracleWheelHandler(graphDiv as unknown as HTMLElement);
        }}
      />
    </div>
  );
}

interface OraclePlotData {
  deviationTrace: Record<string, unknown>;
  timestamps: string[];
  isSparse: boolean;
  yMin: number;
  yMax: number;
}

function buildOraclePlotData({
  snapshots,
  token0Symbol,
  token1Symbol,
  baseline,
  thresholdRatio,
}: {
  snapshots: OracleSnapshot[];
  token0Symbol: string;
  token1Symbol: string;
  baseline: number | null;
  thresholdRatio: number | null;
}): OraclePlotData {
  const isSparse = snapshots.length < 20;
  const timestamps = snapshots.map((s) =>
    new Date(Number(s.timestamp) * 1000).toISOString(),
  );

  // Raw oracle-reported value (Fixidity 1e24 → float). This is the value the
  // breaker compares against `referenceValue` / EMA — direction-agnostic.
  // We intentionally do NOT call `parseOraclePriceToNumber` here: that helper
  // inverts the rate for USD-quoted display, which would put the chart in a
  // different units space than the breaker config it's compared to.
  const prices = snapshots.map((s) => {
    if (!s.oraclePrice || s.oraclePrice === "0") return Number.NaN;
    return Number(s.oraclePrice) / FIXIDITY_ONE;
  });

  // Helper: marker is "tripping" if the reported price crosses the breaker band.
  const isOutOfBand = (price: number): boolean => {
    if (!baseline || !thresholdRatio || !Number.isFinite(price)) return false;
    return Math.abs(price - baseline) / baseline > thresholdRatio;
  };

  const markerColors = snapshots.map((s, i) => {
    if (!s.oracleOk) return "#ef4444"; // rejected report — red regardless
    const p = prices[i];
    if (!Number.isFinite(p)) return "#64748b";
    return isOutOfBand(p) ? "#ef4444" : "#22c55e";
  });
  const markerSizes = snapshots.map((s, i) => {
    if (!s.oracleOk) return isSparse ? 12 : 9;
    const p = prices[i];
    if (!Number.isFinite(p)) return isSparse ? 8 : 4;
    return isOutOfBand(p) ? (isSparse ? 12 : 8) : isSparse ? 8 : 4;
  });

  const hoverText = snapshots.map((s, i) =>
    formatOracleChartHoverText({
      snapshot: s,
      price: prices[i],
      baseline,
      thresholdRatio,
      token0Symbol,
      token1Symbol,
    }),
  );

  const traceMode = isSparse
    ? ("markers" as const)
    : ("lines+markers" as const);

  const deviationTrace = {
    x: timestamps,
    y: prices,
    type: "scatter" as const,
    mode: traceMode,
    name: "Oracle price",
    line: { color: "rgba(148,163,184,0.55)", width: 1.5 },
    marker: { size: markerSizes, color: markerColors },
    yaxis: "y" as const,
    hoverinfo: "text" as const,
    text: hoverText,
  };

  // TradingView-style Y range: tight around data, only stretching to a band
  // edge if the band is realistically "near" the data (within half a data
  // span past the extremes). For a tightly-pegged pool the chart zooms in
  // on the actual price; a band edge sitting far outside that range stays
  // off-screen until the data drifts toward it. The shapes use 0 / +∞ for
  // their outer extents so Plotly clips them to whatever range we choose.
  const finitePrices = prices.filter((p) => Number.isFinite(p));
  const fallback = baseline ?? 1;
  const dataMin =
    finitePrices.length > 0 ? Math.min(...finitePrices) : fallback;
  const dataMax =
    finitePrices.length > 0 ? Math.max(...finitePrices) : fallback;
  // Floor the data span so a perfectly flat dataset still gets a visible
  // window — otherwise yMin === yMax and Plotly draws an empty axis.
  const rawSpan = dataMax - dataMin;
  const dataSpan = Math.max(
    rawSpan,
    baseline ? baseline * 5e-5 : Math.abs(fallback) * 5e-5 || 1e-6,
  );

  let lo = dataMin;
  let hi = dataMax;
  if (baseline && thresholdRatio) {
    const bandLo = baseline * (1 - thresholdRatio);
    const bandHi = baseline * (1 + thresholdRatio);
    // Include a band edge when it's "near" the data. The inclusion margin
    // is the larger of half a data span and the breaker's own half-width
    // (`baseline × thresholdRatio`). That second term is what makes the
    // bands visible on MEDIAN_DELTA pools, where data sits on the EMA and
    // the band edges are intrinsically `threshold` away from it — without
    // this term, the bands would never qualify as "near" and would stay
    // off-screen. For tight VALUE_DELTA stablecoin pools, data clustered
    // at one band still hides the far band (its distance is ~2 × half-
    // width, so it doesn't qualify).
    const margin = Math.max(dataSpan * 0.5, baseline * thresholdRatio);
    if (bandLo >= dataMin - margin && bandLo <= dataMax + margin) {
      lo = Math.min(lo, bandLo);
    }
    if (bandHi >= dataMin - margin && bandHi <= dataMax + margin) {
      hi = Math.max(hi, bandHi);
    }
  }
  const visibleSpan = Math.max(hi - lo, dataSpan);
  const padding = visibleSpan * 0.15;
  const yMin = lo - padding;
  const yMax = hi + padding;

  return { deviationTrace, timestamps, isSparse, yMin, yMax };
}

function buildOracleShapes(
  breachStartedAt: string | null | undefined,
  yMax: number,
  baseline: number | null,
  thresholdRatio: number | null,
): Plotly.Layout["shapes"] {
  const shapes: Plotly.Layout["shapes"] = [];

  if (baseline && thresholdRatio) {
    const bandLo = baseline * (1 - thresholdRatio);
    const bandHi = baseline * (1 + thresholdRatio);
    // Anchor band rectangles to fixed extents past any realistic price so
    // the band zones always extend beyond whatever Y window we render in.
    // Plotly clips shapes to the visible plot area, so this is purely a
    // "make sure the tint reaches the edge" mechanism.
    const farLo = 0;
    const farHi = Math.max(baseline * 10, yMax * 2);

    shapes.push({
      type: "rect",
      xref: "paper",
      yref: "y",
      x0: 0,
      x1: 1,
      y0: farLo,
      y1: bandLo,
      fillcolor: "#ef4444",
      opacity: 0.08,
      line: { width: 0 },
      layer: "below",
    });
    shapes.push({
      type: "rect",
      xref: "paper",
      yref: "y",
      x0: 0,
      x1: 1,
      y0: bandLo,
      y1: bandHi,
      fillcolor: "#22c55e",
      opacity: 0.06,
      line: { width: 0 },
      layer: "below",
    });
    shapes.push({
      type: "rect",
      xref: "paper",
      yref: "y",
      x0: 0,
      x1: 1,
      y0: bandHi,
      y1: farHi,
      fillcolor: "#ef4444",
      opacity: 0.08,
      line: { width: 0 },
      layer: "below",
    });

    // Breaker band edges (dashed red).
    for (const y of [bandLo, bandHi]) {
      shapes.push({
        type: "line",
        xref: "paper",
        yref: "y",
        x0: 0,
        x1: 1,
        y0: y,
        y1: y,
        line: { color: "#ef4444", width: 1.25, dash: "dash" },
        layer: "above",
      });
    }
    // Baseline (solid, dim).
    shapes.push({
      type: "line",
      xref: "paper",
      yref: "y",
      x0: 0,
      x1: 1,
      y0: baseline,
      y1: baseline,
      line: { color: "rgba(148,163,184,0.6)", width: 1, dash: "dot" },
      layer: "above",
    });
  }

  if (breachStartedAt && Number(breachStartedAt) > 0) {
    const breachIso = new Date(Number(breachStartedAt) * 1000).toISOString();
    shapes.push({
      type: "line",
      xref: "x",
      yref: "paper",
      x0: breachIso,
      x1: breachIso,
      y0: 0,
      y1: 1,
      line: { color: "#ef4444", width: 2, dash: "dot" },
      layer: "above",
    });
  }

  return shapes;
}

function buildOracleXaxis(timestamps: string[], isSparse: boolean) {
  // Default visible window = last 7 days (the most operationally useful
  // horizon for spotting recent breaker trips). The rangeselector buttons
  // + rangeslider below let you scrub further if needed. Falls back to a
  // padded all-data window when there are fewer than ~20 snapshots.
  const xaxisBase = makeDateXAxis(RANGE_SELECTOR_BUTTONS_DAILY);
  if (isSparse && timestamps.length >= 2) {
    const minTs = new Date(timestamps[0]).getTime();
    const maxTs = new Date(timestamps[timestamps.length - 1]).getTime();
    const pad = Math.max((maxTs - minTs) * 0.1, 3600_000);
    xaxisBase.range = [
      new Date(minTs - pad).toISOString(),
      new Date(maxTs + pad).toISOString(),
    ];
    xaxisBase.autorange = false;
  } else if (timestamps.length > 0) {
    const maxTs = new Date(timestamps[timestamps.length - 1]).getTime();
    const minDataTs = new Date(timestamps[0]).getTime();
    const sevenDaysMs = 7 * 24 * 3_600_000;
    const start = Math.max(minDataTs, maxTs - sevenDaysMs);
    xaxisBase.range = [
      new Date(start).toISOString(),
      new Date(maxTs).toISOString(),
    ];
    xaxisBase.autorange = false;
  }
  return xaxisBase;
}

function buildOracleLayout({
  shapes,
  xaxis,
  yMin,
  yMax,
  baseline,
  thresholdRatio,
}: {
  shapes: Plotly.Layout["shapes"];
  xaxis: ReturnType<typeof buildOracleXaxis>;
  yMin: number;
  yMax: number;
  baseline: number | null;
  thresholdRatio: number | null;
}) {
  // Pick a tick precision that resolves the breaker band. For a 0.15% threshold
  // on a baseline of 1.0, ticks like 0.998 / 1.000 / 1.002 are right; for a
  // wider 4% threshold on a 1.08 baseline, 1.04 / 1.08 / 1.12 reads cleanly.
  const tickformat = (() => {
    if (!baseline || !thresholdRatio) return ".4f";
    const decimals = Math.min(
      8,
      Math.max(2, Math.ceil(-Math.log10(thresholdRatio)) + 1),
    );
    return `.${decimals}f`;
  })();

  return {
    ...PLOTLY_BASE_LAYOUT,
    shapes,
    xaxis,
    yaxis: {
      title: { text: "Oracle price", font: { size: 10 } },
      ...PLOTLY_AXIS_DEFAULTS,
      range: [yMin, yMax],
      tickformat,
      // Allow the user to scroll-zoom / drag-pan Y independently of X. The
      // wider band-tint rectangles already extend past the visible range,
      // so zooming out reveals the full breaker band when the default view
      // hides it.
      fixedrange: false,
    },
    legend: {
      ...PLOTLY_LEGEND,
      orientation: "h" as const,
      x: 0.5,
      y: -0.3,
      xanchor: "center" as const,
      yanchor: "top" as const,
    },
    margin: { t: 8, l: 64, r: 24, b: 8 },
    font: { ...PLOTLY_BASE_LAYOUT.font, size: 11 },
    autosize: true,
    dragmode: "pan" as const,
  };
}

function OracleChartLegend({
  breachStartedAt,
  breakerConfig,
}: {
  breachStartedAt: string | null | undefined;
  breakerConfig: BreakerConfigForChart | null | undefined;
}) {
  const thresholdPct =
    breakerConfig && fixidityToFloat(breakerConfig.rateChangeThreshold);
  const baseline = breakerConfig
    ? breakerConfig.breakerKind === "VALUE_DELTA"
      ? fixidityToFloat(breakerConfig.referenceValue)
      : fixidityToFloat(breakerConfig.medianRatesEMA)
    : null;
  const baselineLabel =
    breakerConfig?.breakerKind === "MEDIAN_DELTA" ? "median EMA" : "peg";
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 mb-2 text-[10px] sm:text-xs text-slate-500">
      <span className="flex items-center gap-1">
        <span className="inline-block w-2 h-2 rounded-full bg-green-500" />
        Within breaker band
      </span>
      <span className="flex items-center gap-1">
        <span className="inline-block w-2 h-2 rounded-full bg-red-500" />
        Outside band — breaker would trip
      </span>
      <span className="flex items-center gap-1">
        <span className="inline-block w-4 border-t-2 border-dashed border-red-500" />
        Breaker threshold
        {thresholdPct != null ? ` (±${(thresholdPct * 100).toFixed(2)}%)` : ""}
      </span>
      <span className="flex items-center gap-1">
        <span className="inline-block w-4 border-t-2 border-dotted border-slate-400" />
        Baseline ({baselineLabel}
        {baseline != null ? ` = ${formatBaseline(baseline)}` : ""})
      </span>
      {breachStartedAt && Number(breachStartedAt) > 0 && (
        <span className="flex items-center gap-1">
          <span className="inline-block w-4 border-t-2 border-dotted border-red-500" />
          Breach start
        </span>
      )}
    </div>
  );
}

function formatBaseline(b: number): string {
  if (b >= 100) return b.toFixed(2);
  if (b >= 1) return b.toFixed(4);
  return b.toFixed(6);
}

export function formatOracleChartHoverText({
  snapshot,
  price,
  baseline,
  thresholdRatio,
  token0Symbol,
  token1Symbol,
}: {
  snapshot: OracleSnapshot;
  price: number;
  baseline?: number | null;
  thresholdRatio?: number | null;
  token0Symbol: string;
  token1Symbol: string;
}): string {
  const d = new Date(Number(snapshot.timestamp) * 1000);
  const ts =
    d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }) +
    " " +
    d.toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  const priceText = Number.isFinite(price) ? price.toFixed(8) : "N/A";
  // Distance from baseline as both an absolute price difference (8dp) and
  // a basis-point delta, which is the unit operators tend to read in.
  const deltaLine =
    baseline && Number.isFinite(price)
      ? (() => {
          const delta = price - baseline;
          const bps = (delta / baseline) * 10_000;
          const sign = delta >= 0 ? "+" : "";
          const thresholdBps =
            thresholdRatio != null ? thresholdRatio * 10_000 : null;
          const verdict =
            thresholdBps != null
              ? Math.abs(bps) > thresholdBps
                ? " · breaker would TRIP"
                : " · within breaker band"
              : "";
          return `<br>Δ vs baseline: ${sign}${delta.toFixed(8)} (${sign}${bps.toFixed(1)} bps)${verdict}`;
        })()
      : "";
  return (
    `<b>${ts}</b><br>` +
    `Oracle price: ${priceText} (${token0Symbol}/${token1Symbol})` +
    deltaLine +
    // Source field distinguishes oracle_reported vs oracle_median_updated.
    (snapshot.source ? `<br>Source: ${snapshot.source}` : "")
  );
}
