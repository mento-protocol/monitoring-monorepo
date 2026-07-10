// Server-safe GraphQL fetcher shared by the React hook
// (`@/hooks/use-all-networks-data`) and Server Components that need to
// pre-render the dashboard payload. Deliberately avoids any React / SWR
// imports so it can run in both runtimes without tripping Next.js's RSC
// swr/react-server bundling (which has no default export). Pagination module
// state intentionally persists across requests to throttle Sentry signals
// across the 30s poll loop; tests `.clear()` those caches between cases.

import { GraphQLClient } from "graphql-request";
import { NETWORKS, NETWORK_IDS, isConfiguredNetworkId } from "@/lib/networks";
import type { Network } from "@/lib/networks";
import { ALL_POOLS_WITH_HEALTH } from "@/lib/queries";
import {
  buildSnapshotWindows,
  type SnapshotWindows,
  type TimeRange,
} from "@/lib/volume";
import { isVirtualPool, type Pool } from "@/lib/types";
import { isFpmm } from "@/lib/tokens";
import type { NetworkData, SerializableError } from "./types";
import { mergePoolSources } from "./merge-pools";
import {
  fetchNetworkSources,
  type NetworkSources,
  type TimedRequest,
} from "./sources";
import {
  resolveStrategyIds,
  resolveStrategyError,
} from "./strategy-resolution";
import { assembleNetworkData } from "./assemble";
import { REQUEST_TIMEOUT_MS } from "./pagination";

export { SNAPSHOT_PAGE_SIZE } from "./constants";
export {
  REQUEST_TIMEOUT_MS,
  fetchAllDailySnapshotPages,
  fetchAllFeeSnapshotPages,
  fetchPaginatedRows,
  incrementalRowCache,
  partialPageLastCapturedAt,
  seedIncrementalRowCacheFromNetworkData,
  warnedCapKeys,
} from "./pagination";

/**
 * True iff every error channel on `n` is null — top-level, rates,
 * fee snapshots, per-window snapshots, all-history daily, broker daily,
 * and LP. Used to decide whether an SSR-seeded payload is fresh enough
 * to skip client-side revalidation; any per-slice failure on the server
 * would otherwise trap the user on partial `N/A` metrics until the next
 * poll.
 *
 * Truncation flags (`feeSnapshotsTruncated`, `snapshotsAllDailyTruncated`,
 * `brokerSnapshotsAllDailyTruncated`, `uniqueLpAddressesTruncated`) are
 * intentionally excluded — they represent a permanent cap-exhaustion state
 * until `SNAPSHOT_MAX_PAGES` is raised. Including them would force perpetual
 * mount-time revalidation that can never recover. The UI surfaces truncation
 * via the `≈` prefix + subtitle; this gate is for transient errors only.
 */
export function isNetworkDataFullyHealthy(n: NetworkData): boolean {
  return (
    n.error === null &&
    n.liveHealthError == null &&
    n.ratesError === null &&
    n.feeSnapshotsError === null &&
    n.snapshotsError === null &&
    n.snapshots7dError === null &&
    n.snapshots30dError === null &&
    n.snapshotsAllDailyError === null &&
    n.brokerSnapshotsAllDailyError === null &&
    n.strategyError === null &&
    n.lpError === null
  );
}

/**
 * Zero-default `NetworkData` shell. Exported so slim hooks (e.g.
 * `useProtocolFees`) can produce a `NetworkData[]`-shaped payload with
 * only the fields they populate, rather than redeclaring the 20-field
 * blank template. `overrides` lets a caller drop fees/rates/etc. in.
 */
