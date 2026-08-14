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

function fetchPegMonitoring(): Promise<PegMonitoringResponse> {
  return fetchJsonOrThrow<PegMonitoringResponse>(
    "/api/peg-monitoring",
    "Peg monitoring",
    { timeoutMs: 10_000 },
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
      revalidateOnFocus: false,
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
