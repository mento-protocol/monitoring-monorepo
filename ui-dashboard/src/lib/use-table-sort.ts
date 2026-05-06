"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { SortDir } from "@/lib/table-sort";

export interface UseTableSortOptions<K extends string> {
  defaultKey: K;
  defaultDir: SortDir;
  validKeys: ReadonlySet<K>;
  /** URL param prefix. Defaults to "". With prefix "foo" params are fooSort + fooDir. */
  paramPrefix?: string;
}

export interface UseTableSortResult<K extends string> {
  sortKey: K;
  sortDir: SortDir;
  handleSort: (key: K) => void;
}

interface SortState<K extends string> {
  key: K;
  dir: SortDir;
}

function readSortFromParams<K extends string>(
  params: URLSearchParams,
  sortParam: string,
  dirParam: string,
  validKeys: ReadonlySet<K>,
  defaultKey: K,
  defaultDir: SortDir,
): SortState<K> {
  const rawKey = params.get(sortParam);
  const rawDir = params.get(dirParam);
  const key: K =
    rawKey !== null && validKeys.has(rawKey as K) ? (rawKey as K) : defaultKey;
  const dir: SortDir =
    rawDir === "asc" || rawDir === "desc" ? rawDir : defaultDir;
  return { key, dir };
}

function buildNextSearch<K extends string>(
  currentSearch: string,
  sortParam: string,
  dirParam: string,
  state: SortState<K>,
  defaultKey: K,
  defaultDir: SortDir,
): string {
  const params = new URLSearchParams(currentSearch);
  if (state.key === defaultKey && state.dir === defaultDir) {
    params.delete(sortParam);
    params.delete(dirParam);
  } else {
    params.set(sortParam, state.key);
    params.set(dirParam, state.dir);
  }
  return params.toString();
}

/**
 * Generic hook that reads sort key + direction from URL search params and
 * persists toggle changes back to the URL. Falls back to defaults when
 * params are absent or invalid. Strips params from the URL when they match
 * defaults to keep URLs clean.
 *
 * Sort state lives in `useState` and the URL is updated via the native
 * History API (`window.history.replaceState`) — *not* via Next.js's
 * `router.replace`, which in the App Router triggers an RSC refetch of the
 * current route segment. On the homepage that round-trip costs ~700ms, which
 * is what the user sees as sort lag. The native call has no React/Next
 * involvement, so the click → re-render is synchronous.
 *
 * Caller contract: `defaultKey`, `defaultDir`, `paramPrefix`, and `validKeys`
 * must be render-stable. Defaults and prefix should be literal constants;
 * `validKeys` should be a module-level `Set` (or `useMemo`-stable). Mount-time
 * canonicalization captures the scalars in an empty-deps effect, and the
 * `popstate` listener depends on `validKeys` identity — passing a fresh set
 * inline (`new Set([...])`) tears down and re-registers the listener every
 * render.
 *
 * @example
 * const { sortKey, sortDir, handleSort } = useTableSort({
 *   defaultKey: "tvl",
 *   defaultDir: "desc",
 *   validKeys: GLOBAL_SORT_KEYS,
 *   paramPrefix: "pools",
 * });
 * // URL: ?poolsSort=tvl&poolsDir=desc  (stripped when matching defaults)
 */
export function useTableSort<K extends string>({
  defaultKey,
  defaultDir,
  validKeys,
  paramPrefix = "",
}: UseTableSortOptions<K>): UseTableSortResult<K> {
  const searchParams = useSearchParams();

  const sortParam = `${paramPrefix}Sort`;
  const dirParam = `${paramPrefix}Dir`;

  // Lazy-init from the live URL so deep links land on the right column AND
  // remounts during a session pick up the latest sort. We can't rely on
  // Next's `useSearchParams` here: it returns the snapshot from the route's
  // last RSC payload, which is stale relative to our own `replaceState`
  // writes. A remount triggered by an in-page state change (e.g. the
  // `/leaderboard` venue toggle unmounting + remounting the table) needs
  // the *current* URL params, not the stale snapshot. Fall back to
  // `searchParams` only on the SSR pass.
  const [state, setState] = useState<SortState<K>>(() => {
    const params =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search)
        : searchParams;
    return readSortFromParams(
      params,
      sortParam,
      dirParam,
      validKeys,
      defaultKey,
      defaultDir,
    );
  });

  const replaceUrlForState = useCallback(
    (next: SortState<K>) => {
      if (typeof window === "undefined") return;
      const qs = buildNextSearch(
        window.location.search,
        sortParam,
        dirParam,
        next,
        defaultKey,
        defaultDir,
      );
      const nextUrl =
        window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
      window.history.replaceState(window.history.state, "", nextUrl);
    },
    [defaultKey, defaultDir, sortParam, dirParam],
  );

  // Canonicalize malformed / partial / stale URL params on mount. Without this,
  // deep links like `?fooSort=bogus` or one-sided `?fooSort=fees24h` (no dir)
  // leave junk in the URL while the table renders defaults — refresh / share
  // would carry the junk forward indefinitely. Runs once; subsequent state
  // changes flow through `handleSort`.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const current = new URLSearchParams(window.location.search);
    const rawKey = current.get(sortParam);
    const rawDir = current.get(dirParam);
    const hasNonDefaultState =
      state.key !== defaultKey || state.dir !== defaultDir;
    const sortMatches = hasNonDefaultState
      ? rawKey === state.key
      : rawKey === null;
    const dirMatches = hasNonDefaultState
      ? rawDir === state.dir
      : rawDir === null;
    if (sortMatches && dirMatches) return;
    replaceUrlForState(state);
    // Empty deps: canonicalization is a one-shot mount-time concern. Re-running
    // on every state change would race with `handleSort`'s replaceState and
    // bounce the URL when the user clicks a header before the effect resolves.
  }, []);

  // Sync local state from URL when the browser back/forward buttons fire
  // popstate. We can't rely on `useSearchParams` here: our own writes go
  // through `history.replaceState` which doesn't notify Next.js's router,
  // so `searchParams` stays stale across our writes. `popstate`, however,
  // only fires for genuine navigation (back/forward) — never for our own
  // `replaceState` calls — which makes it the right signal to listen for.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onPopState = () => {
      const params = new URLSearchParams(window.location.search);
      const next = readSortFromParams(
        params,
        sortParam,
        dirParam,
        validKeys,
        defaultKey,
        defaultDir,
      );
      setState((prev) =>
        prev.key === next.key && prev.dir === next.dir ? prev : next,
      );
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [sortParam, dirParam, validKeys, defaultKey, defaultDir]);

  const handleSort = useCallback(
    (key: K) => {
      // The DOM side effect inside the updater violates React's purity rule
      // for state updaters, but is intentional: rapid clicks must compose
      // against the latest committed state, which only the functional updater
      // exposes via `prev`. Hoisting `replaceUrlForState` outside would force
      // recomputing `next` from `state` (closed over), losing composition.
      // Strict Mode runs the updater twice in dev — `replaceState` is
      // idempotent for the same `next` so the duplicate call is harmless.
      setState((prev) => {
        const nextDir: SortDir =
          key === prev.key ? (prev.dir === "asc" ? "desc" : "asc") : defaultDir;
        const next = { key, dir: nextDir };
        replaceUrlForState(next);
        return next;
      });
    },
    [defaultDir, replaceUrlForState],
  );

  return { sortKey: state.key, sortDir: state.dir, handleSort };
}
