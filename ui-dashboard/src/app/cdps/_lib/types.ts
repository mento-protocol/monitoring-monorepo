export type CdpCollateral = {
  id: string;
  chainId: number;
  collIndex: number;
  symbol: string;
  debtToken: string;
  collToken: string;
  troveManager: string;
  stabilityPool: string;
  minDebt: string;
  minBoldInSp: string;
  systemParamsLoaded: boolean;
  mcrBps: number;
  ccrBps: number;
  scrBps: number;
};

export type CdpInstance = {
  id: string;
  collateralId: string;
  chainId: number;
  systemColl: string;
  systemDebt: string;
  tcrBps: number;
  spDeposits: string;
  spColl: string;
  spHeadroom: string;
  currentRedemptionRateBps: number;
  activeTroveCount: number;
  icrP1Bps: number;
  icrP5Bps: number;
  icrP50Bps: number;
  icrFracBelowMcrBps: number;
  liqCountCum: number;
  redemptionCountCum: number;
  borrowingFeeCum: string;
  redemptionFeeCum: string;
  isShutDown: boolean;
  shutDownAt: string | null;
  shutDownTcrBps: number | null;
  lastEventBlock: string;
  lastEventTimestamp: string;
};

export type CdpTrove = {
  id: string;
  troveId: string;
  owner: string;
  status: string;
  debt: string;
  coll: string;
  icrBps: number;
  interestRate: string;
  interestBatchId: string | null;
  lastUpdatedAt: string;
  redemptionCount: number;
  redeemedDebt: string;
  redeemedColl: string;
};

/** Subset of {@link CdpTrove} fetched on the markets list page — enough to
 * compute openTroveCount + totalDebt without paying for the full row. */
export type CdpTroveListRow = {
  id: string;
  collateralId: string;
  status: string;
  debt: string;
  coll: string;
};

/** Trove status values from the indexer's `TROVE_STATUS` enum
 * (`indexer-envio/src/handlers/liquity/troves.ts`) that represent a position
 * with outstanding debt. Mirrored here intentionally — we can't import across
 * the package boundary, so a rename on either side must update both. */
export const CDP_TROVE_OPEN_STATUSES = ["active", "zombie"] as const;
export type CdpTroveOpenStatus = (typeof CDP_TROVE_OPEN_STATUSES)[number];

// Caps on the workaround GraphQL queries that pull open troves for client-side
// aggregation. Single source of truth shared between the queries and the
// completeness-check in the aggregator. When the indexer's `systemDebt` is
// resynced and the workaround is removed (see BACKLOG), drop these too.
export const CDP_TROVES_LIST_LIMIT = 500;
export const CDP_TROVES_DETAIL_LIMIT = 50;

export type CdpDepositor = {
  id: string;
  address: string;
  lastTouchedDeposit: string;
  stashedColl: string;
  lastUpdatedAt: string;
  cumulativeDeposited: string;
  cumulativeWithdrawn: string;
  yieldGainClaimedCum: string;
  ethGainClaimedCum: string;
};

export type CdpPoolRow = {
  id: string;
  poolId: string;
  debtToken: string;
  strategyAddress: string;
  rebalanceCooldownSec: number;
  addedAtTimestamp: string;
  updatedAtTimestamp: string;
};

export type CdpInstanceDailySnapshot = {
  id: string;
  timestamp: string;
  spDeposits: string;
  spColl: string;
  spHeadroom: string;
  systemDebt: string;
  systemColl: string;
};

/** `instanceId` is selected only by the cross-CDP overview query; per-market
 *  queries already filter to a single instance and don't bother projecting
 *  it. Kept optional on every event row so both consumers share types. */
export type CdpLiquidationEventRow = {
  id: string;
  instanceId?: string;
  debtOffsetBySP: string;
  debtRedistributed: string;
  boldGasCompensation: string;
  collGasCompensation: string;
  collSentToSP: string;
  collRedistributed: string;
  collSurplus: string;
  priceAtLiquidation: string;
  timestamp: string;
  blockNumber: string;
  txHash: string;
};

export type CdpRedemptionEventRow = {
  id: string;
  instanceId?: string;
  attemptedBoldAmount: string;
  actualBoldAmount: string;
  ETHSent: string;
  ETHFee: string;
  price: string;
  redemptionPrice: string;
  isRebalance: boolean;
  timestamp: string;
  blockNumber: string;
  txHash: string;
};

export type CdpSpRebalanceEventRow = {
  id: string;
  instanceId?: string;
  amountCollIn: string;
  amountStableOut: string;
  timestamp: string;
  blockNumber: string;
  txHash: string;
};

export type CdpTroveOperationEventRow = {
  id: string;
  instanceId?: string;
  troveId: string;
  /** Liquity v2 OP enum: 0=open, 1=close, 2=adjust, 3=adjustInterestRate,
   *  7=openAndJoinBatch, 8=setBatchManager, 9=removeFromBatch.
   *  LIQUIDATE / REDEEM_COLLATERAL / APPLY_PENDING_DEBT are NOT persisted
   *  here — they have dedicated entities or aren't user actions. */
  operation: number;
  /** Signed delta: positive = collateral added, negative = withdrawn. */
  collChange: string;
  /** Signed delta: positive = debt borrowed, negative = repaid. */
  debtChange: string;
  annualInterestRate: string;
  debtIncreaseFromUpfrontFee: string;
  timestamp: string;
  blockNumber: string;
  txHash: string;
};

/** Discriminated union used by the unified CDP transactions table. */
export type CdpTransactionRow =
  | ({ kind: "liquidation" } & CdpLiquidationEventRow)
  | ({ kind: "redemption" } & CdpRedemptionEventRow)
  | ({ kind: "spRebalance" } & CdpSpRebalanceEventRow)
  | ({ kind: "troveOp" } & CdpTroveOperationEventRow);
