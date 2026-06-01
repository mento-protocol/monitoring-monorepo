"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useOracleViewport } from "./oracle-chart-viewport";
import type { OracleSnapshot } from "@/lib/types";
import { decimateSeries } from "@/lib/oracle-decimation";
import {
  PLOTLY_BASE_LAYOUT,
  PLOTLY_AXIS_DEFAULTS,
  PLOTLY_LEGEND,
  PLOTLY_CONFIG,
  RANGE_SELECTOR_BUTTONS_DAILY,
  makeDateXAxis,
} from "@/lib/plot";
import { attachOracleWheelHandler } from "./oracle-chart-wheel";
import { formatOracleChartHoverText } from "./oracle-chart-hover";
import { OracleChartLegend } from "./oracle-chart-legend";
import {
  SPARSE_SERIES_THRESHOLD,
  buildDailyPlotData,
  computeOracleYRange,
  resolveDailyView,
  type OracleDailyCandle,
  type OraclePlotData,
} from "./oracle-daily";

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

// SVG `scatter` with per-point marker/color/hover arrays renders one DOM node
// per point and gets sluggish past a few thousand. Cap rendered points; the
// decimator preserves every anomalous point regardless of this cap.
const ORACLE_CHART_MAX_POINTS = 2000;

// Stable `<Plot style>` reference — react-plotly.js doesn't redraw on style
// identity, but keeping it module-level avoids a needless object per render.
const PLOT_STYLE = { width: "100%", height: 420 } as const;

/**
 * Read the requested visible X range (unix seconds) out of a Plotly relayout
 * event. Returns `null` when the event carries no X-range change — Y-only
 * wheel-zooms (`yaxis.range` only) and autorange resets — so the caller never
 * fires a history fetch in response to a Y zoom or a "show all" reset. Exported
 * for direct unit testing.
 */
export function readXRange(
  e: Readonly<Record<string, unknown>>,
): [number, number] | null {
  if (e["xaxis.autorange"]) return null;
  const rangeArr = e["xaxis.range"] as readonly unknown[] | undefined;
  const lo = e["xaxis.range[0]"] ?? rangeArr?.[0];
  const hi = e["xaxis.range[1]"] ?? rangeArr?.[1];
  if (lo == null || hi == null) return null;
  // Plotly date-axis range values are ISO-ish strings (or ms numbers from the
  // wheel handler) — `new Date(...)` handles both; /1000 → unix seconds.
  const L = new Date(lo as string | number).getTime() / 1000;
  const R = new Date(hi as string | number).getTime() / 1000;
  return Number.isFinite(L) && Number.isFinite(R) && R > L ? [L, R] : null;
}

/**
 * Classify a Plotly relayout event into the action the chart should take:
 *   - `"reset"` — the X axis autoranged ("All" button / double-click). The
 *     viewport now shows the whole loaded series, so decimation must drop its
 *     stale zoom window (`setVisibleRange(null)`); but there's nothing new to
 *     fetch, so the look-ahead does NOT fire.
 *   - `[lo, hi]` — an explicit X-range change (pan / wheel-X zoom / rangeslider
 *     drag). Refine decimation to that window AND evaluate the look-ahead.
 *   - `null` — no X-axis change (Y-only wheel-zoom, unrelated relayout). Ignore.
 *
 * Splitting "reset" out of `readXRange`'s null is the fix for a desync: before,
 * an autorange reset returned null and left `visibleRange` pinned to the prior
 * zoom, so the axis looked reset while the trace stayed decimated to the old
 * narrow window. Pure + exported for unit testing.
 */
export function relayoutAction(
  e: Readonly<Record<string, unknown>>,
): "reset" | [number, number] | null {
  if (e["xaxis.autorange"]) return "reset";
  return readXRange(e);
}

/**
 * Apply a Plotly relayout to the chart's decimation window + look-ahead. The
 * trigger only ever READS data (never calls relayout), and `uirevision` pins
 * the viewport across the resulting data change — so there's no feedback loop
 * with the wheel handler. Extracted from the JSX to keep `OracleChart` within
 * the max-lines budget.
 */
