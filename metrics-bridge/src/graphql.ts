import { GraphQLClient, gql } from "graphql-request";
import { HASURA_URL } from "./config.js";
import type { BridgePoolsResponse, PoolRow } from "./types.js";

const REQUEST_TIMEOUT_MS = 15_000;

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
    }
  }
`;

// Legacy query without `lastEffectivenessRatio` — used only as a schema-lag
// fallback when Hasura has not yet applied the indexer redeploy that adds
// the field. Delete this (and the fallback branch in `fetchPools`) once all
// Envio deployments are confirmed to have the new schema.
const BRIDGE_POOLS_QUERY_LEGACY = gql`
  query BridgePoolsLegacy {
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
      hasHealthData
    }
  }
`;

type LegacyPoolRow = Omit<PoolRow, "lastEffectivenessRatio">;
interface BridgePoolsLegacyResponse {
  Pool: LegacyPoolRow[];
}

const client = new GraphQLClient(HASURA_URL);

// Detect the specific Hasura validation error that fires when the running
// indexer deployment pre-dates the `lastEffectivenessRatio` schema change.
// We intentionally do NOT broaden to all GraphQL errors — unrelated failures
// should still trip `pollErrors` + propagate.
function isMissingEffectivenessFieldError(err: unknown): boolean {
  if (!err || typeof err !== "object" || !("response" in err)) return false;
  const response = (
    err as {
      response?: { errors?: Array<{ message?: string }> };
    }
  ).response;
  const errors = response?.errors;
  if (!Array.isArray(errors)) return false;
  return errors.some(
    (e) =>
      typeof e?.message === "string" &&
      e.message.includes("lastEffectivenessRatio"),
  );
}

export async function fetchPools(): Promise<BridgePoolsResponse> {
  try {
    return await client.request<BridgePoolsResponse>({
      document: BRIDGE_POOLS_QUERY,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (!isMissingEffectivenessFieldError(err)) throw err;
    // Schema-lag fallback: the bridge Cloud Run service may deploy before the
    // Envio indexer redeploy lands. Without this branch, every poll fails,
    // `markHealthy()` never runs, and the service crash-loops on /health 503
    // until the indexer catches up. Synthesize the "-1" sentinel so
    // `updateMetrics` skips publishing the new gauge (per the same-string
    // check in metrics.ts) and all other gauges continue to emit.
    console.warn(
      "[metrics-bridge] Hasura schema missing `lastEffectivenessRatio` — falling back to legacy query. Remove this fallback once all Envio deployments confirm the new schema.",
    );
    const data = await client.request<BridgePoolsLegacyResponse>({
      document: BRIDGE_POOLS_QUERY_LEGACY,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return {
      Pool: data.Pool.map((p) => ({ ...p, lastEffectivenessRatio: "-1" })),
    };
  }
}
