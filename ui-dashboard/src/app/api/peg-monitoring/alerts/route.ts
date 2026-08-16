import { NextResponse } from "next/server";
import {
  PEG_ALERTS_WINDOW_SECONDS,
  type PegAlertsResponse,
} from "@/lib/peg-alerts";
import {
  GRAFANA_NO_STORE_HEADERS,
  grafanaErrorResponse,
  isGrafanaTimeout,
  readBoundedGrafanaResponse,
  resolveGrafanaEndpoint,
} from "@/lib/server/grafana-read";
import {
  combinePegAlertEvents,
  parseStateTransitions,
  PEG_ALERTS_MAX_STATE_ROWS,
} from "./peg-alert-events";

export const dynamic = "force-dynamic";
export const PEG_ALERTS_UPSTREAM_TIMEOUT_MS = 8_000;
export const PEG_ALERTS_MAX_STATE_RESPONSE_BYTES = 4 * 1024 * 1024;
export const PEG_ALERTS_MAX_EVENTS = 4;
export const PEG_ALERTS_CONTEXT_LEAD_IN_SECONDS = PEG_ALERTS_WINDOW_SECONDS;

function stateHistoryUrl(
  origin: string | undefined,
  from: number,
  to: number,
  kind: "pending" | "raised" | "cleared" | "canceled",
): URL | null {
  const url = resolveGrafanaEndpoint(origin, "/api/v1/rules/history");
  if (url === null) return null;
  url.searchParams.set("from", String(from));
  url.searchParams.set("to", String(to));
  // Ask for one sentinel row beyond the parser cap so a full page proves the
  // seven-day result was truncated instead of silently losing an incident.
  url.searchParams.set("limit", String(PEG_ALERTS_MAX_STATE_ROWS + 1));
  url.searchParams.set("labels_service", "peg-monitoring");
  url.searchParams.set(
    "current",
    kind === "raised" ? "Alerting" : kind === "pending" ? "Pending" : "Normal",
  );
  if (kind === "cleared") url.searchParams.set("previous", "Alerting");
  if (kind === "canceled") url.searchParams.set("previous", "Pending");
  return url;
}

async function fetchJson(
  url: URL,
  token: string,
  maximumBytes: number,
): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
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

export async function GET(): Promise<NextResponse> {
  const to = Math.floor(Date.now() / 1_000);
  const from = to - PEG_ALERTS_WINDOW_SECONDS;
  // Fetch one extra display window so alerts that start before `from` retain
  // their Pending wait and fired evidence. Emitted rows remain within `from`.
  const contextFrom = from - PEG_ALERTS_CONTEXT_LEAD_IN_SECONDS;
  const token = process.env.GRAFANA_QUERY_TOKEN?.trim();
  const raisedUrl = stateHistoryUrl(
    process.env.GRAFANA_QUERY_URL,
    contextFrom,
    to,
    "raised",
  );
  const clearedUrl = stateHistoryUrl(
    process.env.GRAFANA_QUERY_URL,
    contextFrom,
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
    return grafanaErrorResponse("Peg alert history is not configured", 503);
  const pendingUrl = stateHistoryUrl(
    process.env.GRAFANA_QUERY_URL,
    contextFrom,
    to,
    "pending",
  );
  const canceledUrl = stateHistoryUrl(
    process.env.GRAFANA_QUERY_URL,
    contextFrom,
    to,
    "canceled",
  );
  if (pendingUrl === null || canceledUrl === null)
    return grafanaErrorResponse("Peg alert history is not configured", 503);

  try {
    const [pendingRaw, raisedRaw, clearedRaw, canceledRaw] = await Promise.all([
      fetchJson(pendingUrl, token, PEG_ALERTS_MAX_STATE_RESPONSE_BYTES),
      fetchJson(raisedUrl, token, PEG_ALERTS_MAX_STATE_RESPONSE_BYTES),
      fetchJson(clearedUrl, token, PEG_ALERTS_MAX_STATE_RESPONSE_BYTES),
      fetchJson(canceledUrl, token, PEG_ALERTS_MAX_STATE_RESPONSE_BYTES),
    ]);
    const transitions = [
      ...parseStateTransitions(pendingRaw, contextFrom, to),
      ...parseStateTransitions(raisedRaw, contextFrom, to),
      ...parseStateTransitions(clearedRaw, contextFrom, to),
      ...parseStateTransitions(canceledRaw, contextFrom, to),
    ];
    const events = combinePegAlertEvents(
      transitions,
      PEG_ALERTS_MAX_EVENTS,
      from,
    );
    const response: PegAlertsResponse = { from, to, events };
    return NextResponse.json(response, { headers: GRAFANA_NO_STORE_HEADERS });
  } catch (error) {
    if (isGrafanaTimeout(error))
      return grafanaErrorResponse("Peg alert history timed out", 504);
    return grafanaErrorResponse(
      "Peg alert history upstream response is invalid",
      502,
    );
  }
}
