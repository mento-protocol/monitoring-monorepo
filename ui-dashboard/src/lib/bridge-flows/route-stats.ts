import { transferDeliveryDurationSec } from "@/lib/bridge-status";
import type { BridgeTransfer } from "@/lib/types";

export type RouteAvgTime = {
  srcChainId: number;
  dstChainId: number;
  avgSec: number;
  count: number;
};

/**
 * Groups DELIVERED transfers by route (sourceChainId → destChainId) and
 * returns the mean delivery time per route, sorted fastest-first.
 *
 * Only DELIVERED rows are included — non-DELIVERED rows with partial
 * timestamps (dest-first race, indexer lag) are excluded by the explicit
 * status guard rather than relying on transferDeliveryDurationSec returning
 * null (which it may not if both timestamps happen to be set before status
 * is reconciled).
 *
 * Transfers with null chainIds are skipped (can't form a meaningful route key).
 */
export function computeRouteAvgDeliverTimes(
  transfers: ReadonlyArray<
    Pick<
      BridgeTransfer,
      | "status"
      | "sentTimestamp"
      | "deliveredTimestamp"
      | "sourceChainId"
      | "destChainId"
    >
  >,
): RouteAvgTime[] {
  const map = new Map<
    string,
    { totalSec: number; count: number; srcChainId: number; dstChainId: number }
  >();
  for (const t of transfers) {
    if (t.status !== "DELIVERED") continue;
    const dur = transferDeliveryDurationSec(t);
    if (dur === null || t.sourceChainId === null || t.destChainId === null)
      continue;
    const key = `${t.sourceChainId}-${t.destChainId}`;
    const existing = map.get(key);
    if (existing) {
      existing.totalSec += dur;
      existing.count += 1;
    } else {
      map.set(key, {
        totalSec: dur,
        count: 1,
        srcChainId: t.sourceChainId,
        dstChainId: t.destChainId,
      });
    }
  }
  return [...map.values()]
    .map((v) => ({
      srcChainId: v.srcChainId,
      dstChainId: v.dstChainId,
      avgSec: v.totalSec / v.count,
      count: v.count,
    }))
    .sort((a, b) => a.avgSec - b.avgSec);
}