export const blankNetworkData = (
  network: Network,
  snapshotWindows: SnapshotWindows,
  overrides: Partial<NetworkData> = {},
): NetworkData => ({
  network,
  snapshotWindows,
  pools: [],
  snapshots: [],
  snapshots7d: [],
  snapshots30d: [],
  snapshotsAllDaily: [],
  snapshotsAllDailyTruncated: false,
  brokerSnapshotsAllDaily: [],
  brokerSnapshotsAllDailyTruncated: false,
  olsPoolIds: new Set(),
  cdpPoolIds: new Set(),
  reservePoolIds: new Set(),
  strategyError: null,
  fees: null,
  feeSnapshots: [],
  feeSnapshotsError: null,
  feeSnapshotsTruncated: false,
  ratesError: null,
  poolLabels: new Map(),
  uniqueLpAddresses: null,
  uniqueLpAddressesTruncated: false,
  rates: new Map(),
  error: null,
  liveHealthError: null,
  snapshotsError: null,
  snapshots7dError: null,
  snapshots30dError: null,
  snapshotsAllDailyError: null,
  brokerSnapshotsAllDailyError: null,
  lpError: null,
  ...overrides,
});

const emptyNetworkData = (
  network: Network,
  snapshotWindows: SnapshotWindows,
  error: Error,
): NetworkData => blankNetworkData(network, snapshotWindows, { error });

function withVirtualPoolHealthError(
  assembled: NetworkData,
  sources: Pick<
    NetworkSources,
    "vpOracleFreshness" | "vpDeprecation" | "vpLifecycleDeprecation"
  >,
): NetworkData {
  const virtualPools = assembled.pools.filter(isVirtualPool);
  if (virtualPools.length === 0) return assembled;
  const extensionFailure = [
    sources.vpOracleFreshness,
    sources.vpDeprecation,
    sources.vpLifecycleDeprecation,
  ].find((result) => result.status === "rejected");
  const unconfirmedPoolCount = virtualPools.filter(
    (pool) =>
      pool.vpOracleFreshnessCheckedAt === undefined ||
      pool.vpDeprecationKnown === false,
  ).length;
  if (extensionFailure?.status !== "rejected" && unconfirmedPoolCount === 0) {
    return assembled;
  }
  const message =
    extensionFailure?.status === "rejected"
      ? `VirtualPool health refresh failed: ${extensionFailure.reason instanceof Error ? extensionFailure.reason.message : String(extensionFailure.reason)}`
      : `VirtualPool health response did not confirm ${unconfirmedPoolCount} displayed pool${unconfirmedPoolCount === 1 ? "" : "s"}`;
  return { ...assembled, liveHealthError: { message } };
}

