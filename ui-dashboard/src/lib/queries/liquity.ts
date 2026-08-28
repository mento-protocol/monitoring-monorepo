import {
  CDP_STABILITY_POOL_DEPOSITORS_DETAIL_LIMIT,
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
const CDP_STABILITY_POOL_DEPOSITOR_FIELDS = `
      id address lastTouchedDeposit stashedColl lastUpdatedAt
      cumulativeDeposited cumulativeWithdrawn
`;
const CDP_STABILITY_POOL_DEPOSITOR_FIELDS_WITH_SOURCE = `
      id address lastTouchedDeposit stashedColl lastUpdatedAt
      cumulativeDeposited cumulativeWithdrawn
      cumulativeRebalanceUsed cumulativeLiquidationUsed
`;

export const CDP_TROVE_SCHEMA_FIELDS = `
  query CdpSchemaFields {
    TroveType: __type(name: "Trove") {
      fields {
        name
      }
    }
    StabilityPoolDepositorType: __type(name: "StabilityPoolDepositor") {
      fields {
        name
      }
    }
    TroveLedgerEventType: __type(name: "TroveLedgerEvent") {
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
      id chainId collIndex symbol spYieldSplitBps
    }
    LiquityInstance(
      where: { chainId: { _eq: $chainId } }
      order_by: { collateralId: asc }
    ) {
      id collateralId chainId systemDebt activeTroveCount borrowingFeeCum
      borrowingFeeCollectedCum isShutDown shutDownAt
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
      collected
    }
  }
`;

const cdpMarketDetailQuery = (
  operationName: string,
  troveRowFields: string,
  stabilityPoolDepositorFields: string,
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
      where: {
        collateralId: { _eq: $collateralId }
        _or: [
          { lastTouchedDeposit: { _gt: "0" } }
          { stashedColl: { _gt: "0" } }
        ]
      }
      order_by: [
        { lastTouchedDeposit: desc }
        { stashedColl: desc }
        { lastUpdatedAt: desc }
        { id: asc }
      ]
      limit: ${CDP_STABILITY_POOL_DEPOSITORS_DETAIL_LIMIT}
    ) {
${stabilityPoolDepositorFields}
    }
  }
`;

export const CDP_MARKET_DETAIL = cdpMarketDetailQuery(
  "CdpMarketDetail",
  CDP_TROVE_ROW_FIELDS,
  CDP_STABILITY_POOL_DEPOSITOR_FIELDS,
);

export const CDP_MARKET_DETAIL_WITH_TROVE_TX = cdpMarketDetailQuery(
  "CdpMarketDetailWithTroveTx",
  CDP_TROVE_ROW_FIELDS_WITH_TX,
  CDP_STABILITY_POOL_DEPOSITOR_FIELDS,
);

export const CDP_MARKET_DETAIL_WITH_SP_SOURCE = cdpMarketDetailQuery(
  "CdpMarketDetailWithSpSource",
  CDP_TROVE_ROW_FIELDS,
  CDP_STABILITY_POOL_DEPOSITOR_FIELDS_WITH_SOURCE,
);

export const CDP_MARKET_DETAIL_WITH_TROVE_TX_AND_SP_SOURCE =
  cdpMarketDetailQuery(
    "CdpMarketDetailWithTroveTxAndSpSource",
    CDP_TROVE_ROW_FIELDS_WITH_TX,
    CDP_STABILITY_POOL_DEPOSITOR_FIELDS_WITH_SOURCE,
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

const CDP_STABILITY_POOL_OPERATION_FIELDS = `
      id instanceId depositor operation depositLossSinceLastOperation
      topUpOrWithdrawal yieldGainSinceLastOperation yieldGainClaimed
      ethGainSinceLastOperation ethGainClaimed depositBefore depositAfter
      stashedCollBefore stashedCollAfter timestamp blockNumber txHash
