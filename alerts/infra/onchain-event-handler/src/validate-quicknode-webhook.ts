import type { Request } from "@google-cloud/functions-framework";
import config from "./config";
import { logger } from "./logger";
import { verifyQuickNodeSignature } from "./verify-quicknode-signature";

type ValidationResult =
  | { valid: true }
  | { valid: false; status: number; message: string; error?: unknown };

/**
 * Extended Request interface that includes rawBody for signature verification
 */
interface RequestWithRawBody extends Request {
  rawBody?: Buffer;
}

/**
 * Validate QuickNode webhook request signature
 * Extracts headers, retrieves payload, and verifies signature.
 *
 * @param req - The incoming HTTP request
 * @returns Validation result - if invalid, includes status code and error message
 */
export function validateQuickNodeWebhook(req: Request): ValidationResult {
  // Extract required headers
  const nonce = req.headers["x-qn-nonce"] as string | undefined;
  const timestamp = req.headers["x-qn-timestamp"] as string | undefined;
  const signature = req.headers["x-qn-signature"] as string | undefined;

  const secret = config.QUICKNODE_SIGNING_SECRET;

  if (!secret) {
    logger.error("QUICKNODE_SIGNING_SECRET is not configured");
    return {
      valid: false,
      status: 500,
      message: "Server configuration error",
    };
  }

  // Validate required headers are present
  if (!nonce || !timestamp || !signature) {
    logger.warn("Missing required QuickNode headers", {
      headers: Object.keys(req.headers),
      hasNonce: !!nonce,
      hasTimestamp: !!timestamp,
      hasSignature: !!signature,
    });
    return {
      valid: false,
      status: 401,
      message: "Unauthorized: Missing required headers",
    };
  }

  // Get payload as string (QuickNode signs the raw request body)
  // Try to access rawBody first (if available from Express middleware)
  // Otherwise reconstruct from parsed body
  let payload: string;
  const rawBody = (req as RequestWithRawBody).rawBody;
  if (rawBody) {
    // Use raw body if available (as string)
    payload = rawBody.toString("utf8");
  } else if (typeof req.body === "string") {
    payload = req.body;
  } else if (req.body === undefined) {
    // Missing body: stay a string so downstream .length / .substring calls
    // don't throw and the request gets the intended 401 signature rejection
    // (not a 500 from a TypeError).
    payload = "";
  } else {
    // JSON.stringify can return undefined for symbols/functions; coerce to
    // empty string in that case.
    payload = JSON.stringify(req.body) ?? "";
  }

  // Verify signature
  if (!verifyQuickNodeSignature(secret, payload, nonce, timestamp, signature)) {
    // Don't log payload contents here — auth-failure log is reachable by
    // anyone who knows the function URL, so logging an attacker-controlled
    // 200-byte preview is a log-injection / cost-amplification path. The
    // boolean/length fields below are enough to diagnose real client bugs.
    logger.error("Invalid webhook signature", {
      hasSecret: !!secret,
      hasNonce: !!nonce,
      hasTimestamp: !!timestamp,
      hasSignature: !!signature,
      signatureLength: signature?.length,
      secretLength: secret?.length,
      payloadLength: payload.length,
      usingRawBody: !!rawBody,
    });
    return {
      valid: false,
      status: 401,
      message: "Unauthorized: Invalid signature",
    };
  }

  return { valid: true };
}
