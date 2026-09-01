import {
  FORECASTABLE_STETH_SYMBOL,
  TRACKED_STETH_WALLET_IDENTIFIERS,
  type ReserveYieldHolding,
} from "@/lib/reserve-yield-types";

const TRACKED_STETH_WALLET_IDENTIFIER_SET = new Set<string>(
  TRACKED_STETH_WALLET_IDENTIFIERS,
);

export function isTrackedStethWalletIdentifier(identifier: string): boolean {
  return TRACKED_STETH_WALLET_IDENTIFIER_SET.has(
    identifier.trim().toLowerCase(),
  );
}

export function isIndexedStethHolding(holding: ReserveYieldHolding): boolean {
  return (
    holding.assetSymbol.toUpperCase() === FORECASTABLE_STETH_SYMBOL &&
    holding.chain.trim().toLowerCase() === "ethereum" &&
    holding.identifier !== null &&
    isTrackedStethWalletIdentifier(holding.identifier)
  );
}
