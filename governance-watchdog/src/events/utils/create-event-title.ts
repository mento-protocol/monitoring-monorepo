import { EventType } from "../types.js";
import { eventTypeToTitle } from "./event-type-to-title.js";

/**
 * Creates a title with emoji decorations
 * @example createEventTitle("🎉", EventType.ProposalCreated) // "🎉 Proposal Created 🎉"
 */
export function createEventTitle(emoji: string, eventType: EventType): string {
  const title = eventTypeToTitle(eventType);
  return `${emoji} ${title} ${emoji}`;
}
