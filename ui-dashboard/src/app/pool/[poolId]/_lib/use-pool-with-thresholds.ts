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
import {
  POOL_THRESHOLDS_KNOWN_EXT,
  POOL_VP_DEPRECATION_EXT,
  POOL_VP_ORACLE_FRESHNESS_EXT,
} from "@/lib/queries";
import type { Pool } from "@/lib/types";

type ThresholdsExtRow = {
  id: string;
  rebalanceThresholdAbove?: number;
  rebalanceThresholdBelow?: number;
  rebalanceThresholdsKnown?: boolean;
  tokenDecimalsKnown?: boolean;
  degenerateReserves?: boolean;
  breakerTripped?: boolean;
};

type VpOracleFreshnessExtRow = {
  id: string;
  lastOracleReportAt?: string;
  medianLive?: boolean;
  oracleFreshnessWindow?: string;
};

type VpDeprecationExtRow = {
  id: string;
  isDeprecated?: boolean;
};

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
): PoolWithThresholdsResult {
  // Without this, a wedged Hasura connection on the trust-flag fetch
  // sticks the SWR poll until the underlying socket times out (minutes),
  // instead of failing fast and letting the next refresh interval retry.
  const {
    data: thresholdsData,
    error: thresholdsError,
    isLoading: thresholdsLoading,
  } = useGQL<{ Pool: ThresholdsExtRow[] }>(
    POOL_THRESHOLDS_KNOWN_EXT,
    { id: poolId, chainId },
    undefined,
    // 5s mirrors `HASURA_TIMEOUT_MS` in `lib/hasura-timeout.ts` (kept
    // literal here so this file's `vi.mock("@/lib/graphql", ...)`
    // boundary in the page test doesn't have to enumerate every named
    // export).
    { timeoutMs: 5000 },
  );
  const thresholdsExt = thresholdsData?.Pool?.[0] ?? null;
  const { data: vpFreshnessData, isLoading: vpFreshnessLoading } = useGQL<{
    Pool: VpOracleFreshnessExtRow[];
  }>(POOL_VP_ORACLE_FRESHNESS_EXT, { id: poolId, chainId }, undefined, {
    timeoutMs: 5000,
  });
  const vpFreshnessExt = vpFreshnessData?.Pool?.[0] ?? null;
  const { data: vpDeprecationData, isLoading: vpDeprecationLoading } = useGQL<{
    BiPoolExchange: VpDeprecationExtRow[];
  }>(POOL_VP_DEPRECATION_EXT, { id: poolId, chainId }, undefined, {
    timeoutMs: 5000,
  });
  const vpDeprecationExt = vpDeprecationData?.BiPoolExchange?.[0] ?? null;
  const pool = useMemo<Pool | null>(() => {
    if (!rawPool) return null;
    if (!thresholdsExt && !vpFreshnessExt && !vpDeprecationExt) return rawPool;
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
      ...(vpDeprecationExt
        ? {
            wrappedExchangeDeprecated: vpDeprecationExt.isDeprecated,
          }
        : {}),
    };
  }, [rawPool, thresholdsExt, vpFreshnessExt, vpDeprecationExt]);
  return {
    pool,
    thresholdsLoading:
      thresholdsLoading || vpFreshnessLoading || vpDeprecationLoading,
    thresholdsError,
  };
}