function applyOracleRelayout(
  e: unknown,
  setVisibleRange: (range: [number, number] | null) => void,
  setShowAll: (showAll: boolean) => void,
  onVisibleXRangeChange?: (range: [number, number]) => void,
): void {
  const action = relayoutAction(e as Readonly<Record<string, unknown>>);
  if (action === "reset") {
    // "All" / double-click autorange: full-extent intent → select daily
    // candles (if available) rather than the loaded raw head. No fetch.
    setVisibleRange(null);
    setShowAll(true);
    return;
  }
  if (!action) return; // Y-only / unrelated relayout → ignore
  setVisibleRange(action);
  setShowAll(false);
  onVisibleXRangeChange?.(action);
}

/**
 * Coalesce the stream of `onRelayout` events into at most one React state
 * update per animation frame. The wheel handler fires a relayout on every tick
 * (up to ~120/s on a trackpad), and each one previously ran `applyOracleRelayout`
 * synchronously → a full decimation recompute + `Plotly.react` redraw, twice per
 * tick, pinning the main thread to ~10fps during a zoom. The wheel's own
 * `Plotly.relayout` already reframes the axis instantly every tick (the zoom is
 * visible immediately); this defers only the React-side work — re-scoping
 * decimation, re-evaluating daily-mode, firing look-ahead — to once the viewport
 * settles within a frame. The latest event in a frame wins, which matches the
 * chart's final axis state. `resetKey` (`${networkId}:${poolId}`) cancels any
 * pending frame when the chart identity changes — OracleTab does NOT remount
 * across a poolId change, so without this a frame scheduled for the old pool
 * would flush after `useOracleViewport` has reset the new one, applying the old
 * pool's X range and firing look-ahead against the new pool. Returns a stable
 * handler. Exported for unit testing.
 */
export function useCoalescedRelayout(
  setVisibleRange: (range: [number, number] | null) => void,
  setShowAll: (showAll: boolean) => void,
  onVisibleXRangeChange: ((range: [number, number]) => void) | undefined,
  resetKey: string | undefined,
): (e: unknown) => void {
  const pendingRef = useRef<unknown>(null);
  const rafIdRef = useRef<number | null>(null);
  // Keep the latest look-ahead callback in a ref so a queued flush never fires a
  // stale closure if the prop changes (e.g. oldestLoadedTs advances as older
  // pages load) between scheduling and firing. setVisibleRange/setShowAll are
  // stable state setters, so flush — and thus the returned handler — stays
  // referentially stable across parent re-renders.
  const onVisibleXRangeChangeRef = useRef(onVisibleXRangeChange);
  useEffect(() => {
    onVisibleXRangeChangeRef.current = onVisibleXRangeChange;
  });

  // Cancel + drop any pending frame the instant the chart identity changes,
  // DURING render. This must NOT be an effect: a queued `requestAnimationFrame`
  // fires before the next paint, whereas passive (and even layout) effect
  // cleanup runs after the commit — so an effect could let the old-pool flush
  // apply a stale X range / fire look-ahead against the new pool before the
  // cleanup cancels it. OracleTab reuses this component across a poolId change,
  // so that window is real. Running here (mirroring useOracleViewport's
  // render-phase reset on the same key) guarantees the cancel precedes the
  // browser's rAF. The `!= null` guard keeps it SSR-safe: rafIdRef is always
  // null on the server, so cancelAnimationFrame is never called there.
  const prevResetKeyRef = useRef(resetKey);
  if (prevResetKeyRef.current !== resetKey) {
    prevResetKeyRef.current = resetKey;
    if (rafIdRef.current != null) cancelAnimationFrame(rafIdRef.current);
    rafIdRef.current = null;
    pendingRef.current = null;
  }

  const flush = useCallback(() => {
    rafIdRef.current = null;
    const e = pendingRef.current;
    pendingRef.current = null;
    if (e != null) {
      applyOracleRelayout(
        e,
        setVisibleRange,
        setShowAll,
        onVisibleXRangeChangeRef.current,
      );
    }
  }, [setVisibleRange, setShowAll]);
  // Cancel any pending frame on unmount (identity-change is handled above).
  useEffect(
    () => () => {
      if (rafIdRef.current != null) cancelAnimationFrame(rafIdRef.current);
    },
    [],
  );
  return useCallback(
    (e: unknown) => {
      pendingRef.current = e;
      rafIdRef.current ??= requestAnimationFrame(flush);
    },
    [flush],
  );
}

