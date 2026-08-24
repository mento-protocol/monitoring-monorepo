"use client";

import useSWR from "swr";
import { GraphQLClient } from "@/lib/graphql-fetch";
import { GraphQLSchemaError } from "@/lib/graphql-schema-error";
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
import { isValidStethYieldDailySnapshotRow } from "@/lib/canonical-revenue/steth-snapshot-validation";
import { RESERVE_YIELD_ETHEREUM_CHAIN_ID } from "@/lib/reserve-yield-types";

export type ReserveYieldHistoryResult = {
  rows: ReserveYieldDailySnapshotRow[];
  isLoading: boolean;
  hasError: boolean;
  unavailable: boolean;
  truncated: boolean;
  stethHistoryFailed: boolean;
  hasStethSnapshotSource: boolean;
};

type SnapshotPageResult = {
  rows: ReserveYieldDailySnapshotRow[];
  unavailable: boolean;
  truncated: boolean;
};

type ReserveYieldHistoryFetchResult = SnapshotPageResult & {
  stethHistoryFailed: boolean;
  hasStethSnapshotSource: boolean;
};

type OptionalStethHistoryResult = SnapshotPageResult & {
  failed: boolean;
};

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

function isValidEthereumStethSnapshot(
  value: unknown,
): value is StethYieldDailySnapshotRow {
  return (
    isValidStethYieldDailySnapshotRow(value) &&
    value.chainId === RESERVE_YIELD_ETHEREUM_CHAIN_ID
  );
}

async function fetchReserveYieldHistory(): Promise<ReserveYieldHistoryFetchResult> {
  const client = new GraphQLClient(reserveYieldHistoryHasuraUrl());
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

  try {
    const susds = await fetchSusdsHistory(client, signal);
    const steth = await fetchOptionalStethHistory(client, signal);
    return {
      rows: [...susds.rows, ...steth.rows],
      unavailable: false,
      truncated: susds.truncated || steth.truncated,
      stethHistoryFailed: steth.failed,
      hasStethSnapshotSource: steth.rows.length > 0,
    };
  } catch (err) {
    if (isMissingEntity(err, "SusdsYieldDailySnapshot")) {
      return {
        rows: [],
        unavailable: true,
        truncated: false,
        stethHistoryFailed: false,
        hasStethSnapshotSource: false,
      };
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
): Promise<OptionalStethHistoryResult> {
  try {
    return { ...(await fetchStethHistory(client, signal)), failed: false };
  } catch (err) {
    if (err instanceof GraphQLSchemaError) throw err;
    // Keep already-fetched sUSDS rows and report the stETH failure separately.
    return { rows: [], unavailable: false, truncated: false, failed: true };
  }
}

async function fetchStethHistory(
  client: GraphQLClient,
  signal: AbortSignal,
): Promise<SnapshotPageResult> {
  return fetchReserveYieldHistoryPage({
    client,
    signal,
    document: STETH_YIELD_DAILY_SNAPSHOTS,
    responseKey: "StethYieldDailySnapshot",
  });
}

type ReserveYieldHistoryResponseKey =
  | "SusdsYieldDailySnapshot"
  | "StethYieldDailySnapshot";

function malformedHistoryRowError(
  responseKey: ReserveYieldHistoryResponseKey,
): GraphQLSchemaError {
  return new GraphQLSchemaError(
    [
      {
        code: "custom",
        path: [responseKey],
        message: "contained a malformed row",
      },
    ],
    responseKey,
  );
}

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
          row.chainId === RESERVE_YIELD_ETHEREUM_CHAIN_ID,
      )
    ) {
      throw malformedHistoryRowError(responseKey);
    }
    return pageRows;
  }
  if (!pageRows.every((row) => isValidEthereumStethSnapshot(row))) {
    throw malformedHistoryRowError(responseKey);
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
      chainId: RESERVE_YIELD_ETHEREUM_CHAIN_ID,
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

function cachedStethHistoryState(
  data: ReserveYieldHistoryFetchResult | undefined,
  hasError: boolean,
): {
  rows: ReserveYieldDailySnapshotRow[];
  failed: boolean;
  hasSource: boolean;
} {
  if (hasError || data === undefined) {
    return { rows: [], failed: false, hasSource: false };
  }
  const hasMalformedRow = data.rows.some(
    (row) => "wallet" in row && !isValidEthereumStethSnapshot(row),
  );
  const rows = data.rows.filter(
    (row) => !("wallet" in row) || isValidEthereumStethSnapshot(row),
  );
  const hasSource = rows.some(
    (row) => "wallet" in row && isValidEthereumStethSnapshot(row),
  );
  return {
    rows,
    failed: data.stethHistoryFailed === true || hasMalformedRow,
    hasSource,
  };
}

export function useReserveYieldHistory(): ReserveYieldHistoryResult {
  const { data, error, isLoading } = useSWR<ReserveYieldHistoryFetchResult>(
    SWR_KEY_RESERVE_YIELD_HISTORY,
    fetchReserveYieldHistory,
    SHARED_QUERY_SWR_CONFIG,
  );
  const hasMalformedCachedSusdsHistory =
    data !== undefined && hasInvalidSusdsYieldDailySnapshotRow(data.rows);
  const hasError = error !== undefined || hasMalformedCachedSusdsHistory;
  const stethHistory = cachedStethHistoryState(data, hasError);

  return {
    rows: stethHistory.rows,
    isLoading,
    hasError,
    unavailable: hasError ? false : (data?.unavailable ?? false),
    truncated: hasError ? false : (data?.truncated ?? false),
    stethHistoryFailed: stethHistory.failed,
    hasStethSnapshotSource: stethHistory.hasSource,
  };
}
