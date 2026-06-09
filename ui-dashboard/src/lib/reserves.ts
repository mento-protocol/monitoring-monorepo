import { parseWei } from "@/lib/format";
import type { Network } from "@/lib/networks";
import {
  canValueTvl,
  tokenSymbol,
  tokenToUSD,
  USDM_SYMBOLS,
  type OracleRateMap,
} from "@/lib/tokens";
import type { Pool } from "@/lib/types";

/**
 * Pure computation helpers for reserve visualizations.
 * Extracted for testability — all functions are side-effect free.
 */

/**
 * Computes USD-normalized fill percentages for a two-asset pool.
 *
 * Prefers USD-normalized pct when oracle price is available to avoid
 * misleading displays for non-parity pairs (e.g. a balanced KESm/USDm pool
 * has ~130:1 raw token ratio but 50/50 USD value). Falls back to raw token
 * count when oracle data is absent.
 *
 * Edge cases:
 * - Both reserves zero: returns pct0=0, pct1=100 (component should guard against rendering this)
 * - One reserve null (not yet indexed): rawTotal = 0 → pct0=0, pct1=100
 */
export function computeReservePcts(
  r0: number | null,
  r1: number | null,
  usd0: number | null,
  usd1: number | null,
): { pct0: number; pct1: number } {
  const usdTotal = usd0 !== null && usd1 !== null ? usd0 + usd1 : null;
  const rawTotal = r0 !== null && r1 !== null ? r0 + r1 : 0;
  const pct0 =
    usdTotal !== null && usdTotal > 0
      ? (usd0! / usdTotal) * 100
      : rawTotal > 0
        ? (r0! / rawTotal) * 100
        : 0;
  return { pct0, pct1: 100 - pct0 };
}

export type ReserveComposition =
  | {
      kind: "available";
      symbol0: string;
      symbol1: string;
      reserve0: number;
      reserve1: number;
      usd0: number;
      usd1: number;
      usdTotal: number;
      pct0: number;
      pct1: number;
    }
  | {
      kind: "untrusted-decimals" | "missing" | "empty" | "unpriceable";
      symbol0: string;
      symbol1: string;
    };

