export interface PoolRow {
  id: string;
  chainId: number;
  token0: string | null;
  token1: string | null;
  source: string;
  healthStatus: string;
  oracleOk: boolean;
  oracleTimestamp: string;
  oracleTxHash: string;
  oracleExpiry: string;
  oracleNumReporters: number;
  oracleFreshnessWindow: string;
  tokenDecimalsKnown: boolean;
  lastOracleReportAt: string;
  medianLive: boolean;
  lastDeviationRatio: string;
  deviationBreachStartedAt: string;
  currentOpenBreachPeak: string;
  currentOpenBreachEntryThreshold: number;
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
  // "" = FPMM (native pool), non-empty hex = VP (VirtualPool healed from an
  // FPMM). Filtered out by `isFpmmPool` before any gauge/probe work.
  // Schema: `Pool.wrappedExchangeId: String! @index` (schema.graphql:181).
  wrappedExchangeId: string;
  // Optional companion state from BiPoolExchange. Deprecated wrappers should
  // not publish stale VP oracle gauges because swaps are expected to stop.
  wrappedExchangeDeprecated: boolean;
  // Optional companion state from BiPoolExchange. 0 means the bridge could not
  // join the wrapped exchange config yet, so VP freshness must not publish a
  // misleading "fresh" sample.
  wrappedExchangeMinimumReports: string;
}

export function isVirtualPool(pool: PoolRow): boolean {
  return pool.source.includes("virtual") || Boolean(pool.wrappedExchangeId);
}

// Canonical FPMM predicate. Analogous to `isVirtualPool` in
// `indexer-envio/src/helpers.ts` and `ui-dashboard/src/lib/types.ts`.
// "" = native FPMM; non-empty or virtual source = VP. Applied before FPMM-only
// gauges and rebalance probes so VPs only publish their dedicated freshness
// metric.
export function isFpmmPool(pool: PoolRow): boolean {
  return !isVirtualPool(pool);
}

export interface BridgePoolsResponse {
  Pool: PoolRow[];
}

// ── CDP (Liquity v2) rows ──────────────────────────────────────────────────
// One `LiquityInstance` per CDP market (GBPm / CHFm / JPYm on Celo). BigInt
// columns arrive as decimal strings over GraphQL; Int columns as numbers.
// `spHeadroom = spDeposits − MIN_BOLD_IN_SP` (signed; −1 wei sentinel until
// SystemParams is loaded — gate on the collateral's `systemParamsLoaded`).
export interface LiquityInstanceRow {
  id: string;
  collateralId: string;
  chainId: number;
  systemDebt: string;
  spDeposits: string;
  spHeadroom: string;
  isShutDown: boolean;
  liqCountCum: number;
  redemptionCountCum: number;
  rebalanceRedemptionCountCum: number;
  shortfallSubsidyCum: string;
}

// `LiquityCollateral` carries the per-market identity + immutable SystemParams
// snapshot. Joined to its instance by `LiquityCollateral.id === instance.collateralId`.
export interface LiquityCollateralRow {
  id: string;
  symbol: string;
  chainId: number;
  troveManager: string;
  debtToken: string;
  systemParamsLoaded: boolean;
}

// An instance joined to its collateral — what the CDP gauge updater consumes.
export interface CdpInstance {
  instance: LiquityInstanceRow;
  collateral: LiquityCollateralRow;
}

export interface BridgeCdpsResponse {
  LiquityInstance: LiquityInstanceRow[];
  LiquityCollateral: LiquityCollateralRow[];
}
