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

type ResolvedQueryIdentityOptions = {
  /** Whether the query's SWR key is currently non-null. */
  enabled: boolean;
  /** Whether descriptor validation proved SSR fallback belongs to this key. */
  fallbackMatchesCurrent?: boolean;
};

function classifyCurrentResponse(
  result: QueryResultState,
  { enabled, fallbackMatchesCurrent = false }: ResolvedQueryIdentityOptions,
): {
  isCurrentResponse: boolean;
  isCurrentFallback: boolean;
  isSeedableResponse: boolean;
} {
  const hasCurrentKeyData = enabled && result.data !== undefined;
  return {
    isCurrentResponse:
      hasCurrentKeyData && result.error == null && !result.isLoading,
    isCurrentFallback: hasCurrentKeyData && fallbackMatchesCurrent,
    isSeedableResponse: hasCurrentKeyData && !result.isLoading,
  };
}

type ResolvedData<TIdentity> = {
  identity: TIdentity;
  data: unknown;
};

function canAdoptSeedableResponse<TIdentity>(
  isSeedableResponse: boolean,
  currentIdentity: TIdentity,
  currentData: unknown,
  lastResolved: ResolvedData<TIdentity> | undefined,
): boolean {
  if (!isSeedableResponse) return false;
  if (lastResolved === undefined) return true;
  if (lastResolved.identity === currentIdentity) return true;
  // SWR 2.4's keepPreviousData path exposes laggyDataRef.current by exact
  // reference. A distinct non-loading value therefore came from the current
  // key's cache, even when its background revalidation also returned an error.
  return lastResolved.data !== currentData;
}

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
 *
 * `enabled` must match whether the query's SWR key is non-null. A disabled
 * SWR hook can expose its last data with `isLoading: false`; that data must
 * not be restamped as belonging to identities selected while the query was
 * disabled.
 */
export function useResolvedQueryIdentity<
  TIdentity extends string | number | boolean,
>(
  result: QueryResultState,
  currentIdentity: TIdentity,
  options: ResolvedQueryIdentityOptions,
): TIdentity | undefined {
  const { isCurrentResponse, isCurrentFallback, isSeedableResponse } =
    classifyCurrentResponse(result, options);
  // Cached data with a background-revalidation error still belongs to the
  // current SWR key when a tracker first mounts or becomes enabled. Keep this
  // broader seed separate from `isCurrentResponse`: an error after a key
  // change may be retained data from the previous key and must not update an
  // already-established identity.
  const lastResolved = useRef<ResolvedData<TIdentity> | undefined>(
    isSeedableResponse || isCurrentFallback
      ? { identity: currentIdentity, data: result.data }
      : undefined,
  );
  const canAdoptCurrentData = canAdoptSeedableResponse(
    isSeedableResponse,
    currentIdentity,
    result.data,
    lastResolved.current,
  );
  const resolvesCurrentIdentity =
    isCurrentResponse || isCurrentFallback || canAdoptCurrentData;

  useEffect(() => {
    if (!resolvesCurrentIdentity || result.data === undefined) return;
    lastResolved.current = { identity: currentIdentity, data: result.data };
  }, [currentIdentity, resolvesCurrentIdentity, result.data]);

  if (result.data === undefined) return undefined;
  if (resolvesCurrentIdentity) return currentIdentity;
  return lastResolved.current?.identity;
}

/** Range-retained query state with actor-sensitive data exposure. */
export function useVersionedVolumeQueryData<T>(
  result: QueryResultState & { data: T | undefined },
  currentIdentity: VolumeQueryIdentity,
  { enabled }: Pick<ResolvedQueryIdentityOptions, "enabled">,
): {
  data: T | undefined;
  dataIdentity: VolumeQueryIdentity | undefined;
  isLoading: boolean;
  hasError: boolean;
} {
  const dataIdentity = useResolvedQueryIdentity(result, currentIdentity, {
    enabled,
  });
  const data =
    enabled && dataMatchesCurrentActor(dataIdentity, currentIdentity)
      ? result.data
      : undefined;
  return {
    data,
    dataIdentity,
    isLoading: enabled && isLoadingWithoutData(result.isLoading, data),
    hasError: enabled && hasErrorWithoutData(result.error, data),
  };
}
