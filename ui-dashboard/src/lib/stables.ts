// ---------------------------------------------------------------------------
// Display helpers for the /stables page.
//
// The indexer writes brand-named symbols (`USDm`/`EURm`/`GBPm`/...) so the
// UI doesn't normally need to alias. The one exception is the two distinct
// on-chain USDm contracts: Celo cUSD-USDm (`0x765de8…`) and V3 hub USDm
// (`0x106cc…`). Both come over with `tokenSymbol: "USDm"` but different
// `source` enum values. `displayLabel(symbol, source)` adds a `· v3` suffix
// to the hub variant so the legend stays unambiguous.
// ---------------------------------------------------------------------------

import {
  LEGACY_ALIASES_PUBLIC,
  USD_PEGGED_SYMBOLS_PUBLIC,
  oracleRateKey,
  type OracleRateMap,
} from "./tokens";

export type StableSupplySource = "RESERVE" | "V3_HUB_COLLATERAL" | "V3_LIQUITY";

export type StableSupplyChangeKind =
  | "RESERVE_MINT"
  | "RESERVE_BURN"
  | "BRIDGE_MINT"
  | "BRIDGE_BURN"
  | "OTHER_MINT"
  | "OTHER_BURN";

// Internal helper — applies the brand legacy alias table. Today the only
// mapping is cEUR → EURm (Celo cUSD is already brand-named "USDm" in the
// contracts package). Future renames land in `LEGACY_ALIASES_PUBLIC`.
function applyLegacyAlias(indexerSymbol: string): string {
  for (const [from, to] of LEGACY_ALIASES_PUBLIC) {
    if (indexerSymbol === from) return to;
  }
  return indexerSymbol;
}

/**
 * Legend-ready label distinguishing the two USDm contracts. Other tokens
 * pass through (with brand legacy alias applied). The "· v3" suffix is
 * short and avoids confusing "USDm V3" (which would imply a v3-of-the-
 * USDm-contract semantic).
 */
export function displayLabel(
  indexerSymbol: string,
  source: StableSupplySource,
): string {
  const base = applyLegacyAlias(indexerSymbol);
  if (base === "USDm" && source === "V3_HUB_COLLATERAL") return "USDm · v3";
  return base;
}

/**
 * Returns the USD rate for `symbol` from the oracle rate map, defaulting
 * to 1.0 for known USD-pegged stables (`USDm`, cUSD, USDC, ...). This
 * exists because `useOracleRates`/`buildOracleRateMap` derives non-USDm
 * symbols from USDm-paired pools but never emits a rate for USDm itself
 * — so `rates.get("USDm")` returns `undefined` even on healthy data,
 * which would drop USDm from the /stables KPI tiles and stacked chart.
 * The single source of truth for "this symbol is USD-pegged" is
 * `USD_PEGGED_SYMBOLS_PUBLIC` in `tokens.ts`.
 */
export function effectiveOracleRate(
  rates: OracleRateMap,
  symbol: string,
  chainId?: number,
): number | null {
  if (chainId != null) {
    const chainDirect = rates.get(oracleRateKey(chainId, symbol));
    if (chainDirect != null) return chainDirect;
    if (USD_PEGGED_SYMBOLS_PUBLIC.has(symbol)) return 1;
    return null;
  }
  const direct = rates.get(symbol);
  if (direct != null) return direct;
  if (USD_PEGGED_SYMBOLS_PUBLIC.has(symbol)) return 1;
  return null;
}

/** Discriminate a supply-change event into mint vs burn from its `kind`
 *  enum. Authoritative source — the schema's signed `amount` is a
 *  derived field, and a degenerate zero-value burn would render as "0"
 *  (no leading minus), so don't rely on the sign character. */
export function isMintKind(kind: StableSupplyChangeKind): boolean {
  return (
    kind === "RESERVE_MINT" || kind === "BRIDGE_MINT" || kind === "OTHER_MINT"
  );
}

/** Human-readable label for the supply-change source. Used in the
 *  /stables changes table's "Source" column. */
export function kindLabel(kind: StableSupplyChangeKind): string {
  switch (kind) {
    case "RESERVE_MINT":
      return "Reserve mint";
    case "RESERVE_BURN":
      return "Reserve burn";
    case "BRIDGE_MINT":
      return "Bridge mint";
    case "BRIDGE_BURN":
      return "Bridge burn";
    case "OTHER_MINT":
      return "Mint";
    case "OTHER_BURN":
      return "Burn";
  }
}
