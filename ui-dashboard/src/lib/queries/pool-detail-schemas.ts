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

import { z } from "zod/mini";
import { ORACLE_REPORTER_TYPES } from "@mento-protocol/config/oracle-reporters";

const OptionalStringSchema = z.optional(z.string());
const OptionalNumberSchema = z.optional(z.number());
const OptionalBooleanSchema = z.optional(z.boolean());
const NullableStringSchema = z.nullable(z.string());
const NullishNumberToUndefinedSchema = z.pipe(
  z.optional(z.nullable(z.number())),
  z.transform((value) => value ?? undefined),
);
const NullishStringToUndefinedSchema = z.pipe(
  z.optional(z.nullable(z.string())),
  z.transform((value) => value ?? undefined),
);

// ---------------------------------------------------------------------------
// POOL_BREACH_ROLLUP
// ---------------------------------------------------------------------------

const PoolBreachRollupRowSchema = z.object({
  id: z.string(),
  breachCount: OptionalNumberSchema,
  healthBinarySeconds: OptionalStringSchema,
  healthTotalSeconds: OptionalStringSchema,
});

export const PoolBreachRollupSchema = z.object({
  Pool: z.array(PoolBreachRollupRowSchema),
});

// ---------------------------------------------------------------------------
// POOL_CONFIG_EXT
// ---------------------------------------------------------------------------

const PoolConfigExtRowSchema = z.object({
  id: z.string(),
  rebalanceReward: OptionalNumberSchema,
});

export const PoolConfigExtSchema = z.object({
  Pool: z.array(PoolConfigExtRowSchema),
});

// ---------------------------------------------------------------------------
// POOL_LIQUIDITY_STRATEGIES
// ---------------------------------------------------------------------------

const PoolLiquidityStrategyRowSchema = z.object({
  id: z.string(),
  chainId: z.number(),
  poolId: z.string(),
  strategyAddress: z.string(),
  kind: z.enum(["OPEN", "CDP", "RESERVE", "UNKNOWN"]),
  active: z.boolean(),
  addedAtBlock: z.string(),
  addedAtTimestamp: z.string(),
  updatedAtBlock: z.string(),
  updatedAtTimestamp: z.string(),
});

export const PoolLiquidityStrategiesSchema = z.object({
  PoolLiquidityStrategy: z.array(PoolLiquidityStrategyRowSchema),
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
  token0: NullableStringSchema,
  token1: NullableStringSchema,
  // Decimals are queried but may be null on older indexer rows; coerce so the
  // inferred type stays compatible with Pool.token0Decimals?: number.
  token0Decimals: NullishNumberToUndefinedSchema,
  token1Decimals: NullishNumberToUndefinedSchema,
  source: z.string(),
  createdAtBlock: z.string(),
  createdAtTimestamp: z.string(),
  updatedAtBlock: z.string(),
  updatedAtTimestamp: z.string(),
  // Optional health/oracle fields — may be absent on older schema versions
  healthStatus: OptionalStringSchema,
  oracleOk: OptionalBooleanSchema,
  oraclePrice: OptionalStringSchema,
  oracleTimestamp: OptionalStringSchema,
  oracleTxHash: OptionalStringSchema,
  oracleExpiry: OptionalStringSchema,
  oracleNumReporters: OptionalNumberSchema,
  referenceRateFeedID: OptionalStringSchema,
  priceDifference: OptionalStringSchema,
  rebalanceThreshold: OptionalNumberSchema,
  lastRebalancedAt: OptionalStringSchema,
  // Hasura can return null when no breach is open; coerce to undefined so the
  // inferred type stays compatible with Pool.deviationBreachStartedAt?: string.
  deviationBreachStartedAt: NullishStringToUndefinedSchema,
  lpFee: OptionalNumberSchema,
  protocolFee: OptionalNumberSchema,
  limitStatus: OptionalStringSchema,
  limitPressure0: OptionalStringSchema,
  limitPressure1: OptionalStringSchema,
  rebalancerAddress: OptionalStringSchema,
  reserves0: OptionalStringSchema,
  reserves1: OptionalStringSchema,
  swapCount: OptionalNumberSchema,
  rebalanceCount: OptionalNumberSchema,
  // Pool cumulative counters are non-null in schema.graphql and power the
  // exact SSR all-time Volume headline. Missing values must fail parsing
  // rather than fabricate a believable $0.00 while snapshot history loads.
  notionalVolume0: z.string(),
  notionalVolume1: z.string(),
  healthTotalSeconds: OptionalStringSchema,
  hasHealthData: OptionalBooleanSchema,
  // Hasura can return null on FPMM pools; coerce to undefined for Pool compat.
  wrappedExchangeId: NullishStringToUndefinedSchema,
});

