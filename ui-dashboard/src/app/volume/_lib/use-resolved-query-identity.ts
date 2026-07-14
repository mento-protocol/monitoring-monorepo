"use client";

import { useEffect, useRef } from "react";
import type { VolumeRangeKey } from "@/lib/volume";
import { hasErrorWithoutData, isLoadingWithoutData } from "@/lib/swr-state";

type ActorView = "all" | "organic";
export type VolumeQueryIdentity = `${VolumeRangeKey}|${number}|${ActorView}`;

export function volumeQueryIdentity({
  range,
  cutoff,
  includeProtocolActors,
}: {
  range: VolumeRangeKey;
  cutoff: number;
  includeProtocolActors: boolean;
}): VolumeQueryIdentity {
  return `${range}|${cutoff}|${includeProtocolActors ? "all" : "organic"}`;
}

export function rangeFromQueryIdentity(
  identity: VolumeQueryIdentity | undefined,
): VolumeRangeKey | undefined {
  return identity?.split("|", 1)[0] as VolumeRangeKey | undefined;
}

export function cutoffFromQueryIdentity(
  identity: VolumeQueryIdentity | undefined,
): number | undefined {
  const cutoff = identity?.split("|")[1];
  return cutoff === undefined ? undefined : Number(cutoff);
}

export function actorViewFromQueryIdentity(
  identity: VolumeQueryIdentity | undefined,
): boolean | undefined {
  const actorView = identity?.split("|")[2] as ActorView | undefined;
  return actorView === undefined ? undefined : actorView === "all";
}

export function dataMatchesCurrentActor(
  identity: VolumeQueryIdentity | undefined,
  currentIdentity: VolumeQueryIdentity,
): boolean {
  return (
    actorViewFromQueryIdentity(identity) ===
    actorViewFromQueryIdentity(currentIdentity)
  );
}

type QueryResultState = {
  data: unknown;
  error: unknown;
  isLoading: boolean;
};

/**
 * Tracks which query identity produced SWR's currently exposed data.
 *
 * With `keepPreviousData`, a key change exposes the prior response while the
 * replacement request is loading (and keeps exposing it if that request
 * fails). Consumers must therefore pair the data with the last successfully
 * resolved key, rather than with the render's newly requested key.
 *
 * `fallbackMatchesCurrent` covers SSR `fallbackData`: SWR reports it as
 * loading during the first revalidation, but the server descriptor has
 * already proved that it belongs to the current key.
 */
export function useResolvedQueryIdentity<
  TIdentity extends string | number | boolean,
>(
  result: QueryResultState,
  currentIdentity: TIdentity,
  fallbackMatchesCurrent = false,
): TIdentity | undefined {
  const isCurrentResponse =
    result.data !== undefined && result.error == null && !result.isLoading;
  const lastResolvedIdentity = useRef<TIdentity | undefined>(
    isCurrentResponse || (result.data !== undefined && fallbackMatchesCurrent)
      ? currentIdentity
      : undefined,
  );

  useEffect(() => {
    if (!isCurrentResponse) return;
    lastResolvedIdentity.current = currentIdentity;
  }, [currentIdentity, isCurrentResponse]);

  if (result.data === undefined) return undefined;
  if (isCurrentResponse || fallbackMatchesCurrent) return currentIdentity;
  return lastResolvedIdentity.current;
}

/** Range-retained query state with actor-sensitive data exposure. */
export function useVersionedVolumeQueryData<T>(
  result: QueryResultState & { data: T | undefined },
  currentIdentity: VolumeQueryIdentity,
): {
  data: T | undefined;
  dataIdentity: VolumeQueryIdentity | undefined;
  isLoading: boolean;
  hasError: boolean;
} {
  const dataIdentity = useResolvedQueryIdentity(result, currentIdentity);
  const data = dataMatchesCurrentActor(dataIdentity, currentIdentity)
    ? result.data
    : undefined;
  return {
    data,
    dataIdentity,
    isLoading: isLoadingWithoutData(result.isLoading, data),
    hasError: hasErrorWithoutData(result.error, data),
  };
}
