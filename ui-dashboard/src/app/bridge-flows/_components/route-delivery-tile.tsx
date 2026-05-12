"use client";

/**
 * Per-route average delivery time tile for the bridge-flows Key metrics row.
 * Computes avg delivery seconds per route from the last N delivered transfers,
 * then renders one row per route with a chain-pair icon, duration, and sample
 * count. Isolated in its own file so the parent page stays under 300 lines.
 */

import { useMemo } from "react";
import { computeRouteAvgDeliverTimes } from "@/lib/bridge-flows/route-stats";
import { formatDurationShort } from "@/lib/bridge-status";
import type { BridgeTransfer } from "@/lib/types";
import { ROUTE_STATS_LIMIT } from "@/lib/bridge-flows/layout";
import { RouteCell } from "./transfer-row-cells";

export function RouteDeliveryTile({
  transfers,
  isLoading,
  hasError,
}: {
  transfers: ReadonlyArray<
    Pick<
      BridgeTransfer,
      | "status"
      | "sentTimestamp"
      | "deliveredTimestamp"
      | "sourceChainId"
      | "destChainId"
    >
  >;
  isLoading: boolean;
  hasError: boolean;
}) {
  const routes = useMemo(
    () => computeRouteAvgDeliverTimes(transfers),
    [transfers],
  );
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 px-5 py-4 min-h-[88px]">
      <p className="text-sm text-slate-400 mb-3">Avg Delivery Time by Route</p>
      {hasError ? (
        <p className="text-2xl font-semibold text-white font-mono">—</p>
      ) : isLoading ? (
        <div className="space-y-2">
          {[0, 1].map((i) => (
            // react-doctor-disable-next-line react-doctor/no-array-index-as-key
            <div
              key={`skel-route-${i}`}
              className="h-4 animate-pulse rounded bg-slate-800/50"
            />
          ))}
        </div>
      ) : routes.length === 0 ? (
        <p className="text-sm text-slate-500">No delivered transfers yet</p>
      ) : (
        <>
          <div className="space-y-2">
            {routes.map((r) => (
              <div
                key={`${r.srcChainId}-${r.dstChainId}`}
                className="flex items-center gap-3"
              >
                <RouteCell
                  sourceChainId={r.srcChainId}
                  destChainId={r.dstChainId}
                />
                <span className="font-mono text-sm font-semibold text-white">
                  {formatDurationShort(r.avgSec)}
                </span>
                <span className="text-xs text-slate-500">n={r.count}</span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-slate-500">
            last {ROUTE_STATS_LIMIT} delivered
          </p>
        </>
      )}
    </div>
  );
}
