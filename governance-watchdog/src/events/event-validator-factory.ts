import { QuicknodeEvent } from "./types.js";

interface EventValidatorConfig {
  requiredFields: string[];
  additionalValidation?: (event: Record<string, unknown>) => boolean;
}

/**
 * Creates a generic event validator for common patterns
 * Note: Event type validation happens at the routing level, not here
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export function createEventValidator<T extends QuicknodeEvent>(
  config: EventValidatorConfig,
) {
  return function validateEvent(event: unknown): event is T {
    // Basic type checks
    if (!isObject(event)) {
      return false;
    }

    // Validate required fields exist
    const basicValidation = config.requiredFields.every(
      (field) => field in event,
    );

    // If no additional validation provided, return basic validation
    if (!config.additionalValidation) {
      return basicValidation;
    }

    // Return basic validation AND additional validation
    return basicValidation && config.additionalValidation(event);
  };
}

/**
 * Type guard to check if a value is an object (but not array or null)
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
