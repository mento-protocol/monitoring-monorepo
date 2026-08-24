import {
  FORECASTABLE_SUSDS_SYMBOL,
  type ReserveYieldHolding,
} from "@/lib/reserve-yield-types";

const TRACKED_SUSDS_WALLET_IDENTIFIERS = new Set([
  "0xd0697f70e79476195b742d5afab14be50f98cc1e",
  "0xd3d2e5c5af667da817b2d752d86c8f40c22137e1",
]);

function isSusdsHolding(holding: ReserveYieldHolding): boolean {
  return holding.assetSymbol.toUpperCase() === FORECASTABLE_SUSDS_SYMBOL;
}

export function isIndexedSusdsHolding(holding: ReserveYieldHolding): boolean {
  const identifier = holding.identifier?.toLowerCase() ?? null;
  return (
    isSusdsHolding(holding) &&
    holding.chain.toLowerCase() === "ethereum" &&
    identifier !== null &&
    TRACKED_SUSDS_WALLET_IDENTIFIERS.has(identifier)
  );
}

function hasNonzeroSusdsExposure(holding: ReserveYieldHolding): boolean {
  return (
    (Number.isFinite(holding.balance) && holding.balance !== 0) ||
    (Number.isFinite(holding.principalUsd) && holding.principalUsd !== 0)
  );
}

export function hasUnindexedSusdsHolding(
  holdings: ReadonlyArray<ReserveYieldHolding>,
): boolean {
  return holdings.some(
    (holding) =>
      isSusdsHolding(holding) &&
      !isIndexedSusdsHolding(holding) &&
      hasNonzeroSusdsExposure(holding),
  );
}
