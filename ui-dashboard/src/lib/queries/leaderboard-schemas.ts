/**
 * Zod response schemas for leaderboard queries.
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
 * - The outer shape mirrors the GQL selection set name (entity name used as
 *   the Hasura query root), e.g. `{ TraderDailySnapshot: z.array(...) }`.
 * - Keep in sync with the corresponding queries in leaderboard.ts and the
 *   TypeScript row types in lib/leaderboard.ts / lib/leaderboard-pool.ts.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared row fragments (reused across v3 and v2 broker variants)
// ---------------------------------------------------------------------------

/** Fields shared by LEADERBOARD_TODAY_TRADERS and LEADERBOARD_YESTERDAY_TRADERS. */
const LeaderboardPartialTraderRowSchema = z.object({
  chainId: z.number(),
  trader: z.string(),
  volumeUsdWei: z.string(),
  swapCount: z.number(),
  isSystemAddress: z.boolean(),
});

/** Fields shared by LEADERBOARD_WINDOW_FIRSTDAY_LATEST variants. */
const LeaderboardWindowFirstDayRowSchema = z.object({
  chainId: z.number(),
  snapshotDay: z.string(),
  firstDayVolumeUsdWei: z.string(),
  firstDayVolumeUsdWeiIncludingSystem: z.string(),
  firstDaySwapCount: z.number(),
  firstDaySwapCountIncludingSystem: z.number(),
  firstDayExclusiveUniqueTraders: z.number(),
  firstDayExclusiveUniqueTradersIncludingSystem: z.number(),
});

/** Fields shared by LEADERBOARD_WINDOW_LATEST variants. */
const LeaderboardWindowRowSchema = z.object({
  id: z.string(),
  chainId: z.number(),
  windowKey: z.string(),
  snapshotDay: z.string(),
  windowStartDay: z.string(),
  totalVolumeUsdWei: z.string(),
  totalVolumeUsdWeiIncludingSystem: z.string(),
  totalSwapCount: z.number(),
  totalSwapCountIncludingSystem: z.number(),
  uniqueTraders: z.number(),
  uniqueTradersIncludingSystem: z.number(),
});

/** Fields shared by LEADERBOARD_PARTIAL_OVERLAP_TRADERS variants. */
const LeaderboardPartialOverlapRowSchema = z.object({
  chainId: z.number(),
  trader: z.string(),
  timestamp: z.string(),
  isSystemAddress: z.boolean(),
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
  isSystemAddress: z.boolean(),
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
// POOLS_FOR_LEADERBOARD
// ---------------------------------------------------------------------------

const PoolForLeaderboardRowSchema = z.object({
  id: z.string(),
  chainId: z.number(),
  token0: z.string().nullable(),
  token1: z.string().nullable(),
});

export const PoolsForLeaderboardSchema = z.object({
  Pool: z.array(PoolForLeaderboardRowSchema),
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
  swapCountIncludingSystem: z.number(),
  volumeUsdWei: z.string(),
  volumeUsdWeiIncludingSystem: z.string(),
});

export const PoolDailyVolumeSchema = z.object({
  PoolDailyVolumeSnapshot: z.array(PoolDailyVolumeRowSchema),
});

// ---------------------------------------------------------------------------
// AGGREGATOR_DAILY_TOP / AGGREGATOR_DAILY_TOP_INCLUDING_SYSTEM
// ---------------------------------------------------------------------------

const AggregatorDailyRowSchema = z.object({
  id: z.string(),
  chainId: z.number(),
  aggregator: z.string(),
  lastSeenAggregatorAddress: z.string(),
  timestamp: z.string(),
  swapCount: z.number(),
  swapCountIncludingSystem: z.number(),
  uniqueTraders: z.number(),
  uniqueTradersIncludingSystem: z.number(),
  volumeUsdWei: z.string(),
  volumeUsdWeiIncludingSystem: z.string(),
});

// Used for both AGGREGATOR_DAILY_TOP and AGGREGATOR_DAILY_TOP_INCLUDING_SYSTEM
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
  isSystemAddress: z.boolean(),
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
// LEADERBOARD_WINDOW_LATEST / BROKER_LEADERBOARD_WINDOW_LATEST
// ---------------------------------------------------------------------------

export const LeaderboardWindowLatestSchema = z.object({
  LeaderboardWindowSnapshot: z.array(LeaderboardWindowRowSchema),
});

export const BrokerLeaderboardWindowLatestSchema = z.object({
  BrokerLeaderboardWindowSnapshot: z.array(LeaderboardWindowRowSchema),
});

// ---------------------------------------------------------------------------
// LEADERBOARD_WINDOW_FIRSTDAY_LATEST / BROKER_LEADERBOARD_WINDOW_FIRSTDAY_LATEST
// ---------------------------------------------------------------------------

export const LeaderboardWindowFirstDayLatestSchema = z.object({
  LeaderboardWindowSnapshot: z.array(LeaderboardWindowFirstDayRowSchema),
});

export const BrokerLeaderboardWindowFirstDayLatestSchema = z.object({
  BrokerLeaderboardWindowSnapshot: z.array(LeaderboardWindowFirstDayRowSchema),
});

// ---------------------------------------------------------------------------
// LEADERBOARD_WINDOW_TRADERS_LATEST
// ---------------------------------------------------------------------------
// Isolated address-list query for the homepage Traders tile. Separated
// from LEADERBOARD_WINDOW_LATEST so a hosted Hasura "field not found"
// error during the indexer deploy+resync window degrades ONLY the
// Traders tile (which falls back to N/A) instead of taking down every
// pre-rolled KPI that depends on the parent query. Same pattern as
// LEADERBOARD_WINDOW_FIRSTDAY_LATEST.

const LeaderboardWindowTradersRowSchema = z.object({
  chainId: z.number(),
  snapshotDay: z.string(),
  windowTraders: z.array(z.string()),
});

export const LeaderboardWindowTradersLatestSchema = z.object({
  LeaderboardWindowSnapshot: z.array(LeaderboardWindowTradersRowSchema),
});

// ---------------------------------------------------------------------------
// LEADERBOARD_PARTIAL_OVERLAP_TRADERS / BROKER_LEADERBOARD_PARTIAL_OVERLAP_TRADERS
// ---------------------------------------------------------------------------

export const LeaderboardPartialOverlapTradersSchema = z.object({
  TraderDailySnapshot: z.array(LeaderboardPartialOverlapRowSchema),
});

export const BrokerLeaderboardPartialOverlapTradersSchema = z.object({
  BrokerTraderDailySnapshot: z.array(LeaderboardPartialOverlapRowSchema),
});

// ---------------------------------------------------------------------------
// LEADERBOARD_TODAY_TRADERS / BROKER_LEADERBOARD_TODAY_TRADERS
// ---------------------------------------------------------------------------

export const LeaderboardTodayTradersSchema = z.object({
  TraderDailySnapshot: z.array(LeaderboardPartialTraderRowSchema),
});

export const BrokerLeaderboardTodayTradersSchema = z.object({
  BrokerTraderDailySnapshot: z.array(LeaderboardPartialTraderRowSchema),
});

// ---------------------------------------------------------------------------
// LEADERBOARD_YESTERDAY_TRADERS / BROKER_LEADERBOARD_YESTERDAY_TRADERS
// ---------------------------------------------------------------------------

export const LeaderboardYesterdayTradersSchema = z.object({
  TraderDailySnapshot: z.array(LeaderboardPartialTraderRowSchema),
});

export const BrokerLeaderboardYesterdayTradersSchema = z.object({
  BrokerTraderDailySnapshot: z.array(LeaderboardPartialTraderRowSchema),
});
