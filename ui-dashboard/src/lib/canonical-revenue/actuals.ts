import { currentDayBucket, dayBucket, isoDate } from "./utils";
import { isValidSusdsYieldDailySnapshotRow } from "./reserve-snapshot-validation";
import { isValidStethYieldDailySnapshotRow } from "./steth-snapshot-validation";
import { hasUnindexedSusdsHolding } from "@/lib/reserve-yield-susds-coverage";
import { isIndexedStethHolding } from "@/lib/reserve-yield-steth-coverage";
import {
  FORECASTABLE_STETH_SYMBOL,
  RESERVE_YIELD_ETHEREUM_CHAIN_ID,
} from "@/lib/reserve-yield-types";
import type {
  ActualRevenueAvailability,
  BuildCanonicalRevenueArgs,
  ReserveYieldDailySnapshotRow,
  StethYieldDailySnapshotRow,
} from "./types";

function hasReserveYieldSignal(
  reserveYield: BuildCanonicalRevenueArgs["reserveYield"],
): boolean {
  if (reserveYield === null) return false;
  const earnedYieldUsd =
    typeof reserveYield.earnedYieldUsd === "number" &&
    Number.isFinite(reserveYield.earnedYieldUsd)
      ? reserveYield.earnedYieldUsd
      : null;
  if (earnedYieldUsd !== null && earnedYieldUsd > 0) return true;
  return reserveYield.holdings.some(
    (holding) =>
      ["SUSDS", "STETH"].includes(holding.assetSymbol.toUpperCase()) &&
      holding.principalUsd > 0,
  );
}

function hasSusdsSnapshotSource(
  reserveDailySnapshots: ReadonlyArray<ReserveYieldDailySnapshotRow>,
): boolean {
  return reserveDailySnapshots.some(
    (row) =>
      !("wallet" in row) &&
      isValidSusdsYieldDailySnapshotRow(row) &&
      row.chainId === RESERVE_YIELD_ETHEREUM_CHAIN_ID,
  );
}

function hasStethSnapshotSource(args: BuildCanonicalRevenueArgs): boolean {
  if (args.hasStethSnapshotSource === false) return false;
  const validRows = args.reserveDailySnapshots.filter(
    (row): row is StethYieldDailySnapshotRow =>
      "wallet" in row &&
      isValidStethYieldDailySnapshotRow(row) &&
      row.chainId === RESERVE_YIELD_ETHEREUM_CHAIN_ID,
  );
  if (validRows.length === 0) return false;
  const reserveYield = args.reserveYield;
  if (reserveYield === null) return true;
  const currentHoldings = reserveYield.holdings.filter(
    (holding) =>
      holding.assetSymbol.toUpperCase() === FORECASTABLE_STETH_SYMBOL &&
      holdingHasExposure(holding),
  );
  if (currentHoldings.length === 0) {
    return reserveYield.stethSnapshotSourceRequired !== true;
  }
  const snapshotWallets = new Set(
    validRows.map((row) => row.wallet.trim().toLowerCase()),
  );
  return currentHoldings.every(
    (holding) =>
      isIndexedStethHolding(holding) &&
      holding.identifier !== null &&
      snapshotWallets.has(holding.identifier.trim().toLowerCase()),
  );
}

function holdingHasExposure(
  holding: NonNullable<
    BuildCanonicalRevenueArgs["reserveYield"]
  >["holdings"][number],
): boolean {
  return (
    holding.principalUsd !== 0 ||
    holding.balance !== 0 ||
    (holding.earnedYieldUsd !== null &&
      Number.isFinite(holding.earnedYieldUsd) &&
      holding.earnedYieldUsd !== 0)
  );
}

function hasCurrentStethExposure(
  reserveYield: BuildCanonicalRevenueArgs["reserveYield"],
): boolean {
  if (reserveYield === null) return false;
  if (reserveYield.stethSnapshotSourceRequired === true) return true;
  return reserveYield.holdings.some(
    (holding) =>
      holding.assetSymbol.toUpperCase() === FORECASTABLE_STETH_SYMBOL &&
      holdingHasExposure(holding),
  );
}

function currentHoldingsClassificationFailed(
  args: BuildCanonicalRevenueArgs,
): boolean {
  return (
    args.reserveCurrentHoldingsClassificationFailed === true ||
    args.reserveYield?.reserveCurrentHoldingsClassificationFailed === true
  );
}

function incompleteStethSnapshotCoverage(
  args: BuildCanonicalRevenueArgs,
): boolean {
  return args.reserveYield?.hasIncompleteStethSourceCoverage === true;
}

function unavailableStethSnapshotSource(
  args: BuildCanonicalRevenueArgs,
): boolean {
  // Historical stETH yield can outlive current wallet exposure. A failed
  // history query cannot distinguish an exited wallet from a never-held wallet.
  if (args.stethHistoryFailed === true) return true;
  if (currentHoldingsClassificationFailed(args)) return true;
  if (incompleteStethSnapshotCoverage(args)) return true;
  const sourceRequired = hasCurrentStethExposure(args.reserveYield);
  return sourceRequired && !hasStethSnapshotSource(args);
}

