/**
 * Chain IDs for production mainnet networks on the multichain indexer.
 * These are safe to import in API routes (no NEXT_PUBLIC_* side effects).
 * Keep in sync with mainnet network entries in src/lib/networks.ts:
 *   - celo-mainnet → 42220
 *   - monad-mainnet → 143
 */
export const MAINNET_CHAIN_IDS = [42220, 143] as const;

/** True when the pool is a VirtualPool (no oracle, no fees, no rebalance
 * mechanics). Mirrors `isVirtualPool` in `indexer-envio/src/helpers.ts`;
 * keep both in lockstep. */
export function isVirtualPool(pool: { source?: string }): boolean {
  return pool.source?.includes("virtual") ?? false;
}

export type Pool = {
  id: string;
  chainId: number;
  token0: string | null;
  token1: string | null;
  source: string;
  createdAtBlock: string;
  createdAtTimestamp: string;
  updatedAtBlock: string;
  updatedAtTimestamp: string;
  // Oracle & health state (optional — only present when indexer has new schema)
  healthStatus?: string;
  oracleOk?: boolean;
  oraclePrice?: string;
  oracleTimestamp?: string;
  oracleTxHash?: string;
  oracleExpiry?: string;
  oracleNumReporters?: number;
  referenceRateFeedID?: string;
  priceDifference?: string;
  rebalanceThreshold?: number;
  lastRebalancedAt?: string;
  deviationBreachStartedAt?: string;
  lpFee?: number;
  protocolFee?: number;
  rebalanceReward?: number;
  limitStatus?: string;
  limitPressure0?: string;
  limitPressure1?: string;
  rebalancerAddress?: string;
  token0Decimals?: number;
  token1Decimals?: number;
  swapCount?: number;
  rebalanceCount?: number;
  notionalVolume0?: string;
  notionalVolume1?: string;
  reserves0?: string;
  reserves1?: string;
  healthTotalSeconds?: string;
  healthBinarySeconds?: string;
  hasHealthData?: boolean;
  breachCount?: number;
  // Set on VirtualPools at deploy time via bytecode extraction (PUSH32
  // immediates in swap() preamble). Joins to BiPoolExchange.exchangeId in
  // the POOL_V2_EXCHANGE query. Null on FPMM pools and on VPs whose
  // deploy-time RPC failed (the next event's self-heal is not wired here —
  // tracked as Phase 2 follow-up if any pre-Phase-2 VP shows up missing it).
  wrappedExchangeId?: string;
};

/**
 * User-facing categories for breach start/end causes. Kept in lockstep
 * with `BreachEventCategory` in `indexer-envio/src/deviationBreach.ts` —
 * indexer and UI can't share TS types directly (indexer codegen via
 * rescript + shared-config is JSON), so this mirror is the source of
 * truth for the UI side. A new category has to be added in both places.
 */
export type BreachEventCategory =
  | "rebalance"
  | "swap"
  | "liquidity"
  | "oracle_update"
  | "threshold_change"
  | "unknown";

/**
 * One historical deviation-threshold breach for a pool. Emitted by the
 * indexer on the rising edge, closed on the falling edge. Durations are
 * trading-seconds (weekend-aware). See
 * indexer-envio/schema.graphql → `DeviationThresholdBreach`.
 */
export type DeviationThresholdBreach = {
  id: string;
  chainId: number;
  poolId: string;
  startedAt: string;
  startedAtBlock: string;
  /** Null while the breach is still open. */
  endedAt: string | null;
  endedAtBlock: string | null;
  durationSeconds: string | null;
  criticalDurationSeconds: string | null;
  entryPriceDifference: string;
  /** rebalanceThreshold in bps captured at the rising edge. Used for breach
   * severity scoring (peak vs 1.05x) so a mid-breach threshold change can't
   * retroactively shift the magnitude verdict. Optional during the indexer
   * resync window when the new column hasn't backfilled yet. */
  entryRebalanceThreshold?: number;
  peakPriceDifference: string;
  peakAt: string;
  peakAtBlock: string;
  startedByEvent: BreachEventCategory;
  startedByTxHash: string;
  endedByEvent: BreachEventCategory | null;
  endedByTxHash: string | null;
  endedByStrategy: string | null;
  rebalanceCountDuring: number;
};

