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

// Internal helper — applies the v2→v3 legacy alias table. Today the only
// mapping is cEUR → EURm (V2 cUSD is already brand-named "USDm" in the
// contracts package). Future renames land in `LEGACY_ALIASES_PUBLIC`.
function applyLegacyAlias(indexerSymbol: string): string {
  for (const [from, to] of LEGACY_ALIASES_PUBLIC) {
    if (indexerSymbol === from) return to;
  }
  return indexerSymbol;
}

/**
 * Legend-ready label distinguishing the two USDm contracts. Other tokens
 * pass through (with v2→v3 legacy alias applied). The "· v3" suffix is
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
