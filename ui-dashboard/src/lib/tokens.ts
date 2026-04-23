import type { Pool } from "./types";
import type { Network } from "./networks";
import { truncateAddress, parseWei } from "./format";

// Network-aware helpers

/** All entries here must also appear in USD_PEGGED_SYMBOLS below. */
export const USDM_SYMBOLS = new Set(["USDm"]);

/** Tokens treated as $1.00 for USD conversion. */
const USD_PEGGED_SYMBOLS = new Set([
  "cUSD",
  "USDC",
  "axlUSDC",
  "USDT",
  "USD\u20AE",
  "USDm",
  "AUSD",
]);

/** Maps token symbol → USD-per-1-token rate, derived from pool oracle prices. */
export type OracleRateMap = Map<string, number>;

/** Minimum `Pool` shape `buildOracleRateMap` needs. Exported so callers that
 *  fetch a slim per-chain query (e.g. ORACLE_RATES) can type their result
 *  without redeclaring the Pick locally. */
export type OracleRatePool = Pick<
  Pool,
  "token0" | "token1" | "oraclePrice" | "oracleOk"
>;

/** Legacy symbol aliases (v2 → v3 rebrand). Historical indexed fee transfers
 * may still carry old symbols like "cEUR" instead of "EURm". */
const LEGACY_ALIASES: ReadonlyArray<[string, string]> = [["cEUR", "EURm"]];

/**
 * Builds a symbol→USD rate map from pools that have a USDm leg.
 * For each pool with one USDm token and a valid oraclePrice,
 * extracts the USD rate for the non-USDm token.
 */
export function buildOracleRateMap(
  pools: ReadonlyArray<OracleRatePool>,
  network: Network,
): OracleRateMap {
  const rates: OracleRateMap = new Map();
  for (const pool of pools) {
    if (!pool.oraclePrice || pool.oraclePrice === "0") continue;
    if (pool.oracleOk === false) continue;
    const sym0 = tokenSymbol(network, pool.token0 ?? null);
    const sym1 = tokenSymbol(network, pool.token1 ?? null);
    const feedVal = Number(pool.oraclePrice) / 1e24;
    if (!isFinite(feedVal) || feedVal <= 0) continue;

    if (USDM_SYMBOLS.has(sym0) && !USDM_SYMBOLS.has(sym1)) {
      rates.set(sym1, feedVal);
    } else if (USDM_SYMBOLS.has(sym1) && !USDM_SYMBOLS.has(sym0)) {
      rates.set(sym0, feedVal);
    }
  }
  for (const [legacy, current] of LEGACY_ALIASES) {
    const rate = rates.get(current);
    if (rate !== undefined && !rates.has(legacy)) {
      rates.set(legacy, rate);
    }
  }

  return rates;
}

/** Convert a token amount to USD using live oracle rates. Returns null for unknown tokens. */
export function tokenToUSD(
  symbol: string,
  amount: number,
  rates: OracleRateMap,
): number | null {
  if (USD_PEGGED_SYMBOLS.has(symbol)) return amount;
  const rate = rates.get(symbol);
  if (rate !== undefined) return amount * rate;
  return null;
}

export function tokenSymbol(network: Network, address: string | null): string {
  if (!address) return "?";
  const lower = address.toLowerCase();
  const primary = network.tokenSymbols[lower];
  if (primary) return primary;
  // addressLabels fallback deliberately sanitizes StableToken* — those are
  // implementation-contract names (e.g. StableTokenSpoke, StableTokenV3v301)
  // kept raw in addressLabels for the Address Book's precision needs, but
  // they must never surface as a pool-token symbol.
  const label = network.addressLabels[lower];
  if (label && !label.startsWith("StableToken")) return label;
  return truncateAddress(address);
}

export function explorerAddressUrl(network: Network, address: string): string {
  return `${network.explorerBaseUrl}/address/${address}`;
}

export function explorerTxUrl(network: Network, txHash: string): string {
  return `${network.explorerBaseUrl}/tx/${txHash}`;
}

/** Pool display name like "KESm/USDm" with USDm always last. */
export function poolName(
  network: Network,
  token0: string | null,
  token1: string | null,
): string {
  const sym0 = tokenSymbol(network, token0);
  const sym1 = tokenSymbol(network, token1);

  if (USDM_SYMBOLS.has(sym0) && !USDM_SYMBOLS.has(sym1)) {
    return `${sym1}/${sym0}`;
  }
  return `${sym0}/${sym1}`;
}

/** Returns true if the pool is an FPMM (as opposed to a VirtualPool). */
export function isFpmm(pool: Pick<Pool, "source">): boolean {
  return pool.source.toLowerCase().includes("fpmm");
}

/**
 * True when at least one leg is a non-USD-pegged token, i.e. the pair has
 * FX exposure (EUR, GBP, BRL, …). Covers USDm/FX pairs, FX/FX pairs
 * (e.g. `axlEUROC/EURm`), and stable/FX pairs (e.g. `USDC/GBPm`) — all of
 * which pause oracle updates over TradFi weekends.
 */
export function isFxPool(
  network: Network,
  token0: string | null,
  token1: string | null,
): boolean {
  const sym0 = tokenSymbol(network, token0);
  const sym1 = tokenSymbol(network, token1);
  return !USD_PEGGED_SYMBOLS.has(sym0) || !USD_PEGGED_SYMBOLS.has(sym1);
}