export type OracleSnapshot = {
  id: string;
  chainId: number;
  poolId: string;
  timestamp: string;
  oraclePrice: string;
  oracleOk: boolean;
  numReporters: number;
  priceDifference: string;
  rebalanceThreshold: number;
  source: string;
  blockNumber: string;
  txHash: string;
  deviationRatio?: string;
  hasHealthData?: boolean;
};

type VirtualPoolLifecycleAction = "DEPLOYED" | "DEPRECATED";

export type VirtualPoolLifecycle = {
  id: string;
  action: VirtualPoolLifecycleAction;
  factoryAddress: string;
  txHash: string;
  blockNumber: string;
  blockTimestamp: string;
};

// Mento v2 BiPoolManager exchange row, returned by the POOL_V2_EXCHANGE
// GraphQL query (joined to Pool via `Pool.wrappedExchangeId`). All BigInt
// fields ride as decimal strings — that's how Hasura serializes
// `precision:78` columns over JSON; convert with `BigInt(...)` at the use
// site when arithmetic is needed.
export type BiPoolExchangeRow = {
  id: string;
  chainId: number;
  exchangeId: string;
  exchangeProvider: string;
  asset0: string;
  asset1: string;
  pricingModule: string;
  /** Friendly label resolved by the indexer at write time (e.g.
   * "ConstantSum"). `null`/missing for pricing modules not in the
   * `@mento-protocol/contracts` package — UI renders an em-dash. */
  pricingModuleName: string | null;
  /** FixidityLib 1e24 unit. Divide by 1e24 for the swap-fee fraction
   * (e.g. `5e21 = 0.005 = 50 bps`). */
  spread: string;
  referenceRateFeedID: string;
  referenceRateResetFrequency: string;
  minimumReports: string;
  stablePoolResetSize: string;
  bucket0: string;
  bucket1: string;
  lastBucketUpdate: string;
  isDeprecated: boolean;
  /** poolId of the VirtualPool that wraps this exchange. `null` for v2-only
   * exchanges (legacy direct trading via Broker, no v3 wrapper). */
  wrappedByPoolId: string | null;
};

export type SwapEvent = {
  id: string;
  chainId: number;
  poolId: string;
  sender: string;
  recipient: string;
  amount0In: string;
  amount1In: string;
  amount0Out: string;
  amount1Out: string;
  txHash: string;
  blockNumber: string;
  blockTimestamp: string;
};

export type LiquidityEvent = {
  id: string;
  chainId: number;
  poolId: string;
  kind: string;
  sender: string;
  amount0: string;
  amount1: string;
  liquidity: string;
  txHash: string;
  blockNumber: string;
  blockTimestamp: string;
};

export type ReserveUpdate = {
  id: string;
  chainId: number;
  poolId: string;
  reserve0: string;
  reserve1: string;
  blockTimestampInPool: string;
  txHash: string;
  blockNumber: string;
  blockTimestamp: string;
};

export type PoolSnapshot = {
  id: string;
  poolId: string;
  timestamp: string;
  reserves0: string;
  reserves1: string;
  swapCount: number;
  swapVolume0: string;
  swapVolume1: string;
  rebalanceCount: number;
  cumulativeSwapCount: number;
  cumulativeVolume0: string;
  cumulativeVolume1: string;
  blockNumber: string;
};

export type RebalanceEvent = {
  id: string;
  chainId: number;
  poolId: string;
  sender: string;
  caller: string;
  priceDifferenceBefore: string;
  priceDifferenceAfter: string;
  txHash: string;
  blockNumber: string;
  blockTimestamp: string;
  improvement?: string;
  // `rebalanceThreshold` (bps) at the time of the rebalance. Used by the
  // Rebalance tab to label the new boundary-relative effectiveness ratio.
  // Optional because it's a schema addition — rows indexed before the schema
  // bump surface as null until Envio reprocesses the backfill.
  rebalanceThreshold?: number;
  effectivenessRatio?: string;
  // Token deltas across the rebalance (signed wei strings; positive = pool
  // received). Optional during indexer resync — pre-existing rows lack them.
  amount0Delta?: string;
  amount1Delta?: string;
  // `Pool.rebalanceReward` snapshot at event time (bps). Optional during resync.
  rewardBps?: number;
  // Pre-computed USD values, fixed-point 4dp strings (e.g. "1234.5678"). Empty
  // string sentinel when uncomputable (no USD-pegged side / RPC failure).
  notionalUsd?: string;
  rewardUsd?: string;
};

