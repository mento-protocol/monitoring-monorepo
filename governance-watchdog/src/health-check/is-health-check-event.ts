import {
  EventType,
  type MedianUpdatedEvent,
  type QuicknodeEvent,
} from "../events/types.js";

export default function isHealthCheckEvent(
  event: unknown,
): event is QuicknodeEvent & MedianUpdatedEvent {
  return (
    event !== null &&
    event !== undefined &&
    typeof event === "object" &&
    "name" in event &&
    event.name === EventType.MedianUpdated &&
    "token" in event &&
    "value" in event
  );
}
