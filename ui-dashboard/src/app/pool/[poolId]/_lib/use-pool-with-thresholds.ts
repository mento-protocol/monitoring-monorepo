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

import { useCallback, useMemo, useRef, useState } from "react";
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
import {
  PoolThresholdsKnownExtSchema,
  PoolVpDeprecationExtSchema,
  PoolVpLifecycleDeprecationExtSchema,
  PoolVpOracleFreshnessExtSchema,
} from "@/lib/queries/pool-detail-schemas";
import { isVirtualPool, type Pool } from "@/lib/types";

function mergePoolExtensions(
  rawPool: Pool | null,
  args: {
    thresholdsExt: PoolThresholdsKnownExtRow | null;
    vpFreshnessExt: PoolVpOracleFreshnessExtRow | null;
    vpDeprecationExt: PoolVpDeprecationExtRow | null;
    vpLifecycleDeprecationExt: PoolVpLifecycleDeprecationExtRow | null;
    vpDeprecationKnown: boolean;
  },
): Pool | null {
  if (!rawPool) return null;
  const {
    thresholdsExt,
    vpFreshnessExt,
    vpDeprecationExt,
    vpLifecycleDeprecationExt,
    vpDeprecationKnown,
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
          ...(isVirtualPool(rawPool)
            ? {
                vpOracleTimestamp: vpFreshnessExt.oracleTimestamp,
                vpOracleNumReporters: vpFreshnessExt.oracleNumReporters,
                vpTokenDecimalsKnown: vpFreshnessExt.tokenDecimalsKnown,
                vpOracleFreshnessCheckedAt:
                  vpFreshnessExt.vpOracleFreshnessCheckedAt,
              }
            : {}),
        }
      : {}),
    ...(wrappedExchangeDeprecated ? { wrappedExchangeDeprecated } : {}),
    ...(isVirtualPool(rawPool) ? { vpDeprecationKnown } : {}),
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

function retainConfirmedExchangeDeprecation(
  prior: PoolVpDeprecationExtRow,
  current: PoolVpDeprecationExtRow,
): boolean {
  return prior.isDeprecated === true && current.isDeprecated !== true;
}

function usePoolScopedRowFallback<T>(
  poolKey: string,
  currentRow: T | null,
  initialRow: T | null,
  retainPrior?: ((prior: T, current: T) => boolean) | undefined,
): T | null {
  const lastConfirmedRef = useRef<{ poolKey: string; row: T | null }>({
    poolKey,
    row: initialRow,
  });
  if (lastConfirmedRef.current.poolKey !== poolKey) {
    lastConfirmedRef.current = { poolKey, row: initialRow };
  }
  if (currentRow !== null) {
    const prior = lastConfirmedRef.current.row;
    if (prior === null || retainPrior?.(prior, currentRow) !== true) {
      lastConfirmedRef.current = { poolKey, row: currentRow };
    }
  }
  return lastConfirmedRef.current.row;
}

const MISSING_THRESHOLDS_ROW_ERROR = new Error(
  "Pool threshold health response omitted the requested pool",
);
const MISSING_VP_FRESHNESS_ROW_ERROR = new Error(
  "VirtualPool freshness response omitted the requested pool",
);
const MISSING_VP_DEPRECATION_ROW_ERROR = new Error(
  "VirtualPool deprecation response omitted the requested exchange",
);
const MISSING_VP_LIFECYCLE_ROW_ERROR = new Error(
  "VirtualPool lifecycle response dropped a confirmed deprecation event",
);

function resolveVpDeprecationRefreshError(args: {
  vpDeprecationRetained: boolean;
  vpDeprecationError: Error | undefined;
  vpLifecycleDeprecationRetained: boolean;
  vpLifecycleDeprecationError: Error | undefined;
}): Error | undefined {
  if (args.vpDeprecationError) return args.vpDeprecationError;
  if (args.vpDeprecationRetained) return MISSING_VP_DEPRECATION_ROW_ERROR;
  if (args.vpLifecycleDeprecationError) return args.vpLifecycleDeprecationError;
  if (args.vpLifecycleDeprecationRetained)
    return MISSING_VP_LIFECYCLE_ROW_ERROR;
  return undefined;
}

