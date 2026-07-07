"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { RangeKey } from "./types";

const DEFAULT_STABLES_RANGE: RangeKey = "30d";
const STABLES_RANGE_QUERY_PARAM = "range";
const VALID_STABLES_RANGES = new Set<RangeKey>(["7d", "30d", "90d", "all"]);

type StablesRangeUrlState = {
  range: RangeKey;
  updateRange: (next: RangeKey) => void;
};

function parseStablesRange(params: URLSearchParams): RangeKey {
  const raw = params.get(STABLES_RANGE_QUERY_PARAM);
  return raw && VALID_STABLES_RANGES.has(raw as RangeKey)
    ? (raw as RangeKey)
    : DEFAULT_STABLES_RANGE;
}

function buildStablesRangeSearch(
  currentSearch: string,
  range: RangeKey,
): string {
  const params = new URLSearchParams(currentSearch);
  if (range === DEFAULT_STABLES_RANGE) {
    params.delete(STABLES_RANGE_QUERY_PARAM);
  } else {
    params.set(STABLES_RANGE_QUERY_PARAM, range);
  }
  return params.toString();
}

function writeStablesRangeUrl(range: RangeKey) {
  if (typeof window === "undefined") return;
  const qs = buildStablesRangeSearch(window.location.search, range);
  const nextUrl =
    window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
  window.history.replaceState(window.history.state, "", nextUrl);
}

export function useStablesRangeUrlState(): StablesRangeUrlState {
  // `useSearchParams()` is the SSR-pass source for direct `/stables?...`
  // loads. Writes use History API so the chart control does not trigger an
  // App Router RSC refetch.
  // react-doctor-disable-next-line react-doctor/nextjs-no-use-search-params-without-suspense
  const searchParams = useSearchParams();

  const initialReadParams =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search)
      : searchParams;

  const [range, setRange] = useState<RangeKey>(() =>
    parseStablesRange(initialReadParams),
  );

  const updateRange = useCallback((next: RangeKey) => {
    setRange(next);
    writeStablesRangeUrl(next);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const current = new URLSearchParams(window.location.search);
    const next = parseStablesRange(current);
    const canonicalSearch = buildStablesRangeSearch(
      window.location.search,
      next,
    );
    if (canonicalSearch !== current.toString()) {
      writeStablesRangeUrl(next);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onPopState = () => {
      const next = parseStablesRange(
        new URLSearchParams(window.location.search),
      );
      setRange((prev) => (prev === next ? prev : next));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  return { range, updateRange };
}

export { DEFAULT_STABLES_RANGE };
