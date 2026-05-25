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
  // QuickNode envelope varies by API era:
  //   - Pre-template (custom filter_function): `{ result: [...] }` — the
  //     filter function explicitly returned this shape.
  //   - Template-based (evmContractEvents, evmAbiFilter, etc.): may deliver
  //     `{ data: [...], metadata: {...} }` per the Webhooks envelope.
  // We accept both shapes and normalize to `result` so the rest of the
  // handler stays a single code path. The two top-level keys are checked
  // in priority order — if both somehow appear, `result` wins.
  const body = req.body as
    | { result?: unknown; data?: unknown }
    | null
    | undefined;

  const rawArray =
    body && Array.isArray(body.result)
      ? body.result
      : body && Array.isArray(body.data)
        ? body.data
        : null;

  if (!rawArray) {
    // Don't log req.body. Even though signature verification has already
    // passed at this point, a malformed payload could still be large or
    // contain sensitive multisig-event data that bloats Cloud Logging.
    // The shape diagnostic below is enough to debug real producer bugs.
    logger.error(
      "Invalid webhook payload: neither result nor data array present",
      {
        hasBody: req.body !== undefined,
        bodyType: typeof req.body,
        topLevelKeys:
          body && typeof body === "object" ? Object.keys(body) : null,
        resultIsArray: Array.isArray(body?.result),
        dataIsArray: Array.isArray(body?.data),
      },
    );
    return {
      valid: false,
      status: 400,
      error: { error: "Invalid payload: result or data array is required" },
    };
  }

  // Normalize to the canonical `result` shape. The QuickNodeWebhookPayload
  // type stays `{ result: QuickNodeDecodedLog[] }`; downstream code is
  // agnostic to whether the wire-level envelope was `data` or `result`.
  const payload = {
    result: rawArray as QuickNodeWebhookPayload["result"],
  } satisfies QuickNodeWebhookPayload;

  return { valid: true, payload };
}
