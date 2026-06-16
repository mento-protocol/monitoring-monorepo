import { currentDayBucket, dayBucket, isoDate } from "./utils";
import type {
  ActualRevenueAvailability,
  BuildCanonicalRevenueArgs,
  SusdsYieldDailySnapshotRow,
} from "./types";

function hasSusdsReserveYieldSignal(
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
      holding.assetSymbol.toUpperCase() === "SUSDS" && holding.principalUsd > 0,
  );
}

function latestReserveSnapshotBucket(
  reserveDailySnapshots: ReadonlyArray<SusdsYieldDailySnapshotRow>,
): number | null {
  let latest: number | null = null;
  for (const row of reserveDailySnapshots) {
    const timestamp = Number(row.timestamp);
    if (!Number.isFinite(timestamp)) continue;
    const bucket = dayBucket(timestamp);
    if (latest === null || bucket > latest) latest = bucket;
  }
  return latest;
}

function reserveStaleAfterBucket(
  args: BuildCanonicalRevenueArgs,
): number | null {
  if (args.reserveHistoryFailed || args.reserveHistoryUnavailable) return null;
  const latestBucket = latestReserveSnapshotBucket(args.reserveDailySnapshots);
  if (latestBucket === null) return null;
  return latestBucket <
    currentDayBucket(args.nowSeconds ?? Math.floor(Date.now() / 1000))
    ? latestBucket
    : null;
}

export function buildActualAvailability(
  args: BuildCanonicalRevenueArgs,
): ActualRevenueAvailability {
  const reserveHistoryUnavailable =
    args.reserveHistoryFailed === true ||
    args.reserveHistoryUnavailable === true ||
    (args.reserveDailySnapshots.length === 0 &&
      (args.reserveYieldFailed === true ||
        hasSusdsReserveYieldSignal(args.reserveYield)));
  return {
    reserve: !reserveHistoryUnavailable,
    reserveStaleAfter: reserveStaleAfterBucket(args),
    swap: args.swapFeesFailed !== true,
    cdp: args.cdpDailySeriesFailed !== true,
  };
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
  if (args.reserveHistoryFailed) {
    reasons.push("Reserve earned-yield history failed to load.");
  } else if (args.reserveHistoryUnavailable) {
    reasons.push("Reserve earned-yield history is not indexed yet.");
  } else if (
    args.reserveYieldFailed &&
    args.reserveDailySnapshots.length === 0
  ) {
    reasons.push(
      "Reserve earned-yield actuals unavailable: current reserve yield failed to load before any snapshots were indexed.",
    );
  } else if (
    args.reserveDailySnapshots.length === 0 &&
    hasSusdsReserveYieldSignal(args.reserveYield)
  ) {
    reasons.push("Reserve earned-yield history has no sUSDS snapshots yet.");
  } else {
    const staleAfter = reserveStaleAfterBucket(args);
    if (staleAfter !== null) {
      reasons.push(
        `Reserve earned-yield history is stale; latest snapshot is ${isoDate(staleAfter)}.`,
      );
    }
  }
  if (args.reserveHistoryTruncated) {
    reasons.push("Reserve earned-yield history exceeded the pagination cap.");
  }
  return reasons;
}
