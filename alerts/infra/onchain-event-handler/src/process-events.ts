import type { EventContext } from "./build-event-context";
import { formatDiscordMessage, sendToDiscord } from "./discord";
import { logger } from "./logger";
import type {
  ProcessedEvent,
  QuickNodeDecodedLog,
  QuickNodeWebhookPayload,
} from "./types";
import {
  findChainForAddress,
  findChainFromBlockHash,
  getMultisigKey,
  getWebhookUrl,
  isSecurityEvent,
} from "./utils";

const DEFAULT_PROCESSING_BUDGET_MS = 270_000;

interface ProcessEventsOptions {
  /**
   * Maximum wall-clock time to spend starting event work. Defaults to 270s,
   * leaving 30s of headroom under the Cloud Function's 300s timeout for the
   * HTTP response and platform overhead.
   */
  budgetMs?: number;
  now?: () => number;
}

interface ProcessEventsResult {
  processedEvents: ProcessedEvent[];
  skipped: number;
}

/**
 * Error thrown when chain cannot be determined from webhook payload.
 * Local to this module — the outer handler in index.ts doesn't catch it
 * (the per-event try/catch below logs+drops it instead of re-throwing).
 */
class ChainDetectionError extends Error {
  constructor(
    message: string,
    public readonly address: string,
    public readonly blockHash?: string,
    public readonly transactionHash?: string,
  ) {
    super(message);
    this.name = "ChainDetectionError";
  }
}

/**
 * Process all events from webhook payload
 * Skips ExecutionSuccess notifications if there's a SafeMultiSigTransaction for the same tx
 *
 * @param logs - Array of decoded log entries from QuickNode webhook
 * @param context - Event context built from first pass
 * @returns Array of successfully processed events
 */
export async function processEvents(
  logs: QuickNodeWebhookPayload["result"],
  context: EventContext,
  options: ProcessEventsOptions = {},
): Promise<ProcessEventsResult> {
  const { txHashMap, hasSafeMultiSigTx } = context;
  const now = options.now ?? Date.now;
  const budgetMs = options.budgetMs ?? DEFAULT_PROCESSING_BUDGET_MS;
  const startedAt = now();

  // Filter out logs that should be skipped before processing.
  const logsToProcess = logs.filter((logEntry) => {
    // Drop null / non-object entries at filter time. Payload validation only
    // checks that `result` is an array, so a malformed batch entry would
    // otherwise reach processEvent → validateLog → the per-event catch (all
    // of which read fields like `transactionHash`) and throw a TypeError that
    // rejects Promise.all → HTTP 500 → QuickNode retries the whole batch →
    // duplicate Discord deliveries for events that already succeeded.
    if (logEntry === null || typeof logEntry !== "object") return false;
    // Skip ExecutionSuccess if we already have SafeMultiSigTransaction for this tx.
    if (
      logEntry.name === "ExecutionSuccess" &&
      typeof logEntry.transactionHash === "string" &&
      hasSafeMultiSigTx.has(logEntry.transactionHash.toLowerCase())
    ) {
      logger.info("Skipping ExecutionSuccess notification", {
        reason: "SafeMultiSigTransaction already sent",
        transactionHash: logEntry.transactionHash,
      });
      return false;
    }
    return true;
  });

  const processedEvents: ProcessedEvent[] = [];
  let skipped = 0;

  for (const [index, logEntry] of logsToProcess.entries()) {
    const elapsedMs = now() - startedAt;
    if (elapsedMs >= budgetMs) {
      skipped = logsToProcess.length - index;
      logger.warn("Skipping remaining logs due to processing budget", {
        reason: "skipped_due_to_timeout",
        skipped,
        processed: processedEvents.length,
        elapsedMs,
        budgetMs,
      });
      break;
    }

    try {
      const result = await processEvent(logEntry, txHashMap);
      if (result) {
        processedEvents.push(result);
      }
    } catch (error) {
      // Defense-in-depth: logEntry could in principle still be malformed
      // (e.g. a primitive that slipped past the filter's object check).
      // Guard property reads so a logger call can't throw on top of the
      // original error. Returning 200 to QuickNode avoids replaying the whole
      // batch and duplicating Discord deliveries that already succeeded.
      const safe: Partial<QuickNodeDecodedLog> =
        logEntry !== null && typeof logEntry === "object" ? logEntry : {};
      logger.error("Error processing log", {
        error:
          error instanceof Error
            ? {
                name: error.name,
                message: error.message,
                stack: error.stack,
              }
            : String(error),
        transactionHash: safe.transactionHash,
        eventName: safe.name,
        chainDetectionFailure: error instanceof ChainDetectionError,
      });
    }
  }

  return { processedEvents, skipped };
}

