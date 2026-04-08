import type { Pool } from "./types";
import type { Network } from "./networks";
import { truncateAddress, parseWei } from "./format";

// ---------------------------------------------------------------------------
// Network-aware helpers
// ---------------------------------------------------------------------------

export const USDM_SYMBOLS = new Set(["USDm"]);

/** Tokens treated as $1.00 for USD conversion. */
export const USD_PEGGED_SYMBOLS = new Set([
  "cUSD",
  "USDC",
  "axlUSDC",
  "USDT",
  "USD\u20AE",
  "USDm",
  "AUSD",
]);

/**
 * FX rates for non-USD stablecoins (USD per 1 token).
 * Approximate spot rates — acceptable for a monitoring dashboard.
 */
export const FX_RATES: Record<string, number> = {
  cEUR: 1.1455,
  EURm: 1.1455,
  GBPm: 1.3263,
  AUDm: 0.6993,
  CADm: 0.7299,
  CHFm: 1.2674,
  KESm: 0.0077,
  BRLm: 0.1905,
  COPm: 0.00027,
  GHSm: 0.0924,
  JPYm: 0.00627,
  NGNm: 0.00073,
  PHPm: 0.01675,
  XOFm: 0.00175,
  ZARm: 0.0593,
  axlEUROC: 1.1455,
};

/** Convert a token amount to USD. Returns null for unknown tokens. */
export function tokenToUSD(symbol: string, amount: number): number | null {
  if (USD_PEGGED_SYMBOLS.has(symbol)) return amount;
  const rate = FX_RATES[symbol];
  if (rate !== undefined) return amount * rate;
  return null;
}

export function tokenSymbol(network: Network, address: string | null): string {
  if (!address) return "?";
  const lower = address.toLowerCase();
  return (
    network.tokenSymbols[lower] ??
    network.addressLabels[lower] ??
    truncateAddress(address)
  );
}

export function addressLabel(network: Network, address: string | null): string {
  if (!address) return "\u2014";
  return (
    network.addressLabels[address.toLowerCase()] ?? truncateAddress(address)
  );
}

export function hasLabel(network: Network, address: string | null): boolean {
  if (!address) return false;
  return address.toLowerCase() in network.addressLabels;
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

/** Lookup from pool ID -> display name for a list of pools. */
export function buildPoolNameMap(
  network: Network,
  pools: Pool[],
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const p of pools) {
    map[p.id] = poolName(network, p.token0, p.token1);
  }
  return map;
}

/**
 * Returns the Chainlink data feed URL for a given token symbol and chainId,
 * or null if no mapping exists for that chain. Only applicable to FPMM pools.
 * Add new chains to CHAINLINK_FEEDS as they go live.
 */
export function chainlinkFeedUrl(
  tokenSymbol: string,
  chainId: number,
): string | null {
  const chainConfig = CHAINLINK_FEEDS[chainId];
  if (!chainConfig) return null;
  // Normalise: strip "axl" prefix and lowercase for matching
  const sym = tokenSymbol.replace(/^axl/i, "").toLowerCase();
  const slug = chainConfig.slugs[sym];
  if (!slug) return null;
  return `${chainConfig.baseUrl}/${slug}`;
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
    },
  },
  // 10143: { baseUrl: "...", slugs: { ... } }, // Monad — add when live
};
