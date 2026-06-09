import { EventType, QuicknodeEvent } from "../events/types.js";
import isValidQuicknodePayload from "./is-valid-quicknode-payload.js";

/**
 * Parse request body containing parsed events from QuickNode
 */
export default function parseRequestBody(
  requestBody: unknown,
): QuicknodeEvent[] {
  if (!isValidQuicknodePayload(requestBody)) {
    throw new Error(
      `Request body is not a valid QuickNode payload: ${JSON.stringify(
        requestBody,
      )}`,
    );
  }

  const parsedEvents: QuicknodeEvent[] = [];

  for (const event of requestBody.result) {
    const eventType = Object.values(EventType).includes(event.name)
      ? (event.name as EventType)
      : EventType.Unknown;

    if (eventType === EventType.Unknown) {
      console.log(`Skipping unknown event: '${event.name}'.`);
      continue;
    }

    parsedEvents.push(event);
  }

  return parsedEvents;
}
