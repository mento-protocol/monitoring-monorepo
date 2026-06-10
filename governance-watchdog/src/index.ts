import type {
  HttpFunction,
  Request,
  Response,
} from "@google-cloud/functions-framework";
import { processEvent } from "./events/process-event.js";
import { initializeEventRegistry } from "./events/registry.js";
import { EventType } from "./events/types.js";
import { checkWebhookStatus } from "./quicknode-health/index.js";
import { getCacheSize, isDuplicate } from "./utils/event-deduplication.js";
import parseRequestBody from "./utils/parse-request-body.js";
import {
  hasAuthToken,
  isFromQuicknode,
} from "./utils/validate-request-origin.js";

/**
 * Check if the webhook body contains only health check events (MedianUpdated).
 * Used to avoid verbose logging for routine health check pings.
 */
const isHealthCheckWebhook = (body: unknown): boolean => {
  if (
    !body ||
    typeof body !== "object" ||
    !("result" in body) ||
    !Array.isArray(body.result)
  ) {
    return false;
  }

  const result = (body as { result: unknown[] }).result;
  return (
    result.length > 0 &&
    result.every(
      (event) =>
        event &&
        typeof event === "object" &&
        "name" in event &&
        event.name === EventType.MedianUpdated,
    )
  );
};

// Initialize event registry at global scope to leverage Cloud Functions instance reuse
// This runs once per container instance (cold start), not on every invocation (warm start)
initializeEventRegistry();

/**
 * Handles the /quicknode-health endpoint which checks QuickNode webhook status.
 * Called periodically by Cloud Scheduler to detect terminated or paused webhooks.
 */
const handleQuicknodeHealthCheck = async (
  _req: Request,
  res: Response,
): Promise<void> => {
  const requestStartTime = Date.now();

  try {
    const result = await checkWebhookStatus();

    if (result.healthy) {
      console.info(
        `[QuickNodeHealth] All webhooks healthy: ${result.webhooks.map((w) => `${w.name}=${w.status}`).join(", ")}`,
      );
      res.status(200).send("All QuickNode webhooks are healthy");
    } else {
      // Log as ERROR to trigger Slack alert via error_logs_policy
      console.error(
        `[QuickNodeHealth] ❌ Unhealthy webhooks detected: ${result.unhealthyWebhooks.join(", ")}`,
      );
      console.error(
        `[QuickNodeHealth] Webhook statuses: ${JSON.stringify(result.webhooks)}`,
      );
      res
        .status(500)
        .send(`Unhealthy webhooks: ${result.unhealthyWebhooks.join(", ")}`);
    }
  } catch (error) {
    const requestDuration = Date.now() - requestStartTime;
    // Include timing in error log to help diagnose timeouts
    console.error(
      `[QuickNodeHealth] ❌ Failed to check webhook status after ${String(requestDuration)}ms:`,
      error,
    );
    res.status(500).send("Failed to check QuickNode webhook status");
  }
};

/**
 * Handles QuickNode webhook events - the main event processing logic.
 */
const handleQuicknodeWebhook = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const isProduction = process.env.NODE_ENV !== "development";

  /**
   * In production, we only want to accept requests that
   *  1) Come from QuickNode
   *  2) OR have an auth token (which we use for testing in production)
   */
  if (isProduction) {
    const isHealthCheck = isHealthCheckWebhook(req.body);

    if (await isFromQuicknode(req)) {
      // Skip verbose logging for health check webhooks to reduce log noise
      if (!isHealthCheck) {
        console.info("Received QuickNode Webhook:", req.body);
      }
    } else if (await hasAuthToken(req)) {
      console.info("Received Call with auth token:", req.body);
    } else {
      console.error("Unauthorized. Request origin validation failed.");
      res.status(401).send("Unauthorized");
      return;
    }
  }

  if (!req.body) {
    console.info("No events to process");
    res.status(200).send("No events to process");
    return;
  }

  if (req.body && typeof req.body === "object" && "error" in req.body) {
    console.error(
      "❌ Request body contains an error:",
      (req.body as { error: unknown }).error,
    );
    res.status(500).send("Something went wrong 🤔");
    return;
  }

  let eventsProcessed = 0;
  let eventsDeduplicated = 0;

  for (const quicknodeEvent of parseRequestBody(req.body)) {
    // Skip duplicated events to prevent sending multiple notifications
    if (isDuplicate(quicknodeEvent)) {
      eventsDeduplicated++;
      continue;
    } else {
      eventsProcessed++;
    }

    await processEvent(quicknodeEvent);
  }

  if (eventsDeduplicated > 0) {
    console.log(
      `Events processed: ${String(
        eventsProcessed,
      )}, Events deduplicated: ${String(
        eventsDeduplicated,
      )}, Deduplication cache size: ${String(getCacheSize())}`,
    );
  }

  res.status(200).send("Event successfully processed");
};

export const governanceWatchdog: HttpFunction = async (
  req: Request,
  res: Response,
) => {
  try {
    // Route based on path
    if (req.path === "/quicknode-health") {
      await handleQuicknodeHealthCheck(req, res);
      return;
    }

    // Default: handle QuickNode webhook events
    await handleQuicknodeWebhook(req, res);
  } catch (error) {
    console.error("Error processing request:", error);
    res.status(500).send("Something went wrong 🤔");
  }
};
