/**
 * Discord message formatting and sending
 */

import axios, { AxiosError } from "axios";
import { DISCORD_COLORS, DISCORD_WEBHOOK_TIMEOUT_MS } from "./constants";
import { logger } from "./logger";
import type { DiscordMessage, QuickNodeDecodedLog } from "./types";
import {
  decodeEventData,
  getBlockExplorer,
  getMultisigChainInfo,
  getMultisigName,
  getSafeUiUrl,
  isSecurityEvent,
} from "./utils";

/**
 * Format a Discord message from a log event
 * @param eventName - The Safe event name (e.g., "AddedOwner", "ExecutionSuccess")
 * @param log - QuickNode decoded log entry containing transaction data
 * @param multisigKey - Multisig identifier key (e.g., "mento-labs")
 * @param txHashMap - Map of transactionHash -> txHash from ExecutionSuccess events
 * @returns Formatted Discord message with embeds
 */
export async function formatDiscordMessage(
  eventName: string,
  log: QuickNodeDecodedLog,
  multisigKey: string,
  txHashMap: Map<string, string>,
): Promise<DiscordMessage> {
  const isSecurity = isSecurityEvent(eventName);
  const color = isSecurity ? DISCORD_COLORS.ALERT : DISCORD_COLORS.EVENT;
  const multisigName = getMultisigName(multisigKey);

  // Get chain info - fail if not found
  const chainInfo = getMultisigChainInfo(multisigKey);
  if (!chainInfo) {
    throw new Error(`Chain info not found for multisig: ${multisigKey}`);
  }

  // Capitalize chain name
  const chainDisplay =
    chainInfo.chain.charAt(0).toUpperCase() + chainInfo.chain.slice(1);
  const chainName = chainInfo.chain;

  // Prefer txHash (Safe transaction hash) if available in the log,
  // otherwise look it up from ExecutionSuccess events via txHashMap,
  // finally fall back to transactionHash (on-chain tx hash)
  const txHashForSafe =
    log.txHash && typeof log.txHash === "string"
      ? log.txHash
      : txHashMap.get(log.transactionHash.toLowerCase()) || log.transactionHash;
  const safeUiUrl = getSafeUiUrl(log.address, txHashForSafe, multisigKey);

  // Get chain-specific block explorer
  const blockExplorer = getBlockExplorer(chainName);

  const fields = [
    {
      name: "Transaction Hash",
      value: `[${log.transactionHash}](${blockExplorer.tx(log.transactionHash)})`,
      inline: false,
    },
    {
      name: "Safe UI Link",
      value: `[Open TX in Safe UI](${safeUiUrl})`,
      inline: false,
    },
    ...(await decodeEventData(eventName, log, txHashForSafe, chainName)),
  ];

  // Build title: "Mento Labs Multisig [Celo]"
  const title = `${multisigName} [${chainDisplay}]`;

  // Build description: "AddedOwner event detected on Mento Labs Multisig on Celo"
  const description = `\`${eventName}\` event detected on ${multisigName} on ${chainDisplay}`;

  // Use current timestamp since block timestamp isn't in decoded log
  return {
    embeds: [
      {
        title,
        description,
        color,
        fields,
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

/**
 * Retry configuration for Discord webhook requests
 */
const DISCORD_RETRY_CONFIG = {
  maxRetries: 3,
  retryDelayMs: 1000, // Start with 1 second
  retryableStatusCodes: [429, 500, 502, 503, 504] as number[], // Rate limit and server errors
} as const;

/**
 * Check if an error is retryable
 */
function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const axiosError = error as AxiosError;
  const status = axiosError.response?.status;

  // Retry on network errors (no response) or retryable status codes
  if (!status) {
    return true; // Network error, retry
  }

  return DISCORD_RETRY_CONFIG.retryableStatusCodes.includes(status);
}

/**
 * Calculate exponential backoff delay
 */
function calculateRetryDelay(attempt: number): number {
  return DISCORD_RETRY_CONFIG.retryDelayMs * Math.pow(2, attempt);
}

/**
 * Send message to Discord webhook with retry logic
 * @param webhookUrl - Discord webhook URL to send the message to
 * @param message - Formatted Discord message with embeds
 * @throws {AxiosError} If the webhook request fails after all retries
 */
export async function sendToDiscord(
  webhookUrl: string,
  message: DiscordMessage,
): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= DISCORD_RETRY_CONFIG.maxRetries; attempt++) {
    try {
      await axios.post(webhookUrl, message, {
        headers: { "Content-Type": "application/json" },
        timeout: DISCORD_WEBHOOK_TIMEOUT_MS,
      });

      // Extract key info for logging
      const embed = message.embeds[0];
      const description = embed.description || "";
      const txField = embed.fields.find((f) => f.name === "Transaction Hash");
      const txHash = txField?.value.match(/\[([^\]]+)\]/)?.[1] || "unknown";

      if (attempt > 0) {
        logger.info("Discord message sent after retry", {
          description,
          transactionHash: txHash,
          attempt: attempt + 1,
        });
      } else {
        logger.info("Discord message sent", {
          description,
          transactionHash: txHash,
        });
      }

      return; // Success, exit function
    } catch (error) {
      lastError = error;

      const axiosError = error as AxiosError;
      const isLastAttempt = attempt === DISCORD_RETRY_CONFIG.maxRetries;

      // Log error details
      logger.warn("Discord webhook attempt failed", {
        attempt: attempt + 1,
        maxRetries: DISCORD_RETRY_CONFIG.maxRetries + 1,
        error:
          axiosError instanceof Error
            ? {
                name: axiosError.name,
                message: axiosError.message,
              }
            : String(axiosError),
        status: axiosError.response?.status,
        statusText: axiosError.response?.statusText,
      });

      // Check if we should retry
      if (!isLastAttempt && isRetryableError(error)) {
        const delay = calculateRetryDelay(attempt);
        logger.info("Retrying Discord webhook request", {
          attempt: attempt + 2,
          delayMs: delay,
        });
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue; // Retry
      }

      // Not retryable or last attempt, break and throw
      break;
    }
  }

  // All retries exhausted, log final error and throw
  const axiosError = lastError as AxiosError;
  logger.error("Discord webhook failed after all retries", {
    error:
      axiosError instanceof Error
        ? {
            name: axiosError.name,
            message: axiosError.message,
            stack: axiosError.stack,
          }
        : String(axiosError),
    status: axiosError.response?.status,
    statusText: axiosError.response?.statusText,
    data: axiosError.response?.data,
  });

  throw lastError;
}
