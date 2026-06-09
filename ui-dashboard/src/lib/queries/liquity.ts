import {
  CDP_TROVE_OPEN_STATUSES,
  CDP_TROVES_DETAIL_LIMIT,
  CDP_TROVES_LIST_LIMIT,
} from "@/app/cdps/_lib/types";

const OPEN_STATUS_LIST = CDP_TROVE_OPEN_STATUSES.map((s) => `"${s}"`).join(
  ", ",
);
const CDP_TROVE_ROW_FIELDS = `
      id troveId owner previousOwner status debt coll icrBps interestRate
      interestBatchId openedAt openedTxHash closedAt closedTxHash lastUpdatedAt
      liquidatedDebt liquidatedColl collSurplus priceAtLiquidation
      redemptionCount redeemedDebt redeemedColl redemptionFeePaidCum
`;
const CDP_TROVE_ROW_FIELDS_WITH_TX = `
      id troveId owner previousOwner status debt coll icrBps interestRate
      interestBatchId openedAt openedTxHash closedAt closedTxHash lastUpdatedAt
      lastUpdatedTxHash liquidatedDebt liquidatedColl collSurplus
      priceAtLiquidation redemptionCount redeemedDebt redeemedColl
      redemptionFeePaidCum
`;

export const CDP_TROVE_SCHEMA_FIELDS = `
  query CdpTroveSchemaFields {
    __type(name: "Trove") {
      fields {
        name
      }
    }
  }
`;

// `LiquityInstance.systemDebt` is the source of truth for the system-debt KPI
// since the post-fix handlers landed (commit 026c629, promoted 2026-05-20).
// We still pull active+zombie trove rows here for the open-trove count — the
// indexer's `activeTroveCount` excludes zombies, so the UX-meaningful "open
// positions" count is derived client-side until the indexer grows an
// `openTroveCount` field maintained alongside `activeTroveCount` in the same
// delta path. Per-row payload is intentionally minimal (id + collateralId +
// status) — debt/coll come from `LiquityInstance.systemDebt`/`systemColl`.
export const CDP_MARKETS = `
  query CdpMarkets($chainId: Int!) {
    LiquityCollateral(
      where: { chainId: { _eq: $chainId } }
      order_by: { collIndex: asc }
    ) {
      id chainId collIndex symbol debtToken collToken troveManager stabilityPool
      minDebt minBoldInSp minBoldAfterRebalance systemParamsLoaded
      mcrBps ccrBps scrBps
    }
    LiquityInstance(
      where: { chainId: { _eq: $chainId } }
      order_by: { collateralId: asc }
    ) {
      id collateralId chainId systemColl systemDebt tcrBps spDeposits spColl
      spHeadroom currentRedemptionRateBps activeTroveCount
      icrP1Bps icrP5Bps icrP50Bps icrFracBelowMcrBps
      liqCountCum redemptionCountCum redemptionDebtCum redemptionFeeCum
      rebalanceRedemptionCountCum rebalanceRedemptionDebtCum
      rebalanceRedemptionFeeCum borrowingFeeCum
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
      id collateralId status
    }
  }
`;

export const CDP_BORROWING_REVENUE_MARKETS = `
  query CdpBorrowingRevenueMarkets($chainId: Int!) {
    LiquityCollateral(
      where: { chainId: { _eq: $chainId } }
      order_by: { collIndex: asc }
    ) {
      id chainId collIndex symbol
    }
    LiquityInstance(
      where: { chainId: { _eq: $chainId } }
      order_by: { collateralId: asc }
    ) {
      id collateralId chainId systemDebt activeTroveCount borrowingFeeCum
    }
  }
`;

export const CDP_BORROWING_REVENUE_BRACKETS = `
  query CdpBorrowingRevenueBrackets(
    $collateralIds: [String!]!
    $limit: Int!
    $offset: Int!
  ) {
    InterestRateBracket(
      where: { collateralId: { _in: $collateralIds } }
      order_by: [{ collateralId: asc }, { rate: asc }]
      limit: $limit
      offset: $offset
    ) {
      id collateralId rate totalDebt sumDebtTimesRateD36
      pendingDebtTimesOneYearD36 updatedAt
    }
  }
`;

export const CDP_BORROWING_FEE_EVENTS = `
  query CdpBorrowingFeeEvents($chainId: Int!, $limit: Int!, $offset: Int!) {
    TroveOperationEvent(
      where: {
        chainId: { _eq: $chainId }
        debtIncreaseFromUpfrontFee: { _gt: "0" }
      }
      order_by: [{ timestamp: desc }, { id: desc }]
      limit: $limit
      offset: $offset
    ) {
      id instanceId debtIncreaseFromUpfrontFee timestamp
    }
  }
`;

