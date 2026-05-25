/**
 * Logger using @google-cloud/logging for structured logging in Google Cloud
 * Uses LogSync for Cloud Run/Functions to prevent log loss due to CPU constraints
 * @see https://cloud.google.com/logging/docs/structured-logging
 */

import { Logging } from "@google-cloud/logging";

// Initialize the Logging client
// In Cloud Run/Functions, this automatically uses the service account credentials
const logging = new Logging();

// Use LogSync for serverless environments (Cloud Run, Cloud Functions, App Engine)
// Async logs may be dropped in serverless due to lack of CPU
// LogSync writes to stdout, which is picked up by the Logging agent
const log = logging.logSync("onchain-event-handler");

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
 * Write a log entry with the specified severity
 * Uses LogSync which writes synchronously to stdout (picked up by Logging agent)
 * This prevents log loss in serverless environments where async logs may be dropped
 */
function writeLog(
  severity: LogSeverity,
  message: string,
  metadata?: Record<string, unknown>,
): void {
  try {
    const entryMetadata = {
      severity: severityMap[severity],
      // Resource type will be automatically detected in Cloud Run environment
      // For local development, it will use 'global' as fallback
    };

    const entry = log.entry(entryMetadata, {
      message,
      ...metadata,
    });

    // LogSync writes synchronously to stdout
    // The Logging agent picks up stdout logs and forwards them to Cloud Logging
    log.write(entry);
  } catch {
    // Fallback to console if logging fails (e.g., in local development without credentials)
    // This ensures logs are still visible during development
    const fallbackMessage = `[${severity}] ${message}`;
    if (severity === "ERROR" || severity === "CRITICAL") {
      console.error(fallbackMessage, metadata);
    } else {
      console.log(fallbackMessage, metadata);
    }
  }
}

/**
 * Logger with methods for different severity levels
 * All methods write logs synchronously to stdout (via LogSync)
 * The Logging agent picks up stdout logs and forwards them to Cloud Logging
 */
export const logger = {
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
