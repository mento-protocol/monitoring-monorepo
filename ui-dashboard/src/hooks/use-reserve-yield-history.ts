"use client";

import useSWR from "swr";
import { GraphQLClient } from "@/lib/graphql-fetch";
import { NETWORKS } from "@/lib/networks";
import {
  STETH_YIELD_DAILY_SNAPSHOTS,
  SUSDS_YIELD_DAILY_SNAPSHOTS,
} from "@/lib/queries";
import { REQUEST_TIMEOUT_MS } from "@/lib/fetch-all-networks";
import { SHARED_QUERY_SWR_CONFIG } from "@/lib/gql-retry";
import { SWR_KEY_RESERVE_YIELD_HISTORY } from "@/lib/swr-keys";
import type {
  ReserveYieldDailySnapshotRow,
  StethYieldDailySnapshotRow,
} from "@/lib/canonical-revenue";
import {
  hasInvalidSusdsYieldDailySnapshotRow,
  isValidSusdsYieldDailySnapshotRow,
} from "@/lib/canonical-revenue/reserve-snapshot-validation";

export type ReserveYieldHistoryResult = {
  rows: ReserveYieldDailySnapshotRow[];
  isLoading: boolean;
  hasError: boolean;
  unavailable: boolean;
  truncated: boolean;
};

type SnapshotPageResult = {
  rows: ReserveYieldDailySnapshotRow[];
  unavailable: boolean;
  truncated: boolean;
};

const ETHEREUM_CHAIN_ID = 1;
const HISTORY_PAGE_SIZE = 1000;
const HISTORY_MAX_PAGES = 20;

function reserveYieldHistoryHasuraUrl(): string {
  const url = NETWORKS["celo-mainnet"].hasuraUrl;
  if (!url) {
    throw new Error("Hasura URL is not configured for reserve yield history");
  }
  return url;
}

async function requestWithTimeout<T>(
  client: GraphQLClient,
  document: string,
  variables: Record<string, unknown>,
  signal: AbortSignal,
): Promise<T> {
  return client.request<T>({
    document,
    variables,
    signal,
  });
}

function isMissingEntity(err: unknown, entity: string): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes(entity) &&
    (message.includes("not found in type") ||
      message.includes("Cannot query field"))
  );
}

async function fetchReserveYieldHistory(): Promise<SnapshotPageResult> {
  const client = new GraphQLClient(reserveYieldHistoryHasuraUrl());
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

  try {
    const susds = await fetchSusdsHistory(client, signal);
    const steth = await fetchOptionalStethHistory(client, signal);
    return {
      rows: [...susds.rows, ...steth.rows],
      unavailable: false,
      truncated: susds.truncated || steth.truncated,
    };
  } catch (err) {
    if (isMissingEntity(err, "SusdsYieldDailySnapshot")) {
      return { rows: [], unavailable: true, truncated: false };
    }
    throw err;
  }
}

async function fetchSusdsHistory(
  client: GraphQLClient,
  signal: AbortSignal,
): Promise<SnapshotPageResult> {
  return fetchReserveYieldHistoryPage({
    client,
    signal,
    document: SUSDS_YIELD_DAILY_SNAPSHOTS,
    responseKey: "SusdsYieldDailySnapshot",
  });
}

async function fetchOptionalStethHistory(
  client: GraphQLClient,
  signal: AbortSignal,
): Promise<SnapshotPageResult> {
  try {
    return await fetchStethHistory(client, signal);
  } catch {
    // stETH history is optional during rollout; keep already-fetched sUSDS rows.
    return { rows: [], unavailable: false, truncated: false };
  }
}

async function fetchStethHistory(
  client: GraphQLClient,
  signal: AbortSignal,
): Promise<SnapshotPageResult> {
  try {
    return await fetchReserveYieldHistoryPage({
      client,
      signal,
      document: STETH_YIELD_DAILY_SNAPSHOTS,
      responseKey: "StethYieldDailySnapshot",
    });
  } catch (err) {
    if (isMissingEntity(err, "StethYieldDailySnapshot")) {
      return { rows: [], unavailable: false, truncated: false };
    }
    throw err;
  }
}

type ReserveYieldHistoryResponseKey =
  | "SusdsYieldDailySnapshot"
  | "StethYieldDailySnapshot";

function pageRowsForResponse(
  response: unknown,
  responseKey: ReserveYieldHistoryResponseKey,
): ReserveYieldDailySnapshotRow[] {
  if (typeof response !== "object" || response === null) {
    throw new Error("Reserve yield history response was not an object");
  }
  const pageRows = (response as Record<string, unknown>)[responseKey];
  if (!Array.isArray(pageRows)) {
    throw new Error(`${responseKey} was not an array`);
  }
  if (responseKey === "SusdsYieldDailySnapshot") {
    if (
      !pageRows.every(
        (row) =>
          isValidSusdsYieldDailySnapshotRow(row) &&
          row.chainId === ETHEREUM_CHAIN_ID,
      )
    ) {
      throw new Error("SusdsYieldDailySnapshot contained a malformed row");
    }
    return pageRows;
  }
  return pageRows as StethYieldDailySnapshotRow[];
}

async function fetchReserveYieldHistoryPage({
  client,
  signal,
  document,
  responseKey,
  rows = [],
  seen = new Set<string>(),
  page = 0,
}: {
  client: GraphQLClient;
  signal: AbortSignal;
  document: string;
  responseKey: ReserveYieldHistoryResponseKey;
  rows?: ReserveYieldDailySnapshotRow[];
  seen?: Set<string>;
  page?: number;
}): Promise<SnapshotPageResult> {
  if (page >= HISTORY_MAX_PAGES) {
    return { rows, unavailable: false, truncated: true };
  }

  const response = await requestWithTimeout<unknown>(
    client,
    document,
    {
      chainId: ETHEREUM_CHAIN_ID,
      limit: HISTORY_PAGE_SIZE,
      offset: page * HISTORY_PAGE_SIZE,
    },
    signal,
  );
  const pageRows = pageRowsForResponse(response, responseKey) ?? [];
  for (const row of pageRows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(row);
  }
  if (pageRows.length < HISTORY_PAGE_SIZE) {
    return { rows, unavailable: false, truncated: false };
  }
  return fetchReserveYieldHistoryPage({
    client,
    signal,
    document,
    responseKey,
    rows,
    seen,
    page: page + 1,
  });
}

export function useReserveYieldHistory(): ReserveYieldHistoryResult {
  const { data, error, isLoading } = useSWR<SnapshotPageResult>(
    SWR_KEY_RESERVE_YIELD_HISTORY,
    fetchReserveYieldHistory,
    SHARED_QUERY_SWR_CONFIG,
  );
  const hasMalformedCachedSusdsHistory =
    data !== undefined && hasInvalidSusdsYieldDailySnapshotRow(data.rows);
  const hasError = error !== undefined || hasMalformedCachedSusdsHistory;

  return {
    rows: hasError ? [] : (data?.rows ?? []),
    isLoading,
    hasError,
    unavailable: hasError ? false : (data?.unavailable ?? false),
    truncated: hasError ? false : (data?.truncated ?? false),
  };
}
