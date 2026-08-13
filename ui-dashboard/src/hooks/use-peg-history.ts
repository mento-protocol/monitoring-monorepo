"use client";

import useSWR from "swr";
import { fetchJsonOrThrow } from "@/lib/fetch-json";
import { rateLimitAwareRetry } from "@/lib/gql-retry";
import {
  PEG_HISTORY_RANGES,
  type PegHistoryRange,
  type PegHistoryResponse,
} from "@/lib/peg-history";

export type PegHistoryIdentity = {
  asset: string;
  source: string;
  policyVersion: string;
};

export type PegHistoryResult = {
  data: PegHistoryResponse | null;
  isLoading: boolean;
  hasError: boolean;
};

export function pegHistoryUrl(
  identity: PegHistoryIdentity,
  range: PegHistoryRange,
): string {
  const query = new URLSearchParams({ ...identity, range });
  return `/api/peg-monitoring/history?${query.toString()}`;
}

export function usePegHistory(
  identity: PegHistoryIdentity | null,
  range: PegHistoryRange,
): PegHistoryResult {
  const key = identity === null ? null : pegHistoryUrl(identity, range);
  const { data, error, isLoading } = useSWR<PegHistoryResponse>(
    key,
    (url: string) =>
      fetchJsonOrThrow<PegHistoryResponse>(url, "Peg history", {
        timeoutMs: 10_000,
        method: "POST",
      }),
    {
      refreshInterval: PEG_HISTORY_RANGES[range].stepSeconds * 1_000,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      refreshWhenHidden: false,
      onErrorRetry: rateLimitAwareRetry,
    },
  );
  return {
    data: data ?? null,
    isLoading: identity !== null && isLoading,
    hasError: error !== undefined,
  };
}
