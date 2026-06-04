/**
 * Zod response schemas for volume queries.
 *
 * When passed to useGQL's `schema` option, a parse failure surfaces as a
 * typed `GraphQLSchemaError` via SWR's error path instead of silently
 * rendering `undefined`. This turns silent Hasura schema-drift bugs into
 * typed errors caught at fetch time.
 *
 * Rules for these schemas:
 * - All Hasura "numeric" scalar fields come back as strings in JSON.
 * - `chainId` is a plain Postgres integer → z.number().
 * - Fields that the indexer may not have written yet are `.optional()`.
 * - The outer shape mirrors each GQL selection set name. Some queries alias
 *   persisted Hasura entity names to volume-specific response keys.
 * - Keep in sync with the corresponding queries in volume.ts and the
 *   TypeScript row types in lib/volume.ts / lib/volume-pool.ts.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared row fragments (reused across v3 and v2 broker variants)
// ---------------------------------------------------------------------------

/** Fields shared by VOLUME_TODAY_TRADERS and VOLUME_YESTERDAY_TRADERS. */
const VolumePartialTraderRowSchema = z.object({
  chainId: z.number(),
  trader: z.string(),
  volumeUsdWei: z.string(),
  swapCount: z.number(),
  isProtocolActor: z.boolean(),
});

/** Fields shared by VOLUME_WINDOW_FIRSTDAY_LATEST variants. */
const VolumeWindowFirstDayRowSchema = z.object({
  chainId: z.number(),
  snapshotDay: z.string(),
  firstDayVolumeUsdWei: z.string(),
  firstDayVolumeUsdWeiIncludingProtocolActors: z.string(),
  firstDaySwapCount: z.number(),
  firstDaySwapCountIncludingProtocolActors: z.number(),
  firstDayExclusiveUniqueTraders: z.number(),
  firstDayExclusiveUniqueTradersIncludingProtocolActors: z.number(),
});

/** Fields shared by VOLUME_WINDOW_LATEST variants. */
const VolumeWindowRowSchema = z.object({
  id: z.string(),
  chainId: z.number(),
  windowKey: z.string(),
  snapshotDay: z.string(),
  windowStartDay: z.string(),
  totalVolumeUsdWei: z.string(),
  totalVolumeUsdWeiIncludingProtocolActors: z.string(),
  totalSwapCount: z.number(),
  totalSwapCountIncludingProtocolActors: z.number(),
  uniqueTraders: z.number(),
  uniqueTradersIncludingProtocolActors: z.number(),
});

/** Fields shared by VOLUME_PARTIAL_OVERLAP_TRADERS variants. */
const VolumePartialOverlapRowSchema = z.object({
  chainId: z.number(),
  trader: z.string(),
  timestamp: z.string(),
  isProtocolActor: z.boolean(),
});

// ---------------------------------------------------------------------------
// TRADER_DAILY_TOP / TRADER_DAILY_WINDOW_TOP
// ---------------------------------------------------------------------------

const TraderDailyRowSchema = z.object({
  id: z.string(),
  chainId: z.number(),
  trader: z.string(),
  timestamp: z.string(),
  swapCount: z.number(),
  uniquePools: z.number(),
  volumeUsdWei: z.string(),
  feesPaidUsdWei: z.string(),
  isProtocolActor: z.boolean(),
  aggregatorKeys: z.array(z.string()).default([]),
  lastSeenTimestamp: z.string(),
});

export const TraderDailyTopSchema = z.object({
  TraderDailySnapshot: z.array(TraderDailyRowSchema),
});

// Same row shape as TraderDailyTopSchema — both query TRADER_DAILY_TOP and
// TRADER_DAILY_WINDOW_TOP select the identical field set from
// TraderDailySnapshot. Two named exports let call sites document intent.
export const TraderDailyWindowTopSchema = z.object({
  TraderDailySnapshot: z.array(TraderDailyRowSchema),
});

// ---------------------------------------------------------------------------
// TRADER_POOL_DAILY_FOR_TRADER / TRADER_POOL_DAILY_TOP
// ---------------------------------------------------------------------------