export const PoolDetailWithHealthSchema = z.object({
  Pool: z.array(PoolDetailRowSchema),
});

// ---------------------------------------------------------------------------
// POOL_THRESHOLDS_KNOWN_EXT
// ---------------------------------------------------------------------------

const PoolThresholdsKnownExtRowSchema = z.object({
  id: z.string(),
  rebalanceThresholdAbove: OptionalNumberSchema,
  rebalanceThresholdBelow: OptionalNumberSchema,
  rebalanceThresholdsKnown: OptionalBooleanSchema,
  tokenDecimalsKnown: OptionalBooleanSchema,
  degenerateReserves: OptionalBooleanSchema,
  breakerTripped: OptionalBooleanSchema,
});

export const PoolThresholdsKnownExtSchema = z.object({
  Pool: z.array(PoolThresholdsKnownExtRowSchema),
});

// ---------------------------------------------------------------------------
// POOL_VP_ORACLE_FRESHNESS_EXT
// ---------------------------------------------------------------------------

const PoolVpOracleFreshnessExtRowSchema = z.object({
  id: z.string(),
  oracleTimestamp: OptionalStringSchema,
  oracleNumReporters: OptionalNumberSchema,
  tokenDecimalsKnown: OptionalBooleanSchema,
  lastOracleReportAt: OptionalStringSchema,
  medianLive: OptionalBooleanSchema,
  oracleFreshnessWindow: OptionalStringSchema,
});

export const PoolVpOracleFreshnessExtSchema = z.object({
  Pool: z.array(PoolVpOracleFreshnessExtRowSchema),
});

// ---------------------------------------------------------------------------
// POOL_VP_DEPRECATION_EXT
// ---------------------------------------------------------------------------

const PoolVpDeprecationExtRowSchema = z.object({
  id: z.string(),
  isDeprecated: OptionalBooleanSchema,
  minimumReports: OptionalStringSchema,
});

export const PoolVpDeprecationExtSchema = z.object({
  BiPoolExchange: z.array(PoolVpDeprecationExtRowSchema),
});

// ---------------------------------------------------------------------------
// POOL_VP_LIFECYCLE_DEPRECATION_EXT
// ---------------------------------------------------------------------------

const PoolVpLifecycleDeprecationExtRowSchema = z.object({
  id: z.string(),
  poolId: OptionalStringSchema,
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
  pricingModuleName: NullableStringSchema,
  spread: z.string(),
  referenceRateFeedID: z.string(),
  referenceRateResetFrequency: z.string(),
  minimumReports: z.string(),
  stablePoolResetSize: z.string(),
  bucket0: z.string(),
  bucket1: z.string(),
  lastBucketUpdate: z.string(),
  isDeprecated: z.boolean(),
  wrappedByPoolId: NullableStringSchema,
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
  smoothingFactor: NullableStringSchema,
  medianRatesEMA: NullableStringSchema,
  referenceValue: NullableStringSchema,
  lastMedianRate: NullableStringSchema,
  lastUpdatedAt: NullableStringSchema,
  status: z.enum(["OK", "TRIPPED"]),
  tradingMode: z.number(),
  lastStatusUpdatedAt: z.string(),
  cooldownEndsAt: z.string(),
  lastTripAt: NullableStringSchema,
  lastTripTxHash: NullableStringSchema,
  lastResetAt: NullableStringSchema,
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
  referenceAtTrip: NullableStringSchema,
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
