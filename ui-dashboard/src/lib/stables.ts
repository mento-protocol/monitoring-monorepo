// ---------------------------------------------------------------------------
// Display helpers for the /stables page.
//
// The indexer writes brand-named symbols (`USDm`/`EURm`/`GBPm`/...) so the
// UI doesn't normally need to alias. The one exception is the two distinct
// on-chain USDm contracts: V2 cUSD-USDm (`0x765de8…`) and V3 hub USDm
// (`0x106cc…`). Both come over with `tokenSymbol: "USDm"` but different
// `source` enum values. `displayLabel(symbol, source)` adds a `· v3` suffix
// to the hub variant so the legend stays unambiguous.
// ---------------------------------------------------------------------------

import { LEGACY_ALIASES_PUBLIC } from "./tokens";

export type StableSupplySource =
  | "V2_RESERVE"
  | "V3_HUB_COLLATERAL"
  | "V3_LIQUITY";

export type StableSupplyChangeKind =
  | "RESERVE_MINT"
  | "RESERVE_BURN"
  | "BRIDGE_MINT"
  | "BRIDGE_BURN"
  | "OTHER_MINT"
  | "OTHER_BURN";

/**
 * Resolves an indexer-side symbol to the Mento brand display name. Today
 * the only mapping is cEUR → EURm (carried from `LEGACY_ALIASES_PUBLIC` in
 * tokens.ts) — V2 cUSD is already published as "USDm" by the contracts
 * package. Future renames land in `LEGACY_ALIASES_PUBLIC`, not here.
 */
export function displaySymbol(indexerSymbol: string): string {
  for (const [from, to] of LEGACY_ALIASES_PUBLIC) {
    if (indexerSymbol === from) return to;
  }
  return indexerSymbol;
}

/**
 * Legend-ready label distinguishing the two USDm contracts. Other tokens
 * pass through unchanged. The "· v3" suffix is short and avoids confusing
 * "USDm V3" (which would imply a v3-of-the-USDm-contract semantic).
 */
export function displayLabel(
  indexerSymbol: string,
  source: StableSupplySource,
): string {
  const base = displaySymbol(indexerSymbol);
  if (base === "USDm" && source === "V3_HUB_COLLATERAL") return "USDm · v3";
  return base;
}

/** Coarse "is this a mint" predicate from the kind enum. */
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
