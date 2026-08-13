const decimal = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 6,
  maximumFractionDigits: 6,
});
const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** Executable prices, e.g. `0.999692`. */
export const formatNumber = (value: number | null): string =>
  value === null ? "—" : decimal.format(value);

/** Spread and threshold copy reads in whole bps, matching the mockup. */
export const formatWholeBps = (value: number | null): string =>
  value === null ? "—" : `${whole.format(value)} bps`;

export const formatFraction = (value: number | null): string =>
  value === null ? "—" : `${whole.format(value * 100)}%`;

export const formatAge = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3_600)}h`;
};

/**
 * "checked 29s ago" for a unix-seconds observation, or `null` when the
 * measurement carries no timestamp at all.
 */
export function checkedAgo(
  atSeconds: number | null,
  nowMs: number,
): string | null {
  if (atSeconds === null) return null;
  return `checked ${formatAge(Math.max(0, nowMs - atSeconds * 1_000))} ago`;
}

/** `600` → `10 minutes`; used to interpolate policy windows into alert copy. */
export function formatDuration(seconds: number): string {
  if (seconds >= 3_600 && seconds % 3_600 === 0) {
    const hours = seconds / 3_600;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  if (seconds >= 60 && seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

/** `30` → `30s`, for the header's "Checks every 30s". */
export function formatShortDuration(seconds: number): string {
  if (seconds >= 3_600 && seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}
