// Pure helpers for the sparkline grid card. Extracted so the SVG-points
// math is testable without rendering the React tree — the component
// itself in `_components/stables-sparkline-grid.tsx` consumes
// `sparklinePoints(series, w, h, pad)`.

/**
 * Returns the `points` attribute string for a `<polyline>` SVG, mapping
 * `series` into a `w × h` viewBox with `pad` margin. Min-max normalized.
 *
 * Caller responsibilities:
 * - `series.length >= 2` (callers gate the render path on this and show
 *   a placeholder otherwise).
 * - `series` values are finite (`buildTokenUsdTimeSeries` enforces this
 *   via `parseWei` + multiplication by a Number rate).
 */
export function sparklinePoints(
  series: ReadonlyArray<number>,
  w: number,
  h: number,
  pad: number,
): string {
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;
  const step = (w - pad * 2) / (series.length - 1);
  return series
    .map((v, i) => {
      const x = pad + i * step;
      const y = pad + (h - pad * 2) * (1 - (v - min) / span);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}
