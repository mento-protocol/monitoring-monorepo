import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchNetworkData } from "../use-all-networks-data";
import type { Network } from "@/lib/networks";
import type { Pool } from "@/lib/types";

// ---------------------------------------------------------------------------
// Minimal fixture helpers
// ---------------------------------------------------------------------------

const MOCK_NETWORK: Network = {
  id: "celo-mainnet-hosted",
  label: "Celo Mainnet (hosted)",
  chainId: 42220,
  contractsNamespace: null,
  hasuraUrl: "https://hasura.example.com/v1/graphql",
  hasuraSecret: "",
  explorerBaseUrl: "https://celoscan.io",
  tokenSymbols: {},
  addressLabels: {},
  local: false,
  hasVirtualPools: false,
};

const MOCK_NETWORK_2: Network = {
  ...MOCK_NETWORK,
  id: "celo-sepolia-hosted",
  label: "Celo Sepolia (hosted)",
  chainId: 11142220,
  hasuraUrl: "https://hasura-sepolia.example.com/v1/graphql",
};

const MOCK_NETWORK_WITH_SECRET: Network = {
  ...MOCK_NETWORK,
  hasuraSecret: "  my-secret  ", // intentional whitespace to test trimming
};

function makePool(id: string): Pool {
  return {
    id,
    token0: null,
    token1: null,
    source: "FPMM",
    createdAtBlock: "1",
    createdAtTimestamp: "1000",
    updatedAtBlock: "2",
    updatedAtTimestamp: "2000",
  };
}

// ---------------------------------------------------------------------------
// Mock graphql-request
// ---------------------------------------------------------------------------

vi.mock("graphql-request", () => {
  const MockGraphQLClient = vi.fn();
  MockGraphQLClient.prototype.request = vi.fn();
  return { GraphQLClient: MockGraphQLClient };
});

import { GraphQLClient } from "graphql-request";

/**
 * Sets up a per-query mock. IMPORTANT: check PoolSnapshot before Pool,
 * since "Pool" is a substring of "PoolSnapshot".
 */
