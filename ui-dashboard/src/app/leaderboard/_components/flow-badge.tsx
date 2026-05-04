"use client";

import type { FlowResult } from "@/lib/leaderboard";

/**
 * Visualizes a trader's flow in their primary pool (BACKLOG.md PR 3 spec):
 *   one-directional → 🡆 (extractive arb / corridor flow)
 *   delta-neutral   → ⇌ (round-tripping, MM-like)
 *   mixed           → ⤺
 *
 * Imbalance score lives behind the `title` attribute so a hover surfaces the
 * underlying number without cluttering the table cell.
 */
export function FlowBadge({
  flow,
  token0Symbol,
  token1Symbol,
}: {
  flow: FlowResult;
  token0Symbol?: string | null;
  token1Symbol?: string | null;
}) {
  if (flow.kind === "one-directional") {
    const accumulated =
      flow.direction === 0
        ? token0Symbol
        : flow.direction === 1
          ? token1Symbol
          : null;
    return (
      <span
        className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300"
        title={`Imbalance ${(flow.imbalance * 100).toFixed(0)}% — net accumulating ${accumulated ?? "one token"}`}
      >
        <span aria-hidden="true">🡆</span>
        {accumulated ? `+${accumulated}` : "1-way"}
      </span>
    );
  }
  if (flow.kind === "delta-neutral") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300"
        title={`Imbalance ${(flow.imbalance * 100).toFixed(0)}% — flows roughly cancel out`}
      >
        <span aria-hidden="true">⇌</span>
        Round-trip
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded bg-slate-500/15 px-1.5 py-0.5 text-[10px] font-medium text-slate-300"
      title={`Imbalance ${(flow.imbalance * 100).toFixed(0)}%`}
    >
      <span aria-hidden="true">⤺</span>
      Mixed
    </span>
  );
}
