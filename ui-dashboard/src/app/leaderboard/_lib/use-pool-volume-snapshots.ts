"use client";

import { GraphQLClient } from "graphql-request";
import useSWR from "swr";
import { useNetwork } from "@/components/network-provider";
import { rateLimitAwareRetry } from "@/lib/gql-retry";
import { POOL_DAILY_VOLUME } from "@/lib/queries/leaderboard";
import type { PoolDailyVolumeRow } from "@/lib/leaderboard-pool";

const PAGE_SIZE = 1000;
const MAX_PAGES = 100;
const REFRESH_MS = 10_000;
const POLL_TIMEOUT_MS = 8_000;

type PoolVolumePage = {
  PoolDailyVolumeSnapshot: PoolDailyVolumeRow[];
};

type PoolVolumeResult = {
  rows: PoolDailyVolumeRow[];
  partial: boolean;
};

export async function fetchPoolVolumeSnapshots(
  hasuraUrl: string,
  afterTimestamp: number,
): Promise<PoolVolumeResult> {
  const client = new GraphQLClient(hasuraUrl);
  const rows: PoolDailyVolumeRow[] = [];
  const seen = new Set<string>();
  const signal = AbortSignal.timeout(POLL_TIMEOUT_MS);

  for (let page = 0; page <= MAX_PAGES; page += 1) {
    let batch: PoolDailyVolumeRow[];
    try {
      const result = await client.request<PoolVolumePage>({
        document: POOL_DAILY_VOLUME,
        variables: {
          afterTimestamp,
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        },
        signal,
      });
      batch = result.PoolDailyVolumeSnapshot ?? [];
    } catch (err) {
      if (rows.length === 0) throw err;
      return { rows, partial: true };
    }

    if (page === MAX_PAGES) {
      return { rows, partial: batch.length > 0 };
    }

    for (const row of batch) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }
    if (batch.length < PAGE_SIZE) return { rows, partial: false };
  }

  throw new Error("unreachable pool-volume pagination state");
}

export function usePoolVolumeSnapshots({
  enabled,
  afterTimestamp,
}: {
  enabled: boolean;
  afterTimestamp: number;
}): {
  rows: PoolDailyVolumeRow[];
  isLoading: boolean;
  error: unknown;
  partial: boolean;
} {
  const { network } = useNetwork();
  const missingUrlError =
    enabled && !network.hasuraUrl
      ? new Error(
          `Hasura URL not configured for "${network.label}". ` +
            `Get the GraphQL endpoint from the Envio dashboard and set it in .env.local.`,
        )
      : null;
  const { data, error, isLoading } = useSWR<PoolVolumeResult>(
    enabled && network.hasuraUrl
      ? [
          "leaderboard-pool-volume-snapshots",
          network.id,
          network.hasuraUrl,
          afterTimestamp,
        ]
      : null,
    () => fetchPoolVolumeSnapshots(network.hasuraUrl, afterTimestamp),
    {
      refreshInterval: REFRESH_MS,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      refreshWhenHidden: false,
      onErrorRetry: rateLimitAwareRetry,
    },
  );

  return {
    rows: data?.rows ?? [],
    isLoading: missingUrlError ? false : isLoading,
    error: missingUrlError ?? error,
    partial: data?.partial ?? false,
  };
}
