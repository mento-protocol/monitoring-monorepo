import { Logging } from "@google-cloud/logging";

const logging = new Logging();
const log = logging.logSync("oncall-announcer");

const severityMap = {
  DEBUG: "DEBUG",
  INFO: "INFO",
  WARNING: "WARNING",
  ERROR: "ERROR",
  CRITICAL: "CRITICAL",
} as const;

type LogSeverity = keyof typeof severityMap;

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
    const fallbackMessage = `[${severity}] ${message}`;
    if (severity === "ERROR" || severity === "CRITICAL") {
      console.error(fallbackMessage, metadata);
    } else {
      console.log(fallbackMessage, metadata);
    }
  }
}

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
