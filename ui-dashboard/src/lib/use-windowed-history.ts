"use client";

import { GraphQLClient } from "graphql-request";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNetwork } from "@/components/network-provider";
import { ENVIO_MAX_ROWS } from "@/lib/constants";
import { useGQL } from "@/lib/graphql";

/**
 * Keyset-windowed history for a timestamp-ordered Hasura entity.
 *
 * The problem this solves: hosted Hasura hard-caps every query at 1000 rows
 * (`ENVIO_MAX_ROWS`), so a chart that fetches "the most recent 1000 rows" can
 * never scroll back past that window. This hook lets a chart page back through
 * older history on demand (TradingView-style) without ever re-polling the
 * frozen older pages — re-polling them would multiply query volume and hit the
 * Envio "Tier Quota" wall the 30s polling default exists to avoid.
 *
 * Shape (the load-bearing split):
 *   - **Live head**: one `useGQL` poll (30s) for the newest window, using the
 *     same keyset query with a far-future cursor. This is the ONLY thing that
 *     ever revalidates. As new rows land, the head slides forward and merges
 *     them in.
 *   - **Frozen older pages**: a manual keyset accumulator (bare
 *     `client.request`, modelled on `fetchPoolVolumeSnapshots`). Each older
 *     page is fetched exactly once, on demand, and kept in a ref-backed Map of
 *     all loaded rows. Nothing here ever re-fetches.
 *
 * Both feed one Map keyed by `id`; the head only ever ADDS/refreshes rows (it
 * never deletes), so rows that fall out of the newest-1000 window as the head
 * slides forward are NOT lost — they stay in the Map. That's what keeps the
 * merged series gap-free across the session. (Assumes < `pageSize` brand-new
 * rows appear between two head polls, i.e. the head windows always overlap —
 * true by orders of magnitude at oracle cadence.)
 */

export interface WindowedHistoryRow {
  id: string;
  /** Unix seconds as a string (Hasura BigInt → JSON string). */
  timestamp: string;
}

export interface UseWindowedHistoryParams<T extends WindowedHistoryRow> {
  /** The keyset query. Pass `null` to disable the hook (mirrors `useGQL(null)`). */
  query: string | null;
  /**
   * Per-entity variables WITHOUT `limit` / `beforeTimestamp` — the hook injects
   * those. e.g. `{ poolId }`.
   */
  variables: Record<string, unknown> | undefined;
  /** Pulls the row array out of the GraphQL response envelope. */
  selectRows: (data: unknown) => T[];
  /**
   * Identity of the data set. When it changes (pool switch, network switch),
   * ALL loaded rows are dropped and the live head re-seeds. Use
   * `` `${network.id}:${poolId}` ``.
   */
  resetKey: string;
  /** Rows per keyset page. Defaults to the Hasura cap (1000). */
  pageSize?: number;
  /** Hard backstop on how many older pages to fetch. */
  maxPages?: number;
}

export interface UseWindowedHistoryResult<T extends WindowedHistoryRow> {
  /** Frozen older pages ⊕ live head, deduped by `id`, sorted ASC by timestamp. */
  rows: T[];
  /** Oldest loaded timestamp (unix seconds); `Infinity` before the head loads. */
  oldestLoadedTs: number;
  /** True once an older page came back short — we've reached indexed genesis. */
  reachedStart: boolean;
  /** True once `maxPages` is hit before genesis — older rows exist beyond us. */
  capped: boolean;
  isLoadingHead: boolean;
  isFetchingOlder: boolean;
  /** Live-poll error (history stays rendered when this is set). */
  headError: Error | undefined;
  /** Last older-page error (non-fatal; the next request retries the same page). */
  olderError: Error | undefined;
  /**
   * Ensure data is loaded at least back to `targetTs` (unix seconds). Idempotent
   * and single-flight: a no-op if already covered, already fetching, or we've
   * reached genesis / the page cap. Fetches sequentially, one page at a time,
   * continuing until it covers `targetTs`.
   */
  ensureLoadedBefore: (targetTs: number) => void;
}

// Numeric.MAX-ish cursor (~year 2286 in unix seconds). `timestamp < this`
// returns the newest page from the top of the desc-ordered table. Mirrors
// `TS_CURSOR_INITIAL` in `use-stables-data.ts`.
const TS_CURSOR_INITIAL = "9999999999";
const DEFAULT_MAX_PAGES = 100;
// One-shot older-page fetch: a touch more slack than the 8s poll timeout since
// a deep page can be a cold scan.
const OLDER_PAGE_TIMEOUT_MS = 10_000;

function minTimestamp<T extends WindowedHistoryRow>(rows: Iterable<T>): string {
  let min: bigint | null = null;
  for (const r of rows) {
    const t = BigInt(r.timestamp);
    if (min === null || t < min) min = t;
  }
  return min === null ? TS_CURSOR_INITIAL : min.toString();
}