function resolveHealthRefreshError(args: {
  rawPool: Pool | null;
  thresholdsData: PoolThresholdsKnownExtResponse | undefined;
  currentThresholdsExt: PoolThresholdsKnownExtRow | null;
  thresholdsError: Error | undefined;
  vpFreshnessData: PoolVpOracleFreshnessExtResponse | undefined;
  currentVpFreshnessExt: PoolVpOracleFreshnessExtRow | null;
  vpFreshnessError: Error | undefined;
  vpDeprecationData: PoolVpDeprecationExtResponse | undefined;
  currentVpDeprecationExt: PoolVpDeprecationExtRow | null;
  vpDeprecationRetained: boolean;
  vpDeprecationError: Error | undefined;
  vpLifecycleDeprecationRetained: boolean;
  vpLifecycleDeprecationError: Error | undefined;
}): Error | undefined {
  if (args.thresholdsError) return args.thresholdsError;
  if (
    args.rawPool &&
    args.thresholdsData !== undefined &&
    args.currentThresholdsExt === null
  ) {
    return MISSING_THRESHOLDS_ROW_ERROR;
  }
  if (!args.rawPool || !isVirtualPool(args.rawPool)) return undefined;
  const missingFreshnessError =
    args.vpFreshnessData !== undefined && args.currentVpFreshnessExt === null
      ? MISSING_VP_FRESHNESS_ROW_ERROR
      : undefined;
  const missingDeprecationError =
    args.vpDeprecationData !== undefined &&
    args.currentVpDeprecationExt === null
      ? MISSING_VP_DEPRECATION_ROW_ERROR
      : undefined;
  return (
    args.vpFreshnessError ??
    missingFreshnessError ??
    missingDeprecationError ??
    resolveVpDeprecationRefreshError(args)
  );
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

function useThresholdExtension(args: {
  poolKey: string;
  poolId: string;
  chainId: number;
  initialData: PoolDetailInitialData | undefined;
}) {
  const { data, error, isLoading } = useGQL<PoolThresholdsKnownExtResponse>(
    POOL_THRESHOLDS_KNOWN_EXT,
    { id: args.poolId, chainId: args.chainId },
    undefined,
    {
      timeoutMs: 5000,
      fallbackData: args.initialData?.thresholds,
      schema: PoolThresholdsKnownExtSchema,
    },
  );
  const current = firstPoolRow(data);
  const row = usePoolScopedRowFallback(
    args.poolKey,
    current,
    firstPoolRow(args.initialData?.thresholds),
  );
  return { data, error, isLoading, current, row };
}

function useVpFreshnessExtension(args: {
  poolKey: string;
  poolId: string;
  chainId: number;
  initialData: PoolDetailInitialData | undefined;
}) {
  const initialRow = firstPoolRow(args.initialData?.vpOracleFreshness);
  const [observation, setObservation] = useState<{
    poolKey: string;
    checkedAt: number | undefined;
  }>(() => ({
    poolKey: args.poolKey,
    checkedAt: initialRow?.vpOracleFreshnessCheckedAt,
  }));
  const recordObservation = useCallback(
    (response: PoolVpOracleFreshnessExtResponse) => {
      if (!response.Pool?.[0]) return;
      setObservation({
        poolKey: args.poolKey,
        checkedAt: Date.now() / 1000,
      });
    },
    [args.poolKey],
  );
  const { data, error, isLoading } = useGQL<PoolVpOracleFreshnessExtResponse>(
    POOL_VP_ORACLE_FRESHNESS_EXT,
    { id: args.poolId, chainId: args.chainId },
    undefined,
    {
      timeoutMs: 5000,
      fallbackData: args.initialData?.vpOracleFreshness,
      onSuccess: recordObservation,
      schema: PoolVpOracleFreshnessExtSchema,
    },
  );
  const rawCurrent = firstPoolRow(data);
  const activeCheckedAt =
    observation.poolKey === args.poolKey
      ? observation.checkedAt
      : initialRow?.vpOracleFreshnessCheckedAt;
  const current = rawCurrent
    ? {
        ...rawCurrent,
        ...(activeCheckedAt !== undefined
          ? { vpOracleFreshnessCheckedAt: activeCheckedAt }
          : {}),
      }
    : null;
  const row = usePoolScopedRowFallback(args.poolKey, current, initialRow);
  return { data, error, isLoading, current, row };
}

function useVpDeprecationExtensions(args: {
  poolKey: string;
  poolId: string;
  chainId: number;
  initialData: PoolDetailInitialData | undefined;
}) {
  const exchange = useGQL<PoolVpDeprecationExtResponse>(
    POOL_VP_DEPRECATION_EXT,
    { id: args.poolId, chainId: args.chainId },
    undefined,
    {
      timeoutMs: 5000,
      fallbackData: args.initialData?.vpDeprecation,
      schema: PoolVpDeprecationExtSchema,
    },
  );
  const currentExchange = firstBiPoolExchangeRow(exchange.data);
  const exchangeRow = usePoolScopedRowFallback(
    args.poolKey,
    currentExchange,
    firstBiPoolExchangeRow(args.initialData?.vpDeprecation),
    retainConfirmedExchangeDeprecation,
  );
  const exchangeRetained =
    exchange.data !== undefined &&
    exchangeRow !== null &&
    exchangeRow !== currentExchange;

  const lifecycle = useGQL<PoolVpLifecycleDeprecationExtResponse>(
    POOL_VP_LIFECYCLE_DEPRECATION_EXT,
    { id: args.poolId, chainId: args.chainId },
    undefined,
    {
      timeoutMs: 5000,
      fallbackData: args.initialData?.vpLifecycleDeprecation,
      schema: PoolVpLifecycleDeprecationExtSchema,
    },
  );
  const currentLifecycle = firstVirtualPoolLifecycleRow(lifecycle.data);
  const lifecycleRow = usePoolScopedRowFallback(
    args.poolKey,
    currentLifecycle,
    firstVirtualPoolLifecycleRow(args.initialData?.vpLifecycleDeprecation),
  );
  const lifecycleRetained =
    lifecycle.data !== undefined &&
    lifecycleRow !== null &&
    lifecycleRow !== currentLifecycle;
  return {
    exchange,
    currentExchange,
    exchangeRow,
    exchangeRetained,
    lifecycle,
    currentLifecycle,
    lifecycleRow,
    lifecycleRetained,
  };
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
  /** A base-health extension failed after stale data was retained. The page
   * can keep rendering that last confirmed state, but must disclose that its
   * breaker/VirtualPool inputs are no longer being re-observed. */
  healthRefreshError: Error | undefined;
};

export function usePoolWithThresholds(
  rawPool: Pool | null,
  poolId: string,
  chainId: number,
  initialData?: PoolDetailInitialData,
): PoolWithThresholdsResult {
  const poolKey = `${chainId}:${poolId}`;
  const thresholds = useThresholdExtension({
    poolKey,
    poolId,
    chainId,
    initialData,
  });
  const vpFreshness = useVpFreshnessExtension({
    poolKey,
    poolId,
    chainId,
    initialData,
  });
  const deprecation = useVpDeprecationExtensions({
    poolKey,
    poolId,
    chainId,
    initialData,
  });
  const pool = useMemo<Pool | null>(() => {
    return mergePoolExtensions(rawPool, {
      thresholdsExt: thresholds.row,
      vpFreshnessExt: vpFreshness.row,
      vpDeprecationExt: deprecation.exchangeRow,
      vpLifecycleDeprecationExt: deprecation.lifecycleRow,
      vpDeprecationKnown:
        deprecation.exchangeRow !== null &&
        deprecation.exchange.data !== undefined &&
        deprecation.lifecycle.data !== undefined,
    });
  }, [
    rawPool,
    thresholds.row,
    vpFreshness.row,
    deprecation.exchangeRow,
    deprecation.exchange.data,
    deprecation.lifecycleRow,
    deprecation.lifecycle.data,
  ]);
  const vpLoading = virtualPoolExtensionsLoading(rawPool, {
    vpFreshnessData: vpFreshness.data,
    vpFreshnessQueryLoading: vpFreshness.isLoading,
    vpDeprecationData: deprecation.exchange.data,
    vpDeprecationQueryLoading: deprecation.exchange.isLoading,
    vpLifecycleDeprecationData: deprecation.lifecycle.data,
    vpLifecycleDeprecationQueryLoading: deprecation.lifecycle.isLoading,
  });
  const healthRefreshError = resolveHealthRefreshError({
    rawPool,
    thresholdsData: thresholds.data,
    currentThresholdsExt: thresholds.current,
    thresholdsError: thresholds.error,
    vpFreshnessData: vpFreshness.data,
    currentVpFreshnessExt: vpFreshness.current,
    vpFreshnessError: vpFreshness.error,
    vpDeprecationData: deprecation.exchange.data,
    currentVpDeprecationExt: deprecation.currentExchange,
    vpDeprecationRetained: deprecation.exchangeRetained,
    vpDeprecationError: deprecation.exchange.error,
    vpLifecycleDeprecationRetained: deprecation.lifecycleRetained,
    vpLifecycleDeprecationError: deprecation.lifecycle.error,
  });
  return {
    pool,
    thresholdsLoading: anyLoading(
      queryStillLoadingWithoutData(thresholds.data, thresholds.isLoading),
      vpLoading,
    ),
    thresholdsError:
      thresholds.data === undefined ? thresholds.error : undefined,
    healthRefreshError,
  };
}
