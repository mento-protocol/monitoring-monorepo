import { ClientError, GraphQLClient, gql } from "graphql-request";
import { HASURA_URL } from "./config.js";
import type { BridgePoolsResponse, PoolRow } from "./types.js";

const REQUEST_TIMEOUT_MS = 15_000;

// `BRIDGE_POOLS_QUERY` is the load-bearing one — base pool state for every
// FPMM gauge. Schema-stable: every field on it has been live in production
// for >1 release. NEW indexer columns MUST land in
// `BRIDGE_POOLS_ORACLE_LINEAGE_QUERY` (or a sibling) so a deploy-window
// schema mismatch only loses the new annotation, not every pool gauge —
// `fetchPools` falls back to base values when the lineage query fails with
// an unknown-field error. `lastMedianPrice` is on the BASE query because
// it predates this PR (used by the indexer's jump computation since the
// initial Oracle Jump alert), so degraded mode keeps publishing the
// current-price gauge — only the previous-price pair drops out.
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
      lastEffectivenessRatio
      rebalanceLivenessStatus
      hasHealthData
      lpFee
      protocolFee
      lastMedianPrice
      lastOracleJumpBps
      lastOracleJumpAt
      reserves0
      reserves1
      token0Decimals
      token1Decimals
      rebalancerAddress
    }
  }
`;

// Optional companion query — only the truly new columns this PR introduced.
// Isolated so a schema/deploy-order mismatch (bridge ships ahead of indexer
// re-sync) degrades to "no previous-price annotation" instead of "every
// pool metric stale".
const BRIDGE_POOLS_ORACLE_LINEAGE_QUERY = gql`
  query BridgePoolsOracleLineage {
    Pool(where: { source: { _like: "%fpmm%" } }) {
      id
      prevMedianPrice
      prevMedianAt
    }
  }
`;

const BRIDGE_LATEST_REBALANCES_QUERY = gql`
  query BridgeLatestRebalances {
    RebalanceEvent(
      distinct_on: poolId
      order_by: [{ poolId: asc }, { blockTimestamp: desc }]
    ) {
      poolId
      txHash
    }
  }
`;

type OracleLineageRow = Pick<
  PoolRow,
  "id" | "prevMedianPrice" | "prevMedianAt"
>;

type BridgePoolsBaseResponse = {
  Pool: Omit<
    PoolRow,
    "prevMedianPrice" | "prevMedianAt" | "latestRebalanceTxHash"
  >[];
};

type BridgePoolsOracleLineageResponse = { Pool: OracleLineageRow[] };
type LatestRebalanceRow = { poolId: string; txHash: string };
type BridgeLatestRebalancesResponse = { RebalanceEvent: LatestRebalanceRow[] };

const LINEAGE_DEFAULTS = {
  prevMedianPrice: "0",
  prevMedianAt: "0",
  latestRebalanceTxHash: "",
} as const;

const client = new GraphQLClient(HASURA_URL);

// Whether a GraphQL error is a Hasura "unknown field" report. Typical shape
// from a fresh deploy where Hasura hasn't tracked the new columns yet:
//   field "prevMedianPrice" not found in type: 'Pool'
// or:
//   field 'prevMedianAt' not found in type 'Pool'
// Match conservatively so a transient network/timeout error never trips
// the degraded path.
function isUnknownFieldError(err: unknown): boolean {
  if (!(err instanceof ClientError)) return false;
  const errors = err.response?.errors ?? [];
  return errors.some((e) =>
    /field\s+["']?\w+["']?\s+not found/i.test(e.message),
  );
}

let unknownFieldWarned = false;
let latestRebalancesWarned = false;

export async function fetchPools(): Promise<BridgePoolsResponse> {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const [base, lineage, latestRebalances] = await Promise.all([
    client.request<BridgePoolsBaseResponse>({
      document: BRIDGE_POOLS_QUERY,
      signal,
    }),
    client
      .request<BridgePoolsOracleLineageResponse>({
        document: BRIDGE_POOLS_ORACLE_LINEAGE_QUERY,
        signal,
      })
      .catch((err: unknown) => {
        if (!isUnknownFieldError(err)) throw err;
        if (!unknownFieldWarned) {
          unknownFieldWarned = true;
          console.warn(
            "[metrics-bridge] Hasura schema missing oracle-lineage fields; Oracle Jump previous-price annotation disabled until indexer catches up.",
          );
        }
        return { Pool: [] as OracleLineageRow[] };
      }),
    client
      .request<BridgeLatestRebalancesResponse>({
        document: BRIDGE_LATEST_REBALANCES_QUERY,
        signal,
      })
      .catch((err: unknown) => {
        if (!latestRebalancesWarned) {
          latestRebalancesWarned = true;
          console.warn(
            "[metrics-bridge] Latest rebalance tx query failed; Slack tx links disabled until the next successful poll.",
            err,
          );
        }
        return { RebalanceEvent: [] as LatestRebalanceRow[] };
      }),
  ]);

  const lineageById = new Map(lineage.Pool.map((p) => [p.id, p]));
  const latestRebalanceByPoolId = new Map(
    latestRebalances.RebalanceEvent.map((r) => [r.poolId, r.txHash]),
  );
  return {
    Pool: base.Pool.map((p) => ({
      ...p,
      ...LINEAGE_DEFAULTS,
      ...lineageById.get(p.id),
      latestRebalanceTxHash: latestRebalanceByPoolId.get(p.id) ?? "",
    })),
  };
}
