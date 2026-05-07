export const SECONDS_PER_HOUR = 3_600;
export const SECONDS_PER_DAY = 86_400;

export type RangeKey = "7d" | "30d" | "90d" | "all";

const RANGE_DAYS: Record<RangeKey, number | null> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  all: null,
};

export const RANGES: ReadonlyArray<{
  key: RangeKey;
  label: string;
}> = [
  { key: "7d", label: "1W" },
  { key: "30d", label: "1M" },
  { key: "all", label: "All" },
];

/**
 * Leaderboard-specific ranges: 1M / 3M / All (no 1W — too few datapoints
 * to read the per-pool stacked breakdown). Charts that want a different
 * pill set than the default `RANGES` pass this via the chart card's
 * `ranges` prop.
 */
export const LEADERBOARD_CHART_RANGES: ReadonlyArray<{
  key: RangeKey;
  label: string;
}> = [
  { key: "30d", label: "1M" },
  { key: "90d", label: "3M" },
  { key: "all", label: "All" },
];

/**
 * Leaderboard fallback / single-line chart pill set. Used by the v3+<30d
 * and v2 single-line daily-volume charts: needs to cover every chartRange
 * the page can produce (7d / 30d / 90d / all) so the active pill always
 * matches the page's selected window.
 */
export const LEADERBOARD_FALLBACK_CHART_RANGES: ReadonlyArray<{
  key: RangeKey;
  label: string;
}> = [
  { key: "7d", label: "1W" },
  { key: "30d", label: "1M" },
  { key: "90d", label: "3M" },
  { key: "all", label: "All" },
];

export type TimeSeriesPoint = {
  timestamp: number;
  value: number;
};

export function filterSeriesByRange(
  series: readonly TimeSeriesPoint[],
  range: RangeKey,
): TimeSeriesPoint[] {
  const days = RANGE_DAYS[range];
  if (days === null) return [...series];
  const cutoff = Math.floor(Date.now() / 1000) - days * SECONDS_PER_DAY;
  return series.filter((point) => point.timestamp >= cutoff);
}

/** Days-in-window for a RangeKey; `null` means "all time" (no cutoff). */
export function rangeKeyToDays(range: RangeKey): number | null {
  return RANGE_DAYS[range];
}
