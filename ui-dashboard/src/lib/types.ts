export type Pool = {
  id: string;
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
};

export type OracleSnapshot = {
  id: string;
  poolId: string;
  timestamp: string;
  oraclePrice: string;
  oracleOk: boolean;
  numReporters: number;
  priceDifference: string;
  rebalanceThreshold: number;
  source: string;
  blockNumber: string;
};

export type SwapEvent = {
  id: string;
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
  poolId: string;
  kind: string;
  sender: string;
  recipient: string;
  amount0: string;
  amount1: string;
  liquidity: string;
  txHash: string;
  blockNumber: string;
  blockTimestamp: string;
};

export type ReserveUpdate = {
  id: string;
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
  poolId: string;
  sender: string;
  caller: string;
  priceDifferenceBefore: string;
  priceDifferenceAfter: string;
  txHash: string;
  blockNumber: string;
  blockTimestamp: string;
  rebalancerAddress?: string;
  improvement?: string;
  effectivenessRatio?: string;
};

export type PoolSnapshot24h = {
  poolId: string;
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
  tokenSymbol: string;
  tokenDecimals: number;
  amount: string;
  blockTimestamp: string;
};

export type OlsPool = {
  id: string;
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
