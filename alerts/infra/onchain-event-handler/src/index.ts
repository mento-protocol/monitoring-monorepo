import { Request, Response } from "@google-cloud/functions-framework";
import { buildEventContext } from "./build-event-context";
import { checkPayloadSize } from "./check-payload-size";
import { handleHealthCheck } from "./health-check";
import { logger } from "./logger";
import { ChainDetectionError, processEvents } from "./process-events";
import { validatePayload } from "./validate-payload";
import { validateQuickNodeWebhook } from "./validate-quicknode-webhook";

/**
 * Cloud Function entry point for processing QuickNode webhooks
 */
export const processQuicknodeWebhook = async (
  req: Request,
  res: Response,
): Promise<void> => {
  // Handle health check requests
  if (req.method === "GET") {
    handleHealthCheck(res);
    return;
  }

  try {
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

    if (isProduction) {
      const requestValidation = validateQuickNodeWebhook(req);
      if (!requestValidation.valid) {
        logger.warn("Webhook validation failed", {
          status: requestValidation.status,
          message: requestValidation.message,
        });
        res.status(requestValidation.status).send(requestValidation.message);
        return;
      }
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

    const webhookPayload = payloadValidation.payload;
    const webhookData = webhookPayload.result;

    logger.info("Processing webhook", {
      logCount: webhookData.length,
    });

    // 4. Build context needed for processing
    // We need this context BEFORE processing to correctly skip ExecutionSuccess duplicates
    const context = buildEventContext(webhookData);

    // 5. Process events with complete context
    const results = await processEvents(webhookData, context);

    logger.info("Webhook processing completed", {
      processed: results.length,
      total: webhookData.length,
    });

    // 6. Return success
    res.status(200).json({
      processed: results.length,
      total: webhookData.length,
    });
  } catch (error) {
    // Handle chain detection errors with a specific HTTP status code
    if (error instanceof ChainDetectionError) {
      logger.error("Chain detection failed", {
        error: error.message,
        address: error.address,
        blockHash: error.blockHash,
        transactionHash: error.transactionHash,
      });
      res.status(422).json({
        error: "Unprocessable Entity",
        message: error.message,
        details: {
          address: error.address,
          blockHash: error.blockHash,
          transactionHash: error.transactionHash,
        },
      });
      return;
    }

    // Handle other errors as internal server errors
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
