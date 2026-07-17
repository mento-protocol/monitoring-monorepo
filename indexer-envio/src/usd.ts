import { KNOWN_TOKEN_META } from "./feeToken.js";

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

const EXPLICIT_FX_CURRENCY_BY_SYMBOL: Readonly<Record<string, string>> = {
  axlEUROC: "EUR",
  cEUR: "EUR",
  EUROP: "EUR",
};

function currencyForSymbol(symbol: string | undefined): string | null {
  if (symbol === undefined) return null;
  if (USD_PEGGED_SYMBOLS.has(symbol)) return "USD";
  const explicit = EXPLICIT_FX_CURRENCY_BY_SYMBOL[symbol];
  if (explicit !== undefined) return explicit;
  if (/^[A-Z]{3}m$/.test(symbol)) return symbol.slice(0, 3);
  return null;
}

function tokenCurrency(
  chainId: number,
  token: string | undefined,
): string | null {
  if (!token) return null;
  return currencyForSymbol(
    KNOWN_TOKEN_META.get(`${chainId}:${token.toLowerCase()}`)?.symbol,
  );
}

/**
 * Currency shared by both legs of a non-USD stable pair (for example
 * EURm/EUROP). These pairs need a historical same-chain FX rate rather than
 * the $1 pegged-leg shortcut used by USDm/USDC pools.
 */
export function swapFxCurrency(input: {
  chainId: number;
  token0: string | undefined;
  token1: string | undefined;
}): string | null {
  const currency0 = tokenCurrency(input.chainId, input.token0);
  const currency1 = tokenCurrency(input.chainId, input.token1);
  if (
    currency0 === null ||
    currency1 === null ||
    currency0 === "USD" ||
    currency0 !== currency1
  ) {
    return null;
  }
  return currency0;
}

/** True when a pool is a USD/currency cross that can price `currency`. */
export function poolCarriesUsdRateForCurrency(
  chainId: number,
  token0: string | undefined,
  token1: string | undefined,
  currency: string,
): boolean {
  const currencies = [
    tokenCurrency(chainId, token0),
    tokenCurrency(chainId, token1),
  ];
  return currencies.includes("USD") && currencies.includes(currency);
}

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
interface TokenAmount {
  token: string | undefined;
  amount: bigint;
  decimals: number;
}

function pickPeggedSide(
  chainId: number,
  side0: TokenAmount,
  side1: TokenAmount,
): { peggedAmount: bigint; peggedDecimals: number } | null {
  if (
    !side0.token ||
    !side1.token ||
    (side0.amount === 0n && side1.amount === 0n)
  ) {
    return null;
  }

  const sym0 = KNOWN_TOKEN_META.get(
    `${chainId}:${side0.token.toLowerCase()}`,
  )?.symbol;
  const sym1 = KNOWN_TOKEN_META.get(
    `${chainId}:${side1.token.toLowerCase()}`,
  )?.symbol;
  const peg0 = sym0 !== undefined && USD_PEGGED_SYMBOLS.has(sym0);
  const peg1 = sym1 !== undefined && USD_PEGGED_SYMBOLS.has(sym1);
  if (!peg0 && !peg1) return null;

  const useToken0 =
    peg0 &&
    (!peg1 ||
      side0.amount * 10n ** BigInt(side1.decimals) >=
        side1.amount * 10n ** BigInt(side0.decimals));
  return useToken0
    ? { peggedAmount: side0.amount, peggedDecimals: side0.decimals }
    : { peggedAmount: side1.amount, peggedDecimals: side1.decimals };
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
  /** When false, USD valuation is gated to the `""` (uncomputable)
   *  sentinel. A non-18-decimal USD leg computed against the schema-
   *  default 18/18 would persist USD off by `10^(18 - real_dec)` for
   *  the lifetime of the row. Optional: callers can omit (legacy
   *  behaviour = always compute). */
  tokenDecimalsKnown?: boolean;
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
    tokenDecimalsKnown,
  } = input;

  // Gate USD on `tokenDecimalsKnown` when present (see RebalanceUsdInput
  // doc). Returns the same `""` sentinel as the address-missing /
  // not-pegged cases below.
  if (tokenDecimalsKnown === false) {
    return { notionalUsd: "", rewardUsd: "" };
  }

  const picked = pickPeggedSide(
    chainId,
    {
      token: token0,
      amount: bAbs(amount0Delta),
      decimals: token0Decimals,
    },
    {
      token: token1,
      amount: bAbs(amount1Delta),
      decimals: token1Decimals,
    },
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
 *  Assumes the input token is USD-pegged (1 token = $1).
 *  Truncates (not rounds) when `tokenDecimals > 18`. No USD-pegged token
 *  exceeds 18 decimals today; revisit if that ever changes. */
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
export function computeSwapUsdWei(
  input: SwapUsdInput,
  /** USD per token, Fixidity-scaled (1e24 = $1). Required only for a
   * same-currency non-USD pair such as EURm/EUROP. */
  fxUsdRate?: bigint,
): bigint {
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

  // Match the gross-leg convention used by `Pool.notionalVolume0/1` upserts
  // (handlers/fpmm.ts, handlers/virtualPool.ts): notional per side is the
  // larger of (in, out). For standard Uniswap-V2-style swaps exactly one is
  // non-zero so this equals |in − out|; for callback/flash-style flows where
  // both are non-zero, gross is the correct accounting choice.
  const a0 = amount0In > amount0Out ? amount0In : amount0Out;
  const a1 = amount1In > amount1Out ? amount1In : amount1Out;

  const picked = pickPeggedSide(
    chainId,
    { token: token0, amount: a0, decimals: token0Decimals },
    { token: token1, amount: a1, decimals: token1Decimals },
  );
  if (picked !== null) {
    return scaleToUsdWei(picked.peggedAmount, picked.peggedDecimals);
  }

  if (fxUsdRate === undefined || fxUsdRate <= 0n) return 0n;
  if (swapFxCurrency(input) === null) return 0n;
  const useToken0 =
    a0 * 10n ** BigInt(token1Decimals) >= a1 * 10n ** BigInt(token0Decimals);
  const amountUsdWei = useToken0
    ? scaleToUsdWei(a0, token0Decimals)
    : scaleToUsdWei(a1, token1Decimals);
  return (amountUsdWei * fxUsdRate) / 10n ** 24n;
}

/**
 * Compute the USD-wei equivalent of a protocol fee transfer.
 *
 * Pegged-only: returns 0n for non-pegged tokens (dashboard prices those
 * via oracle rate map). Pegged tokens get scaled to USD-wei (18 dp),
 * matching `TraderDailySnapshot.feesPaidUsdWei` and `RebalanceEvent.notionalUsd`.
 */
export function computeFeeUsdWei({
  tokenSymbol,
  tokenDecimals,
  amount,
}: {
  tokenSymbol: string;
  tokenDecimals: number;
  amount: bigint;
}): bigint {
  if (!USD_PEGGED_SYMBOLS.has(tokenSymbol)) return 0n;
  return scaleToUsdWei(amount, tokenDecimals);
}

/** Multiply USD-wei by a fee bps and return the fee in USD-wei.
 *  `feeBps` is integer bps (e.g., 30 = 0.30%). */
export function applyFeeBps(volumeUsdWei: bigint, feeBps: number): bigint {
  if (feeBps <= 0) return 0n;
  return (volumeUsdWei * BigInt(feeBps)) / 10_000n;
}
