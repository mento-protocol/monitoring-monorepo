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
  // Ask for one sentinel row beyond the parser cap so a full page proves the
  // seven-day result was truncated instead of silently losing an incident.
  url.searchParams.set("limit", String(PEG_ALERTS_MAX_STATE_ROWS + 1));
  url.searchParams.set("labels_service", "peg-monitoring");
  url.searchParams.set("current", kind === "raised" ? "Alerting" : "Normal");
  if (kind === "cleared") url.searchParams.set("previous", "Alerting");
  return url;
}

function errorStateHistoryUrl(url: URL): URL | null {
  const current = url.searchParams.get("current");
  const previous = url.searchParams.get("previous");
  const errorUrl = new URL(url);
  if (current === "Alerting" && previous === null) {
    errorUrl.searchParams.set("current", "Error");
    return errorUrl;
  }
  if (current === "Normal" && previous === "Alerting") {
    errorUrl.searchParams.delete("current");
    errorUrl.searchParams.set("previous", "Error");
    return errorUrl;
  }
  return null;
}

async function fetchJson(
  url: URL,
  token: string,
  maximumBytes: number,
): Promise<unknown[]> {
  const errorUrl = errorStateHistoryUrl(url);
  const urls = errorUrl === null ? [url] : [url, errorUrl];
  return Promise.all(
    urls.map(async (requestUrl) => {
      const response = await fetch(requestUrl, {
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
    }),
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
    return grafanaErrorResponse("Peg alert history is not configured", 503);
  try {
    const [raisedRaw, clearedRaw] = await Promise.all([
      fetchJson(raisedUrl, token, PEG_ALERTS_MAX_STATE_RESPONSE_BYTES),
      fetchJson(clearedUrl, token, PEG_ALERTS_MAX_STATE_RESPONSE_BYTES),
    ]);
    const transitions = [
      ...parseStateTransitions(raisedRaw, from, to),
      ...parseStateTransitions(clearedRaw, from, to),
    ];
    const events = combinePegAlertEvents(transitions, PEG_ALERTS_MAX_EVENTS);
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
