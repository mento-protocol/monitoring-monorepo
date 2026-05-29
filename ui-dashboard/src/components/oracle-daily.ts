// Daily-candle render path for the oracle chart (the zoomed-out resolution).
// Kept out of oracle-chart.tsx for two reasons: (1) the 1000-line cap, and
// (2) candle coloring is direct-from-`anyOutOfBand` (the precomputed breaker
// verdict), NOT the per-snapshot band recompute the raw path runs — so a
// zoomed-out candle stays red when an intraday trip recovered by close.

const FIXIDITY_ONE = 1e24;

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
  const dev =
    c.maxDeviationRatio !== "-1" ? ` · max dev ${c.maxDeviationRatio}` : "";
  return `${date}<br>${ohlc}<br>${c.sampleCount} medians${verdict}${dev}`;
}

interface OracleDailyPlotData {
  deviationTrace: Record<string, unknown>;
  timestamps: string[];
  isSparse: boolean;
  yMin: number;
  yMax: number;
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
}): OracleDailyPlotData {
  const isSparse = candles.length < 20;
  const timestamps = candles.map((c) =>
    new Date(Number(c.bucketStart) * 1000).toISOString(),
  );
  const prices = candles.map((c) => fixToFloat(c.closePrice));
  // Direct from the precomputed verdict — never recompute from close + band
  // (an intraday trip that recovered by close must still read red).
  const markerColors = candles.map((c) =>
    c.anyOutOfBand ? "#ef4444" : "#22c55e",
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
