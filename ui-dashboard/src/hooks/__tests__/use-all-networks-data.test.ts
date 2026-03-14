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
      if (query.includes("Pool")) return { Pool: [pool] };
      if (query.includes("ProtocolFeeTransfer"))
        return { ProtocolFeeTransfer: [] };
      if (query.includes("PoolSnapshot")) return { PoolSnapshot: [] };
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
      if (query.includes("Pool")) return Promise.resolve({ Pool: [pool] });
      if (query.includes("PoolSnapshot"))
        return Promise.resolve({ PoolSnapshot: [] });
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
      if (query.includes("Pool")) return Promise.resolve({ Pool: [pool] });
      if (query.includes("ProtocolFeeTransfer"))
        return Promise.resolve({ ProtocolFeeTransfer: [] });
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