`;

// Isolated StabilityPool operation feed. This entity is newer than the base CDP
// transaction branches, so keep it out of CDP_TRANSACTIONS during rollout; the
// table merges it only when this companion query resolves.
export const CDP_STABILITY_POOL_EVENTS = `
  query CdpStabilityPoolEvents($instanceId: String!, $limit: Int!) {
    StabilityPoolOperationEvent(
      where: { instanceId: { _eq: $instanceId } }
      order_by: [{ timestamp: desc }, { id: desc }]
      limit: $limit
    ) {
${CDP_STABILITY_POOL_OPERATION_FIELDS}
    }
  }
`;

export const ALL_CDP_STABILITY_POOL_EVENTS = `
  query AllCdpStabilityPoolEvents($chainId: Int!, $limit: Int!) {
    StabilityPoolOperationEvent(
      where: { chainId: { _eq: $chainId } }
      order_by: [{ timestamp: desc }, { id: desc }]
      limit: $limit
    ) {
${CDP_STABILITY_POOL_OPERATION_FIELDS}
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

// Trove history page (/cdps/[symbol]/troves/[troveId]) header card. `id` is
// the composite entity id (`${collateralId}-${troveId}`, see the indexer's
// `makeTroveId`) resolved client-side from the route's symbol + on-chain
// troveId — never passed in raw from the URL.
//
// Two variants, same schema-lag rationale as `CDP_MARKET_DETAIL` /
// `CDP_MARKET_DETAIL_WITH_TROVE_TX`: `lastUpdatedTxHash` is a newer column,
// and hosted Hasura rejects unknown fields at parse time during a
// deploy+resync window. The caller probes `CDP_TROVE_SCHEMA_FIELDS` (shared
// with the market page) and picks the variant that matches — querying the
// `_WITH_TX` variant unconditionally would fail the whole header request on
// a schema-lagged environment instead of just omitting one optional field.
export const CDP_TROVE_BY_ID = `
  query CdpTroveById($troveEntityId: String!) {
    Trove(where: { id: { _eq: $troveEntityId } }, limit: 1) {
${CDP_TROVE_ROW_FIELDS_WITH_TX}
    }
  }
`;

export const CDP_TROVE_BY_ID_WITHOUT_TX = `
  query CdpTroveByIdWithoutTx($troveEntityId: String!) {
    Trove(where: { id: { _eq: $troveEntityId } }, limit: 1) {
${CDP_TROVE_ROW_FIELDS}
    }
  }
`;

// Route-specific Open Graph snapshot. Keep this narrower than CDP_MARKETS:
// an unfurl needs only enough collateral metadata to resolve the composite
// Trove id and label the four visible values. Reusing CDP_MARKETS would also
// fetch instances and up to 500 open troves for every cold social share.
export const CDP_TROVE_OG_COLLATERALS = `
  query CdpTroveOgCollaterals($chainId: Int!) {
    LiquityCollateral(
      where: { chainId: { _eq: $chainId } }
      order_by: { collIndex: asc }
    ) {
      id chainId symbol mcrBps
    }
  }
`;

// Stable fields only. The card deliberately omits the batch-managed interest
// rate, so it needs neither the schema-lagged lastUpdatedTxHash field nor a
// follow-up InterestBatch join. Opened/closed/updated timestamps are complete
// lifecycle facts; the partial interim operation ledger stays off the image.
export const CDP_TROVE_OG_BY_ID = `
  query CdpTroveOgById($troveEntityId: String!) {
    Trove(where: { id: { _eq: $troveEntityId } }, limit: 1) {
      id troveId status debt coll icrBps openedAt closedAt lastUpdatedAt
    }
  }
`;

// Trove history page header rate join: resolves the CURRENT batch rate for a
// batch-managed trove, same as the market page's `InterestBatch` join in
// `cdpMarketDetailQuery` — `Trove.interestRate` can retain a stale
// individually-copied value after the batch manager changes the batch's
// rate, so the header must read `InterestBatch.annualInterestRate` rather
// than the trove's own (possibly stale) field. Queried by id rather than
// bundled into `CDP_TROVE_BY_ID` because the batch id isn't known until the
// trove row itself resolves.
export const CDP_INTEREST_BATCH_BY_ID = `
  query CdpInterestBatchById($batchId: String!) {
    InterestBatch(where: { id: { _eq: $batchId } }, limit: 1) {
      id collateralId batchManager annualInterestRate updatedAt
    }
  }
`;

// Trove history page interim assembly (docs/PLAN-trove-history-page.md,
// "GraphQL contract → interim assembly"): the page merges these user-op
// rows with `Trove` cumulatives until `TroveLedgerEvent` ships (M4 child,
// #2086) and adds the full per-redemption ledger. Filtered by BOTH
// instanceId and troveId — the raw on-chain troveId collides across
// markets, so instanceId scopes it to one. `limit` is the caller's
// request size (render limit + 1) so the page can detect truncation via
// the sentinel row without a Hasura aggregate (disabled on hosted Hasura).
export const CDP_TROVE_OPERATIONS = `
  query CdpTroveOperations($instanceId: String!, $troveId: String!, $limit: Int!) {
    TroveOperationEvent(
      where: { instanceId: { _eq: $instanceId }, troveId: { _eq: $troveId } }
      order_by: [{ timestamp: desc }, { id: desc }]
      limit: $limit
    ) {
      id troveId operation collChange debtChange
      annualInterestRate debtIncreaseFromUpfrontFee
      timestamp blockNumber txHash
    }
  }
`;

// Owner lookup on the /cdps overview (docs/PLAN-trove-history-page.md,
// "GraphQL contract → CDP_TROVES_BY_OWNER"): every trove an address owns or
// owned, across all markets on one chain. The NFT burn handler zeroes
// `owner` on close and liquidation and stashes the last owner in
// `previousOwner`, so matching `owner` alone would miss exactly the closed
// troves support asks about — hence the `_or`. Chain-scoped because Liquity
// is indexed on multiple chains. `$limit` is the caller's request size
// (render limit + 1) so a capped result is detected via the sentinel row,
// never a Hasura aggregate (disabled on hosted Hasura); ordering is
// newest-updated-first with the unique entity id as tiebreaker, so the cap
// drops the least recently touched troves.
export const CDP_TROVES_BY_OWNER = `
  query CdpTrovesByOwner($chainId: Int!, $address: String!, $limit: Int!) {
    Trove(
      where: {
        chainId: { _eq: $chainId }
        _or: [{ owner: { _eq: $address } }, { previousOwner: { _eq: $address } }]
      }
      order_by: [{ lastUpdatedAt: desc }, { id: asc }]
      limit: $limit
    ) {
      id collateralId troveId status debt coll lastUpdatedAt
    }
  }
`;

// Trove history page redemption-queue panel (docs/PLAN-trove-history-page.md,
// "UI design → Redemption queue"): the market's current rate ladder plus the
// shutdown flag, fetched by the trove page ITSELF — a direct page load must
// render the ladder without the market page's cache being warm, so this owns
// its fetch instead of reading `CDP_MARKET_DETAIL`'s. Same `OpenTrove` shape
// and cap as that query (active + zombie, `CDP_TROVES_DETAIL_LIMIT`) so the
// panel's cap suppression triggers exactly where the market table hides its
// rank column; zombies are excluded client-side (they sit outside the sorted
// queue and shield nothing), which keeps the exclusion unit-testable and the
// cap semantics identical. Per-row payload is minimal — the ladder needs only
// status/debt/rate/batch join; `InterestBatch` resolves the CURRENT rate for
// batch-managed troves (`Trove.interestRate` can be a stale copy). While
// `isShutDown` is true redemptions are urgent-mode and rate order no longer
// decides, so the panel swaps the ladder for a shutdown notice.
export const CDP_TROVE_QUEUE = `
  query CdpTroveQueue($collateralId: String!) {
    LiquityInstance(where: { collateralId: { _eq: $collateralId } }, limit: 1) {
      id isShutDown shutDownAt
    }
    OpenTrove: Trove(
      where: {
        collateralId: { _eq: $collateralId }
        status: { _in: [${OPEN_STATUS_LIST}] }
      }
      order_by: [{ interestRate: asc }, { troveId: asc }, { id: asc }]
      limit: ${CDP_TROVES_DETAIL_LIMIT}
    ) {
      id status debt interestRate interestBatchId
    }
    InterestBatch(
      where: { collateralId: { _eq: $collateralId } }
      order_by: [{ annualInterestRate: asc }, { id: asc }]
      limit: ${CDP_TROVES_DETAIL_LIMIT}
    ) {
      id annualInterestRate
    }
  }
`;

// Trove history page complete ledger (docs/PLAN-trove-history-page.md,
// "GraphQL contract → CDP_TROVE_LEDGER"): every TroveOperation ordinal
// including redemptions/liquidations/interest folds, superseding the interim
// `CDP_TROVE_OPERATIONS` assembly once hosted Hasura serves the entity. The
// caller gates on `CDP_TROVE_SCHEMA_FIELDS` finding both `TroveLedgerEvent`
// and the `Trove` watermark columns — this query is never fired ungated,
// which is also why `lastLedgerBlock`/`lastLedgerLogIndex` live HERE (aliased
// `LedgerWatermark` branch) and never in `CDP_TROVE_ROW_FIELDS[_WITH_TX]`:
// those constants feed the ungated market-detail and trove-header queries,
// and one unknown column fails a whole request at parse time on a
// schema-lagged deploy. Fetching the watermark alongside the ledger rows also
// keeps the reconciliation pair (#2088) reading one response, not two skewed
// polls — and the same branch carries the redemption cumulatives the impact
// panel reconciles against, so cumulatives, watermark, and rows are all one
// snapshot: comparing the header query's (independently polled) cumulatives
// to this response's rows would re-open exactly the skew the watermark
// exists to close. The cumulative columns are long-deployed and safe here;
// only the two watermark columns are gate-dependent.
//
// Ordering is the numeric triple — `TroveLedgerEvent` has a queryable
// `logIndex`, unlike `TroveOperationEvent`, so the server tiebreaks
// correctly and no row can be dropped at the cap boundary by the string-id
// workaround this route needs for the interim query. The unpadded string
// `id` never participates in ordering. Fetched newest-first so the OLDEST
// rows drop at the cap; the caller reverses to chronological and detects
// truncation via the limit+1 sentinel (render 999, request 1000 — aggregates
// are disabled on hosted Hasura, and the render limit sits below the
// 1,000-row hard cap so a capped response still carries the sentinel).
export const CDP_TROVE_LEDGER = `
  query CdpTroveLedger($troveEntityId: String!, $limit: Int!) {
    LedgerWatermark: Trove(where: { id: { _eq: $troveEntityId } }, limit: 1) {
      lastLedgerBlock lastLedgerLogIndex
      redemptionCount redeemedDebt redeemedColl redemptionFeePaidCum
    }
    TroveLedgerEvent(
      where: { troveEntityId: { _eq: $troveEntityId } }
      order_by: [{ timestamp: desc }, { blockNumber: desc }, { logIndex: desc }]
      limit: $limit
    ) {
      id operation collChange debtChange debtIncreaseFromUpfrontFee
      debtIncreaseFromRedist collIncreaseFromRedist annualInterestRate
      debtBefore debtAfter collBefore collAfter statusBefore statusAfter
      redemptionFeeCredited isRebalance redemptionPrice priceAtEvent
      icrAfterBps timestamp blockNumber logIndex txHash
    }
  }
`;