// One keyset page older than `beforeTimestamp`. Bare client.request (NOT useGQL)
// so this never lands behind a polling SWR key — frozen history is fetched once.
async function requestOlderRows<T extends WindowedHistoryRow>(args: {
  client: GraphQLClient;
  query: string;
  variables: Record<string, unknown> | undefined;
  pageSize: number;
  beforeTimestamp: string;
  selectRows: (data: unknown) => T[];
}): Promise<T[]> {
  const { client, query, variables, pageSize, beforeTimestamp, selectRows } =
    args;
  const resp = await client.request({
    document: query,
    variables: { ...variables, limit: pageSize, beforeTimestamp },
    signal: AbortSignal.timeout(OLDER_PAGE_TIMEOUT_MS),
  });
  return selectRows(resp);
}

// eslint-disable-next-line max-lines-per-function -- Cohesive stateful hook: the live-head poll, the frozen older-page accumulator, the reset, and the look-ahead trigger share refs and must stay co-located (same call as oracle-tab's disable).
export function useWindowedHistory<T extends WindowedHistoryRow>({
  query,
  variables,
  selectRows,
  resetKey,
  pageSize = ENVIO_MAX_ROWS,
  maxPages = DEFAULT_MAX_PAGES,
}: UseWindowedHistoryParams<T>): UseWindowedHistoryResult<T> {
  const { network } = useNetwork();
  const client = useMemo(
    () => (network.hasuraUrl ? new GraphQLClient(network.hasuraUrl) : null),
    [network.hasuraUrl],
  );

  // All rows ever loaded (head + older pages), keyed by id. A ref so appending
  // doesn't itself trigger renders — we bump `version` deliberately instead.
  const loadedRef = useRef<Map<string, T>>(new Map());
  const reachedStartRef = useRef(false);
  const cappedRef = useRef(false);
  const fetchingRef = useRef(false);
  const pageCountRef = useRef(0);
  // Bumped on every reset. An older-page fetch captures this before its await
  // and discards its result if the generation changed mid-flight — otherwise a
  // request in flight when the pool/network switches resolves AFTER the reset
  // and writes the old pool's rows into the freshly-cleared Map (cross-pool
  // contamination, and a short stale page would even flip `reachedStart` on the
  // new pool, permanently disabling its scroll-back).
  const generationRef = useRef(0);
  // Oldest timestamp the caller has asked us to reach. `Infinity` = no request
  // yet (continuation never fires for a finite oldest > Infinity).
  const pendingTargetRef = useRef<number>(Infinity);
  const [version, setVersion] = useState(0);
  const [olderError, setOlderError] = useState<Error | undefined>(undefined);
  const [isFetchingOlder, setIsFetchingOlder] = useState(false);

  // ----- Reset on identity change (pool / network switch). -------------------
  // Done DURING render (the React "adjust state when a prop changes" pattern),
  // NOT in an effect: an effect would also run on initial mount and wipe the
  // head data the merge just produced (a 30s blank chart until the next poll).
  // This runs before any effect commits, so the mount-time head populate is
  // never clobbered. `uirevision` (keyed identically) resets the chart viewport
  // in lockstep. It's the ONLY place frozen state is dropped.
  const [prevResetKey, setPrevResetKey] = useState(resetKey);
  if (prevResetKey !== resetKey) {
    setPrevResetKey(resetKey);
    loadedRef.current = new Map();
    reachedStartRef.current = false;
    cappedRef.current = false;
    fetchingRef.current = false;
    pageCountRef.current = 0;
    // Invalidate any in-flight older-page fetch so its stale result is dropped
    // instead of merged into the new pool's now-empty Map.
    generationRef.current += 1;
    pendingTargetRef.current = Infinity;
    setOlderError(undefined);
    setIsFetchingOlder(false);
    // Bump (not zero) so the merge memo re-runs against the now-empty Map even
    // if version happened to be 0; the head effect repopulates right after.
    setVersion((v) => v + 1);
  }

  // ----- Live head: newest window via the shared 30s-polling useGQL. ---------
  const headVariables = useMemo(
    () => ({
      ...variables,
      limit: pageSize,
      beforeTimestamp: TS_CURSOR_INITIAL,
    }),
    [variables, pageSize],
  );
  const {
    data: headData,
    error: headError,
    isLoading: isLoadingHead,
  } = useGQL<unknown>(query, headVariables);

  const headRows = useMemo(
    () => (headData != null ? selectRows(headData) : []),
    [headData, selectRows],
  );

  // Merge head rows into the loaded Map. The head only adds/refreshes — it
  // never removes — so rows aging out of the newest-1000 window persist.
  useEffect(() => {
    if (headRows.length === 0) return;
    for (const r of headRows) loadedRef.current.set(r.id, r);
    setVersion((v) => v + 1);
  }, [headRows]);

  // ----- Merged, sorted view. ------------------------------------------------
  const rows = useMemo(() => {
    const arr = Array.from(loadedRef.current.values());
    // Spread+sort (not toSorted) — ES2017 target per ui-dashboard/CLAUDE.md.
    arr.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
    return arr;
    // `version` is the deliberate re-merge trigger; loadedRef is a ref.
  }, [version]);

  const oldestLoadedTs =
    rows.length > 0 ? Number(rows[0]!.timestamp) : Infinity;
  // Mirror into a ref so `ensureLoadedBefore` stays identity-stable (the
  // consumer debounces it; recreating it on every poll would reset the timer).
  const oldestLoadedTsRef = useRef(oldestLoadedTs);
  oldestLoadedTsRef.current = oldestLoadedTs;

  // ----- Older-page fetch (manual keyset, single-flight). --------------------
  // Inputs ride a ref so this callback keeps a stable identity (the
  // continuation effect and the debounced caller depend on it).
  const fetchInputsRef = useRef({
    client,
    query,
    variables,
    pageSize,
    maxPages,
    selectRows,
  });
  fetchInputsRef.current = {
    client,
    query,
    variables,
    pageSize,
    maxPages,
    selectRows,
  };

  const fetchOlderPage = useCallback(async () => {
    if (fetchingRef.current || reachedStartRef.current || cappedRef.current) {
      return;
    }
    const {
      client: c,
      query: q,
      variables: v,
      pageSize: ps,
      maxPages: mp,
      selectRows: sel,
    } = fetchInputsRef.current;
    // Nothing to page from until the head has seeded the newest window.
    if (!c || !q || loadedRef.current.size === 0) return;

    fetchingRef.current = true;
    setIsFetchingOlder(true);
    // Snapshot the generation so a reset (pool/network switch) that lands while
    // this request is in flight causes us to drop the result instead of writing
    // the old pool's rows into the new pool's Map.
    const generation = generationRef.current;
    // Min loaded timestamp is exactly the boundary for the next older page.
    const beforeTimestamp = minTimestamp(loadedRef.current.values());
    try {
      const batch = await requestOlderRows({
        client: c,
        query: q,
        variables: v,
        pageSize: ps,
        beforeTimestamp,
        selectRows: sel,
      });
      // Reset raced ahead of this resolve — abandon the stale page entirely and
      // touch none of the flags: the new generation already cleared them on
      // reset and may own an in-flight fetch of its own by now.
      if (generation !== generationRef.current) return;
      for (const r of batch) loadedRef.current.set(r.id, r);
      pageCountRef.current += 1;
      // A short page means we hit the start of indexed history.
      if (batch.length < ps) reachedStartRef.current = true;
      if (pageCountRef.current >= mp) cappedRef.current = true;
      setOlderError(undefined);
      setVersion((ver) => ver + 1);
    } catch (err) {
      // Same generation guard as the success path — a reset mid-flight must not
      // surface the stale request's error against the new pool.
      if (generation !== generationRef.current) return;
      // Non-fatal: loaded rows stay rendered. We did NOT advance any cursor
      // (it's derived from the Map), so the next request retries the same page.
      setOlderError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      // Only release the flags if we still own them — a stale resolve must not
      // clear the fetching state the new generation set after its reset.
      if (generation === generationRef.current) {
        fetchingRef.current = false;
        setIsFetchingOlder(false);
      }
    }
  }, []);

  // Continuation: after a page lands (or the head shifts the oldest), keep
  // paging until we cover the requested target. Single-flight via fetchingRef;
  // self-terminates at coverage / genesis / cap.
  useEffect(() => {
    if (fetchingRef.current || reachedStartRef.current || cappedRef.current) {
      return;
    }
    if (oldestLoadedTs > pendingTargetRef.current) void fetchOlderPage();
  }, [version, oldestLoadedTs, fetchOlderPage]);

  const ensureLoadedBefore = useCallback(
    (targetTs: number) => {
      pendingTargetRef.current = targetTs;
      if (reachedStartRef.current || cappedRef.current) return;
      if (loadedRef.current.size === 0) return; // head not loaded yet
      if (oldestLoadedTsRef.current <= targetTs) return; // already covered
      void fetchOlderPage();
    },
    [fetchOlderPage],
  );

  return {
    rows,
    oldestLoadedTs,
    reachedStart: reachedStartRef.current,
    capped: cappedRef.current,
    isLoadingHead,
    isFetchingOlder,
    headError: headError as Error | undefined,
    olderError,
    ensureLoadedBefore,
  };
}
