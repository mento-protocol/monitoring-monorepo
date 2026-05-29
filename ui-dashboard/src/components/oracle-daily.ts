// Daily-candle render path for the oracle chart (the zoomed-out resolution).
// Kept out of oracle-chart.tsx for two reasons: (1) the 1000-line cap, and
// (2) candle coloring is direct-from-`anyOutOfBand` (the precomputed breaker
// verdict), NOT the per-snapshot band recompute the raw path runs — so a
// zoomed-out candle stays red when an intraday trip recovered by close.

import { escapePlotText } from "@/lib/plot";

const FIXIDITY_ONE = 1e24;

// Markers-only below this point count, lines+markers at or above it. Shared with
// the raw path (buildOraclePlotData in oracle-chart.tsx) so the two resolutions
// keep identical sparse-vs-dense visual semantics.
export const SPARSE_SERIES_THRESHOLD = 20;

// Switch the chart from the raw keyset path to daily candles when the visible
// X span (unix seconds) exceeds this. At raw cadence (~170 medians/day on a
// busy feed) the 1000-row keyset head is only ~6 days, so beyond ~2 months the
// raw path would page many times to fill the window — the daily rollup serves
// the whole range in one sub-1000-row query. Shared with oracle-tab's
// look-ahead gate so the render switch and the paging gate react to the same
// relayout (no prop round-trip, no lag).
export const DAILY_MODE_SPAN_SECONDS = 60 * 86400;

/** A row of `OraclePriceDailySnapshot` (see indexer-envio/schema.graphql). */
export interface OracleDailyCandle {
  bucketStart: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  closePrice: string;
  sampleCount: number;
  anyOutOfBand: boolean;
  maxDeviationRatio: string;
  endBreakerBaselineAtSnapshot: string | null;
  endBreakerThresholdAtSnapshot: string | null;
}

const fixToFloat = (v: string): number => {
  if (!v || v === "0") return Number.NaN;
  return Number(v) / FIXIDITY_ONE;
};

/**
 * TradingView-style Y range: tight around the data, stretching to a band edge
 * only when that edge is "near" the data. Extracted verbatim from
 * `buildOraclePlotData` so the raw and daily paths share one implementation.
 * `prices` are floats (NaN entries are ignored).
 */
export function computeOracleYRange(
  prices: readonly number[],
  baseline: number | null,
  thresholdRatio: number | null,
): { yMin: number; yMax: number } {
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
  return { yMin: lo - padding, yMax: hi + padding };
}

const fmtPrice = (n: number): string =>
  Number.isFinite(n) ? n.toPrecision(6) : "—";

function buildDailyHover(c: OracleDailyCandle): string {
  const date = new Date(Number(c.bucketStart) * 1000)
    .toISOString()
    .slice(0, 10);
  const ohlc =
    `O ${fmtPrice(fixToFloat(c.openPrice))}  H ${fmtPrice(fixToFloat(c.highPrice))}  ` +
    `L ${fmtPrice(fixToFloat(c.lowPrice))}  C ${fmtPrice(fixToFloat(c.closePrice))}`;
  const verdict = c.anyOutOfBand ? " · OUT OF BAND" : "";
  // Escape the DB-sourced ratio — Plotly renders HTML in `text`, so an
  // unescaped string is an XSS sink (mirrors the raw path's escapePlotText use).
  const dev =
    c.maxDeviationRatio !== "-1"
      ? ` · max dev ${escapePlotText(c.maxDeviationRatio)}`
      : "";
  return `${date}<br>${ohlc}<br>${c.sampleCount} medians${verdict}${dev}`;
}

// The plot payload shared by the raw (`buildOraclePlotData`) and daily
// (`buildDailyPlotData`) paths. Defined in this leaf and imported by
// oracle-chart.tsx so `selectOraclePlotData`'s return type is ONE named type,
// not two structurally-identical interfaces coupled only by structural typing.
export interface OraclePlotData {
  deviationTrace: Record<string, unknown>;
  timestamps: string[];
  isSparse: boolean;
  yMin: number;
  yMax: number;
}

// DESC rows (the ORACLE_PRICE_DAILY ordering — see config.ts) reversed to
// chronological ASC for the chart's left-to-right line. Pure spread + reverse
// (not `toReversed`) for the ES2017 target. Exported so the reversal is unit-
// tested directly (it's load-bearing: a missed reversal renders the chart
// backwards / breaks the daily↔raw seam).
export function chronological(
  rows: readonly OracleDailyCandle[],
): readonly OracleDailyCandle[] {
  return [...rows].reverse();
}

// The look-ahead paging gate: a visible X span (unix seconds) wider than the
// daily threshold is served by daily candles, so raw keyset scroll-back must NOT
// fire (it would page many pages into the Hasura 429 wall). Exported so the gate
// is unit-tested directly.
export function shouldSkipLookAhead(range: readonly [number, number]): boolean {
  return range[1] - range[0] > DAILY_MODE_SPAN_SECONDS;
}

