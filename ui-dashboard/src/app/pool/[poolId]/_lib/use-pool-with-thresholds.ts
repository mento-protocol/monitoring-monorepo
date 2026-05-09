// Pool detail page fetches POOL_DETAIL_WITH_HEALTH for the bulk of the
// pool entity, but `rebalanceThresholdAbove` / `rebalanceThresholdBelow` /
// `rebalanceThresholdsKnown` are isolated in `POOL_THRESHOLDS_KNOWN_EXT`
// for schema-lag resilience (see queries.ts). This hook merges the two
// so consumers get a single `Pool` object with the threshold fields
// merged in. On EXT failure the threshold fields stay `undefined` and
// `isNeverRebalance` / `effectiveThreshold` fall back to the safe
// 10000-bps under-bound.

import { useMemo } from "react";
import { useGQL } from "@/lib/graphql";
import { POOL_THRESHOLDS_KNOWN_EXT } from "@/lib/queries";
import type { Pool } from "@/lib/types";

type ThresholdsExtRow = {
  id: string;
  rebalanceThresholdAbove?: number;
  rebalanceThresholdBelow?: number;
  rebalanceThresholdsKnown?: boolean;
};

export function usePoolWithThresholds(
  rawPool: Pool | null,
  poolId: string,
  chainId: number,
): Pool | null {
  const { data: thresholdsData } = useGQL<{ Pool: ThresholdsExtRow[] }>(
    POOL_THRESHOLDS_KNOWN_EXT,
    { id: poolId, chainId },
  );
  const thresholdsExt = thresholdsData?.Pool?.[0] ?? null;
  return useMemo<Pool | null>(() => {
    if (!rawPool) return null;
    if (!thresholdsExt) return rawPool;
    return {
      ...rawPool,
      rebalanceThresholdAbove: thresholdsExt.rebalanceThresholdAbove,
      rebalanceThresholdBelow: thresholdsExt.rebalanceThresholdBelow,
      rebalanceThresholdsKnown: thresholdsExt.rebalanceThresholdsKnown,
    };
  }, [rawPool, thresholdsExt]);
}
