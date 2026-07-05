/**
 * Dead-letter persistence for Safe/multisig alerts that exhaust Slack
 * delivery retries. Reuses the same GCS bucket + metadata-server auth as
 * QuickNode nonce replay protection (quicknode-replay-protection.ts), under
 * a distinct "dead-letter/" prefix, instead of provisioning new infra.
 *
 * Redrive path: scripts/redrive-onchain-deadletter.mjs lists objects under
 * this prefix, reposts them to Slack, then archives them under
 * "dead-letter/done/".
 */

import { logger } from "./logger";
import { getMetadataAccessToken } from "./quicknode-replay-protection";
import type { SlackMessage } from "./slack";
import type { QuickNodeDecodedLog } from "./types";

const STORAGE_UPLOAD_BASE_URL =
  "https://storage.googleapis.com/upload/storage/v1/b";

const DEAD_LETTER_PREFIX = "dead-letter/";

type Fetch = typeof fetch;

interface DeadLetterInput {
  logEntry: QuickNodeDecodedLog;
  slackMessage: SlackMessage;
  multisigKey: string;
  channelId: string;
  chain: string;
  failureReason: string;
}

interface WriteDeadLetterOptions {
  bucketName?: string;
  fetchImpl?: Fetch;
  /**
   * Bounds both the metadata-token fetch and the GCS upload so a stalled
   * write can't eat into the webhook's response budget indefinitely — see
   * deadLetterIfSlackDeliveryFailed in process-events.ts, which supplies a
   * short fixed-timeout signal independent of the overall request budget.
   */
  signal?: AbortSignal;
}

/**
 * Persist a dead-lettered Safe alert to GCS so it can be redriven later.
 * Never throws: a write failure here must not crash the batch, so every
 * failure path logs at ERROR and returns instead of rejecting.
 */
export async function writeDeadLetter(
  input: DeadLetterInput,
  options: WriteDeadLetterOptions = {},
): Promise<void> {
  const bucketName =
    options.bucketName ?? process.env.QUICKNODE_REPLAY_BUCKET ?? "";
  const transactionHash = input.logEntry.transactionHash;

  if (!bucketName) {
    logger.error("Dead-letter write failed", {
      reason: "dead_letter_bucket_not_configured",
      transactionHash,
    });
    return;
  }

  const objectName = `${DEAD_LETTER_PREFIX}${transactionHash}-${input.logEntry.logIndex}-${Date.now()}.json`;
  const fetchImpl = options.fetchImpl ?? fetch;

  try {
    const accessToken = await getMetadataAccessToken(fetchImpl, options.signal);
    const uploadUrl = new URL(
      `${STORAGE_UPLOAD_BASE_URL}/${encodeURIComponent(bucketName)}/o`,
    );
    uploadUrl.searchParams.set("uploadType", "media");
    uploadUrl.searchParams.set("name", objectName);

    const response = await fetchImpl(uploadUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        deadLetteredAt: new Date().toISOString(),
        failureReason: input.failureReason,
        eventName: input.logEntry.name,
        transactionHash,
        chain: input.chain,
        multisigKey: input.multisigKey,
        channelId: input.channelId,
        logEntry: input.logEntry,
        slackMessage: input.slackMessage,
      }),
      signal: options.signal,
    });

    if (!response.ok) {
      logger.error("Dead-letter write failed", {
        reason: "dead_letter_write_failed",
        status: response.status,
        statusText: response.statusText,
        transactionHash,
      });
      return;
    }

    // Distinct, grep-able marker for operators: this ERROR means a Safe
    // alert could not be delivered to Slack but IS safely persisted and
    // redrivable — see scripts/redrive-onchain-deadletter.mjs.
    logger.error("Dead-lettered Safe alert after Slack delivery failure", {
      reason: "dead_lettered",
      objectName,
      transactionHash,
      eventName: input.logEntry.name,
      chain: input.chain,
      multisigKey: input.multisigKey,
      channelId: input.channelId,
      failureReason: input.failureReason,
    });
  } catch (error) {
    logger.error("Dead-letter write failed", {
      reason: "dead_letter_write_failed",
      error: error instanceof Error ? error.message : String(error),
      transactionHash,
    });
  }
}
