import type { Request } from "@google-cloud/functions-framework";
import { logger } from "./logger";
import type { QuickNodeWebhookPayload } from "./types";

type PayloadValidationResult =
  | { valid: true; payload: QuickNodeWebhookPayload }
  | { valid: false; status: number; error: { error: string } };

/**
 * Validate QuickNode webhook payload structure
 * Ensures the request body contains a valid result array
 *
 * @param req - The incoming HTTP request
 * @returns Validation result with parsed payload if valid
 */
export function validatePayload(req: Request): PayloadValidationResult {
  const webhookData = req.body as QuickNodeWebhookPayload;

  // Validate payload structure
  if (
    !webhookData ||
    !webhookData.result ||
    !Array.isArray(webhookData.result)
  ) {
    // Don't log req.body. Even though signature verification has already
    // passed at this point, a malformed payload could still be large or
    // contain sensitive multisig-event data that bloats Cloud Logging.
    // The shape diagnostic below is enough to debug real producer bugs.
    logger.error("Invalid webhook payload: missing or invalid result array", {
      hasBody: req.body !== undefined,
      bodyType: typeof req.body,
      hasResult:
        req.body !== null &&
        typeof req.body === "object" &&
        "result" in (req.body as object),
      resultIsArray: Array.isArray(
        (req.body as { result?: unknown } | undefined)?.result,
      ),
    });
    return {
      valid: false,
      status: 400,
      error: { error: "Invalid payload: result array is required" },
    };
  }

  return { valid: true, payload: webhookData };
}
