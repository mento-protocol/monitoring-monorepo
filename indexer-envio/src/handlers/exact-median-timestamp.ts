import type { Logger } from "envio";

type SortedOraclesMedianEvent = "OracleReported" | "MedianUpdated";

/**
 * Historical oracle events cannot be reconstructed from a later state-sync.
 * Reject a tracked event when its exact-block median timestamp read failed so
 * Envio retries the event instead of committing incomplete snapshots and
 * health counters.
 */
export function requireExactMedianTimestamp({
  timestamp,
  eventName,
  chainId,
  rateFeedID,
  blockNumber,
  log,
}: {
  timestamp: bigint | null;
  eventName: SortedOraclesMedianEvent;
  chainId: number;
  rateFeedID: string;
  blockNumber: bigint;
  log: Logger;
}): bigint {
  if (timestamp !== null) return timestamp;

  const message =
    `sortedOracles.exactMedianTimestampUnavailable event=${eventName} ` +
    `chainId=${chainId} feed=${rateFeedID} block=${blockNumber}`;
  log.error(message);
  throw new Error(message);
}
