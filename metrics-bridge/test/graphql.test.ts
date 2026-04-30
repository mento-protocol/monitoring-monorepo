import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientError } from "graphql-request";

// `vi.mock` is hoisted ABOVE imports, so the factory can't close over
// module-scope `vi.fn()` directly. `vi.hoisted` lifts the spy into the
// same scope so the GraphQLClient mock can reference it. `ClientError`
// stays as the real class so the SUT's `instanceof` check still works.
const { requestSpy } = vi.hoisted(() => ({ requestSpy: vi.fn() }));
vi.mock("graphql-request", async () => {
  const actual =
    await vi.importActual<typeof import("graphql-request")>("graphql-request");
  // vitest 4+ rejects arrow-function `vi.fn().mockImplementation` for class
  // mocks ("did not use 'function' or 'class'") — use a real class so
  // `new GraphQLClient(...)` resolves correctly when the SUT loads.
  class MockGraphQLClient {
    request = requestSpy;
  }
  return {
    ...actual,
    GraphQLClient: MockGraphQLClient,
  };
});

import { fetchPools } from "../src/graphql.js";

const BASE_POOL = {
  id: "42220-0xabc",
  chainId: 42220,
  token0: "0x1",
  token1: "0x2",
  source: "fpmm_factory",
  healthStatus: "OK",
  oracleOk: true,
  oracleTimestamp: "1713200000",
  oracleExpiry: "300",
  lastDeviationRatio: "0.42",
  deviationBreachStartedAt: "0",
  limitStatus: "OK",
  limitPressure0: "0.1",
  limitPressure1: "0.0",
  lastRebalancedAt: "1713199000",
  lastEffectivenessRatio: "0.5",
  rebalanceLivenessStatus: "ACTIVE",
  hasHealthData: true,
  lpFee: 5,
  protocolFee: 5,
  lastOracleJumpBps: "3.0000",
  lastOracleJumpAt: "1713200000",
  reserves0: "1",
  reserves1: "1",
  token0Decimals: 18,
  token1Decimals: 18,
  rebalancerAddress: "0xbeef",
};

function unknownFieldError(field: string): ClientError {
  return new ClientError(
    {
      data: undefined,
      errors: [
        {
          message: `field "${field}" not found in type: 'Pool'`,
        },
      ],
      status: 200,
      headers: new Headers(),
    },
    { query: "..." },
  );
}

describe("fetchPools — degraded-mode oracle lineage", () => {
  beforeEach(() => {
    requestSpy.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("merges base + lineage rows on the happy path", async () => {
    requestSpy.mockImplementation(({ document }: { document: unknown }) => {
      const doc = String(document);
      if (doc.includes("BridgePoolsOracleLineage")) {
        return Promise.resolve({
          Pool: [
            {
              id: BASE_POOL.id,
              lastMedianPrice: "1150000000000000000000000",
              prevMedianPrice: "1120000000000000000000000",
              prevMedianAt: "1713199580",
            },
          ],
        });
      }
      return Promise.resolve({ Pool: [BASE_POOL] });
    });

    const res = await fetchPools();
    expect(res.Pool).toHaveLength(1);
    expect(res.Pool[0]).toMatchObject({
      id: BASE_POOL.id,
      lastMedianPrice: "1150000000000000000000000",
      prevMedianPrice: "1120000000000000000000000",
      prevMedianAt: "1713199580",
    });
  });

  it("falls back to '0' lineage when Hasura reports an unknown field", async () => {
    // Simulates the deploy-window race where the bridge ships ahead of the
    // indexer's schema migration. The base query keeps returning every
    // pool's gauges; only the new annotation values are dropped.
    requestSpy.mockImplementation(({ document }: { document: unknown }) => {
      const doc = String(document);
      if (doc.includes("BridgePoolsOracleLineage")) {
        return Promise.reject(unknownFieldError("prevMedianPrice"));
      }
      return Promise.resolve({ Pool: [BASE_POOL] });
    });

    const res = await fetchPools();
    expect(res.Pool).toHaveLength(1);
    expect(res.Pool[0]).toMatchObject({
      id: BASE_POOL.id,
      lastMedianPrice: "0",
      prevMedianPrice: "0",
      prevMedianAt: "0",
      // Base fields untouched.
      lastOracleJumpBps: "3.0000",
    });
  });

  it("propagates non-schema errors (network / timeout / generic GraphQL)", async () => {
    requestSpy.mockImplementation(({ document }: { document: unknown }) => {
      const doc = String(document);
      if (doc.includes("BridgePoolsOracleLineage")) {
        return Promise.reject(new Error("network down"));
      }
      return Promise.resolve({ Pool: [BASE_POOL] });
    });

    await expect(fetchPools()).rejects.toThrow("network down");
  });

  it("leaves lineage at '0' when the lineage query returns rows for other pools only", async () => {
    requestSpy.mockImplementation(({ document }: { document: unknown }) => {
      const doc = String(document);
      if (doc.includes("BridgePoolsOracleLineage")) {
        return Promise.resolve({
          Pool: [
            {
              id: "different-pool-id",
              lastMedianPrice: "1",
              prevMedianPrice: "1",
              prevMedianAt: "1",
            },
          ],
        });
      }
      return Promise.resolve({ Pool: [BASE_POOL] });
    });

    const res = await fetchPools();
    expect(res.Pool[0]).toMatchObject({
      id: BASE_POOL.id,
      lastMedianPrice: "0",
      prevMedianPrice: "0",
      prevMedianAt: "0",
    });
  });
});