const TraderPoolDailyRowSchema = z.object({
  id: z.string(),
  chainId: z.number(),
  trader: z.string(),
  poolId: z.string(),
  timestamp: z.string(),
  swapCount: z.number(),
  volumeUsdWei: z.string(),
  inflowToken0UsdWei: z.string(),
  outflowToken0UsdWei: z.string(),
  inflowToken1UsdWei: z.string(),
  outflowToken1UsdWei: z.string(),
  feesPaidUsdWei: z.string(),
});

export const TraderPoolDailyForTraderSchema = z.object({
  TraderPoolDailySnapshot: z.array(TraderPoolDailyRowSchema),
});

export const TraderPoolDailyTopSchema = z.object({
  TraderPoolDailySnapshot: z.array(TraderPoolDailyRowSchema),
});

// ---------------------------------------------------------------------------
// SWAP_EVENT_OUTLIERS
// ---------------------------------------------------------------------------

const SwapOutlierRowSchema = z.object({
  id: z.string(),
  chainId: z.number(),
  poolId: z.string(),
  caller: z.string(),
  txTo: z.string(),
  recipient: z.string(),
  volumeUsdWei: z.string(),
  txHash: z.string(),
  blockTimestamp: z.string(),
});

export const SwapEventOutliersSchema = z.object({
  SwapEvent: z.array(SwapOutlierRowSchema),
});

// ---------------------------------------------------------------------------
// POOLS_FOR_VOLUME
// ---------------------------------------------------------------------------

const PoolForVolumeRowSchema = z.object({
  id: z.string(),
  chainId: z.number(),
  token0: z.string().nullable(),
  token1: z.string().nullable(),
});

export const PoolsForVolumeSchema = z.object({
  Pool: z.array(PoolForVolumeRowSchema),
});

// ---------------------------------------------------------------------------
// POOL_DAILY_VOLUME
// ---------------------------------------------------------------------------

const PoolDailyVolumeRowSchema = z.object({
  id: z.string(),
  chainId: z.number(),
  poolId: z.string(),
  timestamp: z.string(),
  swapCount: z.number(),
  swapCountIncludingProtocolActors: z.number(),
  volumeUsdWei: z.string(),
  volumeUsdWeiIncludingProtocolActors: z.string(),
});

export const PoolDailyVolumeSchema = z.object({
  PoolDailyVolumeSnapshot: z.array(PoolDailyVolumeRowSchema),
});

// ---------------------------------------------------------------------------
// AGGREGATOR_DAILY_TOP / AGGREGATOR_DAILY_TOP_INCLUDING_PROTOCOL_ACTORS
// ---------------------------------------------------------------------------

const AggregatorDailyRowSchema = z.object({
  id: z.string(),
  chainId: z.number(),
  aggregator: z.string(),
  lastSeenAggregatorAddress: z.string(),
  timestamp: z.string(),
  swapCount: z.number(),
  swapCountIncludingProtocolActors: z.number(),
  uniqueTraders: z.number(),
  uniqueTradersIncludingProtocolActors: z.number(),
  volumeUsdWei: z.string(),
  volumeUsdWeiIncludingProtocolActors: z.string(),
});

// Used for both AGGREGATOR_DAILY_TOP and AGGREGATOR_DAILY_TOP_INCLUDING_PROTOCOL_ACTORS
// queries — they select the same fields from AggregatorDailySnapshot and differ
// only in their WHERE/ORDER_BY clause, not the response shape.
export const AggregatorDailyTopSchema = z.object({
  AggregatorDailySnapshot: z.array(AggregatorDailyRowSchema),
});

// ---------------------------------------------------------------------------
// BROKER_TRADER_DAILY_TOP
// ---------------------------------------------------------------------------

const BrokerTraderDailyRowSchema = z.object({
  id: z.string(),
  chainId: z.number(),
  // GQL alias `trader: caller` — Hasura serialises the aliased field as "trader"
  trader: z.string(),
  timestamp: z.string(),
  swapCount: z.number(),
  volumeUsdWei: z.string(),
  isProtocolActor: z.boolean(),
  lastSeenTimestamp: z.string(),
});

export const BrokerTraderDailyTopSchema = z.object({
  BrokerTraderDailySnapshot: z.array(BrokerTraderDailyRowSchema),
});