/** @internal Exported for testing only. */
export async function fetchNetworkData(
  network: Network,
  windows: { w24h: TimeRange; w7d: TimeRange; w30d: TimeRange },
): Promise<NetworkData> {
  const client = new GraphQLClient(network.hasuraUrl);
  const chainVariables = { chainId: network.chainId };

  // Helper to bind a per-request AbortSignal.timeout without repeating the
  // object-form at every call site. Re-binds on every invocation so each
  // request gets its own timer (a shared signal would abort the rest of
  // the parallel batch when any single request exceeded the budget).
  const timed: TimedRequest = <T>(
    document: string,
    variables?: Record<string, unknown>,
  ) =>
    client.request<T>({
      document,
      ...(variables !== undefined ? { variables } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

  let pools: Pool[];
  let oracleFreshnessCheckedAt: number;
  try {
    const poolsRes = await timed<{ Pool: Pool[] }>(
      ALL_POOLS_WITH_HEALTH,
      chainVariables,
    );
    oracleFreshnessCheckedAt = Date.now() / 1000;
    pools = poolsRes.Pool ?? [];
  } catch (err) {
    return emptyNetworkData(
      network,
      windows,
      err instanceof Error ? err : new Error(String(err)),
    );
  }

  const poolIds = pools.map((p) => p.id);
  const fpmmPoolIds = pools.flatMap((p) => (isFpmm(p) ? [p.id] : []));
  const snapshotTailNowMs = windows.w24h.to * 1000;

  const sources = await fetchNetworkSources({
    client,
    network,
    timed,
    chainVariables,
    pools,
    poolIds,
    fpmmPoolIds,
    snapshotTailNowMs,
  });

  // Merge the isolated per-source fields into the pool objects. On failure
  // (including the phased-rollout "field not found" window) each merge
  // leaves its fields undefined and the corresponding UI falls back to "—".
  // The primary oracle fields and each isolated extension query were observed
  // independently. `mergePoolSources` records each extension's indexer block
  // so the live overlay can merge the three field groups without rolling any
  // of them backward.
  pools = mergePoolSources(pools, sources).map((pool) => ({
    ...pool,
    oracleFreshnessCheckedAt,
  }));

  const { cdpPoolIds, reservePoolIds } = resolveStrategyIds({
    network,
    pools,
    indexedCdpPoolsResult: sources.indexedCdpPools,
    fallbackStrategiesResult: sources.fallbackStrategies,
  });
  const strategyError = resolveStrategyError({
    network,
    olsResult: sources.ols,
    indexedCdpPoolsResult: sources.indexedCdpPools,
    fallbackStrategiesResult: sources.fallbackStrategies,
  });

  const assembled = assembleNetworkData({
    network,
    windows,
    pools,
    snapshotTailNowMs,
    feeSnapshotsResult: sources.feeSnapshots,
    snapshotsAllDailyResult: sources.snapshotsAllDaily,
    brokerSnapshotsAllDailyResult: sources.brokerSnapshotsAllDaily,
    lpResult: sources.lp,
    olsResult: sources.ols,
    cdpPoolIds,
    reservePoolIds,
    strategyError,
  });
  return withVirtualPoolHealthError(assembled, sources);
}

/**
 * Rebuild a `NetworkData`'s ten error channels as plain `{ message }` objects
 * (#661). `fetchNetworkData` populates them with `Error` instances internally
 * (structurally assignable to `SerializableError`), but those must not cross
 * the Server → Client boundary: React's Flight serializer opaques `Error`
 * instances to a generic "…message is omitted in production builds…"
 * placeholder, which would then render into `<ErrorBox>` instead of the real
 * cause. Reading `.message` into a fresh literal yields a plain object that
 * survives serialization. Idempotent — a value already shaped `{ message }`
 * round-trips unchanged. Applied once, here at the `fetchAllNetworks` boundary
 * (per the issue), so `fetchNetworkData` stays a pure internal fetcher.
 */
function toSerializableError(
  e: SerializableError | null,
): SerializableError | null {
  return e === null ? null : { message: e.message };
}

function withSerializableErrors(data: NetworkData): NetworkData {
  return {
    ...data,
    error: toSerializableError(data.error),
    liveHealthError: toSerializableError(data.liveHealthError ?? null),
    ratesError: toSerializableError(data.ratesError),
    feeSnapshotsError: toSerializableError(data.feeSnapshotsError),
    snapshotsError: toSerializableError(data.snapshotsError),
    snapshots7dError: toSerializableError(data.snapshots7dError),
    snapshots30dError: toSerializableError(data.snapshots30dError),
    snapshotsAllDailyError: toSerializableError(data.snapshotsAllDailyError),
    brokerSnapshotsAllDailyError: toSerializableError(
      data.brokerSnapshotsAllDailyError,
    ),
    strategyError: toSerializableError(data.strategyError),
    lpError: toSerializableError(data.lpError),
  };
}

/**
 * Fetches pools, full-history daily snapshots (paginated), protocol fees, and
 * LP counts for ALL configured networks in parallel. Window-specific snapshot
 * arrays (24h/7d/30d) are derived in-memory from `snapshotsAllDaily` so we
 * make one paginated request instead of four overlapping ones, and avoid
 * Hasura's silent 1000-row cap on windowed queries. Uses Promise.allSettled
 * so one failing network doesn't block others. Error channels are flattened to
 * plain `{ message }` objects so they survive the RSC boundary (see #661).
 */
export async function fetchAllNetworks(): Promise<NetworkData[]> {
  const configuredNetworkIds = NETWORK_IDS.filter(isConfiguredNetworkId);
  const now = Date.now();
  const windows = buildSnapshotWindows(now);

  const results = await Promise.allSettled(
    configuredNetworkIds.map((id) => fetchNetworkData(NETWORKS[id], windows)),
  );

  return results.map((result, i) => {
    const networkData =
      result.status === "fulfilled"
        ? result.value
        : emptyNetworkData(
            NETWORKS[configuredNetworkIds[i]!],
            windows,
            result.reason instanceof Error
              ? result.reason
              : new Error(String(result.reason)),
          );
    return withSerializableErrors(networkData);
  });
}
