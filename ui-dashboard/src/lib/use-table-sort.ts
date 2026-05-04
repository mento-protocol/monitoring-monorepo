"use client";

import { useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
  const searchParams = useSearchParams();

  const sortParam = `${paramPrefix}Sort`;
  const dirParam = `${paramPrefix}Dir`;

  const rawKey = searchParams.get(sortParam);
  const rawDir = searchParams.get(dirParam);

  const sortKey: K =
    rawKey !== null && validKeys.has(rawKey as K) ? (rawKey as K) : defaultKey;

  const sortDir: SortDir =
    rawDir === "asc" || rawDir === "desc" ? rawDir : defaultDir;

  const handleSort = useCallback(
    (key: K) => {
      const nextDir: SortDir =
        key === sortKey ? (sortDir === "asc" ? "desc" : "asc") : "desc";

      const params = new URLSearchParams(searchParams.toString());

      if (key === defaultKey && nextDir === defaultDir) {
        params.delete(sortParam);
        params.delete(dirParam);
      } else {
        params.set(sortParam, key);
        params.set(dirParam, nextDir);
      }

      const qs = params.toString();
      router.replace(qs ? `?${qs}` : "?", { scroll: false });
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
    ],
  );

  return { sortKey, sortDir, handleSort };
}
