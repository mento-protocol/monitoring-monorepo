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
}

// Canonical FPMM predicate. Analogous to `isVirtualPool` in
// `indexer-envio/src/helpers.ts` and `ui-dashboard/src/lib/types.ts`, but
// simplified: those check two conditions (`source.includes("virtual") ||
// wrappedExchangeId`), whereas here the GQL query's `source: { _like: "%fpmm%" }`
// filter has already excluded native VPs (`source: "virtual_pool_factory"`) at
// the query boundary, leaving `wrappedExchangeId` as the only remaining
// discriminator. A healed VirtualPool retains its original "fpmm_factory" source
// until the next re-sync, so the source filter alone is not sufficient —
// `wrappedExchangeId` is the load-bearing discriminator:
// "" = native FPMM; non-empty = healed VP. Applied once at the poller boundary
// so BOTH gauge publication (`updateMetrics`) and the rebalance probe
// (`runRebalanceProbes`) operate on FPMM-only rows from a single source of
// truth instead of each re-deriving the guard. `eligibleForProbe` also applies
// it defensively, since a leaked VP with a non-empty `rebalancerAddress` would
// otherwise publish a phantom `mento_pool_rebalance_blocked` gauge.
export function isFpmmPool(pool: PoolRow): boolean {
  return !pool.wrappedExchangeId;
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
