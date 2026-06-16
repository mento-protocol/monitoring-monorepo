/**
 * QuickNode webhook signature verification
 *
 * QuickNode signs webhooks using: HMAC-SHA256(secret, nonce + timestamp + payload)
 * Reference: https://www.quicknode.com/guides/quicknode-products/streams/validating-incoming-streams-webhook-messages
 */

import { logger } from "./logger";
import { verifyQuickNodeHmac } from "./quicknode-hmac";

/**
 * Maximum allowed timestamp difference in milliseconds (±5 minutes)
 */
const MAX_TIMESTAMP_DIFF_MS = 5 * 60 * 1000;

/**
 * Verify QuickNode webhook signature
 *
 * @param secret - The secret key used for signing (from QuickNode webhook configuration)
 * @param payload - The raw request body as a string
 * @param nonce - The nonce from x-qn-nonce header
 * @param timestamp - The timestamp from x-qn-timestamp header
 * @param givenSignature - The signature from x-qn-signature header
 * @returns true if signature is valid, false otherwise
 */
export function verifyQuickNodeSignature(
  secret: string,
  payload: string,
  nonce: string,
  timestamp: string,
  givenSignature: string,
): boolean {
  if (!secret || !nonce || !timestamp || !givenSignature) {
    return false;
  }

  // Validate timestamp freshness (prevent replay attacks)
  const timestampNum = parseInt(timestamp, 10);
  if (isNaN(timestampNum)) {
    return false;
  }

  const now = Date.now();
  const timestampMs = timestampNum * 1000; // Convert seconds to milliseconds
  const diff = Math.abs(now - timestampMs);

  if (diff > MAX_TIMESTAMP_DIFF_MS) {
    logger.warn("Timestamp validation failed", {
      timestamp,
      timestampMs,
      now,
      diff,
      maxDiff: MAX_TIMESTAMP_DIFF_MS,
    });
    return false;
  }

  return verifyQuickNodeHmac(secret, payload, nonce, timestamp, givenSignature);
}
