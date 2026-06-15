/**
 * Orchestration tests for `useCdpBorrowingRevenue`.
 *
 * The hook's fetcher owns the daily-snapshot rollout boundary: an older
 * indexer schema without the snapshot entity may fall back to fee events, but
 * an incompatible selected field on the snapshot entity must fail the daily
 * series visibly instead of hiding schema drift behind the fallback.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

let capturedFetcher: (() => Promise<unknown>) | null = null;

vi.mock("swr", () => ({
  default: (
    _key: string,
    fetcher: () => Promise<unknown>,
  ): { data: undefined; isLoading: boolean } => {
    capturedFetcher = fetcher;
    return { data: undefined, isLoading: false };
  },
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock("graphql-request", () => {
  const MockGraphQLClient = vi.fn();
  MockGraphQLClient.prototype.request = vi.fn();
  return { GraphQLClient: MockGraphQLClient };
});

const networkMocks = vi.hoisted(() => {
  const celo = {
    id: "celo-mainnet",
    label: "Celo",
    chainId: 42220,
    contractsNamespace: null,
    hasuraUrl: "https://celo.example.com/v1/graphql",
    hasuraSecret: "",
    explorerBaseUrl: "https://celoscan.io",
    tokenSymbols: {},
    addressLabels: {},
    local: false,
    hasVirtualPools: false,
    testnet: false,
  };

  return {
    networkIds: ["celo-mainnet"] as string[],
    networks: { "celo-mainnet": celo } as Record<string, unknown>,
  };
});

vi.mock("@/lib/networks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/networks")>();
  return {
    ...actual,
    get NETWORK_IDS() {
      return networkMocks.networkIds;
    },
    get NETWORKS() {
      return networkMocks.networks;
    },
    isConfiguredNetworkId: (id: string) => networkMocks.networkIds.includes(id),
  };
});

import { GraphQLClient } from "graphql-request";
import { useCdpBorrowingRevenue } from "../use-cdp-borrowing-revenue";

type HookFetcherRow = {
  dailySeries: unknown[];
  dailySeriesFailed: boolean;
  error: Error | null;
};

function extractQuery(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg && typeof arg === "object" && "document" in arg) {
    const doc = (arg as { document: unknown }).document;
    if (typeof doc === "string") return doc;
  }
  return "";
}

function mockRequest(impl: (query: string) => unknown | Promise<unknown>) {
  (
    GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
  ).mockImplementation((...args: unknown[]) => {
    const query = extractQuery(args[0]);
    try {
      const result = impl(query);
      return result instanceof Promise ? result : Promise.resolve(result);
    } catch (err) {
      return Promise.reject(err);
    }
  });
}

function CdpBorrowingRevenueProbe() {
  capturedFetcher = null;
  useCdpBorrowingRevenue();
  return null;
}

async function runFetcher(): Promise<HookFetcherRow[]> {
  CdpBorrowingRevenueProbe();
  if (!capturedFetcher) throw new Error("SWR fetcher was never captured");
  return (await capturedFetcher()) as HookFetcherRow[];
}

const COLLATERAL = {
  id: "collateral-1",
  chainId: 42220,
  collIndex: 0,
  symbol: "USDm",
  spYieldSplitBps: 0,
};

const INSTANCE = {
  id: "instance-1",
  collateralId: COLLATERAL.id,
  chainId: 42220,
  systemDebt: "0",
  activeTroveCount: 0,
  borrowingFeeCum: "1000000000000000000",
  borrowingFeeCollectedCum: "0",
  isShutDown: false,
  shutDownAt: null,
};

function setupRevenueMock(args: {
  dailySnapshotError?: Error;
  feeEvents?: unknown[];
}): string[] {
  const seenQueries: string[] = [];
  mockRequest((query) => {
    seenQueries.push(query);
    if (query.includes("CdpBorrowingRevenueMarkets")) {
      return { LiquityCollateral: [COLLATERAL], LiquityInstance: [INSTANCE] };
    }
    if (query.includes("OracleRates")) return { Pool: [] };
    if (query.includes("CdpBorrowingRevenueBrackets")) {
      return { InterestRateBracket: [] };
    }
    if (query.includes("CdpBorrowingRevenueDailySnapshots")) {
      if (args.dailySnapshotError) throw args.dailySnapshotError;
      return { LiquityBorrowingRevenueDailySnapshot: [] };
    }
    if (query.includes("CdpBorrowingFeeEvents")) {
      return { TroveOperationEvent: args.feeEvents ?? [] };
    }
    return {};
  });
  return seenQueries;
}

beforeEach(() => {
  vi.resetAllMocks();
  capturedFetcher = null;
  networkMocks.networkIds = ["celo-mainnet"];
});

describe("useCdpBorrowingRevenue fetcher — daily snapshot fallback boundary", () => {
  it("does not fall back to fee events when the snapshot entity exists but a selected field is missing", async () => {
    const seenQueries = setupRevenueMock({
      dailySnapshotError: new Error(
        "field 'collected' not found in type: 'LiquityBorrowingRevenueDailySnapshot'",
      ),
    });

    const [row] = await runFetcher();

    expect(row?.error).toBeNull();
    expect(row?.dailySeriesFailed).toBe(true);
    expect(row?.dailySeries).toEqual([]);
    expect(
      seenQueries.some((query) => query.includes("CdpBorrowingFeeEvents")),
    ).toBe(false);
  });

  it("falls back to fee events only when the daily snapshot root entity is absent", async () => {
    const seenQueries = setupRevenueMock({
      dailySnapshotError: new Error(
        "field 'LiquityBorrowingRevenueDailySnapshot' not found in type: 'query_root'",
      ),
      feeEvents: [
        {
          id: "fee-event-1",
          instanceId: INSTANCE.id,
          debtIncreaseFromUpfrontFee: "1000000000000000000",
          timestamp: String(Math.floor(Date.now() / 1000) - 86_400),
        },
      ],
    });

    const [row] = await runFetcher();

    expect(row?.error).toBeNull();
    expect(row?.dailySeriesFailed).toBe(false);
    expect(row?.dailySeries.length).toBeGreaterThan(0);
    expect(
      seenQueries.some((query) => query.includes("CdpBorrowingFeeEvents")),
    ).toBe(true);
  });
});
