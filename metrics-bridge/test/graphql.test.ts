import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock graphql-request BEFORE importing the module under test so the module-level
// `new GraphQLClient()` is intercepted. vi.mock() is hoisted above all imports,
// so `mockRequest` MUST be defined via vi.hoisted() to be visible inside the
// factory without a TDZ error.
const { mockRequest } = vi.hoisted(() => ({ mockRequest: vi.fn() }));

vi.mock("graphql-request", async () => {
  const actual =
    await vi.importActual<typeof import("graphql-request")>("graphql-request");
  class MockGraphQLClient {
    request = mockRequest;
  }
  return {
    ...actual,
    GraphQLClient: MockGraphQLClient,
  };
});

import { fetchPools } from "../src/graphql.js";

// Shape that graphql-request's `ClientError` produces on a Hasura
// validation-failed error. We only need the bits the detector reads.
function makeSchemaLagError(): Error {
  const err = new Error(
    "Validation error: field 'lastEffectivenessRatio' not found",
  ) as Error & {
    response: {
      errors: Array<{ message: string; extensions?: { code: string } }>;
    };
  };
  err.response = {
    errors: [
      {
        message:
          "field 'lastEffectivenessRatio' not found in type: 'Pool_fields'",
        extensions: { code: "validation-failed" },
      },
    ],
  };
  return err;
}

function legacyPool() {
  return {
    id: "42220-0xabc",
    chainId: 42220,
    token0: "0xaa",
    token1: "0xbb",
    source: "fpmm_factory",
    healthStatus: "OK",
    oracleOk: true,
    oracleTimestamp: "1",
    oracleExpiry: "1",
    lastDeviationRatio: "0.1",
    deviationBreachStartedAt: "0",
    limitStatus: "OK",
    limitPressure0: "0",
    limitPressure1: "0",
    lastRebalancedAt: "0",
    rebalanceLivenessStatus: "ACTIVE",
    hasHealthData: true,
  };
}

describe("fetchPools schema-lag fallback", () => {
  beforeEach(() => {
    mockRequest.mockReset();
  });

  it("retries with legacy query + synthesizes -1 sentinel when Hasura lacks lastEffectivenessRatio", async () => {
    mockRequest
      .mockRejectedValueOnce(makeSchemaLagError())
      .mockResolvedValueOnce({ Pool: [legacyPool()] });

    const result = await fetchPools();

    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(result.Pool).toHaveLength(1);
    expect(result.Pool[0]).toMatchObject({
      id: "42220-0xabc",
      lastEffectivenessRatio: "-1",
    });
  });

  it("does NOT retry on unrelated GraphQL errors", async () => {
    const unrelated = new Error("network timeout");
    mockRequest.mockRejectedValueOnce(unrelated);

    await expect(fetchPools()).rejects.toThrow("network timeout");
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on validation errors that mention a different field", async () => {
    const otherFieldErr = new Error("Validation error") as Error & {
      response: { errors: Array<{ message: string }> };
    };
    otherFieldErr.response = {
      errors: [{ message: "field 'someOtherField' not found" }],
    };
    mockRequest.mockRejectedValueOnce(otherFieldErr);

    await expect(fetchPools()).rejects.toThrow();
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });
});
