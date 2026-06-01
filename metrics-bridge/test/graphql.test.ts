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
  lastOracleReportAt: "1713200000",
  oracleTxHash:
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  oracleExpiry: "300",
  lastDeviationRatio: "0.42",
  deviationBreachStartedAt: "0",
  currentOpenBreachPeak: "0",
  currentOpenBreachEntryThreshold: 0,
  limitStatus: "OK",
  limitPressure0: "0.1",
  limitPressure1: "0.0",
  lastRebalancedAt: "1713199000",
  lastEffectivenessRatio: "0.5",
  rebalanceLivenessStatus: "ACTIVE",
  hasHealthData: true,
  lpFee: 5,
  protocolFee: 5,
  lastMedianPrice: "1150000000000000000000000",
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
              prevMedianPrice: "1120000000000000000000000",
              prevMedianAt: "1713199580",
            },
          ],
        });
      }
      if (doc.includes("BridgePoolsOpenBreach")) {
        return Promise.resolve({
          Pool: [
            {
              id: BASE_POOL.id,
              currentOpenBreachPeak: "15000",
              currentOpenBreachEntryThreshold: 5000,
            },
          ],
        });
      }
      if (doc.includes("BridgePoolsOracleTx")) {
        return Promise.resolve({
          Pool: [
            {
              id: BASE_POOL.id,
              oracleTxHash:
                "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
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
      oracleTxHash:
        "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      prevMedianPrice: "1120000000000000000000000",
      prevMedianAt: "1713199580",
      currentOpenBreachPeak: "15000",
      currentOpenBreachEntryThreshold: 5000,
    });
  });

  it("falls back to '0' prev-only lineage when Hasura reports an unknown field", async () => {
    // Simulates the deploy-window race where the bridge ships ahead of the
    // indexer's schema migration. `lastMedianPrice` rides on the base
    // query (pre-existing column), so the current-price gauge keeps
    // publishing — only `prevMedianPrice` / `prevMedianAt` degrade to "0".
    requestSpy.mockImplementation(({ document }: { document: unknown }) => {
      const doc = String(document);
      if (doc.includes("BridgePoolsOracleLineage")) {
        return Promise.reject(unknownFieldError("prevMedianPrice"));
      }
      if (doc.includes("BridgePoolsOpenBreach")) {
        return Promise.resolve({ Pool: [] });
      }
      if (doc.includes("BridgePoolsOracleTx")) {
        return Promise.resolve({ Pool: [] });
      }
      return Promise.resolve({ Pool: [BASE_POOL] });
    });

    const res = await fetchPools();
    expect(res.Pool).toHaveLength(1);
    expect(res.Pool[0]).toMatchObject({
      id: BASE_POOL.id,
      // Pre-existing column rides the base query — current-price gauge
      // keeps working in degraded mode.
      lastMedianPrice: "1150000000000000000000000",
      oracleTxHash: "",
      prevMedianPrice: "0",
      prevMedianAt: "0",
      lastOracleJumpBps: "3.0000",
      currentOpenBreachPeak: "0",
      currentOpenBreachEntryThreshold: 0,
    });
  });

  it("falls back to zero open-breach state when Hasura reports an unknown field", async () => {
    requestSpy.mockImplementation(({ document }: { document: unknown }) => {
      const doc = String(document);
      if (doc.includes("BridgePoolsOracleLineage")) {
        return Promise.resolve({
          Pool: [
            {
              id: BASE_POOL.id,
              prevMedianPrice: "1120000000000000000000000",
              prevMedianAt: "1713199580",
            },
          ],
        });
      }
      if (doc.includes("BridgePoolsOpenBreach")) {
        return Promise.reject(unknownFieldError("currentOpenBreachPeak"));
      }
      if (doc.includes("BridgePoolsOracleTx")) {
        return Promise.resolve({ Pool: [] });
      }
      return Promise.resolve({ Pool: [BASE_POOL] });
    });

    const res = await fetchPools();
    expect(res.Pool[0]).toMatchObject({
      id: BASE_POOL.id,
      prevMedianPrice: "1120000000000000000000000",
      prevMedianAt: "1713199580",
      currentOpenBreachPeak: "0",
      currentOpenBreachEntryThreshold: 0,
    });
  });

  it("propagates non-schema errors (network / timeout / generic GraphQL)", async () => {
    requestSpy.mockImplementation(({ document }: { document: unknown }) => {
      const doc = String(document);
      if (doc.includes("BridgePoolsOracleLineage")) {
        return Promise.reject(new Error("network down"));
      }
      if (doc.includes("BridgePoolsOpenBreach")) {
        return Promise.resolve({ Pool: [] });
      }
      if (doc.includes("BridgePoolsOracleTx")) {
        return Promise.resolve({ Pool: [] });
      }
      return Promise.resolve({ Pool: [BASE_POOL] });
    });

    await expect(fetchPools()).rejects.toThrow("network down");
  });

  it("leaves prev fields at '0' when the lineage query returns rows for other pools only", async () => {
    requestSpy.mockImplementation(({ document }: { document: unknown }) => {
      const doc = String(document);
      if (doc.includes("BridgePoolsOracleLineage")) {
        return Promise.resolve({
          Pool: [
            {
              id: "different-pool-id",
              prevMedianPrice: "1",
              prevMedianAt: "1",
            },
          ],
        });
      }
      if (doc.includes("BridgePoolsOpenBreach")) {
        return Promise.resolve({
          Pool: [
            {
              id: "different-pool-id",
              currentOpenBreachPeak: "1",
              currentOpenBreachEntryThreshold: 1,
            },
          ],
        });
      }
      if (doc.includes("BridgePoolsOracleTx")) {
        return Promise.resolve({
          Pool: [
            {
              id: "different-pool-id",
              oracleTxHash: "0x1",
            },
          ],
        });
      }
      return Promise.resolve({ Pool: [BASE_POOL] });
    });

    const res = await fetchPools();
    expect(res.Pool[0]).toMatchObject({
      id: BASE_POOL.id,
      lastMedianPrice: "1150000000000000000000000",
      oracleTxHash: "",
      prevMedianPrice: "0",
      prevMedianAt: "0",
      currentOpenBreachPeak: "0",
      currentOpenBreachEntryThreshold: 0,
    });
  });

  it("falls back to an empty oracle tx hash when Hasura reports an unknown field", async () => {
    requestSpy.mockImplementation(({ document }: { document: unknown }) => {
      const doc = String(document);
      if (doc.includes("BridgePoolsOracleLineage")) {
        return Promise.resolve({ Pool: [] });
      }
      if (doc.includes("BridgePoolsOpenBreach")) {
        return Promise.resolve({ Pool: [] });
      }
      if (doc.includes("BridgePoolsOracleTx")) {
        return Promise.reject(unknownFieldError("oracleTxHash"));
      }
      return Promise.resolve({ Pool: [BASE_POOL] });
    });

    const res = await fetchPools();
    expect(res.Pool[0]).toMatchObject({
      id: BASE_POOL.id,
      oracleTxHash: "",
    });
  });
});
