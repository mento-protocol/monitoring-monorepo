// Dead-man switch for the Sentry triage pipeline (issue #1281, ADR 0036).
//
// Cloud Scheduler calls this hourly. It reads the newest successful
// `sentry-triage-ingest.yml` run from the GitHub API and publishes the age of
// that run as a Cloud Monitoring gauge. alerts/infra/monitoring.tf alerts when
// the gauge exceeds 26h *or* when it stops arriving.
//
// It lives outside GitHub Actions on purpose: a scheduler that dies silently
// cannot report its own death, so the check must not run on the thing it
// checks.
//
// The GitHub read is deliberately unauthenticated. `mento-protocol/
// monitoring-monorepo` is public and this endpoint needs no scope, so at one
// call per hour the watcher stays far inside the 60/hr unauthenticated limit.
// Adding a token here would hand a credential to a service whose only job is
// to notice silence — do not add one.

import { freshnessSeconds, parseLatestSuccessfulRun } from "./freshness.mjs";

const GITHUB_API_BASE = "https://api.github.com";
const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const MONITORING_API_BASE = "https://monitoring.googleapis.com/v3";
const OUTBOUND_TIMEOUT_MS = 10_000;

function log(severity, message, fields = {}) {
  // Cloud Logging promotes `severity` out of the structured payload, which is
  // what the log-based views in monitoring.tf filter on.
  console.log(JSON.stringify({ severity, message, ...fields }));
}

function requiredEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value === "") {
    throw new Error(`missing required environment variable: ${name}`);
  }
  return value;
}

async function fetchWorkflowRuns(repository, workflowFile) {
  const url = `${GITHUB_API_BASE}/repos/${repository}/actions/workflows/${workflowFile}/runs?status=success&per_page=10`;
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "mento-sentry-ingest-watcher",
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`github_http_${response.status}`);
  }
  return response.json();
}

async function runtimeAccessToken() {
  const response = await fetch(METADATA_TOKEN_URL, {
    headers: { "metadata-flavor": "Google" },
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`metadata_http_${response.status}`);
  }
  const body = await response.json();
  if (typeof body?.access_token !== "string") {
    throw new Error("metadata_token_missing");
  }
  return body.access_token;
}

async function publishFreshness({ projectId, metricType, seconds, nowMs }) {
  const token = await runtimeAccessToken();
  const response = await fetch(
    `${MONITORING_API_BASE}/projects/${projectId}/timeSeries`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        timeSeries: [
          {
            metric: { type: metricType },
            resource: { type: "global", labels: { project_id: projectId } },
            metricKind: "GAUGE",
            valueType: "INT64",
            points: [
              {
                interval: { endTime: new Date(nowMs).toISOString() },
                value: { int64Value: String(seconds) },
              },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw new Error(
      `monitoring_http_${response.status}: ${await response.text()}`,
    );
  }
}

export const handleSentryIngestFreshness = async (_request, response) => {
  let projectId;
  let metricType;
  let repository;
  let workflowFile;
  try {
    projectId = requiredEnv("GCP_PROJECT_ID");
    metricType = requiredEnv("FRESHNESS_METRIC_TYPE");
    repository = requiredEnv("GITHUB_REPOSITORY");
    workflowFile = requiredEnv("INGEST_WORKFLOW_FILE");
  } catch (error) {
    log("ERROR", "sentry_ingest_watcher.misconfigured", {
      error: String(error),
    });
    response.status(500).send("misconfigured");
    return;
  }

  let parsed;
  try {
    parsed = parseLatestSuccessfulRun(
      await fetchWorkflowRuns(repository, workflowFile),
    );
  } catch (error) {
    // Publish nothing. A guessed value would look fresh; silence lets the
    // absence condition alert instead.
    log("ERROR", "sentry_ingest_watcher.github_unreachable", {
      error: String(error),
      repository,
      workflowFile,
    });
    response.status(502).send("github_unreachable");
    return;
  }

  if (!parsed.ok) {
    log("ERROR", "sentry_ingest_watcher.freshness_unresolved", {
      reason: parsed.reason,
      repository,
      workflowFile,
    });
    response.status(502).send(parsed.reason);
    return;
  }

  const nowMs = Date.now();
  const seconds = freshnessSeconds(parsed.completedAtMs, nowMs);
  if (seconds === null) {
    log("ERROR", "sentry_ingest_watcher.freshness_unresolved", {
      reason: "freshness_not_computable",
      repository,
      workflowFile,
    });
    response.status(502).send("freshness_not_computable");
    return;
  }

  try {
    await publishFreshness({ projectId, metricType, seconds, nowMs });
  } catch (error) {
    log("ERROR", "sentry_ingest_watcher.publish_failed", {
      error: String(error),
      freshnessSeconds: seconds,
    });
    response.status(500).send("publish_failed");
    return;
  }

  log("INFO", "sentry_ingest_watcher.published", {
    freshnessSeconds: seconds,
    lastSuccessfulRunAt: new Date(parsed.completedAtMs).toISOString(),
  });
  response.status(200).json({ freshnessSeconds: seconds });
};
