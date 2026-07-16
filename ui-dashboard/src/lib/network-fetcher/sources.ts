// Fires the 13-way parallel fan-out behind `fetchNetworkData`: fee/daily/
// broker snapshots, LP addresses, OLS pools, breach rollup, health cursor,
// rebalance-threshold-known, VP oracle freshness, VP deprecation x2, indexed
// CDP pools, and fallback strategy probes. Each branch is isolated behind
// `Promise.allSettled` so one query's schema-lag or timeout degrades only
// its own slice instead of failing the whole pool list.

import type { GraphQLClient } from "@/lib/graphql-fetch";
import type { Network } from "@/lib/networks";
import {
  ALL_CDP_POOLS,
  ALL_OLS_POOLS,
  ALL_POOLS_BREACH_ROLLUP,
  ALL_POOLS_HEALTH_CURSOR,
  ALL_POOLS_REBALANCE_THRESHOLDS_KNOWN,
  ALL_POOLS_VP_DEPRECATION,
  ALL_POOLS_VP_LIFECYCLE_DEPRECATION,
  ALL_POOLS_VP_ORACLE_FRESHNESS,
} from "@/lib/queries";
import { usesRuntimeStrategyProbe } from "@/lib/strategy-probe-scope";
import type { Pool, PoolDailyFeeSnapshot } from "@/lib/types";
import { shouldQueryPoolSnapshots } from "@/lib/volume";
import {
  fetchAllBrokerDailySnapshotPages,
  fetchAllDailySnapshotPages,
  fetchAllFeeSnapshotPages,
  fetchAllLpAddressPages,
} from "./pagination";
import {
  emptyStrategyIds,
  usesIndexedCdpPools,
  type CdpPoolsResponse,
  type ProbedStrategies,
} from "./strategy-resolution";
import type {
  BrokerDailySnapshotRow,
  OlsPoolsResult,
  ObservedResult,
  PaginatedPageResult,
  PoolBreachRollupResult,
  PoolHealthCursorResult,
  PoolRebalanceThresholdsKnownResult,
  PoolsVpOracleFreshnessResult,
  SnapshotPageResult,
  VpLifecycleDeprecationResult,
} from "./types";
import type { VpExchangeDeprecationResult } from "./vp-deprecation";

export type TimedRequest = <T>(
  document: string,
  variables?: Record<string, unknown>,
) => Promise<T>;

export type NetworkSources = {
  feeSnapshots: PromiseSettledResult<PaginatedPageResult<PoolDailyFeeSnapshot>>;
  snapshotsAllDaily: PromiseSettledResult<SnapshotPageResult>;
  brokerSnapshotsAllDaily: PromiseSettledResult<
    PaginatedPageResult<BrokerDailySnapshotRow>
  >;
  lp: PromiseSettledResult<PaginatedPageResult<{ address: string }>>;
  ols: PromiseSettledResult<OlsPoolsResult>;
  breachRollup: PromiseSettledResult<PoolBreachRollupResult>;
  healthCursor: PromiseSettledResult<PoolHealthCursorResult>;
  rebalanceThresholdsKnown: PromiseSettledResult<PoolRebalanceThresholdsKnownResult>;
  vpOracleFreshness: PromiseSettledResult<
    ObservedResult<PoolsVpOracleFreshnessResult>
  >;
  vpDeprecation: PromiseSettledResult<VpExchangeDeprecationResult>;
  vpLifecycleDeprecation: PromiseSettledResult<VpLifecycleDeprecationResult>;
  indexedCdpPools: PromiseSettledResult<CdpPoolsResponse>;
  fallbackStrategies: PromiseSettledResult<Readonly<ProbedStrategies>>;
};

function requestIndexedCdpPools(
  network: Network,
  timed: TimedRequest,
): Promise<CdpPoolsResponse> {
  if (!usesIndexedCdpPools(network)) return Promise.resolve({ CdpPool: [] });
  return timed<CdpPoolsResponse>(ALL_CDP_POOLS, { chainId: network.chainId });
}

async function requestFallbackStrategies(
  network: Network,
  pools: Pool[],
): Promise<Readonly<ProbedStrategies>> {
  if (!usesRuntimeStrategyProbe(network)) return emptyStrategyIds();
  const { detectProbedStrategies } = await import("@/lib/strategy-detection");
  return detectProbedStrategies(network, pools);
}

type SourcesArgs = {
  client: GraphQLClient;
  network: Network;
  timed: TimedRequest;
  chainVariables: Record<string, unknown>;
  pools: Pool[];
  poolIds: string[];
  fpmmPoolIds: string[];
  snapshotTailNowMs: number;
};

