import type { Request } from "@google-cloud/functions-framework";

/**
 * Maximum payload size in bytes (10MB)
 */
const MAX_PAYLOAD_SIZE_BYTES = 10 * 1024 * 1024;

interface PayloadSizeCheck {
  valid: boolean;
  size: number;
  maxSize: number;
}

/**
 * Extended Request interface that includes rawBody for payload size checking
 */
interface RequestWithRawBody extends Request {
  rawBody?: Buffer;
}

/**
 * Check if request payload size is within limits
 */
export function checkPayloadSize(req: Request): PayloadSizeCheck {
  const rawBody = (req as RequestWithRawBody).rawBody;
  // JSON.stringify(undefined) returns undefined (not the string "undefined"),
  // so .length throws on a missing body. Treat missing/empty as size 0.
  const stringified =
    typeof req.body === "string"
      ? req.body
      : req.body === undefined
        ? ""
        : (JSON.stringify(req.body) ?? "");
  const payloadSize = rawBody
    ? rawBody.length
    : Buffer.byteLength(stringified, "utf8");

  return {
    valid: payloadSize <= MAX_PAYLOAD_SIZE_BYTES,
    size: payloadSize,
    maxSize: MAX_PAYLOAD_SIZE_BYTES,
  };
}
