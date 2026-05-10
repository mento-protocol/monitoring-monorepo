// Pool detail page fetches POOL_DETAIL_WITH_HEALTH for the bulk of the
// pool entity, but data-trust flags (`rebalanceThresholdsKnown` triple +
// `tokenDecimalsKnown`) are isolated in `POOL_THRESHOLDS_KNOWN_EXT` for
// schema-lag resilience (see queries.ts). This hook merges the two so
// consumers get a single `Pool` object with the trust flags merged in.
// On EXT failure the fields stay `undefined`: `isNeverRebalance` /
// `effectiveThreshold` fall back to the 10000-bps under-bound, and
// USD math via `getSnapshotVolumeInUsd` / `poolTvlUSD` fails closed —
// PR 1.7 tightened the gate to strict `!== true`, so an EXT-query
// failure renders the pool's USD fields as `—` until the next refresh.

import { useMemo } from "react";
import { useGQL } from "@/lib/graphql";
import { POOL_THRESHOLDS_KNOWN_EXT } from "@/lib/queries";
import type { Pool } from "@/lib/types";

type ThresholdsExtRow = {
  id: string;
  rebalanceThresholdAbove?: number;
  rebalanceThresholdBelow?: number;
  rebalanceThresholdsKnown?: boolean;
  tokenDecimalsKnown?: boolean;
};

export function usePoolWithThresholds(
  rawPool: Pool | null,
  poolId: string,
  chainId: number,
): Pool | null {
  // Without this, a wedged Hasura connection on the trust-flag fetch
  // sticks the SWR poll until the underlying socket times out (minutes),
  // instead of failing fast and letting the next refresh interval retry.
  const { data: thresholdsData } = useGQL<{ Pool: ThresholdsExtRow[] }>(
    POOL_THRESHOLDS_KNOWN_EXT,
    { id: poolId, chainId },
    undefined,
    // 5s mirrors `HASURA_TIMEOUT_MS` in `lib/graphql.ts` (kept literal here
    // so this file's `vi.mock("@/lib/graphql", ...)` boundary in the page
    // test doesn't have to enumerate every named export).
    { timeoutMs: 5000 },
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
      tokenDecimalsKnown: thresholdsExt.tokenDecimalsKnown,
    };
  }, [rawPool, thresholdsExt]);
}
