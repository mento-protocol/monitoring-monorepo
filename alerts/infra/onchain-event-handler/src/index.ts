import { Request, Response } from "@google-cloud/functions-framework";
import { buildEventContext } from "./build-event-context";
import {
  configuredPoolWatches,
  hasPoolBurnLog,
  poolBurnCandidates,
  stagePoolBurns,
} from "./pool-liquidity-withdrawal";
import { checkPayloadSize } from "./check-payload-size";
import config from "./config";
import { MULTISIG_CONFIG_ERROR } from "./constants";
import { handleHealthCheck } from "./health-check";
import { logger } from "./logger";
import { processEvents } from "./process-events";
import { reserveQuickNodeNonce } from "./quicknode-replay-protection";
import { validatePayload } from "./validate-payload";
import { validateQuickNodeWebhook } from "./validate-quicknode-webhook";

const DEFAULT_FUNCTION_TIMEOUT_SECONDS = 300;
const RESPONSE_HEADROOM_MS = 30_000;

function getProcessingBudgetMs(): number {
  const configuredTimeoutSeconds = Number(config.FUNCTION_TIMEOUT_SECONDS);
  const timeoutSeconds =
    Number.isFinite(configuredTimeoutSeconds) && configuredTimeoutSeconds > 0
      ? configuredTimeoutSeconds
      : DEFAULT_FUNCTION_TIMEOUT_SECONDS;
  return Math.max(0, timeoutSeconds * 1000 - RESPONSE_HEADROOM_MS);
}

/**
 * Cloud Function entry point for processing QuickNode webhooks
 */
export const processQuicknodeWebhook = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const requestStartedAtMs = Date.now();

  // Handle health check requests
  if (req.method === "GET") {
    handleHealthCheck(res);
    return;
  }

  try {
    if (MULTISIG_CONFIG_ERROR) {
      logger.error("Rejecting webhook because MULTISIG_CONFIG is invalid", {
        error: MULTISIG_CONFIG_ERROR,
      });
      res.status(503).json({
        error: "Service Unavailable",
        message: MULTISIG_CONFIG_ERROR,
      });
      return;
    }

    // 1. Check payload size
    const payloadSizeCheck = checkPayloadSize(req);
    if (!payloadSizeCheck.valid) {
      logger.warn("Payload size exceeded", {
        payloadSize: payloadSizeCheck.size,
        maxSize: payloadSizeCheck.maxSize,
      });
      res.status(413).json({
        error: "Payload Too Large",
        message: `Payload size ${payloadSizeCheck.size} bytes exceeds maximum of ${payloadSizeCheck.maxSize} bytes`,
      });
      return;
    }

    // 2. Verify webhook signature (skip in local development)
    const isProduction = process.env.NODE_ENV !== "development";

    let validatedWebhook: { nonce: string; timestamp: string } | null = null;

    if (isProduction) {
      const requestValidation = await validateQuickNodeWebhook(req);
      if (!requestValidation.valid) {
        logger.warn("Webhook validation failed", {
          status: requestValidation.status,
          message: requestValidation.message,
        });
        res.status(requestValidation.status).send(requestValidation.message);
        return;
      }
      validatedWebhook = requestValidation;
    }

    // 3. Validate payload structure
    const payloadValidation = validatePayload(req);
    if (!payloadValidation.valid) {
      logger.warn("Payload validation failed", {
        status: payloadValidation.status,
        error: payloadValidation.error,
      });
      res.status(payloadValidation.status).json(payloadValidation.error);
      return;
    }

    // Claim event keys before nonce reservation, so a signed replay can still
    // recover them after the Safe nonce is claimed. Private Scheduler performs
    // receipt proof and Slack delivery; the public runtime can only create
    // records, not rewrite or delete the delivery audit trail.
    const poolDelivery = (async (): Promise<boolean> => {
      try {
        if (!hasPoolBurnLog(req.body)) return false;
        const poolWatches = configuredPoolWatches();
        const { failures } = await stagePoolBurns(
          poolBurnCandidates(req.body, poolWatches),
        );
        return failures > 0;
      } catch (error) {
        logger.error("Watched LP withdrawal delivery failed", {
          reason: "pool_liquidity_delivery_failed",
          error: error instanceof Error ? error.message : String(error),
        });
        return true;
      }
    })();

    // 4. Reserve the nonce only after the payload is structurally valid. If
    // QuickNode sends an envelope we do not understand, reserving first would
    // make its retry look like a duplicate and permanently hide the producer
    // bug instead of giving the fixed handler another chance to process it.
    if (validatedWebhook) {
      const replayValidation = await reserveQuickNodeNonce(
        validatedWebhook.nonce,
        validatedWebhook.timestamp,
      );
      if (!replayValidation.valid) {
        logger.warn("Webhook replay validation failed", {
          status: replayValidation.status,
          message: replayValidation.message,
          replayed: replayValidation.replayed,
        });
        if ((await poolDelivery) && replayValidation.replayed) {
          res.status(503).send("Watched LP withdrawal delivery failed");
        } else {
          res.status(replayValidation.status).send(replayValidation.message);
        }
        return;
      }
    }

    const webhookPayload = payloadValidation.payload;
    // Safe has no Burn event. Keep Burns out of its formatter even when the
    // pool watch config is invalid; its error must not block Safe delivery.
    const webhookData = webhookPayload.result.filter(
      (log) => !(log && typeof log === "object" && log.name === "Burn"),
    );

    logger.info("Processing webhook", {
      logCount: webhookData.length,
    });

    // 5. Build context needed for processing
    // We need this context BEFORE processing to correctly skip ExecutionSuccess duplicates
    const context = buildEventContext(webhookData);

    // 6. Process events with complete context
    const results = await processEvents(webhookData, context, {
      budgetMs: getProcessingBudgetMs(),
      startedAtMs: requestStartedAtMs,
    });

    logger.info("Webhook processing completed", {
      processed: results.processedEvents.length,
      skipped: results.skipped,
      total: webhookData.length,
    });

    // A 503 asks QuickNode to retry Watched LP while the claimed Safe nonce prevents
    // duplicate Safe posts. The retry function also recovers staged events.
    if (await poolDelivery) {
      res.status(503).send("Watched LP withdrawal delivery failed");
      return;
    }

    // 7. Return success
    res.status(200).json({
      processed: results.processedEvents.length,
      skipped: results.skipped,
      total: webhookData.length,
    });
  } catch (error) {
    // ChainDetectionError is handled (logged + dropped) inside processEvents'
    // per-event catch — see the design note there. Only unexpected outer
    // failures (payload parsing exceptions, etc.) reach this branch.
    logger.error("Webhook processing error", {
      error:
        error instanceof Error
          ? {
              name: error.name,
              message: error.message,
              stack: error.stack,
            }
          : String(error),
    });
    res.status(500).send("Internal Server Error");
  }
};
