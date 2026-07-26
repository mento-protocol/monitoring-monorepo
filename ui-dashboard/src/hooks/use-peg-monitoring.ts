"use client";

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

function fetchPegMonitoring(): Promise<PegMonitoringResponse> {
  return fetchJsonOrThrow<PegMonitoringResponse>(
    "/api/peg-monitoring",
    "Peg monitoring",
    { timeoutMs: 10_000 },
  );
}

export function usePegMonitoring(): PegMonitoringResult {
  const { data, error, isLoading } = useSWR(
    SWR_KEY_PEG_MONITORING,
    fetchPegMonitoring,
    {
      refreshInterval: PEG_MONITORING_REFRESH_MS,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      refreshWhenHidden: false,
      onErrorRetry: rateLimitAwareRetry,
    },
  );
  return { data: data ?? null, isLoading, hasError: error !== undefined };
}
