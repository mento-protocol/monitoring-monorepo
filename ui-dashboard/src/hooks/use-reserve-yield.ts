"use client";

import useSWR from "swr";
import { fetchJsonOrThrow } from "@/lib/fetch-json";
import type { ReserveYieldResponse } from "@/lib/reserve-yield";
import { SWR_KEY_RESERVE_YIELD } from "@/lib/swr-keys";

const RESERVE_YIELD_REFRESH_MS = 5 * 60_000;

export type ReserveYieldResult = {
  data: ReserveYieldResponse | null;
  isLoading: boolean;
  hasError: boolean;
};

function fetchReserveYield(): Promise<ReserveYieldResponse> {
  return fetchJsonOrThrow<ReserveYieldResponse>(
    "/api/reserve-yield",
    "Reserve yield",
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
      onErrorRetry: (_err, _key, _config, revalidate, { retryCount }) => {
        if (
          typeof document !== "undefined" &&
          document.visibilityState === "hidden"
        ) {
          return;
        }
        if (retryCount >= 5) return;
        setTimeout(
          () => {
            void revalidate({ retryCount });
          },
          Math.min(1_000 * 2 ** retryCount, 30_000),
        );
      },
    },
  );

  return {
    data: data ?? null,
    isLoading,
    hasError:
      error !== undefined ||
      (data?.holdingsError ?? null) !== null ||
      (data?.rateError ?? null) !== null,
  };
}
