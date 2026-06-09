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
  CDP_BORROWING_FEE_EVENTS,
  CDP_BORROWING_REVENUE_DAILY_SNAPSHOTS,
  CDP_BORROWING_REVENUE_BRACKETS,
  CDP_BORROWING_REVENUE_MARKETS,
  ORACLE_RATES,
} from "@/lib/queries";
import { REQUEST_TIMEOUT_MS } from "@/lib/fetch-all-networks";
import {
  aggregateCdpBorrowingRevenue,
  aggregateCdpBorrowingRevenueMarkets,
  buildDailyCdpBorrowingFeeSeries,
  buildDailyCdpBorrowingFeeSeriesFromSnapshots,
  type CdpBorrowingFeeEvent,
  type CdpBorrowingFeeSeriesPoint,
  type CdpBorrowingRevenueBracket,
  type CdpBorrowingRevenueCollateral,
  type CdpBorrowingRevenueDailySnapshot,
  type CdpBorrowingRevenueInstance,
  type CdpBorrowingRevenueMarket,
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

type FeeEventsResponse = {
  TroveOperationEvent: CdpBorrowingFeeEvent[];
};

type DailySnapshotsResponse = {
  LiquityBorrowingRevenueDailySnapshot: CdpBorrowingRevenueDailySnapshot[];
};

type BracketPageResult = {
  rows: CdpBorrowingRevenueBracket[];
  truncated: boolean;
};

type FeeEventPageResult = {
  rows: CdpBorrowingFeeEvent[];
  truncated: boolean;
};

type DailySnapshotPageResult = {
  rows: CdpBorrowingRevenueDailySnapshot[];
  truncated: boolean;
  unavailable: boolean;
};

type NetworkCdpBorrowingRevenue = {
  network: Network;
  summary: CdpBorrowingRevenueSummary | null;
  markets: CdpBorrowingRevenueMarket[];
  dailySeries: CdpBorrowingFeeSeriesPoint[];
  dailySeriesTruncated: boolean;
  dailySeriesApproximate: boolean;
  error: Error | null;
};

export type CdpBorrowingRevenueResult = {
  summary: CdpBorrowingRevenueSummary | null;
  markets: CdpBorrowingRevenueMarket[];
  dailySeries: CdpBorrowingFeeSeriesPoint[];
  dailySeriesTruncated: boolean;
  dailySeriesApproximate: boolean;
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
const FEE_EVENT_PAGE_SIZE = 1000;
const FEE_EVENT_MAX_PAGES = 20;
const DAILY_SNAPSHOT_PAGE_SIZE = 1000;
const DAILY_SNAPSHOT_MAX_PAGES = 20;
const CDP_REVENUE_CHAIN_IDS = new Set([42220]);

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

function mergeMarkets(
  rows: ReadonlyArray<NetworkCdpBorrowingRevenue>,
): CdpBorrowingRevenueMarket[] {
  return rows
    .flatMap((row) => row.markets)
    .sort(
      (a, b) =>
        b.totalRevenueUSD - a.totalRevenueUSD || a.collIndex - b.collIndex,
    );
}

function mergeDailySeries(
  rows: ReadonlyArray<NetworkCdpBorrowingRevenue>,
): CdpBorrowingFeeSeriesPoint[] {
  const buckets = new Map<
    number,
    { upfrontFeesUSD: number; accruedInterestUSD: number }
  >();

  for (const row of rows) {
    for (const point of row.dailySeries) {
      const existing = buckets.get(point.timestamp) ?? {
        upfrontFeesUSD: 0,
        accruedInterestUSD: 0,
      };
      existing.upfrontFeesUSD += point.upfrontFeesUSD;
      existing.accruedInterestUSD += point.accruedInterestUSD;
      buckets.set(point.timestamp, existing);
    }
  }

  return [...buckets.entries()]
    .map(([timestamp, bucket]) => ({
      timestamp,
      upfrontFeesUSD: bucket.upfrontFeesUSD,
      accruedInterestUSD: bucket.accruedInterestUSD,
      totalFeesUSD: bucket.upfrontFeesUSD + bucket.accruedInterestUSD,
    }))
    .sort((a, b) => a.timestamp - b.timestamp);
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

async function fetchAllFeeEventPages(
  client: GraphQLClient,
  chainId: number,
): Promise<FeeEventPageResult> {
  const rows: CdpBorrowingFeeEvent[] = [];
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  for (let page = 0; page < FEE_EVENT_MAX_PAGES; page++) {
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Event pagination is intentionally sequential so we can stop after the first short page.
    const response = await requestWithTimeout<FeeEventsResponse>(
      client,
      CDP_BORROWING_FEE_EVENTS,
      {
        chainId,
        limit: FEE_EVENT_PAGE_SIZE,
        offset: page * FEE_EVENT_PAGE_SIZE,
      },
      signal,
    );
    const pageRows = response.TroveOperationEvent ?? [];
    rows.push(...pageRows);
    if (pageRows.length < FEE_EVENT_PAGE_SIZE) {
      return { rows, truncated: false };
    }
  }

  return { rows, truncated: true };
}

function isMissingDailySnapshotEntityError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("LiquityBorrowingRevenueDailySnapshot");
}

async function fetchAllDailySnapshotPages(
  client: GraphQLClient,
  chainId: number,
): Promise<DailySnapshotPageResult> {
  const rows: CdpBorrowingRevenueDailySnapshot[] = [];
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  try {
    for (let page = 0; page < DAILY_SNAPSHOT_MAX_PAGES; page++) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Snapshot pagination is intentionally sequential so we can stop after the first short page.
      const response = await requestWithTimeout<DailySnapshotsResponse>(
        client,
        CDP_BORROWING_REVENUE_DAILY_SNAPSHOTS,
        {
          chainId,
          limit: DAILY_SNAPSHOT_PAGE_SIZE,
          offset: page * DAILY_SNAPSHOT_PAGE_SIZE,
        },
        signal,
      );
      const pageRows = response.LiquityBorrowingRevenueDailySnapshot ?? [];
      rows.push(...pageRows);
      if (pageRows.length < DAILY_SNAPSHOT_PAGE_SIZE) {
        return { rows, truncated: false, unavailable: false };
      }
    }

    return { rows, truncated: true, unavailable: false };
  } catch (err) {
    if (isMissingDailySnapshotEntityError(err)) {
      return { rows: [], truncated: false, unavailable: true };
    }
    throw err;
  }
}

// The daily series feeds only the time-series chart. A failure fetching it (a
// transient error, or fallback fee-event pagination timing out while production
// is still on the old schema) must NOT blank the summary tiles and market
// tables that the caller's market/bracket/rate queries already produced.
// Degrade to an empty, approximate-flagged series instead of rejecting.
async function resolveDailyBorrowingFeeSeries(
  client: GraphQLClient,
  chainId: number,
  aggregateArgs: {
    collaterals: ReadonlyArray<CdpBorrowingRevenueCollateral>;
    instances: ReadonlyArray<CdpBorrowingRevenueInstance>;
    brackets: ReadonlyArray<CdpBorrowingRevenueBracket>;
    rates: OracleRateMap;
    bracketsTruncated: boolean;
  },
): Promise<{
  points: CdpBorrowingFeeSeriesPoint[];
  truncated: boolean;
  approximate: boolean;
}> {
  try {
    const dailySnapshotPages = await fetchAllDailySnapshotPages(
      client,
      chainId,
    );
    const fallbackFeeEventPages = dailySnapshotPages.unavailable
      ? await fetchAllFeeEventPages(client, chainId)
      : undefined;
    return {
      points:
        fallbackFeeEventPages === undefined
          ? buildDailyCdpBorrowingFeeSeriesFromSnapshots({
              ...aggregateArgs,
              dailySnapshots: dailySnapshotPages.rows,
            })
          : buildDailyCdpBorrowingFeeSeries({
              ...aggregateArgs,
              feeEvents: fallbackFeeEventPages.rows,
            }),
      truncated:
        fallbackFeeEventPages?.truncated ?? dailySnapshotPages.truncated,
      approximate: dailySnapshotPages.unavailable,
    };
  } catch {
    return { points: [], truncated: true, approximate: false };
  }
}

async function fetchRevenueForNetwork(
  network: Network,
): Promise<NetworkCdpBorrowingRevenue> {
  if (!network.hasuraUrl) {
    return {
      network,
      summary: null,
      markets: [],
      dailySeries: [],
      dailySeriesTruncated: false,
      dailySeriesApproximate: false,
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
        markets: [],
        dailySeries: [],
        dailySeriesTruncated: false,
        dailySeriesApproximate: false,
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
    const aggregateArgs = {
      collaterals,
      instances,
      brackets: bracketPages.rows,
      rates,
      bracketsTruncated: bracketPages.truncated,
    };

    const daily = await resolveDailyBorrowingFeeSeries(
      client,
      network.chainId,
      aggregateArgs,
    );

    return {
      network,
      summary: aggregateCdpBorrowingRevenue(aggregateArgs),
      markets: aggregateCdpBorrowingRevenueMarkets(aggregateArgs),
      dailySeries: daily.points,
      dailySeriesTruncated: daily.truncated,
      dailySeriesApproximate: daily.approximate,
      error: null,
    };
  } catch (err) {
    return {
      network,
      summary: null,
      markets: [],
      dailySeries: [],
      dailySeriesTruncated: false,
      dailySeriesApproximate: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

async function fetchAllCdpBorrowingRevenue(): Promise<
  NetworkCdpBorrowingRevenue[]
> {
  const ids = NETWORK_IDS.filter(
    (id) =>
      isConfiguredNetworkId(id) &&
      CDP_REVENUE_CHAIN_IDS.has(NETWORKS[id].chainId),
  );
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
    markets: data === undefined ? [] : mergeMarkets(rows),
    dailySeries: data === undefined ? [] : mergeDailySeries(rows),
    dailySeriesTruncated: rows.some((row) => row.dailySeriesTruncated),
    dailySeriesApproximate: rows.some((row) => row.dailySeriesApproximate),
    isLoading,
    hasError: error !== undefined || rows.some((row) => row.error !== null),
  };
}
