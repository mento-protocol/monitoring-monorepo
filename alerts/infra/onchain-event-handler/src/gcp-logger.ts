/**
 * Logger using @google-cloud/logging for structured logging in Google Cloud
 * Uses LogSync for Cloud Run/Functions to prevent log loss due to CPU constraints
 * @see https://cloud.google.com/logging/docs/structured-logging
 *
 * VENDORED FILE — keep the copies byte-identical:
 *   - alerts/infra/onchain-event-handler/src/gcp-logger.ts
 *   - alerts/infra/oncall-announcer/src/gcp-logger.ts
 * These Cloud Functions deploy from standalone lockfile roots, so they cannot
 * import a shared workspace package. A drift test in each package fails CI
 * when the copies diverge (see vendored-source-drift.test.ts).
 */

import { Logging } from "@google-cloud/logging";

/**
 * Map severity strings to Google Cloud Logging severity levels
 */
const severityMap = {
  DEBUG: "DEBUG",
  INFO: "INFO",
  WARNING: "WARNING",
  ERROR: "ERROR",
  CRITICAL: "CRITICAL",
} as const;

type LogSeverity = keyof typeof severityMap;

/**
 * Create a logger with methods for different severity levels.
 * All methods write logs synchronously to stdout (via LogSync).
 * The Logging agent picks up stdout logs and forwards them to Cloud Logging.
 */
export function createGcpLogger(logName: string) {
  // Initialize the Logging client
  // In Cloud Run/Functions, this automatically uses the service account credentials
  const logging = new Logging();

  // Use LogSync for serverless environments (Cloud Run, Cloud Functions, App Engine)
  // Async logs may be dropped in serverless due to lack of CPU
  // LogSync writes to stdout, which is picked up by the Logging agent
  const log = logging.logSync(logName);

  function writeLog(
    severity: LogSeverity,
    message: string,
    metadata?: Record<string, unknown>,
  ): void {
    try {
      const entry = log.entry(
        {
          severity: severityMap[severity],
        },
        {
          message,
          ...metadata,
        },
      );
      log.write(entry);
    } catch {
      // Fallback to console if logging fails (e.g., local dev without credentials)
      const fallbackMessage = `[${severity}] ${message}`;
      if (severity === "ERROR" || severity === "CRITICAL") {
        console.error(fallbackMessage, metadata);
      } else {
        console.log(fallbackMessage, metadata);
      }
    }
  }

  return {
    debug: (message: string, metadata?: Record<string, unknown>) => {
      writeLog("DEBUG", message, metadata);
    },
    info: (message: string, metadata?: Record<string, unknown>) => {
      writeLog("INFO", message, metadata);
    },
    warn: (message: string, metadata?: Record<string, unknown>) => {
      writeLog("WARNING", message, metadata);
    },
    error: (message: string, metadata?: Record<string, unknown>) => {
      writeLog("ERROR", message, metadata);
    },
    critical: (message: string, metadata?: Record<string, unknown>) => {
      writeLog("CRITICAL", message, metadata);
    },
  };
}