function incompleteSusdsSnapshotCoverage(
  args: BuildCanonicalRevenueArgs,
): boolean {
  if (args.hasUnindexedSusdsHolding === true) return true;
  if (args.reserveYield === null) return false;
  if (args.reserveYield.hasUnindexedSusdsHolding === true) return true;
  if (args.reserveYield.hasUnindexedSusdsHolding === false) return false;
  return hasUnindexedSusdsHolding(args.reserveYield.holdings);
}

function hasSusdsActualSignal(
  reserveYield: BuildCanonicalRevenueArgs["reserveYield"],
): boolean {
  if (reserveYield === null) return false;
  if (reserveYield.susdsSnapshotSourceRequired === true) return true;
  const earnedYieldSignal =
    typeof reserveYield.susdsEarnedYieldUsd === "number" &&
    Number.isFinite(reserveYield.susdsEarnedYieldUsd) &&
    reserveYield.susdsEarnedYieldUsd !== 0;
  const currentSusdsHolding = reserveYield.holdings.some(
    (holding) =>
      holding.assetSymbol.toUpperCase() === "SUSDS" &&
      ((Number.isFinite(holding.principalUsd) && holding.principalUsd > 0) ||
        (Number.isFinite(holding.balance) && holding.balance > 0) ||
        (holding.earnedYieldUsd !== null &&
          Number.isFinite(holding.earnedYieldUsd) &&
          holding.earnedYieldUsd !== 0)),
  );
  return currentSusdsHolding || earnedYieldSignal;
}

function hasInactiveSusdsSource(args: BuildCanonicalRevenueArgs): boolean {
  const reserveYield = args.reserveYield;
  return (
    reserveYield !== null &&
    args.reserveCurrentHoldingsClassificationFailed !== true &&
    reserveYield.reserveCurrentHoldingsClassificationFailed === false &&
    args.hasUnindexedSusdsHolding !== true &&
    reserveYield.hasUnindexedSusdsHolding === false &&
    reserveYield.susdsYieldSignalUnavailable === false &&
    reserveYield.susdsSnapshotSourceRequired === false &&
    (reserveYield.susdsEarnedYieldUsd === null ||
      reserveYield.susdsEarnedYieldUsd === 0) &&
    !hasSusdsActualSignal(reserveYield)
  );
}

function knownMissingSusdsSnapshotSource(
  args: BuildCanonicalRevenueArgs,
): boolean {
  return (
    hasSusdsActualSignal(args.reserveYield) &&
    !hasSusdsSnapshotSource(args.reserveDailySnapshots)
  );
}

function unverifiableSusdsSnapshotSource(
  args: BuildCanonicalRevenueArgs,
): boolean {
  return (
    args.reserveCurrentHoldingsClassificationFailed === true &&
    !hasSusdsSnapshotSource(args.reserveDailySnapshots)
  );
}

function unavailableSusdsSignalSource(
  args: BuildCanonicalRevenueArgs,
): boolean {
  return (
    args.reserveYield !== null &&
    args.reserveYield.susdsYieldSignalUnavailable !== false &&
    !hasSusdsSnapshotSource(args.reserveDailySnapshots)
  );
}

function reserveSnapshotSourceKey(row: ReserveYieldDailySnapshotRow): string {
  const tokenKey = `${row.chainId}:${row.token.toLowerCase()}`;
  return "wallet" in row ? `${tokenKey}:${row.wallet.toLowerCase()}` : tokenKey;
}

function latestReserveSnapshotBucketsBySource(
  args: BuildCanonicalRevenueArgs,
): Map<string, number> {
  const latestBySource = new Map<string, number>();
  const ignoreInactiveSusdsSource = hasInactiveSusdsSource(args);
  for (const row of args.reserveDailySnapshots) {
    if (ignoreInactiveSusdsSource && !("wallet" in row)) continue;
    const timestamp = Number(row.timestamp);
    if (!Number.isFinite(timestamp)) continue;
    const bucket = dayBucket(timestamp);
    const sourceKey = reserveSnapshotSourceKey(row);
    const latest = latestBySource.get(sourceKey);
    if (latest === undefined || bucket > latest) {
      latestBySource.set(sourceKey, bucket);
    }
  }
  return latestBySource;
}

function reserveStaleAfterBucket(
  args: BuildCanonicalRevenueArgs,
): number | null {
  if (args.reserveHistoryFailed || args.reserveHistoryUnavailable) return null;
  const latestBySource = latestReserveSnapshotBucketsBySource(args);
  if (latestBySource.size === 0) return null;
  const today = currentDayBucket(
    args.nowSeconds ?? Math.floor(Date.now() / 1000),
  );
  let staleAfter: number | null = null;
  for (const latestBucket of latestBySource.values()) {
    if (latestBucket >= today) continue;
    staleAfter =
      staleAfter === null ? latestBucket : Math.min(staleAfter, latestBucket);
  }
  return staleAfter;
}