export type PoolSnapshotWindow = {
  poolId: string;
  timestamp: string;
  reserves0: string;
  reserves1: string;
  swapCount: number;
  swapVolume0: string;
  swapVolume1: string;
};

export type TradingLimit = {
  id: string;
  poolId: string;
  token: string;
  limit0: string;
  limit1: string;
  decimals: number;
  netflow0: string;
  netflow1: string;
  lastUpdated0: string;
  lastUpdated1: string;
  limitPressure0: string;
  limitPressure1: string;
  limitStatus: string;
  updatedAtBlock: string;
  updatedAtTimestamp: string;
};

export type LiquidityPosition = {
  id: string;
  poolId: string;
  address: string;
  netLiquidity: string; // BigInt serialized as string
  lastUpdatedBlock: string;
  lastUpdatedTimestamp: string;
};

/**
 * Daily rollup of pool-level protocol fee transfers, one row per
 * (chainId, poolAddress, UTC day). Source of truth for every fee surface
 * on /revenue (KPI tile, chart, per-pool leaderboard) — pool×day
 * cardinality stays within a few thousand rows even at all-time scale,
 * so we paginate the full history cleanly. See
 * `indexer-envio/schema.graphql` → `PoolDailyFeeSnapshot`.
 *
 * Hybrid USD pricing: `feesUsdWei` carries USD-pegged tokens converted indexer-side
 * (18-dp USD-wei BigInt). Non-pegged FX tokens are dashboard-priced from the parallel
 * `tokens[]` / `tokenSymbols[]` / `tokenDecimals[]` / `amounts[]` arrays via the live
 * oracle rate map.
 */
export type PoolDailyFeeSnapshot = {
  id: string;
  chainId: number;
  poolAddress: string;
  /** UTC day bucket, in seconds (`(ts / 86400) * 86400`). BigInt as decimal string. */
  timestamp: string;
  tokens: string[];
  tokenSymbols: string[];
  tokenDecimals: number[];
  /** Raw token-native amounts, summed per day per token. BigInt as decimal string. */
  amounts: string[];
  /** USD-pegged subset only, 18-dp USD-wei BigInt as decimal string. */
  feesUsdWei: string;
  // Other entity fields (`poolId`, `allPegged`, `unresolvedCount`, `transferCount`,
  // `blockNumber`, `updatedAtTimestamp`) exist in `schema.graphql` but the dashboard
  // does not read them, so they are intentionally omitted from
  // `POOL_DAILY_FEE_SNAPSHOTS_PAGE` to shrink the paginated payload.
};

export type OlsPool = {
  id: string;
  chainId: number;
  poolId: string;
  olsAddress: string;
  isActive: boolean;
  debtToken: string;
  rebalanceCooldown: string;
  lastRebalance: string;
  protocolFeeRecipient: string;
  liquiditySourceIncentiveExpansion: string;
  liquiditySourceIncentiveContraction: string;
  protocolIncentiveExpansion: string;
  protocolIncentiveContraction: string;
  olsRebalanceCount: number;
  addedAtBlock: string;
  addedAtTimestamp: string;
  updatedAtBlock: string;
  updatedAtTimestamp: string;
};

export type OlsLiquidityEvent = {
  id: string;
  chainId: number;
  poolId: string;
  olsAddress: string;
  direction: number;
  tokenGivenToPool: string;
  amountGivenToPool: string;
  tokenTakenFromPool: string;
  amountTakenFromPool: string;
  caller: string;
  txHash: string;
  blockNumber: string;
  blockTimestamp: string;
};

// Bridge Flows — generic (provider-agnostic) core

export type BridgeProvider = "WORMHOLE";

export type BridgeStatus =
  | "PENDING"
  | "SENT"
  | "ATTESTED"
  | "DELIVERED"
  | "QUEUED_INBOUND"
  | "CANCELLED"
  | "FAILED";

// Derived client-side overlay: a SENT or ATTESTED transfer older than 24h.
export type BridgeStatusOverlay = BridgeStatus | "STUCK";

