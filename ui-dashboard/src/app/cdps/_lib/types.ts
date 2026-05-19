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
