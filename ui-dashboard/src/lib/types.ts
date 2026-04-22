/**
 * Chain IDs for production mainnet networks on the multichain indexer.
 * These are safe to import in API routes (no NEXT_PUBLIC_* side effects).
 * Keep in sync with mainnet network entries in src/lib/networks.ts:
 *   - celo-mainnet → 42220
 *   - monad-mainnet → 143
 */
export const MAINNET_CHAIN_IDS = [42220, 143] as const;

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
  limitStatus?: string;
  limitPressure0?: string;
  limitPressure1?: string;
  rebalancerAddress?: string;
  rebalanceLivenessStatus?: string;
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
  lastOracleSnapshotTimestamp?: string;
  lastDeviationRatio?: string;
  hasHealthData?: boolean;
};

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
  peakPriceDifference: string;
  peakAt: string;
  peakAtBlock: string;
  startedByEvent: string;
  startedByTxHash: string;
  endedByEvent: string | null;
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
  healthBinaryValue?: string;
  hasHealthData?: boolean;
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
  effectivenessRatio?: string;
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

export type ProtocolFeeTransfer = {
  chainId: number;
  tokenSymbol: string;
  tokenDecimals: number;
  amount: string;
  blockTimestamp: string;
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
