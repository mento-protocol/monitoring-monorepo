import { describe, expect, it } from "vitest";

import * as queries from "@/lib/queries";

const EXPECTED_EXPORT_NAMES = [
  "ALL_POOLS_WITH_HEALTH",
  "ALL_POOLS_BREACH_ROLLUP",
  "ALL_POOLS_HEALTH_CURSOR",
  "ALL_POOLS_REBALANCE_THRESHOLDS_KNOWN",
  "ORACLE_RATES",
  "RECENT_SWAPS",
  "POOL_SWAPS",
  "POOL_SWAPS_PAGE",
  "POOL_SWAPS_COUNT",
  "POOL_RESERVES",
  "POOL_REBALANCES",
  "POOL_REBALANCES_PAGE",
  "POOL_REBALANCES_USD_EXT",
  "POOL_REBALANCE_REWARDS",
  "POOL_REBALANCES_COUNT",
  "LATEST_POOL_REBALANCE_FOR_STRATEGY",
  "POOL_LIQUIDITY",
  "POOL_LIQUIDITY_PAGE",
  "POOL_LIQUIDITY_COUNT",
  "POOL_DETAIL_WITH_HEALTH",
  "POOL_THRESHOLDS_KNOWN_EXT",
  "POOL_CONFIG_EXT",
  "POOL_V2_EXCHANGE",
  "POOL_BREACH_ROLLUP",
  "POOL_HEALTH_CURSOR",
  "POOL_HEALTH_7D_ANCHOR",
  "POOL_OPEN_BREACH_TX",
  "POOL_DEVIATION_BREACHES_PAGE",
  "POOL_DEVIATION_BREACHES_COUNT",
  "POOL_DEVIATION_BREACHES_ALL",
  "POOL_SNAPSHOTS_CHART",
  "POOL_DAILY_SNAPSHOTS_CHART",
  "POOL_DAILY_SNAPSHOTS_ALL",
  "BROKER_DAILY_SNAPSHOTS_ALL",
  "BROKER_EXCHANGE_DAILY_SNAPSHOTS_24H",
  "POOL_DAILY_FEE_SNAPSHOTS_PAGE",
  "ALL_TRADING_LIMITS",
  "TRADING_LIMITS",
  "ORACLE_SNAPSHOTS",
  "ORACLE_SNAPSHOTS_CHART",
  "ORACLE_PRICE_DAILY",
  "ORACLE_SNAPSHOTS_COUNT_PAGE",
  "POOL_DEPLOYMENT",
  "POOL_LP_POSITIONS",
  "UNIQUE_LP_ADDRESSES",
  "OLS_POOL",
  "OLS_LIQUIDITY_EVENTS_PAGE",
  "OLS_LIQUIDITY_EVENTS_COUNT",
  "ALL_OLS_POOLS",
  "ALL_CDP_POOLS",
  "ALL_CDP_TRANSACTIONS",
  "ALL_CDP_TROVE_OP_SNAPSHOTS",
  "CDP_INSTANCE_DAILY_SNAPSHOTS",
  "CDP_MARKETS",
  "CDP_MARKET_DETAIL",
  "CDP_TRANSACTIONS",
  "CDP_TROVE_OP_SNAPSHOTS",
  "POOL_BREAKER_CONFIG",
  "POOL_LABELS_ALL",
  "VIRTUAL_POOL_LIFECYCLE",
] as const;

const normalize = (s: string) => s.replace(/\s+/g, " ").trim();

describe("@/lib/queries — surface contract", () => {
  it("exports every expected query name", () => {
    const actual = Object.keys(queries).sort();
    const expected = EXPECTED_EXPORT_NAMES.toSorted();
    expect(actual).toEqual(expected);
  });

  it("exports nothing extra", () => {
    const extra = Object.keys(queries).filter(
      (k) =>
        !EXPECTED_EXPORT_NAMES.includes(
          k as (typeof EXPECTED_EXPORT_NAMES)[number],
        ),
    );
    expect(extra).toEqual([]);
  });

  it.each(EXPECTED_EXPORT_NAMES)("%s is a non-empty GraphQL string", (name) => {
    const value = (queries as Record<string, unknown>)[name];
    expect(typeof value).toBe("string");
    expect(value).toBeTruthy();
    expect(value).toMatch(/\bquery\s+\w+/);
  });
});

