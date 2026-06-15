"use client";

import useSWR from "swr";
import { GraphQLClient } from "graphql-request";
import { NETWORKS } from "@/lib/networks";
import { SUSDS_YIELD_DAILY_SNAPSHOTS } from "@/lib/queries";
import { REQUEST_TIMEOUT_MS } from "@/lib/fetch-all-networks";
import { SHARED_QUERY_SWR_CONFIG } from "@/lib/gql-retry";
import { SWR_KEY_RESERVE_YIELD_HISTORY } from "@/lib/swr-keys";
import type { SusdsYieldDailySnapshotRow } from "@/lib/canonical-revenue";

export type ReserveYieldHistoryResult = {
  rows: SusdsYieldDailySnapshotRow[];
  isLoading: boolean;
  hasError: boolean;
  unavailable: boolean;
  truncated: boolean;
};

type SusdsYieldDailySnapshotsResponse = {
  SusdsYieldDailySnapshot: SusdsYieldDailySnapshotRow[];
};

type SnapshotPageResult = {
  rows: SusdsYieldDailySnapshotRow[];
  unavailable: boolean;
  truncated: boolean;
};

const ETHEREUM_CHAIN_ID = 1;
const HISTORY_PAGE_SIZE = 1000;
const HISTORY_MAX_PAGES = 20;

function reserveYieldHistoryHasuraUrl(): string {
  // Production Celo and Monad entries share the same multichain Envio Hasura
  // endpoint; the Monad fallback is an endpoint fallback, not a chain switch.
  const url =
    NETWORKS["celo-mainnet"].hasuraUrl || NETWORKS["monad-mainnet"].hasuraUrl;
  if (!url) {
    throw new Error("Hasura URL is not configured for reserve yield history");
  }
  return url;
}

async function requestWithTimeout<T>(
  client: GraphQLClient,
  variables: Record<string, unknown>,
  signal: AbortSignal,
): Promise<T> {
  return client.request<T>({
    document: SUSDS_YIELD_DAILY_SNAPSHOTS,
    variables,
    signal,
  });
}

function isMissingSusdsYieldDailySnapshotEntity(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("SusdsYieldDailySnapshot") &&
    (message.includes("not found in type") ||
      message.includes("Cannot query field"))
  );
}

async function fetchReserveYieldHistory(): Promise<SnapshotPageResult> {
  const client = new GraphQLClient(reserveYieldHistoryHasuraUrl());
  const rows: SusdsYieldDailySnapshotRow[] = [];
  const seen = new Set<string>();
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

  try {
    return await fetchReserveYieldHistoryPage(client, signal, rows, seen, 0);
  } catch (err) {
    if (isMissingSusdsYieldDailySnapshotEntity(err)) {
      return { rows: [], unavailable: true, truncated: false };
    }
    throw err;
  }
}

async function fetchReserveYieldHistoryPage(
  client: GraphQLClient,
  signal: AbortSignal,
  rows: SusdsYieldDailySnapshotRow[],
  seen: Set<string>,
  page: number,
): Promise<SnapshotPageResult> {
  if (page >= HISTORY_MAX_PAGES) {
    return { rows, unavailable: false, truncated: true };
  }

  const response = await requestWithTimeout<SusdsYieldDailySnapshotsResponse>(
    client,
    {
      chainId: ETHEREUM_CHAIN_ID,
      limit: HISTORY_PAGE_SIZE,
      offset: page * HISTORY_PAGE_SIZE,
    },
    signal,
  );
  const pageRows = response.SusdsYieldDailySnapshot ?? [];
  for (const row of pageRows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(row);
  }
  if (pageRows.length < HISTORY_PAGE_SIZE) {
    return { rows, unavailable: false, truncated: false };
  }
  return fetchReserveYieldHistoryPage(client, signal, rows, seen, page + 1);
}

export function useReserveYieldHistory(): ReserveYieldHistoryResult {
  const { data, error, isLoading } = useSWR<SnapshotPageResult>(
    SWR_KEY_RESERVE_YIELD_HISTORY,
    fetchReserveYieldHistory,
    SHARED_QUERY_SWR_CONFIG,
  );
  const hasError = error !== undefined;

  return {
    rows: hasError ? [] : (data?.rows ?? []),
    isLoading,
    hasError,
    unavailable: hasError ? false : (data?.unavailable ?? false),
    truncated: hasError ? false : (data?.truncated ?? false),
  };
}
