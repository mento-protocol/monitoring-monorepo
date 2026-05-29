/**
 * Tests for GraphQLSchemaError and the schema validation integration in useGQL.
 *
 * The hook itself is tested via React Testing Library in other files; here we
 * cover the pure validation logic: error construction, field propagation, and
 * that the Zod schema round-trips cleanly on good data.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { GraphQLSchemaError } from "@/lib/graphql-schema-error";

// ---------------------------------------------------------------------------
// GraphQLSchemaError
// ---------------------------------------------------------------------------

describe("GraphQLSchemaError", () => {
  // Use z to produce a real ZodIssue rather than hand-crafting the v4 shape.
  const sampleIssues = (() => {
    const schema = z.object({ Pool: z.array(z.object({ id: z.string() })) });
    const r = schema.safeParse({ Pool: [{}] });
    if (!r.success) return r.error.issues;
    throw new Error("expected parse failure");
  })();

  it("is an instance of Error", () => {
    const err = new GraphQLSchemaError(sampleIssues);
    expect(err).toBeInstanceOf(Error);
  });

  it("has name GraphQLSchemaError", () => {
    const err = new GraphQLSchemaError(sampleIssues);
    expect(err.name).toBe("GraphQLSchemaError");
  });

  it("exposes the Zod issues array", () => {
    const err = new GraphQLSchemaError(sampleIssues);
    expect(err.issues).toBe(sampleIssues);
  });

  it("includes path and message in the error message", () => {
    const err = new GraphQLSchemaError(sampleIssues);
    expect(err.message).toContain("Pool.0.id");
    expect(err.message).toContain("string");
  });

  it("includes a query hint when provided", () => {
    const err = new GraphQLSchemaError(sampleIssues, "PoolBreachRollup");
    expect(err.message).toContain("[PoolBreachRollup]");
  });

  it("omits the bracket prefix when no hint is provided", () => {
    const err = new GraphQLSchemaError(sampleIssues);
    expect(err.message).not.toContain("[");
  });
});

// ---------------------------------------------------------------------------
// Schema round-trip tests (validates the three PoC schemas)
// ---------------------------------------------------------------------------

import {
  PoolBreachRollupSchema,
  PoolConfigExtSchema,
  PoolDetailWithHealthSchema,
} from "@/lib/queries/pool-detail-schemas";

describe("PoolBreachRollupSchema", () => {
  it("passes with minimal valid data", () => {
    const data = { Pool: [{ id: "0xabc" }] };
    const result = PoolBreachRollupSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it("passes with all optional fields present", () => {
    const data = {
      Pool: [
        {
          id: "0xabc",
          breachCount: 3,
          healthBinarySeconds: "86400",
          healthTotalSeconds: "172800",
        },
      ],
    };
    const result = PoolBreachRollupSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it("fails when Pool is missing", () => {
    const result = PoolBreachRollupSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("fails when id field is missing from a row", () => {
    const result = PoolBreachRollupSchema.safeParse({
      Pool: [{ breachCount: 3 }],
    });
    expect(result.success).toBe(false);
  });

  it("fails when a numeric field receives a non-numeric type", () => {
    const result = PoolBreachRollupSchema.safeParse({
      Pool: [{ id: "0xabc", breachCount: "not-a-number" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("PoolConfigExtSchema", () => {
  it("passes with minimal valid data (no rebalanceReward)", () => {
    const data = { Pool: [{ id: "0xdef" }] };
    const result = PoolConfigExtSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it("passes with rebalanceReward present", () => {
    const data = { Pool: [{ id: "0xdef", rebalanceReward: 50 }] };
    const result = PoolConfigExtSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it("fails when Pool is not an array", () => {
    const result = PoolConfigExtSchema.safeParse({ Pool: null });
    expect(result.success).toBe(false);
  });
});

describe("PoolDetailWithHealthSchema", () => {
  const minimalRow = {
    id: "0x123",
    chainId: 42220,
    token0: "0xaaa",
    token1: "0xbbb",
    source: "BiPoolManager",
    createdAtBlock: "1000",
    createdAtTimestamp: "1700000000",
    updatedAtBlock: "2000",
    updatedAtTimestamp: "1700001000",
  };

  it("passes with minimal required fields", () => {
    const result = PoolDetailWithHealthSchema.safeParse({ Pool: [minimalRow] });
    expect(result.success).toBe(true);
  });

  it("passes with all optional fields set", () => {
    const full = {
      ...minimalRow,
      token0Decimals: 18,
      token1Decimals: 6,
      healthStatus: "ok",
      oracleOk: true,
      oraclePrice: "1.0001",
      oracleTimestamp: "1700001000",
      oracleTxHash: "0xtx",
      oracleExpiry: "1700002000",
      oracleNumReporters: 5,
      referenceRateFeedID: "0xfeed",
      priceDifference: "0.001",
      rebalanceThreshold: 500,
      lastRebalancedAt: "1700000800",
      deviationBreachStartedAt: null,
      lpFee: 100,
      protocolFee: 50,
      limitStatus: "ok",
      limitPressure0: "0.5",
      limitPressure1: "0.3",
      rebalancerAddress: "0xrebal",
      reserves0: "1000000",
      reserves1: "1000000",
      swapCount: 42,
      healthTotalSeconds: "86400",
      hasHealthData: true,
    };
    const result = PoolDetailWithHealthSchema.safeParse({ Pool: [full] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.Pool[0]!.token0Decimals).toBe(18);
      expect(result.data.Pool[0]!.token1Decimals).toBe(6);
    }
  });

  it("preserves token decimals through the schema (no silent strip)", () => {
    // POOL_DETAIL_WITH_HEALTH queries token0Decimals/token1Decimals; both must
    // round-trip through the schema since the USD math and `tokenDecimalsKnown`
    // trust gate depend on them. If they're ever dropped from the row schema,
    // Zod will silently strip them and this test catches it.
    const row = { ...minimalRow, token0Decimals: 18, token1Decimals: 6 };
    const result = PoolDetailWithHealthSchema.safeParse({ Pool: [row] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.Pool[0]!.token0Decimals).toBe(18);
      expect(result.data.Pool[0]!.token1Decimals).toBe(6);
    }
  });

  it("fails when a required string field is missing", () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { id: _omit, ...withoutId } = minimalRow;
    const result = PoolDetailWithHealthSchema.safeParse({
      Pool: [withoutId],
    });
    expect(result.success).toBe(false);
  });

  it("fails when chainId is a string instead of number", () => {
    const result = PoolDetailWithHealthSchema.safeParse({
      Pool: [{ ...minimalRow, chainId: "42220" }],
    });
    expect(result.success).toBe(false);
  });

  it("passes with an empty Pool array (no results)", () => {
    const result = PoolDetailWithHealthSchema.safeParse({ Pool: [] });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Simulated fetcher validation logic (pure unit — no React/SWR needed)
// ---------------------------------------------------------------------------

describe("schema validation logic", () => {
  const schema = z.object({ Pool: z.array(z.object({ id: z.string() })) });

  it("returns data unchanged when schema passes", () => {
    const raw = { Pool: [{ id: "0x1" }] };
    const result = schema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(raw);
  });

  it("produces a GraphQLSchemaError from parse failure", () => {
    const raw = { Pool: [{ id: 99 }] }; // id is a number, not a string
    const result = schema.safeParse(raw);
    expect(result.success).toBe(false);
    if (!result.success) {
      const err = new GraphQLSchemaError(result.error.issues, "TestQuery");
      expect(err).toBeInstanceOf(GraphQLSchemaError);
      expect(err.issues.length).toBeGreaterThan(0);
    }
  });

  it("extracts the operation name from a multi-line GraphQL document", () => {
    // The fetcher passes the operation name (not the whole doc) as the
    // queryHint so Sentry alert titles stay readable.
    const extract = (q: string) => q.match(/\b(?:query|mutation)\s+(\w+)/)?.[1];
    expect(
      extract(`\n  query PoolDetailWithHealth($id: String!) { Pool { id } }\n`),
    ).toBe("PoolDetailWithHealth");
    expect(extract(`mutation UpdatePool { update_pool { id } }`)).toBe(
      "UpdatePool",
    );
    expect(extract(`{ Pool { id } }`)).toBeUndefined(); // anonymous query
  });

  it("strips unknown keys by default (Zod behavior note)", () => {
    // Zod's z.object() strips unknown keys from parsed output (it does NOT
    // fail on them). Hasura can return extra fields the schema doesn't
    // declare; they're silently dropped from `data` unless the schema uses
    // .passthrough(). This test pins down the strip behavior so future
    // schema-validation work (e.g. adding .passthrough() to a row schema)
    // can break this test deliberately as a tripwire.
    const schema = z.object({ Pool: z.array(z.object({ id: z.string() })) });
    const raw = { Pool: [{ id: "0x1", unknown: 42 }] };
    const result = schema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.Pool[0]!.id).toBe("0x1");
      expect("unknown" in result.data.Pool[0]!).toBe(false);
    }
  });
});
