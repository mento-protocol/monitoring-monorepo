import handleHealthCheck from "../health-check/index.js";
import { EVENT_CONFIGS } from "./configs.js";
import { createEventHandler } from "./event-handler-factory.js";
import {
  EventHandlerFunction,
  EventRegistryEntry,
  EventType,
  ExtendedEventHandlerConfig,
  QuicknodeEvent,
} from "./types.js";

/**
 * Event registry that manages all event handlers
 */
class EventRegistry {
  private handlers = new Map<EventType, EventRegistryEntry>();
  private specialHandlers = new Map<string, EventHandlerFunction>();

  /**
   * Register an event handler
   */
  register<T extends QuicknodeEvent>(
    config: ExtendedEventHandlerConfig<T>,
    handler: EventHandlerFunction,
  ): void {
    const entry: EventRegistryEntry = {
      eventType: config.eventType,
      handler,
      config: config as unknown as ExtendedEventHandlerConfig<QuicknodeEvent>,
    };

    this.handlers.set(config.eventType, entry);
  }

  /**
   * Register a special handler (like health checks)
   */
  registerSpecial(name: string, handler: EventHandlerFunction): void {
    this.specialHandlers.set(name, handler);
  }

  /**
   * Get handler for an event type
   */
  getHandler(eventType: EventType): EventHandlerFunction | undefined {
    const entry = this.handlers.get(eventType);
    return entry?.handler;
  }

  /**
   * Get special handler by name
   */
  getSpecialHandler(name: string): EventHandlerFunction | undefined {
    return this.specialHandlers.get(name);
  }

  /**
   * Get all registered event types
   */
  getRegisteredEventTypes(): EventType[] {
    return Array.from(this.handlers.keys());
  }

  /**
   * Get configuration for an event type
   */
  getConfig(
    eventType: EventType,
  ): ExtendedEventHandlerConfig<QuicknodeEvent> | undefined {
    const entry = this.handlers.get(eventType);
    return entry?.config;
  }

  /**
   * Check if an event type is registered
   */
  isRegistered(eventType: EventType): boolean {
    return this.handlers.has(eventType);
  }
}

// Global registry instance
export const eventRegistry = new EventRegistry();

/**
 * Auto-register all events from the centralized event configurations
 * This automatically loops through EVENT_CONFIGS, so new events are registered
 * simply by adding them to configs.ts
 */
export function initializeEventRegistry(): void {
  // Auto-register all events from EVENT_CONFIGS
  Object.values(EVENT_CONFIGS).forEach((config) => {
    // Type assertion needed because Object.values() creates a union type
    // At runtime, each config is correctly typed for its specific event
    eventRegistry.register(
      config as ExtendedEventHandlerConfig<QuicknodeEvent>,
      createEventHandler(config as ExtendedEventHandlerConfig<QuicknodeEvent>),
    );
  });

  // Register special handlers (i.e. the health check does not emit notifications and has some custom logic)
  eventRegistry.registerSpecial("healthCheck", handleHealthCheck);

  console.log(
    `Event registry initialized with ${String(eventRegistry.getRegisteredEventTypes().length)} event types`,
  );
}
