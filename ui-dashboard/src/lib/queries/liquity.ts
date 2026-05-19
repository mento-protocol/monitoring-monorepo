import {
  CDP_TROVE_OPEN_STATUSES,
  CDP_TROVES_DETAIL_LIMIT,
  CDP_TROVES_LIST_LIMIT,
} from "@/app/cdps/_lib/types";

const OPEN_STATUS_LIST = CDP_TROVE_OPEN_STATUSES.map((s) => `"${s}"`).join(
  ", ",
);

// We pull every active+zombie trove here so the list page can compute its own
// systemDebt and borrower count: the on-chain ActivePoolBoldDebtUpdated event
// is never emitted by Mento's Liquity fork, so LiquityInstance.systemDebt /
// activeTroveCount understate reality. See BACKLOG for indexer-side fix.
export const CDP_MARKETS = `
  query CdpMarkets($chainId: Int!) {
    LiquityCollateral(
      where: { chainId: { _eq: $chainId } }
      order_by: { collIndex: asc }
    ) {
      id chainId collIndex symbol debtToken collToken troveManager stabilityPool
      minDebt minBoldInSp systemParamsLoaded
      mcrBps ccrBps scrBps
    }
    LiquityInstance(
      where: { chainId: { _eq: $chainId } }
      order_by: { collateralId: asc }
    ) {
      id collateralId chainId systemColl systemDebt tcrBps spDeposits spColl
      spHeadroom currentRedemptionRateBps activeTroveCount
      icrP1Bps icrP5Bps icrP50Bps icrFracBelowMcrBps
      liqCountCum redemptionCountCum borrowingFeeCum redemptionFeeCum
      isShutDown shutDownAt shutDownTcrBps lastEventBlock lastEventTimestamp
    }
    Trove(
      where: {
        chainId: { _eq: $chainId }
        status: { _in: [${OPEN_STATUS_LIST}] }
      }
      order_by: { lastUpdatedAt: desc }
      limit: ${CDP_TROVES_LIST_LIMIT}
    ) {
      id collateralId status debt coll
    }
  }
`;

export const CDP_MARKET_DETAIL = `
  query CdpMarketDetail($collateralId: String!) {
    LiquityCollateral(where: { id: { _eq: $collateralId } }, limit: 1) {
      id chainId collIndex symbol debtToken collToken troveManager stabilityPool
      minDebt minBoldInSp systemParamsLoaded
      mcrBps ccrBps scrBps
    }
    LiquityInstance(where: { collateralId: { _eq: $collateralId } }, limit: 1) {
      id collateralId chainId systemColl systemDebt tcrBps spDeposits spColl
      spHeadroom currentRedemptionRateBps activeTroveCount
      icrP1Bps icrP5Bps icrP50Bps icrFracBelowMcrBps
      liqCountCum redemptionCountCum borrowingFeeCum redemptionFeeCum
      isShutDown shutDownAt shutDownTcrBps lastEventBlock lastEventTimestamp
    }
    Trove(
      where: {
        collateralId: { _eq: $collateralId }
        status: { _in: [${OPEN_STATUS_LIST}] }
      }
      order_by: { lastUpdatedAt: desc }
      limit: ${CDP_TROVES_DETAIL_LIMIT}
    ) {
      id troveId owner status debt coll icrBps interestRate interestBatchId
      lastUpdatedAt redemptionCount redeemedDebt redeemedColl
    }
    StabilityPoolDepositor(
      where: { collateralId: { _eq: $collateralId } }
      order_by: { lastUpdatedAt: desc }
      limit: 25
    ) {
      id address lastTouchedDeposit stashedColl lastUpdatedAt
      cumulativeDeposited cumulativeWithdrawn yieldGainClaimedCum ethGainClaimedCum
    }
    CdpPool(
      where: { collateralId: { _eq: $collateralId }, removed: { _eq: false } }
      order_by: { updatedAtTimestamp: desc }
      limit: 100
    ) {
      id poolId debtToken strategyAddress rebalanceCooldownSec
      addedAtTimestamp updatedAtTimestamp
    }
  }
`;
