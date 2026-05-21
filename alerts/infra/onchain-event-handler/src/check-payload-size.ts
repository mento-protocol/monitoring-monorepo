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
  const payloadSize = rawBody
    ? rawBody.length
    : typeof req.body === "string"
      ? Buffer.byteLength(req.body, "utf8")
      : JSON.stringify(req.body).length;

  return {
    valid: payloadSize <= MAX_PAYLOAD_SIZE_BYTES,
    size: payloadSize,
    maxSize: MAX_PAYLOAD_SIZE_BYTES,
  };
}
