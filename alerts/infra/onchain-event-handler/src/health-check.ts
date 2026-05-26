import { Response } from "@google-cloud/functions-framework";
import config from "./config";
import { MULTISIGS_BY_CHAIN, MULTISIG_CONFIG_ERROR } from "./constants";

/**
 * Health check endpoint handler
 */
export function handleHealthCheck(res: Response): void {
  const checks: Record<string, { status: string; message?: string }> = {};

  // Check config
  try {
    const hasSlackBotToken = !!config.SLACK_BOT_TOKEN;
    const hasSlackChannelAlerts = !!config.SLACK_CHANNEL_ALERTS;
    const hasSlackChannelEvents = !!config.SLACK_CHANNEL_EVENTS;
    const hasSigningSecret = !!config.QUICKNODE_SIGNING_SECRET;

    checks.config = {
      status:
        hasSlackBotToken &&
        hasSlackChannelAlerts &&
        hasSlackChannelEvents &&
        hasSigningSecret
          ? "ok"
          : "error",
      message: !hasSlackBotToken
        ? "Missing SLACK_BOT_TOKEN"
        : !hasSlackChannelAlerts
          ? "Missing SLACK_CHANNEL_ALERTS"
          : !hasSlackChannelEvents
            ? "Missing SLACK_CHANNEL_EVENTS"
            : !hasSigningSecret
              ? "Missing QUICKNODE_SIGNING_SECRET"
              : undefined,
    };
  } catch (error) {
    checks.config = {
      status: "error",
      message: `Config error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // Check multisig config parsing
  try {
    if (MULTISIG_CONFIG_ERROR) {
      checks.multisigs = {
        status: "error",
        message: MULTISIG_CONFIG_ERROR,
      };
      throw new Error(MULTISIG_CONFIG_ERROR);
    }
    const multisigCount = Object.keys(MULTISIGS_BY_CHAIN).length;
    checks.multisigs = {
      status: multisigCount > 0 ? "ok" : "error",
      message:
        multisigCount > 0
          ? `${multisigCount} multisig(s) configured`
          : "No multisigs configured",
    };
  } catch (error) {
    if (!checks.multisigs) {
      checks.multisigs = {
        status: "error",
        message: `Failed to parse multisig config: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  const allOk = Object.values(checks).every((check) => check.status === "ok");
  const hasErrors = Object.values(checks).some(
    (check) => check.status === "error",
  );

  res.status(hasErrors ? 503 : allOk ? 200 : 200).json({
    status: hasErrors ? "unhealthy" : allOk ? "healthy" : "degraded",
    checks,
    timestamp: new Date().toISOString(),
  });
}
