import type { EventContext } from "./build-event-context";
import { formatDiscordMessage, sendToDiscord } from "./discord";
import { logger } from "./logger";
import type { ProcessedEvent, QuickNodeWebhookPayload } from "./types";
import {
  findChainForAddress,
  findChainFromBlockHash,
  getMultisigKey,
  getWebhookUrl,
  isSecurityEvent,
} from "./utils";

/**
 * Error thrown when chain cannot be determined from webhook payload
 */
export class ChainDetectionError extends Error {
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
): Promise<ProcessedEvent[]> {
  const { txHashMap, hasSafeMultiSigTx } = context;

  // Filter out logs that should be skipped before parallel processing
  const logsToProcess = logs.filter((logEntry) => {
    // Skip ExecutionSuccess if we already have SafeMultiSigTransaction for this tx
    if (
      logEntry.name === "ExecutionSuccess" &&
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

  // Process all events in parallel
  const results = await Promise.all(
    logsToProcess.map(async (logEntry) => {
      try {
        return await processEvent(logEntry, txHashMap);
      } catch (error) {
        logger.error("Error processing log", {
          error:
            error instanceof Error
              ? {
                  name: error.name,
                  message: error.message,
                  stack: error.stack,
                }
              : String(error),
          transactionHash: logEntry.transactionHash,
          eventName: logEntry.name,
        });
        // Return null for failed events
        return null;
      }
    }),
  );

  // Filter out null results (failed events)
  return results.filter((result): result is ProcessedEvent => result !== null);
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
