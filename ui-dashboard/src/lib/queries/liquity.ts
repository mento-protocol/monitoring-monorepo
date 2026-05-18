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
      where: { collateralId: { _eq: $collateralId } }
      order_by: { icrBps: asc }
      limit: 50
    ) {
      id troveId owner status debt coll icrBps interestRate interestBatchId
      lastUpdatedAt redemptionCount redeemedDebt redeemedColl
    }
    StabilityPoolDepositor(
      where: { collateralId: { _eq: $collateralId } }
      order_by: { lastTouchedDeposit: desc }
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
