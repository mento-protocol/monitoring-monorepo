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
  return num.toLocaleString(undefined, {
    minimumFractionDigits: 2,
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

export function formatUSD(value: number): string {
  if (!Number.isFinite(value)) return "N/A";
  if (value >= 999_950) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Oracle price formatting
// ---------------------------------------------------------------------------

/** Set of USD-stable token symbols. If token0 is in this set, the SortedOracles
 * feed value ("1 feedToken = X USD") must be inverted to get the pool display
 * direction ("1 USDm = 1/X token1"). */
const USD_STABLE_SYMS = new Set(["USDm"]);

/**
 * Converts a raw SortedOracles oracle price (24dp integer string) to a
 * human-readable number in pool display direction (token0 → token1).
 *
 * SortedOracles stores prices as "1 feedToken = X USD" (feed direction).
 * When token0 is USD-stable (USDm), the pool shows "1 USDm = 1/X token1",
 * so we invert. For non-USD-stable token0 (e.g. USDT/USDm) no inversion needed.
 *
 * Returns 0 if price is missing or invalid.
 */
export function parseOraclePriceToNumber(
  rawPrice: string | null | undefined,
  sym0: string,
): number {
  if (!rawPrice || rawPrice === "0") return 0;
  const feedValue = Number(rawPrice) / 10 ** SORTED_ORACLES_DECIMALS;
  if (!isFinite(feedValue) || feedValue <= 0) return 0;
  return USD_STABLE_SYMS.has(sym0) ? 1 / feedValue : feedValue;
}
