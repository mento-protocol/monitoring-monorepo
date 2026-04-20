export const SECONDS_PER_DAY = 86_400;

export type RangeKey = "7d" | "30d" | "all";

const RANGE_DAYS: Record<RangeKey, number | null> = {
  "7d": 7,
  "30d": 30,
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
