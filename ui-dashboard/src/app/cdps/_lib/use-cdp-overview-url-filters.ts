"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useSearchParams } from "next/navigation";
import {
  TX_FILTER_TYPE_ORDER,
  normalizeAddressFilter,
} from "../_components/cdp-tx-filters";
import type { BadgeKind } from "./transactions";

const CDP_TYPE_QUERY_PARAM = "type";
const CDP_MARKET_QUERY_PARAM = "market";
const CDP_ADDRESS_QUERY_PARAM = "address";
const TX_FILTER_TYPE_SET = new Set<BadgeKind>(TX_FILTER_TYPE_ORDER);

interface CollateralSummary {
  id: string;
}

interface OverviewFilterSnapshot {
  typeFilter: BadgeKind | null;
  marketFilter: string | null;
  addressInput: string;
}

function readOverviewFiltersFromParams(
  params: URLSearchParams,
  collaterals: CollateralSummary[],
): OverviewFilterSnapshot {
  return {
    typeFilter: parseTypeFilter(params),
    marketFilter: normalizeMarketFilter(parseMarketFilter(params), collaterals),
    addressInput: parseAddressInput(params),
  };
}

function parseTypeFilter(params: URLSearchParams): BadgeKind | null {
  const raw = params.get(CDP_TYPE_QUERY_PARAM);
  return raw && TX_FILTER_TYPE_SET.has(raw as BadgeKind)
    ? (raw as BadgeKind)
    : null;
}

function parseMarketFilter(params: URLSearchParams): string | null {
  const raw = params.get(CDP_MARKET_QUERY_PARAM)?.trim();
  return raw ? raw : null;
}

function parseAddressInput(params: URLSearchParams): string {
  return normalizeAddressFilter(params.get(CDP_ADDRESS_QUERY_PARAM) ?? "");
}

function normalizeMarketFilter(
  marketFilter: string | null,
  collaterals: CollateralSummary[],
): string | null {
  if (marketFilter == null) return null;
  return collaterals.some((c) => c.id === marketFilter) ? marketFilter : null;
}

function buildOverviewFiltersSearch(
  currentSearch: string,
  { typeFilter, marketFilter, addressInput }: OverviewFilterSnapshot,
): string {
  const params = new URLSearchParams(currentSearch);
  if (typeFilter == null) {
    params.delete(CDP_TYPE_QUERY_PARAM);
  } else {
    params.set(CDP_TYPE_QUERY_PARAM, typeFilter);
  }
  if (marketFilter == null) {
    params.delete(CDP_MARKET_QUERY_PARAM);
  } else {
    params.set(CDP_MARKET_QUERY_PARAM, marketFilter);
  }
  const normalizedAddress = normalizeAddressFilter(addressInput);
  if (normalizedAddress === "") {
    params.delete(CDP_ADDRESS_QUERY_PARAM);
  } else {
    params.set(CDP_ADDRESS_QUERY_PARAM, normalizedAddress);
  }
  return params.toString();
}

function replaceOverviewFiltersUrl(nextSearch: string) {
  if (typeof window === "undefined") return;
  const nextUrl =
    window.location.pathname +
    (nextSearch ? `?${nextSearch}` : "") +
    window.location.hash;
  window.history.replaceState(window.history.state, "", nextUrl);
}

function writeOverviewFiltersUrl(next: OverviewFilterSnapshot) {
  if (typeof window === "undefined") return;
  replaceOverviewFiltersUrl(
    buildOverviewFiltersSearch(window.location.search, next),
  );
}

function syncOverviewFilterState({
  next,
  setTypeFilterState,
  setMarketFilterState,
  setAddressInputState,
}: {
  next: OverviewFilterSnapshot;
  setTypeFilterState: Dispatch<SetStateAction<BadgeKind | null>>;
  setMarketFilterState: Dispatch<SetStateAction<string | null>>;
  setAddressInputState: Dispatch<SetStateAction<string>>;
}) {
  setTypeFilterState((prev) =>
    prev === next.typeFilter ? prev : next.typeFilter,
  );
  setMarketFilterState((prev) =>
    prev === next.marketFilter ? prev : next.marketFilter,
  );
  setAddressInputState((prev) =>
    prev === next.addressInput ? prev : next.addressInput,
  );
}

