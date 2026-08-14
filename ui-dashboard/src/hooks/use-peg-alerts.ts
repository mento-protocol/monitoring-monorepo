"use client";

import useSWR from "swr";
import { fetchJsonOrThrow } from "@/lib/fetch-json";
import { rateLimitAwareRetry } from "@/lib/gql-retry";
import {
  PEG_ALERTS_REFRESH_MS,
  type PegAlertsResponse,
} from "@/lib/peg-alerts";
import { SWR_KEY_PEG_ALERTS } from "@/lib/swr-keys";

export type PegAlertsResult = {
  data: PegAlertsResponse | null;
  isLoading: boolean;
  hasError: boolean;
};

function fetchPegAlerts(): Promise<PegAlertsResponse> {
  return fetchJsonOrThrow<PegAlertsResponse>(
    "/api/peg-monitoring/alerts",
    "Peg alert history",
    { timeoutMs: 10_000 },
  );
}

export function usePegAlerts(enabled: boolean): PegAlertsResult {
  const { data, error, isLoading } = useSWR<PegAlertsResponse>(
    enabled ? SWR_KEY_PEG_ALERTS : null,
    fetchPegAlerts,
    {
      refreshInterval: PEG_ALERTS_REFRESH_MS,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      refreshWhenHidden: false,
      onErrorRetry: rateLimitAwareRetry,
    },
  );
  return {
    data: data ?? null,
    isLoading: enabled && isLoading,
    hasError: enabled && error !== undefined,
  };
}