/**
 * Returns the Chainlink data feed URL + display pair for a given token
 * symbol and chainId, or null if no mapping exists. Only applicable to
 * FPMM pools. Add new chains / symbols to CHAINLINK_FEEDS as they go live.
 *
 * `pair` is derived from the slug: `"gbp-usd"` → `"GBP/USD"`, suitable
 * for "via {pair} oracle" labels in the UI.
 */
export function chainlinkFeed(
  tokenSymbol: string,
  chainId: number,
): { url: string; pair: string } | null {
  const chainConfig = CHAINLINK_FEEDS[chainId];
  if (!chainConfig) return null;
  // Normalise: strip "axl" prefix and lowercase for matching
  const sym = tokenSymbol.replace(/^axl/i, "").toLowerCase();
  const slug = chainConfig.slugs[sym];
  if (!slug) return null;
  const pair = slug
    .split("-")
    .map((s) => s.toUpperCase())
    .join("/");
  return { url: `${chainConfig.baseUrl}/${slug}`, pair };
}

/**
 * True when the pool's legs are USD-convertible: one leg is USDm or the rate
 * map can price one of the non-USDm legs. Intentionally does NOT require
 * `oraclePrice` — volume conversion uses per-snapshot `swapVolumeX` values
 * and does not depend on the live oracle. TVL callers that *do* need the
 * oracle should gate on `pool.oraclePrice` themselves.
 */
export function canPricePool(
  pool: Pick<Pool, "token0" | "token1">,
  network: Network,
  rates: OracleRateMap,
): boolean {
  const sym0 = tokenSymbol(network, pool.token0 ?? null);
  const sym1 = tokenSymbol(network, pool.token1 ?? null);
  if (USDM_SYMBOLS.has(sym0) || USDM_SYMBOLS.has(sym1)) return true;
  return (
    tokenToUSD(sym0, 1, rates) !== null || tokenToUSD(sym1, 1, rates) !== null
  );
}

/**
 * True when the pool's current TVL can be computed in USD: USD-convertible
 * legs *plus* a usable `oraclePrice` (required for the `reserves × price`
 * math). Without the oracle gate, `poolTvlUSD()` silently returns 0 during
 * oracle outages and the card renders a believable $0.00.
 */
export function canValueTvl(
  pool: Pick<Pool, "token0" | "token1" | "oraclePrice">,
  network: Network,
  rates: OracleRateMap,
): boolean {
  if (!pool.oraclePrice || pool.oraclePrice === "0") return false;
  return canPricePool(pool, network, rates);
}

/**
 * Computes the TVL of a pool in USD using the oracle price and token reserves.
 * Returns 0 if oracle price or reserves are missing.
 */
export function poolTvlUSD(
  pool: {
    reserves0?: string;
    reserves1?: string;
    token0Decimals?: number;
    token1Decimals?: number;
    oraclePrice?: string;
    token0?: string | null;
    token1?: string | null;
  },
  network: Network,
  rates?: OracleRateMap,
): number {
  if (!pool.oraclePrice || pool.oraclePrice === "0") return 0;
  if (!pool.reserves0 && !pool.reserves1) return 0;
  const r0 = parseWei(pool.reserves0 ?? "0", pool.token0Decimals ?? 18);
  const r1 = parseWei(pool.reserves1 ?? "0", pool.token1Decimals ?? 18);
  const feedVal = Number(pool.oraclePrice) / 1e24;
  const sym0 = tokenSymbol(network, pool.token0 ?? null);
  const sym1 = tokenSymbol(network, pool.token1 ?? null);
  if (USDM_SYMBOLS.has(sym0)) {
    return r0 + r1 * feedVal;
  }
  if (USDM_SYMBOLS.has(sym1)) {
    return r0 * feedVal + r1;
  }
  // Neither leg is USDm — try to convert via oracle rate map.
  if (rates) {
    const usd0 = tokenToUSD(sym0, 1, rates);
    if (usd0 !== null) {
      return (r0 + r1 * feedVal) * usd0;
    }
    const usd1 = tokenToUSD(sym1, 1, rates);
    if (usd1 !== null) {
      return (r0 * feedVal + r1) * usd1;
    }
  }
  return 0;
}

/** Per-chain Chainlink feed configuration. Add new entries as new chains go live. */
const CHAINLINK_FEEDS: Record<
  number,
  { baseUrl: string; slugs: Record<string, string> }
> = {
  42220: {
    // Celo Mainnet
    baseUrl: "https://data.chain.link/feeds/celo/mainnet",
    slugs: {
      usdc: "usdc-usd",
      usdt: "usdt-usd",
      gbp: "gbp-usd",
      gbpm: "gbp-usd",
      eur: "eur-usd",
      eurm: "eur-usd",
      euroc: "eur-usd",
    },
  },
  143: {
    // Monad Mainnet
    baseUrl: "https://data.chain.link/feeds/monad/monad",
    slugs: {
      usdc: "usdc-usd",
      usdt: "usdt-usd",
      ausd: "ausd-usd",
      gbp: "gbp-usd",
      gbpm: "gbp-usd",
      eur: "eur-usd",
      eurm: "eur-usd",
    },
  },
  // 10143: { baseUrl: "...", slugs: { ... } }, // Monad Testnet — add when live
};