export const CDP_BORROWING_REVENUE_DAILY_SNAPSHOTS = `
  query CdpBorrowingRevenueDailySnapshots(
    $chainId: Int!
    $limit: Int!
    $offset: Int!
  ) {
    LiquityBorrowingRevenueDailySnapshot(
      where: { chainId: { _eq: $chainId } }
      order_by: [{ timestamp: desc }, { id: desc }]
      limit: $limit
      offset: $offset
    ) {
      id chainId collateralId instanceId timestamp upfrontFee accruedInterest
    }
  }
`;

const cdpMarketDetailQuery = (
  operationName: string,
  troveRowFields: string,
): string => `
  query ${operationName}($collateralId: String!) {
    LiquityCollateral(where: { id: { _eq: $collateralId } }, limit: 1) {
      id chainId collIndex symbol debtToken collToken troveManager stabilityPool
      minDebt minBoldInSp minBoldAfterRebalance systemParamsLoaded
      mcrBps ccrBps scrBps
    }
    LiquityInstance(where: { collateralId: { _eq: $collateralId } }, limit: 1) {
      id collateralId chainId systemColl systemDebt tcrBps spDeposits spColl
      spHeadroom currentRedemptionRateBps activeTroveCount
      icrP1Bps icrP5Bps icrP50Bps icrFracBelowMcrBps
      liqCountCum redemptionCountCum redemptionDebtCum redemptionFeeCum
      rebalanceRedemptionCountCum rebalanceRedemptionDebtCum
      rebalanceRedemptionFeeCum borrowingFeeCum
      isShutDown shutDownAt shutDownTcrBps lastEventBlock lastEventTimestamp
    }
    OpenTrove: Trove(
      where: {
        collateralId: { _eq: $collateralId }
        status: { _in: [${OPEN_STATUS_LIST}] }
      }
      order_by: [{ interestRate: asc }, { troveId: asc }, { id: asc }]
      limit: ${CDP_TROVES_DETAIL_LIMIT}
    ) {
${troveRowFields}
    }
    AllTrove: Trove(
      where: {
        collateralId: { _eq: $collateralId }
        status: { _nin: [${OPEN_STATUS_LIST}] }
      }
      order_by: [{ lastUpdatedAt: desc }, { id: asc }]
      limit: ${CDP_TROVES_DETAIL_LIMIT}
    ) {
${troveRowFields}
    }
    InterestBatch(
      where: { collateralId: { _eq: $collateralId } }
      order_by: [{ annualInterestRate: asc }, { id: asc }]
      limit: ${CDP_TROVES_DETAIL_LIMIT}
    ) {
      id collateralId batchManager annualInterestRate updatedAt
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

export const CDP_MARKET_DETAIL = cdpMarketDetailQuery(
  "CdpMarketDetail",
  CDP_TROVE_ROW_FIELDS,
);

export const CDP_MARKET_DETAIL_WITH_TROVE_TX = cdpMarketDetailQuery(
  "CdpMarketDetailWithTroveTx",
  CDP_TROVE_ROW_FIELDS_WITH_TX,
);

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
      id troveId operation collChange debtChange
      annualInterestRate debtIncreaseFromUpfrontFee
      timestamp blockNumber txHash
    }
  }
`;

// Isolated trove-op snapshot fields. Same isolation pattern as
// POOL_BREACH_ROLLUP / POOL_CONFIG_EXT: `owner` + before/after debt/coll
// are brand-new indexer columns, and hosted Hasura rejects unknown fields
// at parse time during the deploy+resync window. Keeping them in their
// own query lets the transactions table keep rendering — only the
// before/after presentation and the address filter degrade — while the
// schema catches up. UI merges the snapshot rows into the transaction
// rows client-side by event id.
export const CDP_TROVE_OP_SNAPSHOTS = `
  query CdpTroveOpSnapshots($instanceId: String!, $limit: Int!) {
    TroveOperationEvent(
      where: { instanceId: { _eq: $instanceId } }
      order_by: [{ timestamp: desc }, { id: desc }]
      limit: $limit
    ) {
      id owner debtBefore debtAfter collBefore collAfter
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
      id instanceId troveId operation collChange debtChange
      annualInterestRate debtIncreaseFromUpfrontFee
      timestamp blockNumber txHash
    }
  }
`;

// Cross-CDP equivalent of CDP_TROVE_OP_SNAPSHOTS — same isolation
// rationale (see comment above CDP_TROVE_OP_SNAPSHOTS). Scoped by chain
// to match ALL_CDP_TRANSACTIONS.
export const ALL_CDP_TROVE_OP_SNAPSHOTS = `
  query AllCdpTroveOpSnapshots($chainId: Int!, $limit: Int!) {
    TroveOperationEvent(
      where: { chainId: { _eq: $chainId } }
      order_by: [{ timestamp: desc }, { id: desc }]
      limit: $limit
    ) {
      id owner debtBefore debtAfter collBefore collAfter
    }
  }
`;
