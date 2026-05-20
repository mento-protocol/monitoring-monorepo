"use client";

import { useRef } from "react";

export function usePoolScopedCountFallback(
  poolId: string,
  rawTotal: number,
  hasCountError: boolean,
): number {
  const lastKnownTotalRef = useRef({ poolId, total: 0 });
  if (lastKnownTotalRef.current.poolId !== poolId) {
    lastKnownTotalRef.current = { poolId, total: 0 };
  }
  if (rawTotal > 0) lastKnownTotalRef.current = { poolId, total: rawTotal };
  return hasCountError ? lastKnownTotalRef.current.total : rawTotal;
}
