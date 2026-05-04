import { KNOWN_TOKEN_META } from "./feeToken";

/**
 * Tokens treated as $1.00 for USD conversion. Mirrors
 * `ui-dashboard/src/lib/tokens.ts:USD_PEGGED_SYMBOLS` — keep in sync. The
 * drift-protection test in `test/usd.test.ts` enforces this.
 */
export const USD_PEGGED_SYMBOLS = new Set<string>([
  "cUSD",
  "USDC",
  "axlUSDC",
  "USDT",
  "USDT0",
  "USD₮",
  "USDm",
  "AUSD",
]);

/** `Pool.rebalanceReward` sentinels: `-1` (RPC not yet read) and `-2` (getter
 *  missing — see PR #222) collapse to 0 so reward arithmetic is well-defined. */
export function normalizeRewardBps(bps: number): number {
  return bps < 0 ? 0 : bps;
}

const bAbs = (n: bigint): bigint => (n < 0n ? -n : n);

/**
 * Convert a wei-scaled amount to a 4dp fixed-point string. Truncates (not
 * rounds) on overflow past 4dp — acceptable for monitoring display.
 *
 * Example: `formatFixed4(1234567890n, 6)` → `"1234.5678"` (USDC, 6 decimals).
 */
function formatFixed4(value: bigint, decimals: number): string {
  const abs = bAbs(value);
  const SCALE = 10_000n; // 10^4
  const int4dp =
    decimals >= 4
      ? (abs * SCALE) / 10n ** BigInt(decimals)
      : abs * 10n ** BigInt(4 - decimals);
  return `${int4dp / SCALE}.${String(int4dp % SCALE).padStart(4, "0")}`;
}

/**
 * Pick the USD-pegged side from two absolute token amounts. If both sides are
 * pegged (stable/stable), prefers the side with the larger USD notional after
 * decimal normalization to be robust against asymmetric fees/rounding. Cross-
 * multiplies to compare without dividing: a/10^da ≥ b/10^db ⇔ a × 10^db ≥ b × 10^da.
 *
 * Returns `null` when token addresses are missing, both abs amounts are zero,
 * or neither side is in `USD_PEGGED_SYMBOLS`.
 */
function pickPeggedSide(
  chainId: number,
  token0: string | undefined,
  token1: string | undefined,
  abs0: bigint,
  abs1: bigint,
  decimals0: number,
  decimals1: number,
): { peggedAmount: bigint; peggedDecimals: number } | null {
  if (!token0 || !token1 || (abs0 === 0n && abs1 === 0n)) return null;

  const sym0 = KNOWN_TOKEN_META.get(
    `${chainId}:${token0.toLowerCase()}`,
  )?.symbol;
  const sym1 = KNOWN_TOKEN_META.get(
    `${chainId}:${token1.toLowerCase()}`,
  )?.symbol;
  const peg0 = sym0 !== undefined && USD_PEGGED_SYMBOLS.has(sym0);
  const peg1 = sym1 !== undefined && USD_PEGGED_SYMBOLS.has(sym1);
  if (!peg0 && !peg1) return null;

  const useToken0 =
    peg0 &&
    (!peg1 ||
      abs0 * 10n ** BigInt(decimals1) >= abs1 * 10n ** BigInt(decimals0));
  return useToken0
    ? { peggedAmount: abs0, peggedDecimals: decimals0 }
    : { peggedAmount: abs1, peggedDecimals: decimals1 };
}

export interface RebalanceUsdInput {
  chainId: number;
  /** Pool.token0 / token1. Optional — VirtualPools can lack token addresses,
   *  in which case USD is uncomputable and the function returns `""`. */
  token0: string | undefined;
  token1: string | undefined;
  token0Decimals: number;
  token1Decimals: number;
  amount0Delta: bigint;
  amount1Delta: bigint;
  /** Already passed through `normalizeRewardBps` by the caller. */
  rewardBps: number;
}

export interface RebalanceUsd {
  /** Notional USD value of the rebalance, fixed-point 4dp (e.g. `"1234.5678"`).
   *  `""` when the pool has no exactly-one USD-pegged side or pre-reserves
   *  RPC failed (callers signal failure by passing zero deltas). */
  notionalUsd: string;
  /** `notionalUsd × rewardBps / 10_000`, fixed-point 4dp. `""` mirrors
   *  `notionalUsd`. */
  rewardUsd: string;
}

