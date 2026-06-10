import type { Request } from "@google-cloud/functions-framework";
import crypto from "crypto";
import config from "../config.js";
import getSecret from "./get-secret.js";

/**
 * Maximum allowed age (and future clock skew) of the x-qn-timestamp header.
 *
 * The timestamp is part of the HMAC input, so a verified signature proves it was
 * set by QuickNode — but without a freshness check, a captured request (e.g. from
 * an intermediate proxy or log) could be replayed indefinitely to produce duplicate
 * governance notifications. 5 minutes comfortably covers QuickNode delivery retries
 * and clock skew. We deliberately do NOT track x-qn-nonce values: a nonce cache
 * would live in per-instance memory only, adding little on top of this window and
 * the event-deduplication cache (see ./event-deduplication.ts).
 */
const MAX_TIMESTAMP_SKEW_SECONDS = 5 * 60;

export async function isFromQuicknode(req: Request): Promise<boolean> {
  const nonce = req.headers["x-qn-nonce"] as string;
  const timestamp = req.headers["x-qn-timestamp"] as string;
  const givenSignature = req.headers["x-qn-signature"] as string;

  // Cheap pre-checks come before any getSecret() call: the function is publicly
  // invokable and getSecret intentionally doesn't cache values, so every check we
  // can do without a Secret Manager round trip saves quota and latency on
  // unauthenticated scans and malformed traffic.
  if (!nonce || !timestamp || !givenSignature) {
    console.error("QuickNode Validation: Missing required QuickNode headers");
    return false;
  }

  if (!isTimestampFresh(timestamp)) {
    console.error(
      `QuickNode Validation: x-qn-timestamp outside the ±${String(
        MAX_TIMESTAMP_SKEW_SECONDS,
      )}s replay window: ${timestamp}`,
    );
    return false;
  }

  // Use rawBody for signature verification - this is the original request body
  // before any parsing. Re-serializing req.body with JSON.stringify() can produce
  // different output than what was sent, causing signature verification to fail.
  if (!req.rawBody) {
    console.error(
      "❌ QuickNode Validation: req.rawBody is not available. Cannot verify signature.",
    );
    return false;
  }

  try {
    const quicknodeSecurityToken = await getSecret(
      config.QUICKNODE_SECURITY_TOKEN_SECRET_ID,
    );
    const payloadString = req.rawBody.toString();
    const isValid = verifySignature(
      quicknodeSecurityToken,
      payloadString,
      nonce,
      timestamp,
      givenSignature,
    );

    if (isValid) {
      if (process.env.DEBUG) {
        console.log("\n✅ Signature verified successfully");
      }
      return true;
    } else {
      console.error("\n❌ QuickNode signature verification failed");
      return false;
    }
  } catch (error) {
    console.error("\n❌ Error processing QuickNode webhook:", error);
    return false;
  }
}

export async function hasAuthToken(req: Request): Promise<boolean> {
  const authToken = req.headers["x-auth-token"];

  // Don't burn a Secret Manager read when the header is absent (see the
  // pre-check note in isFromQuicknode).
  if (!authToken) {
    return false;
  }

  const expectedAuthToken = await getSecret(config.X_AUTH_TOKEN_SECRET_ID);

  return authToken === expectedAuthToken;
}

/**
 * Checks that the x-qn-timestamp header is within the replay window.
 * QuickNode sends unix epoch seconds; we tolerate milliseconds defensively
 * because the unit is controlled by QuickNode and guessing wrong would reject
 * every legitimate webhook (which QuickNode punishes by terminating it).
 */
function isTimestampFresh(timestamp: string): boolean {
  const parsed = Number(timestamp);
  if (!Number.isFinite(parsed)) {
    return false;
  }
  const timestampMs = parsed > 1e12 ? parsed : parsed * 1000;
  return (
    Math.abs(Date.now() - timestampMs) <= MAX_TIMESTAMP_SKEW_SECONDS * 1000
  );
}

// Taken from https://www.quicknode.com/guides/quicknode-products/streams/validating-incoming-streams-webhook-messages
function verifySignature(
  secretKey: string,
  payload: string,
  nonce: string,
  timestamp: string,
  givenSignature: string,
): boolean {
  // First concatenate signature inputs as strings
  const signatureData = nonce + timestamp + payload;

  // Use string directly instead of Buffer to avoid type errors with crypto.createHmac
  // in strict TypeScript environments (GCP build uses locked @types/node that triggers this)
  const hmac = crypto.createHmac("sha256", secretKey);
  hmac.update(signatureData);
  const computedSignature = hmac.digest("hex");

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

  // Reject signatures of the wrong length before converting: timingSafeEqual
  // throws on length-mismatched buffers and hexToBytes throws on odd-length hex,
  // turning a malformed x-qn-signature into a noisy TypeError instead of a clean
  // reject. The expected length is fixed (64 hex chars for HMAC-SHA256), so this
  // comparison leaks nothing secret.
  if (givenSignature.length !== computedSignature.length) {
    return false;
  }

  // Convert to Uint8Array manually to satisfy timingSafeEqual's ArrayBufferView requirement
  // without Buffer's type issues
  return crypto.timingSafeEqual(
    hexToBytes(computedSignature),
    hexToBytes(givenSignature),
  );
}

/**
 * Helper to convert hex string to Uint8Array.
 * We use this instead of Buffer to avoid type mismatches in newer @types/node versions,
 * which introduce stricter ArrayBufferLike checks that Buffer doesn't fully satisfy
 * (due to SharedArrayBuffer compatibility issues).
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
