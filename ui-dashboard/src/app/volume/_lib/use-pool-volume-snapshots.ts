"use client";

import { GraphQLClient } from "@/lib/graphql-fetch";
import useSWR from "swr";
import { useNetwork } from "@/components/network-provider";
import { rateLimitAwareRetry } from "@/lib/gql-retry";
import { POOL_DAILY_VOLUME } from "@/lib/queries/volume";
import type { VolumeRangeKey } from "@/lib/volume";
import type { PoolDailyVolumeRow } from "@/lib/volume-pool";

const PAGE_SIZE = 1000;
const MAX_PAGES = 100;
// PoolDailyVolumeSnapshot is a daily rollup — only today's row mutates, so
// sub-minute polling adds Hasura load without adding chart resolution.
const REFRESH_MS = 60_000;
const POLL_TIMEOUT_MS = 8_000;
const POLL_OVERALL_TIMEOUT_MS = 55_000;

type PoolVolumePage = {
  PoolDailyVolumeSnapshot: PoolDailyVolumeRow[];
};

type PoolVolumeResult = {
  rows: PoolDailyVolumeRow[];
  partial: boolean;
  afterTimestamp: number;
};

type PoolVolumeCacheResult = PoolVolumeResult & {
  range: VolumeRangeKey;
};

function finishAfterDeadline(
  rows: readonly PoolDailyVolumeRow[],
  afterTimestamp: number,
): PoolVolumeResult {
  if (rows.length === 0) {
    throw new Error("Pool volume snapshot pagination exceeded its budget");
  }
  return { rows: [...rows], partial: true, afterTimestamp };
}

export async function fetchPoolVolumeSnapshots(
  hasuraUrl: string,
  afterTimestamp: number,
): Promise<PoolVolumeResult> {
  const client = new GraphQLClient(hasuraUrl);
  const rows: PoolDailyVolumeRow[] = [];
  const seen = new Set<string>();
  const deadlineMs = Date.now() + POLL_OVERALL_TIMEOUT_MS;

  // Sequential pagination with a fresh per-page abort budget (matches
  // fetchPaginatedRows in src/lib/network-fetcher/fetch.ts), plus an overall
  // budget below the 60s refresh interval so multi-page ranges cannot stack
  // pageCount × 8s worth of overlapping polls.
  for (let page = 0; page <= MAX_PAGES; page += 1) {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      return finishAfterDeadline(rows, afterTimestamp);
    }

    let batch: PoolDailyVolumeRow[];
    try {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      const result = await client.request<PoolVolumePage>({
        document: POOL_DAILY_VOLUME,
        variables: {
          afterTimestamp,
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        },
        signal: AbortSignal.timeout(Math.min(POLL_TIMEOUT_MS, remainingMs)),
      });
      batch = result.PoolDailyVolumeSnapshot ?? [];
    } catch (err) {
      if (rows.length === 0) throw err;
      return { rows, partial: true, afterTimestamp };
    }

    if (page === MAX_PAGES) {
      return { rows, partial: batch.length > 0, afterTimestamp };
    }

    for (const row of batch) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }
    if (batch.length < PAGE_SIZE)
      return { rows, partial: false, afterTimestamp };
  }

  throw new Error("unreachable pool-volume pagination state");
}

export function usePoolVolumeSnapshots({
  enabled,
  afterTimestamp,
  range,
}: {
  enabled: boolean;
  afterTimestamp: number;
  range: VolumeRangeKey;
}): {
  rows: PoolDailyVolumeRow[];
  isLoading: boolean;
  error: unknown;
  partial: boolean;
  /** Cutoff that produced `rows`. During `keepPreviousData` revalidation this
   * remains the prior cutoff, so consumers never clip/zero-fill old rows as if
   * they covered the newly requested window. */
  dataAfterTimestamp: number | undefined;
  dataRange: VolumeRangeKey | undefined;
  hasData: boolean;
} {
  const { network } = useNetwork();
  const missingUrlError =
    enabled && !network.hasuraUrl
      ? new Error(
          `Hasura URL not configured for "${network.label}". ` +
            `Get the GraphQL endpoint from the Envio dashboard and set it in .env.local.`,
        )
      : null;
  const { data, error, isLoading } = useSWR<PoolVolumeCacheResult>(
    enabled && network.hasuraUrl
      ? [
          "volume-pool-snapshots",
          network.id,
          network.hasuraUrl,
          range,
          afterTimestamp,
        ]
      : null,
    async () => ({
      ...(await fetchPoolVolumeSnapshots(network.hasuraUrl, afterTimestamp)),
      range,
    }),
    {
      refreshInterval: REFRESH_MS,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      refreshWhenHidden: false,
      onErrorRetry: rateLimitAwareRetry,
      keepPreviousData: true,
    },
  );

  return {
    rows: data?.rows ?? [],
    isLoading: missingUrlError ? false : isLoading,
    error: missingUrlError ?? error,
    partial: data?.partial ?? false,
    dataAfterTimestamp: data?.afterTimestamp,
    dataRange: data?.range,
    hasData: data !== undefined,
  };
}
