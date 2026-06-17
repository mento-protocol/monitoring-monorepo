import { ClientError, GraphQLClient, gql } from "graphql-request";
import { HASURA_URL } from "./config.js";
import type { BridgePoolsResponse, PoolRow } from "./types.js";

const REQUEST_TIMEOUT_MS = 15_000;

// `BRIDGE_POOLS_QUERY` is the load-bearing one — base pool state for every
// FPMM gauge plus VP identity and report timestamps. Schema-stable: every field on it has been live in production
// for >1 release. NEW indexer columns MUST land in an isolated companion
// query so a deploy-window schema mismatch only loses the new annotation or
// alert refinement, not every pool gauge — `fetchPools` falls back to base
// values when a companion query fails with an unknown-field error.
// `lastMedianPrice` is on the BASE query because it predates this PR (used
// by the indexer's jump computation since the initial Oracle Jump alert), so
// degraded mode keeps publishing the current-price gauge — only the
// previous-price pair drops out.
//
// Companion-query exception: `wrappedExchangeId` stays on the BASE query even
// though it is "new" relative to most callers. It is load-bearing for
// CORRECTNESS, not just annotation — `isFpmmPool` filters VirtualPools on it
// together with `source.includes("virtual")`. Missing field → filter can't run
// → VPs leak as phantom FPMM gauges, which is WORSE than the base query failing
// loudly. Schema-stable since VP Phase 2 (see PR #853); fail-loud is the
// correct posture here.
export const BRIDGE_POOLS_QUERY = gql`
  query BridgePools {
    Pool {
      id
      chainId
      token0
      token1
      source
      # BASE query (not companion): load-bearing for VP exclusion — "" = FPMM, non-empty = healed VP.
      # A companion "wrappedExchangeId" with graceful "" fallback would silently let VPs leak as
      # phantom FPMM gauges. Fail-loud (base query error) is the correct posture here.
      wrappedExchangeId
      healthStatus
      oracleOk
      oracleTimestamp
      oracleExpiry
      oracleNumReporters
      lastOracleReportAt
      medianLive
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
export const BRIDGE_POOLS_ORACLE_LINEAGE_QUERY = gql`
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
export const BRIDGE_POOLS_OPEN_BREACH_QUERY = gql`
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
export const BRIDGE_POOLS_ORACLE_TX_QUERY = gql`
  query BridgePoolsOracleTx {
    Pool(where: { source: { _like: "%fpmm%" } }) {
      id
      oracleTxHash
    }
  }
`;

// Optional companion query for the VP-specific freshness window. If the bridge
// deploys before the indexer schema, only the new VP freshness metric degrades;
// FPMM gauges keep publishing.
export const BRIDGE_POOLS_VP_FRESHNESS_QUERY = gql`
  query BridgePoolsVpFreshness {
    Pool {
      id
      oracleFreshnessWindow
      tokenDecimalsKnown
    }
  }
`;

// Optional companion query for wrapped VirtualPool exchange state. A deprecated
// backing exchange OR factory lifecycle deprecation means the VP is retired,
// so stale freshness gauges should stop publishing instead of paging on
// expected inactivity. `minimumReports` feeds the VP median-validity gate.
export const BRIDGE_POOLS_VP_EXCHANGE_DEPRECATION_QUERY = gql`
  query BridgePoolsVpExchangeDeprecation {
    BiPoolExchange(where: { wrappedByPoolId: { _is_null: false } }) {
      wrappedByPoolId
      isDeprecated
      minimumReports
    }
  }
