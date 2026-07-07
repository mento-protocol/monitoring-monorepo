// Pool detail page fetches POOL_DETAIL_WITH_HEALTH for the bulk of the
// pool entity, but data-trust / degenerate-classification flags
// (`rebalanceThresholdsKnown` triple + `tokenDecimalsKnown` +
// `degenerateReserves`) are isolated in `POOL_THRESHOLDS_KNOWN_EXT` for
// schema-lag resilience (see queries.ts). This hook merges the two so
// consumers get a single `Pool` object with those flags merged in,
// plus loading/error state so the page can disambiguate "trust flags
// not yet known" (transient) from "decimals are confirmed unknown"
// (persistent). PR 1.7 tightened the USD gate to strict `!== true`, so
// returning `rawPool` (with `tokenDecimalsKnown=undefined`) under an
// EXT-query failure would render every USD field on the page as "—"
// without explanation — the page should show a retry/banner instead.

import { useMemo } from "react";
import { useGQL } from "@/lib/graphql";
import type { PoolDetailInitialData } from "@/lib/pool-detail-initial-data";
import {
  POOL_THRESHOLDS_KNOWN_EXT,
  POOL_VP_DEPRECATION_EXT,
  POOL_VP_LIFECYCLE_DEPRECATION_EXT,
  POOL_VP_ORACLE_FRESHNESS_EXT,
  type PoolThresholdsKnownExtResponse,
  type PoolThresholdsKnownExtRow,
  type PoolVpDeprecationExtResponse,
  type PoolVpDeprecationExtRow,
  type PoolVpLifecycleDeprecationExtResponse,
  type PoolVpLifecycleDeprecationExtRow,
  type PoolVpOracleFreshnessExtResponse,
  type PoolVpOracleFreshnessExtRow,
} from "@/lib/queries";
import { isVirtualPool, type Pool } from "@/lib/types";

function mergePoolExtensions(
  rawPool: Pool | null,
  args: {
    thresholdsExt: PoolThresholdsKnownExtRow | null;
    vpFreshnessExt: PoolVpOracleFreshnessExtRow | null;
    vpDeprecationExt: PoolVpDeprecationExtRow | null;
    vpLifecycleDeprecationExt: PoolVpLifecycleDeprecationExtRow | null;
  },
): Pool | null {
  if (!rawPool) return null;
  const {
    thresholdsExt,
    vpFreshnessExt,
    vpDeprecationExt,
    vpLifecycleDeprecationExt,
  } = args;
  const wrappedExchangeDeprecated =
    vpDeprecationExt?.isDeprecated === true ||
    vpLifecycleDeprecationExt !== null;
  return {
    ...rawPool,
    ...(thresholdsExt
      ? {
          rebalanceThresholdAbove: thresholdsExt.rebalanceThresholdAbove,
          rebalanceThresholdBelow: thresholdsExt.rebalanceThresholdBelow,
          rebalanceThresholdsKnown: thresholdsExt.rebalanceThresholdsKnown,
          tokenDecimalsKnown: thresholdsExt.tokenDecimalsKnown,
          degenerateReserves: thresholdsExt.degenerateReserves,
          breakerTripped: thresholdsExt.breakerTripped,
        }
      : {}),
    ...(vpFreshnessExt
      ? {
          lastOracleReportAt: vpFreshnessExt.lastOracleReportAt,
          medianLive: vpFreshnessExt.medianLive,
          oracleFreshnessWindow: vpFreshnessExt.oracleFreshnessWindow,
        }
      : {}),
    ...(wrappedExchangeDeprecated ? { wrappedExchangeDeprecated } : {}),
    ...(vpDeprecationExt?.minimumReports !== undefined
      ? { wrappedExchangeMinimumReports: vpDeprecationExt.minimumReports }
      : {}),
  };
}

function anyLoading(...states: boolean[]): boolean {
  return states.some(Boolean);
}

function queryStillLoadingWithoutData(
  data: unknown,
  isLoading: boolean,
): boolean {
  return data === undefined && isLoading;
}

function firstPoolRow<T>(
  data: { Pool?: T[] | undefined } | undefined,
): T | null {
  return data?.Pool?.[0] ?? null;
}

function firstBiPoolExchangeRow(
  data: PoolVpDeprecationExtResponse | undefined,
): PoolVpDeprecationExtRow | null {
  return data?.BiPoolExchange?.[0] ?? null;
}

function firstVirtualPoolLifecycleRow(
  data: PoolVpLifecycleDeprecationExtResponse | undefined,
): PoolVpLifecycleDeprecationExtRow | null {
  return data?.VirtualPoolLifecycle?.[0] ?? null;
}

