import type { PegMonitoringResponse } from "@/lib/peg-monitoring-schema";

export const PEG_MONITORING_REFRESH_MS = 30_000;
export const PEG_MONITORING_STALE_AFTER_MS = 90_000;
const MAX_FUTURE_CLOCK_SKEW_MS = 60_000;
export const PEG_GRAFANA_ALERTS_URL =
  "https://clabsmento.grafana.net/alerting/history?var-LABELS_FILTER=service%3Dpeg-monitoring&from=now-7d&to=now&timezone=browser&var-STATE_FILTER_TO=Alerting";
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

/**
 * True when the package was produced under a policy that is no longer the
 * approved active one — either it came from the previous slot, or its policy
 * version has since been superseded. Both the board and its social card feed
 * this into `presentPegMonitoring`, so it lives here rather than being spelled
 * out at each call site: a safety rule with two copies is a safety rule that
 * can disagree with itself.
 */
export function usesPreviousPolicy(data: PegMonitoringResponse): boolean {
  return (
    data.policySlot === "previous" ||
    data.producedPolicyVersion !== data.approvedActivePolicyVersion
  );
}

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
