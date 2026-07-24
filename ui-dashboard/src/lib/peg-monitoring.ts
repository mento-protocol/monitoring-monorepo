import type { PegMonitoringResponse } from "@/lib/peg-monitoring-schema";

export const PEG_MONITORING_REFRESH_MS = 30_000;
export const PEG_MONITORING_STALE_AFTER_MS = 90_000;
const MAX_FUTURE_CLOCK_SKEW_MS = 60_000;
export const PEG_GRAFANA_ALERTS_URL =
  "https://clabsmento.grafana.net/alerting/list?search=Peg%20Monitoring";
export type {
  PegMonitoringResponse,
  PegAssetPackage,
  PegMonitor,
  PegSource,
} from "@/lib/peg-monitoring-schema";

export type PegMonitoringViewState =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "current"; data: PegMonitoringResponse; ageMs: number }
  | {
      kind: "stale";
      data: PegMonitoringResponse;
      ageMs: number;
      reason: "age" | "clock-skew" | "refresh-error";
    };

export function classifyPegMonitoringState(input: {
  data: PegMonitoringResponse | null;
  hasError: boolean;
  isLoading: boolean;
  nowMs: number;
}): PegMonitoringViewState {
  if (input.data === null)
    return input.hasError || !input.isLoading
      ? { kind: "unavailable" }
      : { kind: "loading" };
  const producedAtMs = input.data.producedAt * 1_000;
  const ageMs = Math.max(0, input.nowMs - producedAtMs);
  if (input.hasError)
    return { kind: "stale", data: input.data, ageMs, reason: "refresh-error" };
  if (producedAtMs > input.nowMs + MAX_FUTURE_CLOCK_SKEW_MS)
    return { kind: "stale", data: input.data, ageMs, reason: "clock-skew" };
  return ageMs > PEG_MONITORING_STALE_AFTER_MS
    ? { kind: "stale", data: input.data, ageMs, reason: "age" }
    : { kind: "current", data: input.data, ageMs };
}
