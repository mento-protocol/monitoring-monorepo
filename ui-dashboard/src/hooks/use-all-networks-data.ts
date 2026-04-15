"use client";

import useSWR from "swr";
import { GraphQLClient } from "graphql-request";
import { NETWORKS, NETWORK_IDS, isConfiguredNetworkId } from "@/lib/networks";
import type { Network } from "@/lib/networks";
import {
  ALL_POOLS_WITH_HEALTH,
  POOL_SNAPSHOTS_ALL,
  PROTOCOL_FEE_TRANSFERS_ALL,
  UNIQUE_LP_ADDRESSES,
} from "@/lib/queries";
import {
  aggregateProtocolFees,
  type ProtocolFeeSummary,
} from "@/lib/protocol-fees";
import {
  buildSnapshotWindows,
  filterSnapshotsToWindow,
  shouldQueryPoolSnapshots,
  SNAPSHOT_REFRESH_MS,
  type SnapshotWindows,
  type TimeRange,
} from "@/lib/volume";
import type {
  Pool,
  PoolSnapshotWindow,
  ProtocolFeeTransfer,
} from "@/lib/types";
import { isFpmm, buildOracleRateMap, type OracleRateMap } from "@/lib/tokens";

export type NetworkData = {
  network: Network;
  snapshotWindows: SnapshotWindows;
  pools: Pool[];
  /**
   * Snapshot arrays for the three standard rolling windows. All derived
   * client-side from `snapshotsAll` (one paginated query), so the three
   * window-specific error fields below all alias to `snapshotsAllError`.
   */
  snapshots: PoolSnapshotWindow[];
  snapshots7d: PoolSnapshotWindow[];
  snapshots30d: PoolSnapshotWindow[];
  /** Full-history snapshots (paginated). Source of truth for the chart. */
  snapshotsAll: PoolSnapshotWindow[];
  /**
   * True when pagination hit the `SNAPSHOT_MAX_PAGES` safety cap. Older rows
   * were dropped, but the `snapshotsAll` array still carries the most recent
   * pages — so 24h/7d/30d windows remain correct and only the "All" chart
   * range is incomplete. Surfaced via the partial-data badge.
   */
  snapshotsAllTruncated: boolean;
  fees: ProtocolFeeSummary | null;
  uniqueLpCount: number | null;
  rates: OracleRateMap;
  error: Error | null;
  feesError: Error | null;
  /**
   * Snapshot error fields. All four alias to a single underlying failure since
   * the three window arrays are derived from `snapshotsAll`. Field names
   * retained for backward compatibility with existing consumers.
   */
  snapshotsError: Error | null;
  snapshots7dError: Error | null;
  snapshots30dError: Error | null;
  snapshotsAllError: Error | null;
  lpError: Error | null;
};

type AllNetworksResult = {
  networkData: NetworkData[];
  isLoading: boolean;
  error: Error | null;
};

const emptyNetworkData = (
  network: Network,
  snapshotWindows: SnapshotWindows,
  error: Error,
): NetworkData => ({
  network,
  snapshotWindows,
  pools: [],
  snapshots: [],
  snapshots7d: [],
  snapshots30d: [],
  snapshotsAll: [],
  snapshotsAllTruncated: false,
  fees: null,
  uniqueLpCount: null,
  rates: new Map(),
  error,
  feesError: null,
  snapshotsError: null,
  snapshots7dError: null,
  snapshots30dError: null,
  snapshotsAllError: null,
  lpError: null,
});

