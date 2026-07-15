/**
 * Zod response schemas for pool-detail queries.
 *
 * The SSR prefetch and matching client `useGQL` subscriber pass the same
 * schema object for every prefetched selection. Server parse failures degrade
 * to an absent fallback; client parse failures surface as a typed
 * `GraphQLSchemaError` through SWR's error path.
 *
 * Rules for these schemas:
 * - All Hasura scalar fields are strings (even numeric ones) unless
 *   explicitly typed otherwise (e.g. `id: z.string()`).
 * - Fields that the indexer may not have written yet are `.optional()`.
 * - The outer object keys mirror the query's selected/aliased entity names.
 * - Keep in sync with the corresponding query and TypeScript type in types.ts.
 */

import { z } from "zod";
import { ORACLE_REPORTER_TYPES } from "@mento-protocol/config/oracle-reporters";

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
// POOL_RATE_FEED_EXT
// ---------------------------------------------------------------------------

const OracleReporterTypeSchema = z.enum(ORACLE_REPORTER_TYPES);

const PoolRateFeedExtRowSchema = z.object({
  id: z.string(),
  chainId: z.number(),
  feedAddress: z.string(),
  pair: z.string(),
  reporterTypes: z.array(OracleReporterTypeSchema),
});

export const PoolRateFeedExtSchema = z.object({
  RateFeed: z.array(PoolRateFeedExtRowSchema),
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

// ---------------------------------------------------------------------------
// POOL_THRESHOLDS_KNOWN_EXT
// ---------------------------------------------------------------------------

const PoolThresholdsKnownExtRowSchema = z.object({
  id: z.string(),
  rebalanceThresholdAbove: z.number().optional(),
  rebalanceThresholdBelow: z.number().optional(),
  rebalanceThresholdsKnown: z.boolean().optional(),
  tokenDecimalsKnown: z.boolean().optional(),
  degenerateReserves: z.boolean().optional(),
  breakerTripped: z.boolean().optional(),
});

export const PoolThresholdsKnownExtSchema = z.object({
  Pool: z.array(PoolThresholdsKnownExtRowSchema),
});

// ---------------------------------------------------------------------------
// POOL_VP_ORACLE_FRESHNESS_EXT
// ---------------------------------------------------------------------------

const PoolVpOracleFreshnessExtRowSchema = z.object({
  id: z.string(),
  oracleTimestamp: z.string().optional(),
  oracleNumReporters: z.number().optional(),
  tokenDecimalsKnown: z.boolean().optional(),
  lastOracleReportAt: z.string().optional(),
  medianLive: z.boolean().optional(),
  oracleFreshnessWindow: z.string().optional(),
});

export const PoolVpOracleFreshnessExtSchema = z.object({
  Pool: z.array(PoolVpOracleFreshnessExtRowSchema),
});

// ---------------------------------------------------------------------------
// POOL_VP_DEPRECATION_EXT
// ---------------------------------------------------------------------------

const PoolVpDeprecationExtRowSchema = z.object({
  id: z.string(),
  isDeprecated: z.boolean().optional(),
  minimumReports: z.string().optional(),
});

export const PoolVpDeprecationExtSchema = z.object({
  BiPoolExchange: z.array(PoolVpDeprecationExtRowSchema),
});

// ---------------------------------------------------------------------------
// POOL_VP_LIFECYCLE_DEPRECATION_EXT
// ---------------------------------------------------------------------------

const PoolVpLifecycleDeprecationExtRowSchema = z.object({
  id: z.string(),
  poolId: z.string().optional(),
});

export const PoolVpLifecycleDeprecationExtSchema = z.object({
  VirtualPoolLifecycle: z.array(PoolVpLifecycleDeprecationExtRowSchema),
});

// ---------------------------------------------------------------------------
// POOL_V2_EXCHANGE
// ---------------------------------------------------------------------------

const PoolV2ExchangeRowSchema = z.object({
  id: z.string(),
  chainId: z.number(),
  exchangeId: z.string(),
  exchangeProvider: z.string(),
  asset0: z.string(),
  asset1: z.string(),
  pricingModule: z.string(),
  pricingModuleName: z.string().nullable(),
  spread: z.string(),
  referenceRateFeedID: z.string(),
  referenceRateResetFrequency: z.string(),
  minimumReports: z.string(),
  stablePoolResetSize: z.string(),
  bucket0: z.string(),
  bucket1: z.string(),
  lastBucketUpdate: z.string(),
  isDeprecated: z.boolean(),
  wrappedByPoolId: z.string().nullable(),
});

export const PoolV2ExchangeSchema = z.object({
  BiPoolExchange: z.array(PoolV2ExchangeRowSchema),
});

// ---------------------------------------------------------------------------
// BROKER_EXCHANGE_DAILY_SNAPSHOTS_24H
// ---------------------------------------------------------------------------

const BrokerExchangeDailySnapshot24hRowSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  volumeUsdWei: z.string(),
  swapCount: z.number(),
});

export const BrokerExchangeDailySnapshots24hSchema = z.object({
  BrokerExchangeDailySnapshot: z.array(BrokerExchangeDailySnapshot24hRowSchema),
});

// ---------------------------------------------------------------------------
// POOL_BREAKER_CONFIG
// ---------------------------------------------------------------------------

const BreakerKindSchema = z.enum([
  "MEDIAN_DELTA",
  "VALUE_DELTA",
  "MARKET_HOURS",
]);

const BreakerConfigRowSchema = z.object({
  id: z.string(),
  enabled: z.boolean(),
  cooldownTime: z.string(),
  rateChangeThreshold: z.string(),
  smoothingFactor: z.string().nullable(),
  medianRatesEMA: z.string().nullable(),
  referenceValue: z.string().nullable(),
  lastMedianRate: z.string().nullable(),
  lastUpdatedAt: z.string().nullable(),
  status: z.enum(["OK", "TRIPPED"]),
  tradingMode: z.number(),
  lastStatusUpdatedAt: z.string(),
  cooldownEndsAt: z.string(),
  lastTripAt: z.string().nullable(),
  lastTripTxHash: z.string().nullable(),
  lastResetAt: z.string().nullable(),
  tripCountLifetime: z.number(),
  breaker: z.object({
    id: z.string(),
    address: z.string(),
    kind: BreakerKindSchema,
    activatesTradingMode: z.number(),
    defaultCooldownTime: z.string(),
    defaultRateChangeThreshold: z.string(),
  }),
});

const BreakerTripEventRowSchema = z.object({
  id: z.string(),
  blockTimestamp: z.string(),
  txHash: z.string(),
  medianRateAtTrip: z.string(),
  referenceAtTrip: z.string().nullable(),
  thresholdAtTrip: z.string(),
  breaker: z.object({
    address: z.string(),
    kind: BreakerKindSchema,
  }),
});

export const PoolBreakerConfigSchema = z.object({
  BreakerConfig: z.array(BreakerConfigRowSchema),
  BreakerTripEvent: z.array(BreakerTripEventRowSchema),
});
