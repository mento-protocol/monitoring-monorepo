import { NextResponse } from "next/server";
import {
  PEG_ALERTS_WINDOW_SECONDS,
  type PegAlertsResponse,
} from "@/lib/peg-alerts";
import {
  readBoundedGrafanaResponse,
  resolveGrafanaEndpoint,
} from "@/lib/server/grafana-read";
import {
  combinePegAlertEvents,
  parsePolicyActivations,
  parseStateTransitions,
  policyQueryBounds,
  PEG_ALERTS_MAX_STATE_ROWS,
  PEG_ALERTS_POLICY_STEP_SECONDS,
} from "./peg-alert-events";

export const dynamic = "force-dynamic";
export const PEG_ALERTS_UPSTREAM_TIMEOUT_MS = 8_000;
export const PEG_ALERTS_MAX_STATE_RESPONSE_BYTES = 4 * 1024 * 1024;
export const PEG_ALERTS_MAX_POLICY_RESPONSE_BYTES = 512 * 1024;
export const PEG_ALERTS_MAX_EVENTS = 4;
export const PEG_ALERTS_DATASOURCE_UID = "grafanacloud-prom";

const responseHeaders = { "Cache-Control": "no-store" } as const;

function errorResponse(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status, headers: responseHeaders });
}

function stateHistoryUrl(
  origin: string | undefined,
  from: number,
  to: number,
  kind: "raised" | "cleared",
): URL | null {
  const url = resolveGrafanaEndpoint(origin, "/api/v1/rules/history");
  if (url === null) return null;
  url.searchParams.set("from", String(from));
  url.searchParams.set("to", String(to));
  url.searchParams.set("limit", String(PEG_ALERTS_MAX_STATE_ROWS));
  url.searchParams.set("labels_service", "peg-monitoring");
  if (kind === "cleared") {
    url.searchParams.set("previous", "Alerting");
    url.searchParams.set("current", "Normal");
  } else {
    url.searchParams.set("current", "Alerting");
  }
  return url;
}

function policyRequest(from: number, to: number): object {
  const bounds = policyQueryBounds(from, to);
  const stepMs = PEG_ALERTS_POLICY_STEP_SECONDS * 1_000;
  return {
    queries: [
      {
        refId: "P",
        datasource: {
          type: "prometheus",
          uid: PEG_ALERTS_DATASOURCE_UID,
        },
        expr: "mento_peg_policy_version",
        format: "time_series",
        range: true,
        instant: false,
        intervalMs: stepMs,
        maxDataPoints: (bounds.toMs - bounds.fromMs) / stepMs + 1,
      },
    ],
    // One extra point distinguishes a policy that predates the visible window
    // from a label series first observed inside it.
    from: String(bounds.fromMs),
    to: String(bounds.toMs),
  };
}

async function fetchJson(
  url: URL,
  token: string,
  maximumBytes: number,
  init: Pick<RequestInit, "body" | "method"> = {},
): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
    },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(PEG_ALERTS_UPSTREAM_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("Grafana unavailable");
  if (!response.headers.get("content-type")?.includes("application/json"))
    throw new Error("Grafana returned non-JSON");
  return JSON.parse(
    await readBoundedGrafanaResponse(response, maximumBytes),
  ) as unknown;
}

function timedOut(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

export async function GET(): Promise<NextResponse> {
  const to = Math.floor(Date.now() / 1_000);
  const from = to - PEG_ALERTS_WINDOW_SECONDS;
  const token = process.env.GRAFANA_QUERY_TOKEN?.trim();
  const raisedUrl = stateHistoryUrl(
    process.env.GRAFANA_QUERY_URL,
    from,
    to,
    "raised",
  );
  const clearedUrl = stateHistoryUrl(
    process.env.GRAFANA_QUERY_URL,
    from,
    to,
    "cleared",
  );
  const policyUrl = resolveGrafanaEndpoint(
    process.env.GRAFANA_QUERY_URL,
    "/api/ds/query",
  );
  if (
    token === undefined ||
    token === "" ||
    raisedUrl === null ||
    clearedUrl === null ||
    policyUrl === null
  )
    return errorResponse("Peg alert history is not configured", 503);

  try {
    const [raisedRaw, clearedRaw, policyRaw] = await Promise.all([
      fetchJson(raisedUrl, token, PEG_ALERTS_MAX_STATE_RESPONSE_BYTES),
      fetchJson(clearedUrl, token, PEG_ALERTS_MAX_STATE_RESPONSE_BYTES),
      fetchJson(policyUrl, token, PEG_ALERTS_MAX_POLICY_RESPONSE_BYTES, {
        method: "POST",
        body: JSON.stringify(policyRequest(from, to)),
      }),
    ]);
    const transitions = [
      ...parseStateTransitions(raisedRaw, from, to),
      ...parseStateTransitions(clearedRaw, from, to),
    ];
    const events = combinePegAlertEvents(
      transitions,
      parsePolicyActivations(policyRaw, from, to),
      PEG_ALERTS_MAX_EVENTS,
    );
    const response: PegAlertsResponse = { from, to, events };
    return NextResponse.json(response, { headers: responseHeaders });
  } catch (error) {
    if (timedOut(error))
      return errorResponse("Peg alert history timed out", 504);
    return errorResponse("Peg alert history upstream response is invalid", 502);
  }
}