function virtualPoolExtensionsLoading(
  rawPool: Pool | null,
  states: {
    vpFreshnessData: PoolVpOracleFreshnessExtResponse | undefined;
    vpFreshnessQueryLoading: boolean;
    vpDeprecationData: PoolVpDeprecationExtResponse | undefined;
    vpDeprecationQueryLoading: boolean;
    vpLifecycleDeprecationData:
      | PoolVpLifecycleDeprecationExtResponse
      | undefined;
    vpLifecycleDeprecationQueryLoading: boolean;
  },
): boolean {
  if (!rawPool || !isVirtualPool(rawPool)) return false;
  return anyLoading(
    queryStillLoadingWithoutData(
      states.vpFreshnessData,
      states.vpFreshnessQueryLoading,
    ),
    queryStillLoadingWithoutData(
      states.vpDeprecationData,
      states.vpDeprecationQueryLoading,
    ),
    queryStillLoadingWithoutData(
      states.vpLifecycleDeprecationData,
      states.vpLifecycleDeprecationQueryLoading,
    ),
  );
}

export type PoolWithThresholdsResult = {
  pool: Pool | null;
  /** True until SWR has either resolved data or returned an error for the
   * isolated trust-flag query. Distinguishes "still loading" from "loaded
   * but missing" so the page can render a skeleton vs an error vs USD `—`. */
  thresholdsLoading: boolean;
  /** Defined when the EXT query failed (timeout, schema-lag rejection,
   * Hasura unreachable). Consumers should surface a retry CTA rather than
   * silently rendering USD fields as `—`. */
  thresholdsError: Error | undefined;
};

export function usePoolWithThresholds(
  rawPool: Pool | null,
  poolId: string,
  chainId: number,
  initialData?: PoolDetailInitialData,
): PoolWithThresholdsResult {
  // Without this, a wedged Hasura connection on the trust-flag fetch
  // sticks the SWR poll until the underlying socket times out (minutes),
  // instead of failing fast and letting the next refresh interval retry.
  const {
    data: thresholdsData,
    error: thresholdsError,
    isLoading: thresholdsQueryLoading,
  } = useGQL<PoolThresholdsKnownExtResponse>(
    POOL_THRESHOLDS_KNOWN_EXT,
    { id: poolId, chainId },
    undefined,
    // 5s mirrors `HASURA_TIMEOUT_MS` in `lib/hasura-timeout.ts` (kept
    // literal here so this file's `vi.mock("@/lib/graphql", ...)`
    // boundary in the page test doesn't have to enumerate every named
    // export).
    { timeoutMs: 5000, fallbackData: initialData?.thresholds },
  );
  const thresholdsExt = firstPoolRow(thresholdsData);
  const { data: vpFreshnessData, isLoading: vpFreshnessQueryLoading } =
    useGQL<PoolVpOracleFreshnessExtResponse>(
      POOL_VP_ORACLE_FRESHNESS_EXT,
      { id: poolId, chainId },
      undefined,
      { timeoutMs: 5000, fallbackData: initialData?.vpOracleFreshness },
    );
  const vpFreshnessExt = firstPoolRow(vpFreshnessData);
  const { data: vpDeprecationData, isLoading: vpDeprecationQueryLoading } =
    useGQL<PoolVpDeprecationExtResponse>(
      POOL_VP_DEPRECATION_EXT,
      { id: poolId, chainId },
      undefined,
      { timeoutMs: 5000, fallbackData: initialData?.vpDeprecation },
    );
  const vpDeprecationExt = firstBiPoolExchangeRow(vpDeprecationData);
  const {
    data: vpLifecycleDeprecationData,
    isLoading: vpLifecycleDeprecationQueryLoading,
  } = useGQL<PoolVpLifecycleDeprecationExtResponse>(
    POOL_VP_LIFECYCLE_DEPRECATION_EXT,
    { id: poolId, chainId },
    undefined,
    { timeoutMs: 5000, fallbackData: initialData?.vpLifecycleDeprecation },
  );
  const vpLifecycleDeprecationExt = firstVirtualPoolLifecycleRow(
    vpLifecycleDeprecationData,
  );
  const pool = useMemo<Pool | null>(() => {
    return mergePoolExtensions(rawPool, {
      thresholdsExt,
      vpFreshnessExt,
      vpDeprecationExt,
      vpLifecycleDeprecationExt,
    });
  }, [
    rawPool,
    thresholdsExt,
    vpFreshnessExt,
    vpDeprecationExt,
    vpLifecycleDeprecationExt,
  ]);
  const vpLoading = virtualPoolExtensionsLoading(rawPool, {
    vpFreshnessData,
    vpFreshnessQueryLoading,
    vpDeprecationData,
    vpDeprecationQueryLoading,
    vpLifecycleDeprecationData,
    vpLifecycleDeprecationQueryLoading,
  });
  return {
    pool,
    thresholdsLoading: anyLoading(
      queryStillLoadingWithoutData(thresholdsData, thresholdsQueryLoading),
      vpLoading,
    ),
    thresholdsError:
      thresholdsData === undefined ? thresholdsError : undefined,
  };
}
