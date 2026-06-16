/**
 * QuickNode webhook HMAC-SHA256 signature verification (shared core).
 *
 * QuickNode signs webhooks using: HMAC-SHA256(secret, nonce + timestamp + payload)
 * Reference: https://www.quicknode.com/guides/quicknode-products/streams/validating-incoming-streams-webhook-messages
 *
 * VENDORED FILE — keep the copies byte-identical:
 *   - alerts/infra/onchain-event-handler/src/quicknode-hmac.ts
 *   - governance-watchdog/src/utils/quicknode-hmac.ts
 * These Cloud Functions deploy from standalone lockfile roots, so they cannot
 * import a shared workspace package. A drift test in each package fails CI
 * when the copies diverge (see vendored-source-drift.test.ts). Replay
 * protection (timestamp freshness, nonce tracking) deliberately differs per
 * function and stays OUT of this file.
 */

import crypto from "crypto";

/**
 * Verify a QuickNode webhook HMAC-SHA256 signature.
 *
 * @param secret - The secret key used for signing (from QuickNode webhook configuration)
 * @param payload - The raw request body as a string
 * @param nonce - The nonce from the x-qn-nonce header
 * @param timestamp - The timestamp from the x-qn-timestamp header
 * @param givenSignature - The signature from the x-qn-signature header
 * @returns true if the signature is valid, false otherwise
 */
export function verifyQuickNodeHmac(
  secret: string,
  payload: string,
  nonce: string,
  timestamp: string,
  givenSignature: string,
): boolean {
  // Concatenate signature inputs as strings (nonce + timestamp + payload)
  const signatureData = nonce + timestamp + payload;

  // Compute HMAC-SHA256 signature
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(signatureData);
  const computedSignature = hmac.digest("hex");

  // Intentional parity between standalone function roots: DEBUG logs signature
  // metadata and the first payload bytes for operator debugging. This path is
  // disabled unless DEBUG is set on the function.
  if (process.env.DEBUG) {
    console.log("\nSignature Debug:");
    console.log("Message components:");
    console.log("- Nonce:", nonce);
    console.log("- Timestamp:", timestamp);
    console.log("- Payload first 100 chars:", payload.substring(0, 100));
    console.log("\nSignatures:");
    console.log("- Computed:", computedSignature);
    console.log("- Given:", givenSignature);
  }

  // Validate that both signatures are valid hex strings of equal, even length
  // before converting: timingSafeEqual throws on length-mismatched buffers and
  // hexToBytes mangles odd-length or non-hex input. HMAC-SHA256 always produces
  // 64 hex chars, so this comparison leaks nothing secret.
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
 * Validate that a string is a valid hex string with even length.
 */
function isValidHex(hex: string): boolean {
  return /^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0;
}

/**
 * Helper to convert hex string to Uint8Array for timing-safe comparison.
 *
 * We use this instead of Buffer to avoid type mismatches in newer @types/node
 * versions, which introduce stricter ArrayBufferLike checks that Buffer doesn't
 * fully satisfy (due to SharedArrayBuffer compatibility issues).
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
