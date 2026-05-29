/**
 * Viewport-scoped, anomaly-preserving decimation for chart series.
 *
 * Why this exists: the windowed-history hook can accumulate tens of thousands
 * of rows as the user scrolls back. The oracle chart renders an SVG `scatter`
 * trace with per-point marker color/size/hover arrays — one DOM node per
 * point — which gets sluggish past ~2–4k points. So we cap the number of
 * RENDERED points while keeping the chart honest:
 *
 *   1. Scope to the visible X window (+ a one-span margin each side so small
 *      pans don't reveal empty edges before the next relayout re-decimates).
 *      Zoomed in → the window holds few rows → no decimation → exact raw
 *      points. Zoomed out → decimate.
 *   2. NEVER drop an anomalous (red) point — a breaker-trip or rejected report
 *      is the whole reason an operator looks at this chart. Only the "normal"
 *      points are strided down to fit the budget.
 *   3. Always keep the first and last in-window points so the line doesn't
 *      visually truncate at the viewport edges.
 *
 * Pure + generic so it unit-tests without React/Plotly.
 */

export interface DecimateOptions<T> {
  /** Visible X window in unix seconds, or `null` to consider the whole series. */
  visibleRange: [number, number] | null;
  /** Soft cap on rendered points. Anomalies always survive even past the cap. */
  cap: number;
  /** Row → unix-seconds timestamp. */
  getTimestamp: (row: T) => number;
  /** Row → true if it must never be dropped (renders red / rejected). */
  isAnomalous: (row: T) => boolean;
}

/**
 * Decimate `rows` (assumed sorted ASC by timestamp) to at most ~`cap` points
 * within the visible window, preserving every anomalous point and the window
 * endpoints. Returns a new ASC-sorted array; never mutates the input.
 */
export function decimateSeries<T>(rows: T[], opts: DecimateOptions<T>): T[] {
  const { visibleRange, cap, getTimestamp, isAnomalous } = opts;
  if (rows.length === 0) return rows;

  // 1. Window scope (+ one-span margin each side).
  const windowed = sliceToWindow(rows, visibleRange, getTimestamp);
  if (windowed.length <= cap) return windowed; // exact raw points — no decimation

  // 2. Partition: anomalies always kept; normals are the decimation pool.
  const keep = new Set<number>(); // indices into `windowed`
  const normalIdx: number[] = [];
  for (let i = 0; i < windowed.length; i += 1) {
    if (isAnomalous(windowed[i]!)) keep.add(i);
    else normalIdx.push(i);
  }
  // 3. Always keep the window endpoints (line continuity).
  keep.add(0);
  keep.add(windowed.length - 1);

  // 4. Stride the normals into whatever budget remains after anomalies.
  const budget = Math.max(0, cap - keep.size);
  if (budget > 0 && normalIdx.length > budget) {
    const stride = Math.ceil(normalIdx.length / budget);
    for (let j = 0; j < normalIdx.length; j += stride) keep.add(normalIdx[j]!);
  } else {
    // Budget covers all normals (only possible when anomalies pushed us over
    // the cap on their own) — keep them all; anomalies still win.
    for (const idx of normalIdx) keep.add(idx);
  }

  // Emit in original ASC order.
  const out: T[] = [];
  for (let i = 0; i < windowed.length; i += 1) {
    if (keep.has(i)) out.push(windowed[i]!);
  }
  return out;
}

function sliceToWindow<T>(
  rows: T[],
  visibleRange: [number, number] | null,
  getTimestamp: (row: T) => number,
): T[] {
  if (!visibleRange) return rows;
  const [lo, hi] = visibleRange;
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return rows;
  // One-span margin each side so a small pan shows neighbouring data before
  // the next relayout fires a fresh decimation.
  const span = hi - lo;
  const from = lo - span;
  const to = hi + span;
  const sliced = rows.filter((r) => {
    const t = getTimestamp(r);
    return t >= from && t <= to;
  });
  // Never return empty just because the window sits between two sparse points —
  // fall back to the full series so the chart still renders something.
  return sliced.length > 0 ? sliced : rows;
}
