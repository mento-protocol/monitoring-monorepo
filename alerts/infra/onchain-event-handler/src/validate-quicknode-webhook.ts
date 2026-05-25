import type { Request } from "@google-cloud/functions-framework";
import config from "./config";
import { logger } from "./logger";
import { reserveQuickNodeNonce } from "./quicknode-replay-protection";
import { verifyQuickNodeSignature } from "./verify-quicknode-signature";

type ValidationResult =
  | { valid: true; nonce: string; timestamp: string }
  | {
      valid: false;
      status: number;
      message: string;
      error?: unknown;
      replayed?: boolean;
    };

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
export async function validateQuickNodeWebhook(
  req: Request,
): Promise<ValidationResult> {
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

  // QuickNode signs the EXACT raw HTTP body bytes. `JSON.stringify(req.body)`
  // can't reproduce them — any field reorder, whitespace difference, or
  // float-precision diff in the parse-then-serialize roundtrip produces a
  // different byte sequence and every signature check fails 401.
  //
  // Gen2 Cloud Functions populate `req.rawBody` reliably (functions-framework
  // 4.x stashes the buffer before body-parser runs). If it's missing in
  // production, that's a runtime/configuration bug — fail loudly with a 500
  // rather than silently rejecting every legitimate webhook.
  const rawBody = (req as RequestWithRawBody).rawBody;
  if (!rawBody) {
    logger.error("rawBody missing from QuickNode webhook request", {
      bodyType: typeof req.body,
      contentType: req.headers["content-type"],
    });
    return {
      valid: false,
      status: 500,
      message: "Server configuration error: rawBody unavailable",
    };
  }
  const payload = rawBody.toString("utf8");

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

  const replayValidation = await reserveQuickNodeNonce(nonce, timestamp);
  if (!replayValidation.valid) {
    return replayValidation;
  }

  return { valid: true, nonce, timestamp };
}
