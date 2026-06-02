"use client";

import useSWR from "swr";
import { GraphQLClient } from "graphql-request";
import {
  NETWORKS,
  NETWORK_IDS,
  isConfiguredNetworkId,
  type Network,
} from "@/lib/networks";
import { SHARED_QUERY_SWR_CONFIG } from "@/lib/gql-retry";
import {
  CDP_BORROWING_REVENUE_BRACKETS,
  CDP_BORROWING_REVENUE_MARKETS,
  ORACLE_RATES,
} from "@/lib/queries";
import { REQUEST_TIMEOUT_MS } from "@/lib/fetch-all-networks";
import {
  aggregateCdpBorrowingRevenue,
  type CdpBorrowingRevenueBracket,
  type CdpBorrowingRevenueCollateral,
  type CdpBorrowingRevenueInstance,
  type CdpBorrowingRevenueSummary,
} from "@/lib/cdp-borrowing-revenue";
import {
  buildOracleRateMap,
  type OracleRatePool,
  type OracleRateMap,
} from "@/lib/tokens";
import { SWR_KEY_CDP_BORROWING_REVENUE } from "@/lib/swr-keys";

type MarketsResponse = {
  LiquityCollateral: CdpBorrowingRevenueCollateral[];
  LiquityInstance: CdpBorrowingRevenueInstance[];
};

type BracketsResponse = {
  InterestRateBracket: CdpBorrowingRevenueBracket[];
};

type BracketPageResult = {
  rows: CdpBorrowingRevenueBracket[];
  truncated: boolean;
};

type NetworkCdpBorrowingRevenue = {
  network: Network;
  summary: CdpBorrowingRevenueSummary | null;
  error: Error | null;
};

export type CdpBorrowingRevenueResult = {
  summary: CdpBorrowingRevenueSummary | null;
  isLoading: boolean;
  hasError: boolean;
};

const EMPTY_SUMMARY: CdpBorrowingRevenueSummary = {
  totalRevenueUSD: 0,
  upfrontFeesUSD: 0,
  accruedInterestUSD: 0,
  marketCount: 0,
  activeInterestBracketCount: 0,
  unpricedSymbols: [],
  bracketsTruncated: false,
};

const BRACKET_PAGE_SIZE = 1000;
const BRACKET_MAX_PAGES = 20;

function mergeSummaries(
  rows: ReadonlyArray<NetworkCdpBorrowingRevenue>,
): CdpBorrowingRevenueSummary | null {
  let sawSummary = false;
  const merged: CdpBorrowingRevenueSummary = { ...EMPTY_SUMMARY };
  const unpricedSymbols = new Set<string>();

  for (const row of rows) {
    if (row.summary === null) continue;
    sawSummary = true;
    merged.totalRevenueUSD += row.summary.totalRevenueUSD;
    merged.upfrontFeesUSD += row.summary.upfrontFeesUSD;
    merged.accruedInterestUSD += row.summary.accruedInterestUSD;
    merged.marketCount += row.summary.marketCount;
    merged.activeInterestBracketCount += row.summary.activeInterestBracketCount;
    merged.bracketsTruncated =
      merged.bracketsTruncated || row.summary.bracketsTruncated;
    for (const symbol of row.summary.unpricedSymbols) {
      unpricedSymbols.add(symbol);
    }
  }

  if (!sawSummary) return null;
  merged.unpricedSymbols = [...unpricedSymbols].sort();
  return merged;
}

async function requestWithTimeout<T>(
  client: GraphQLClient,
  document: string,
  variables: Record<string, unknown>,
  signal: AbortSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS),
): Promise<T> {
  return client.request<T>({
    document,
    variables,
    signal,
  });
}

async function fetchAllBracketPages(
  client: GraphQLClient,
  collateralIds: string[],
): Promise<BracketPageResult> {
  const rows: CdpBorrowingRevenueBracket[] = [];
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  for (let page = 0; page < BRACKET_MAX_PAGES; page++) {
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Bracket pagination is intentionally sequential so we can stop after the first short page.
    const response = await requestWithTimeout<BracketsResponse>(
      client,
      CDP_BORROWING_REVENUE_BRACKETS,
      {
        collateralIds,
        limit: BRACKET_PAGE_SIZE,
        offset: page * BRACKET_PAGE_SIZE,
      },
      signal,
    );
    const pageRows = response.InterestRateBracket ?? [];
    rows.push(...pageRows);
    if (pageRows.length < BRACKET_PAGE_SIZE) {
      return { rows, truncated: false };
    }
  }

  return { rows, truncated: true };
}

async function fetchRevenueForNetwork(
  network: Network,
): Promise<NetworkCdpBorrowingRevenue> {
  if (!network.hasuraUrl) {
    return {
      network,
      summary: null,
      error: new Error(`Hasura URL not configured for "${network.label}"`),
    };
  }

  try {
    const client = new GraphQLClient(network.hasuraUrl);
    const marketsResponse = await requestWithTimeout<MarketsResponse>(
      client,
      CDP_BORROWING_REVENUE_MARKETS,
      { chainId: network.chainId },
    );
    const collaterals = marketsResponse.LiquityCollateral ?? [];
    const instances = marketsResponse.LiquityInstance ?? [];
    if (collaterals.length === 0) {
      return {
        network,
        summary: aggregateCdpBorrowingRevenue({
          collaterals,
          instances,
          brackets: [],
          rates: new Map(),
        }),
        error: null,
      };
    }

    const [ratesResponse, bracketPages] = await Promise.all([
      requestWithTimeout<{ Pool: OracleRatePool[] }>(client, ORACLE_RATES, {
        chainId: network.chainId,
      }),
      fetchAllBracketPages(
        client,
        collaterals.map((c) => c.id),
      ),
    ]);
    const rates: OracleRateMap = buildOracleRateMap(
      ratesResponse.Pool ?? [],
      network,
    );
    return {
      network,
      summary: aggregateCdpBorrowingRevenue({
        collaterals,
        instances,
        brackets: bracketPages.rows,
        rates,
        bracketsTruncated: bracketPages.truncated,
      }),
      error: null,
    };
  } catch (err) {
    return {
      network,
      summary: null,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

async function fetchAllCdpBorrowingRevenue(): Promise<
  NetworkCdpBorrowingRevenue[]
> {
  const ids = NETWORK_IDS.filter(isConfiguredNetworkId);
  return Promise.all(ids.map((id) => fetchRevenueForNetwork(NETWORKS[id])));
}

export function useCdpBorrowingRevenue(): CdpBorrowingRevenueResult {
  const { data, error, isLoading } = useSWR<NetworkCdpBorrowingRevenue[]>(
    SWR_KEY_CDP_BORROWING_REVENUE,
    fetchAllCdpBorrowingRevenue,
    SHARED_QUERY_SWR_CONFIG,
  );
  const rows = data ?? [];

  return {
    summary:
      data === undefined ? null : (mergeSummaries(rows) ?? EMPTY_SUMMARY),
    isLoading,
    hasError: error !== undefined || rows.some((row) => row.error !== null),
  };
}
