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

// Daily rollup of LiquityInstanceSnapshot — one row per CDP market per UTC day.
// At ~365 rows per market per year the full history fits well under Hasura's
// 1000-row cap. Fetching newest-first preserves recent history if the cap is
// ever hit; the chart reverses to chronological client-side.
export const CDP_INSTANCE_DAILY_SNAPSHOTS = `
  query CdpInstanceDailySnapshots($instanceId: String!) {
    LiquityInstanceDailySnapshot(
      where: { instanceId: { _eq: $instanceId } }
      order_by: [{ timestamp: desc }, { id: desc }]
    ) {
      id timestamp spDeposits spColl spHeadroom systemDebt systemColl
    }
  }
`;

// Unified CDP transactions feed. The indexer has no single CDPOperation
// entity, so we fetch the four event types in parallel and merge them
// client-side. Each branch's history is well under ENVIO_MAX_ROWS, so a
// single capped query per kind suffices — the merged result is paginated
// client-side via array slice. If any per-kind array hits the cap, the
// UI shows a footnote so older history isn't silently dropped.
export const CDP_TRANSACTIONS = `
  query CdpTransactions($instanceId: String!, $limit: Int!) {
    LiquidationEvent(
      where: { instanceId: { _eq: $instanceId } }
      order_by: [{ timestamp: desc }, { id: desc }]
      limit: $limit
    ) {
      id debtOffsetBySP debtRedistributed boldGasCompensation collGasCompensation
      collSentToSP collRedistributed collSurplus priceAtLiquidation
      timestamp blockNumber txHash
    }
    RedemptionEvent(
      where: { instanceId: { _eq: $instanceId } }
      order_by: [{ timestamp: desc }, { id: desc }]
      limit: $limit
    ) {
      id attemptedBoldAmount actualBoldAmount ETHSent ETHFee
      price redemptionPrice isRebalance
      timestamp blockNumber txHash
    }
    SpRebalanceEvent(
      where: { instanceId: { _eq: $instanceId } }
      order_by: [{ timestamp: desc }, { id: desc }]
      limit: $limit
    ) {
      id amountCollIn amountStableOut
      timestamp blockNumber txHash
    }
    TroveOperationEvent(
      where: { instanceId: { _eq: $instanceId } }
      order_by: [{ timestamp: desc }, { id: desc }]
      limit: $limit
    ) {
      id troveId owner operation collChange debtChange
      debtBefore debtAfter collBefore collAfter
      annualInterestRate debtIncreaseFromUpfrontFee
      timestamp blockNumber txHash
    }
  }
`;

// Cross-CDP transactions feed for the /cdps overview page. Same shape as
// CDP_TRANSACTIONS but scoped by chain instead of instance — Liquity is
// indexed on multiple chains (Celo + Monad), so without the chainId
// predicate the overview would leak cross-chain rows into the per-chain
// page. The limit caps each kind, the UI merges client-side and shows
// the last N. `instanceId` is projected so the UI can resolve which
// market each row belongs to.
export const ALL_CDP_TRANSACTIONS = `
  query AllCdpTransactions($chainId: Int!, $limit: Int!) {
    LiquidationEvent(
      where: { chainId: { _eq: $chainId } }
      order_by: [{ timestamp: desc }, { id: desc }]
      limit: $limit
    ) {
      id instanceId
      debtOffsetBySP debtRedistributed boldGasCompensation collGasCompensation
      collSentToSP collRedistributed collSurplus priceAtLiquidation
      timestamp blockNumber txHash
    }
    RedemptionEvent(
      where: { chainId: { _eq: $chainId } }
      order_by: [{ timestamp: desc }, { id: desc }]
      limit: $limit
    ) {
      id instanceId
      attemptedBoldAmount actualBoldAmount ETHSent ETHFee
      price redemptionPrice isRebalance
      timestamp blockNumber txHash
    }
    SpRebalanceEvent(
      where: { chainId: { _eq: $chainId } }
      order_by: [{ timestamp: desc }, { id: desc }]
      limit: $limit
    ) {
      id instanceId
      amountCollIn amountStableOut
      timestamp blockNumber txHash
    }
    TroveOperationEvent(
      where: { chainId: { _eq: $chainId } }
      order_by: [{ timestamp: desc }, { id: desc }]
      limit: $limit
    ) {
      id instanceId troveId owner operation collChange debtChange
      debtBefore debtAfter collBefore collAfter
      annualInterestRate debtIncreaseFromUpfrontFee
      timestamp blockNumber txHash
    }
  }
`;
