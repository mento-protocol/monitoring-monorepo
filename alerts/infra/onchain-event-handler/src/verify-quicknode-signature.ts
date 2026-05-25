/**
 * QuickNode webhook signature verification
 *
 * QuickNode signs webhooks using: HMAC-SHA256(secret, nonce + timestamp + payload)
 * Reference: https://www.quicknode.com/guides/quicknode-products/streams/validating-incoming-streams-webhook-messages
 */

import crypto from "crypto";
import { logger } from "./logger";

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

  // Concatenate signature inputs as strings (nonce + timestamp + payload)
  const signatureData = nonce + timestamp + payload;

  // Compute HMAC-SHA256 signature
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(signatureData);
  const computedSignature = hmac.digest("hex");

  // Validate that both signatures are valid hex strings with even length
  // HMAC-SHA256 produces 64 hex characters (32 bytes)
  if (
    !isValidHex(computedSignature) ||
    !isValidHex(givenSignature) ||
    computedSignature.length !== givenSignature.length
  ) {
    return false;
  }

  // Use timing-safe comparison to prevent timing attacks
  return crypto.timingSafeEqual(
    hexToBytes(computedSignature),
    hexToBytes(givenSignature),
  );
}

/**
 * Validate that a string is a valid hex string with even length
 * @param hex - String to validate
 * @returns true if valid hex string with even length
 */
function isValidHex(hex: string): boolean {
  return /^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0;
}

/**
 * Helper to convert hex string to Uint8Array for timing-safe comparison
 *
 * We use this instead of Buffer to avoid type mismatches in newer @types/node versions,
 * which introduce stricter ArrayBufferLike checks that Buffer doesn't fully satisfy
 * (due to SharedArrayBuffer compatibility issues).
 *
 * @param hex - Hex string to convert (must be valid hex with even length)
 * @returns Uint8Array representation of the hex string
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
