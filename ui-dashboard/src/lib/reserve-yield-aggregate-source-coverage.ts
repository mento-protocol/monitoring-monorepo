import { numericField } from "@/lib/reserve-yield-shared";
import { isIndexedStethHolding } from "@/lib/reserve-yield-steth-coverage";
import { isIndexedSusdsHolding } from "@/lib/reserve-yield-susds-coverage";
import type { ReserveYieldHolding } from "@/lib/reserve-yield-types";

export type SourceHoldingResult = {
  source: Record<string, unknown>;
  holding: ReserveYieldHolding | null;
};

export function recordProvesZeroExposure(
  record: Record<string, unknown>,
): boolean {
  let hasExposureValue = false;
  for (const field of ["balance", "usd_value"] as const) {
    const rawValue = record[field];
    if (rawValue === undefined || rawValue === null) continue;
    hasExposureValue = true;
    if (numericField(rawValue) !== 0) return false;
  }
  return hasExposureValue;
}

// Each normalized source can add conversion and summation roundoff. Scale the
// tolerance with the source count so only floating-point noise is accepted.
const SOURCE_COVERAGE_ULPS_PER_SOURCE = 16;

function aggregateDiffersFromSourceTotal(
  rawAggregateValue: unknown,
  sourceTotal: number,
  sourceCount: number,
): boolean {
  if (
    rawAggregateValue === undefined ||
    rawAggregateValue === null ||
    rawAggregateValue === ""
  ) {
    return false;
  }
  const aggregateValue = numericField(rawAggregateValue);
  if (aggregateValue === null || aggregateValue < 0) return true;
  if (!Number.isFinite(sourceTotal) || sourceTotal < 0) return true;
  const tolerance =
    Math.max(Math.abs(aggregateValue), Math.abs(sourceTotal), 1) *
    Number.EPSILON *
    Math.max(sourceCount, 1) *
    SOURCE_COVERAGE_ULPS_PER_SOURCE;
  return Math.abs(aggregateValue - sourceTotal) > tolerance;
}

function hasAggregateSourceCoverageGap(
  asset: Record<string, unknown>,
  results: SourceHoldingResult[],
): boolean {
  let sourceBalanceTotal = 0;
  let sourcePrincipalUsdTotal = 0;
  for (const { holding } of results) {
    if (holding === null) continue;
    if (
      (holding.hasTokenBalance && holding.balance < 0) ||
      holding.principalUsd < 0
    ) {
      return true;
    }
    if (holding.hasTokenBalance) sourceBalanceTotal += holding.balance;
    sourcePrincipalUsdTotal += holding.principalUsd;
  }
  return (
    aggregateDiffersFromSourceTotal(
      asset.balance,
      sourceBalanceTotal,
      results.length,
    ) ||
    aggregateDiffersFromSourceTotal(
      asset.usd_value,
      sourcePrincipalUsdTotal,
      results.length,
    )
  );
}

function holdingHasNonzeroExposure(holding: ReserveYieldHolding): boolean {
  return (
    (Number.isFinite(holding.balance) && holding.balance !== 0) ||
    (Number.isFinite(holding.principalUsd) && holding.principalUsd !== 0)
  );
}

export function hasIncompleteSusdsSourceCoverage({
  asset,
  rawSourceCount,
  results,
}: {
  asset: Record<string, unknown>;
  rawSourceCount: number;
  results: SourceHoldingResult[];
}): boolean {
  if (rawSourceCount !== results.length) return true;
  if (
    results.some(
      ({ source, holding }) =>
        !recordProvesZeroExposure(source) &&
        (holding === null || !isIndexedSusdsHolding(holding)),
    )
  ) {
    return true;
  }
  if (hasAggregateSourceCoverageGap(asset, results)) return true;
  return (
    !recordProvesZeroExposure(asset) &&
    !results.some(
      ({ holding }) => holding !== null && holdingHasNonzeroExposure(holding),
    )
  );
}

export function hasIncompleteStethSourceCoverage({
  asset,
  rawSourceCount,
  results,
}: {
  asset: Record<string, unknown>;
  rawSourceCount: number;
  results: SourceHoldingResult[];
}): boolean {
  if (rawSourceCount !== results.length) return true;
  if (
    results.some(
      ({ source, holding }) =>
        !recordProvesZeroExposure(source) &&
        (holding === null || !isIndexedStethHolding(holding)),
    )
  ) {
    return true;
  }
  if (hasAggregateSourceCoverageGap(asset, results)) return true;
  return (
    !recordProvesZeroExposure(asset) &&
    !results.some(
      ({ holding }) => holding !== null && holdingHasNonzeroExposure(holding),
    )
  );
}
