import type { Request } from "@google-cloud/functions-framework";
import crypto from "crypto";
import config from "../config.js";
import getSecret from "./get-secret.js";
import { verifyQuickNodeHmac } from "./quicknode-hmac.js";

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
  // callable and getSecret intentionally doesn't cache values, so every check we
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
    const isValid = verifyQuickNodeHmac(
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
  if (typeof authToken !== "string" || authToken === "") {
    return false;
  }

  const expectedAuthToken = await getSecret(config.X_AUTH_TOKEN_SECRET_ID);

  // Constant-time comparison, like the signature check above. The length
  // pre-check is required (timingSafeEqual throws on mismatched lengths)
  // and leaks only the token length.
  const encoder = new TextEncoder();
  const given = encoder.encode(authToken);
  const expected = encoder.encode(expectedAuthToken);

  return (
    given.length === expected.length && crypto.timingSafeEqual(given, expected)
  );
}

/**
 * Checks that the x-qn-timestamp header is within the replay window.
 * QuickNode sends unix epoch seconds; we tolerate milliseconds defensively
 * because the unit is controlled by QuickNode and guessing wrong would reject
 * every legitimate webhook (which QuickNode punishes by terminating it).
 *
 * Do NOT "clean this up" into a strict seconds-only check: the tolerance does
 * not widen the window (each timestamp string normalizes to a single instant,
 * and the timestamp is HMAC-bound so an attacker can't re-encode it), but
 * removing it would reject every webhook if QuickNode ever switches units.
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