export function buildActualAvailability(
  args: BuildCanonicalRevenueArgs,
): ActualRevenueAvailability {
  const reserveHistoryUnavailable =
    args.reserveHistoryFailed === true ||
    args.reserveHistoryUnavailable === true ||
    args.reserveHistoryUnpriced === true ||
    (args.reserveDailySnapshots.length === 0 &&
      (args.reserveYieldFailed === true ||
        hasReserveYieldSignal(args.reserveYield))) ||
    knownMissingSusdsSnapshotSource(args) ||
    incompleteSusdsSnapshotCoverage(args) ||
    unverifiableSusdsSnapshotSource(args) ||
    unavailableSusdsSignalSource(args) ||
    unavailableStethSnapshotSource(args);
  return {
    reserve: !reserveHistoryUnavailable,
    reserveStaleAfter: reserveStaleAfterBucket(args),
    swap: args.swapFeesFailed !== true,
    cdp: args.cdpDailySeriesFailed !== true,
  };
}

function reservePartialReason(args: BuildCanonicalRevenueArgs): string | null {
  if (args.reserveHistoryFailed) {
    return "Reserve earned-yield history failed to load.";
  }
  const sourceReason = immediateSnapshotSourceReason(args);
  if (sourceReason !== null) return sourceReason;
  if (args.reserveYield?.earnedYieldError) {
    return `Reserve earned-yield actuals partial: ${args.reserveYield.earnedYieldError}`;
  }
  const missingStethReason = missingStethSnapshotSourceReason(args);
  if (missingStethReason !== null) return missingStethReason;
  if (args.reserveHistoryUnavailable) {
    return "Reserve earned-yield history is not indexed yet.";
  }
  if (args.reserveHistoryUnpriced) {
    return "Reserve stETH earned-yield history is unavailable: current stETH USD/token pricing is missing.";
  }
  if (args.reserveDailySnapshots.length > 0) {
    const staleAfter = reserveStaleAfterBucket(args);
    return staleAfter === null
      ? null
      : `Reserve earned-yield history is stale; latest snapshot is ${isoDate(staleAfter)}.`;
  }
  if (args.reserveYieldFailed) {
    return "Reserve earned-yield actuals unavailable: current reserve yield failed to load before any snapshots were indexed.";
  }
  return hasReserveYieldSignal(args.reserveYield)
    ? "Reserve earned-yield history has no snapshots yet."
    : null;
}

function immediateSnapshotSourceReason(
  args: BuildCanonicalRevenueArgs,
): string | null {
  if (unavailableStethSnapshotSource(args) && args.stethHistoryFailed) {
    return "Reserve stETH earned-yield actuals unavailable: StethYieldDailySnapshot history failed to load.";
  }
  if (incompleteSusdsSnapshotCoverage(args)) {
    return "Reserve sUSDS earned-yield actuals unavailable: indexed snapshots do not cover all current sUSDS sources.";
  }
  if (unverifiableSusdsSnapshotSource(args)) {
    return "Reserve sUSDS earned-yield actuals unavailable: current reserve holdings classification failed and no SusdsYieldDailySnapshot source exists.";
  }
  if (unavailableSusdsSignalSource(args)) {
    return "Reserve sUSDS earned-yield actuals unavailable: the current sUSDS yield signal is unavailable and no SusdsYieldDailySnapshot source exists.";
  }
  if (knownMissingSusdsSnapshotSource(args)) {
    return "Reserve sUSDS earned-yield actuals unavailable: no SusdsYieldDailySnapshot source exists for current sUSDS holdings or earned signal.";
  }
  if (
    unavailableStethSnapshotSource(args) &&
    currentHoldingsClassificationFailed(args)
  ) {
    return "Reserve stETH earned-yield actuals unavailable: current reserve holdings classification failed, so current stETH wallet snapshot coverage cannot be verified.";
  }
  if (incompleteStethSnapshotCoverage(args)) {
    return "Reserve stETH earned-yield actuals unavailable: indexed snapshots do not cover all current stETH sources.";
  }
  return null;
}

function missingStethSnapshotSourceReason(
  args: BuildCanonicalRevenueArgs,
): string | null {
  if (!unavailableStethSnapshotSource(args)) return null;
  return "Reserve stETH earned-yield actuals unavailable: no StethYieldDailySnapshot source exists for current stETH holdings.";
}

export function buildPartialReasons(args: BuildCanonicalRevenueArgs): string[] {
  const reasons: string[] = [];
  if (args.swapFeesFailed) reasons.push("Swap fee history failed to load.");
  if (!args.swapFeesFailed && args.swapFeesApproximate) {
    reasons.push("Swap fee history is approximate.");
  }
  if (args.cdpDailySeriesFailed) {
    reasons.push("CDP borrowing revenue history failed to load.");
  }
  if (!args.cdpDailySeriesFailed && args.cdpInputsApproximate) {
    reasons.push("CDP borrowing history is approximate.");
  }
  const reserveReason = reservePartialReason(args);
  if (reserveReason !== null) reasons.push(reserveReason);
  if (args.reserveHistoryTruncated) {
    reasons.push("Reserve earned-yield history exceeded the pagination cap.");
  }
  return reasons;
}
