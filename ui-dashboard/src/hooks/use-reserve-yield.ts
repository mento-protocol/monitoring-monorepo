"use client";

import useSWR from "swr";
import { fetchJsonOrThrow } from "@/lib/fetch-json";
import type { ReserveYieldResponse } from "@/lib/reserve-yield";
import { SWR_KEY_RESERVE_YIELD } from "@/lib/swr-keys";
import { rateLimitAwareRetry } from "@/lib/gql-retry";
import { hasUnindexedSusdsHolding as holdingsHaveUnindexedSusdsSource } from "@/lib/reserve-yield-susds-coverage";

const RESERVE_YIELD_REFRESH_MS = 5 * 60_000;

export type ReserveYieldResult = {
  data: ReserveYieldResponse | null;
  isLoading: boolean;
  hasError: boolean;
  reserveCurrentHoldingsClassificationFailed: boolean;
  hasUnindexedSusdsHolding: boolean;
};

function fetchReserveYield(): Promise<ReserveYieldResponse> {
  return fetchJsonOrThrow<ReserveYieldResponse>(
    "/api/reserve-yield",
    "Reserve yield",
  );
}

function responseHasUnindexedSusdsHolding(
  data: ReserveYieldResponse | undefined,
): boolean {
  if (data === undefined) return false;
  if (typeof data.hasUnindexedSusdsHolding === "boolean") {
    return data.hasUnindexedSusdsHolding;
  }
  return (
    Array.isArray(data.holdings) &&
    holdingsHaveUnindexedSusdsSource(data.holdings)
  );
}

export function useReserveYield(): ReserveYieldResult {
  const { data, error, isLoading } = useSWR<ReserveYieldResponse>(
    SWR_KEY_RESERVE_YIELD,
    fetchReserveYield,
    {
      refreshInterval: RESERVE_YIELD_REFRESH_MS,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      refreshWhenHidden: false,
      errorRetryCount: 5,
      onErrorRetry: rateLimitAwareRetry,
    },
  );

  return {
    data: data ?? null,
    isLoading,
    reserveCurrentHoldingsClassificationFailed:
      error !== undefined ||
      (data !== undefined &&
        data.reserveCurrentHoldingsClassificationFailed !== false),
    hasUnindexedSusdsHolding: responseHasUnindexedSusdsHolding(data),
    hasError:
      error !== undefined ||
      (data?.holdingsError ?? null) !== null ||
      (data?.rateError ?? null) !== null ||
      (data?.earnedYieldError ?? null) !== null,
  };
}