function usdRateFromOraclePrice(
  oraclePrice: string | undefined,
): number | null {
  if (!oraclePrice || oraclePrice === "0") return null;
  const rate = Number(oraclePrice) / 1e24;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

function reserveUsdValue({
  symbol,
  otherSymbol,
  reserve,
  feedRate,
  rates,
}: {
  symbol: string;
  otherSymbol: string;
  reserve: number;
  feedRate: number;
  rates: OracleRateMap;
}): number | null {
  if (USDM_SYMBOLS.has(symbol)) return reserve;
  if (USDM_SYMBOLS.has(otherSymbol)) return reserve * feedRate;

  const directRate = tokenToUSD(symbol, 1, rates);
  if (directRate !== null) return reserve * directRate;

  const otherRate = tokenToUSD(otherSymbol, 1, rates);
  return otherRate !== null ? reserve * feedRate * otherRate : null;
}

function reserveUsdValues({
  pool,
  symbol0,
  symbol1,
  reserve0,
  reserve1,
  rates,
}: {
  pool: Pick<Pool, "oraclePrice">;
  symbol0: string;
  symbol1: string;
  reserve0: number;
  reserve1: number;
  rates: OracleRateMap;
}): { usd0: number; usd1: number } | null {
  const feedRate = usdRateFromOraclePrice(pool.oraclePrice);
  if (feedRate === null) return null;

  const usd0 = reserveUsdValue({
    symbol: symbol0,
    otherSymbol: symbol1,
    reserve: reserve0,
    feedRate,
    rates,
  });
  const usd1 = reserveUsdValue({
    symbol: symbol1,
    otherSymbol: symbol0,
    reserve: reserve1,
    feedRate,
    rates,
  });
  return usd0 !== null && usd1 !== null ? { usd0, usd1 } : null;
}

export function computeReserveComposition(
  pool: Pick<
    Pool,
    | "token0"
    | "token1"
    | "token0Decimals"
    | "token1Decimals"
    | "tokenDecimalsKnown"
    | "reserves0"
    | "reserves1"
    | "oraclePrice"
  >,
  network: Network,
  rates: OracleRateMap,
): ReserveComposition {
  const symbol0 = tokenSymbol(network, pool.token0 ?? null);
  const symbol1 = tokenSymbol(network, pool.token1 ?? null);

  if (pool.tokenDecimalsKnown !== true) {
    return { kind: "untrusted-decimals", symbol0, symbol1 };
  }
  if (pool.reserves0 == null || pool.reserves1 == null) {
    return { kind: "missing", symbol0, symbol1 };
  }

  const reserve0 = parseWei(pool.reserves0, pool.token0Decimals ?? 18);
  const reserve1 = parseWei(pool.reserves1, pool.token1Decimals ?? 18);
  if (reserve0 === 0 && reserve1 === 0) {
    return { kind: "empty", symbol0, symbol1 };
  }
  if (!canValueTvl(pool, network, rates)) {
    return { kind: "unpriceable", symbol0, symbol1 };
  }

  const usdValues = reserveUsdValues({
    pool,
    symbol0,
    symbol1,
    reserve0,
    reserve1,
    rates,
  });
  // Second unpriceable path: canValueTvl passed its string-level guard, but
  // usdRateFromOraclePrice still rejected an Infinity/NaN oracle price.
  if (usdValues === null) {
    return { kind: "unpriceable", symbol0, symbol1 };
  }

  const { usd0, usd1 } = usdValues;
  const usdTotal = usd0 + usd1;
  const { pct0, pct1 } = computeReservePcts(reserve0, reserve1, usd0, usd1);

  return {
    kind: "available",
    symbol0,
    symbol1,
    reserve0,
    reserve1,
    usd0,
    usd1,
    usdTotal,
    pct0,
    pct1,
  };
}

/**
 * Threshold fill percentages at which priceDifference = rebalanceThreshold.
 *
 * Uses USD-normalized pct where the equilibrium is always 50/50 by
 * construction (both sides have equal USD value when the pool is balanced
 * at oracle price). At critical threshold T = rebalanceThreshold/10000:
 *
 *   threshold0Upper = 100 / (2 − T)   ← too much token0  (x0 at usd1/usd0 = 1−T)
 *   threshold0Lower = 100 / (2 + T)   ← too little token0 (x0 at usd1/usd0 = 1+T)
 *   threshold1Lower = 100 − threshold0Upper  (complements, since pct1 = 100−pct0)
 *   threshold1Upper = 100 − threshold0Lower
 *
 * Derivation: the indexer computes priceDifference from reserveRatio = r1/r0
 * (see indexer-envio/src/priceDifference.ts). At critical:
 *   r1/r0 / oracleRef = 1 ± T → usd1/usd0 = 1 ± T   (oracle cancels via the
 *                                                   USD-price ratio)
 *   x0 = 1 / (1 + usd1/usd0) = 1 / (2 ± T)
 *
 * Returns null when:
 * - usdTotal is null (no oracle → using raw count pct, formula doesn't apply)
 * - rebalanceThreshold is missing or zero
 * - T ≥ 1 (threshold ≥ 10000 bps): threshold0Upper = 100/(2−T) hits 100% at
 *   T=1 and blows past the bar above it. T > 1 is also semantically
 *   nonsense — a pool that tolerates >100% price deviation has no
 *   meaningful rebalance line to draw.
 */
interface ThresholdLines {
  threshold0Lower: number;
  threshold0Upper: number;
  threshold1Lower: number;
  threshold1Upper: number;
}

export function computeThresholdLines(
  rebalanceThreshold: number | null | undefined,
  usdTotal: number | null,
): ThresholdLines | null {
  if (usdTotal === null) return null;
  const T =
    rebalanceThreshold != null && rebalanceThreshold > 0
      ? rebalanceThreshold / 10000
      : null;
  if (T === null || T >= 1) return null;

  const threshold0Upper = 100 / (2 - T);
  const threshold0Lower = 100 / (2 + T);
  return {
    threshold0Upper,
    threshold0Lower,
    threshold1Lower: 100 - threshold0Upper,
    threshold1Upper: 100 - threshold0Lower,
  };
}
