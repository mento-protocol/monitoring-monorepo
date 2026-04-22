import { describe, it, expect, vi, beforeEach } from "vitest";

// NETWORKS mock — two mainnet chains sharing a Hasura URL (matches the
// real config where both Celo + Monad point at the same NEXT_PUBLIC_HASURA_URL).
vi.mock("@/lib/networks", () => {
  const celo = {
    id: "celo-mainnet" as const,
    label: "Celo",
    chainId: 42220,
    contractsNamespace: "mainnet" as string | null,
    hasuraUrl: "https://multichain.example.com/v1/graphql",
    hasuraSecret: "",
    explorerBaseUrl: "https://celoscan.io",
    tokenSymbols: {},
    addressLabels: {},
    local: false,
    testnet: false,
    hasVirtualPools: true,
  };
  const monad = {
    ...celo,
    id: "monad-mainnet" as const,
    label: "Monad",
    chainId: 143,
    hasVirtualPools: false,
  };
  return {
    NETWORKS: { "celo-mainnet": celo, "monad-mainnet": monad },
    NETWORK_IDS: ["celo-mainnet", "monad-mainnet"],
    networkIdForChainId: (chainId: number) => {
      if (chainId === 42220) return "celo-mainnet";
      if (chainId === 143) return "monad-mainnet";
      return null;
    },
    isCanonicalNetwork: () => true,
    isNetworkId: () => true,
    isConfiguredNetworkId: () => true,
  };
});

vi.mock("graphql-request", () => {
  const MockGraphQLClient = vi.fn();
  MockGraphQLClient.prototype.request = vi.fn();
  return { GraphQLClient: MockGraphQLClient };
});

// next/cache's unstable_cache wraps the fn with memoization we don't need in
// the uncached test path; no-op it so every test sees fresh mock responses.
vi.mock("next/cache", () => ({
  unstable_cache: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
}));

import { GraphQLClient } from "graphql-request";
import { fetchBridgeFlowsOgDataUncached } from "../bridge-flows-og";

const BRIDGE_SNAPSHOT_QUERY_MARKER = "BridgeDailySnapshot";
const ALL_POOLS_QUERY_MARKER = "ALL_POOLS_WITH_HEALTH";

// Test fixtures: two recent days of USDm transfers, one chain, all priced
// directly via sentUsdValue so we don't need oracle rates to assert totals.
function makeSnapshots() {
  const nowSec = Math.floor(Date.now() / 1000);
  const day = 86_400;
  const todayBucket = nowSec - (nowSec % day);
  return [
    {
      id: "row-1",
      date: String(todayBucket),
      provider: "WORMHOLE",
      tokenSymbol: "USDm",
      sourceChainId: 42220,
      destChainId: 143,
      sentCount: 5,
      deliveredCount: 5,
      cancelledCount: 0,
      sentVolume: "0",
      deliveredVolume: "0",
      sentUsdValue: "1000.00",
      updatedAt: String(nowSec),
    },
    {
      id: "row-2",
      date: String(todayBucket - day),
      provider: "WORMHOLE",
      tokenSymbol: "USDm",
      sourceChainId: 42220,
      destChainId: 143,
      sentCount: 3,
      deliveredCount: 3,
      cancelledCount: 0,
      sentVolume: "0",
      deliveredVolume: "0",
      sentUsdValue: "500.00",
      updatedAt: String(nowSec),
    },
  ];
}

function mockRequests(handlers: {
  snapshots?: () => Promise<unknown>;
  pools?: () => Promise<unknown>;
}) {
  (
    GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
  ).mockImplementation(async (arg: string | { document: string }) => {
    const doc = typeof arg === "string" ? arg : arg.document;
    if (doc.includes(BRIDGE_SNAPSHOT_QUERY_MARKER)) {
      return handlers.snapshots
        ? handlers.snapshots()
        : { BridgeDailySnapshot: [] };
    }
    if (doc.includes(ALL_POOLS_QUERY_MARKER) || doc.includes("Pool(")) {
      return handlers.pools ? handlers.pools() : { Pool: [] };
    }
    throw new Error(`Unexpected query: ${doc.slice(0, 40)}`);
  });
}

describe("fetchBridgeFlowsOgDataUncached", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns populated data on the happy path", async () => {
    mockRequests({
      snapshots: async () => ({ BridgeDailySnapshot: makeSnapshots() }),
      pools: async () => ({ Pool: [] }),
    });
    const data = await fetchBridgeFlowsOgDataUncached();
    expect(data).not.toBeNull();
    expect(data!.volume30dUsd).toBe(1500);
    expect(data!.totalTransfers30d).toBe(8);
    expect(data!.volumeSeries).toEqual([500, 1000]);
    expect(data!.chains).toEqual(["Celo", "Monad"]);
  });

  it("degrades gracefully when snapshots fail — chains label still populated", async () => {
    mockRequests({
      snapshots: () => Promise.reject(new Error("hasura down")),
      pools: async () => ({ Pool: [] }),
    });
    const data = await fetchBridgeFlowsOgDataUncached();
    expect(data).not.toBeNull();
    expect(data!.volume30dUsd).toBeNull();
    expect(data!.totalTransfers30d).toBeNull();
    expect(data!.volumeSeries).toEqual([]);
    expect(data!.chains).toEqual(["Celo", "Monad"]);
  });

  it("still returns volume when a pools query fails (rate map degraded)", async () => {
    // One chain's pool query fails, the other succeeds. Since fixtures use
    // pinned sentUsdValue, the missing rate map doesn't affect totals — the
    // card still renders real numbers.
    let poolCallCount = 0;
    mockRequests({
      snapshots: async () => ({ BridgeDailySnapshot: makeSnapshots() }),
      pools: async () => {
        poolCallCount++;
        if (poolCallCount === 1) throw new Error("celo pool query timeout");
        return { Pool: [] };
      },
    });
    const data = await fetchBridgeFlowsOgDataUncached();
    expect(data).not.toBeNull();
    expect(data!.volume30dUsd).toBe(1500);
    expect(data!.volumeSeries).toEqual([500, 1000]);
  });

  it("returns 0 (not null) when snapshots query succeeded but is empty", async () => {
    // Truly idle bridge: query came back, just no rows. Distinguish from
    // "query failed" (which keeps null) so the OG can honestly say
    // "30d volume $0" instead of falling through to a generic fallback.
    mockRequests({
      snapshots: async () => ({ BridgeDailySnapshot: [] }),
      pools: async () => ({ Pool: [] }),
    });
    const data = await fetchBridgeFlowsOgDataUncached();
    expect(data).not.toBeNull();
    expect(data!.volume30dUsd).toBe(0);
    expect(data!.totalTransfers30d).toBe(0);
    expect(data!.volumeSeries).toEqual([]);
  });
});
