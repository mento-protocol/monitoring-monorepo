"use client";

import { useGQL } from "@/lib/graphql";
import { HASURA_TIMEOUT_MS } from "@/lib/hasura-timeout";
import type { PoolDetailInitialData } from "@/lib/pool-detail-initial-data";
import {
  POOL_DETAIL_WITH_HEALTH,
  type PoolDetailResponse,
} from "@/lib/queries";
import { PoolDetailWithHealthSchema } from "@/lib/queries/pool-detail-schemas";
import type { Pool } from "@/lib/types";
import { useCallback, useMemo, useRef, useState } from "react";

const MISSING_POOL_ROW_ERROR = new Error(
  "Pool health response omitted the requested pool",
);

export function useObservedPoolDetail(
  normalizedPoolId: string,
  chainId: number,
  initialData?: PoolDetailInitialData,
) {
  const poolKey = `${chainId}:${normalizedPoolId}`;
  const initialPool = initialData?.pool.Pool[0] ?? null;
  const lastConfirmedRef = useRef<{ poolKey: string; pool: Pool | null }>({
    poolKey,
    pool: initialPool,
  });
  if (lastConfirmedRef.current.poolKey !== poolKey) {
    lastConfirmedRef.current = { poolKey, pool: initialPool };
  }
  const [clientObservation, setClientObservation] = useState<{
    poolKey: string;
    checkedAt: number;
  } | null>(null);
  const recordFreshnessCheck = useCallback(
    (response: PoolDetailResponse) => {
      if (!response.Pool?.[0]) return;
      setClientObservation({ poolKey, checkedAt: Date.now() / 1000 });
    },
    [poolKey],
  );
  const { data, error, isLoading } = useGQL<PoolDetailResponse>(
    POOL_DETAIL_WITH_HEALTH,
    { id: normalizedPoolId, chainId },
    // Keep the default 30s refresh. Options belong in the 4th argument per
    // the documented useGQL shape (see use-gql-shape.test.ts).
    undefined,
    {
      fallbackData: initialData?.pool,
      onSuccess: recordFreshnessCheck,
      schema: PoolDetailWithHealthSchema,
      timeoutMs: HASURA_TIMEOUT_MS,
    },
  );
  const currentPool = data?.Pool?.[0] ?? null;
  if (currentPool !== null) {
    lastConfirmedRef.current = { poolKey, pool: currentPool };
  }
  const rawPool = currentPool ?? lastConfirmedRef.current.pool;
  const retainedAfterOmission =
    data !== undefined && currentPool === null && rawPool !== null;
  const refreshError =
    error ?? (retainedAfterOmission ? MISSING_POOL_ROW_ERROR : undefined);
  const pool = useMemo<Pool | null>(() => {
    if (!rawPool) return null;
    const clientFreshnessCheckedAt =
      clientObservation?.poolKey === poolKey
        ? clientObservation.checkedAt
        : undefined;
    const freshnessCheckedAt =
      clientFreshnessCheckedAt ?? rawPool.oracleFreshnessCheckedAt;
    const hasConfirmedCheck =
      freshnessCheckedAt !== undefined &&
      Number.isFinite(freshnessCheckedAt) &&
      freshnessCheckedAt > 0;
    const hasClientCheck = clientFreshnessCheckedAt !== undefined;
    return {
      ...rawPool,
      ...(hasConfirmedCheck
        ? { oracleFreshnessCheckedAt: freshnessCheckedAt }
        : {}),
      // A stale-while-revalidate SSR entry may be minutes old. Preserve its
      // event-time health, but wait for the first client response before
      // synthesizing a new stale-oracle incident from its timestamp.
      oracleFreshnessCheckPending: !hasConfirmedCheck && !hasClientCheck,
    };
  }, [rawPool, clientObservation, poolKey]);

  return { pool, error: refreshError, isLoading };
}
