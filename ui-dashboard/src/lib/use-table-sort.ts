"use client";

import { useCallback, useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
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

/**
 * Generic hook that reads sort key + direction from URL search params and
 * writes back on toggle. Falls back to defaults when params are absent or
 * invalid. Strips params from the URL when they match defaults to keep URLs
 * clean.
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
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const sortParam = `${paramPrefix}Sort`;
  const dirParam = `${paramPrefix}Dir`;

  const rawKey = searchParams.get(sortParam);
  const rawDir = searchParams.get(dirParam);

  const sortKey: K =
    rawKey !== null && validKeys.has(rawKey as K) ? (rawKey as K) : defaultKey;

  const sortDir: SortDir =
    rawDir === "asc" || rawDir === "desc" ? rawDir : defaultDir;

  // Canonicalize malformed / partial / stale params back into the URL so the
  // address bar always describes the rendered state. Without this, deep links
  // like `?fooSort=bogus` or one-sided `?fooSort=fees24h` (no dir) leave junk
  // in the URL while the table renders defaults — refresh / share would carry
  // the junk forward indefinitely.
  useEffect(() => {
    const isCanonical = sortKey !== defaultKey || sortDir !== defaultDir;
    const sortMatches = isCanonical ? rawKey === sortKey : rawKey === null;
    const dirMatches = isCanonical ? rawDir === sortDir : rawDir === null;
    if (sortMatches && dirMatches) return;

    const params = new URLSearchParams(searchParams.toString());
    if (isCanonical) {
      params.set(sortParam, sortKey);
      params.set(dirParam, sortDir);
    } else {
      params.delete(sortParam);
      params.delete(dirParam);
    }
    const qs = params.toString();
    router.replace(qs ? `?${qs}` : pathname, { scroll: false });
  }, [
    rawKey,
    rawDir,
    sortKey,
    sortDir,
    defaultKey,
    defaultDir,
    sortParam,
    dirParam,
    searchParams,
    router,
    pathname,
  ]);

  // Track the most recent intent so rapid successive clicks compose against
  // each other instead of all reading the same stale URL-derived `sortDir`.
  // App Router navigation is async; without this ref a fast asc→desc→asc
  // double-click would write the same URL twice and silently lose the second
  // toggle. Cleared whenever URL state changes (either to match our intent or
  // to a value from external navigation).
  const intentRef = useRef<{ key: K; dir: SortDir } | null>(null);
  useEffect(() => {
    intentRef.current = null;
  }, [sortKey, sortDir]);

  const handleSort = useCallback(
    (key: K) => {
      const current = intentRef.current ?? { key: sortKey, dir: sortDir };
      const nextDir: SortDir =
        key === current.key
          ? current.dir === "asc"
            ? "desc"
            : "asc"
          : defaultDir;
      intentRef.current = { key, dir: nextDir };

      const params = new URLSearchParams(searchParams.toString());

      if (key === defaultKey && nextDir === defaultDir) {
        params.delete(sortParam);
        params.delete(dirParam);
      } else {
        params.set(sortParam, key);
        params.set(dirParam, nextDir);
      }

      const qs = params.toString();
      router.replace(qs ? `?${qs}` : pathname, { scroll: false });
    },
    [
      sortKey,
      sortDir,
      defaultKey,
      defaultDir,
      searchParams,
      sortParam,
      dirParam,
      router,
      pathname,
    ],
  );

  return { sortKey, sortDir, handleSort };
}
