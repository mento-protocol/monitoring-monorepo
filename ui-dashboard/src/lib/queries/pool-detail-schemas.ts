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

export const PoolBreachRollupRowSchema = z.object({
  id: z.string(),
  breachCount: z.number().optional(),
  healthBinarySeconds: z.string().optional(),
  healthTotalSeconds: z.string().optional(),
});

export const PoolBreachRollupSchema = z.object({
  Pool: z.array(PoolBreachRollupRowSchema),
});

export type PoolBreachRollupResponse = z.infer<typeof PoolBreachRollupSchema>;

// ---------------------------------------------------------------------------
// POOL_CONFIG_EXT
// ---------------------------------------------------------------------------

export const PoolConfigExtRowSchema = z.object({
  id: z.string(),
  rebalanceReward: z.number().optional(),
});

export const PoolConfigExtSchema = z.object({
  Pool: z.array(PoolConfigExtRowSchema),
});

export type PoolConfigExtResponse = z.infer<typeof PoolConfigExtSchema>;

// ---------------------------------------------------------------------------
// POOL_DETAIL_WITH_HEALTH  (primary pool-page query)
// ---------------------------------------------------------------------------

export const PoolDetailRowSchema = z.object({
  id: z.string(),
  chainId: z.number(),
  token0: z.string().nullable(),
  token1: z.string().nullable(),
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
  deviationBreachStartedAt: z.string().nullable().optional(),
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
  wrappedExchangeId: z.string().optional(),
});

export const PoolDetailWithHealthSchema = z.object({
  Pool: z.array(PoolDetailRowSchema),
});

export type PoolDetailWithHealthResponse = z.infer<
  typeof PoolDetailWithHealthSchema
>;