// ---------------------------------------------------------------------------
// BROKER_AGGREGATOR_DAILY_TOP
// ---------------------------------------------------------------------------

const BrokerAggregatorDailyRowSchema = z.object({
  id: z.string(),
  chainId: z.number(),
  aggregator: z.string(),
  lastSeenAggregatorAddress: z.string(),
  timestamp: z.string(),
  swapCount: z.number(),
  uniqueTraders: z.number(),
  volumeUsdWei: z.string(),
});

export const BrokerAggregatorDailyTopSchema = z.object({
  BrokerAggregatorDailySnapshot: z.array(BrokerAggregatorDailyRowSchema),
});

// ---------------------------------------------------------------------------
// VOLUME_WINDOW_LATEST / BROKER_VOLUME_WINDOW_LATEST
// ---------------------------------------------------------------------------

export const VolumeWindowLatestSchema = z.object({
  volumeWindowSnapshots: z.array(VolumeWindowRowSchema),
});

export const BrokerVolumeWindowLatestSchema = z.object({
  brokerVolumeWindowSnapshots: z.array(VolumeWindowRowSchema),
});

// ---------------------------------------------------------------------------
// VOLUME_WINDOW_FIRSTDAY_LATEST / BROKER_VOLUME_WINDOW_FIRSTDAY_LATEST
// ---------------------------------------------------------------------------

export const VolumeWindowFirstDayLatestSchema = z.object({
  volumeWindowFirstDaySnapshots: z.array(VolumeWindowFirstDayRowSchema),
});

export const BrokerVolumeWindowFirstDayLatestSchema = z.object({
  brokerVolumeWindowFirstDaySnapshots: z.array(VolumeWindowFirstDayRowSchema),
});

// ---------------------------------------------------------------------------
// VOLUME_WINDOW_TRADERS_LATEST
// ---------------------------------------------------------------------------
// Isolated address-list query for the homepage Traders tile. Separated
// from VOLUME_WINDOW_LATEST so a hosted Hasura "field not found"
// error during the indexer deploy+resync window degrades ONLY the
// Traders tile (which falls back to N/A) instead of taking down every
// pre-rolled KPI that depends on the parent query. Same pattern as
// VOLUME_WINDOW_FIRSTDAY_LATEST.

const VolumeWindowTradersRowSchema = z.object({
  chainId: z.number(),
  snapshotDay: z.string(),
  windowTraders: z.array(z.string()),
});

export const VolumeWindowTradersLatestSchema = z.object({
  volumeWindowTraderSnapshots: z.array(VolumeWindowTradersRowSchema),
});

// ---------------------------------------------------------------------------
// VOLUME_PARTIAL_OVERLAP_TRADERS / BROKER_VOLUME_PARTIAL_OVERLAP_TRADERS
// ---------------------------------------------------------------------------

export const VolumePartialOverlapTradersSchema = z.object({
  volumePartialOverlapTraders: z.array(VolumePartialOverlapRowSchema),
});

export const BrokerVolumePartialOverlapTradersSchema = z.object({
  brokerVolumePartialOverlapTraders: z.array(VolumePartialOverlapRowSchema),
});

// ---------------------------------------------------------------------------
// VOLUME_TODAY_TRADERS / BROKER_VOLUME_TODAY_TRADERS
// ---------------------------------------------------------------------------

export const VolumeTodayTradersSchema = z.object({
  volumeTodayTraders: z.array(VolumePartialTraderRowSchema),
});

export const BrokerVolumeTodayTradersSchema = z.object({
  brokerVolumeTodayTraders: z.array(VolumePartialTraderRowSchema),
});

// ---------------------------------------------------------------------------
// VOLUME_YESTERDAY_TRADERS / BROKER_VOLUME_YESTERDAY_TRADERS
// ---------------------------------------------------------------------------

export const VolumeYesterdayTradersSchema = z.object({
  volumeYesterdayTraders: z.array(VolumePartialTraderRowSchema),
});

export const BrokerVolumeYesterdayTradersSchema = z.object({
  brokerVolumeYesterdayTraders: z.array(VolumePartialTraderRowSchema),
});