/**
 * Envio's hosted Hasura silently caps every PoolSnapshot query at 1000 rows
 * regardless of the `limit` we send, so for full history we paginate with
 * offset. Stop as soon as a page comes back under the page size (that's the
 * last page).
 *
 * Failure modes, all designed to fail open rather than blank the dashboard:
 * - Safety cap `SNAPSHOT_MAX_PAGES` reached → return accumulated rows with
 *   `truncated: true, error: null`. Since rows are ordered newest-first, the
 *   missing rows are the oldest ones, so 24h/7d/30d windows stay correct.
 *   No `error` because this is an intentional safety cap, not a fault.
 * - Mid-loop request error AFTER some pages succeeded → keep what we have,
 *   flag `truncated: true` AND set `error` so error-aware consumers (e.g.
 *   the Summary Volume tile) partial-badge correctly. Without the error
 *   signal the degraded state would be invisible to anything that only
 *   checks the error channel.
 * - First-page failure → rethrow. No rows at all means there's nothing to
 *   salvage; the caller surfaces it as `snapshotsAllError` (empty state with
 *   explicit error message, not a misleading `$0` dashboard).
 *
 * Dedup: offset pagination on an append-only table isn't stable under
 * concurrent inserts — a new snapshot at position 0 shifts everything one
 * row right, so the next page's offset overlaps with the previous page's
 * tail. We dedup by `(poolId, timestamp)` (which uniquely identifies a
 * snapshot per the indexer's hourBucket upsert id) before pushing into the
 * result. This mitigates duplicates; omissions are still theoretically
 * possible but rare and self-heal on the next refresh. A proper fix is
 * keyset pagination — tracked as a follow-up.
 */
const SNAPSHOT_PAGE_SIZE = 1000;
const SNAPSHOT_MAX_PAGES = 100;

type SnapshotPageResult = {
  rows: PoolSnapshotWindow[];
  truncated: boolean;
  error: Error | null;
};

const snapshotDedupKey = (s: PoolSnapshotWindow) =>
  `${s.poolId}-${s.timestamp}`;

