import type { QuickNodeWebhookPayload } from "./types";

export interface EventContext {
  txHashMap: Map<string, string>;
  hasSafeMultiSigTx: Set<string>;
}

/**
 * Build context from webhook events
 * - txHashMap: Maps transactionHash -> Safe txHash from ExecutionSuccess events
 * - hasSafeMultiSigTx: Tracks which transactions have SafeMultiSigTransaction events
 *
 * @param logs - Array of decoded log entries from QuickNode webhook
 * @returns Event context needed for processing
 */
export function buildEventContext(
  logs: QuickNodeWebhookPayload["result"],
): EventContext {
  const txHashMap = new Map<string, string>();
  const hasSafeMultiSigTx = new Set<string>();

  for (const log of logs) {
    // Payload-level validation only guarantees `result` is an array, so each
    // log could be null, a primitive, or missing transactionHash entirely.
    // Skip those entries here so a malformed batch entry can't throw a
    // TypeError before per-log validation runs.
    if (log === null || typeof log !== "object") continue;
    if (typeof log.transactionHash !== "string") continue;
    const txHashLower = log.transactionHash.toLowerCase();

    // Build txHashMap from ExecutionSuccess events (needed for SafeMultiSigTransaction)
    if (
      log.name === "ExecutionSuccess" &&
      log.txHash &&
      typeof log.txHash === "string"
    ) {
      txHashMap.set(txHashLower, log.txHash);
    }

    // Track which transactions have SafeMultiSigTransaction events
    if (log.name === "SafeMultiSigTransaction") {
      hasSafeMultiSigTx.add(txHashLower);
    }
  }

  return { txHashMap, hasSafeMultiSigTx };
}
