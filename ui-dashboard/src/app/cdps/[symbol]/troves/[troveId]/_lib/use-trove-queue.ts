"use client";

// The redemption-queue panel's one data source. It owns its fetch by design
// (docs/PLAN-trove-history-page.md, "UI design → Redemption queue"): a direct
// deep-link to the trove page must render the ladder without the market
// page's `CDP_MARKET_DETAIL` cache being warm, so this never reads that
// query's response — it fires the panel-sized `CDP_TROVE_QUEUE` instead.
// Follows docs/pr-checklists/swr-polling-hasura.md: `useGQL`'s wrapper-owned
// 30s poll with focus/reconnect revalidation off, `timeoutMs` well below the
// poll interval, the shared retry policy, and a Zod rollout guard.

import { useMemo } from "react";
import { HASURA_TIMEOUT_MS, useGQL } from "@/lib/graphql";
import { CDP_TROVE_QUEUE } from "@/lib/queries";
import type { CdpCollateral } from "../../../../_lib/types";
import {
  buildTroveQueueModel,
  CdpTroveQueueSchema,
  type CdpTroveQueueResponse,
  type TroveQueueModel,
} from "./queue";

export type TroveQueueState = {
  /** Null until the query resolves once — `data == null` is the loading
   *  state (docs/pr-checklists/swr-polling-hasura.md: render a skeleton
   *  until `data !== undefined`, never a happy-path zero). */
  model: TroveQueueModel | null;
  isLoading: boolean;
  error: Error | undefined;
  /** `data != null`: distinguishes "never loaded" (hard error state) from
   *  "loaded, then a poll failed" (stale-refresh notice over the last
   *  confirmed ladder). */
  hasLoadedOnce: boolean;
};

export function useTroveQueue(
  /** The resolved market row (or undefined while markets load / for an
   *  unknown symbol) — taking the row instead of a pre-extracted id keeps
   *  the null-handling here, off the caller's lint complexity budget. */
  collateral: Pick<CdpCollateral, "id"> | undefined,
  troveEntityId: string | null,
): TroveQueueState {
  const collateralId = collateral == null ? null : collateral.id;
  const enabled = collateralId != null && troveEntityId != null;
  const queue = useGQL<CdpTroveQueueResponse>(
    enabled ? CDP_TROVE_QUEUE : null,
    enabled ? { collateralId } : undefined,
    { timeoutMs: HASURA_TIMEOUT_MS, schema: CdpTroveQueueSchema },
  );
  const model = useMemo(
    () =>
      queue.data == null || troveEntityId == null
        ? null
        : buildTroveQueueModel(queue.data, troveEntityId),
    [queue.data, troveEntityId],
  );
  return {
    model,
    isLoading: queue.isLoading,
    error: queue.error,
    hasLoadedOnce: queue.data != null,
  };
}