`;

export const BRIDGE_POOLS_VP_LIFECYCLE_DEPRECATION_QUERY = gql`
  query BridgePoolsVpLifecycleDeprecation {
    VirtualPoolLifecycle(
      where: { action: { _eq: "DEPRECATED" } }
      limit: 1000
    ) {
      poolId
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
type VpFreshnessRow = Pick<
  PoolRow,
  "id" | "oracleFreshnessWindow" | "tokenDecimalsKnown"
>;
type VpExchangeDeprecationRow = {
  wrappedByPoolId: string | null;
  isDeprecated: boolean;
  minimumReports?: string | null;
};
type VpLifecycleDeprecationRow = {
  poolId: string;
};

type BridgePoolsBaseResponse = {
  Pool: Omit<
    PoolRow,
    | "oracleTxHash"
    | "oracleFreshnessWindow"
    | "tokenDecimalsKnown"
    | "prevMedianPrice"
    | "prevMedianAt"
    | "currentOpenBreachPeak"
    | "currentOpenBreachEntryThreshold"
    | "wrappedExchangeDeprecated"
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

const VP_FRESHNESS_DEFAULTS = {
  oracleFreshnessWindow: "0",
  tokenDecimalsKnown: false,
  wrappedExchangeDeprecated: false,
  wrappedExchangeMinimumReports: "0",
} as const;

type BridgePoolCompanionResponses = {
  base: BridgePoolsBaseResponse;
  lineage: { Pool: OracleLineageRow[] };
  openBreach: { Pool: OpenBreachRow[] };
  oracleTx: { Pool: OracleTxRow[] };
  vpFreshness: { Pool: VpFreshnessRow[] };
  vpExchangeDeprecation: {
    BiPoolExchange: VpExchangeDeprecationRow[];
  };
  vpLifecycleDeprecation: {
    VirtualPoolLifecycle: VpLifecycleDeprecationRow[];
  };
};

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
  vpFreshness: false,
  vpExchangeDeprecation: false,
  vpLifecycleDeprecation: false,
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

async function requestOptionalVpExchangeDeprecationRows(
  signal: AbortSignal,
): Promise<{
  BiPoolExchange: VpExchangeDeprecationRow[];
}> {
  try {
    return await client.request<{
      BiPoolExchange: VpExchangeDeprecationRow[];
    }>({ document: BRIDGE_POOLS_VP_EXCHANGE_DEPRECATION_QUERY, signal });
  } catch (err) {
    if (!isUnknownFieldError(err)) throw err;
    if (!unknownFieldWarnings.vpExchangeDeprecation) {
      unknownFieldWarnings.vpExchangeDeprecation = true;
      console.warn(
        "[metrics-bridge] Hasura schema missing VP exchange deprecation state; exchange-retired VirtualPool staleness suppression disabled until indexer catches up.",
      );
    }
    return { BiPoolExchange: [] };
  }
}

async function requestOptionalVpLifecycleDeprecationRows(
  signal: AbortSignal,
): Promise<{
  VirtualPoolLifecycle: VpLifecycleDeprecationRow[];
}> {
  try {
    return await client.request<{
      VirtualPoolLifecycle: VpLifecycleDeprecationRow[];
    }>({ document: BRIDGE_POOLS_VP_LIFECYCLE_DEPRECATION_QUERY, signal });
  } catch (err) {
    if (!isUnknownFieldError(err)) throw err;
    if (!unknownFieldWarnings.vpLifecycleDeprecation) {
      unknownFieldWarnings.vpLifecycleDeprecation = true;
      console.warn(
        "[metrics-bridge] Hasura schema missing VP lifecycle deprecation state; factory-retired VirtualPool staleness suppression disabled until indexer catches up.",
      );
    }
    return { VirtualPoolLifecycle: [] };
  }
}

async function requestBridgePoolCompanions(
  signal: AbortSignal,
): Promise<BridgePoolCompanionResponses> {
  const [
    base,
    lineage,
    openBreach,
    oracleTx,
    vpFreshness,
    vpExchangeDeprecation,
    vpLifecycleDeprecation,
  ] = await Promise.all([
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
    requestOptionalPoolRows<VpFreshnessRow>(
      BRIDGE_POOLS_VP_FRESHNESS_QUERY,
      signal,
      "vpFreshness",
      "[metrics-bridge] Hasura schema missing VP oracle freshness field; VirtualPool oracle staleness metric disabled until indexer catches up.",
    ),
    requestOptionalVpExchangeDeprecationRows(signal),
    requestOptionalVpLifecycleDeprecationRows(signal),
  ]);
  return {
    base,
    lineage,
    openBreach,
    oracleTx,
    vpFreshness,
    vpExchangeDeprecation,
    vpLifecycleDeprecation,
  };
}

function mergeBridgePoolCompanions({
  base,
  lineage,
  openBreach,
  oracleTx,
  vpFreshness,
  vpExchangeDeprecation,
  vpLifecycleDeprecation,
}: BridgePoolCompanionResponses): BridgePoolsResponse {
  const lineageById = new Map(lineage.Pool.map((p) => [p.id, p]));
  const openBreachById = new Map(openBreach.Pool.map((p) => [p.id, p]));
  const oracleTxById = new Map(
    oracleTx.Pool.filter((p) => p.oracleTxHash).map((p) => [p.id, p]),
  );
  const vpFreshnessById = new Map(vpFreshness.Pool.map((p) => [p.id, p]));
  const deprecatedVpPoolIds = new Set<string>();
  const vpMinimumReportsByPoolId = new Map<string, string>();
  for (const e of vpExchangeDeprecation.BiPoolExchange) {
    if (e.wrappedByPoolId && e.minimumReports) {
      vpMinimumReportsByPoolId.set(e.wrappedByPoolId, e.minimumReports);
    }
    if (e.wrappedByPoolId && e.isDeprecated) {
      deprecatedVpPoolIds.add(e.wrappedByPoolId);
    }
  }
  for (const lifecycle of vpLifecycleDeprecation.VirtualPoolLifecycle) {
    deprecatedVpPoolIds.add(lifecycle.poolId);
  }
  return {
    Pool: base.Pool.map((p) => ({
      ...p,
      ...ORACLE_TX_DEFAULTS,
      ...VP_FRESHNESS_DEFAULTS,
      ...LINEAGE_DEFAULTS,
      ...OPEN_BREACH_DEFAULTS,
      ...lineageById.get(p.id),
      ...openBreachById.get(p.id),
      ...oracleTxById.get(p.id),
      ...vpFreshnessById.get(p.id),
      wrappedExchangeDeprecated: deprecatedVpPoolIds.has(p.id),
      wrappedExchangeMinimumReports:
        vpMinimumReportsByPoolId.get(p.id) ??
        VP_FRESHNESS_DEFAULTS.wrappedExchangeMinimumReports,
    })),
  };
}

export async function fetchPools(): Promise<BridgePoolsResponse> {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return mergeBridgePoolCompanions(await requestBridgePoolCompanions(signal));
}