export type BridgeTransfer = {
  id: string; // "{provider}-{providerMessageId}"
  provider: BridgeProvider;
  providerMessageId: string;
  status: BridgeStatus;
  tokenSymbol: string;
  tokenAddress: string;
  tokenDecimals: number;
  sourceChainId: number | null;
  sourceContract: string | null;
  destChainId: number | null;
  destContract: string | null;
  sender: string | null;
  recipient: string | null;
  amount: string | null; // BigInt serialized as decimal string
  sentBlock: string | null;
  sentTimestamp: string | null;
  sentTxHash: string | null;
  attestationCount: number;
  firstAttestedTimestamp: string | null;
  lastAttestedTimestamp: string | null;
  deliveredBlock: string | null;
  deliveredTimestamp: string | null;
  deliveredTxHash: string | null;
  cancelledTimestamp: string | null;
  failedReason: string | null;
  usdPriceAtSend: string | null;
  usdValueAtSend: string | null;
  firstSeenAt: string;
  lastUpdatedAt: string;
};

export type BridgeBridger = {
  id: string;
  sender: string;
  totalSentCount: number;
  totalSentUsd: string | null;
  sourceChainsUsed: string; // JSON array of chainIds
  tokensUsed: string; // JSON array of token symbols
  providersUsed: string; // JSON array of providers
  firstSeenAt: string;
  lastSeenAt: string;
};

// =============================================================================
// Circuit breakers — see indexer-envio/schema.graphql for the source of truth.
// =============================================================================

type BreakerKind = "MEDIAN_DELTA" | "VALUE_DELTA" | "MARKET_HOURS";
type BreakerStatus = "OK" | "TRIPPED";

/** One row per (chainId, breakerAddress). */
type Breaker = {
  id: string;
  address: string;
  kind: BreakerKind;
  /** Trading mode this breaker OR's into rateFeedTradingMode when tripped
   * (production: 3 = halt). */
  activatesTradingMode: number;
  defaultCooldownTime: string; // BigInt → string (seconds)
  defaultRateChangeThreshold: string; // BigInt → string (Fixidity 1e24=100%)
};

/** One row per (chainId, breakerAddress, rateFeedID). Per-feed config + live
 * state. The dashboard reads this for the `<BreakerPanel />` strip. */
export type BreakerConfig = {
  id: string;
  enabled: boolean;
  /** Per-feed cooldown override; sentinel "0" inherits Breaker.defaultCooldownTime. */
  cooldownTime: string;
  /** Per-feed threshold override; sentinel "0" inherits Breaker.defaultRateChangeThreshold. */
  rateChangeThreshold: string;
  /** MedianDelta-only — null on VALUE_DELTA / MARKET_HOURS. */
  smoothingFactor: string | null;
  /** MedianDelta-only. "0" = uninitialized; the next MedianUpdated will seed. */
  medianRatesEMA: string | null;
  /** ValueDelta-only — fixed peg target. */
  referenceValue: string | null;
  /** Last oracle median we mirrored from MedianUpdated. */
  lastMedianRate: string | null;
  lastUpdatedAt: string | null;
  status: BreakerStatus;
  /** Effective trading mode contributed by THIS breaker (0 if OK, else
   * Breaker.activatesTradingMode). The pool's effective tradingMode is the
   * OR of all enabled BreakerConfig.tradingMode rows for its rateFeedID. */
  tradingMode: number;
  /** = on-chain BreakerStatus.lastUpdatedTime; drives cooldown timing. */
  lastStatusUpdatedAt: string;
  /** Pre-rolled `lastStatusUpdatedAt + cooldownTime`. */
  cooldownEndsAt: string;
  lastTripAt: string | null;
  lastTripTxHash: string | null;
  lastResetAt: string | null;
  tripCountLifetime: number;
  breaker: Breaker;
};

/** One row per BreakerTripped event — snapshot of trip-time values. */
export type BreakerTripEvent = {
  id: string;
  blockTimestamp: string;
  txHash: string;
  medianRateAtTrip: string;
  /** EMA at trip time for MedianDelta; referenceValue for ValueDelta;
   * null on MARKET_HOURS (which doesn't trip via this path). */
  referenceAtTrip: string | null;
  thresholdAtTrip: string;
  breaker: Pick<Breaker, "address" | "kind">;
};

export type BridgeDailySnapshot = {
  id: string;
  date: string;
  provider: BridgeProvider;
  tokenSymbol: string;
  sourceChainId: number;
  destChainId: number;
  sentCount: number;
  deliveredCount: number;
  cancelledCount: number;
  sentVolume: string;
  deliveredVolume: string;
  sentUsdValue: string | null;
  updatedAt: string;
};
