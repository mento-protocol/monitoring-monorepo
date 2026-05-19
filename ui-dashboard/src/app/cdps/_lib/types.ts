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

export type CdpLiquidationEventRow = {
  id: string;
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
  amountCollIn: string;
  amountStableOut: string;
  timestamp: string;
  blockNumber: string;
  txHash: string;
};

/** Discriminated union used by the unified CDP transactions table. */
export type CdpTransactionRow =
  | ({ kind: "liquidation" } & CdpLiquidationEventRow)
  | ({ kind: "redemption" } & CdpRedemptionEventRow)
  | ({ kind: "spRebalance" } & CdpSpRebalanceEventRow);
