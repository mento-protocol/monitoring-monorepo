/**
 * Emits a single-line JSON log entry that Cloud Run's logging agent parses
 * into a LogEntry with severity ERROR. Raw console.error text lands as
 * severity DEFAULT (verified live 2026-06-10) and is therefore invisible to
 * the error_logs_count metric that feeds the cloud-function-errors Slack
 * alert (infra/monitoring.tf).
 *
 * Contract: https://cloud.google.com/run/docs/logging#using-json — the
 * `severity` and `message` fields of a one-line JSON object are promoted
 * onto the LogEntry.
 *
 * Use this ONLY for error paths that should page Slack. Probe-facing rejects
 * (e.g. the 401 path) must stay on plain console.error — unauthenticated
 * internet noise must not feed the alert metric.
 */
export default function logError(message: string, error?: unknown): void {
  const detail =
    error === undefined ? message : `${message} ${formatError(error)}`;

  console.error(JSON.stringify({ severity: "ERROR", message: detail }));
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return JSON.stringify(error);
}