async function fetchAllSnapshotPages(
  client: GraphQLClient,
  poolIds: string[],
): Promise<SnapshotPageResult> {
  const seen = new Set<string>();
  const rows: PoolSnapshotWindow[] = [];
  for (let page = 0; page < SNAPSHOT_MAX_PAGES; page++) {
    let batch: PoolSnapshotWindow[];
    try {
      const result = await client.request<{
        PoolSnapshot: PoolSnapshotWindow[];
      }>(POOL_SNAPSHOTS_ALL, {
        poolIds,
        limit: SNAPSHOT_PAGE_SIZE,
        offset: page * SNAPSHOT_PAGE_SIZE,
      });
      batch = result.PoolSnapshot ?? [];
    } catch (err) {
      // First-page failure is a hard error — nothing to degrade to.
      if (rows.length === 0) throw err;
      // Otherwise preserve the pages we did fetch; surface error AND flag
      // truncation so consumers know the data is partial.
      return {
        rows,
        truncated: true,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
    for (const row of batch) {
      const key = snapshotDedupKey(row);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
    if (batch.length < SNAPSHOT_PAGE_SIZE) {
      return { rows, truncated: false, error: null };
    }
  }
  return { rows, truncated: true, error: null };
}

/** @internal Exported for testing only. */
export async function fetchNetworkData(
  network: Network,
  windows: { w24h: TimeRange; w7d: TimeRange; w30d: TimeRange },
): Promise<NetworkData> {
  const secret = network.hasuraSecret.trim();
  const client = new GraphQLClient(network.hasuraUrl, {
    headers: secret ? { "x-hasura-admin-secret": secret } : {},
  });

  let pools: Pool[];
  try {
    const poolsRes = await client.request<{ Pool: Pool[] }>(
      ALL_POOLS_WITH_HEALTH,
      { chainId: network.chainId },
    );
    pools = poolsRes.Pool ?? [];
  } catch (err) {
    return emptyNetworkData(
      network,
      windows,
      err instanceof Error ? err : new Error(String(err)),
    );
  }

  const poolIds = pools.map((p) => p.id);
  const fpmmPoolIds = pools.filter(isFpmm).map((p) => p.id);
  const shouldQuery = shouldQueryPoolSnapshots(poolIds);

  const [feesResult, snapshotsAllResult, lpResult] = await Promise.allSettled([
    client.request<{ ProtocolFeeTransfer: ProtocolFeeTransfer[] }>(
      PROTOCOL_FEE_TRANSFERS_ALL,
      { chainId: network.chainId },
    ),
    shouldQuery
      ? fetchAllSnapshotPages(client, poolIds)
      : Promise.resolve<SnapshotPageResult>({
          rows: [],
          truncated: false,
          error: null,
        }),
    fpmmPoolIds.length > 0
      ? client.request<{
          LiquidityPosition: { address: string }[];
        }>(UNIQUE_LP_ADDRESSES, { poolIds: fpmmPoolIds })
      : Promise.resolve({
          LiquidityPosition: [] as { address: string }[],
        }),
  ]);

  const toError = (reason: unknown) =>
    reason instanceof Error ? reason : new Error(String(reason));

  const rates = buildOracleRateMap(pools, network);

  const fees =
    feesResult.status === "fulfilled"
      ? aggregateProtocolFees(feesResult.value.ProtocolFeeTransfer ?? [], rates)
      : null;

  // Single source of truth: the paginated all-history fetch. Window-specific
  // arrays are derived in-memory — no separate requests, no server-side cap.
  // If pagination truncated (hit MAX_PAGES or mid-loop fetch failure), we keep
  // the most-recent rows we did fetch: 24h/7d/30d derive correctly from those,
  // and "All" is flagged as partial. Mid-loop failure also surfaces via
  // `snapshotsAllError` so error-aware consumers (Summary tile) partial-badge.
  const snapshotsAll =
    snapshotsAllResult.status === "fulfilled"
      ? snapshotsAllResult.value.rows
      : [];
  const snapshotsAllTruncated =
    snapshotsAllResult.status === "fulfilled"
      ? snapshotsAllResult.value.truncated
      : false;
  const snapshotsAllError =
    snapshotsAllResult.status === "rejected"
      ? toError(snapshotsAllResult.reason)
      : (snapshotsAllResult.value.error ?? null);

  const snapshots = filterSnapshotsToWindow(snapshotsAll, windows.w24h);
  const snapshots7d = filterSnapshotsToWindow(snapshotsAll, windows.w7d);
  const snapshots30d = filterSnapshotsToWindow(snapshotsAll, windows.w30d);

  const uniqueLpCount =
    lpResult.status === "fulfilled"
      ? new Set(
          (lpResult.value.LiquidityPosition ?? []).map((lp) => lp.address),
        ).size
      : null;

  return {
    network,
    snapshotWindows: windows,
    pools,
    snapshots,
    snapshots7d,
    snapshots30d,
    snapshotsAll,
    snapshotsAllTruncated,
    fees,
    uniqueLpCount,
    rates,
    error: null,
    feesError:
      feesResult.status === "rejected" ? toError(feesResult.reason) : null,
    // All four alias to the same error — see NetworkData comment.
    snapshotsError: snapshotsAllError,
    snapshots7dError: snapshotsAllError,
    snapshots30dError: snapshotsAllError,
    snapshotsAllError,
    lpError: lpResult.status === "rejected" ? toError(lpResult.reason) : null,
  };
}

/** @internal Exported for testing only. */
export async function fetchAllNetworks(): Promise<NetworkData[]> {
  const configuredNetworkIds = NETWORK_IDS.filter(isConfiguredNetworkId);
  const now = Date.now();
  const windows = buildSnapshotWindows(now);

  const results = await Promise.allSettled(
    configuredNetworkIds.map((id) => fetchNetworkData(NETWORKS[id], windows)),
  );

  return results.map((result, i) => {
    if (result.status === "fulfilled") return result.value;
    return emptyNetworkData(
      NETWORKS[configuredNetworkIds[i]],
      windows,
      result.reason instanceof Error
        ? result.reason
        : new Error(String(result.reason)),
    );
  });
}

/**
 * Fetches pools, full-history snapshots (paginated), protocol fees, and LP
 * counts for ALL configured networks in parallel. Window-specific snapshot
 * arrays (24h/7d/30d) are derived in-memory from `snapshotsAll` so we make one
 * GraphQL request instead of four overlapping ones, and avoid Hasura's silent
 * 1000-row cap on windowed queries. Uses Promise.allSettled so one failing
 * network doesn't block others.
 */
export function useAllNetworksData(): AllNetworksResult {
  const { data, error, isLoading } = useSWR<NetworkData[]>(
    "all-networks-data",
    fetchAllNetworks,
    { refreshInterval: SNAPSHOT_REFRESH_MS },
  );

  return {
    networkData: data ?? [],
    isLoading,
    error: error instanceof Error ? error : null,
  };
}