/**
 * Build the daily-candle scatter trace. Same trace shape + x-encoding (ISO
 * strings via `toISOString()`, matching `buildOraclePlotData`) so it drops into
 * the same `<Plot>` and `uirevision` pins the viewport across the raw↔daily
 * swap. y = close (the day's last median, so the close equals the last raw
 * point of the day — a seamless handoff). Color is the precomputed
 * `anyOutOfBand` verdict; NO decimation (a pool's full daily history is one
 * sub-1000-row page).
 */
export function buildDailyPlotData({
  candles,
  baseline,
  thresholdRatio,
}: {
  candles: readonly OracleDailyCandle[];
  baseline: number | null;
  thresholdRatio: number | null;
}): OraclePlotData {
  const isSparse = candles.length < SPARSE_SERIES_THRESHOLD;
  const timestamps = candles.map((c) =>
    new Date(Number(c.bucketStart) * 1000).toISOString(),
  );
  const prices = candles.map((c) => fixToFloat(c.closePrice));
  // Tri-state, direct from the precomputed verdict — never recompute from
  // close + band (an intraday trip that recovered by close must still read red):
  //   red    = a median that day was out of band (or rejected),
  //   neutral= no breaker band existed that day (unseeded EMA / pre-backfill,
  //            so `anyOutOfBand: false` means "unknown", not "in band"),
  //   green  = a band existed and nothing tripped.
  // (Neutral is more honest than green here; it still differs from the raw
  // chart, which falls back to the *current* breaker config for null-band rows.)
  const markerColors = candles.map((c) =>
    c.anyOutOfBand
      ? "#ef4444"
      : c.endBreakerBaselineAtSnapshot == null
        ? "#64748b"
        : "#22c55e",
  );
  const markerSizes = candles.map(() => (isSparse ? 9 : 5));
  const hoverText = candles.map(buildDailyHover);

  const deviationTrace = {
    x: timestamps,
    y: prices,
    type: "scatter" as const,
    mode: isSparse ? ("markers" as const) : ("lines+markers" as const),
    name: "Oracle price (daily)",
    line: { color: "rgba(148,163,184,0.55)", width: 1.5 },
    marker: { size: markerSizes, color: markerColors },
    yaxis: "y" as const,
    hoverinfo: "text" as const,
    text: hoverText,
  };

  const { yMin, yMax } = computeOracleYRange(prices, baseline, thresholdRatio);
  return { deviationTrace, timestamps, isSparse, yMin, yMax };
}

// Scope daily candles to the visible X window (unix seconds), keeping one candle
// just past each edge so the line reaches the viewport. Candles are chronological
// ASC by bucketStart. Pure filter (NOT decimation — daily is already ≤1000 pts);
// the point is to bound the Y-range to the selected period so a far-off historical
// outlier can't flatten it. Falls back to all candles if the window has none.
function scopeToWindow(
  candles: readonly OracleDailyCandle[],
  [lo, hi]: readonly [number, number],
): readonly OracleDailyCandle[] {
  const first = candles.findIndex((c) => Number(c.bucketStart) >= lo);
  if (first === -1) return candles.slice(-1); // window entirely after data
  let last = first;
  for (let i = first; i < candles.length; i++) {
    if (Number(candles[i]!.bucketStart) <= hi) last = i;
    else break;
  }
  const scoped = candles.slice(
    Math.max(0, first - 1),
    Math.min(candles.length, last + 2),
  );
  return scoped.length > 0 ? scoped : candles;
}

/**
 * Decide whether the chart renders daily candles, and if so which ones.
 *
 * `active` is true when daily data exists AND either the user asked to see
 * everything (`showAll` — Plotly "All"/double-click autorange) or the visible
 * span exceeds the daily threshold. A null `visibleRange` with `showAll=false`
 * is the initial 7-day view → raw (active stays false). When active and a
 * `visibleRange` is set, candles are scoped to that window (so the Y-range
 * reflects the selected period); `showAll` (null range) keeps the full extent.
 */
export function resolveDailyView({
  visibleRange,
  showAll,
  dailyCandles,
}: {
  visibleRange: readonly [number, number] | null;
  showAll: boolean;
  dailyCandles: readonly OracleDailyCandle[] | undefined;
}): { active: boolean; candles: readonly OracleDailyCandle[] } {
  if (!dailyCandles?.length) return { active: false, candles: [] };
  const span = visibleRange ? visibleRange[1] - visibleRange[0] : null;
  const active = showAll || (span !== null && span > DAILY_MODE_SPAN_SECONDS);
  if (!active) return { active: false, candles: [] };
  return {
    active: true,
    candles: visibleRange
      ? scopeToWindow(dailyCandles, visibleRange)
      : dailyCandles,
  };
}
