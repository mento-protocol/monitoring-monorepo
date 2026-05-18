/**
 * Zod response schemas for high-risk pool-detail queries.
 *
 * These are the three most drift-prone query shapes (they're explicitly
 * isolated because Hasura rejects new fields during deploy+resync windows).
 * When passed to useGQL's `schema` option, a parse failure surfaces as a
 * typed `GraphQLSchemaError` via SWR's error path instead of silently
 * rendering `undefined`.
 *
 * Rules for these schemas:
 * - All Hasura scalar fields are strings (even numeric ones) unless
 *   explicitly typed otherwise (e.g. `id: z.string()`).
 * - Fields that the indexer may not have written yet are `.optional()`.
 * - The outer shape is always `{ Pool: z.array(...) }` for entity queries.
 * - Keep in sync with the corresponding query and TypeScript type in types.ts.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// POOL_BREACH_ROLLUP
// ---------------------------------------------------------------------------

const PoolBreachRollupRowSchema = z.object({
  id: z.string(),
  breachCount: z.number().optional(),
  healthBinarySeconds: z.string().optional(),
  healthTotalSeconds: z.string().optional(),
});

export const PoolBreachRollupSchema = z.object({
  Pool: z.array(PoolBreachRollupRowSchema),
});

// ---------------------------------------------------------------------------
// POOL_CONFIG_EXT
// ---------------------------------------------------------------------------

const PoolConfigExtRowSchema = z.object({
  id: z.string(),
  rebalanceReward: z.number().optional(),
});

export const PoolConfigExtSchema = z.object({
  Pool: z.array(PoolConfigExtRowSchema),
});

// ---------------------------------------------------------------------------
// POOL_DETAIL_WITH_HEALTH  (primary pool-page query)
// ---------------------------------------------------------------------------

const PoolDetailRowSchema = z.object({
  id: z.string(),
  chainId: z.number(),
  token0: z.string().nullable(),
  token1: z.string().nullable(),
  // Decimals are queried but may be null on older indexer rows; coerce so the
  // inferred type stays compatible with Pool.token0Decimals?: number.
  token0Decimals: z
    .number()
    .nullable()
    .optional()
    .transform((v) => v ?? undefined),
  token1Decimals: z
    .number()
    .nullable()
    .optional()
    .transform((v) => v ?? undefined),
  source: z.string(),
  createdAtBlock: z.string(),
  createdAtTimestamp: z.string(),
  updatedAtBlock: z.string(),
  updatedAtTimestamp: z.string(),
  // Optional health/oracle fields — may be absent on older schema versions
  healthStatus: z.string().optional(),
  oracleOk: z.boolean().optional(),
  oraclePrice: z.string().optional(),
  oracleTimestamp: z.string().optional(),
  oracleTxHash: z.string().optional(),
  oracleExpiry: z.string().optional(),
  oracleNumReporters: z.number().optional(),
  referenceRateFeedID: z.string().optional(),
  priceDifference: z.string().optional(),
  rebalanceThreshold: z.number().optional(),
  lastRebalancedAt: z.string().optional(),
  // Hasura can return null when no breach is open; coerce to undefined so the
  // inferred type stays compatible with Pool.deviationBreachStartedAt?: string.
  deviationBreachStartedAt: z
    .string()
    .nullable()
    .optional()
    .transform((v) => v ?? undefined),
  lpFee: z.number().optional(),
  protocolFee: z.number().optional(),
  limitStatus: z.string().optional(),
  limitPressure0: z.string().optional(),
  limitPressure1: z.string().optional(),
  rebalancerAddress: z.string().optional(),
  reserves0: z.string().optional(),
  reserves1: z.string().optional(),
  swapCount: z.number().optional(),
  healthTotalSeconds: z.string().optional(),
  hasHealthData: z.boolean().optional(),
  // Hasura can return null on FPMM pools; coerce to undefined for Pool compat.
  wrappedExchangeId: z
    .string()
    .nullable()
    .optional()
    .transform((v) => v ?? undefined),
});

export const PoolDetailWithHealthSchema = z.object({
  Pool: z.array(PoolDetailRowSchema),
});
