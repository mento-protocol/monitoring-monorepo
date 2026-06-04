"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  DEFAULT_SUPPLY_CHANGE_MIN_USD,
  SUPPLY_CHANGE_MIN_USD_QUERY_PARAM,
} from "./aggregate";

type SupplyChangeThresholdState = {
  minimumUsdValue: number;
  updateMinimumUsdValue: (next: number) => void;
  resetMinimumUsdValue: () => void;
};

function parseMinimumUsdValue(params: URLSearchParams): number {
  const raw = params.get(SUPPLY_CHANGE_MIN_USD_QUERY_PARAM);
  if (raw == null) return DEFAULT_SUPPLY_CHANGE_MIN_USD;
  const next = Number(raw.trim());
  return Number.isFinite(next) && next >= 0
    ? next
    : DEFAULT_SUPPLY_CHANGE_MIN_USD;
}

function writeMinimumUsdValueUrl(next: number) {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  if (next === DEFAULT_SUPPLY_CHANGE_MIN_USD) {
    params.delete(SUPPLY_CHANGE_MIN_USD_QUERY_PARAM);
  } else {
    params.set(SUPPLY_CHANGE_MIN_USD_QUERY_PARAM, String(next));
  }
  const qs = params.toString();
  const nextUrl =
    window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
  window.history.replaceState(window.history.state, "", nextUrl);
}

function sanitizeMinimumUsdValue(next: number): number {
  return Number.isFinite(next) && next >= 0
    ? next
    : DEFAULT_SUPPLY_CHANGE_MIN_USD;
}

export function useSupplyChangeThreshold(): SupplyChangeThresholdState {
  // `useSearchParams()` is the SSR-pass source for direct `/stables?...`
  // loads. Writes use History API below so this table-local filter does not
  // trigger an App Router RSC refetch.
  // react-doctor-disable-next-line react-doctor/nextjs-no-use-search-params-without-suspense
  const searchParams = useSearchParams();

  const initialReadParams =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search)
      : searchParams;

  const [minimumUsdValue, setMinimumUsdValue] = useState(() =>
    parseMinimumUsdValue(initialReadParams),
  );

  const updateMinimumUsdValue = useCallback((next: number) => {
    const sanitized = sanitizeMinimumUsdValue(next);
    setMinimumUsdValue(sanitized);
    writeMinimumUsdValueUrl(sanitized);
  }, []);

  const resetMinimumUsdValue = useCallback(() => {
    updateMinimumUsdValue(DEFAULT_SUPPLY_CHANGE_MIN_USD);
  }, [updateMinimumUsdValue]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const current = new URLSearchParams(window.location.search);
    const next = parseMinimumUsdValue(current);
    const currentRaw = current.get(SUPPLY_CHANGE_MIN_USD_QUERY_PARAM);
    const isDefault = next === DEFAULT_SUPPLY_CHANGE_MIN_USD;
    if (
      (currentRaw == null && isDefault) ||
      (!isDefault && currentRaw === String(next))
    ) {
      return;
    }
    writeMinimumUsdValueUrl(next);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onPopState = () => {
      const next = parseMinimumUsdValue(
        new URLSearchParams(window.location.search),
      );
      setMinimumUsdValue((prev) => (prev === next ? prev : next));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  return {
    minimumUsdValue,
    updateMinimumUsdValue,
    resetMinimumUsdValue,
  };
}