/**
 * Look-ahead gate: given the requested visible X range (unix seconds) and the
 * oldest loaded timestamp, return the timestamp to load back to — or `null`
 * when the left edge still has comfortable headroom and no fetch is needed.
 * Triggers one span-fraction before the edge so scroll-back stays fluid rather
 * than stuttering at the boundary. Pure + exported for unit testing.
 */
export function lookAheadTarget(
  range: [number, number],
  oldestLoadedTs: number,
  fraction: number,
): number | null {
  const [left, right] = range;
  const span = right - left;
  if (span <= 0) return null;
  if (left - oldestLoadedTs < span * fraction) return left - span * fraction;
  return null;
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

/**
 * Whether a reported price falls outside its breaker band.
 *
 * Returns `null` (verdict unknown → render neutral, never red) when no usable
 * band exists. We guard both `baseline === 0` (divide-by-zero — every marker
 * would render red) AND `thresholdRatio === 0` (`|x-b|/b > 0` is true for any
 * inexact price — same all-red failure). `fixidityToFloat("0")` is a finite
 * `0`, which a naive `!= null` check would miss, so the zero guards matter.
 */
function priceOutOfBand(
  price: number,
  baseline: number | null,
  thresholdRatio: number | null,
): boolean | null {
  if (
    baseline == null ||
    baseline === 0 ||
    thresholdRatio == null ||
    thresholdRatio === 0 ||
    !Number.isFinite(price)
  ) {
    return null;
  }
  return Math.abs(price - baseline) / baseline > thresholdRatio;
}

/**
 * Whether a snapshot renders as a "red" marker — a rejected report or an
 * out-of-band median. Used by the decimator's anomaly filter so these points
 * survive at any zoom. Mirrors the marker-color logic in `buildSnapshotMarkers`.
 */
function snapshotIsRed(
  s: OracleSnapshot,
  currentBaseline: number | null,
  currentThresholdRatio: number | null,
): boolean {
  if (!s.oracleOk) return true;
  const price =
    !s.oraclePrice || s.oraclePrice === "0"
      ? Number.NaN
      : Number(s.oraclePrice) / FIXIDITY_ONE;
  if (!Number.isFinite(price)) return false; // neutral, not red
  const band = resolveSnapshotBand(s, currentBaseline, currentThresholdRatio);
  return priceOutOfBand(price, band.baseline, band.thresholdRatio) === true;
}

export type BreakerConfigStatus = "loading" | "ready" | "missing";

interface OracleChartProps {
  snapshots: OracleSnapshot[];
  token0Symbol?: string | undefined;
  token1Symbol?: string | undefined;
  breakerConfig?: BreakerConfigForChart | null | undefined;
  // Lets the chart distinguish "still fetching the breaker for this feed"
  // from "no breaker exists for this feed" — only in `ready` do we color
  // markers green/red against the band; the others render a neutral state.
  breakerConfigStatus?: BreakerConfigStatus;
  // Plotly `uirevision` token — pass `${networkId}:${poolId}`. While it stays
  // the same, Plotly preserves the user's zoom/pan across every data change
  // (30s repoll, scroll-back append). Changing it (pool/network switch) resets
  // the viewport to the default window.
  uirevision?: string | undefined;
  // Fired (with the requested visible X range in unix seconds) whenever the
  // user pans/zooms the X axis. The pool tab debounces this into the
  // windowed-history hook's `ensureLoadedBefore` to page in older data.
  onVisibleXRangeChange?: ((range: [number, number]) => void) | undefined;
  // Daily OHLC rollup (full history, fetched once by the pool tab). When the
  // visible X span exceeds DAILY_MODE_SPAN_SECONDS, the chart renders these
  // instead of the raw keyset `snapshots` — a single sub-1000-row page spans
  // years where raw medians would need many keyset pages. Undefined/empty →
  // the chart stays on the raw path at every zoom.
  dailyCandles?: readonly OracleDailyCandle[] | undefined;
}

/**
 * Cap rendered points to the visible window, preserving every anomalous (red)
 * point. The current-band fallback (gated on `ready`, mirroring
 * buildOraclePlotData) feeds the anomaly filter so a point's verdict matches
 * its marker color.
 */
function useDecimatedSnapshots(
  snapshots: OracleSnapshot[],
  visibleRange: [number, number] | null,
  baseline: number | null,
  thresholdRatio: number | null,
  breakerConfigStatus: BreakerConfigStatus,
): OracleSnapshot[] {
  const currentBaseline = breakerConfigStatus === "ready" ? baseline : null;
  const currentThresholdRatio =
    breakerConfigStatus === "ready" ? thresholdRatio : null;
  return useMemo(
    () =>
      decimateSeries(snapshots, {
        visibleRange,
        cap: ORACLE_CHART_MAX_POINTS,
        getTimestamp: (s) => Number(s.timestamp),
        isAnomalous: (s) =>
          snapshotIsRed(s, currentBaseline, currentThresholdRatio),
      }),
    [snapshots, visibleRange, currentBaseline, currentThresholdRatio],
  );
}

// Resolve the CURRENT breaker band (baseline + threshold, floats) for the chart.
// Gated on `ready` only: SWR keeps the previous `breakerConfig` during a
// revalidation failure, so a non-ready status nulls the band rather than drawing
// a stale one while the markers correctly show neutral. VALUE_DELTA bases on the
// reference value, MEDIAN_DELTA on the median EMA.
function resolveCurrentBand(
  breakerConfig: BreakerConfigForChart | null | undefined,
  breakerConfigStatus: BreakerConfigStatus,
): { baseline: number | null; thresholdRatio: number | null } {
  if (breakerConfigStatus !== "ready" || !breakerConfig) {
    return { baseline: null, thresholdRatio: null };
  }
  const baseline =
    breakerConfig.breakerKind === "VALUE_DELTA"
      ? fixidityToFloat(breakerConfig.referenceValue)
      : fixidityToFloat(breakerConfig.medianRatesEMA);
  return {
    baseline,
    thresholdRatio: fixidityToFloat(breakerConfig.rateChangeThreshold),
  };
}

// Resolution switch: a wide viewport (> ~60d) renders daily candles — full
// history in one page — while a tight one keeps the raw keyset path. The same
// span threshold gates oracle-tab's look-ahead, so zooming out never pages raw
// history that daily mode renders instead. `uirevision` pins the viewport
// across the raw↔daily swap (the daily close equals the day's last raw point).
function selectOraclePlotData({
  visibleRange,
  showAll,
  dailyCandles,
  visibleSnapshots,
  token0Symbol,
  token1Symbol,
  baseline,
  thresholdRatio,
  breakerConfigStatus,
}: {
  visibleRange: [number, number] | null;
  showAll: boolean;
  dailyCandles: readonly OracleDailyCandle[] | undefined;
  visibleSnapshots: OracleSnapshot[];
  token0Symbol: string;
  token1Symbol: string;
  baseline: number | null;
  thresholdRatio: number | null;
  breakerConfigStatus: BreakerConfigStatus;
}): OraclePlotData {
  const daily = resolveDailyView({ visibleRange, showAll, dailyCandles });
  if (daily.active) {
    return buildDailyPlotData({
      candles: daily.candles,
      baseline,
      thresholdRatio,
    });
  }
  return buildOraclePlotData({
    snapshots: visibleSnapshots,
    token0Symbol,
    token1Symbol,
    baseline,
    thresholdRatio,
    breakerConfigStatus,
  });
}

/**
 * Memoized plot model: decimate → build trace data + layout, all referentially
 * stable. react-plotly.js 2.6 ref-compares `data`/`layout`/`config` in
 * `componentDidUpdate` and skips `Plotly.react` when all three are unchanged,
 * so a 30s SWR repoll or a coalesced relayout whose decimated output is
 * identical no longer rebuilds + redraws the SVG (the dominant per-tick cost).
 * Extracted to keep `OracleChart` under the max-lines-per-function budget.
 */
function useOracleChartModel({
  snapshots,
  visibleRange,
  showAll,
  dailyCandles,
  token0Symbol,
  token1Symbol,
  baseline,
  thresholdRatio,
  breakerConfigStatus,
  applyInitialRange,
  uirevision,
}: {
  snapshots: OracleSnapshot[];
  visibleRange: [number, number] | null;
  showAll: boolean;
  dailyCandles: readonly OracleDailyCandle[] | undefined;
  token0Symbol: string;
  token1Symbol: string;
  baseline: number | null;
  thresholdRatio: number | null;
  breakerConfigStatus: BreakerConfigStatus;
  applyInitialRange: boolean;
  uirevision: string | undefined;
}) {
  // Decimate to a bounded render count within the visible window, preserving
  // every anomalous point and the window endpoints.
  const visibleSnapshots = useDecimatedSnapshots(
    snapshots,
    visibleRange,
    baseline,
    thresholdRatio,
    breakerConfigStatus,
  );
  const plotData = useMemo(
    () =>
      selectOraclePlotData({
        visibleRange,
        showAll,
        dailyCandles,
        visibleSnapshots,
        token0Symbol,
        token1Symbol,
        baseline,
        thresholdRatio,
        breakerConfigStatus,
      }),
    [
      visibleRange,
      showAll,
      dailyCandles,
      visibleSnapshots,
      token0Symbol,
      token1Symbol,
      baseline,
      thresholdRatio,
      breakerConfigStatus,
    ],
  );
  const shapes = useMemo(
    () => buildOracleShapes(plotData.yMax, baseline, thresholdRatio),
    [plotData.yMax, baseline, thresholdRatio],
  );
  const layout = useMemo(
    () =>
      buildOracleLayout({
        shapes,
        plotData,
        applyInitialRange,
        baseline,
        thresholdRatio,
        uirevision,
      }),
    [shapes, plotData, applyInitialRange, baseline, thresholdRatio, uirevision],
  );
  // Stable `data` reference (changes only when the trace does) so react-plotly
  // skips the redraw when the figure is unchanged.
  const traceData = useMemo(
    () => [plotData.deviationTrace],
    [plotData.deviationTrace],
  );
  return { traceData, layout };
}

export function OracleChart({
  snapshots,
  token0Symbol = "Token 0",
  token1Symbol = "Token 1",
  breakerConfig,
  breakerConfigStatus = "ready",
  uirevision,
  onVisibleXRangeChange,
  dailyCandles,
}: OracleChartProps) {
  // Stash the wheel-listener cleanup so we can detach when react-plotly tears
  // the chart down (onPurge) or remounts it. Without this, stacked listeners
  // on re-init would amplify scroll deltas. MUST be declared before the
  // `snapshots.length === 0` early-return so hook order is stable.
  const cleanupWheelRef = useRef<(() => void) | null>(null);
  // Viewport: zoom window (scopes decimation + daily Y) + full-extent ("All")
  // intent, reset on pool switch. See useOracleViewport / resolveDailyView.
  const { visibleRange, setVisibleRange, showAll, setShowAll } =
    useOracleViewport(uirevision);
  // Supply an explicit xaxis.range ONLY on the default view — no active user
  // zoom/pan (`visibleRange`) and not "All" (`showAll`). There the recomputed
  // `[maxTs - 7d, maxTs]` keeps the right edge tracking new samples each SWR
  // repoll, and a pool switch (which resets the viewport here) lands back on
  // the 7-day default. Once the user has a viewport, omit range/autorange so
  // uirevision preserves it across repolls — re-supplying a recomputed range
  // would otherwise clobber a scroll-wheel zoom on the next data load.
  const applyInitialRange = visibleRange === null && !showAll;

  const { baseline, thresholdRatio } = resolveCurrentBand(
    breakerConfig,
    breakerConfigStatus,
  );

  // Decimate + build a memoized, referentially-stable trace/layout (see hook).
  const { traceData, layout } = useOracleChartModel({
    snapshots,
    visibleRange,
    showAll,
    dailyCandles,
    token0Symbol,
    token1Symbol,
    baseline,
    thresholdRatio,
    breakerConfigStatus,
    applyInitialRange,
    uirevision,
  });

  // One React state update per animation frame instead of per wheel tick;
  // `uirevision` (= `${networkId}:${poolId}`) cancels a pending frame on a
  // pool/network switch so it can't apply the old pool's range.
  const handleRelayout = useCoalescedRelayout(
    setVisibleRange,
    setShowAll,
    onVisibleXRangeChange,
    uirevision,
  );

  // Gate on raw snapshots only (not dailyCandles): raw is the default view, and
  // daily mode is zoom-gated (needs visibleRange > threshold), so daily can't
  // render on first paint anyway. "Empty raw but non-empty daily" can't persist
  // either — both derive from the same `oracle_median_updated` events, so a pool
  // with daily candles always has raw medians; the only empty-raw window is the
  // brief parallel-fetch load, after which raw fills in. After all hooks so hook
  // order stays stable across the empty→loaded transition.
  if (snapshots.length === 0) return null;

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
        breakerConfig={breakerConfig}
        breakerConfigStatus={breakerConfigStatus}
        hasPersistedBands={hasPersistedBands}
        baseline={baseline}
        thresholdRatio={thresholdRatio}
        baselineLabel={
          breakerConfig?.breakerKind === "MEDIAN_DELTA" ? "median EMA" : "peg"
        }
      />
      <Plot
        data={traceData}
        layout={layout}
        config={ORACLE_CHART_CONFIG}
        style={PLOT_STYLE}
        useResizeHandler
        onRelayout={handleRelayout}
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
  const isSparse = snapshots.length < SPARSE_SERIES_THRESHOLD;
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
  const { yMin, yMax } = computeOracleYRange(prices, baseline, thresholdRatio);
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
  // Thin band-shaped adapter over the shared `priceOutOfBand` so the marker
  // verdict and the decimator's anomaly filter can never drift apart.
  const isOutOfBand = (
    price: number,
    band: { baseline: number | null; thresholdRatio: number | null },
  ): boolean | null =>
    priceOutOfBand(price, band.baseline, band.thresholdRatio);

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

  return shapes;
}

function buildOracleXaxis(
  timestamps: string[],
  isSparse: boolean,
  applyInitialRange = true,
) {
  // Default visible window = last 7 days (the most operationally useful
  // horizon for spotting recent breaker trips). The rangeselector buttons
  // + rangeslider below let you scrub further if needed. Falls back to a
  // padded all-data window when there are fewer than ~20 snapshots.
  const xaxisBase = makeDateXAxis(RANGE_SELECTOR_BUTTONS_DAILY);
  // After the initial paint, omit `range`/`autorange` entirely so uirevision
  // preserves the user's zoom/pan across SWR repolls. Supplying a recomputed
  // range here would override a scroll-wheel zoom on the next data load. This
  // also drops the stale `maxTs - 7d` clamp from the daily / "All" view, where
  // a recomputed 7-day range was wrong for the full-extent intent.
  if (!applyInitialRange) return xaxisBase;
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
  plotData,
  applyInitialRange,
  baseline,
  thresholdRatio,
  uirevision,
}: {
  shapes: Plotly.Layout["shapes"];
  plotData: OraclePlotData;
  applyInitialRange: boolean;
  baseline: number | null;
  thresholdRatio: number | null;
  uirevision?: string | undefined;
}) {
  const xaxis = buildOracleXaxis(
    plotData.timestamps,
    plotData.isSparse,
    applyInitialRange,
  );
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
    // While `uirevision` is unchanged, Plotly preserves the user's zoom/pan
    // across every re-render — the 30s repoll and each scroll-back append.
    // It changes only on a pool/network switch (the caller keys it on
    // `${networkId}:${poolId}`), which resets the viewport to the default
    // window below. The initial `xaxis.range` is still honored on mount.
    // Spread conditionally: exactOptionalPropertyTypes rejects an explicit
    // `undefined` on Plotly's optional `uirevision`.
    ...(uirevision != null ? { uirevision } : {}),
    shapes,
    xaxis,
    yaxis: {
      title: { text: "Oracle price", font: { size: 10 } },
      ...PLOTLY_AXIS_DEFAULTS,
      range: [plotData.yMin, plotData.yMax],
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

// Test-only surface — keeps these helpers out of the module's public API
// while letting `__tests__/oracle-chart.test.ts` import them directly. Do
// not import this from production code.
export const __test__ = {
  buildOracleShapes,
  buildOracleXaxis,
  buildOraclePlotData,
  buildOracleLayout,
};
