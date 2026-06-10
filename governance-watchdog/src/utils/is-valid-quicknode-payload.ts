import { QuicknodePayload } from "../events/types.js";

/**
 * Check if the payload is a valid QuickNode payload
 */
export default function isValidQuicknodePayload(
  requestBody: unknown,
): requestBody is QuicknodePayload {
  return (
    typeof requestBody === "object" &&
    requestBody !== null &&
    "result" in requestBody &&
    Array.isArray((requestBody as QuicknodePayload).result) &&
    (requestBody as QuicknodePayload).result.every((event) => {
      const e = event as unknown as Record<string, unknown>;
      return (
        typeof event === "object" &&
        typeof e.address === "string" &&
        typeof e.blockHash === "string" &&
        typeof e.blockNumber === "string" &&
        typeof e.logIndex === "string" &&
        typeof e.name === "string" &&
        typeof e.transactionHash === "string"
      );
    })
  );
}