// Positional tuple matching `fetchNetworkSources`'s destructure order below —
// kept as its own function so the 13-item fan-out (with its per-branch
// isolation rationale) stays readable as one literal instead of folded into
// a larger function body.
function buildSourcePromises(
  args: SourcesArgs,
): [
  Promise<PaginatedPageResult<PoolDailyFeeSnapshot>>,
  Promise<SnapshotPageResult>,
  Promise<PaginatedPageResult<BrokerDailySnapshotRow>>,
  Promise<PaginatedPageResult<{ address: string }>>,
  Promise<OlsPoolsResult>,
  Promise<PoolBreachRollupResult>,
  Promise<PoolHealthCursorResult>,
  Promise<PoolRebalanceThresholdsKnownResult>,
  Promise<ObservedResult<PoolsVpOracleFreshnessResult>>,
  Promise<VpExchangeDeprecationResult>,
  Promise<VpLifecycleDeprecationResult>,
  Promise<CdpPoolsResponse>,
  Promise<Readonly<ProbedStrategies>>,
] {
  const {
    client,
    network,
    timed,
    chainVariables,
    pools,
    poolIds,
    fpmmPoolIds,
    snapshotTailNowMs,
  } = args;
  const emptySnapshotPage: SnapshotPageResult = {
    rows: [],
    truncated: false,
    error: null,
  };

  return [
    fetchAllFeeSnapshotPages(client, network.chainId, network.id),
    shouldQueryPoolSnapshots(poolIds)
      ? fetchAllDailySnapshotPages(
          client,
          poolIds,
          network.id,
          snapshotTailNowMs,
        )
      : Promise.resolve(emptySnapshotPage),
    // Legacy v2 daily volume rollup (Broker.Swap with `routedViaV3Router=false`).
    // Filtered server-side by chainId — only Celo has a Broker today, but
    // querying on every chain is harmless (Monad simply returns 0 rows).
    fetchAllBrokerDailySnapshotPages(client, network.chainId, network.id),
    fpmmPoolIds.length > 0
      ? fetchAllLpAddressPages(client, fpmmPoolIds, network.id)
      : Promise.resolve({
          rows: [] as { address: string }[],
          truncated: false,
          error: null,
        }),
    timed<OlsPoolsResult>(ALL_OLS_POOLS, chainVariables),
    // Uptime rollup — isolated from ALL_POOLS_WITH_HEALTH so a schema-
    // lag fail degrades just the uptime column to "—", not the entire
    // pools page.
    timed<PoolBreachRollupResult>(ALL_POOLS_BREACH_ROLLUP, chainVariables),
    // Live-tail cursor is isolated so schema-lag does not hide persisted uptime counters.
    timed<PoolHealthCursorResult>(ALL_POOLS_HEALTH_CURSOR, chainVariables),
    // Data-trust / degenerate-classification flags. Isolated so schema-lag
    // degrades thresholds, USD math, and degenerate health without failing
    // the main pool list; split sides are needed for `isNeverRebalance`.
    timed<PoolRebalanceThresholdsKnownResult>(
      ALL_POOLS_REBALANCE_THRESHOLDS_KNOWN,
      chainVariables,
    ),
    // Isolate VP freshness so schema lag drops only VP staleness state.
    Promise.resolve(
      timed<PoolsVpOracleFreshnessResult>(
        ALL_POOLS_VP_ORACLE_FRESHNESS,
        chainVariables,
      ),
    ).then((data) => ({ data, checkedAt: Date.now() / 1000 })),
    timed<VpExchangeDeprecationResult>(
      ALL_POOLS_VP_DEPRECATION,
      chainVariables,
    ),
    timed<VpLifecycleDeprecationResult>(
      ALL_POOLS_VP_LIFECYCLE_DEPRECATION,
      chainVariables,
    ),
    // CDP badges are Celo-only and come from indexed CdpPool rows. The
    // runtime probe is a non-Celo Reserve fallback and must not produce CDP
    // badges.
    requestIndexedCdpPools(network, timed),
    requestFallbackStrategies(network, pools),
  ];
}

/**
 * Fires the 13 isolated data-source queries and returns their settled
 * results keyed by name. `pools` is the already-fetched `ALL_POOLS_WITH_HEALTH`
 * result — needed by the fallback strategy probe — and `poolIds`/`fpmmPoolIds`
 * are derived from it by the caller.
 */
export async function fetchNetworkSources(
  args: SourcesArgs,
): Promise<NetworkSources> {
  const [
    feeSnapshots,
    snapshotsAllDaily,
    brokerSnapshotsAllDaily,
    lp,
    ols,
    breachRollup,
    healthCursor,
    rebalanceThresholdsKnown,
    vpOracleFreshness,
    vpDeprecation,
    vpLifecycleDeprecation,
    indexedCdpPools,
    fallbackStrategies,
  ] = await Promise.allSettled(buildSourcePromises(args));

  return {
    feeSnapshots,
    snapshotsAllDaily,
    brokerSnapshotsAllDaily,
    lp,
    ols,
    breachRollup,
    healthCursor,
    rebalanceThresholdsKnown,
    vpOracleFreshness,
    vpDeprecation,
    vpLifecycleDeprecation,
    indexedCdpPools,
    fallbackStrategies,
  };
}