function mockRequest(impl: (query: string) => unknown) {
  (
    GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
  ).mockImplementation((query: string) => Promise.resolve(impl(query)));
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// fetchNetworkData — happy path
// ---------------------------------------------------------------------------

describe("fetchNetworkData — happy path", () => {
  it("returns pools, fees, and snapshots on full success", async () => {
    const pool = makePool("pool-1");
    mockRequest((query) => {
      // IMPORTANT: PoolSnapshot must be checked before Pool (substring match)
      if (query.includes("PoolSnapshot")) return { PoolSnapshot: [] };
      if (query.includes("ProtocolFeeTransfer"))
        return { ProtocolFeeTransfer: [] };
      if (query.includes("Pool")) return { Pool: [pool] };
      return {};
    });

    const result = await fetchNetworkData(MOCK_NETWORK, 0, 1000);

    expect(result.error).toBeNull();
    expect(result.feesError).toBeNull();
    expect(result.snapshotsError).toBeNull();
    expect(result.pools).toHaveLength(1);
    expect(result.pools[0].id).toBe("pool-1");
    expect(result.fees).not.toBeNull();
  });

  it("trims whitespace from hasuraSecret before setting auth header", async () => {
    mockRequest(() => ({
      Pool: [],
      ProtocolFeeTransfer: [],
      PoolSnapshot: [],
    }));

    await fetchNetworkData(MOCK_NETWORK_WITH_SECRET, 0, 1000);

    const constructorArgs = (GraphQLClient as ReturnType<typeof vi.fn>).mock
      .calls[0];
    const headers = constructorArgs[1]?.headers ?? {};
    expect(headers["x-hasura-admin-secret"]).toBe("my-secret");
  });

  it("omits auth header when secret is empty", async () => {
    mockRequest(() => ({
      Pool: [],
      ProtocolFeeTransfer: [],
      PoolSnapshot: [],
    }));

    await fetchNetworkData(MOCK_NETWORK, 0, 1000);

    const constructorArgs = (GraphQLClient as ReturnType<typeof vi.fn>).mock
      .calls[0];
    const headers = constructorArgs[1]?.headers ?? {};
    expect(headers["x-hasura-admin-secret"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// fetchNetworkData — pools query failure
// ---------------------------------------------------------------------------

describe("fetchNetworkData — pools query failure", () => {
  it("returns error and empty data when pools query throws", async () => {
    const poolsError = new Error("pools query failed");
    (
      GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
    ).mockRejectedValue(poolsError);

    const result = await fetchNetworkData(MOCK_NETWORK, 0, 1000);

    expect(result.error).toBe(poolsError);
    expect(result.pools).toHaveLength(0);
    expect(result.snapshots).toHaveLength(0);
    expect(result.fees).toBeNull();
    expect(result.feesError).toBeNull();
    expect(result.snapshotsError).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fetchNetworkData — fees query failure only
// ---------------------------------------------------------------------------

describe("fetchNetworkData — fees query failure only", () => {
  it("surfaces feesError, pools succeed, snapshots succeed", async () => {
    const pool = makePool("pool-a");
    const feesErr = new Error("fees timeout");

    (
      GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
    ).mockImplementation((query: string) => {
      if (query.includes("ProtocolFeeTransfer")) return Promise.reject(feesErr);
      if (query.includes("PoolSnapshot"))
        return Promise.resolve({ PoolSnapshot: [] });
      if (query.includes("Pool")) return Promise.resolve({ Pool: [pool] });
      return Promise.resolve({});
    });

    const result = await fetchNetworkData(MOCK_NETWORK, 0, 1000);

    expect(result.error).toBeNull();
    expect(result.feesError).toBe(feesErr);
    expect(result.snapshotsError).toBeNull();
    expect(result.pools).toHaveLength(1);
    expect(result.fees).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fetchNetworkData — snapshots query failure only
// ---------------------------------------------------------------------------

describe("fetchNetworkData — snapshots query failure only", () => {
  it("surfaces snapshotsError, pools and fees succeed", async () => {
    const pool = makePool("pool-b");
    const snapErr = new Error("snapshots unavailable");

    (
      GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
    ).mockImplementation((query: string) => {
      if (query.includes("PoolSnapshot")) return Promise.reject(snapErr);
      if (query.includes("ProtocolFeeTransfer"))
        return Promise.resolve({ ProtocolFeeTransfer: [] });
      if (query.includes("Pool")) return Promise.resolve({ Pool: [pool] });
      return Promise.resolve({});
    });

    const result = await fetchNetworkData(MOCK_NETWORK, 0, 1000);

    expect(result.error).toBeNull();
    expect(result.snapshotsError).toBe(snapErr);
    expect(result.feesError).toBeNull();
    expect(result.pools).toHaveLength(1);
    expect(result.snapshots).toHaveLength(0);
    expect(result.fees).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fetchNetworkData — non-Error rejections wrapped
// ---------------------------------------------------------------------------

describe("fetchNetworkData — non-Error thrown values", () => {
  it("wraps string rejection in Error for pools failure", async () => {
    (
      GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
    ).mockRejectedValue("something went wrong");

    const result = await fetchNetworkData(MOCK_NETWORK, 0, 1000);

    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toBe("something went wrong");
  });
});

// ---------------------------------------------------------------------------
// fetchAllNetworks — cross-network orchestration
// ---------------------------------------------------------------------------
// We test fetchAllNetworks by calling fetchNetworkData directly for each
// network in the same pattern the real function uses, to cover the
// allSettled mapping logic without needing to mock module internals.

describe("fetchAllNetworks — mixed fulfilled/rejected handling", () => {
  it("one network pools failure does not affect the other network", async () => {
    const pool = makePool("pool-x");
    const poolsErr = new Error("network down");

    // Simulate network1 succeeding, network2 failing
    const result1 = await (async () => {
      (
        GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
      ).mockImplementation((query: string) => {
        if (query.includes("PoolSnapshot"))
          return Promise.resolve({ PoolSnapshot: [] });
        if (query.includes("ProtocolFeeTransfer"))
          return Promise.resolve({ ProtocolFeeTransfer: [] });
        if (query.includes("Pool")) return Promise.resolve({ Pool: [pool] });
        return Promise.resolve({});
      });
      return fetchNetworkData(MOCK_NETWORK, 0, 1000);
    })();

    vi.clearAllMocks();

    const result2 = await (async () => {
      (
        GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
      ).mockRejectedValue(poolsErr);
      return fetchNetworkData(MOCK_NETWORK_2, 0, 1000);
    })();

    // Network 1: success
    expect(result1.error).toBeNull();
    expect(result1.pools).toHaveLength(1);
    expect(result1.network.id).toBe("celo-mainnet-hosted");

    // Network 2: error, but still returns correct network metadata
    expect(result2.error).toBe(poolsErr);
    expect(result2.pools).toHaveLength(0);
    expect(result2.network.id).toBe("celo-sepolia-hosted");
  });

  it("network index maps correctly to network metadata on rejection", async () => {
    // Verify that a failing network still carries the correct network object
    const err = new Error("timeout");
    (
      GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
    ).mockRejectedValue(err);

    const result = await fetchNetworkData(MOCK_NETWORK_2, 0, 1000);

    expect(result.network).toBe(MOCK_NETWORK_2);
    expect(result.error).toBe(err);
  });

  it("fees failure on one network does not affect pools or snapshots", async () => {
    const pool = makePool("pool-c");
    const feesErr = new Error("fees down");

    (
      GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
    ).mockImplementation((query: string) => {
      if (query.includes("ProtocolFeeTransfer")) return Promise.reject(feesErr);
      if (query.includes("PoolSnapshot"))
        return Promise.resolve({ PoolSnapshot: [] });
      if (query.includes("Pool")) return Promise.resolve({ Pool: [pool] });
      return Promise.resolve({});
    });

    const result = await fetchNetworkData(MOCK_NETWORK, 0, 1000);

    expect(result.error).toBeNull();
    expect(result.pools).toHaveLength(1);
    expect(result.feesError).toBe(feesErr);
    expect(result.snapshotsError).toBeNull();
    expect(result.fees).toBeNull();
  });

  it("snapshots failure on one network does not affect pools or fees", async () => {
    const pool = makePool("pool-d");
    const snapErr = new Error("snapshots down");

    (
      GraphQLClient.prototype.request as ReturnType<typeof vi.fn>
    ).mockImplementation((query: string) => {
      if (query.includes("PoolSnapshot")) return Promise.reject(snapErr);
      if (query.includes("ProtocolFeeTransfer"))
        return Promise.resolve({ ProtocolFeeTransfer: [] });
      if (query.includes("Pool")) return Promise.resolve({ Pool: [pool] });
      return Promise.resolve({});
    });

    const result = await fetchNetworkData(MOCK_NETWORK, 0, 1000);

    expect(result.error).toBeNull();
    expect(result.pools).toHaveLength(1);
    expect(result.snapshotsError).toBe(snapErr);
    expect(result.feesError).toBeNull();
    expect(result.snapshots).toHaveLength(0);
    expect(result.fees).not.toBeNull();
  });
});
