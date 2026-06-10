import { eventRegistry } from "../events/registry.js";
import { EventType, QuicknodeEvent } from "../events/types.js";

type EventId = string;
type Timestamp = number;

// Map to store recently processed events in memory
const processedEvents = new Map<EventId, Timestamp>();

// Window of time in which to consider an event as a duplicate
const DEDUPLICATION_WINDOW_MS = 60 * 1000; // 1 minute

// Maximum number of events to keep in cache before cleanup
const MAX_CACHE_SIZE = 100;

/**
 * Extracts unique data from an event based on the configured deduplication strategy
 */
function extractUniqueData(
  event: QuicknodeEvent,
  strategy: "proposalId" | "rateFeedId" | "transactionHash" | "custom",
): string {
  switch (strategy) {
    case "proposalId":
      return "proposalId" in event ? event.proposalId.toString() : "";

    case "rateFeedId":
      if ("token" in event && "value" in event) {
        return `${event.token}-${event.value.toString()}`;
      }
      return "";

    case "transactionHash":
      return event.transactionHash;

    case "custom":
      // For custom strategies, we fall back to a combination of available fields
      // This can be extended in the future if specific custom logic is needed
      console.warn(
        `Custom deduplication strategy not yet implemented for ${event.name}`,
      );
      return "";

    default:
      return "";
  }
}

/**
 * Generates a unique ID for an event based on its configured deduplication strategy
 */
function generateEventId(event: QuicknodeEvent): EventId {
  const config = eventRegistry.getConfig(event.name);

  if (!config) {
    console.warn(`No config found for event type: ${event.name}`);
    // Fallback to basic deduplication using transaction data
    return `${event.name}-${event.transactionHash}-${event.blockNumber}-${event.logIndex}`;
  }

  const uniqueData = extractUniqueData(event, config.deduplicationStrategy);

  return `${event.name}-${uniqueData}-${event.transactionHash}-${event.blockNumber}-${event.logIndex}`;
}

/**
 * Removes old entries from the cache to prevent possible memory leaks.
 * Given the nature of Cloud Functions shutting down after a period of inactivity,
 * it's unlikely for this cache to grow too large, but still good practice to clean it up.
 */
function cleanupOldEntries(): void {
  const expiredTime = Date.now() - DEDUPLICATION_WINDOW_MS;

  for (const [id, timestamp] of processedEvents.entries()) {
    if (timestamp < expiredTime) {
      processedEvents.delete(id);
    }
  }
}

/**
 * Checks if an event is a duplicate (meaning: the same EventID has been processed recently)
 * @param event The event to check
 * @returns true if the event is a duplicate, false otherwise
 */
export function isDuplicate(event: QuicknodeEvent): boolean {
  const eventId = generateEventId(event);
  const now = Date.now();

  if (process.env.DEBUG) {
    console.log(
      `[DEDUP] Checking event: ${event.name} (logIndex: ${event.logIndex}, txHash: ${event.transactionHash})`,
    );

    if (
      event.name === EventType.MedianUpdated &&
      "token" in event &&
      "value" in event
    ) {
      console.log(
        `[DEDUP] MedianUpdated details - token: ${event.token},
         value: ${String(event.value)}`,
      );
    }
    console.log(`[DEDUP] Generated eventId: ${eventId}`);
  }

  // Check if we've seen this event recently
  if (processedEvents.has(eventId)) {
    const lastSeen = processedEvents.get(eventId) ?? 0;
    if (now - lastSeen < DEDUPLICATION_WINDOW_MS) {
      console.log(`[DEDUP] Duplicate event detected: ${eventId}`);
      return true; // It's a duplicate within our window
    }
  }

  // Update the cache
  processedEvents.set(eventId, now);

  if (process.env.DEBUG) {
    console.log(`[DEDUP] New event added to cache: ${eventId}`);
  }

  // Clean up old entries if cache is getting too large
  if (processedEvents.size > MAX_CACHE_SIZE) {
    cleanupOldEntries();
  }

  return false;
}

/**
 * For debugging/monitoring: get current size of deduplication cache
 */
export function getCacheSize(): number {
  return processedEvents.size;
}
