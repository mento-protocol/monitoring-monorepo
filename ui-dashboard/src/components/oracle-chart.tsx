"use client";

import dynamic from "next/dynamic";
import { useRef } from "react";
import type { OracleSnapshot } from "@/lib/types";
import {
  PLOTLY_BASE_LAYOUT,
  PLOTLY_AXIS_DEFAULTS,
  PLOTLY_LEGEND,
  PLOTLY_CONFIG,
  RANGE_SELECTOR_BUTTONS_DAILY,
  makeDateXAxis,
} from "@/lib/plot";
import { attachOracleWheelHandler } from "./oracle-chart-wheel";
import {
  formatBaseline,
  formatOracleChartHoverText,
} from "./oracle-chart-hover";

export { formatOracleChartHoverText };

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

interface BreakerConfigForChart {
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

/**
 * Resolve the per-snapshot band, with fallback to the current breaker config.
 *
 * The indexer persists `breakerBaselineAtSnapshot` + `breakerThresholdAtSnapshot`
 * on each `OracleSnapshot` row written from an oracle-driven source so the
 * chart can render a historically accurate "would have tripped at the time"
 * verdict. Pre-deploy rows + rows from non-oracle sources land as null, and
 * fall back to the current breaker config.
 *
 * Exported so `oracle-chart.test.ts` can prove per-snapshot values take
 * precedence (the spec for this fix).
 *
 * Returns null `baseline`/`thresholdRatio` when neither source provides a
 * usable value — callers render a neutral verdict in that case.
 */
export function resolveSnapshotBand(
  snapshot: Pick<
    OracleSnapshot,
    "breakerBaselineAtSnapshot" | "breakerThresholdAtSnapshot"
  >,
  currentBaseline: number | null,
  currentThresholdRatio: number | null,
): { baseline: number | null; thresholdRatio: number | null } {
  const persistedBaseline = fixidityToFloat(snapshot.breakerBaselineAtSnapshot);
  const persistedThreshold = fixidityToFloat(
    snapshot.breakerThresholdAtSnapshot,
  );
  // Both persisted fields are written together by the indexer — if one is
  // present the other should be too. Resolve them as a pair so we never
  // mix a persisted baseline with a fallback threshold (that would mean
  // evaluating a historical price against today's threshold, which is a
  // verdict nobody asked for). When either is missing, fall back to the
  // current pair. Skips zero/non-finite values via fixidityToFloat.
  if (persistedBaseline != null && persistedThreshold != null) {
    return {
      baseline: persistedBaseline,
      thresholdRatio: persistedThreshold,
    };
  }
  return {
    baseline: currentBaseline,
    thresholdRatio: currentThresholdRatio,
  };
}

type BreakerConfigStatus = "loading" | "ready" | "missing";

interface OracleChartProps {
  snapshots: OracleSnapshot[];
  token0Symbol?: string | undefined;
  token1Symbol?: string | undefined;
  breachStartedAt?: string | null | undefined;
  breakerConfig?: BreakerConfigForChart | null | undefined;
  // Lets the chart distinguish "still fetching the breaker for this feed"
  // from "no breaker exists for this feed" — only in `ready` do we color
  // markers green/red against the band; the others render a neutral state.
  breakerConfigStatus?: BreakerConfigStatus;
}

export function OracleChart({
  snapshots,
  token0Symbol = "Token 0",
  token1Symbol = "Token 1",
  breachStartedAt,
  breakerConfig,
  breakerConfigStatus = "ready",
}: OracleChartProps) {
  // Stash the wheel-listener cleanup so we can detach when react-plotly tears
  // the chart down (onPurge) or remounts it. Without this, stacked listeners
  // on re-init would amplify scroll deltas. MUST be declared before the
  // `snapshots.length === 0` early-return so hook order is stable.
  const cleanupWheelRef = useRef<(() => void) | null>(null);

  if (snapshots.length === 0) return null;

  // Gate band geometry on `ready` only. SWR keeps the previous `breakerConfig`
  // payload during a revalidation failure, so without this null-out a stale
  // band could keep drawing while the legend / markers correctly show the
  // neutral state. Treat any non-ready status as "no band".
  const baseline =
    breakerConfigStatus === "ready" && breakerConfig
      ? breakerConfig.breakerKind === "VALUE_DELTA"
        ? fixidityToFloat(breakerConfig.referenceValue)
        : fixidityToFloat(breakerConfig.medianRatesEMA)
      : null;
  const thresholdRatio =
    breakerConfigStatus === "ready" && breakerConfig
      ? fixidityToFloat(breakerConfig.rateChangeThreshold)
      : null;

  const plotData = buildOraclePlotData({
    snapshots,
    token0Symbol,
    token1Symbol,
    baseline,
    thresholdRatio,
    breakerConfigStatus,
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

  // Whether ANY snapshot carries a persisted at-the-time band. When the
  // current breaker fetch is loading / errored / missing, the markers can
  // still color themselves green/red from these — so the legend needs to
  // describe that case rather than say "band check unavailable."
  const hasPersistedBands = snapshots.some(
    (s) => s.breakerBaselineAtSnapshot != null,
  );

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-2 sm:p-4 mb-4 overflow-hidden">
      <h3 className="text-sm font-medium text-slate-400 mb-3">
        Oracle Price vs Breaker Band
      </h3>
      <OracleChartLegend
        breachStartedAt={breachStartedAt}
        breakerConfig={breakerConfig}
        breakerConfigStatus={breakerConfigStatus}
        hasPersistedBands={hasPersistedBands}
      />
      <Plot
        data={[plotData.deviationTrace]}
        layout={layout}
        config={ORACLE_CHART_CONFIG}
        style={{ width: "100%", height: 420 }}
        useResizeHandler
        onInitialized={(_figure, graphDiv) => {
          cleanupWheelRef.current?.();
          cleanupWheelRef.current = attachOracleWheelHandler(
            graphDiv as unknown as HTMLElement,
          );
        }}
        onPurge={() => {
          cleanupWheelRef.current?.();
          cleanupWheelRef.current = null;
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
  breakerConfigStatus,
}: {
  snapshots: OracleSnapshot[];
  token0Symbol: string;
  token1Symbol: string;
  baseline: number | null;
  thresholdRatio: number | null;
  breakerConfigStatus: BreakerConfigStatus;
}): OraclePlotData {
  // `breakerConfigStatus === "ready"` gates fallback-band use. When the
  // current breaker hasn't loaded yet (or is genuinely missing), we still
  // honor PER-SNAPSHOT persisted bands — those are self-contained, they
  // don't depend on the current breaker row at all. Pre-deploy snapshots
  // (no persisted fields) fall back to the current config; if that's not
  // ready, the verdict is genuinely unknown for those points.
  const currentBaseline = breakerConfigStatus === "ready" ? baseline : null;
  const currentThresholdRatio =
    breakerConfigStatus === "ready" ? thresholdRatio : null;
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

  // `buildSnapshotMarkers` resolves per-snapshot persisted bands (when
  // present) and falls back to the current `currentBaseline / currentThresholdRatio`
  // otherwise, then computes marker color / size / hover text in one pass.
  // The fallback `isOutOfBand` extraction from PR #637 stays — the marker
  // builder calls into it internally for the fallback path.
  const { markerColors, markerSizes, hoverText } = buildSnapshotMarkers({
    snapshots,
    prices,
    currentBaseline,
    currentThresholdRatio,
    isSparse,
    token0Symbol,
    token1Symbol,
  });

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

// Per-snapshot marker styling + hover text. Extracted so the parent flow
// stays under the project's max-lines-per-function budget (100). The
// per-snapshot band resolution is the only place that varies per row, so
// it lives here next to the consumers.
function buildSnapshotMarkers({
  snapshots,
  prices,
  currentBaseline,
  currentThresholdRatio,
  isSparse,
  token0Symbol,
  token1Symbol,
}: {
  snapshots: OracleSnapshot[];
  prices: number[];
  currentBaseline: number | null;
  currentThresholdRatio: number | null;
  isSparse: boolean;
  token0Symbol: string;
  token1Symbol: string;
}): {
  markerColors: string[];
  markerSizes: number[];
  hoverText: string[];
} {
  // Per-snapshot band resolution. When the indexer persisted the breaker's
  // baseline + threshold at write time we use those — the breaker the
  // contract was actually arming when this median landed — so MEDIAN_DELTA
  // EMA drift can't retroactively flip a historical verdict. Pre-deploy
  // rows (and `update_reserves` / `rebalanced` rows that explicitly null
  // the fields) fall through to the current band as before.
  const perSnapshotBands = snapshots.map((s) =>
    resolveSnapshotBand(s, currentBaseline, currentThresholdRatio),
  );

  // Marker is "tripping" if the reported price crosses ITS snapshot's band.
  // When neither persisted nor current band is available, the verdict is
  // genuinely unknown — return null and let the caller render the marker in
  // a neutral state instead of greenwashing it. We guard both `baseline === 0`
  // (divide-by-zero — every marker would render red) AND `thresholdRatio
  // === 0` (`|x - b| / b > 0` is true for any non-exact price — same
  // all-red failure mode). `resolveSnapshotBand` returns whatever
  // `fixidityToFloat` produces, and `fixidityToFloat("0")` is `0` (finite),
  // which would pass a naive `!= null` check. The indexer's resolver
  // normally writes `null` for an unseeded `0n` baseline AND for a zero
  // effective threshold, but a manual DB write or backfill edge case could
  // still surface either as zero — treat both as "no band".
  const isOutOfBand = (
    price: number,
    band: { baseline: number | null; thresholdRatio: number | null },
  ): boolean | null => {
    if (
      band.baseline == null ||
      band.baseline === 0 ||
      band.thresholdRatio == null ||
      band.thresholdRatio === 0 ||
      !Number.isFinite(price)
    )
      return null;
    return (
      Math.abs(price - band.baseline) / band.baseline > band.thresholdRatio
    );
  };

  const markerColors = snapshots.map((s, i) => {
    if (!s.oracleOk) return "#ef4444"; // rejected report — red regardless
    const p = prices[i]!;
    if (!Number.isFinite(p)) return "#64748b";
    const verdict = isOutOfBand(p, perSnapshotBands[i]!);
    if (verdict === null) return "#64748b"; // unknown band — neutral
    return verdict ? "#ef4444" : "#22c55e";
  });
  const markerSizes = snapshots.map((s, i) => {
    if (!s.oracleOk) return isSparse ? 12 : 9;
    const p = prices[i]!;
    if (!Number.isFinite(p)) return isSparse ? 8 : 4;
    return isOutOfBand(p, perSnapshotBands[i]!) === true
      ? isSparse
        ? 12
        : 8
      : isSparse
        ? 8
        : 4;
  });

  const hoverText = snapshots.map((s, i) =>
    formatOracleChartHoverText({
      snapshot: s,
      price: prices[i]!,
      baseline: perSnapshotBands[i]!.baseline,
      thresholdRatio: perSnapshotBands[i]!.thresholdRatio,
      // Match `resolveSnapshotBand`'s pair-of-two semantics: a half-populated
      // row (only one persisted field set) falls back to the current band,
      // so the hover wording should not say "at the time" for that case.
      isHistoricalBand:
        s.breakerBaselineAtSnapshot != null &&
        s.breakerThresholdAtSnapshot != null,
      token0Symbol,
      token1Symbol,
    }),
  );

  return { markerColors, markerSizes, hoverText };
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
    // `deviationBreachStartedAt` is the *rebalance* threshold's breach anchor
    // (priceDifference > rebalanceThreshold), not a breaker trip. We keep
    // the guide line because it's operationally useful context, but the
    // legend explicitly labels it "Rebalance breach start" so it isn't
    // confused with the breaker band the rest of the chart visualizes.
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
  if (timestamps.length === 1) {
    // Newly-indexed pool with exactly one snapshot — pad ±1h around the
    // sole timestamp so the marker doesn't render against a zero-width
    // (degenerate) X axis.
    const ts = new Date(timestamps[0]!).getTime();
    const pad = 3600_000;
    xaxisBase.range = [
      new Date(ts - pad).toISOString(),
      new Date(ts + pad).toISOString(),
    ];
    xaxisBase.autorange = false;
  } else if (isSparse && timestamps.length >= 2) {
    const minTs = new Date(timestamps[0]!).getTime();
    const maxTs = new Date(timestamps[timestamps.length - 1]!).getTime();
    const pad = Math.max((maxTs - minTs) * 0.1, 3600_000);
    xaxisBase.range = [
      new Date(minTs - pad).toISOString(),
      new Date(maxTs + pad).toISOString(),
    ];
    xaxisBase.autorange = false;
  } else if (timestamps.length > 0) {
    const maxTs = new Date(timestamps[timestamps.length - 1]!).getTime();
    const minDataTs = new Date(timestamps[0]!).getTime();
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
  breakerConfigStatus,
  hasPersistedBands,
}: {
  breachStartedAt: string | null | undefined;
  breakerConfig: BreakerConfigForChart | null | undefined;
  breakerConfigStatus: BreakerConfigStatus;
  hasPersistedBands: boolean;
}) {
  // When the current breaker isn't ready, the markers can be one of two
  // things: persisted per-snapshot verdicts (if any snapshot carries an
  // at-the-time band) OR genuinely-neutral (no current AND no persisted).
  // The legend copy must match what the markers actually display so an
  // operator never sees red/green markers next to "band check unavailable."
  if (breakerConfigStatus !== "ready" || !breakerConfig) {
    const loading = breakerConfigStatus === "loading";
    const msg = hasPersistedBands
      ? loading
        ? "Verdicts use each snapshot's at-the-time band; current breaker still loading"
        : "No active current breaker — verdicts use each snapshot's at-the-time persisted band only"
      : loading
        ? "Loading current breaker config…"
        : "No active breaker for this rate feed — band check unavailable";
    return (
      <div className="flex flex-wrap gap-x-3 gap-y-1 mb-2 text-[10px] sm:text-xs text-slate-500">
        {hasPersistedBands && (
          <>
            <span className="flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-full bg-green-500" />
              Within band when evaluated
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-full bg-red-500" />
              Outside band — breaker would trip
            </span>
          </>
        )}
        <span className="flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-full bg-slate-500" />
          {msg}
        </span>
        {breachStartedAt && Number(breachStartedAt) > 0 && (
          <span className="flex items-center gap-1">
            <span className="inline-block w-4 border-t-2 border-dotted border-red-500" />
            Rebalance breach start
          </span>
        )}
      </div>
    );
  }
  const thresholdPct = fixidityToFloat(breakerConfig.rateChangeThreshold);
  const baseline =
    breakerConfig.breakerKind === "VALUE_DELTA"
      ? fixidityToFloat(breakerConfig.referenceValue)
      : fixidityToFloat(breakerConfig.medianRatesEMA);
  const baselineLabel =
    breakerConfig.breakerKind === "MEDIAN_DELTA" ? "median EMA" : "peg";
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 mb-2 text-[10px] sm:text-xs text-slate-500">
      <span className="flex items-center gap-1">
        <span className="inline-block w-2 h-2 rounded-full bg-green-500" />
        {/* Marker verdicts use each snapshot's at-the-time band when
            persisted (oracle_median_updated rows from PR #631 onward),
            falling back to the current band for older rows. The drawn
            band shape (dashed lines / shaded zones) below always reflects
            the CURRENT breaker config — historical bands aren't drawn
            because they'd produce a noisy stack of rectangles. */}
        Within band when evaluated
      </span>
      <span className="flex items-center gap-1">
        <span className="inline-block w-2 h-2 rounded-full bg-red-500" />
        Outside band — breaker would trip
      </span>
      <span className="flex items-center gap-1">
        <span className="inline-block w-4 border-t-2 border-dashed border-red-500" />
        Current threshold
        {thresholdPct != null ? ` (±${(thresholdPct * 100).toFixed(2)}%)` : ""}
      </span>
      <span className="flex items-center gap-1">
        <span className="inline-block w-4 border-t-2 border-dotted border-slate-400" />
        Current baseline ({baselineLabel}
        {baseline != null ? ` = ${formatBaseline(baseline)}` : ""})
      </span>
      {breachStartedAt && Number(breachStartedAt) > 0 && (
        <span className="flex items-center gap-1">
          <span className="inline-block w-4 border-t-2 border-dotted border-red-500" />
          Rebalance breach start
        </span>
      )}
    </div>
  );
}

// Test-only surface — keeps these helpers out of the module's public API
// while letting `__tests__/oracle-chart.test.ts` import them directly. Do
// not import this from production code.
export const __test__ = {
  buildOracleShapes,
  buildOracleXaxis,
  buildOraclePlotData,
};
