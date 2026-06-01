import { ClientError, GraphQLClient, gql } from "graphql-request";
import { HASURA_URL } from "./config.js";
import type { BridgePoolsResponse, PoolRow } from "./types.js";

const REQUEST_TIMEOUT_MS = 15_000;

// `BRIDGE_POOLS_QUERY` is the load-bearing one — base pool state for every
// FPMM gauge. Schema-stable: every field on it has been live in production
// for >1 release. NEW indexer columns MUST land in an isolated companion
// query so a deploy-window schema mismatch only loses the new annotation or
// alert refinement, not every pool gauge — `fetchPools` falls back to base
// values when a companion query fails with an unknown-field error.
// `lastMedianPrice` is on the BASE query because it predates this PR (used
// by the indexer's jump computation since the initial Oracle Jump alert), so
// degraded mode keeps publishing the current-price gauge — only the
// previous-price pair drops out.
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

// Optional companion query for the open-breach denormalized state. Grafana
// uses this to keep the critical deviation alert firing until a breach that
// crossed the critical magnitude actually returns within tolerance.
const BRIDGE_POOLS_OPEN_BREACH_QUERY = gql`
  query BridgePoolsOpenBreach {
    Pool(where: { source: { _like: "%fpmm%" } }) {
      id
      currentOpenBreachPeak
      currentOpenBreachEntryThreshold
    }
  }
`;

// Optional companion query for the transaction that produced the last oracle
// update. If this column is unavailable during a schema rollout, only the
// Slack deep link degrades; timestamp/liveness metrics keep publishing.
const BRIDGE_POOLS_ORACLE_TX_QUERY = gql`
  query BridgePoolsOracleTx {
    Pool(where: { source: { _like: "%fpmm%" } }) {
      id
      oracleTxHash
    }
  }
`;

type OracleLineageRow = Pick<
  PoolRow,
  "id" | "prevMedianPrice" | "prevMedianAt"
>;

type OpenBreachRow = Pick<
  PoolRow,
  "id" | "currentOpenBreachPeak" | "currentOpenBreachEntryThreshold"
>;

type OracleTxRow = Pick<PoolRow, "id" | "oracleTxHash">;

type BridgePoolsBaseResponse = {
  Pool: Omit<
    PoolRow,
    | "oracleTxHash"
    | "prevMedianPrice"
    | "prevMedianAt"
    | "currentOpenBreachPeak"
    | "currentOpenBreachEntryThreshold"
  >[];
};

const LINEAGE_DEFAULTS = {
  prevMedianPrice: "0",
  prevMedianAt: "0",
} as const;

const OPEN_BREACH_DEFAULTS = {
  currentOpenBreachPeak: "0",
  currentOpenBreachEntryThreshold: 0,
} as const;

const ORACLE_TX_DEFAULTS = {
  oracleTxHash: "",
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

const unknownFieldWarnings = {
  oracleLineage: false,
  openBreach: false,
  oracleTx: false,
};

async function requestOptionalPoolRows<T>(
  document: string,
  signal: AbortSignal,
  warningKey: keyof typeof unknownFieldWarnings,
  message: string,
): Promise<{ Pool: T[] }> {
  try {
    return await client.request<{ Pool: T[] }>({ document, signal });
  } catch (err) {
    if (!isUnknownFieldError(err)) throw err;
    if (!unknownFieldWarnings[warningKey]) {
      unknownFieldWarnings[warningKey] = true;
      console.warn(message);
    }
    return { Pool: [] };
  }
}

export async function fetchPools(): Promise<BridgePoolsResponse> {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const [base, lineage, openBreach, oracleTx] = await Promise.all([
    client.request<BridgePoolsBaseResponse>({
      document: BRIDGE_POOLS_QUERY,
      signal,
    }),
    requestOptionalPoolRows<OracleLineageRow>(
      BRIDGE_POOLS_ORACLE_LINEAGE_QUERY,
      signal,
      "oracleLineage",
      "[metrics-bridge] Hasura schema missing oracle-lineage fields; Oracle Jump previous-price annotation disabled until indexer catches up.",
    ),
    requestOptionalPoolRows<OpenBreachRow>(
      BRIDGE_POOLS_OPEN_BREACH_QUERY,
      signal,
      "openBreach",
      "[metrics-bridge] Hasura schema missing open-breach fields; deviation critical de-escalation persistence disabled until indexer catches up.",
    ),
    requestOptionalPoolRows<OracleTxRow>(
      BRIDGE_POOLS_ORACLE_TX_QUERY,
      signal,
      "oracleTx",
      "[metrics-bridge] Hasura schema missing oracle tx hash field; oracle alert transaction links disabled until indexer catches up.",
    ),
  ]);

  const lineageById = new Map(lineage.Pool.map((p) => [p.id, p]));
  const openBreachById = new Map(openBreach.Pool.map((p) => [p.id, p]));
  const oracleTxById = new Map(oracleTx.Pool.map((p) => [p.id, p]));
  return {
    Pool: base.Pool.map((p) => ({
      ...p,
      ...ORACLE_TX_DEFAULTS,
      ...LINEAGE_DEFAULTS,
      ...OPEN_BREACH_DEFAULTS,
      ...lineageById.get(p.id),
      ...openBreachById.get(p.id),
      ...oracleTxById.get(p.id),
    })),
  };
}