/**
 * Compute the USD notional + caller-incentive reward of a rebalance from the
 * reserve deltas. Uses a USD-pegged side's |delta| as the notional —
 * rebalances are roughly-symmetric swaps, so either pegged side gives the
 * same number within rounding. For stable/stable pools (both legs pegged,
 * e.g. USDC/USDm), picks whichever side has the larger USD notional after
 * decimal normalization to be robust against asymmetric fees/rounding.
 *
 * Returns `{ "", "" }` only when token addresses are missing, neither token
 * is USD-pegged, or both deltas are zero (RPC fallback path).
 */
export function computeRebalanceUsd(input: RebalanceUsdInput): RebalanceUsd {
  const {
    chainId,
    token0,
    token1,
    token0Decimals,
    token1Decimals,
    amount0Delta,
    amount1Delta,
    rewardBps,
  } = input;

  const picked = pickPeggedSide(
    chainId,
    token0,
    token1,
    bAbs(amount0Delta),
    bAbs(amount1Delta),
    token0Decimals,
    token1Decimals,
  );
  if (picked === null) return { notionalUsd: "", rewardUsd: "" };

  const { peggedAmount, peggedDecimals } = picked;
  const notionalUsd = formatFixed4(peggedAmount, peggedDecimals);
  const rewardUsd = formatFixed4(
    applyFeeBps(peggedAmount, rewardBps),
    peggedDecimals,
  );
  return { notionalUsd, rewardUsd };
}

// ---------------------------------------------------------------------------
// Swap USD valuation
// ---------------------------------------------------------------------------

/** Common scale for aggregated USD fields in trader/aggregator snapshots.
 *  18 decimals (matches ETH-wei convention) — chosen so a single BigInt cell
 *  comfortably holds total volume across years without precision loss, and
 *  arithmetic is plain BigInt addition. */
export const USD_WEI_DECIMALS = 18;

/** Scale a token-native amount to 18-decimal USD-wei.
 *  Assumes the input token is USD-pegged (1 token = $1). */
function scaleToUsdWei(amount: bigint, tokenDecimals: number): bigint {
  if (tokenDecimals === USD_WEI_DECIMALS) return amount;
  if (tokenDecimals < USD_WEI_DECIMALS) {
    return amount * 10n ** BigInt(USD_WEI_DECIMALS - tokenDecimals);
  }
  return amount / 10n ** BigInt(tokenDecimals - USD_WEI_DECIMALS);
}

export interface SwapUsdInput {
  chainId: number;
  token0: string | undefined;
  token1: string | undefined;
  token0Decimals: number;
  token1Decimals: number;
  amount0In: bigint;
  amount0Out: bigint;
  amount1In: bigint;
  amount1Out: bigint;
}

/**
 * Compute the USD notional of a swap as 18-decimal USD-wei.
 *
 * Picks the USD-pegged side (per `USD_PEGGED_SYMBOLS`) and uses
 * `|amountIn - amountOut|` of that side as the notional — exactly one of in/out
 * is non-zero per side in a normal swap, so the absolute difference equals the
 * traded amount. If both sides are pegged (stable/stable), prefers the side
 * with the larger USD notional after decimal normalization (defensive against
 * fee/rounding asymmetry).
 *
 * Returns `0n` when neither token address is provided or neither side is
 * pegged. Callers should distinguish "uncomputable" from "zero-volume swap"
 * by also checking the raw amounts.
 */
export function computeSwapUsdWei(input: SwapUsdInput): bigint {
  const {
    chainId,
    token0,
    token1,
    token0Decimals,
    token1Decimals,
    amount0In,
    amount0Out,
    amount1In,
    amount1Out,
  } = input;

  const picked = pickPeggedSide(
    chainId,
    token0,
    token1,
    bAbs(amount0In - amount0Out),
    bAbs(amount1In - amount1Out),
    token0Decimals,
    token1Decimals,
  );
  if (picked === null) return 0n;
  return scaleToUsdWei(picked.peggedAmount, picked.peggedDecimals);
}

/** Multiply USD-wei by a fee bps and return the fee in USD-wei.
 *  `feeBps` is integer bps (e.g., 30 = 0.30%). */
export function applyFeeBps(volumeUsdWei: bigint, feeBps: number): bigint {
  if (feeBps <= 0) return 0n;
  return (volumeUsdWei * BigInt(feeBps)) / 10_000n;
}
