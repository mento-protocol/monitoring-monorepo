import { GraphQLClient, gql } from "graphql-request";
import { HASURA_URL } from "./config.js";
import type { BridgePoolsResponse } from "./types.js";

const BRIDGE_POOLS_QUERY = gql`
  query BridgePools {
    Pool(where: { source: { _like: "%fpmm%" } }) {
      id
      chainId
      token0
      token1
      source
      healthStatus
      oracleOk
      oracleTimestamp
      oracleExpiry
      lastDeviationRatio
      deviationBreachStartedAt
      limitStatus
      limitPressure0
      limitPressure1
      lastRebalancedAt
      rebalanceLivenessStatus
    }
  }
`;

const client = new GraphQLClient(HASURA_URL);

export async function fetchPools(): Promise<BridgePoolsResponse> {
  return client.request<BridgePoolsResponse>(BRIDGE_POOLS_QUERY);
}
