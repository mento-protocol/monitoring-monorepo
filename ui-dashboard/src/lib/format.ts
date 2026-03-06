/**
 * SortedOracles always uses 24-decimal fixed-point precision.
 * Divide any raw oracle price value by 10^SORTED_ORACLES_DECIMALS to get the
 * human-readable rate.
 */
export const SORTED_ORACLES_DECIMALS = 24;

export function truncateAddress(address: string | null): string {
  if (!address) return "\u2014";
  if (address.length <= 10) return address;
  return `${address.slice(0, 6)}\u2026${address.slice(-4)}`;
}

/** Raw numeric conversion from wei string -- for charts and calculations. */
export function parseWei(value: string, decimals = 18): number {
  if (!value || value === "0") return 0;
  return Number(value) / 10 ** decimals;
}

// Number() loses precision beyond ~9,007 tokens (2^53 wei at 18 decimals).
// Acceptable for display; use BigInt division if sub-wei precision matters.
export function formatWei(value: string, decimals = 18, display = 4): string {
  if (!value || value === "0") return "0";
  const num = Number(value) / 10 ** decimals;
  if (Math.abs(num) < 0.0001 && num !== 0) return num.toExponential(2);
  return num.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: display,
  });
}

export function formatTimestamp(ts: string): string {
  if (!ts || ts === "0") return "\u2014";
  return new Date(Number(ts) * 1000).toLocaleString();
}

export function relativeTime(ts: string): string {
  if (!ts || ts === "0") return "\u2014";
  const diff = Date.now() - Number(ts) * 1000;
  if (diff < 0) return formatTimestamp(ts);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function formatBlock(bn: string): string {
  return Number(bn).toLocaleString();
}

export function isValidAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}
