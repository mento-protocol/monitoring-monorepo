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
  lastMedianPrice: string;
  prevMedianPrice: string;
  prevMedianAt: string;
  lastOracleJumpBps: string;
  lastOracleJumpAt: string;
  reserves0: string;
  reserves1: string;
  token0Decimals: number;
  token1Decimals: number;
  // Liquidity strategy address — needed by the metrics-bridge rebalance probe
  // to simulate `rebalance(pool)` and decode the revert reason. The
  // `Pool.rebalancerAddress` column is `String!` in the indexer schema
  // (`indexer-envio/schema.graphql:95`), so this field is always populated
  // in the GraphQL response.
  rebalancerAddress: string;
  latestRebalanceTxHash: string;
}

export interface BridgePoolsResponse {
  Pool: PoolRow[];
}
