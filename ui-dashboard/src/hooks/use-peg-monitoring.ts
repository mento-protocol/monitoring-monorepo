"use client";

import { useState } from "react";
import useSWR from "swr";
import { fetchJsonOrThrow } from "@/lib/fetch-json";
import { rateLimitAwareRetry } from "@/lib/gql-retry";
import {
  PEG_MONITORING_REFRESH_MS,
  type PegMonitoringResponse,
} from "@/lib/peg-monitoring";
import { SWR_KEY_PEG_MONITORING } from "@/lib/swr-keys";

export type PegMonitoringResult = {
  data: PegMonitoringResponse | null;
  isLoading: boolean;
  hasError: boolean;
};

const REFRESH_FAILURES_BEFORE_STALE = 2;

// The route's own upstream call budgets PEG_MONITORING_UPSTREAM_TIMEOUT_MS
// (10s, see lib/peg-monitoring-upstream.ts) for its leg alone. This client
// deadline has to cover that same leg plus round-trip and server-side
// parsing, so it carries a margin above it rather than matching it exactly
// — otherwise the browser aborts before the server's own timeout can fire
// and return a proper error. Still well under the 30s refresh interval.
function fetchPegMonitoring(): Promise<PegMonitoringResponse> {
  return fetchJsonOrThrow<PegMonitoringResponse>(
    "/api/peg-monitoring",
    "Peg monitoring",
    { timeoutMs: 15_000 },
  );
}

export function usePegMonitoring(): PegMonitoringResult {
  const [consecutiveRefreshFailures, setConsecutiveRefreshFailures] =
    useState(0);
  const { data, error, isLoading } = useSWR(
    SWR_KEY_PEG_MONITORING,
    fetchPegMonitoring,
    {
      refreshInterval: PEG_MONITORING_REFRESH_MS,
      // This is one same-origin board read, not a Hasura query fan-out. Refresh
      // on resume so a hidden tab does not retain an old package until the next
      // interval, and cap focus refreshes at the normal board cadence.
      revalidateOnFocus: true,
      focusThrottleInterval: PEG_MONITORING_REFRESH_MS,
      revalidateOnReconnect: false,
      refreshWhenHidden: false,
      onSuccess() {
        setConsecutiveRefreshFailures(0);
      },
      onErrorRetry(error, key, config, revalidate, options) {
        setConsecutiveRefreshFailures((failures) =>
          Math.min(failures + 1, REFRESH_FAILURES_BEFORE_STALE),
        );
        rateLimitAwareRetry(error, key, config, revalidate, options);
      },
    },
  );
  return {
    data: data ?? null,
    isLoading,
    hasError:
      error !== undefined &&
      consecutiveRefreshFailures >= REFRESH_FAILURES_BEFORE_STALE,
  };
}
