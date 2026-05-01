import { describe, expect, it } from "vitest";

import * as queries from "@/lib/queries";

const EXPECTED_EXPORT_NAMES = [
  "ALL_POOLS_WITH_HEALTH",
  "ALL_POOLS_BREACH_ROLLUP",
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
  "POOL_CONFIG_EXT",
  "POOL_BREACH_ROLLUP",
  "POOL_HEALTH_7D_ANCHOR",
  "POOL_OPEN_BREACH_TX",
  "POOL_DEVIATION_BREACHES_PAGE",
  "POOL_DEVIATION_BREACHES_COUNT",
  "POOL_DEVIATION_BREACHES_ALL",
  "POOL_SNAPSHOTS_CHART",
  "POOL_DAILY_SNAPSHOTS_CHART",
  "POOL_DAILY_SNAPSHOTS_ALL",
  "ALL_TRADING_LIMITS",
  "TRADING_LIMITS",
  "ORACLE_SNAPSHOTS",
  "ORACLE_SNAPSHOTS_CHART",
  "ORACLE_SNAPSHOTS_COUNT_PAGE",
  "POOL_DEPLOYMENT",
  "POOL_LP_POSITIONS",
  "UNIQUE_LP_ADDRESSES",
  "OLS_POOL",
  "OLS_LIQUIDITY_EVENTS_PAGE",
  "OLS_LIQUIDITY_EVENTS_COUNT",
  "ALL_OLS_POOLS",
  "POOL_BREAKER_CONFIG",
  "PROTOCOL_FEE_TRANSFERS_ALL",
] as const;

const normalize = (s: string) => s.replace(/\s+/g, " ").trim();

describe("@/lib/queries — surface contract", () => {
  it("exports every expected query name", () => {
    const actual = Object.keys(queries).sort();
    const expected = [...EXPECTED_EXPORT_NAMES].sort();
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

  it("POOL_BREACH_ROLLUP returns just rollup counters", () => {
    expect(queries.POOL_BREACH_ROLLUP).toContain("breachCount");
    expect(queries.POOL_BREACH_ROLLUP).toContain("healthBinarySeconds");
    expect(queries.POOL_BREACH_ROLLUP).toContain("healthTotalSeconds");
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

  it("ORACLE_SNAPSHOTS_CHART selects deviationRatio + hasHealthData", () => {
    expect(queries.ORACLE_SNAPSHOTS_CHART).toContain("deviationRatio");
    expect(queries.ORACLE_SNAPSHOTS_CHART).toContain("hasHealthData");
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

  it("POOL_BREAKER_CONFIG queries both BreakerConfig and BreakerTripEvent in one round-trip", () => {
    expect(queries.POOL_BREAKER_CONFIG).toContain("BreakerConfig");
    expect(queries.POOL_BREAKER_CONFIG).toContain("BreakerTripEvent");
    expect(queries.POOL_BREAKER_CONFIG).toContain(
      "rateFeedID: { _eq: $rateFeedID }",
    );
  });

  it("PROTOCOL_FEE_TRANSFERS_ALL caps at 10000 rows", () => {
    expect(queries.PROTOCOL_FEE_TRANSFERS_ALL).toMatch(/limit:\s*10000\b/);
  });
});

describe("@/lib/queries — full module snapshot (locks every query string verbatim)", () => {
  it("matches the module-wide snapshot", () => {
    const sorted = Object.fromEntries(
      Object.entries(queries)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, normalize(String(v))]),
    );
    expect(sorted).toMatchSnapshot();
  });
});
