import { GraphQLClient, gql } from "graphql-request";
import { HASURA_URL } from "../config.js";

const REQUEST_TIMEOUT_MS = 15_000;

export const PEG_STRUCTURAL_PAGE_LIMIT = 1_000;
export const PEG_BREAKER_CONFIG_LIMIT = 8;

// Keep the structural fetch isolated from the bridge's load-bearing pool query:
// a peg-specific schema or request failure must fail this coverage path closed
// without suppressing the existing pool metric family.
export const PEG_STRUCTURAL_QUERY = gql`
  query PegStructuralContext(
    $poolId: String!
    $monitoredToken: String!
    $chainId: Int!
    $rateFeedId: String!
    $since: numeric!
  ) {
    Pool(where: { id: { _eq: $poolId } }, limit: 1) {
      id
      chainId
      source
      token0
      token1
      token0Decimals
      token1Decimals
      reserves0
      reserves1
      referenceRateFeedID
    }
    TradingLimit(
      where: { poolId: { _eq: $poolId }, token: { _eq: $monitoredToken } }
      limit: 1
    ) {
      id
      chainId
      poolId
      token
      limit0
      limit1
      decimals
      netflow0
      netflow1
      lastUpdated0
      lastUpdated1
      updatedAtBlock
      updatedAtTimestamp
    }
    BreakerConfig(
      where: { chainId: { _eq: $chainId }, rateFeedID: { _eq: $rateFeedId } }
      order_by: { id: asc }
      limit: 8
    ) {
      id
      enabled
      rateChangeThreshold
      referenceValue
      lastMedianRate
      lastUpdatedAt
      status
      tradingMode
      lastStatusUpdatedAt
      breaker {
        id
        address
        kind
        defaultRateChangeThreshold
        removed
      }
    }
    SwapEvent(
      where: { poolId: { _eq: $poolId }, blockTimestamp: { _gte: $since } }
      order_by: [{ blockTimestamp: desc }, { id: desc }]
      limit: 1000
    ) {
      id
      caller
      amount0In
      amount1In
      amount0Out
      amount1Out
      blockTimestamp
    }
  }
`;

export type PegStructuralPoolRow = {
  id: string;
  chainId: number;
  source: string;
  token0: string | null;
  token1: string | null;
  token0Decimals: number;
  token1Decimals: number;
  reserves0: string;
  reserves1: string;
  referenceRateFeedID: string;
};

export type PegTradingLimitRow = {
  id: string;
  chainId: number;
  poolId: string;
  token: string;
  limit0: string;
  limit1: string;
  decimals: number;
  netflow0: string;
  netflow1: string;
  lastUpdated0: string;
  lastUpdated1: string;
  updatedAtBlock: string;
  updatedAtTimestamp: string;
};

export type PegSwapEventRow = {
  id: string;
  caller: string;
  amount0In: string;
  amount1In: string;
  amount0Out: string;
  amount1Out: string;
  blockTimestamp: string;
};

export type PegBreakerConfigRow = {
  id: string;
  enabled: boolean;
  rateChangeThreshold: string;
  referenceValue: string | null;
  lastMedianRate: string | null;
  lastUpdatedAt: string | null;
  status: "OK" | "TRIPPED";
  tradingMode: number;
  lastStatusUpdatedAt: string;
  breaker: {
    id: string;
    address: string;
    kind: "MEDIAN_DELTA" | "VALUE_DELTA" | "MARKET_HOURS";
    defaultRateChangeThreshold: string;
    removed: boolean;
  };
};

export type PegStructuralQueryVariables = {
  poolId: string;
  monitoredToken: string;
  chainId: number;
  rateFeedId: string;
  since: string;
};

export type PegStructuralQueryResponse = {
  Pool: PegStructuralPoolRow[];
  TradingLimit: PegTradingLimitRow[];
  BreakerConfig?: PegBreakerConfigRow[];
  SwapEvent: PegSwapEventRow[];
};

export type PegStructuralRequest = (options: {
  document: string;
  variables: PegStructuralQueryVariables;
  signal: AbortSignal;
}) => Promise<PegStructuralQueryResponse>;

export type PegStructuralContextResult =
  | {
      status: "ok";
      pool: PegStructuralPoolRow;
      tradingLimit: PegTradingLimitRow;
      breakerConfigs?: PegBreakerConfigRow[];
      swaps: PegSwapEventRow[];
      pageSaturated: boolean;
    }
  | {
      status: "pool_missing";
      poolId: string;
      swaps: PegSwapEventRow[];
      pageSaturated: boolean;
    }
  | {
      status: "trading_limit_missing";
      pool: PegStructuralPoolRow;
      monitoredToken: string;
      swaps: PegSwapEventRow[];
      pageSaturated: boolean;
    };

const client = new GraphQLClient(HASURA_URL);

const defaultRequest: PegStructuralRequest = async (options) =>
  client.request<PegStructuralQueryResponse, PegStructuralQueryVariables>(
    options,
  );

export async function fetchPegStructuralContext(
  input: {
    poolId: string;
    monitoredToken: string;
    chainId: number;
    rateFeedId: string;
    since: bigint;
  },
  request: PegStructuralRequest = defaultRequest,
): Promise<PegStructuralContextResult> {
  const data = await request({
    document: PEG_STRUCTURAL_QUERY,
    variables: {
      poolId: input.poolId,
      monitoredToken: input.monitoredToken,
      chainId: input.chainId,
      rateFeedId: input.rateFeedId,
      // graphql-request cannot JSON.stringify a native bigint. Hasura's BigInt
      // scalar accepts the lossless decimal string form.
      since: input.since.toString(),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const swaps = data.SwapEvent;
  const pageSaturated = swaps.length >= PEG_STRUCTURAL_PAGE_LIMIT;
  const pool = data.Pool[0];
  if (pool === undefined) {
    return {
      status: "pool_missing",
      poolId: input.poolId,
      swaps,
      pageSaturated,
    };
  }

  const tradingLimit = data.TradingLimit[0];
  if (tradingLimit === undefined) {
    return {
      status: "trading_limit_missing",
      pool,
      monitoredToken: input.monitoredToken,
      swaps,
      pageSaturated,
    };
  }

  return {
    status: "ok",
    pool,
    tradingLimit,
    breakerConfigs: data.BreakerConfig ?? [],
    swaps,
    pageSaturated,
  };
}
