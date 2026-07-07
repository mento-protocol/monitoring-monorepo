// Pure helpers for the sparkline grid card. Extracted so the SVG-points
// math is testable without rendering the React tree — the component
// itself in `_components/stables-sparkline-grid.tsx` consumes
// `sparklinePoints(series, w, h, pad)`.

/**
 * Returns the `points` attribute string for a `<polyline>` SVG, mapping
 * `series` into a `w × h` viewBox with `pad` margin. The y-axis is a shared
 * signed percent-change scale around the first non-zero value, so card
 * amplitude remains comparable across tokens instead of stretching each
 * token's own min/max to the full height. The scale uses a monotone log curve
 * to keep sub-1% moves visible while preserving severity rank for large moves.
 *
 * Caller responsibilities:
 * - `series.length >= 2` (callers gate the render path on this and show
 *   a placeholder otherwise).
 * - `series` values are finite (`buildTokenUsdTimeSeries` enforces this
 *   via `parseWei` + multiplication by a Number rate).
 */
const SPARKLINE_MAX_ABS_CHANGE_PCT = 50;
const SPARKLINE_LOG_KNEE_PCT = 0.25;

export function sparklinePoints(
  series: ReadonlyArray<number>,
  w: number,
  h: number,
  pad: number,
): string {
  const baseline = firstNonZero(series);
  const denominator = Math.abs(baseline ?? 1);
  const step = (w - pad * 2) / (series.length - 1);
  const midY = h / 2;
  const halfHeight = (h - pad * 2) / 2;

  return series
    .map((v, i) => {
      const x = pad + i * step;
      const pctChange =
        baseline === null ? 0 : ((v - baseline) / denominator) * 100;
      const boundedPct = clamp(scaledPercentChange(pctChange), -1, 1);
      const y = midY - boundedPct * halfHeight;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function firstNonZero(series: ReadonlyArray<number>): number | null {
  for (const value of series) {
    if (value !== 0) return value;
  }
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function scaledPercentChange(percentChange: number): number {
  if (percentChange === 0) return 0;
  const magnitude =
    Math.log1p(Math.abs(percentChange) / SPARKLINE_LOG_KNEE_PCT) /
    Math.log1p(SPARKLINE_MAX_ABS_CHANGE_PCT / SPARKLINE_LOG_KNEE_PCT);
  return Math.sign(percentChange) * magnitude;
}