export function useCdpOverviewUrlFilters(collaterals: CollateralSummary[]) {
  // `useSearchParams()` is the SSR-pass source for direct `/cdps?...` loads.
  // Runtime writes/readbacks use `window.location.search` so our own
  // `replaceState` writes compose with sibling URL-state writers.
  // react-doctor-disable-next-line react-doctor/nextjs-no-use-search-params-without-suspense
  const searchParams = useSearchParams();
  const initialReadParams =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search)
      : searchParams;
  const initialFilters = readOverviewFiltersFromParams(
    initialReadParams,
    collaterals,
  );

  const [typeFilter, setTypeFilterState] = useState<BadgeKind | null>(
    initialFilters.typeFilter,
  );
  const [marketFilter, setMarketFilterState] = useState<string | null>(
    initialFilters.marketFilter,
  );
  const [addressInput, setAddressInputState] = useState(
    initialFilters.addressInput,
  );
  const effectiveMarketFilter = useMemo(() => {
    if (marketFilter == null) return null;
    return collaterals.some((c) => c.id === marketFilter) ? marketFilter : null;
  }, [collaterals, marketFilter]);

  const writeFiltersUrl = useCallback(
    (next: OverviewFilterSnapshot) => {
      writeOverviewFiltersUrl({
        ...next,
        marketFilter: normalizeMarketFilter(next.marketFilter, collaterals),
      });
    },
    [collaterals],
  );

  const setTypeFilter = useCallback(
    (next: BadgeKind | null) => {
      setTypeFilterState(next);
      writeFiltersUrl({
        typeFilter: next,
        marketFilter: effectiveMarketFilter,
        addressInput,
      });
    },
    [addressInput, effectiveMarketFilter, writeFiltersUrl],
  );
  const setMarketFilter = useCallback(
    (next: string | null) => {
      setMarketFilterState(next);
      writeFiltersUrl({
        typeFilter,
        marketFilter: next,
        addressInput,
      });
    },
    [addressInput, typeFilter, writeFiltersUrl],
  );
  const setAddressInput = useCallback(
    (next: string) => {
      setAddressInputState(next);
      writeFiltersUrl({
        typeFilter,
        marketFilter: effectiveMarketFilter,
        addressInput: next,
      });
    },
    [effectiveMarketFilter, typeFilter, writeFiltersUrl],
  );
  useCanonicalOverviewFilterUrl(
    collaterals,
    setTypeFilterState,
    setMarketFilterState,
    setAddressInputState,
  );
  useOverviewFilterPopState(
    collaterals,
    setTypeFilterState,
    setMarketFilterState,
    setAddressInputState,
  );

  return {
    typeFilter,
    setTypeFilter,
    marketFilter: effectiveMarketFilter,
    setMarketFilter,
    effectiveMarketFilter,
    addressInput,
    setAddressInput,
  };
}

function useCanonicalOverviewFilterUrl(
  collaterals: CollateralSummary[],
  setTypeFilterState: Dispatch<SetStateAction<BadgeKind | null>>,
  setMarketFilterState: Dispatch<SetStateAction<string | null>>,
  setAddressInputState: Dispatch<SetStateAction<string>>,
) {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const current = new URLSearchParams(window.location.search);
    const next = readOverviewFiltersFromParams(current, collaterals);
    syncOverviewFilterState({
      next,
      setTypeFilterState,
      setMarketFilterState,
      setAddressInputState,
    });
    const canonicalSearch = buildOverviewFiltersSearch(
      window.location.search,
      next,
    );
    if (canonicalSearch !== current.toString()) {
      replaceOverviewFiltersUrl(canonicalSearch);
    }
  }, [
    collaterals,
    setAddressInputState,
    setMarketFilterState,
    setTypeFilterState,
  ]);
}

function useOverviewFilterPopState(
  collaterals: CollateralSummary[],
  setTypeFilterState: Dispatch<SetStateAction<BadgeKind | null>>,
  setMarketFilterState: Dispatch<SetStateAction<string | null>>,
  setAddressInputState: Dispatch<SetStateAction<string>>,
) {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onPopState = () => {
      const next = readOverviewFiltersFromParams(
        new URLSearchParams(window.location.search),
        collaterals,
      );
      syncOverviewFilterState({
        next,
        setTypeFilterState,
        setMarketFilterState,
        setAddressInputState,
      });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [
    collaterals,
    setAddressInputState,
    setMarketFilterState,
    setTypeFilterState,
  ]);
}
