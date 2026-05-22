// ---------------------------------------------------------------------------
// V2 stable daily-flush logic.
//
// Mirrors the rolling-flush pattern from src/handlers/liquity/instance.ts —
// on the first event of a new UTC day, write out the previous day's
// `StableSupplyDailySnapshot` row using the accumulated today-buckets, then
// reset the buckets for the new day. Bucket accumulation is the caller's
// responsibility; this helper only handles the rollover.
// ---------------------------------------------------------------------------

import type { StableSupplyDailySnapshot, V2StableTokenSupply } from "envio";
import { dayBucket } from "../../helpers.js";
import { makeStableSupplyDailySnapshotId } from "./config.js";

// Narrow context shape — only declares the writer we need so the helper
// stays testable without depending on Envio's full handlerContext.
type DailyFlushContext = {
  StableSupplyDailySnapshot: {
    set: (entity: StableSupplyDailySnapshot) => void;
  };
};

/**
 * Flush the previous day's daily snapshot if `eventTimestamp` crosses into a
 * new UTC day. Returns the supply entity with day buckets reset; caller must
 * `context.V2StableTokenSupply.set(returned)` to persist.
 *
 * NOTE: the running `totalSupply` field on the entity is NOT mutated here —
 * it's already up-to-date from prior delta application. We only reset the
 * today-buckets (mintedTodayBucket, burnedTodayBucket, currentDayBucket).
 */
export function flushV2StableDailySnapshot(
  context: DailyFlushContext,
  supply: V2StableTokenSupply,
  eventTimestamp: bigint,
  blockNumber: bigint,
): V2StableTokenSupply {
  const eventDay = dayBucket(eventTimestamp);
  if (supply.currentDayBucket >= eventDay) {
    return supply; // same day — no flush
  }

  // Emit a snapshot row for the PREVIOUS day using the accumulated buckets.
  // We never emit a "today" row here — today's row gets written on the
  // first event of TOMORROW (or at the next flush call after today closes).
  // This means the most recent UTC day's row appears with a one-event lag,
  // matching the V3 LiquityInstanceDailySnapshot semantics.
  context.StableSupplyDailySnapshot.set({
    id: makeStableSupplyDailySnapshotId(
      supply.chainId,
      supply.tokenAddress,
      supply.currentDayBucket,
    ),
    chainId: supply.chainId,
    tokenAddress: supply.tokenAddress,
    tokenSymbol: supply.tokenSymbol,
    source: supply.source,
    tokenDecimals: supply.tokenDecimals,
    timestamp: supply.currentDayBucket,
    totalSupply: supply.totalSupply,
    dailyMintAmount: supply.mintedTodayBucket,
    dailyBurnAmount: supply.burnedTodayBucket,
    blockNumber,
    updatedAtTimestamp: eventTimestamp,
  });

  return {
    ...supply,
    currentDayBucket: eventDay,
    mintedTodayBucket: 0n,
    burnedTodayBucket: 0n,
  };
}
