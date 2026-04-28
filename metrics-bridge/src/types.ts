export interface PoolRow {
  id: string;
  chainId: number;
  token0: string | null;
  token1: string | null;
  source: string;
  healthStatus: string;
  oracleOk: boolean;
  oracleTimestamp: string;
  oracleExpiry: string;
  lastDeviationRatio: string;
  deviationBreachStartedAt: string;
  limitStatus: string;
  limitPressure0: string;
  limitPressure1: string;
  lastRebalancedAt: string;
  lastEffectivenessRatio: string;
  rebalanceLivenessStatus: string;
  hasHealthData: boolean;
  lpFee: number;
  protocolFee: number;
  lastOracleJumpBps: string;
  lastOracleJumpAt: string;
  reserves0: string;
  reserves1: string;
  token0Decimals: number;
  token1Decimals: number;
}

export interface BridgePoolsResponse {
  Pool: PoolRow[];
}
