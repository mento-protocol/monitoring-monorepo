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
    logger.error("Invalid webhook payload: missing or invalid result array", {
      body: req.body,
    });
    return {
      valid: false,
      status: 400,
      error: { error: "Invalid payload: result array is required" },
    };
  }

  return { valid: true, payload: webhookData };
}
