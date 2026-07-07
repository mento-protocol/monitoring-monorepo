import { currentDayBucket, dayBucket, isoDate } from "./utils";
import type {
  ActualRevenueAvailability,
  BuildCanonicalRevenueArgs,
  ReserveYieldDailySnapshotRow,
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

function reserveSnapshotSourceKey(row: ReserveYieldDailySnapshotRow): string {
  const tokenKey = `${row.chainId}:${row.token.toLowerCase()}`;
  return "wallet" in row ? `${tokenKey}:${row.wallet.toLowerCase()}` : tokenKey;
}

function latestReserveSnapshotBucketsBySource(
  reserveDailySnapshots: ReadonlyArray<ReserveYieldDailySnapshotRow>,
): Map<string, number> {
  const latestBySource = new Map<string, number>();
  for (const row of reserveDailySnapshots) {
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
  const latestBySource = latestReserveSnapshotBucketsBySource(
    args.reserveDailySnapshots,
  );
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
        hasReserveYieldSignal(args.reserveYield)));
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
  if (args.reserveYield?.earnedYieldError) {
    return `Reserve earned-yield actuals partial: ${args.reserveYield.earnedYieldError}`;
  }
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