describe("@/lib/queries — content snapshots (refactor characterization)", () => {
  it("ALL_POOLS_WITH_HEALTH selects the full pool payload", () => {
    expect(normalize(queries.ALL_POOLS_WITH_HEALTH)).toBe(
      normalize(`
        query AllPoolsWithHealth($chainId: Int!) {
          Pool(
            where: { chainId: { _eq: $chainId } }
            order_by: { createdAtBlock: desc }
          ) {
            id
            chainId
            token0
            token1
            token0Decimals
            token1Decimals
            source
            wrappedExchangeId
            createdAtBlock
            createdAtTimestamp
            updatedAtBlock
            updatedAtTimestamp
            healthStatus
            oracleOk
            oraclePrice
            oracleTimestamp
            oracleTxHash
            priceDifference
            rebalanceThreshold
            oracleNumReporters
            oracleExpiry
            lastRebalancedAt
            deviationBreachStartedAt
            lpFee
            protocolFee
            limitStatus
            limitPressure0
            limitPressure1
            rebalancerAddress
            referenceRateFeedID
            swapCount
            rebalanceCount
            notionalVolume0
            notionalVolume1
            reserves0
            reserves1
            healthTotalSeconds
            hasHealthData
          }
        }
      `),
    );
  });

  it("ALL_POOLS_REBALANCE_THRESHOLDS_KNOWN is isolated (rationale: schema-lag resilience)", () => {
    expect(queries.ALL_POOLS_REBALANCE_THRESHOLDS_KNOWN).toContain(
      "rebalanceThresholdsKnown",
    );
    // Split sides accompany the Known flag because the never-rebalance
    // predicate requires BOTH `above === 0 && below === 0` (active
    // `rebalanceThreshold` alone can't disambiguate asymmetric pools).
    expect(queries.ALL_POOLS_REBALANCE_THRESHOLDS_KNOWN).toContain(
      "rebalanceThresholdAbove",
    );
    expect(queries.ALL_POOLS_REBALANCE_THRESHOLDS_KNOWN).toContain(
      "rebalanceThresholdBelow",
    );
    expect(queries.ALL_POOLS_REBALANCE_THRESHOLDS_KNOWN).toContain(
      "degenerateReserves",
    );
    // breakerTripped rides this isolated companion (not the main query) so the
    // whole pools fan-out doesn't fail during the indexer deploy/promote window.
    expect(queries.ALL_POOLS_REBALANCE_THRESHOLDS_KNOWN).toContain(
      "breakerTripped",
    );
    // No heavy / unrelated fields piggybacking — isolation must stay tight
    // so a schema-lag failure on the rollup query degrades only `isNeverRebalance`,
    // not the entire pools page.
    expect(queries.ALL_POOLS_REBALANCE_THRESHOLDS_KNOWN).not.toContain(
      "healthStatus",
    );
    expect(queries.ALL_POOLS_REBALANCE_THRESHOLDS_KNOWN).not.toContain(
      "oraclePrice",
    );
  });

  it("POOL_THRESHOLDS_KNOWN_EXT mirrors the all-pools triple for single-pool fetches", () => {
    expect(queries.POOL_THRESHOLDS_KNOWN_EXT).toContain(
      "rebalanceThresholdsKnown",
    );
    expect(queries.POOL_THRESHOLDS_KNOWN_EXT).toContain(
      "rebalanceThresholdAbove",
    );
    expect(queries.POOL_THRESHOLDS_KNOWN_EXT).toContain(
      "rebalanceThresholdBelow",
    );
    expect(queries.POOL_THRESHOLDS_KNOWN_EXT).toContain("degenerateReserves");
    expect(queries.POOL_THRESHOLDS_KNOWN_EXT).not.toContain("healthStatus");
    expect(queries.POOL_THRESHOLDS_KNOWN_EXT).not.toContain("oraclePrice");
    // Keyed by id + chainId — single-pool variant of the all-pools query.
    expect(queries.POOL_THRESHOLDS_KNOWN_EXT).toContain("$id: String!");
    expect(queries.POOL_THRESHOLDS_KNOWN_EXT).toContain("$chainId: Int!");
  });

  it("ALL_POOLS_BREACH_ROLLUP is isolated (rationale: phased schema rollout)", () => {
    expect(normalize(queries.ALL_POOLS_BREACH_ROLLUP)).toBe(
      normalize(`
        query AllPoolsBreachRollup($chainId: Int!) {
          Pool(where: { chainId: { _eq: $chainId } }) {
            id
            breachCount
            healthBinarySeconds
            healthTotalSeconds
          }
        }
      `),
    );
  });

  it("ALL_POOLS_HEALTH_CURSOR isolates live-tail fields from persisted counters", () => {
    expect(normalize(queries.ALL_POOLS_HEALTH_CURSOR)).toBe(
      normalize(`
        query AllPoolsHealthCursor($chainId: Int!) {
          Pool(where: { chainId: { _eq: $chainId } }) {
            id
            lastOracleSnapshotTimestamp
            lastDeviationRatio
          }
        }
      `),
    );
  });

  it("ORACLE_RATES selects oracleOk-true-or-null pools (mirrors buildOracleRateMap)", () => {
    expect(queries.ORACLE_RATES).toContain("oracleOk: { _eq: true }");
    expect(queries.ORACLE_RATES).toContain("oracleOk: { _is_null: true }");
    expect(queries.ORACLE_RATES).toContain("oraclePrice");
  });

  it("POOL_DETAIL_WITH_HEALTH lookup is keyed on id + chainId", () => {
    expect(queries.POOL_DETAIL_WITH_HEALTH).toContain("$id: String!");
    expect(queries.POOL_DETAIL_WITH_HEALTH).toContain("$chainId: Int!");
    expect(queries.POOL_DETAIL_WITH_HEALTH).toContain("id: { _eq: $id }");
    expect(queries.POOL_DETAIL_WITH_HEALTH).toContain(
      "chainId: { _eq: $chainId }",
    );
  });

  it("POOL_CONFIG_EXT is isolated to rebalanceReward (rationale: schema rollout)", () => {
    expect(queries.POOL_CONFIG_EXT).toContain("rebalanceReward");
    expect(queries.POOL_CONFIG_EXT).not.toContain("healthStatus");
    expect(queries.POOL_CONFIG_EXT).not.toContain("oraclePrice");
  });

  it("POOL_BREACH_ROLLUP returns persisted uptime counters", () => {
    expect(queries.POOL_BREACH_ROLLUP).toContain("breachCount");
    expect(queries.POOL_BREACH_ROLLUP).toContain("healthBinarySeconds");
    expect(queries.POOL_BREACH_ROLLUP).toContain("healthTotalSeconds");
    expect(queries.POOL_BREACH_ROLLUP).not.toContain(
      "lastOracleSnapshotTimestamp",
    );
    expect(queries.POOL_BREACH_ROLLUP).not.toContain("lastDeviationRatio");
  });

  it("POOL_HEALTH_CURSOR isolates live-tail fields from persisted counters", () => {
    expect(queries.POOL_HEALTH_CURSOR).toContain("$id: String!");
    expect(queries.POOL_HEALTH_CURSOR).toContain("$chainId: Int!");
    expect(queries.POOL_HEALTH_CURSOR).toContain("lastOracleSnapshotTimestamp");
    expect(queries.POOL_HEALTH_CURSOR).toContain("lastDeviationRatio");
    expect(queries.POOL_HEALTH_CURSOR).not.toContain("healthBinarySeconds");
    expect(queries.POOL_HEALTH_CURSOR).not.toContain("healthTotalSeconds");
  });

  it("POOL_HEALTH_7D_ANCHOR is scoped by id + chainId at sevenDaysAgo timestamp", () => {
    expect(queries.POOL_HEALTH_7D_ANCHOR).toContain("$id: String!");
    expect(queries.POOL_HEALTH_7D_ANCHOR).toContain("$chainId: Int!");
    expect(queries.POOL_HEALTH_7D_ANCHOR).toContain("$sevenDaysAgo: numeric!");
    expect(queries.POOL_HEALTH_7D_ANCHOR).toContain(
      "chainId: { _eq: $chainId }",
    );
    expect(queries.POOL_HEALTH_7D_ANCHOR).toContain(
      "cumulativeHealthBinarySeconds",
    );
    expect(queries.POOL_HEALTH_7D_ANCHOR).toContain(
      "cumulativeHealthTotalSeconds",
    );
  });

  it("POOL_OPEN_BREACH_TX is keyed on poolId + startedAt", () => {
    expect(queries.POOL_OPEN_BREACH_TX).toContain(
      "startedAt: { _eq: $startedAt }",
    );
    expect(queries.POOL_OPEN_BREACH_TX).toContain("startedByTxHash");
  });

  it("POOL_DEVIATION_BREACHES_PAGE supports server-side filter + sort", () => {
    expect(queries.POOL_DEVIATION_BREACHES_PAGE).toContain(
      "$where: DeviationThresholdBreach_bool_exp!",
    );
    expect(queries.POOL_DEVIATION_BREACHES_PAGE).toContain(
      "$orderBy: [DeviationThresholdBreach_order_by!]",
    );
  });

  it("POOL_DEVIATION_BREACHES_ALL caps at Hasura's row cap (1000)", () => {
    expect(queries.POOL_DEVIATION_BREACHES_ALL).toMatch(/limit:\s*1000\b/);
  });

  it("POOL_SWAPS_PAGE supports server-side ordering", () => {
    expect(queries.POOL_SWAPS_PAGE).toContain(
      "$orderBy: [SwapEvent_order_by!]!",
    );
  });

  it("POOL_REBALANCES_PAGE supports server-side ordering", () => {
    expect(queries.POOL_REBALANCES_PAGE).toContain(
      "$orderBy: [RebalanceEvent_order_by!]!",
    );
  });

  it("POOL_REBALANCES_USD_EXT is id-keyed extension (rationale: schema rollout)", () => {
    expect(queries.POOL_REBALANCES_USD_EXT).toContain("id: { _in: $ids }");
    expect(queries.POOL_REBALANCES_USD_EXT).toContain("notionalUsd");
    expect(queries.POOL_REBALANCES_USD_EXT).toContain("rewardUsd");
  });

  it("POOL_REBALANCE_REWARDS sorts by [blockNumber desc, id asc] (deterministic tie-break)", () => {
    expect(normalize(queries.POOL_REBALANCE_REWARDS)).toContain(
      "order_by: [{ blockNumber: desc }, { id: asc }]",
    );
  });

  it("LATEST_POOL_REBALANCE_FOR_STRATEGY filters by strategy address (sender)", () => {
    expect(queries.LATEST_POOL_REBALANCE_FOR_STRATEGY).toContain(
      "sender: { _eq: $strategy }",
    );
    expect(queries.LATEST_POOL_REBALANCE_FOR_STRATEGY).toMatch(/limit:\s*1\b/);
  });

  it("POOL_LIQUIDITY_PAGE supports server-side ordering", () => {
    expect(queries.POOL_LIQUIDITY_PAGE).toContain(
      "$orderBy: [LiquidityEvent_order_by!]!",
    );
  });

  it("POOL_SNAPSHOTS_CHART caps at 50000 rows", () => {
    expect(queries.POOL_SNAPSHOTS_CHART).toMatch(/limit:\s*50000\b/);
  });

  it("POOL_DAILY_SNAPSHOTS_CHART sorts [timestamp desc, id desc]", () => {
    expect(normalize(queries.POOL_DAILY_SNAPSHOTS_CHART)).toContain(
      "order_by: [{ timestamp: desc }, { id: desc }]",
    );
  });

  it("POOL_DAILY_SNAPSHOTS_ALL paginates by [timestamp desc, id desc] across pools", () => {
    expect(queries.POOL_DAILY_SNAPSHOTS_ALL).toContain("$poolIds: [String!]!");
    expect(normalize(queries.POOL_DAILY_SNAPSHOTS_ALL)).toContain(
      "order_by: [{ timestamp: desc }, { id: desc }]",
    );
  });

  it("BROKER_EXCHANGE_DAILY_SNAPSHOTS_24H reads the exchange daily rollup, not raw BrokerSwapEvent rows", () => {
    expect(queries.BROKER_EXCHANGE_DAILY_SNAPSHOTS_24H).toContain(
      "BrokerExchangeDailySnapshot",
    );
    expect(queries.BROKER_EXCHANGE_DAILY_SNAPSHOTS_24H).toContain(
      "exchangeId: { _eq: $exchangeId }",
    );
    expect(queries.BROKER_EXCHANGE_DAILY_SNAPSHOTS_24H).toContain(
      "exchangeProvider: { _eq: $exchangeProvider }",
    );
    expect(queries.BROKER_EXCHANGE_DAILY_SNAPSHOTS_24H).toContain(
      "timestamp: { _gte: $since }",
    );
    expect(queries.BROKER_EXCHANGE_DAILY_SNAPSHOTS_24H).not.toContain(
      "BrokerSwapEvent",
    );
  });

  it("ALL_TRADING_LIMITS scopes by chainId", () => {
    expect(queries.ALL_TRADING_LIMITS).toContain("chainId: { _eq: $chainId }");
  });

  it("TRADING_LIMITS scopes by poolId", () => {
    expect(queries.TRADING_LIMITS).toContain("poolId: { _eq: $poolId }");
  });

  it("ORACLE_SNAPSHOTS supports server-side ordering", () => {
    expect(queries.ORACLE_SNAPSHOTS).toContain(
      "$orderBy: [OracleSnapshot_order_by!]!",
    );
  });

  it("ORACLE_SNAPSHOTS queries stay scoped to oracle/breaker fields", () => {
    for (const query of [
      queries.ORACLE_SNAPSHOTS,
      queries.ORACLE_SNAPSHOTS_CHART,
    ]) {
      expect(query).not.toContain("priceDifference");
      expect(query).not.toContain("rebalanceThreshold");
      expect(query).not.toContain("deviationRatio");
      expect(query).not.toContain("hasHealthData");
      expect(query).not.toContain("degenerateReserves");
    }
  });

  it("ORACLE_SNAPSHOTS_CHART folds in the persisted breaker band fields", () => {
    // The persisted-band fields used to ride a companion query
    // (ORACLE_SNAPSHOTS_CHART_BANDS_EXT) to survive a hosted-Hasura schema-lag
    // window. That window is long closed (both fields resolve on prod), so
    // they're now selected on the primary chart query — one round-trip.
    expect(queries.ORACLE_SNAPSHOTS_CHART).toContain(
      "breakerBaselineAtSnapshot",
    );
    expect(queries.ORACLE_SNAPSHOTS_CHART).toContain(
      "breakerThresholdAtSnapshot",
    );
  });

  it("ORACLE_SNAPSHOTS_CHART is keyset-paginated by timestamp", () => {
    // Scroll-back past the 1000-row Hasura cap: the chart pages older windows
    // via `timestamp: { _lt: $beforeTimestamp }` with an `id` order tiebreaker.
    expect(queries.ORACLE_SNAPSHOTS_CHART).toContain(
      "$beforeTimestamp: numeric!",
    );
    expect(queries.ORACLE_SNAPSHOTS_CHART).toContain(
      "timestamp: { _lt: $beforeTimestamp }",
    );
    expect(queries.ORACLE_SNAPSHOTS_CHART).toContain(
      "order_by: [{ timestamp: desc }, { id: desc }]",
    );
  });

  it("ORACLE_PRICE_DAILY selects OHLC + the precomputed anyOutOfBand verdict", () => {
    expect(queries.ORACLE_PRICE_DAILY).toContain("OraclePriceDailySnapshot");
    expect(queries.ORACLE_PRICE_DAILY).toContain("closePrice");
    expect(queries.ORACLE_PRICE_DAILY).toContain("anyOutOfBand");
    // DESC so the 1000-row cap drops the OLDEST days (keeping the newest ~2.7yr);
    // the consumer reverses to chronological. No `limit` (the cap is the bound).
    expect(queries.ORACLE_PRICE_DAILY).toContain(
      "order_by: [{ bucketStart: desc }]",
    );
    expect(queries.ORACLE_PRICE_DAILY).not.toContain("limit:");
  });

  it("POOL_DEPLOYMENT looks up FactoryDeployment.txHash", () => {
    expect(queries.POOL_DEPLOYMENT).toContain("FactoryDeployment");
    expect(queries.POOL_DEPLOYMENT).toContain("txHash");
  });

  it("POOL_LP_POSITIONS orders by netLiquidity desc", () => {
    expect(queries.POOL_LP_POSITIONS).toContain(
      "order_by: { netLiquidity: desc }",
    );
  });

  it("UNIQUE_LP_ADDRESSES filters netLiquidity > 0 across multiple pools", () => {
    expect(queries.UNIQUE_LP_ADDRESSES).toContain("poolId: { _in: $poolIds }");
    expect(queries.UNIQUE_LP_ADDRESSES).toContain('netLiquidity: { _gt: "0" }');
  });

  it("OLS_POOL filters isActive: true and limits 1", () => {
    expect(queries.OLS_POOL).toContain("isActive: { _eq: true }");
    expect(queries.OLS_POOL).toMatch(/limit:\s*1\b/);
  });

  it("ALL_OLS_POOLS filters isActive: true scoped to chainId", () => {
    expect(queries.ALL_OLS_POOLS).toContain("isActive: { _eq: true }");
    expect(queries.ALL_OLS_POOLS).toContain("chainId: { _eq: $chainId }");
  });

  it("ALL_CDP_POOLS filters removed pools scoped to chainId", () => {
    expect(queries.ALL_CDP_POOLS).toContain("removed: { _eq: false }");
    expect(queries.ALL_CDP_POOLS).toContain("chainId: { _eq: $chainId }");
  });

  it("POOL_BREAKER_CONFIG queries both BreakerConfig and BreakerTripEvent in one round-trip", () => {
    expect(queries.POOL_BREAKER_CONFIG).toContain("BreakerConfig");
    expect(queries.POOL_BREAKER_CONFIG).toContain("BreakerTripEvent");
    expect(queries.POOL_BREAKER_CONFIG).toContain(
      "rateFeedID: { _eq: $rateFeedID }",
    );
  });

  it("POOL_DAILY_FEE_SNAPSHOTS_PAGE paginates by [timestamp desc, id desc] scoped to chainId", () => {
    expect(queries.POOL_DAILY_FEE_SNAPSHOTS_PAGE).toContain("$chainId: Int!");
    expect(queries.POOL_DAILY_FEE_SNAPSHOTS_PAGE).toContain("$limit: Int!");
    expect(queries.POOL_DAILY_FEE_SNAPSHOTS_PAGE).toContain("$offset: Int!");
    expect(normalize(queries.POOL_DAILY_FEE_SNAPSHOTS_PAGE)).toContain(
      "order_by: [{ timestamp: desc }, { id: desc }]",
    );
    expect(queries.POOL_DAILY_FEE_SNAPSHOTS_PAGE).toContain("feesUsdWei");
  });
});

describe("@/lib/queries — full module snapshot (locks every query's structure + field selection, whitespace-normalized)", () => {
  it("matches the module-wide snapshot", () => {
    const sorted = Object.fromEntries(
      Object.entries(queries)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, normalize(String(v))]),
    );
    expect(sorted).toMatchSnapshot();
  });
});
