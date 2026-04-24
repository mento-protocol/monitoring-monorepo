/**
 * SortedOracles always uses 24-decimal fixed-point precision.
 * Divide any raw oracle price value by 10^SORTED_ORACLES_DECIMALS to get the
 * human-readable rate.
 */
const SORTED_ORACLES_DECIMALS = 24;

/** TradingLimitsV2 stores all limit/netflow values in 15-decimal internal precision. */
export const TRADING_LIMITS_INTERNAL_DECIMALS = 15;

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

/** Rebalance boundary (bps) — returns `null` when no on-chain threshold was
 * recorded for the event (indexed before the schema bump, or threshold=0). */
export function formatBoundaryBps(
  bps: number | null | undefined,
): string | null {
  if (bps == null || bps <= 0) return null;
  return bps.toLocaleString();
}

/** Formatted effectiveness ratio as a percent, or `null` when the rebalance
 * was degenerate. The indexer stamps the raw string `"0.0000"` for events
 * where `computeEffectivenessRatio` returned null (threshold=0 sentinel,
 * pool already in-band, or before=0) — rendering those as "0.0%" would
 * misread as a KPI-4 failure. */
export function formatEffectivenessPercent(
  ratio: string | null | undefined,
): string | null {
  if (ratio == null || ratio === "0.0000") return null;
  return `${(Number(ratio) * 100).toFixed(1)}%`;
}

export { isValidAddress } from "@/lib/validators";

// Pool ID utilities live in lib/pool-id.ts — re-exported here for backward compatibility.
export { isNamespacedPoolId, normalizePoolIdForChain } from "@/lib/pool-id";

export function formatUSD(value: number): string {
  if (!Number.isFinite(value)) return "N/A";
  if (value >= 999_950) {
    const m = (value / 1_000_000).toFixed(2).replace(/\.?0+$/, "");
    return `$${m}M`;
  }
  if (value >= 1_000) {
    const k = (value / 1_000).toFixed(1).replace(/\.0$/, "");
    return `$${k}K`;
  }
  return `$${value.toFixed(2)}`;
}

// Oracle price formatting

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

/**
 * Display format for a positive oracle price. Uses 4dp for everything ≥ 0.01
 * (the common case), and extends precision for sub-cent values — a fiat pair
 * priced at 0.00067 USD would otherwise collapse to "0.0007" (or to "0.0000"
 * for even smaller rates) and misquote the pair. The extended path keeps at
 * least four significant figures, capped at 12dp to stay readable.
 */
export function formatOraclePrice(price: number): string {
  if (price <= 0) return "0.0000";
  if (price >= 0.01) return price.toFixed(4);
  const sigFigDecimals = Math.ceil(-Math.log10(price)) + 3;
  return price.toFixed(Math.min(sigFigDecimals, 12));
}

export function toPercent(raw: string, decimals = 4): string {
  if (!raw || raw === "0") return `0.${"0".repeat(decimals)}%`;
  const v = BigInt(raw);
  const scale = BigInt(10 ** decimals);
  const DIVISOR = BigInt("10000000000000000"); // 1e16 = 1e18 / 100
  const scaled = (v * scale) / DIVISOR;
  const integer = scaled / scale;
  const frac = scaled % scale;
  return `${integer}.${String(frac).padStart(decimals, "0")}%`;
}

type SwapDirection = {
  soldToken0: boolean;
  soldAmt: string;
  boughtAmt: string;
  soldSym: string;
  boughtSym: string;
  soldDec: number;
  boughtDec: number;
};

export function getSwapDirection(
  swap: {
    amount0In: string;
    amount1In: string;
    amount1Out: string;
    amount0Out: string;
  },
  sym0: string,
  sym1: string,
  dec0: number,
  dec1: number,
): SwapDirection {
  const soldToken0 = BigInt(swap.amount0In) > BigInt(0);
  return {
    soldToken0,
    soldAmt: soldToken0 ? swap.amount0In : swap.amount1In,
    boughtAmt: soldToken0 ? swap.amount1Out : swap.amount0Out,
    soldSym: soldToken0 ? sym0 : sym1,
    boughtSym: soldToken0 ? sym1 : sym0,
    soldDec: soldToken0 ? dec0 : dec1,
    boughtDec: soldToken0 ? dec1 : dec0,
  };
}
