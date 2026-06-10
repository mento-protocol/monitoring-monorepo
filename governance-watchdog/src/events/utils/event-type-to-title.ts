import { EventType } from "../types";

/**
 * Transforms an EventType enum value into a human-readable title
 * @example eventTypeToTitle(EventType.ProposalCreated) // "Proposal Created"
 * @example eventTypeToTitle(EventType.ProposalQueued) // "Proposal Queued"
 */

export function eventTypeToTitle(eventType: EventType): string {
  // Insert space before each capital letter (except the first character)
  return eventType.replace(/([A-Z])/g, " $1").trim();
}