/**
 * Validate required fields in a log entry
 */
function validateLog(log: QuickNodeWebhookPayload["result"][0]): {
  valid: boolean;
  error?: string;
} {
  if (!log.address || typeof log.address !== "string") {
    return { valid: false, error: "Log missing or invalid address field" };
  }

  if (!log.name || typeof log.name !== "string") {
    return { valid: false, error: "Log missing or invalid name field" };
  }

  if (!log.transactionHash || typeof log.transactionHash !== "string") {
    return {
      valid: false,
      error: "Log missing or invalid transactionHash field",
    };
  }

  return { valid: true };
}

/**
 * Process a single event log and send to Discord
 *
 * @param logEntry - The decoded log entry from QuickNode webhook
 * @param txHashMap - Map of transactionHash -> Safe txHash for linking transactions
 * @returns ProcessedEvent if successful, null if event should be skipped
 */
async function processEvent(
  logEntry: QuickNodeWebhookPayload["result"][0],
  txHashMap: Map<string, string>,
): Promise<ProcessedEvent | null> {
  // 1. Validate required fields
  const validation = validateLog(logEntry);
  if (!validation.valid) {
    logger.warn("Invalid log entry", {
      error: validation.error,
      address: logEntry.address,
      name: logEntry.name,
      transactionHash: logEntry.transactionHash,
    });
    return null;
  }

  // 2. Get event name from decoded log
  const eventName = logEntry.name!;

  // 3. Identify multisig with chain-aware lookup
  const multisigAddress = logEntry.address!.toLowerCase();

  // Determine chain from block hash (most reliable when same address exists on multiple chains)
  // Fall back to address lookup if block hash is not available
  let chain: string | null = null;

  if (logEntry.blockHash && typeof logEntry.blockHash === "string") {
    chain = await findChainFromBlockHash(logEntry.blockHash, multisigAddress);
  }

  // Fallback to address lookup if block hash verification didn't work
  if (!chain) {
    chain = findChainForAddress(multisigAddress);
  }

  if (!chain) {
    const errorMessage =
      "Could not determine chain from block hash or address. The multisig address may not be configured, or the block hash could not be verified on any known chain.";
    logger.error("Chain detection failed", {
      address: multisigAddress,
      blockHash: logEntry.blockHash,
      transactionHash: logEntry.transactionHash,
    });
    throw new ChainDetectionError(
      errorMessage,
      multisigAddress,
      logEntry.blockHash as string | undefined,
      logEntry.transactionHash,
    );
  }

  // Get multisig key using chain-aware lookup
  const multisigKey = getMultisigKey(multisigAddress, chain);

  if (!multisigKey) {
    logger.warn("Unknown multisig address for chain", {
      address: multisigAddress,
      chain,
      transactionHash: logEntry.transactionHash,
    });
    return null;
  }

  // 4. Determine channel (alerts vs events)
  const isSecurity = isSecurityEvent(eventName);
  const channelType = isSecurity ? "alerts" : "events";

  // 5. Get webhook URL
  const webhookUrl = getWebhookUrl(multisigKey, channelType);
  if (!webhookUrl) {
    logger.error("No webhook URL found", {
      multisigKey,
      channelType,
    });
    return null;
  }

  // 6. Format Discord message
  const discordMessage = await formatDiscordMessage(
    eventName,
    logEntry,
    multisigKey,
    txHashMap,
  );

  // 7. Send to Discord
  await sendToDiscord(webhookUrl, discordMessage);

  logger.info("Event processed successfully", {
    multisigKey,
    eventName,
    channelType,
    transactionHash: logEntry.transactionHash,
  });

  return { multisigKey, eventName, channelType };
}
