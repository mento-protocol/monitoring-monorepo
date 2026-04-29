import { KNOWN_TOKEN_META } from "./feeToken";

/**
 * Tokens treated as $1.00 for USD conversion. Mirrors
 * `ui-dashboard/src/lib/tokens.ts:USD_PEGGED_SYMBOLS` — keep in sync. The
 * drift-protection test in `test/usdPeggedSymbols.test.ts` enforces this.
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
 * reserve deltas. Uses the USD-pegged side's |delta| as the notional —
 * rebalances are roughly-symmetric swaps, so the non-pegged side × oracle
 * price would yield the same number within rounding (not enforced here).
 *
 * Returns `{ "", "" }` when token addresses are missing, neither (or both)
 * tokens are USD-pegged, or both deltas are zero (RPC fallback path).
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

  if (!token0 || !token1 || (amount0Delta === 0n && amount1Delta === 0n)) {
    return { notionalUsd: "", rewardUsd: "" };
  }

  const sym0 = KNOWN_TOKEN_META.get(
    `${chainId}:${token0.toLowerCase()}`,
  )?.symbol;
  const sym1 = KNOWN_TOKEN_META.get(
    `${chainId}:${token1.toLowerCase()}`,
  )?.symbol;
  const peg0 = sym0 !== undefined && USD_PEGGED_SYMBOLS.has(sym0);
  const peg1 = sym1 !== undefined && USD_PEGGED_SYMBOLS.has(sym1);

  if (peg0 === peg1) {
    return { notionalUsd: "", rewardUsd: "" };
  }

  const absDelta = bAbs(peg0 ? amount0Delta : amount1Delta);
  const decimals = peg0 ? token0Decimals : token1Decimals;

  const notionalUsd = formatFixed4(absDelta, decimals);
  const rewardUsd = formatFixed4(
    (absDelta * BigInt(rewardBps)) / 10_000n,
    decimals,
  );

  return { notionalUsd, rewardUsd };
}
