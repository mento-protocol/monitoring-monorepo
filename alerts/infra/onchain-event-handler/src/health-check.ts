import { Response } from "@google-cloud/functions-framework";
import config from "./config";
import { MULTISIGS_BY_CHAIN } from "./constants";

/**
 * Health check endpoint handler
 */
export function handleHealthCheck(res: Response): void {
  const checks: Record<string, { status: string; message?: string }> = {};

  // Check config
  try {
    const hasWebhookAlerts = !!config.DISCORD_WEBHOOK_ALERTS;
    const hasWebhookEvents = !!config.DISCORD_WEBHOOK_EVENTS;
    const hasMultisigConfig = !!config.MULTISIG_CONFIG;
    const hasSigningSecret = !!config.QUICKNODE_SIGNING_SECRET;

    checks.config = {
      status:
        hasWebhookAlerts &&
        hasWebhookEvents &&
        hasMultisigConfig &&
        hasSigningSecret
          ? "ok"
          : "error",
      message: !hasWebhookAlerts
        ? "Missing DISCORD_WEBHOOK_ALERTS"
        : !hasWebhookEvents
          ? "Missing DISCORD_WEBHOOK_EVENTS"
          : !hasMultisigConfig
            ? "Missing MULTISIG_CONFIG"
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
    const multisigCount = Object.keys(MULTISIGS_BY_CHAIN).length;
    checks.multisigs = {
      status: multisigCount > 0 ? "ok" : "warning",
      message:
        multisigCount > 0
          ? `${multisigCount} multisig(s) configured`
          : "No multisigs configured",
    };
  } catch (error) {
    checks.multisigs = {
      status: "error",
      message: `Failed to parse multisig config: ${error instanceof Error ? error.message : String(error)}`,
    };
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
